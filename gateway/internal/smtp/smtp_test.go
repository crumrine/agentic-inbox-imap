// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package smtp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	gosmtp "github.com/emersion/go-smtp"

	"github.com/crumrine/agentic-inbox-imap/gateway/internal/backend"
)

const testMessage = "From: bc@example.com\r\n" +
	"To: a@example.com\r\n" +
	"Subject: hello from the phone\r\n" +
	"Message-ID: <out-1@example.com>\r\n" +
	"\r\n" +
	"sent from a real client\r\n"

func plainAuth(mailbox, password string) string {
	return base64.StdEncoding.EncodeToString([]byte("\x00" + mailbox + "\x00" + password))
}

// authenticate runs EHLO then AUTH PLAIN and requires success.
func authenticate(t *testing.T, c *rawClient) {
	t.Helper()
	requireCode(t, c.do("EHLO client.test"), 250)
	requireCode(t, c.do("AUTH PLAIN %s", plainAuth(testMailbox, testPassword)), 235)
}

// ---------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------

func TestAuthPlainSucceeds(t *testing.T) {
	be := newFakeBackend()
	c := startRawClient(t, be)

	requireCode(t, c.do("EHLO client.test"), 250)
	requireCode(t, c.do("AUTH PLAIN %s", plainAuth(testMailbox, testPassword)), 235)

	be.mu.Lock()
	calls := append([]string(nil), be.authCalls...)
	be.mu.Unlock()
	if len(calls) != 1 || calls[0] != testMailbox {
		t.Errorf("Authenticate calls = %v, want one for %q", calls, testMailbox)
	}
}

func TestAuthPlainWrongPasswordIsRefused(t *testing.T) {
	c := startRawClient(t, newFakeBackend())
	requireCode(t, c.do("EHLO client.test"), 250)

	lines := c.do("AUTH PLAIN %s", plainAuth(testMailbox, "wrong"))
	requireCode(t, lines, 535)
	joined := strings.Join(lines, "\n")
	if strings.Contains(joined, "wrong") || strings.Contains(joined, "invalid credentials") {
		t.Errorf("reply %q leaks credential material", joined)
	}
}

// TestAuthBackendOutageIsTemporary: the credential may well be right, so
// the client must be told to try again rather than that it is wrong.
func TestAuthBackendOutageIsTemporary(t *testing.T) {
	be := newFakeBackend()
	be.mu.Lock()
	be.authErr = &backend.APIError{Kind: backend.ErrKindServer, StatusCode: 503}
	be.mu.Unlock()

	c := startRawClient(t, be)
	requireCode(t, c.do("EHLO client.test"), 250)
	if got := code(t, c.do("AUTH PLAIN %s", plainAuth(testMailbox, testPassword))); got/100 != 4 {
		t.Errorf("reply code = %d, want a 4xx temporary failure", got)
	}
}

func TestCommandsBeforeAuthAreRefused(t *testing.T) {
	c := startRawClient(t, newFakeBackend())
	requireCode(t, c.do("EHLO client.test"), 250)

	if got := code(t, c.do("MAIL FROM:<%s>", testMailbox)); got/100 != 5 {
		t.Errorf("MAIL before AUTH = %d, want a 5xx", got)
	}
}

// ---------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------

// TestMailFromMismatchRejectedBeforeData is the defence-in-depth check. The
// Worker enforces it too, but refusing here means the client is told before
// it uploads a message that would be thrown away.
func TestMailFromMismatchRejectedBeforeData(t *testing.T) {
	be := newFakeBackend()
	c := startRawClient(t, be)
	authenticate(t, c)

	lines := c.do("MAIL FROM:<someone-else@example.com>")
	if got := code(t, lines); got != 550 {
		t.Fatalf("MAIL FROM mismatch = %q, want 550", lines)
	}

	// And DATA is unreachable, so nothing was uploaded.
	requireCode(t, c.do("RCPT TO:<a@example.com>"), 502)
	if be.submitCount() != 0 {
		t.Errorf("the backend was called %d times, want 0", be.submitCount())
	}
}

