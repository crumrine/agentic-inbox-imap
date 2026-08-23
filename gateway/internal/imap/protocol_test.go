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
		Logger:       newTestLogger(t),
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

	// An examined mailbox advertises no permanent flags: nothing about it
	// can be changed until the client reselects with SELECT.
	for _, want := range []string{"* 3 EXISTS", "[UIDVALIDITY 1712345678]", "[UIDNEXT 13]", "[PERMANENTFLAGS ()]", "[READ-ONLY]"} {
		if !strings.Contains(joined, want) {
			t.Errorf("EXAMINE response %q is missing %q", joined, want)
		}
	}
}

// TestSelectAdvertisesStorableFlags pins the advertisement STORE depends
// on. A client reads PERMANENTFLAGS to decide whether a flag change is
// worth attempting, so it has to match what Store accepts.
func TestSelectAdvertisesStorableFlags(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))

	lines := c.do("SELECT INBOX")
	requireOK(t, lines)
	joined := strings.Join(lines, "\n")

	if !strings.Contains(joined, `[PERMANENTFLAGS (\Seen \Answered \Flagged \Deleted \*)]`) {
		t.Errorf("SELECT response %q must advertise the storable flags", joined)
	}
	// \Draft is advertised in FLAGS (messages can have it) but is not
	// storable, so it must not appear in PERMANENTFLAGS.
	permIdx := strings.Index(joined, "[PERMANENTFLAGS")
	permEnd := strings.Index(joined[permIdx:], "]")
	if strings.Contains(joined[permIdx:permIdx+permEnd], `\Draft`) {
		t.Errorf("PERMANENTFLAGS lists \\Draft, which STORE ignores: %q", joined[permIdx:permIdx+permEnd])
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

// TestIdleCompletesOnDone covers the shape of the exchange that hung iOS
// Mail: the client is committed to idling the moment go-imap writes
// "+ idling", so IDLE must block until DONE and then complete OK.
func TestIdleCompletesOnDone(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t), WithPollInterval(0), WithIdleInterval(50*time.Millisecond))
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
	if !strings.Contains(final, " OK") {
		t.Fatalf("IDLE completion = %q, want OK", final)
	}

	requireOK(t, c.do("NOOP"))
}

// TestIdleDeliversNewMailUnprompted is the behaviour iOS Mail depends on:
// an EXISTS arrives while the client is idling and has sent nothing.
func TestIdleDeliversNewMailUnprompted(t *testing.T) {
	be := newFakeBackend(t)
	c := startRawClient(t, be, WithPollInterval(0), WithIdleInterval(20*time.Millisecond))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))

	c.seq++
	tag := fmt.Sprintf("t%d", c.seq)
	if _, err := c.conn.Write([]byte(tag + " IDLE\r\n")); err != nil {
		t.Fatalf("writing IDLE: %v", err)
	}
	if cont := c.readLine(); !strings.HasPrefix(cont, "+ ") {
		t.Fatalf("IDLE continuation = %q", cont)
	}

	be.deliver(t, "inbox", newMessage("while idling", "idle@example.com", time.Now()), rawMsg12)

	// No further client input: the next line must be the unsolicited
	// EXISTS produced by the idle refresh.
	line := c.readLine()
	if line != "* 4 EXISTS" {
		t.Fatalf("unsolicited update = %q, want \"* 4 EXISTS\"", line)
	}

	if _, err := c.conn.Write([]byte("DONE\r\n")); err != nil {
		t.Fatalf("writing DONE: %v", err)
	}
	if final := c.readLine(); !strings.Contains(final, " OK") {
		t.Fatalf("IDLE completion = %q, want OK", final)
	}

	// The message delivered during IDLE is addressable straight away.
	fetch := c.do("FETCH 4 (UID)")
	requireOK(t, fetch)
	if !strings.Contains(strings.Join(fetch, "\n"), "UID 13") {
		t.Errorf("FETCH 4 = %q, want UID 13", fetch)
	}
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
