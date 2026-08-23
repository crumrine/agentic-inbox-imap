// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Package backend implements a typed HTTP client for the agentic-inbox
// Worker's IMAP-gateway API under /api/imap/v1: POST /auth,
// GET {mailbox}/folders, GET {mailbox}/{folder}/messages,
// GET {mailbox}/messages/{uid}/raw, POST {mailbox}/{folder}/search, and the
// write endpoints flags, copy, move, expunge, append and submit.
//
// The client is stateless: it holds no mailbox data, only an HTTP
// connection pool and the Cloudflare Access service-token credentials used
// to authenticate to the Worker.
package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	// headerAccessClientID and headerAccessClientSecret are the Cloudflare
	// Access service-token headers sent on every request.
	headerAccessClientID     = "CF-Access-Client-Id"
	headerAccessClientSecret = "CF-Access-Client-Secret"
	headerCookie             = "Cookie"

	// apiPrefix is the fixed path prefix for the IMAP gateway API.
	apiPrefix = "/api/imap/v1"

	// maxErrorBodyBytes bounds how much of a non-success response body we
	// read into an APIError's Body field, so a misbehaving backend can't
	// make us buffer an unbounded amount of memory.
	maxErrorBodyBytes = 4096

	// defaultRequestTimeout bounds JSON request/response round trips
	// (auth, folders, messages listing). It intentionally does NOT apply
	// to RawMessage's streamed body — see ResponseHeaderTimeout below.
	defaultRequestTimeout = 30 * time.Second

	// defaultUploadTimeout bounds an APPEND, which streams a whole message
	// up to the Worker. defaultRequestTimeout is the wrong bound here for
	// the same reason it was wrong for RawMessage's download: it measures
	// the transfer, not the server, so a large body on a slow link would
	// be cut off mid-flight. The transport's ResponseHeaderTimeout still
	// catches a Worker that goes quiet, because it only starts counting
	// once the request body has been fully written.
	//
	// Five minutes matches go-imap's own literalReadTimeout, so the
	// gateway never waits longer to push a literal upstream than it was
	// willing to wait to read it.
	defaultUploadTimeout = 5 * time.Minute

	// defaultResponseHeaderTimeout bounds how long we wait for the Worker
	// to start responding at all. This is what protects an IMAP session
	// from wedging on a hung Worker; it does not limit how long a large
	// message body may take to stream once it starts.
	defaultResponseHeaderTimeout = 15 * time.Second
)

// Client is a typed, connection-pooling HTTP client for the Worker's IMAP
// gateway API. It is safe for concurrent use by multiple goroutines.
type Client struct {
	baseURL      *url.URL
	clientID     string
	clientSecret string

	// accessCookie is an alternative to the service token, for local testing
	// only. See WithAccessCookie.
	accessCookie string
	httpClient   *http.Client

	// requestTimeout bounds JSON endpoints only; see defaultRequestTimeout.
	requestTimeout time.Duration

	// uploadTimeout bounds Append; see defaultUploadTimeout.
	uploadTimeout time.Duration
}

// Option configures a Client constructed by New.
type Option func(*Client)

// WithHTTPClient overrides the underlying *http.Client. Intended for tests;
// most callers should not need this since New already configures sensible
// pooling and timeouts.
func WithHTTPClient(hc *http.Client) Option {
	return func(c *Client) { c.httpClient = hc }
}

// WithRequestTimeout overrides the timeout applied to JSON endpoints
// (Authenticate, Folders, Messages). It does not affect RawMessage.
func WithRequestTimeout(d time.Duration) Option {
	return func(c *Client) { c.requestTimeout = d }
}

// WithUploadTimeout overrides the timeout applied to Append, which streams
// a whole message body. It does not affect the JSON endpoints.
func WithUploadTimeout(d time.Duration) Option {
	return func(c *Client) { c.uploadTimeout = d }
}

// New builds a Client for the Worker at baseURL, authenticating to it with
// the given Cloudflare Access service token.
func New(baseURL, clientID, clientSecret string, opts ...Option) (*Client, error) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("backend: invalid base URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("backend: base URL must be http(s), got %q", baseURL)
	}

	c := &Client{
		baseURL:      u,
		clientID:     clientID,
		clientSecret: clientSecret,
		httpClient: &http.Client{
			Transport: &http.Transport{
				MaxIdleConns:          100,
				MaxIdleConnsPerHost:   16,
				IdleConnTimeout:       90 * time.Second,
				ResponseHeaderTimeout: defaultResponseHeaderTimeout,
				ExpectContinueTimeout: 1 * time.Second,
			},
			// No blanket Client.Timeout: it would cut off RawMessage's
			// streamed body on a large message. Per-call timeouts are
			// applied explicitly in doJSON via context.WithTimeout.
		},
		requestTimeout: defaultRequestTimeout,
		uploadTimeout:  defaultUploadTimeout,
	}
	for _, opt := range opts {
		opt(c)
	}
	return c, nil
}

