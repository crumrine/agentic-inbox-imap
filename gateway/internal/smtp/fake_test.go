// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package smtp

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/crumrine/agentic-inbox/gateway/internal/backend"
)

const (
	testMailbox  = "bc@bpxo.cc"
	testPassword = "correct-horse-battery-staple"
)

// submitCall records one submission.
type submitCall struct {
	mailbox      string
	envelopeFrom string
	envelopeTo   []string
	body         string

	// consumedAtEntry is how many bytes had been read out of the watched
	// DATA reader when the backend was called. Streaming leaves it zero.
	consumedAtEntry int64
	// watchedReader is true when the reader handed over is the very reader
	// the server was given, rather than a copy of its contents.
	watchedReader bool
	// watched is true when a reader was being watched at all, so a test
	// cannot pass by forgetting to set one up.
	watched bool
}

// fakeBackend is an in-memory Backend with call records and injectable
// failures.
type fakeBackend struct {
	mu sync.Mutex

	authCalls   []string
	submitCalls []submitCall

	authErr   error
	submitErr error

	// submitWatch is the DATA reader a test wants observed. It is watched
	// directly rather than type-asserted off whatever reader the backend
	// receives: a buffering server would hand over a different reader, and
	// the assertion would then pass vacuously.
	submitWatch *trackingReader
}

var _ Backend = (*fakeBackend)(nil)

func newFakeBackend() *fakeBackend { return &fakeBackend{} }

func (f *fakeBackend) Authenticate(ctx context.Context, mailbox, password string) (*backend.AuthResult, error) {
	f.mu.Lock()
	f.authCalls = append(f.authCalls, mailbox)
	injected := f.authErr
	f.mu.Unlock()

	if injected != nil {
		return nil, injected
	}
	if mailbox != testMailbox || password != testPassword {
		return nil, &backend.APIError{Kind: backend.ErrKindAuthFailed, StatusCode: 401, Body: "invalid credentials"}
	}
	return &backend.AuthResult{Mailbox: testMailbox}, nil
}

func (f *fakeBackend) Submit(ctx context.Context, mailbox string, body io.Reader, envelopeFrom string, envelopeTo []string) (*backend.SubmitResult, error) {
	call := submitCall{
		mailbox:      mailbox,
		envelopeFrom: envelopeFrom,
		envelopeTo:   append([]string(nil), envelopeTo...),
	}

	f.mu.Lock()
	injected := f.submitErr
	watch := f.submitWatch
	f.mu.Unlock()

	if watch != nil {
		call.watched = true
		call.consumedAtEntry = watch.consumed()
		call.watchedReader = body == io.Reader(watch)
	}

	if injected != nil {
		f.mu.Lock()
		f.submitCalls = append(f.submitCalls, call)
		f.mu.Unlock()
		return nil, injected
	}

	var buf strings.Builder
	if _, err := io.Copy(&buf, body); err != nil {
		return nil, err
	}
	call.body = buf.String()

	f.mu.Lock()
	f.submitCalls = append(f.submitCalls, call)
	f.mu.Unlock()

	return &backend.SubmitResult{MessageID: "<sent-1@bpxo.cc>", SentUID: 7, SentUIDValidity: 1787427939}, nil
}

func (f *fakeBackend) lastSubmit() (submitCall, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.submitCalls) == 0 {
		return submitCall{}, false
	}
	return f.submitCalls[len(f.submitCalls)-1], true
}

func (f *fakeBackend) submitCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.submitCalls)
}

func (f *fakeBackend) setSubmitErr(err error) {
	f.mu.Lock()
	f.submitErr = err
	f.mu.Unlock()
}

// trackingReader counts what has been read out of it, so a test can tell
// streaming from buffering.
type trackingReader struct {
	mu  sync.Mutex
	src io.Reader
	n   int64
}

func newTrackingReader(r io.Reader) *trackingReader { return &trackingReader{src: r} }

func (t *trackingReader) Read(p []byte) (int, error) {
	n, err := t.src.Read(p)
	t.mu.Lock()
	t.n += int64(n)
	t.mu.Unlock()
	return n, err
}

func (t *trackingReader) consumed() int64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.n
}

// ---------------------------------------------------------------------
// In-memory server harness
// ---------------------------------------------------------------------

// pipeListener hands out net.Pipe connections, so the tests never touch a
// real socket and never need a port.
type pipeListener struct {
	conns chan net.Conn
	done  chan struct{}
	once  sync.Once
}

