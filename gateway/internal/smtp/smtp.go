// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Package smtp implements the SMTP submission listener for agentic-imapd.
// It accepts mail from a client on the tailnet and streams it to the
// Worker's /submit endpoint, which is what puts the message through
// validateSender, the per-mailbox rate limit, and the Sent folder.
//
// Scope is deliberately narrow. This is a submission server, not an MTA: it
// accepts mail only from an authenticated mailbox and hands every message
// to exactly one upstream. There is no queue, no relay and no local
// delivery.
//
// # Transport
//
// Two listeners, one session implementation:
//
//   - 465, implicit TLS. The listener terminates TLS, so the connection is
//     already encrypted at accept time. STARTTLS is not offered because it
//     would be meaningless on an encrypted link, and a connection that
//     somehow is not TLS is dropped before it is greeted.
//   - 587, the RFC 6409 submission port, with mandatory STARTTLS. The
//     connection starts in the clear, as the port is specified to, and
//     AUTH is neither advertised nor accepted until it has been upgraded.
//
// 587 exists because clients default to it. iOS Mail's account setup has
// no outgoing port field at all: it tries 587 and nothing else, so a
// gateway that serves only 465 is one the phone never reaches. Declining
// to serve the port a client actually uses does not make anything safer.
//
// What makes 587 safe is that STARTTLS is mandatory rather than
// opportunistic. AllowInsecureAuth stays false on both listeners, so
// go-smtp refuses AUTH with 523 5.7.10 before it has even parsed the
// mechanism, and the EHLO response omits AUTH entirely until the
// connection is encrypted. A credential cannot reach the wire in clear.
//
// # Credentials
//
// AUTH PLAIN against the same POST /api/imap/v1/auth and the same app
// passwords as IMAP. There is deliberately no second credential system.
package smtp

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strings"
	"time"

	"github.com/emersion/go-sasl"
	gosmtp "github.com/emersion/go-smtp"

	"github.com/crumrine/agentic-inbox/gateway/internal/backend"
)

const (
	// DefaultMaxMessageBytes is the largest message submission accepts.
	//
	// Cloudflare caps outbound mail at 5 MiB including attachments, far
	// below the inbound limit, so this is advertised as SIZE in the EHLO
	// response. A client that respects it refuses an oversize message
	// before uploading it rather than after.
	DefaultMaxMessageBytes int64 = 5 << 20

	// DefaultReadTimeout and DefaultWriteTimeout bound a stalled client.
	DefaultReadTimeout  = 5 * time.Minute
	DefaultWriteTimeout = 1 * time.Minute

	// DefaultMaxRecipients bounds one transaction.
	DefaultMaxRecipients = 100
)

// Backend is the subset of the Worker API submission needs. *backend.Client
// satisfies it.
type Backend interface {
	Authenticate(ctx context.Context, mailbox, password string) (*backend.AuthResult, error)
	Submit(ctx context.Context, mailbox string, body io.Reader, envelopeFrom string, envelopeTo []string) (*backend.SubmitResult, error)
}

var _ Backend = (*backend.Client)(nil)

// Options configures a submission server.
type Options struct {
	// Domain is the hostname announced in the greeting and EHLO response.
	Domain string
	// MaxMessageBytes overrides DefaultMaxMessageBytes.
	MaxMessageBytes int64
	// Logger receives failures that are not reported to the client.
	Logger *slog.Logger
	// AllowInsecureAuth permits AUTH on a connection that is not TLS.
	//
	// TEST ONLY. It is what makes a net.Pipe harness possible, and there
	// is no production case for it: submission is implicit TLS.
	AllowInsecureAuth bool
}

// NewImplicitTLSServer builds the submission server for port 465, where
// the listener has already terminated TLS.
//
// Its TLSConfig is deliberately left unset. In go-smtp that field exists
// only to enable STARTTLS, and offering STARTTLS on a connection that is
// already encrypted is meaningless. Serve it behind WrapListener, which
// refuses anything that is not a *tls.Conn.
func NewImplicitTLSServer(be Backend, opts Options) *gosmtp.Server {
	return newServer(be, nil, opts)
}

