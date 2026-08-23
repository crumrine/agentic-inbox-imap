// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package backend

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
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

func TestSetFlags_Success(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requireAccessHeaders(t, r)
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/api/imap/v1/user@example.com/inbox/flags" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", ct)
		}
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"updated":[{"uid":3,"flags":["\\Seen","\\Answered"]}]}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	got, err := c.SetFlags(context.Background(), "user@example.com", "inbox", []FlagUpdate{
		{UID: 3, Add: []string{`\Seen`}, Remove: []string{`\Flagged`}},
	})
	if err != nil {
		t.Fatalf("SetFlags: %v", err)
	}
	if len(got) != 1 || got[0].UID != 3 {
		t.Fatalf("updated = %+v", got)
	}
	if len(got[0].Flags) != 2 || got[0].Flags[0] != `\Seen` || got[0].Flags[1] != `\Answered` {
		t.Errorf("flags = %v", got[0].Flags)
	}

	const wantBody = `{"updates":[{"uid":3,"add":["\\Seen"],"remove":["\\Flagged"]}]}`
	if strings.TrimSpace(gotBody) != wantBody {
		t.Errorf("request body = %s\nwant           %s", gotBody, wantBody)
	}
}

// TestSetFlags_NilSlicesBecomeArrays: a nil Go slice marshals to JSON null,
// which the endpoint's schema does not accept. The client normalises.
func TestSetFlags_NilSlicesBecomeArrays(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"updated":[]}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	if _, err := c.SetFlags(context.Background(), "user@example.com", "inbox", []FlagUpdate{{UID: 7}}); err != nil {
		t.Fatalf("SetFlags: %v", err)
	}
	if strings.Contains(gotBody, "null") {
		t.Errorf("request body = %s, want empty arrays rather than null", gotBody)
	}
	const wantBody = `{"updates":[{"uid":7,"add":[],"remove":[]}]}`
	if strings.TrimSpace(gotBody) != wantBody {
		t.Errorf("request body = %s\nwant           %s", gotBody, wantBody)
	}
}

func TestSetFlags_ErrorMapping(t *testing.T) {
	tests := []struct {
		name   string
		status int
		want   error
	}{
		{"not found", http.StatusNotFound, ErrNotFound},
		{"server error", http.StatusInternalServerError, ErrServer},
		{"unauthorized", http.StatusUnauthorized, ErrAuthFailed},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				w.Write([]byte(`{"error":"nope"}`))
			}))
			defer srv.Close()

			c := newTestClient(t, srv)
			_, err := c.SetFlags(context.Background(), "user@example.com", "inbox", []FlagUpdate{{UID: 1}})
			if !errors.Is(err, tc.want) {
				t.Errorf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

// TestSetFlags_HonoursRequestTimeout pins that the new method goes through
// doJSON and therefore inherits the same timeout discipline as the rest.
func TestSetFlags_HonoursRequestTimeout(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	defer srv.Close()
	defer close(release)

	c := newTestClient(t, srv, WithRequestTimeout(50*time.Millisecond))
	start := time.Now()
	if _, err := c.SetFlags(context.Background(), "user@example.com", "inbox", []FlagUpdate{{UID: 1}}); err == nil {
		t.Fatal("SetFlags succeeded against a hung server")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("SetFlags took %v; the request timeout did not apply", elapsed)
	}
}

func TestCopy_Success(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requireAccessHeaders(t, r)
		if r.Method != http.MethodPost || r.URL.Path != "/api/imap/v1/user@example.com/inbox/copy" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"copied":[{"sourceUid":3,"destUid":9},{"sourceUid":4,"destUid":10}]}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	got, err := c.Copy(context.Background(), "user@example.com", "inbox", []uint32{3, 4}, "archive")
	if err != nil {
		t.Fatalf("Copy: %v", err)
	}
	if len(got) != 2 || got[0].SourceUID != 3 || got[0].DestUID != 9 || got[1].SourceUID != 4 || got[1].DestUID != 10 {
		t.Errorf("copied = %+v", got)
	}
	const wantBody = `{"uids":[3,4],"destination":"archive"}`
	if strings.TrimSpace(gotBody) != wantBody {
		t.Errorf("body = %s\nwant  %s", gotBody, wantBody)
	}
}

