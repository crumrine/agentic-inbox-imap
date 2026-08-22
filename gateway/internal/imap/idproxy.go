package imap

import (
	"bytes"
	"crypto/tls"
	"net"
	"strings"
	"sync"
	"time"
)

// This file works around a gap in go-imap v2.0.0-beta.8: imapserver has no
// handler for the RFC 2971 ID command, and its unknown-command path is
// hostile to one.
//
// imapserver/conn.go's command switch ends with:
//
//	default:
//	        if c.state == imap.ConnStateNotAuthenticated {
//	                c.state = imap.ConnStateLogout
//	                defer c.Bye("Unknown command")
//	        }
//	        err = &imap.Error{Type: Bad, Text: "Unknown command"}
//
// Dropping the connection on an unrecognised pre-auth command is a
// deliberate cross-protocol-attack mitigation upstream, not a bug. But
// Apple Mail and Thunderbird both send ID before LOGIN, so the combination
// means they cannot connect at all:
//
//	a2 ID ("name" "Mac OS X Mail" "version" "16.0")
//	a2 BAD Unknown command
//	* BYE Unknown command
//
// imapserver.Options exposes no hook for a custom command, imap.Cap values
// outside its hard-coded lists are never advertised, and beta.8 is the
// newest tag. So the interception happens below the library, on the
// net.Conn, before go-imap ever sees the bytes.
//
// The overriding design rule is that this code must get out of the way.
// It inspects the stream only during the narrow pre-auth window in which
// no IMAP literal can appear, and becomes an unconditional pipe the moment
// it sees anything it does not fully understand. Nothing here touches the
// outbound direction at all: the server's own bytes reach the client
// untouched.
//
// ID is therefore answered but never advertised. go-imap builds CAPABILITY
// from hard-coded allow-lists that have no entry for it, so advertising
// would mean rewriting responses on their way out, and a write-side stream
// rewriter is a much worse thing to own than a read-side one. It is also
// unnecessary: Apple Mail and Thunderbird both send ID unsolicited, which
// is the case that was breaking, and RFC 2971 costs a client nothing to
// skip. A client that checks CAPABILITY first simply will not send ID, and
// everything works.

const (
	// maxSniffBytes caps how much unterminated input is buffered while
	// looking for a command line. go-imap allows commands up to 50 KiB;
	// nothing this proxy handles is longer than a few hundred bytes, so a
	// line longer than this is by definition not our business.
	maxSniffBytes = 8 << 10

	// idWriteTimeout bounds the write of a locally generated ID response.
	idWriteTimeout = 30 * time.Second

	// readChunk is the scratch size used when pulling from the wire.
	readChunk = 4 << 10
)

// sniffSafeCommands are the commands the proxy forwards while continuing
// to inspect what follows. They are safe to stay in the stream for because
// they take no arguments, so they can never carry a literal, and their
// responses are single short lines.
//
// Apple Mail's real sequence is CAPABILITY then ID, so continuing past
// CAPABILITY is not optional.
var sniffSafeCommands = map[string]bool{
	"CAPABILITY": true,
	"NOOP":       true,
}

// ListenerOption configures the listener returned by WrapListener.
type ListenerOption func(*idListener)

// AllowCleartext permits connections that are not TLS. It is for tests
// only.
//
// TEST ONLY. Setting this on a serving listener allows app passwords to
// cross an unencrypted link. There is no production case for it: the
// gateway speaks implicit TLS on 993.
//
// The rejection it disables exists because wrapping a connection hides its
// concrete type from go-imap, whose canAuth() decides whether credentials
// may cross the wire with a `c.conn.(*tls.Conn)` type assertion. A wrapped
// TLS connection fails that assertion, so the server must run with
// InsecureAuth, and the listener is what puts the guarantee back: the
// check moves here, where the untampered connection is still visible.
//
// That coupling is the reason the default is the safe one. The check and
// the thing depending on it now live in different files, so forgetting an
// option has to fail closed.
func AllowCleartext() ListenerOption {
	return func(l *idListener) { l.allowCleartext = true }
}

// WrapListener returns a listener whose connections answer the IMAP ID
// command themselves instead of letting it reach go-imap.
//
// By default it accepts only TLS connections; see AllowCleartext.
//
// Wrap the TLS listener, not the TCP one: the proxy has to see plaintext
// IMAP.
func WrapListener(ln net.Listener, opts ...ListenerOption) net.Listener {
	l := &idListener{Listener: ln}
	for _, opt := range opts {
		opt(l)
	}
	return l
}

type idListener struct {
	net.Listener
	allowCleartext bool
}

func (l *idListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if !l.allowCleartext {
			if _, ok := conn.(*tls.Conn); !ok {
				// Never hand a cleartext connection to a server running
				// with InsecureAuth.
				conn.Close()
				continue
			}
		}
		return newIDConn(conn), nil
	}
}

// idConn answers ID during the pre-auth window and is a transparent pipe
// everywhere else.
//
// Only the read direction is ever inspected. Write is not overridden at
// all, so responses reach the client exactly as go-imap wrote them.
type idConn struct {
	net.Conn

	// mu guards sniff. Reads are driven by go-imap's single per-connection
	// goroutine today, so the lock is not strictly needed; it is kept so
	// that a future caller standing the proxy down from elsewhere is a
	// correctness question already answered rather than a data race.
	mu    sync.Mutex
	sniff bool // read side still inspecting commands

	pending []byte // read from the wire, not yet handed to go-imap
	scratch []byte
}

func newIDConn(conn net.Conn) *idConn {
	return &idConn{Conn: conn, sniff: true}
}

