// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2/imapserver"
)

// rawClient speaks IMAP as text. go-imap's own client cannot issue LSUB,
// EXAMINE or the obsolete RFC822 fetch item, and those are all in scope, so
// the only way to test them is on the wire.
type rawClient struct {
	t    *testing.T
	conn net.Conn
	br   *bufio.Reader
	seq  int

	// greeting is the server's first line, kept so tests can assert on the
	// capability list it advertises.
	greeting string
}

func startRawClient(t *testing.T, be Backend, opts ...Option) *rawClient {
	t.Helper()

	ln := newPipeListener()
	srv := imapserver.New(&imapserver.Options{
		NewSession: func(conn *imapserver.Conn) (imapserver.Session, *imapserver.GreetingData, error) {
			return NewSession(be, opts...), nil, nil
		},
		InsecureAuth: true,
		Logger:       testLogger{t},
	})
	served := make(chan error, 1)
	go func() { served <- srv.Serve(WrapListener(ln, AllowCleartext())) }()

	conn, err := ln.dial()
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() {
		conn.Close()
		srv.Close()
		ln.Close()
		<-served
	})

	c := &rawClient{t: t, conn: conn, br: bufio.NewReader(conn)}
	c.greeting = c.readLine()
	if !strings.HasPrefix(c.greeting, "* OK") {
		t.Fatalf("greeting = %q, want * OK ...", c.greeting)
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

// do sends one command and returns every line up to and including the
// tagged completion. Literal payloads are returned inline, which is fine
// for the small fixtures used here.
func (c *rawClient) do(format string, args ...interface{}) []string {
	c.t.Helper()
	c.seq++
	tag := fmt.Sprintf("t%d", c.seq)
	cmd := tag + " " + fmt.Sprintf(format, args...) + "\r\n"

	if err := c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		c.t.Fatalf("SetWriteDeadline: %v", err)
	}
	if _, err := c.conn.Write([]byte(cmd)); err != nil {
		c.t.Fatalf("writing %q: %v", cmd, err)
	}

	var lines []string
	for {
		line := c.readLine()
		lines = append(lines, line)
		if strings.HasPrefix(line, tag+" ") {
			return lines
		}
	}
}

func lastLine(lines []string) string { return lines[len(lines)-1] }

func requireOK(t *testing.T, lines []string) {
	t.Helper()
	final := lastLine(lines)
	if !strings.Contains(final, " OK") {
		t.Fatalf("command failed: %q (full response %q)", final, lines)
	}
}

func requireNo(t *testing.T, lines []string) {
	t.Helper()
	final := lastLine(lines)
	if !strings.Contains(final, " NO") {
		t.Fatalf("expected a NO, got %q (full response %q)", final, lines)
	}
}

func TestCapabilityAdvertisesPlainAuth(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	lines := c.do("CAPABILITY")
	requireOK(t, lines)

	joined := strings.Join(lines, "\n")
	for _, want := range []string{"IMAP4rev1", "AUTH=PLAIN"} {
		if !strings.Contains(joined, want) {
			t.Errorf("CAPABILITY response %q is missing %q", joined, want)
		}
	}
}

func TestAuthenticatePlain(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	// SASL PLAIN initial response: authzid NUL authcid NUL password.
	ir := base64.StdEncoding.EncodeToString([]byte("\x00" + testMailbox + "\x00" + testPassword))
	requireOK(t, c.do("AUTHENTICATE PLAIN %s", ir))
	requireOK(t, c.do("NOOP"))
	requireOK(t, c.do("SELECT INBOX"))
}

func TestAuthenticatePlainWrongPassword(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	ir := base64.StdEncoding.EncodeToString([]byte("\x00" + testMailbox + "\x00wrong"))
	lines := c.do("AUTHENTICATE PLAIN %s", ir)
	requireNo(t, lines)
	if !strings.Contains(lastLine(lines), "AUTHENTICATIONFAILED") {
		t.Errorf("response = %q, want an AUTHENTICATIONFAILED code", lastLine(lines))
	}
	if strings.Contains(strings.Join(lines, "\n"), "wrong") {
		t.Errorf("response %q echoes the password", lines)
	}
}

func TestLSubListsEverySubscribedFolder(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))

	lines := c.do(`LSUB "" "*"`)
	requireOK(t, lines)

	var count int
	for _, line := range lines {
		if strings.HasPrefix(line, "* LSUB ") {
			count++
		}
	}
	if count != 3 {
		t.Errorf("LSUB returned %d mailboxes, want 3: %q", count, lines)
	}
	joined := strings.Join(lines, "\n")
	for _, want := range []string{"INBOX", "Archive", "Sent"} {
		if !strings.Contains(joined, want) {
			t.Errorf("LSUB response %q is missing %q", joined, want)
		}
	}
}