func TestMove_Success(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requireAccessHeaders(t, r)
		if r.URL.Path != "/api/imap/v1/user@example.com/inbox/move" {
			t.Errorf("path = %s", r.URL.Path)
		}
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"moved":[{"sourceUid":3,"destUid":7}]}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	got, err := c.Move(context.Background(), "user@example.com", "inbox", []uint32{3}, "trash")
	if err != nil {
		t.Fatalf("Move: %v", err)
	}
	if len(got) != 1 || got[0].SourceUID != 3 || got[0].DestUID != 7 {
		t.Errorf("moved = %+v", got)
	}
	if !strings.Contains(gotBody, `"destination":"trash"`) {
		t.Errorf("body = %s", gotBody)
	}
}

// TestExpunge_NilUIDsOmitsTheField: absent uids means "every \Deleted
// message", which is a genuinely different request from an empty list.
func TestExpunge_NilUIDsOmitsTheField(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"expunged":[2,5]}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	got, err := c.Expunge(context.Background(), "user@example.com", "inbox", nil)
	if err != nil {
		t.Fatalf("Expunge: %v", err)
	}
	if len(got) != 2 || got[0] != 2 || got[1] != 5 {
		t.Errorf("expunged = %v", got)
	}
	if strings.TrimSpace(gotBody) != `{}` {
		t.Errorf("body = %s, want {} so the Worker applies the \\Deleted rule itself", gotBody)
	}
}

func TestExpunge_WithUIDs(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/imap/v1/user@example.com/inbox/expunge" {
			t.Errorf("path = %s", r.URL.Path)
		}
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"expunged":[3]}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	got, err := c.Expunge(context.Background(), "user@example.com", "inbox", []uint32{3, 4})
	if err != nil {
		t.Fatalf("Expunge: %v", err)
	}
	if len(got) != 1 || got[0] != 3 {
		t.Errorf("expunged = %v", got)
	}
	if strings.TrimSpace(gotBody) != `{"uids":[3,4]}` {
		t.Errorf("body = %s", gotBody)
	}
}

func TestCopyMoveExpunge_ErrorMapping(t *testing.T) {
	calls := map[string]func(c *Client) error{
		"copy": func(c *Client) error {
			_, err := c.Copy(context.Background(), "user@example.com", "inbox", []uint32{1}, "archive")
			return err
		},
		"move": func(c *Client) error {
			_, err := c.Move(context.Background(), "user@example.com", "inbox", []uint32{1}, "trash")
			return err
		},
		"expunge": func(c *Client) error {
			_, err := c.Expunge(context.Background(), "user@example.com", "inbox", nil)
			return err
		},
	}
	statuses := map[int]error{
		http.StatusNotFound:            ErrNotFound,
		http.StatusInternalServerError: ErrServer,
		http.StatusUnauthorized:        ErrAuthFailed,
	}

	for name, call := range calls {
		for status, want := range statuses {
			t.Run(fmt.Sprintf("%s/%d", name, status), func(t *testing.T) {
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.WriteHeader(status)
					w.Write([]byte(`{"error":"nope"}`))
				}))
				defer srv.Close()
				if err := call(newTestClient(t, srv)); !errors.Is(err, want) {
					t.Errorf("err = %v, want %v", err, want)
				}
			})
		}
	}
}

func TestCopyMoveExpunge_HonourRequestTimeout(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	defer srv.Close()
	defer close(release)

	c := newTestClient(t, srv, WithRequestTimeout(50*time.Millisecond))
	start := time.Now()
	if _, err := c.Expunge(context.Background(), "user@example.com", "inbox", nil); err == nil {
		t.Fatal("Expunge succeeded against a hung server")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("Expunge took %v; the request timeout did not apply", elapsed)
	}
}