type pipeAddr struct{}

func (pipeAddr) Network() string { return "pipe" }
func (pipeAddr) String() string  { return "pipe" }

func newPipeListener() *pipeListener {
	return &pipeListener{conns: make(chan net.Conn), done: make(chan struct{})}
}

func (l *pipeListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

func (l *pipeListener) Close() error {
	l.once.Do(func() { close(l.done) })
	return nil
}

func (l *pipeListener) Addr() net.Addr { return pipeAddr{} }

func (l *pipeListener) dial() (net.Conn, error) {
	server, client := net.Pipe()
	select {
	case l.conns <- server:
		return client, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

// rawClient speaks SMTP as text over the pipe.
type rawClient struct {
	t        *testing.T
	conn     net.Conn
	br       *bufio.Reader
	greeting string
}

// startRawClient runs a real go-smtp server over a pipe and returns a
// connected text client. AllowCleartext and AllowInsecureAuth are both
// needed because a pipe is not TLS; production takes neither.
func startRawClient(t *testing.T, be Backend, opts ...func(*Options)) *rawClient {
	t.Helper()

	options := Options{Domain: "gateway.test", AllowInsecureAuth: true, Logger: newTestLogger(t)}
	for _, opt := range opts {
		opt(&options)
	}

	ln := newPipeListener()
	srv := NewServer(be, options)

	served := make(chan error, 1)
	go func() { served <- srv.Serve(WrapListener(ln, AllowCleartext())) }()

	conn, err := ln.dial()
	if err != nil {
		t.Fatalf("dialing test listener: %v", err)
	}
	t.Cleanup(func() {
		conn.Close()
		srv.Close()
		ln.Close()
		<-served
	})

	c := &rawClient{t: t, conn: conn, br: bufio.NewReader(conn)}
	c.greeting = c.readLine()
	if !strings.HasPrefix(c.greeting, "220") {
		t.Fatalf("greeting = %q, want 220", c.greeting)
	}
	return c
}

func (c *rawClient) readLine() string {
	c.t.Helper()
	if err := c.conn.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
		c.t.Fatalf("SetReadDeadline: %v", err)
	}
	line, err := c.br.ReadString('\n')
	if err != nil {
		c.t.Fatalf("reading response: %v (partial %q)", err, line)
	}
	return strings.TrimRight(line, "\r\n")
}

// do sends a command and reads the complete (possibly multi-line) reply.
func (c *rawClient) do(format string, args ...interface{}) []string {
	c.t.Helper()
	c.write(fmt.Sprintf(format, args...) + "\r\n")
	return c.readReply()
}

func (c *rawClient) write(s string) {
	c.t.Helper()
	if err := c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		c.t.Fatalf("SetWriteDeadline: %v", err)
	}
	if _, err := c.conn.Write([]byte(s)); err != nil {
		c.t.Fatalf("writing %q: %v", s, err)
	}
}

// readReply reads one SMTP reply, following the "code-" continuation form.
func (c *rawClient) readReply() []string {
	c.t.Helper()
	var lines []string
	for {
		line := c.readLine()
		lines = append(lines, line)
		if len(line) < 4 || line[3] != '-' {
			return lines
		}
	}
}

func code(t *testing.T, lines []string) int {
	t.Helper()
	last := lines[len(lines)-1]
	if len(last) < 3 {
		t.Fatalf("malformed reply %q", last)
	}
	var n int
	if _, err := fmt.Sscanf(last[:3], "%d", &n); err != nil {
		t.Fatalf("malformed reply code in %q", last)
	}
	return n
}

func requireCode(t *testing.T, lines []string, want int) {
	t.Helper()
	if got := code(t, lines); got != want {
		t.Fatalf("reply = %q, want a %d", lines, want)
	}
}

// testWriter forwards log output to the test and goes quiet once the test
// is over: go-smtp's connection goroutines outlive the test function, and
// calling t.Log after it returns is a runtime panic.
type testWriter struct {
	t    *testing.T
	mu   sync.Mutex
	done bool
}

func (w *testWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.done {
		return len(p), nil
	}
	w.t.Log(strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

func newTestLogger(t *testing.T) *slog.Logger {
	w := &testWriter{t: t}
	// Registered before any cleanup that closes connections, so it runs
	// last: after this returns nothing can reach t.Log.
	t.Cleanup(func() {
		w.mu.Lock()
		w.done = true
		w.mu.Unlock()
	})
	return slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: slog.LevelDebug}))
}
