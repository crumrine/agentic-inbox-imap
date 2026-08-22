package imap

import (
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// TestIDBeforeLoginDoesNotKillTheConnection is the regression test for the
// Apple Mail blocker. Without the proxy go-imap answers BAD and then BYE,
// and the client can never authenticate.
func TestIDBeforeLoginDoesNotKillTheConnection(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))

	lines := c.do(`ID ("name" "Mac OS X Mail" "version" "16.0")`)
	requireOK(t, lines)

	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "* ID NIL") {
		t.Errorf("ID response = %q, want an untagged * ID NIL", joined)
	}
	if strings.Contains(joined, "BAD") || strings.Contains(joined, "BYE") {
		t.Fatalf("ID response = %q; the command reached go-imap", joined)
	}

	// The connection is still usable and authentication still works.
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))
}

// TestAppleMailConnectSequence walks the exact order a real client uses,
// end to end over the real imapserver.
func TestAppleMailConnectSequence(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))

	caps := c.do("CAPABILITY")
	requireOK(t, caps)
	if !strings.Contains(strings.Join(caps, "\n"), "IMAP4rev1") {
		t.Fatalf("CAPABILITY = %q", caps)
	}

	// ID arrives after CAPABILITY and before LOGIN, which is why the proxy
	// has to keep inspecting past a CAPABILITY command rather than going
	// transparent on the first non-ID line.
	requireOK(t, c.do(`ID ("name" "Mac OS X Mail" "version" "16.0" "os" "Mac OS X" "os-version" "14.5")`))

	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))

	list := c.do(`LIST "" "*"`)
	requireOK(t, list)
	if !strings.Contains(strings.Join(list, "\n"), "INBOX") {
		t.Errorf("LIST = %q, want INBOX", list)
	}

	sel := c.do("SELECT INBOX")
	requireOK(t, sel)
	if !strings.Contains(strings.Join(sel, "\n"), "* 3 EXISTS") {
		t.Errorf("SELECT = %q, want 3 EXISTS", sel)
	}

	fetch := c.do("FETCH 1:* (UID FLAGS INTERNALDATE RFC822.SIZE ENVELOPE)")
	requireOK(t, fetch)
	joined := strings.Join(fetch, "\n")
	for _, want := range []string{"UID 5", "UID 9", "UID 12"} {
		if !strings.Contains(joined, want) {
			t.Errorf("FETCH = %q, missing %q", joined, want)
		}
	}

	body := c.do("UID FETCH 5 (BODY.PEEK[])")
	requireOK(t, body)
	if !strings.Contains(strings.Join(body, "\n"), "strawberries") {
		t.Errorf("UID FETCH 5 BODY[] = %q, want the message body", body)
	}
}

func TestIDEchoesTheClientTag(t *testing.T) {
	for _, tag := range []string{"a1", "A-99.xyz", "0000000123", "ZZZZ"} {
		t.Run(tag, func(t *testing.T) {
			c := startRawClient(t, newFakeBackend(t))
			if _, err := c.conn.Write([]byte(tag + " ID NIL\r\n")); err != nil {
				t.Fatalf("writing ID: %v", err)
			}
			if first := c.readLine(); first != "* ID NIL" {
				t.Fatalf("first line = %q, want \"* ID NIL\"", first)
			}
			second := c.readLine()
			if second != tag+" OK ID completed" {
				t.Errorf("completion = %q, want %q", second, tag+" OK ID completed")
			}
		})
	}
}

// TestIDWithLiteralArgumentFallsBackToPassThrough: the proxy must not try
// to parse a command whose arguments continue in a literal. Degrading to
// go-imap's own (unhelpful) handling beats desynchronising the stream.
func TestIDWithLiteralArgumentFallsBackToPassThrough(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))

	if _, err := c.conn.Write([]byte("z1 ID (\"name\" {4}\r\ntest)\r\n")); err != nil {
		t.Fatalf("writing ID: %v", err)
	}
	first := c.readLine()
	if strings.Contains(first, "* ID NIL") {
		t.Fatalf("first line = %q; the proxy answered an ID it could not parse", first)
	}
	if !strings.Contains(first, "BAD") {
		t.Errorf("first line = %q, want go-imap's own BAD for an unknown command", first)
	}
}

// TestLoginWithLiteralPasswordStillAuthenticates proves the proxy is not
// corrupting literals: the password arrives on its own line after a
// continuation request.
func TestLoginWithLiteralPasswordStillAuthenticates(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))

	cmd := "q1 LOGIN " + testMailbox + " {" + itoa(len(testPassword)) + "}\r\n"
	if _, err := c.conn.Write([]byte(cmd)); err != nil {
		t.Fatalf("writing LOGIN: %v", err)
	}
	cont := c.readLine()
	if !strings.HasPrefix(cont, "+") {
		t.Fatalf("expected a continuation request, got %q", cont)
	}
	if _, err := c.conn.Write([]byte(testPassword + "\r\n")); err != nil {
		t.Fatalf("writing the literal: %v", err)
	}
	final := c.readLine()
	if !strings.Contains(final, "OK") {
		t.Fatalf("LOGIN with a literal password = %q, want OK", final)
	}

	requireOK(t, c.do("SELECT INBOX"))
}