func TestAppend_Success(t *testing.T) {
	const body = "From: a@example.com\r\nSubject: hi\r\n\r\nbody\r\n"

	var (
		gotBody          string
		gotContentType   string
		gotContentLength int64
		gotQuery         url.Values
		gotChunked       bool
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requireAccessHeaders(t, r)
		if r.Method != http.MethodPost || r.URL.Path != "/api/imap/v1/user@example.com/drafts/append" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		gotContentType = r.Header.Get("Content-Type")
		gotContentLength = r.ContentLength
		gotQuery = r.URL.Query()
		for _, te := range r.TransferEncoding {
			if te == "chunked" {
				gotChunked = true
			}
		}
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"uid":5,"uidValidity":1787427939,"deduplicated":false}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	when := time.Date(2026, 8, 22, 22, 5, 3, 0, time.UTC)
	got, err := c.Append(context.Background(), "user@example.com", "drafts",
		strings.NewReader(body), int64(len(body)),
		AppendOptions{Flags: []string{`\Seen`, `\Draft`}, Time: when})
	if err != nil {
		t.Fatalf("Append: %v", err)
	}

	if got.UID != 5 || got.UIDValidity != 1787427939 || got.Deduplicated {
		t.Errorf("result = %+v", got)
	}
	if gotBody != body {
		t.Errorf("body = %q, want %q", gotBody, body)
	}
	if gotContentType != "message/rfc822" {
		t.Errorf("Content-Type = %q", gotContentType)
	}
	// A known Content-Length rather than chunked: the size comes from the
	// IMAP literal, so there is no reason to make the Worker guess.
	if gotContentLength != int64(len(body)) {
		t.Errorf("Content-Length = %d, want %d", gotContentLength, len(body))
	}
	if gotChunked {
		t.Error("request was chunked, want a plain body with Content-Length")
	}
	if got := gotQuery.Get("flags"); got != `\Seen,\Draft` {
		t.Errorf("flags = %q, want %q", got, `\Seen,\Draft`)
	}
	if got := gotQuery.Get("internalDate"); got != "2026-08-22T22:05:03Z" {
		t.Errorf("internalDate = %q", got)
	}
}

func TestAppend_OmitsAbsentOptions(t *testing.T) {
	var gotQuery url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query()
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"uid":1,"uidValidity":2,"deduplicated":false}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	if _, err := c.Append(context.Background(), "user@example.com", "sent", strings.NewReader("x"), 1, AppendOptions{}); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if _, ok := gotQuery["flags"]; ok {
		t.Errorf("flags was sent with no flags set: %v", gotQuery)
	}
	if _, ok := gotQuery["internalDate"]; ok {
		t.Errorf("internalDate was sent with no time set: %v", gotQuery)
	}
}

func TestAppend_Deduplicated(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"uid":42,"uidValidity":7,"deduplicated":true}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	got, err := c.Append(context.Background(), "user@example.com", "sent", strings.NewReader("x"), 1, AppendOptions{})
	if err != nil {
		t.Fatalf("Append: %v", err)
	}
	if !got.Deduplicated || got.UID != 42 {
		t.Errorf("result = %+v, want the existing uid 42 flagged as deduplicated", got)
	}
}