// Close releases pooled idle connections.
func (c *Client) Close() {
	if t, ok := c.httpClient.Transport.(*http.Transport); ok {
		t.CloseIdleConnections()
	}
}

// mailboxPath returns apiPrefix + "/" + the URL-escaped mailbox segment.
// Mailbox ids are email addresses and contain '@', which must be escaped.
// mailboxPath returns apiPrefix + "/" + the URL-escaped mailbox segment, as
// a raw (already-escaped) path string. It must only ever be combined with
// other raw path fragments via string concatenation — see buildURL — never
// assigned to a url.URL.Path field, which holds decoded text and would
// double-escape an already-escaped segment (e.g. "%2F" would become
// "%252F").
func mailboxPath(mailbox string) string {
	return apiPrefix + "/" + url.PathEscape(mailbox)
}

// buildURL assembles the full request URL by string concatenation: scheme,
// host, the base URL's own (already escaped) path, then rawPath, then an
// encoded query string.
//
// rawPath must already be a properly percent-escaped path (as produced by
// mailboxPath and the url.PathEscape calls in the methods below), with
// literal '/' characters only where they are meant to be path separators.
// Building the URL this way — rather than by assigning into a url.URL's
// Path field, which Go treats as unescaped text and would re-escape — is
// what keeps mailbox ids containing '/' or other reserved characters from
// being double-encoded or mistaken for path separators.
func (c *Client) buildURL(rawPath string, query url.Values) string {
	var b strings.Builder
	b.WriteString(c.baseURL.Scheme)
	b.WriteString("://")
	b.WriteString(c.baseURL.Host)
	if p := strings.TrimRight(c.baseURL.EscapedPath(), "/"); p != "" {
		b.WriteString(p)
	}
	b.WriteString(rawPath)
	if len(query) > 0 {
		b.WriteString("?")
		b.WriteString(query.Encode())
	}
	return b.String()
}

func (c *Client) newRequest(ctx context.Context, method, path string, query url.Values, body io.Reader) (*http.Request, error) {
	fullURL := c.buildURL(path, query)
	req, err := http.NewRequestWithContext(ctx, method, fullURL, body)
	if err != nil {
		return nil, err
	}
	c.applyAccessCredentials(req)
	req.Header.Set("Accept", "application/json")
	return req, nil
}

// classifyStatus maps an HTTP status code to an ErrorKind. Only called for
// non-2xx responses.
func classifyStatus(status int) ErrorKind {
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return ErrKindAuthFailed
	case status == http.StatusNotFound:
		return ErrKindNotFound
	case status >= 500:
		return ErrKindServer
	default:
		return ErrKindUnknown
	}
}

// readErrorBody reads a bounded excerpt of resp.Body for use in an
// APIError. It never returns an error itself; a read failure just yields an
// empty excerpt.
func readErrorBody(resp *http.Response) string {
	limited := io.LimitReader(resp.Body, maxErrorBodyBytes)
	b, _ := io.ReadAll(limited)
	return string(bytes.TrimSpace(b))
}

// parseRetryAfter reads the delta-seconds form of a Retry-After header. The
// HTTP-date form is legal but not something the Worker emits, so an
// unparseable value simply yields zero rather than an error.
func parseRetryAfter(v string) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	seconds, err := strconv.Atoi(v)
	if err != nil || seconds < 0 {
		return 0
	}
	return time.Duration(seconds) * time.Second
}

// newTransportError wraps a transport-level failure (connection refused,
// DNS failure, TLS failure, etc). Context cancellation/deadline errors are
// NOT wrapped here — callers should check ctx.Err() first and propagate it
// directly so callers can use errors.Is(err, context.DeadlineExceeded).
func newTransportError(err error) *APIError {
	return &APIError{Kind: ErrKindServer, Err: err}
}

// doJSON performs a request expecting a JSON response body, applying
// c.requestTimeout. It decodes the response into out (which may be nil for
// endpoints with no useful body) on success (2xx).
func (c *Client) doJSON(ctx context.Context, method, path string, query url.Values, body io.Reader, contentType string, out any) error {
	return c.doRequest(ctx, c.requestTimeout, method, path, query, body, contentType, -1, out)
}