func TestMailFromIsCaseInsensitive(t *testing.T) {
	c := startRawClient(t, newFakeBackend())
	authenticate(t, c)
	requireCode(t, c.do("MAIL FROM:<BC@EXAMPLE.COM>"), 250)
}

func TestNullReturnPathIsRefused(t *testing.T) {
	c := startRawClient(t, newFakeBackend())
	authenticate(t, c)
	if got := code(t, c.do("MAIL FROM:<>")); got/100 != 5 {
		t.Errorf("null return path = %d, want a 5xx: submission does not originate bounces", got)
	}
}

// ---------------------------------------------------------------------
// DATA
// ---------------------------------------------------------------------

// sendMessage runs a full transaction and returns the DATA reply.
func sendMessage(t *testing.T, c *rawClient, body string, rcpts ...string) []string {
	t.Helper()
	requireCode(t, c.do("MAIL FROM:<%s>", testMailbox), 250)
	for _, rcpt := range rcpts {
		requireCode(t, c.do("RCPT TO:<%s>", rcpt), 250)
	}
	requireCode(t, c.do("DATA"), 354)
	c.write(body + ".\r\n")
	return c.readReply()
}

func TestFullSubmission(t *testing.T) {
	be := newFakeBackend()
	c := startRawClient(t, be)
	authenticate(t, c)

	requireCode(t, sendMessage(t, c, testMessage, "a@example.com", "b@example.com"), 250)

	call, ok := be.lastSubmit()
	if !ok {
		t.Fatal("the backend was never called")
	}
	if call.mailbox != testMailbox {
		t.Errorf("mailbox = %q", call.mailbox)
	}
	if call.envelopeFrom != testMailbox {
		t.Errorf("envelopeFrom = %q", call.envelopeFrom)
	}
	if len(call.envelopeTo) != 2 || call.envelopeTo[0] != "a@example.com" || call.envelopeTo[1] != "b@example.com" {
		t.Errorf("envelopeTo = %v", call.envelopeTo)
	}
	if call.body != testMessage {
		t.Errorf("body = %q\nwant   %q", call.body, testMessage)
	}

	requireCode(t, c.do("QUIT"), 221)
}

// TestDataStreamsWithoutBuffering is the memory-safety guarantee: a message
// is the one thing whose size a client chooses.
func TestDataStreamsWithoutBuffering(t *testing.T) {
	be := newFakeBackend()

	// Drive the session directly so the DATA reader can be watched. The
	// protocol path is covered by TestFullSubmission.
	s := &session{be: be, logger: newTestLogger(t), mailbox: testMailbox, from: testMailbox, rcpts: []string{"a@example.com"}}

	big := strings.Repeat("x", 2<<20)
	watched := newTrackingReader(strings.NewReader(big))
	be.mu.Lock()
	be.submitWatch = watched
	be.mu.Unlock()

	if err := s.Data(watched); err != nil {
		t.Fatalf("DATA: %v", err)
	}

	call, _ := be.lastSubmit()
	if !call.watched {
		t.Fatal("the fake was not watching the reader, so this test proves nothing")
	}
	if call.consumedAtEntry != 0 {
		t.Errorf("%d bytes were already read when the backend was called; the body is being buffered", call.consumedAtEntry)
	}
	if !call.watchedReader {
		t.Error("the backend was handed a different reader; the body is being copied rather than streamed")
	}
	if watched.consumed() != int64(len(big)) {
		t.Errorf("consumed %d bytes, want all %d", watched.consumed(), len(big))
	}
}

// ---------------------------------------------------------------------
// Worker status mapping
// ---------------------------------------------------------------------