func TestExamineIsReadOnly(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))

	lines := c.do("EXAMINE INBOX")
	requireOK(t, lines)
	joined := strings.Join(lines, "\n")

	for _, want := range []string{"* 3 EXISTS", "[UIDVALIDITY 1712345678]", "[UIDNEXT 13]", "[PERMANENTFLAGS ()]", "[READ-ONLY]"} {
		if !strings.Contains(joined, want) {
			t.Errorf("EXAMINE response %q is missing %q", joined, want)
		}
	}
}

// TestSelectAdvertisesNoPermanentFlags documents the one thing this go-imap
// version will not let the session control: SELECT is always answered with
// [READ-WRITE]. Empty PERMANENTFLAGS is how the read-only nature reaches
// the client instead.
func TestSelectAdvertisesNoPermanentFlags(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))

	lines := c.do("SELECT INBOX")
	requireOK(t, lines)
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "[PERMANENTFLAGS ()]") {
		t.Errorf("SELECT response %q must advertise no permanent flags", joined)
	}
}

// TestFetchObsoleteRFC822Items covers RFC822, RFC822.HEADER and
// RFC822.TEXT, which go-imap rewrites into BODY sections and echoes back
// under their obsolete names. Outlook still sends these.
func TestFetchObsoleteRFC822Items(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))

	lines := c.do("FETCH 1 (RFC822)")
	requireOK(t, lines)
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "RFC822 {") {
		t.Errorf("FETCH 1 (RFC822) = %q, want an RFC822 literal", joined)
	}
	if !strings.Contains(joined, "strawberries") {
		t.Errorf("FETCH 1 (RFC822) = %q, want the message body", joined)
	}

	headerLines := c.do("FETCH 1 (RFC822.HEADER)")
	requireOK(t, headerLines)
	headerJoined := strings.Join(headerLines, "\n")
	if !strings.Contains(headerJoined, "RFC822.HEADER {") {
		t.Errorf("FETCH 1 (RFC822.HEADER) = %q", headerJoined)
	}
	if strings.Contains(headerJoined, "strawberries") {
		t.Errorf("RFC822.HEADER leaked the body: %q", headerJoined)
	}

	textLines := c.do("FETCH 1 (RFC822.TEXT)")
	requireOK(t, textLines)
	if !strings.Contains(strings.Join(textLines, "\n"), "RFC822.TEXT {") {
		t.Errorf("FETCH 1 (RFC822.TEXT) = %q", textLines)
	}
}

func TestSearchOverTheWire(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))

	lines := c.do("SEARCH SEEN")
	requireOK(t, lines)
	if !strings.Contains(strings.Join(lines, "\n"), "* SEARCH 1 2") {
		t.Errorf("SEARCH SEEN = %q, want sequence numbers 1 and 2", lines)
	}

	uidLines := c.do("UID SEARCH UNSEEN")
	requireOK(t, uidLines)
	if !strings.Contains(strings.Join(uidLines, "\n"), "* SEARCH 12") {
		t.Errorf("UID SEARCH UNSEEN = %q, want UID 12", uidLines)
	}

	// A search with no matches must still produce a well-formed, empty
	// SEARCH response rather than an encoder error.
	emptyLines := c.do("SEARCH FROM nobody")
	requireOK(t, emptyLines)
	if !strings.Contains(strings.Join(emptyLines, "\n"), "* SEARCH") {
		t.Errorf("empty SEARCH = %q, want a bare * SEARCH line", emptyLines)
	}
}

func TestCloseAndUnselect(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))

	requireOK(t, c.do("SELECT INBOX"))
	requireOK(t, c.do("CLOSE"))
	// After CLOSE the connection is authenticated but no longer selected,
	// so go-imap rejects selected-state commands before they reach us.
	if final := lastLine(c.do("FETCH 1 (UID)")); !strings.Contains(final, " BAD") {
		t.Errorf("FETCH after CLOSE = %q, want BAD (not in the selected state)", final)
	}

	requireOK(t, c.do("SELECT INBOX"))
	requireOK(t, c.do("UNSELECT"))
	requireOK(t, c.do("NOOP"))
}

func TestIdleIsRefusedCleanly(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))

	c.seq++
	tag := fmt.Sprintf("t%d", c.seq)
	if _, err := c.conn.Write([]byte(tag + " IDLE\r\n")); err != nil {
		t.Fatalf("writing IDLE: %v", err)
	}
	cont := c.readLine()
	if !strings.HasPrefix(cont, "+ ") {
		t.Fatalf("IDLE continuation = %q, want a + line", cont)
	}
	if _, err := c.conn.Write([]byte("DONE\r\n")); err != nil {
		t.Fatalf("writing DONE: %v", err)
	}
	final := c.readLine()
	if !strings.Contains(final, " NO") {
		t.Errorf("IDLE completion = %q, want NO (IDLE is out of scope in phase 1)", final)
	}

	// The connection must remain usable after the refusal.
	requireOK(t, c.do("NOOP"))
}

func TestLogoutOverTheWire(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	lines := c.do("LOGOUT")
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "* BYE") {
		t.Errorf("LOGOUT = %q, want a BYE", joined)
	}
	requireOK(t, lines)
}