// doRequest is doJSON with the timeout and body length made explicit, so an
// upload can pick a bound suited to a transfer rather than to a round trip.
// A contentLength below zero leaves net/http to work it out.
func (c *Client) doRequest(ctx context.Context, timeout time.Duration, method, path string, query url.Values, body io.Reader, contentType string, contentLength int64, out any) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := c.newRequest(ctx, method, path, query, body)
	if err != nil {
		return err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if contentLength >= 0 {
		// A known length means a Content-Length header and a straight
		// streamed body. Without it net/http would fall back to chunked
		// encoding for a reader it cannot measure.
		req.ContentLength = contentLength
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		return newTransportError(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &APIError{
			Kind:       classifyStatus(resp.StatusCode),
			StatusCode: resp.StatusCode,
			Body:       readErrorBody(resp),
			RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
		}
	}

	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("backend: decoding response body: %w", err)
	}
	return nil
}

// Authenticate calls POST /api/imap/v1/auth. It returns ErrAuthFailed
// (via errors.Is) when the Worker rejects the credentials.
func (c *Client) Authenticate(ctx context.Context, mailbox, password string) (*AuthResult, error) {
	payload, err := json.Marshal(struct {
		Mailbox  string `json:"mailbox"`
		Password string `json:"password"`
	}{Mailbox: mailbox, Password: password})
	if err != nil {
		return nil, fmt.Errorf("backend: encoding auth request: %w", err)
	}

	var result AuthResult
	err = c.doJSON(ctx, http.MethodPost, apiPrefix+"/auth", nil, bytes.NewReader(payload), "application/json", &result)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// Folders calls GET /api/imap/v1/{mailbox}/folders.
func (c *Client) Folders(ctx context.Context, mailbox string) ([]Folder, error) {
	var folders []Folder
	path := mailboxPath(mailbox) + "/folders"
	if err := c.doJSON(ctx, http.MethodGet, path, nil, nil, "", &folders); err != nil {
		return nil, err
	}
	return folders, nil
}

// MessagesOptions configures the Messages listing call. The zero value
// requests the full listing.
type MessagesOptions struct {
	// SinceUID, if non-zero, is passed as sinceUid so the Worker can
	// return only messages at or after this UID.
	SinceUID uint32
	// Limit, if non-zero, caps the number of messages returned.
	Limit int
}

// Messages calls GET /api/imap/v1/{mailbox}/{folder}/messages.
func (c *Client) Messages(ctx context.Context, mailbox, folder string, opts MessagesOptions) (*MessagesPage, error) {
	query := url.Values{}
	if opts.SinceUID != 0 {
		query.Set("sinceUid", strconv.FormatUint(uint64(opts.SinceUID), 10))
	}
	if opts.Limit != 0 {
		query.Set("limit", strconv.Itoa(opts.Limit))
	}

	var page MessagesPage
	path := mailboxPath(mailbox) + "/" + url.PathEscape(folder) + "/messages"
	if err := c.doJSON(ctx, http.MethodGet, path, query, nil, "", &page); err != nil {
		return nil, err
	}
	return &page, nil
}

// Search calls POST /api/imap/v1/{mailbox}/{folder}/search, asking the
// Worker to evaluate the part of an IMAP SEARCH it can answer from its own
// storage so the gateway does not have to download messages to answer it.
//
// A nil criteria means "every message in the folder", which is what
// SEARCH ALL asks for.
//
// The result is only half an answer: SearchPage.UIDs satisfies the criteria
// named in Handled and nothing else, so the caller must apply the Unhandled
// criteria to those uids itself. See SearchPage.
//
// Every failure mode is the caller's cue to evaluate the whole search
// locally instead: a 400 (criteria this build sent that the Worker does not
// know), a 404 (no such mailbox or folder), a 413 (the search would examine
// too many rows to answer at all), or any transport error. This endpoint is
// an optimisation, and a mail client hanging or seeing a NO is far worse
// than a slow search.
func (c *Client) Search(ctx context.Context, mailbox, folder string, criteria *SearchCriteria) (*SearchPage, error) {
	if criteria == nil {
		criteria = &SearchCriteria{}
	}
	payload, err := json.Marshal(struct {
		Criteria *SearchCriteria `json:"criteria"`
	}{Criteria: criteria})
	if err != nil {
		return nil, fmt.Errorf("backend: encoding search request: %w", err)
	}

	var page SearchPage
	path := mailboxPath(mailbox) + "/" + url.PathEscape(folder) + "/search"
	if err := c.doJSON(ctx, http.MethodPost, path, nil, bytes.NewReader(payload), "application/json", &page); err != nil {
		return nil, err
	}
	return &page, nil
}

// SetFlags calls POST /api/imap/v1/{mailbox}/{folder}/flags, applying a
// batch of per-message flag changes.
//
// It returns each updated message's complete resulting flag set. UIDs the
// Worker does not know are omitted from the result rather than reported as
// an error, so a caller must treat a missing UID as "that message is gone"
// and not as a failure.
func (c *Client) SetFlags(ctx context.Context, mailbox, folder string, updates []FlagUpdate) ([]FlagResult, error) {
	// Normalise here rather than trusting callers: a nil slice marshals to
	// JSON null, and the endpoint's schema expects arrays.
	normalised := make([]FlagUpdate, 0, len(updates))
	for _, u := range updates {
		if u.Add == nil {
			u.Add = []string{}
		}
		if u.Remove == nil {
			u.Remove = []string{}
		}
		normalised = append(normalised, u)
	}

	payload, err := json.Marshal(struct {
		Updates []FlagUpdate `json:"updates"`
	}{Updates: normalised})
	if err != nil {
		return nil, fmt.Errorf("backend: encoding flag update request: %w", err)
	}

	var page FlagsPage
	path := mailboxPath(mailbox) + "/" + url.PathEscape(folder) + "/flags"
	if err := c.doJSON(ctx, http.MethodPost, path, nil, bytes.NewReader(payload), "application/json", &page); err != nil {
		return nil, err
	}
	return page.Updated, nil
}

// Copy calls POST /api/imap/v1/{mailbox}/{folder}/copy, copying messages
// into destination. The source folder is unchanged.
//
// It returns a source-UID to destination-UID pair per message copied. UIDs
// the Worker does not know are omitted rather than reported as an error.
func (c *Client) Copy(ctx context.Context, mailbox, folder string, uids []uint32, destination string) ([]CopiedMessage, error) {
	var page CopyPage
	path := mailboxPath(mailbox) + "/" + url.PathEscape(folder) + "/copy"
	if err := c.doUIDsRequest(ctx, path, uids, destination, &page); err != nil {
		return nil, err
	}
	return page.Copied, nil
}

// Move calls POST /api/imap/v1/{mailbox}/{folder}/move, moving messages
// into destination. The source UIDs cease to exist in the source folder.
func (c *Client) Move(ctx context.Context, mailbox, folder string, uids []uint32, destination string) ([]CopiedMessage, error) {
	var page MovePage
	path := mailboxPath(mailbox) + "/" + url.PathEscape(folder) + "/move"
	if err := c.doUIDsRequest(ctx, path, uids, destination, &page); err != nil {
		return nil, err
	}
	return page.Moved, nil
}

// Expunge calls POST /api/imap/v1/{mailbox}/{folder}/expunge.
//
// A nil uids slice omits the field entirely, which the Worker reads as
// "every message with \Deleted". A non-nil slice restricts the operation
// to those UIDs. The two are genuinely different requests, so a caller that
// wants the unrestricted form must pass nil, not an empty slice.
//
// It returns the source UIDs actually removed.
func (c *Client) Expunge(ctx context.Context, mailbox, folder string, uids []uint32) ([]uint32, error) {
	body := struct {
		UIDs []uint32 `json:"uids,omitempty"`
	}{UIDs: uids}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("backend: encoding expunge request: %w", err)
	}

	var page ExpungePage
	path := mailboxPath(mailbox) + "/" + url.PathEscape(folder) + "/expunge"
	if err := c.doJSON(ctx, http.MethodPost, path, nil, bytes.NewReader(payload), "application/json", &page); err != nil {
		return nil, err
	}
	return page.Expunged, nil
}