// TestSubmitStatusMapping is the split that decides whether a failure loses
// the user's message or loops forever. Only the statuses the contract
// defines as the client's own fault are permanent.
func TestSubmitStatusMapping(t *testing.T) {
	tests := []struct {
		name      string
		err       error
		wantCode  int
		wantClass int // 4 temporary, 5 permanent
	}{
		{"403 sender validation", &backend.APIError{Kind: backend.ErrKindAuthFailed, StatusCode: 403}, 550, 5},
		{"413 too large", &backend.APIError{Kind: backend.ErrKindUnknown, StatusCode: 413}, 552, 5},
		{"429 rate limited", &backend.APIError{Kind: backend.ErrKindUnknown, StatusCode: 429}, 451, 4},
		{"502 upstream send failed", &backend.APIError{Kind: backend.ErrKindServer, StatusCode: 502}, 451, 4},
		{"500 worker error", &backend.APIError{Kind: backend.ErrKindServer, StatusCode: 500}, 451, 4},
		{"401 our service token", &backend.APIError{Kind: backend.ErrKindAuthFailed, StatusCode: 401}, 451, 4},
		{"404 mailbox gone", &backend.APIError{Kind: backend.ErrKindNotFound, StatusCode: 404}, 451, 4},
		{"transport failure", &backend.APIError{Kind: backend.ErrKindServer, StatusCode: 0}, 451, 4},
		{"unrecognised error", io.ErrUnexpectedEOF, 451, 4},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			be := newFakeBackend()
			be.setSubmitErr(tc.err)
			c := startRawClient(t, be)
			authenticate(t, c)

			lines := sendMessage(t, c, testMessage, "a@example.com")
			got := code(t, lines)
			if got != tc.wantCode {
				t.Errorf("reply = %q, want %d", lines, tc.wantCode)
			}
			if got/100 != tc.wantClass {
				t.Errorf("reply %q is class %dxx, want %dxx: getting this wrong either discards the message or retries forever",
					lines, got/100, tc.wantClass)
			}

			// The connection survives and can start another transaction.
			requireCode(t, c.do("RSET"), 250)
		})
	}
}

func TestRateLimitReportsRetryAfter(t *testing.T) {
	be := newFakeBackend()
	be.setSubmitErr(&backend.APIError{StatusCode: 429, RetryAfter: 90 * time.Second})
	c := startRawClient(t, be)
	authenticate(t, c)

	lines := sendMessage(t, c, testMessage, "a@example.com")
	requireCode(t, lines, 451)
	if !strings.Contains(strings.Join(lines, "\n"), "90 seconds") {
		t.Errorf("reply = %q, want the Retry-After delay surfaced", lines)
	}
}

func TestSubmitErrorDoesNotLeakBackendDetail(t *testing.T) {
	be := newFakeBackend()
	be.setSubmitErr(&backend.APIError{
		Kind:       backend.ErrKindServer,
		StatusCode: 502,
		Body:       "upstream https://inbox.internal/api refused, token cf-access-abc123",
	})
	c := startRawClient(t, be)
	authenticate(t, c)

	lines := sendMessage(t, c, testMessage, "a@example.com")
	joined := strings.Join(lines, "\n")
	for _, forbidden := range []string{"inbox.internal", "cf-access-abc123"} {
		if strings.Contains(joined, forbidden) {
			t.Errorf("reply %q leaks %q", joined, forbidden)
		}
	}
}

// ---------------------------------------------------------------------
// SIZE and transport
// ---------------------------------------------------------------------

func TestSizeIsAdvertised(t *testing.T) {
	c := startRawClient(t, newFakeBackend())
	lines := c.do("EHLO client.test")
	requireCode(t, lines, 250)

	joined := strings.Join(lines, "\n")
	want := "SIZE 5242880" // 5 MiB, the Cloudflare outbound cap
	if !strings.Contains(joined, want) {
		t.Errorf("EHLO = %q, want %q so a client refuses an oversize message up front", joined, want)
	}
	if !strings.Contains(joined, "AUTH PLAIN") {
		t.Errorf("EHLO = %q, want AUTH PLAIN advertised", joined)
	}
	// Implicit TLS: STARTTLS must not be offered.
	if strings.Contains(joined, "STARTTLS") {
		t.Errorf("EHLO = %q, want no STARTTLS: submission is implicit TLS on 465", joined)
	}
}

func TestOversizeMailFromIsRefused(t *testing.T) {
	be := newFakeBackend()
	c := startRawClient(t, be)
	authenticate(t, c)

	if got := code(t, c.do("MAIL FROM:<%s> SIZE=%d", testMailbox, DefaultMaxMessageBytes+1)); got/100 != 5 {
		t.Errorf("oversize SIZE= = %d, want a 5xx before any upload", got)
	}
	if be.submitCount() != 0 {
		t.Errorf("the backend was called for an oversize declaration")
	}
}