// NewSTARTTLSServer builds the submission server for port 587, where the
// connection begins in the clear and is upgraded in band.
//
// tlsConfig must not be nil: without it go-smtp advertises no STARTTLS,
// and since AllowInsecureAuth stays false the listener would then accept
// no authentication at all. Serve it on a plain listener, not a TLS one.
//
// STARTTLS here is mandatory rather than opportunistic. AUTH is absent
// from the EHLO response and refused outright until the upgrade, so a
// client cannot be talked into sending a password in the clear.
func NewSTARTTLSServer(be Backend, tlsConfig *tls.Config, opts Options) *gosmtp.Server {
	return newServer(be, tlsConfig, opts)
}

// newServer is the single builder behind both front doors. The session
// logic, credential check, sender check, streaming and status mapping are
// identical; only how the connection gets encrypted differs.
func newServer(be Backend, tlsConfig *tls.Config, opts Options) *gosmtp.Server {
	if opts.MaxMessageBytes <= 0 {
		opts.MaxMessageBytes = DefaultMaxMessageBytes
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}

	srv := gosmtp.NewServer(gosmtp.BackendFunc(func(c *gosmtp.Conn) (gosmtp.Session, error) {
		return &session{be: be, logger: opts.Logger}, nil
	}))
	srv.Domain = opts.Domain
	// Advertising SIZE is the point: it makes a client refuse a too-large
	// message up front, and go-smtp also rejects an over-limit MAIL
	// FROM ... SIZE= and truncates DATA at the same bound.
	srv.MaxMessageBytes = opts.MaxMessageBytes
	srv.MaxRecipients = DefaultMaxRecipients
	srv.ReadTimeout = DefaultReadTimeout
	srv.WriteTimeout = DefaultWriteTimeout
	// Never true in production, on either listener. On 465 the link is
	// already TLS; on 587 this is exactly what makes STARTTLS mandatory
	// instead of optional.
	srv.AllowInsecureAuth = opts.AllowInsecureAuth
	srv.TLSConfig = tlsConfig
	srv.ErrorLog = slogSMTPLogger{opts.Logger}
	return srv
}

// slogSMTPLogger adapts *slog.Logger to go-smtp's logger interface.
type slogSMTPLogger struct{ l *slog.Logger }

func (s slogSMTPLogger) Printf(format string, v ...interface{}) {
	s.l.Error("smtp: " + fmt.Sprintf(format, v...))
}

func (s slogSMTPLogger) Println(v ...interface{}) {
	s.l.Error("smtp: " + fmt.Sprint(v...))
}

// ListenerOption configures the listener returned by WrapListener.
type ListenerOption func(*tlsListener)

// AllowCleartext permits connections that are not TLS.
//
// TEST ONLY. On a serving listener it allows app passwords to cross an
// unencrypted link. Submission is implicit TLS on 465; there is no
// production case for this.
func AllowCleartext() ListenerOption {
	return func(l *tlsListener) { l.allowCleartext = true }
}

// WrapListener refuses any connection that is not already a *tls.Conn.
//
// go-smtp gates AUTH on the same check through AllowInsecureAuth, so this
// is the second of two gates rather than the only one. It exists because
// the default has to be the safe one: a cleartext connection is dropped
// before it can even be greeted, and enabling otherwise takes an
// explicitly named option.
func WrapListener(ln net.Listener, opts ...ListenerOption) net.Listener {
	l := &tlsListener{Listener: ln}
	for _, opt := range opts {
		opt(l)
	}
	return l
}

type tlsListener struct {
	net.Listener
	allowCleartext bool
}

func (l *tlsListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if !l.allowCleartext {
			if _, ok := conn.(*tls.Conn); !ok {
				conn.Close()
				continue
			}
		}
		return conn, nil
	}
}

// ---------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------

// session is one SMTP transaction sequence on one connection.
//
// go-smtp drives it from a single goroutine per connection, so the fields
// need no lock.
type session struct {
	be     Backend
	logger *slog.Logger

	// mailbox is set once AUTH succeeds and is the only address this
	// session may send as.
	mailbox string

	from  string
	rcpts []string
}