// TestLoginWithLiteralPasswordAfterID covers the combination: the proxy
// has answered an ID, then has to hand a literal-bearing LOGIN over
// untouched.
func TestLoginWithLiteralPasswordAfterID(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	requireOK(t, c.do(`ID ("name" "Thunderbird")`))

	cmd := "q1 LOGIN " + testMailbox + " {" + itoa(len(testPassword)) + "}\r\n"
	if _, err := c.conn.Write([]byte(cmd)); err != nil {
		t.Fatalf("writing LOGIN: %v", err)
	}
	if cont := c.readLine(); !strings.HasPrefix(cont, "+") {
		t.Fatalf("expected a continuation request, got %q", cont)
	}
	if _, err := c.conn.Write([]byte(testPassword + "\r\n")); err != nil {
		t.Fatalf("writing the literal: %v", err)
	}
	if final := c.readLine(); !strings.Contains(final, "OK") {
		t.Fatalf("LOGIN = %q, want OK", final)
	}
}

// TestIDIsAnsweredThoughNotAdvertised pins the deliberate asymmetry: the
// proxy handles ID but does not claim it in CAPABILITY, because claiming
// it would mean rewriting responses on their way out and go-imap offers no
// other way to add a capability.
//
// The whole fix therefore rests on clients sending ID unsolicited, which
// Apple Mail and Thunderbird both do. If someone later adds advertisement,
// this test is where they will find out that was a decision, not an
// oversight.
func TestIDIsAnsweredThoughNotAdvertised(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))

	if hasIDCapability(c.greeting) {
		t.Errorf("greeting = %q, advertises ID; the proxy does not rewrite responses", c.greeting)
	}

	caps := c.do("CAPABILITY")
	requireOK(t, caps)
	for _, line := range caps {
		if strings.HasPrefix(line, "* CAPABILITY ") && hasIDCapability(line) {
			t.Errorf("CAPABILITY = %q, advertises ID", line)
		}
	}

	// Unadvertised, but answered.
	lines := c.do(`ID ("name" "Mac OS X Mail")`)
	requireOK(t, lines)
	if !strings.Contains(strings.Join(lines, "\n"), "* ID NIL") {
		t.Errorf("ID = %q, want * ID NIL", lines)
	}
}

// hasIDCapability looks for ID as a whole token in a capability list.
func hasIDCapability(line string) bool {
	for _, field := range strings.Fields(line) {
		if strings.EqualFold(strings.TrimSuffix(field, "]"), "ID") {
			return true
		}
	}
	return false
}

// TestPassThroughIsByteForByte drives idConn directly: a first command
// that is not ID must be forwarded exactly, with nothing lost, added or
// duplicated, including the literal that follows it.
func TestPassThroughIsByteForByte(t *testing.T) {
	payloads := []string{
		"a1 LOGIN user pass\r\n",
		"a1 LOGIN user {6}\r\nsecret\r\na2 NOOP\r\n",
		"a1 SELECT INBOX\r\na2 FETCH 1 (UID)\r\n",
		"garbage without a tag\r\n",
		"\r\n",
		"a1 CAPABILITY\r\na2 LOGIN user pass\r\na3 SELECT INBOX\r\n",
	}

	for _, payload := range payloads {
		t.Run(strings.SplitN(payload, "\r\n", 2)[0], func(t *testing.T) {
			clientEnd, serverEnd := net.Pipe()
			defer clientEnd.Close()
			defer serverEnd.Close()

			wrapped := newIDConn(serverEnd)

			writeErr := make(chan error, 1)
			go func() {
				_, err := clientEnd.Write([]byte(payload))
				writeErr <- err
			}()

			got := make([]byte, len(payload))
			if err := readFullWithDeadline(t, wrapped, got); err != nil {
				t.Fatalf("reading through the proxy: %v", err)
			}
			if err := <-writeErr; err != nil {
				t.Fatalf("client write: %v", err)
			}
			if string(got) != payload {
				t.Errorf("proxy delivered %q, want %q", got, payload)
			}
		})
	}
}

// TestPipelinedIDThenLoginIsNotLost: a client may put both commands in one
// packet. The ID must be answered and the LOGIN forwarded intact.
func TestPipelinedIDThenLoginIsNotLost(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))

	pipelined := "p1 ID (\"name\" \"Mac OS X Mail\")\r\np2 LOGIN " + testMailbox + " " + testPassword + "\r\n"
	if _, err := c.conn.Write([]byte(pipelined)); err != nil {
		t.Fatalf("writing pipelined commands: %v", err)
	}

	if first := c.readLine(); first != "* ID NIL" {
		t.Fatalf("first line = %q, want \"* ID NIL\"", first)
	}
	if second := c.readLine(); second != "p1 OK ID completed" {
		t.Fatalf("second line = %q, want the ID completion", second)
	}
	third := c.readLine()
	if !strings.HasPrefix(third, "p2 ") || !strings.Contains(third, "OK") {
		t.Fatalf("LOGIN completion = %q, want a p2 OK", third)
	}

	requireOK(t, c.do("SELECT INBOX"))
}