func TestWrapListenerRejectsCleartextByDefault(t *testing.T) {
	ln := newPipeListener()
	defer ln.Close()
	wrapped := WrapListener(ln) // no options: the secure default

	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := wrapped.Accept()
		if err == nil {
			accepted <- conn
		}
	}()

	clientEnd, err := ln.dial()
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer clientEnd.Close()

	_ = clientEnd.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := clientEnd.Read(make([]byte, 1)); err == nil {
		t.Fatal("a cleartext connection survived WrapListener's default")
	}
	select {
	case conn := <-accepted:
		conn.Close()
		t.Fatal("WrapListener handed a cleartext connection to the server by default")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestAllowCleartextIsOptIn(t *testing.T) {
	ln := newPipeListener()
	defer ln.Close()
	wrapped := WrapListener(ln, AllowCleartext())

	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := wrapped.Accept()
		if err == nil {
			accepted <- conn
		}
	}()

	clientEnd, err := ln.dial()
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer clientEnd.Close()

	select {
	case conn := <-accepted:
		conn.Close()
	case <-time.After(5 * time.Second):
		t.Fatal("AllowCleartext did not accept an unencrypted connection")
	}
}

// TestAuthRefusedOnCleartextByGoSMTP is the second gate: even if a
// cleartext connection reached the server, AllowInsecureAuth is off in
// production so AUTH is not offered.
func TestAuthRefusedOnCleartextByGoSMTP(t *testing.T) {
	be := newFakeBackend()
	c := startRawClient(t, be, func(o *Options) { o.AllowInsecureAuth = false })

	lines := c.do("EHLO client.test")
	requireCode(t, lines, 250)
	if strings.Contains(strings.Join(lines, "\n"), "AUTH") {
		t.Errorf("EHLO on cleartext = %q, want no AUTH advertised", lines)
	}
	if got := code(t, c.do("AUTH PLAIN %s", plainAuth(testMailbox, testPassword))); got/100 != 5 {
		t.Errorf("AUTH on cleartext = %d, want a 5xx", got)
	}
	if len(be.authCalls) != 0 {
		t.Error("the backend was asked to check a credential offered in cleartext")
	}
}

// TestImplicitTLSServerDoesNotEnableStartTLS guards the 465 posture. In
// go-smtp TLSConfig exists only to enable STARTTLS, and offering it on a
// link that is already encrypted is meaningless.
func TestImplicitTLSServerDoesNotEnableStartTLS(t *testing.T) {
	srv := NewImplicitTLSServer(newFakeBackend(), Options{})
	if srv.TLSConfig != nil {
		t.Error("TLSConfig is set, which advertises STARTTLS on an implicit-TLS listener")
	}
	if srv.AllowInsecureAuth {
		t.Error("AllowInsecureAuth defaults to true; cleartext credentials must be refused")
	}
	if srv.MaxMessageBytes != DefaultMaxMessageBytes {
		t.Errorf("MaxMessageBytes = %d, want %d", srv.MaxMessageBytes, DefaultMaxMessageBytes)
	}
}

// TestSTARTTLSServerConfiguration is the mirror: 587 must offer STARTTLS
// and must still refuse cleartext AUTH, which is what makes the upgrade
// mandatory rather than optional.
func TestSTARTTLSServerConfiguration(t *testing.T) {
	serverTLS, _ := testTLSConfigs(t)
	srv := NewSTARTTLSServer(newFakeBackend(), serverTLS, Options{})
	if srv.TLSConfig == nil {
		t.Error("TLSConfig is unset, so STARTTLS would not be offered and AUTH would be unreachable")
	}
	if srv.AllowInsecureAuth {
		t.Error("AllowInsecureAuth is true, which would make STARTTLS optional")
	}
	if srv.MaxMessageBytes != DefaultMaxMessageBytes {
		t.Errorf("MaxMessageBytes = %d, want the same cap as the other door", srv.MaxMessageBytes)
	}
}

// ---------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------