// doUIDsRequest posts the {"uids":[...],"destination":"..."} body shared by
// the copy and move endpoints.
func (c *Client) doUIDsRequest(ctx context.Context, path string, uids []uint32, destination string, out any) error {
	if uids == nil {
		uids = []uint32{}
	}
	payload, err := json.Marshal(struct {
		UIDs        []uint32 `json:"uids"`
		Destination string   `json:"destination"`
	}{UIDs: uids, Destination: destination})
	if err != nil {
		return fmt.Errorf("backend: encoding request: %w", err)
	}
	return c.doJSON(ctx, http.MethodPost, path, nil, bytes.NewReader(payload), "application/json", out)
}

// AppendOptions carries the optional metadata an APPEND may specify.
type AppendOptions struct {
	// Flags are set on the stored message. Sent as a comma-separated,
	// URL-encoded query parameter.
	Flags []string
	// Time is the message's internal date. Zero means "let the Worker
	// decide", which it does by using the time of receipt.
	Time time.Time
}

// Append calls POST /api/imap/v1/{mailbox}/{folder}/append, streaming a raw
// RFC 5322 message into a folder.
//
// body is streamed straight to the Worker and never buffered here: an
// APPEND is the one request whose size a client chooses, so buffering it
// would let any client make this process allocate arbitrarily. size must be
// the exact byte count, which becomes the Content-Length.
func (c *Client) Append(ctx context.Context, mailbox, folder string, body io.Reader, size int64, opts AppendOptions) (*AppendResult, error) {
	query := url.Values{}
	if len(opts.Flags) > 0 {
		query.Set("flags", strings.Join(opts.Flags, ","))
	}
	if !opts.Time.IsZero() {
		query.Set("internalDate", opts.Time.UTC().Format(time.RFC3339))
	}

	var result AppendResult
	path := mailboxPath(mailbox) + "/" + url.PathEscape(folder) + "/append"
	err := c.doRequest(ctx, c.uploadTimeout, http.MethodPost, path, query, body, "message/rfc822", size, &result)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// Submit calls POST /api/imap/v1/{mailbox}/submit, streaming a raw RFC 5322
// message for outbound delivery.
//
// The body is streamed and never buffered, for the same reason as Append.
// Unlike Append the length is not known up front: SMTP DATA has no declared
// size, and the client's SIZE= hint is advisory rather than exact, so
// sending it as a Content-Length would break the request whenever a client
// rounded. The request is therefore chunked.
func (c *Client) Submit(ctx context.Context, mailbox string, body io.Reader, envelopeFrom string, envelopeTo []string) (*SubmitResult, error) {
	query := url.Values{}
	query.Set("envelopeFrom", envelopeFrom)
	if len(envelopeTo) > 0 {
		query.Set("envelopeTo", strings.Join(envelopeTo, ","))
	}

	var result SubmitResult
	path := mailboxPath(mailbox) + "/submit"
	err := c.doRequest(ctx, c.uploadTimeout, http.MethodPost, path, query, body, "message/rfc822", -1, &result)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// RawMessageReader is the streamed body of a raw message fetch. Callers
// MUST call Close when done, even on error paths after a successful call,
// to return the connection to the pool.
type RawMessageReader struct {
	io.ReadCloser
	// Size is the declared Content-Length, or -1 if the server did not
	// send one.
	Size int64
}

// RawMessage calls GET /api/imap/v1/{mailbox}/messages/{uid}/raw?folder=...
// and returns the response body for streaming — it is never buffered into
// memory by this client. The caller must Close the returned reader.
//
// Unlike the JSON endpoints, RawMessage does not apply c.requestTimeout to
// the whole call: only the time to receive response headers is bounded (via
// the transport's ResponseHeaderTimeout), so a slow-but-progressing
// download of a large message is not aborted. Callers that want an overall
// deadline should pass a context with one.
func (c *Client) RawMessage(ctx context.Context, mailbox, folder string, uid uint32) (*RawMessageReader, error) {
	query := url.Values{}
	query.Set("folder", folder)

	path := mailboxPath(mailbox) + "/messages/" + strconv.FormatUint(uint64(uid), 10) + "/raw"
	req, err := c.newRequest(ctx, http.MethodGet, path, query, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "message/rfc822")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		return nil, newTransportError(err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		return nil, &APIError{
			Kind:       classifyStatus(resp.StatusCode),
			StatusCode: resp.StatusCode,
			Body:       readErrorBody(resp),
		}
	}

	return &RawMessageReader{ReadCloser: resp.Body, Size: resp.ContentLength}, nil
}

// applyAccessCredentials attaches whichever Cloudflare Access credential is
// configured. A service token is the supported production mechanism; the
// cookie is a testing fallback (see WithAccessCookie).
func (c *Client) applyAccessCredentials(req *http.Request) {
	if c.accessCookie != "" {
		req.Header.Set(headerCookie, c.accessCookie)
		return
	}
	req.Header.Set(headerAccessClientID, c.clientID)
	req.Header.Set(headerAccessClientSecret, c.clientSecret)
}

// WithAccessCookie authenticates to the Worker with a CF_Authorization cookie
// instead of a service token.
//
// This exists for local testing before a service token is provisioned. It is
// NOT suitable for production: the cookie is bound to one human's Access
// identity, expires, and cannot be rotated independently of that person. The
// value is the full cookie header, e.g. "CF_Authorization=ey...".
func WithAccessCookie(cookie string) Option {
	return func(c *Client) { c.accessCookie = cookie }
}