// TestAppend_DoesNotBufferTheBody: the request must be streamed. A body the
// client chooses the size of is the one place this process could be made to
// allocate arbitrarily.
func TestAppend_DoesNotBufferTheBody(t *testing.T) {
	const size = 8 << 20 // 8 MiB

	started := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"uid":1,"uidValidity":1,"deduplicated":false}`))
	}))
	defer srv.Close()

	// The reader blocks until the server has begun handling the request.
	// If the client buffered the body first, it would never get there and
	// this would deadlock into the test timeout.
	src := &gatedReader{remaining: size, gate: started}

	c := newTestClient(t, srv)
	if _, err := c.Append(context.Background(), "user@example.com", "inbox", src, size, AppendOptions{}); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if src.read != size {
		t.Errorf("read %d bytes, want %d", src.read, size)
	}
	if src.maxChunk > 1<<20 {
		t.Errorf("largest single Read was %d bytes; the body is not being streamed in chunks", src.maxChunk)
	}
}

// gatedReader yields bytes only once its gate closes, and records how it
// was read.
type gatedReader struct {
	remaining int
	gate      <-chan struct{}
	opened    bool
	read      int
	maxChunk  int
}

func (r *gatedReader) Read(p []byte) (int, error) {
	if !r.opened {
		<-r.gate
		r.opened = true
	}
	if r.remaining == 0 {
		return 0, io.EOF
	}
	n := len(p)
	if n > r.remaining {
		n = r.remaining
	}
	for i := range p[:n] {
		p[i] = 'x'
	}
	r.remaining -= n
	r.read += n
	if n > r.maxChunk {
		r.maxChunk = n
	}
	return n, nil
}

func TestAppend_ErrorMapping(t *testing.T) {
	statuses := map[int]error{
		http.StatusNotFound:            ErrNotFound,
		http.StatusInternalServerError: ErrServer,
		http.StatusUnauthorized:        ErrAuthFailed,
	}
	for status, want := range statuses {
		t.Run(fmt.Sprintf("%d", status), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				io.Copy(io.Discard, r.Body)
				w.WriteHeader(status)
				w.Write([]byte(`{"error":"nope"}`))
			}))
			defer srv.Close()

			c := newTestClient(t, srv)
			_, err := c.Append(context.Background(), "user@example.com", "inbox", strings.NewReader("x"), 1, AppendOptions{})
			if !errors.Is(err, want) {
				t.Errorf("err = %v, want %v", err, want)
			}
		})
	}
}

// TestAppend_UsesTheUploadTimeoutNotTheRequestTimeout is the RawMessage
// lesson applied to the other direction: a slow upload must not be cut off
// by the bound meant for a small JSON round trip.
func TestAppend_UsesTheUploadTimeoutNotTheRequestTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"uid":1,"uidValidity":1,"deduplicated":false}`))
	}))
	defer srv.Close()

	// A request timeout far shorter than the upload takes; the upload
	// timeout is what must apply.
	c := newTestClient(t, srv, WithRequestTimeout(30*time.Millisecond), WithUploadTimeout(30*time.Second))

	body := &slowReader{chunks: 5, delay: 20 * time.Millisecond}
	if _, err := c.Append(context.Background(), "user@example.com", "inbox", body, int64(body.total()), AppendOptions{}); err != nil {
		t.Fatalf("Append: %v; the request timeout was applied to an upload", err)
	}
}

// slowReader delivers a few chunks with a pause between them, so the whole
// transfer outlasts a short request timeout.
type slowReader struct {
	chunks int
	delay  time.Duration
	sent   int
}

func (r *slowReader) total() int { return r.chunks * 16 }

func (r *slowReader) Read(p []byte) (int, error) {
	if r.sent == r.chunks {
		return 0, io.EOF
	}
	time.Sleep(r.delay)
	r.sent++
	n := 16
	if n > len(p) {
		n = len(p)
	}
	for i := range p[:n] {
		p[i] = 'y'
	}
	return n, nil
}

// ── SEARCH push-down ──────────────────────────────────────────────────

func TestSearch_Success(t *testing.T) {
	var body []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requireAccessHeaders(t, r)
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/api/imap/v1/user@example.com/inbox/search" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("Content-Type = %q", ct)
		}
		body, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"uids":[3,7,12],"partial":true,"handled":["since","flag[0]"],"unhandled":["body[0]"],"scanned":42}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	page, err := c.Search(context.Background(), "user@example.com", "inbox", &SearchCriteria{
		Since: "2026-08-01",
		Flag:  []string{"\\Seen"},
		Body:  []string{"invoice"},
	})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}

	// The endpoint rejects an unknown key with a 400, so the request must
	// carry exactly the fields that hold a criterion and nothing else.
	want := `{"criteria":{"since":"2026-08-01","flag":["\\Seen"],"body":["invoice"]}}`
	if string(body) != want {
		t.Errorf("request body = %s, want %s", body, want)
	}

	if len(page.UIDs) != 3 || page.UIDs[0] != 3 || page.UIDs[2] != 12 {
		t.Errorf("uids = %v", page.UIDs)
	}
	if !page.Partial {
		t.Error("partial = false, want true")
	}
	if len(page.Handled) != 2 || page.Handled[1] != "flag[0]" {
		t.Errorf("handled = %v", page.Handled)
	}
	if len(page.Unhandled) != 1 || page.Unhandled[0] != "body[0]" {
		t.Errorf("unhandled = %v", page.Unhandled)
	}
	if page.Scanned != 42 {
		t.Errorf("scanned = %d, want 42", page.Scanned)
	}
}

