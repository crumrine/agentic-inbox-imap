// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package backend

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	testClientID     = "test-client-id"
	testClientSecret = "test-client-secret"
)

// requireAccessHeaders fails the test if the request doesn't carry exactly
// the expected Cloudflare Access headers.
func requireAccessHeaders(t *testing.T, r *http.Request) {
	t.Helper()
	if got := r.Header.Get(headerAccessClientID); got != testClientID {
		t.Errorf("%s header = %q, want %q", headerAccessClientID, got, testClientID)
	}
	if got := r.Header.Get(headerAccessClientSecret); got != testClientSecret {
		t.Errorf("%s header = %q, want %q", headerAccessClientSecret, got, testClientSecret)
	}
}

func newTestClient(t *testing.T, srv *httptest.Server, opts ...Option) *Client {
	t.Helper()
	c, err := New(srv.URL, testClientID, testClientSecret, opts...)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(c.Close)
	return c
}

func TestAuthenticate_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requireAccessHeaders(t, r)
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/api/imap/v1/auth" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("Content-Type = %q", ct)
		}
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), `"mailbox":"user@example.com"`) {
			t.Errorf("body missing mailbox: %s", body)
		}
		if !strings.Contains(string(body), `"password":"hunter2"`) {
			t.Errorf("body missing password: %s", body)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"mailbox":"user@example.com"}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	res, err := c.Authenticate(context.Background(), "user@example.com", "hunter2")
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if res.Mailbox != "user@example.com" {
		t.Errorf("Mailbox = %s", res.Mailbox)
	}
}

func TestAuthenticate_401(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error":"invalid credentials"}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.Authenticate(context.Background(), "user@example.com", "wrong")
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, ErrAuthFailed) {
		t.Errorf("errors.Is(err, ErrAuthFailed) = false, err = %v", err)
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.StatusCode != http.StatusUnauthorized {
		t.Errorf("StatusCode = %d", apiErr.StatusCode)
	}
}

func TestFolders_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requireAccessHeaders(t, r)
		if r.URL.Path != "/api/imap/v1/user@example.com/folders" && r.URL.Path != "/api/imap/v1/user%40example.com/folders" {
			// httptest exposes the decoded path via r.URL.Path.
			t.Errorf("path = %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[{"id":"inbox","name":"Inbox","uidValidity":1712345678,"uidNext":42,"exists":41,"unseen":3,"recent":0}]`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	folders, err := c.Folders(context.Background(), "user@example.com")
	if err != nil {
		t.Fatalf("Folders: %v", err)
	}
	if len(folders) != 1 {
		t.Fatalf("len(folders) = %d, want 1", len(folders))
	}
	f := folders[0]
	if f.ID != "inbox" || f.Name != "Inbox" || f.UIDValidity != 1712345678 || f.UIDNext != 42 || f.Exists != 41 || f.Unseen != 3 || f.Recent != 0 {
		t.Errorf("folder = %+v", f)
	}
}

// TestFolders_MailboxPathEscaping verifies mailbox ids are escaped as a
// single path segment. '@' is valid unescaped in an RFC 3986 path segment
// (it's pchar), so url.PathEscape leaves it as-is — that's correct and
// expected. What must never happen is a character like '/' inside the
// mailbox id being interpreted as an extra path segment, so we exercise
// that instead of asserting a literal "%40".
func TestFolders_MailboxPathEscaping(t *testing.T) {
	var gotRawPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// EscapedPath() reflects exactly what was on the wire, which is
		// what matters here: whether the '/' inside the mailbox id was
		// percent-encoded before being sent, so it could never be
		// mistaken for a path separator in transit.
		gotRawPath = r.URL.EscapedPath()
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	// A mailbox id containing '@' (always present) and, adversarially, a
	// '/' that must be escaped so it can't be mistaken for a path
	// separator on the wire.
	const mailbox = "weird/mailbox@example.com"
	_, err := c.Folders(context.Background(), mailbox)
	if err != nil {
		t.Fatalf("Folders: %v", err)
	}
	const wantSegment = "weird%2Fmailbox@example.com"
	if !strings.Contains(gotRawPath, wantSegment) {
		t.Errorf("raw path %q did not contain escaped mailbox segment %q (the '/' must be percent-encoded)", gotRawPath, wantSegment)
	}
}

func TestFolders_MailboxWithAtSign(t *testing.T) {
	var gotRawPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotRawPath = r.URL.EscapedPath()
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.Folders(context.Background(), "user@example.com")
	if err != nil {
		t.Fatalf("Folders: %v", err)
	}
	if gotRawPath != "/api/imap/v1/user@example.com/folders" {
		t.Errorf("raw path = %q", gotRawPath)
	}
}

func TestFolders_404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`not found`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.Folders(context.Background(), "nobody@example.com")
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("errors.Is(err, ErrNotFound) = false, err = %v", err)
	}
}

