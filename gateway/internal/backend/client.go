// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Package backend implements a typed HTTP client for the agentic-inbox
// Worker's IMAP-gateway API (POST /api/imap/v1/auth, GET .../folders,
// GET .../messages, GET .../messages/{uid}/raw).
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
	ctx, cancel := context.WithTimeout(ctx, c.requestTimeout)
	defer cancel()

	req, err := c.newRequest(ctx, method, path, query, body)
	if err != nil {
		return err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
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