// TestGracefulShutdownWaitsForAnInFlightSession: a message the user has
// already handed over must not be dropped by a restart.
//
// go-smtp's Shutdown closes the listeners and then waits on the
// per-connection goroutines, so it returns once the client disconnects,
// not merely once the command finishes. What this pins is that the
// submission in flight when shutdown began still completes with a 250
// rather than being cut off.
func TestGracefulShutdownWaitsForAnInFlightSession(t *testing.T) {
	be := newFakeBackend()

	entered := make(chan struct{})
	release := make(chan struct{})
	slow := &blockingBackend{Backend: be, entered: entered, release: release}

	ln := newPipeListener()
	srv := NewImplicitTLSServer(slow, Options{Domain: "gateway.test", AllowInsecureAuth: true, Logger: newTestLogger(t)})
	served := make(chan error, 1)
	go func() { served <- srv.Serve(WrapListener(ln, AllowCleartext())) }()

	conn, err := ln.dial()
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	c := &rawClient{t: t, conn: conn, br: bufio.NewReader(conn)}
	c.greeting = c.readLine()
	authenticate(t, c)

	requireCode(t, c.do("MAIL FROM:<%s>", testMailbox), 250)
	requireCode(t, c.do("RCPT TO:<a@example.com>"), 250)
	requireCode(t, c.do("DATA"), 354)

	// The body has to be written from a goroutine: net.Pipe is unbuffered,
	// so the write only completes as the backend reads it.
	writeDone := make(chan struct{})
	go func() {
		defer close(writeDone)
		c.write(testMessage + ".\r\n")
	}()

	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the submission never reached the backend")
	}

	shutdownDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		shutdownDone <- srv.Shutdown(ctx)
	}()

	// The connection is busy, so shutdown must not have completed.
	select {
	case err := <-shutdownDone:
		t.Fatalf("Shutdown returned %v while a submission was in flight", err)
	case <-time.After(200 * time.Millisecond):
	}

	close(release)
	<-writeDone

	// The in-flight message still gets its success reply.
	if got := code(t, c.readReply()); got != 250 {
		t.Errorf("in-flight submission finished with %d, want 250", got)
	}
	if be.submitCount() != 1 {
		t.Errorf("submissions = %d, want the in-flight one to have completed", be.submitCount())
	}

	// Once the client goes away, shutdown finishes.
	requireCode(t, c.do("QUIT"), 221)
	select {
	case err := <-shutdownDone:
		if err != nil {
			t.Errorf("Shutdown: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("Shutdown did not return after the client disconnected")
	}
	ln.Close()
	<-served
}

// blockingBackend reports that it has been reached, then holds Submit until
// release closes. It drains the body first so the client's write can
// complete over an unbuffered pipe.
type blockingBackend struct {
	Backend
	entered chan struct{}
	release chan struct{}
}

func (b *blockingBackend) Submit(ctx context.Context, mailbox string, body io.Reader, from string, to []string) (*backend.SubmitResult, error) {
	buf, err := io.ReadAll(body)
	if err != nil {
		return nil, err
	}
	close(b.entered)
	<-b.release
	return b.Backend.Submit(ctx, mailbox, bytes.NewReader(buf), from, to)
}

func TestResetKeepsTheAuthenticatedMailbox(t *testing.T) {
	c := startRawClient(t, newFakeBackend())
	authenticate(t, c)

	requireCode(t, c.do("MAIL FROM:<%s>", testMailbox), 250)
	requireCode(t, c.do("RSET"), 250)
	// Still authenticated: RFC 5321 says RSET clears the transaction, not
	// the session.
	requireCode(t, c.do("MAIL FROM:<%s>", testMailbox), 250)
}

func TestSessionLogoutClearsTheMailbox(t *testing.T) {
	s := &session{be: newFakeBackend(), logger: newTestLogger(t), mailbox: testMailbox, from: testMailbox}
	if err := s.Logout(); err != nil {
		t.Fatalf("Logout: %v", err)
	}
	if s.mailbox != "" || s.from != "" {
		t.Errorf("state survived Logout: mailbox %q, from %q", s.mailbox, s.from)
	}
	if err := s.Data(strings.NewReader(testMessage)); err != gosmtp.ErrAuthRequired {
		t.Errorf("DATA after Logout = %#v, want ErrAuthRequired", err)
	}
}