func TestFolders_5xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte(`upstream exploded`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.Folders(context.Background(), "user@example.com")
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, ErrServer) {
		t.Errorf("errors.Is(err, ErrServer) = false, err = %v", err)
	}
}

func TestMessages_Success_WithQueryParams(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requireAccessHeaders(t, r)
		if r.URL.Query().Get("sinceUid") != "7" {
			t.Errorf("sinceUid = %q", r.URL.Query().Get("sinceUid"))
		}
		if r.URL.Query().Get("limit") != "50" {
			t.Errorf("limit = %q", r.URL.Query().Get("limit"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"messages":[{"uid":1,"flags":["\\Seen"],"internalDate":"2026-01-02T03:04:05Z","rfc822Size":4096,"envelope":{"subject":"hi","from":[{"name":"","address":"a@example.com"}],"to":[{"name":"","address":"b@example.com"}],"cc":[],"messageId":"<abc@example.com>","inReplyTo":"","date":"2026-01-02T03:04:05Z"},"hasRaw":true}],"uidNext":42}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	page, err := c.Messages(context.Background(), "user@example.com", "INBOX", MessagesOptions{SinceUID: 7, Limit: 50})
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if page.UIDNext != 42 {
		t.Errorf("UIDNext = %d", page.UIDNext)
	}
	if len(page.Messages) != 1 {
		t.Fatalf("len(Messages) = %d", len(page.Messages))
	}
	m := page.Messages[0]
	if m.UID != 1 || m.RFC822Size != 4096 || !m.HasRaw || m.Envelope.Subject != "hi" {
		t.Errorf("message = %+v", m)
	}
	if len(m.Flags) != 1 || m.Flags[0] != `\Seen` {
		t.Errorf("flags = %v", m.Flags)
	}
	wantDate := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	if !m.InternalDate.Equal(wantDate) {
		t.Errorf("InternalDate = %v, want %v", m.InternalDate, wantDate)
	}
}

func TestMessages_NoOptionalParamsOmitted(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Has("sinceUid") {
			t.Errorf("sinceUid should be omitted, got %q", r.URL.Query().Get("sinceUid"))
		}
		if r.URL.Query().Has("limit") {
			t.Errorf("limit should be omitted, got %q", r.URL.Query().Get("limit"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"messages":[],"uidNext":1}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.Messages(context.Background(), "user@example.com", "INBOX", MessagesOptions{})
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
}

func TestRawMessage_Streams(t *testing.T) {
	const body = "From: a@example.com\r\nTo: b@example.com\r\nSubject: hi\r\n\r\nbody text\r\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requireAccessHeaders(t, r)
		if r.URL.Path != "/api/imap/v1/user@example.com/messages/1/raw" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.URL.Query().Get("folder") != "INBOX" {
			t.Errorf("folder = %s", r.URL.Query().Get("folder"))
		}
		w.Header().Set("Content-Type", "message/rfc822")
		w.Write([]byte(body))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	rc, err := c.RawMessage(context.Background(), "user@example.com", "INBOX", 1)
	if err != nil {
		t.Fatalf("RawMessage: %v", err)
	}
	defer rc.Close()

	got, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("reading body: %v", err)
	}
	if string(got) != body {
		t.Errorf("body = %q, want %q", got, body)
	}
}

func TestRawMessage_DoesNotBuffer(t *testing.T) {
	// A streaming client should return before the whole body has been
	// read. We verify this by having the handler write a chunk, flush,
	// and then block until the test tells it to continue — if RawMessage
	// buffered the whole body first, this call would hang.
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("ResponseWriter does not support flushing")
		}
		w.Header().Set("Content-Type", "message/rfc822")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("first-chunk"))
		flusher.Flush()
		<-release
		w.Write([]byte("second-chunk"))
	}))
	defer srv.Close()
	defer close(release)

	c := newTestClient(t, srv)

	done := make(chan struct{})
	var rc *RawMessageReader
	var callErr error
	go func() {
		rc, callErr = c.RawMessage(context.Background(), "user@example.com", "INBOX", 1)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("RawMessage call did not return promptly; looks like it buffered the whole body")
	}
	if callErr != nil {
		t.Fatalf("RawMessage: %v", callErr)
	}
	defer rc.Close()

	buf := make([]byte, len("first-chunk"))
	if _, err := io.ReadFull(rc, buf); err != nil {
		t.Fatalf("reading first chunk: %v", err)
	}
	if string(buf) != "first-chunk" {
		t.Errorf("first chunk = %q", buf)
	}
}