var (
	_ gosmtp.Session     = (*session)(nil)
	_ gosmtp.AuthSession = (*session)(nil)
)

func (s *session) AuthMechanisms() []string {
	return []string{sasl.Plain}
}

// Auth verifies an app password against the Worker, the same credential
// IMAP uses.
//
// The password is never logged and never wrapped into a returned error;
// every failure returns go-smtp's constant ErrAuthFailed.
func (s *session) Auth(mech string) (sasl.Server, error) {
	if mech != sasl.Plain {
		return nil, gosmtp.ErrAuthUnknownMechanism
	}
	return sasl.NewPlainServer(func(identity, username, password string) error {
		if identity != "" && identity != username {
			return gosmtp.ErrAuthFailed
		}

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		res, err := s.be.Authenticate(ctx, username, password)
		if err != nil {
			if errors.Is(err, backend.ErrAuthFailed) || errors.Is(err, backend.ErrNotFound) {
				// A 404 is an unknown mailbox, which the client must not be
				// able to tell apart from a wrong password.
				return gosmtp.ErrAuthFailed
			}
			s.logger.Warn("smtp: authentication could not be checked", "err", err)
			return &gosmtp.SMTPError{
				Code:         454,
				EnhancedCode: gosmtp.EnhancedCode{4, 7, 0},
				Message:      "Temporary authentication failure, try again",
			}
		}

		s.mailbox = username
		if res != nil && res.Mailbox != "" {
			s.mailbox = res.Mailbox
		}
		return nil
	}), nil
}

// Mail records the envelope sender.
//
// The sender must be the authenticated mailbox. The Worker enforces this
// too, through validateSender, but doing it here means the client is told
// before it uploads a message that will be refused, and the gateway is not
// merely trusting that the far end checks.
//
// # Why the From: header is not checked here
//
// Only the envelope sender is verified. The From: header is left entirely
// to the Worker, for three reasons.
//
// The envelope sender is what SMTP AUTH actually authorises, and it is
// available before DATA. Checking it costs nothing and fails early.
// The From: header is message content: reaching it means either buffering
// the body, which this deliberately does not do, or a partial parse that
// can disagree with the Worker's parser. Two parsers with different
// opinions about a malformed header is a worse failure than one.
//
// The Worker also knows things this process does not. Which addresses a
// mailbox may legitimately send as, aliases and plus-addressing included,
// is policy that lives with validateSender. The gateway knows only the
// mailbox id it authenticated, so a check here could reject a send-as the
// Worker would have allowed, and it would reject it permanently.
//
// The mitigation is that the Worker's 403 maps to a clear 550, so a client
// that does send a mismatched From: gets a precise permanent error rather
// than silence.
func (s *session) Mail(from string, opts *gosmtp.MailOptions) error {
	if s.mailbox == "" {
		return gosmtp.ErrAuthRequired
	}

	addr := normaliseAddress(from)
	if addr == "" {
		// A null return path is for bounces, which a submission server
		// does not originate.
		return &gosmtp.SMTPError{
			Code:         550,
			EnhancedCode: gosmtp.EnhancedCode{5, 7, 1},
			Message:      "A null return path is not accepted for submission",
		}
	}
	if !strings.EqualFold(addr, s.mailbox) {
		return &gosmtp.SMTPError{
			Code:         550,
			EnhancedCode: gosmtp.EnhancedCode{5, 7, 1},
			Message:      "Sender must be the authenticated mailbox",
		}
	}

	s.from = addr
	s.rcpts = nil
	return nil
}

func (s *session) Rcpt(to string, opts *gosmtp.RcptOptions) error {
	if s.mailbox == "" {
		return gosmtp.ErrAuthRequired
	}
	addr := normaliseAddress(to)
	if addr == "" {
		return &gosmtp.SMTPError{
			Code:         501,
			EnhancedCode: gosmtp.EnhancedCode{5, 1, 3},
			Message:      "Recipient address is not valid",
		}
	}
	s.rcpts = append(s.rcpts, addr)
	return nil
}