// TestSearch_NilCriteriaIsSearchAll: absent criteria means "every message
// in the folder", and the envelope still has to be present and valid.
func TestSearch_NilCriteriaIsSearchAll(t *testing.T) {
	var body []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"uids":[],"partial":false,"handled":[],"unhandled":[],"scanned":0}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	if _, err := c.Search(context.Background(), "user@example.com", "inbox", nil); err != nil {
		t.Fatalf("Search: %v", err)
	}
	if string(body) != `{"criteria":{}}` {
		t.Errorf("request body = %s, want {\"criteria\":{}}", body)
	}
}

// TestSearch_NestedCriteriaShape pins the two shapes a plain struct marshal
// could get wrong: a uid range object and an OR pair as a two-element JSON
// array, which is what the endpoint's tuple schema expects.
func TestSearch_NestedCriteriaShape(t *testing.T) {
	var body []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"uids":[],"partial":false,"handled":[],"unhandled":[],"scanned":0}`))
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.Search(context.Background(), "user@example.com", "inbox", &SearchCriteria{
		UID: []SearchUIDRange{{Start: 3, End: 9}},
		Not: []SearchCriteria{{Flag: []string{"\\Deleted"}}},
		Or: [][2]SearchCriteria{{
			{Header: []SearchHeaderField{{Key: "From", Value: "alice"}}},
			{Header: []SearchHeaderField{{Key: "From", Value: "bob"}}},
		}},
	})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}

	want := `{"criteria":{"uid":[{"start":3,"end":9}],` +
		`"not":[{"flag":["\\Deleted"]}],` +
		`"or":[[{"header":[{"key":"From","value":"alice"}]},{"header":[{"key":"From","value":"bob"}]}]]}}`
	if string(body) != want {
		t.Errorf("request body = %s, want %s", body, want)
	}
}

func TestSearch_ErrorMapping(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
		kind   ErrorKind
	}{
		{"invalid request", 400, `{"error":"Invalid request"}`, ErrKindUnknown},
		{"no such mailbox", 404, `{"error":"Not found"}`, ErrKindNotFound},
		{"no such folder", 404, `{"error":"Folder not found"}`, ErrKindNotFound},
		{"too large", 413, `{"error":"Search too large"}`, ErrKindUnknown},
		{"worker error", 500, ``, ErrKindServer},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			defer srv.Close()

			c := newTestClient(t, srv)
			_, err := c.Search(context.Background(), "user@example.com", "inbox", &SearchCriteria{})
			var apiErr *APIError
			if !errors.As(err, &apiErr) {
				t.Fatalf("err = %#v, want *APIError", err)
			}
			if apiErr.StatusCode != tc.status {
				t.Errorf("StatusCode = %d, want %d", apiErr.StatusCode, tc.status)
			}
			if apiErr.Kind != tc.kind {
				t.Errorf("Kind = %v, want %v", apiErr.Kind, tc.kind)
			}
		})
	}
}

func TestSearch_HonoursRequestTimeout(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	defer srv.Close()
	defer close(release)

	c := newTestClient(t, srv, WithRequestTimeout(50*time.Millisecond))
	_, err := c.Search(context.Background(), "user@example.com", "inbox", &SearchCriteria{})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %#v, want context.DeadlineExceeded", err)
	}
}