func TestRawMessage_404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`no such message`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.RawMessage(context.Background(), "user@example.com", "INBOX", 999)
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("errors.Is(err, ErrNotFound) = false, err = %v", err)
	}
}

func TestRawMessage_5xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.RawMessage(context.Background(), "user@example.com", "INBOX", 1)
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, ErrServer) {
		t.Errorf("errors.Is(err, ErrServer) = false, err = %v", err)
	}
}

func TestDoJSON_ContextCancellation(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-block
	}))
	defer srv.Close()
	defer close(block)

	c := newTestClient(t, srv)
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled

	_, err := c.Folders(ctx, "user@example.com")
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("errors.Is(err, context.Canceled) = false, err = %v", err)
	}
}

func TestDoJSON_TimeoutDoesNotWedge(t *testing.T) {
	// A handler that never responds must not hang the caller forever: the
	// client's requestTimeout should fire.
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-block
	}))
	defer srv.Close()
	defer close(block)

	c := newTestClient(t, srv, WithRequestTimeout(200*time.Millisecond))

	start := time.Now()
	_, err := c.Folders(context.Background(), "user@example.com")
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected timeout error")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("errors.Is(err, context.DeadlineExceeded) = false, err = %v", err)
	}
	if elapsed > 5*time.Second {
		t.Errorf("call took %v, expected it to be bounded by the 200ms request timeout", elapsed)
	}
}

func TestDoJSON_TransportError(t *testing.T) {
	// Point the client at a closed port so the request fails at the
	// transport level (connection refused), not with an HTTP status.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close() // now nothing is listening

	c := newTestClient(t, &httptest.Server{URL: url})
	_, err := c.Folders(context.Background(), "user@example.com")
	if err == nil {
		t.Fatal("expected transport error")
	}
	if !errors.Is(err, ErrServer) {
		t.Errorf("errors.Is(err, ErrServer) = false, err = %v", err)
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected *APIError, got %T", err)
	}
	if apiErr.StatusCode != 0 {
		t.Errorf("StatusCode = %d, want 0 for a transport-level error", apiErr.StatusCode)
	}
}

func TestAccessHeaders_SentOnEveryEndpoint(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requireAccessHeaders(t, r)
		atomic.AddInt32(&calls, 1)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/auth"):
			w.Write([]byte(`{"mailbox":"user@example.com"}`))
		case strings.HasSuffix(r.URL.Path, "/folders"):
			w.Write([]byte(`[]`))
		case strings.HasSuffix(r.URL.Path, "/messages"):
			w.Write([]byte(`{"messages":[],"uidNext":1}`))
		case strings.Contains(r.URL.Path, "/raw"):
			w.Header().Set("Content-Type", "message/rfc822")
			w.Write([]byte("raw"))
		}
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	ctx := context.Background()

	if _, err := c.Authenticate(ctx, "user@example.com", "pw"); err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if _, err := c.Folders(ctx, "user@example.com"); err != nil {
		t.Fatalf("Folders: %v", err)
	}
	if _, err := c.Messages(ctx, "user@example.com", "INBOX", MessagesOptions{}); err != nil {
		t.Fatalf("Messages: %v", err)
	}
	rc, err := c.RawMessage(ctx, "user@example.com", "INBOX", 1)
	if err != nil {
		t.Fatalf("RawMessage: %v", err)
	}
	rc.Close()

	if got := atomic.LoadInt32(&calls); got != 4 {
		t.Errorf("handler invoked %d times, want 4", got)
	}
}

func TestNew_RejectsNonHTTPBaseURL(t *testing.T) {
	if _, err := New("not a url with spaces and :://", testClientID, testClientSecret); err == nil {
		t.Fatal("expected error for malformed base URL")
	}
	if _, err := New("ftp://example.com", testClientID, testClientSecret); err == nil {
		t.Fatal("expected error for non-http(s) scheme")
	}
}