// Data streams the message to the Worker.
//
// The body is never buffered here: a message is the one thing whose size a
// client chooses, and buffering it is the single place this process could
// be made to allocate arbitrarily. go-smtp drains anything left in r once
// this returns, so the error paths cannot desynchronise the connection.
func (s *session) Data(r io.Reader) error {
	if s.mailbox == "" {
		return gosmtp.ErrAuthRequired
	}
	if s.from == "" || len(s.rcpts) == 0 {
		return &gosmtp.SMTPError{
			Code:         554,
			EnhancedCode: gosmtp.EnhancedCode{5, 5, 1},
			Message:      "No valid sender and recipient",
		}
	}

	// No overall deadline here: the backend client applies its own upload
	// timeout, which is sized for a transfer rather than for a round trip.
	result, err := s.be.Submit(context.Background(), s.mailbox, r, s.from, s.rcpts)
	if err != nil {
		return s.submitError(err)
	}

	s.logger.Info("smtp: message submitted",
		"mailbox", s.mailbox, "recipients", len(s.rcpts),
		"messageId", result.MessageID, "sentUid", result.SentUID)
	return nil
}

// submitError maps a Worker response onto an SMTP status.
//
// The temporary/permanent split is the part that matters. A permanent
// failure makes a client discard the message; a temporary one makes it
// queue and retry. So the rule is deliberately asymmetric: only the two
// statuses the contract defines as the client's own fault are permanent,
// and everything else, including anything unrecognised, is temporary.
// Losing a message the user wrote is worse than a retry loop, which is at
// least visible and recoverable.
func (s *session) submitError(err error) error {
	var apiErr *backend.APIError
	if !errors.As(err, &apiErr) {
		s.logger.Warn("smtp: submission failed", "mailbox", s.mailbox, "err", err)
		return &gosmtp.SMTPError{
			Code:         451,
			EnhancedCode: gosmtp.EnhancedCode{4, 3, 0},
			Message:      "Temporary failure submitting the message, try again",
		}
	}

	s.logger.Warn("smtp: submission rejected by the Worker",
		"mailbox", s.mailbox, "status", apiErr.StatusCode)

	switch apiErr.StatusCode {
	case 403:
		// validateSender refused. The client cannot fix this by retrying.
		return &gosmtp.SMTPError{
			Code:         550,
			EnhancedCode: gosmtp.EnhancedCode{5, 7, 1},
			Message:      "Sender not permitted for this mailbox",
		}
	case 413:
		return &gosmtp.SMTPError{
			Code:         552,
			EnhancedCode: gosmtp.EnhancedCode{5, 3, 4},
			Message:      "Message exceeds the maximum size accepted for delivery",
		}
	case 429:
		return &gosmtp.SMTPError{
			Code:         451,
			EnhancedCode: gosmtp.EnhancedCode{4, 7, 0},
			Message:      rateLimitMessage(apiErr.RetryAfter),
		}
	default:
		return &gosmtp.SMTPError{
			Code:         451,
			EnhancedCode: gosmtp.EnhancedCode{4, 3, 0},
			Message:      "Temporary failure submitting the message, try again",
		}
	}
}

func rateLimitMessage(retryAfter time.Duration) string {
	if retryAfter <= 0 {
		return "Sending rate limit reached, try again later"
	}
	return fmt.Sprintf("Sending rate limit reached, try again in %d seconds", int(retryAfter.Seconds()))
}

// Reset abandons the current transaction. The authenticated mailbox
// survives it, as RFC 5321 requires.
func (s *session) Reset() {
	s.from = ""
	s.rcpts = nil
}

func (s *session) Logout() error {
	s.mailbox = ""
	s.Reset()
	return nil
}

// normaliseAddress trims the angle brackets and whitespace go-smtp may
// leave on an address.
func normaliseAddress(addr string) string {
	addr = strings.TrimSpace(addr)
	addr = strings.TrimPrefix(addr, "<")
	addr = strings.TrimSuffix(addr, ">")
	return strings.TrimSpace(addr)
}