func (c *idConn) sniffing() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sniff
}

// standDown stops interception, permanently. From here the connection is
// a plain pipe in both directions for the rest of its life.
func (c *idConn) standDown() {
	c.mu.Lock()
	c.sniff = false
	c.mu.Unlock()
}

func (c *idConn) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}

	for {
		if !c.sniffing() {
			return c.drain(p)
		}

		idx := bytes.IndexByte(c.pending, '\n')
		if idx < 0 {
			if len(c.pending) >= maxSniffBytes {
				c.standDown()
				continue
			}
			if err := c.fill(); err != nil {
				// Whatever arrived before the failure still belongs to the
				// server; the error resurfaces on the next read.
				c.standDown()
				if len(c.pending) > 0 {
					return c.drain(p)
				}
				return 0, err
			}
			continue
		}

		line := c.pending[:idx+1]
		tag, command, ok := parseTagCommand(line)
		if !ok || lineEndsWithLiteral(line) {
			// Unparseable, or the arguments continue in a literal. Either
			// way the proxy cannot reason about the rest of the stream.
			c.standDown()
			continue
		}

		switch {
		case strings.EqualFold(command, "ID"):
			if err := c.writeIDResponse(tag); err != nil {
				return 0, err
			}
			c.consume(idx + 1)

		case sniffSafeCommands[strings.ToUpper(command)] && len(p) >= len(line):
			// Hand this one to go-imap but keep inspecting what follows.
			// The length check keeps the fast path off a short buffer,
			// where a half-forwarded line would leave the next read
			// looking at a fragment.
			n := copy(p, line)
			c.consume(n)
			return n, nil

		default:
			c.standDown()
		}
	}
}

// consume drops n bytes from the front of pending.
func (c *idConn) consume(n int) {
	c.pending = c.pending[n:]
	if len(c.pending) == 0 {
		c.pending = nil
	}
}

// drain hands over buffered bytes first, then reads straight through.
func (c *idConn) drain(p []byte) (int, error) {
	if len(c.pending) > 0 {
		n := copy(p, c.pending)
		c.consume(n)
		return n, nil
	}
	return c.Conn.Read(p)
}

func (c *idConn) fill() error {
	if c.scratch == nil {
		c.scratch = make([]byte, readChunk)
	}
	n, err := c.Conn.Read(c.scratch)
	if n > 0 {
		c.pending = append(c.pending, c.scratch[:n]...)
	}
	return err
}

// writeIDResponse answers ID with an empty parameter list. The gateway has
// nothing it wants to tell a client about itself, and NIL is the RFC 2971
// way to say so.
//
// This is the only byte the proxy ever originates, and it is only reachable
// while interception is still on, which is to say before go-imap has been
// handed any command and therefore while it cannot be mid-response.
func (c *idConn) writeIDResponse(tag string) error {
	var b strings.Builder
	b.WriteString("* ID NIL\r\n")
	b.WriteString(tag)
	b.WriteString(" OK ID completed\r\n")

	// go-imap sets its own write deadline before each of its writes, so
	// clearing this afterwards cannot strand a later response.
	_ = c.Conn.SetWriteDeadline(time.Now().Add(idWriteTimeout))
	defer func() { _ = c.Conn.SetWriteDeadline(time.Time{}) }()

	_, err := c.Conn.Write([]byte(b.String()))
	return err
}

// parseTagCommand splits "<tag> <command> ..." out of one complete line.
// It is deliberately strict: anything it cannot confidently parse is
// reported as not-a-command, which sends the proxy into pass-through.
func parseTagCommand(line []byte) (tag, command string, ok bool) {
	s := bytes.TrimRight(line, "\r\n")

	sp := bytes.IndexByte(s, ' ')
	if sp <= 0 {
		return "", "", false
	}
	rawTag := s[:sp]
	if !validTag(rawTag) {
		return "", "", false
	}

	rest := s[sp+1:]
	if end := bytes.IndexByte(rest, ' '); end >= 0 {
		rest = rest[:end]
	}
	if len(rest) == 0 {
		return "", "", false
	}
	return string(rawTag), string(rest), true
}

// validTag applies RFC 9051's tag grammar: one or more ASTRING-CHARs
// excluding '+'.
func validTag(tag []byte) bool {
	if len(tag) == 0 || len(tag) > 32 {
		return false
	}
	for _, b := range tag {
		if b <= 0x20 || b >= 0x7f {
			return false
		}
		switch b {
		case '(', ')', '{', '}', '%', '*', '"', '\\', ']', '+':
			return false
		}
	}
	return true
}

// lineEndsWithLiteral reports whether a command line ends in a literal
// marker, meaning its arguments continue on following lines.
//
// The proxy refuses to interpret such a command. Parsing a literal
// correctly means tracking byte counts and synchronising continuation
// requests, and a mistake there desynchronises the whole session; handing
// the stream to go-imap unread is strictly better.
func lineEndsWithLiteral(line []byte) bool {
	s := bytes.TrimRight(line, "\r\n")
	if len(s) == 0 || s[len(s)-1] != '}' {
		return false
	}
	open := bytes.LastIndexByte(s, '{')
	if open < 0 {
		return false
	}
	inner := s[open+1 : len(s)-1]
	if len(inner) > 0 && inner[len(inner)-1] == '+' { // LITERAL+/LITERAL-
		inner = inner[:len(inner)-1]
	}
	if len(inner) == 0 {
		return false
	}
	for _, b := range inner {
		if b < '0' || b > '9' {
			return false
		}
	}
	return true
}