// TestWrapListenerRejectsCleartextByDefault pins the default. The
// enforcement of "credentials only over TLS" lives here rather than in
// go-imap, because wrapping the connection defeats the library's own
// `c.conn.(*tls.Conn)` check and the server therefore runs with
// InsecureAuth. Forgetting an option has to fail closed.
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

	// The listener must have closed it rather than handing it upstream.
	_ = clientEnd.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 1)
	if _, err := clientEnd.Read(buf); err == nil {
		t.Fatal("a cleartext connection survived WrapListener's default")
	}

	select {
	case conn := <-accepted:
		conn.Close()
		t.Fatal("WrapListener handed a cleartext connection to the server by default")
	case <-time.After(100 * time.Millisecond):
	}
}

// TestAllowCleartextIsOptIn is the other half: the escape hatch works, and
// it is the only thing that makes cleartext reachable.
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
		if _, ok := conn.(*idConn); !ok {
			t.Errorf("accepted connection is %T, want *idConn", conn)
		}
		conn.Close()
	case <-time.After(5 * time.Second):
		t.Fatal("AllowCleartext did not accept an unencrypted connection")
	}
}

func readFullWithDeadline(t *testing.T, conn net.Conn, buf []byte) error {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	_, err := io.ReadFull(conn, buf)
	return err
}

// ---------------------------------------------------------------------
// Unit tests for the parsing pieces
// ---------------------------------------------------------------------

func TestParseTagCommand(t *testing.T) {
	tests := []struct {
		line    string
		tag     string
		command string
		ok      bool
	}{
		{"a1 ID NIL\r\n", "a1", "ID", true},
		{"a1 id nil\r\n", "a1", "id", true},
		{"A-99.xyz ID (\"name\" \"x\")\r\n", "A-99.xyz", "ID", true},
		{"a1 CAPABILITY\r\n", "a1", "CAPABILITY", true},
		{"a1 LOGIN user pass\r\n", "a1", "LOGIN", true},
		{"a1 NOOP\n", "a1", "NOOP", true},
		{"\r\n", "", "", false},
		{"noSpace\r\n", "", "", false},
		{" leadingspace ID\r\n", "", "", false},
		{"a1 \r\n", "", "", false},
		{"+tag ID\r\n", "", "", false},
		{"ta(g ID\r\n", "", "", false},
		{strings.Repeat("x", 33) + " ID\r\n", "", "", false},
	}
	for _, tc := range tests {
		t.Run(strings.TrimRight(tc.line, "\r\n"), func(t *testing.T) {
			tag, command, ok := parseTagCommand([]byte(tc.line))
			if ok != tc.ok || tag != tc.tag || command != tc.command {
				t.Errorf("parseTagCommand(%q) = (%q, %q, %v), want (%q, %q, %v)",
					tc.line, tag, command, ok, tc.tag, tc.command, tc.ok)
			}
		})
	}
}

func TestLineEndsWithLiteral(t *testing.T) {
	tests := map[string]bool{
		"a1 LOGIN user {6}\r\n":            true,
		"a1 LOGIN user {6+}\r\n":           true,
		"a1 ID (\"name\" {4}\r\n":          true,
		"a1 LOGIN user pass\r\n":           false,
		"a1 ID NIL\r\n":                    false,
		"a1 FETCH 1 BODY[]<0.10>\r\n":      false,
		"a1 SELECT \"{not a literal\"\r\n": false,
		"a1 SELECT {}\r\n":                 false,
		"a1 SELECT {abc}\r\n":              false,
		"":                                 false,
	}
	for line, want := range tests {
		if got := lineEndsWithLiteral([]byte(line)); got != want {
			t.Errorf("lineEndsWithLiteral(%q) = %v, want %v", line, got, want)
		}
	}
}

func TestIDConnStandsDownPermanently(t *testing.T) {
	clientEnd, serverEnd := net.Pipe()
	defer clientEnd.Close()
	defer serverEnd.Close()

	conn := newIDConn(serverEnd)
	if !conn.sniffing() {
		t.Fatal("a fresh connection should be inspecting")
	}
	conn.standDown()
	if conn.sniffing() {
		t.Error("standDown did not stop interception")
	}
}

// TestIDIsNotInterceptedAfterAuthentication documents the boundary: once
// the proxy has stood down it stays down, so a post-login ID reaches
// go-imap. That is survivable (a BAD past the not-authenticated state does
// not drop the connection) but it is a real limit of this approach.
func TestIDIsNotInterceptedAfterAuthentication(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))

	lines := c.do(`ID ("name" "Mac OS X Mail")`)
	if !strings.Contains(lastLine(lines), "BAD") {
		t.Errorf("post-auth ID = %q; if this now succeeds the comment above is stale", lastLine(lines))
	}
	// The important part: the connection survives it.
	requireOK(t, c.do("SELECT INBOX"))
}
