// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Command agentic-imapd is a stateless IMAP gateway for agentic-inbox. It
// speaks IMAP to mail clients and proxies every request to the Worker's
// HTTP API; it holds no mail and no durable state of its own.
//
// It listens only on a Tailscale interface (enforced by
// internal/config.CheckBindAddr) and terminates TLS using certificates
// produced by `tailscale cert`.
//
// The IMAP session (internal/imap.Session) is read/write: CAPABILITY, NOOP,
// LOGOUT, AUTHENTICATE PLAIN, LOGIN, ID, LIST, LSUB, STATUS, SELECT, EXAMINE,
// CLOSE, UNSELECT, SEARCH, FETCH, IDLE, STORE, COPY, MOVE, EXPUNGE and APPEND.
//
// Read-only was the original scope and it did not survive contact with real
// clients: a mail client treats a refused routine command as a fatal server
// error and reconnects in a loop, so every mutating command had to be
// implemented. IDLE is polling rather than push.
//
// SMTP submission (internal/smtp) runs alongside on a separate listener and is
// optional: if it cannot start, IMAP still serves.
package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/emersion/go-imap/v2/imapserver"
	gosmtp "github.com/emersion/go-smtp"

	"github.com/crumrine/agentic-inbox-imap/gateway/internal/backend"
	"github.com/crumrine/agentic-inbox-imap/gateway/internal/config"
	imapsession "github.com/crumrine/agentic-inbox-imap/gateway/internal/imap"
	smtpsession "github.com/crumrine/agentic-inbox-imap/gateway/internal/smtp"
	"io"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "agentic-imapd: "+err.Error())
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		// config.Load's errors are constructed to never include secret
		// values (see internal/config/config.go); safe to surface as-is.
		return err
	}

	logger := newLogger(cfg.LogLevel)
	logger.Info("starting agentic-imapd",
		"inbox_url", cfg.InboxURL.String(),
		"imap_addr", cfg.IMAPAddr,
		"log_level", cfg.LogLevel,
	)

	var backendOpts []backend.Option
	if cfg.AccessCookie != "" {
		// Testing path. Loud on purpose: this credential is one person's
		// Access session, it expires, and it must not reach production.
		logger.Warn("authenticating to the Worker with a CF_Authorization cookie; " +
			"this is for local testing only, use a service token in production")
		backendOpts = append(backendOpts, backend.WithAccessCookie(cfg.AccessCookie))
	}

	backendClient, err := backend.New(cfg.InboxURL.String(), cfg.AccessClientID, cfg.AccessClientSecret, backendOpts...)
	if err != nil {
		return fmt.Errorf("building backend client: %w", err)
	}
	defer backendClient.Close()

	cert, err := tls.LoadX509KeyPair(cfg.TLSCertFile, cfg.TLSKeyFile)
	if err != nil {
		return fmt.Errorf("loading TLS certificate: %w", err)
	}

	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
	}

	server := imapserver.New(&imapserver.Options{
		NewSession: func(conn *imapserver.Conn) (imapserver.Session, *imapserver.GreetingData, error) {
			return imapsession.NewSession(backendClient, imapsession.WithLogger(logger)), nil, nil
		},
		// No TLSConfig here on purpose. Options.TLSConfig exists only to
		// enable STARTTLS, and this listener is implicit TLS on 993, so
		// STARTTLS has nothing to offer. Leaving it set would be actively
		// wrong now: go-imap decides whether a connection is already
		// encrypted with a `c.conn.(*tls.Conn)` type assertion, the ID
		// proxy below wraps that connection, and the assertion therefore
		// fails — so the server would advertise STARTTLS on a connection
		// that is already TLS.
		//
		// InsecureAuth is set for the same reason, not because anything is
		// cleartext: canAuth() uses that same defeated type assertion and
		// would otherwise refuse LOGIN on a perfectly encrypted link. The
		// guarantee it normally provides is reinstated by the wrapped
		// listener, which by default drops any connection that is not a
		// *tls.Conn before go-imap can see it.
		Caps:         imapsession.ServerCaps(),
		InsecureAuth: true,
		Logger:       printfLogger{logger},
		// At debug level, dump the whole protocol conversation. Real mail
		// clients issue commands no unit test thinks to send, and the useful
		// failure detail is almost always the exact line the client choked on.
		//
		// SECURITY: this writes LOGIN lines, so it prints app passwords in
		// clear. Debug level only, and never in production.
		DebugWriter: debugWriter(cfg.LogLevel),
	})

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Listen for TLS ourselves rather than using ListenAndServeTLS, so the
	// accepted connections can be wrapped. The wrapper answers the RFC 2971
	// ID command, which go-imap does not implement and whose arrival before
	// LOGIN otherwise drops the connection — see internal/imap/idproxy.go.
	// Order matters: TLS terminates first, so the proxy sees plaintext IMAP.
	listener, err := tls.Listen("tcp", cfg.IMAPAddr, tlsConfig)
	if err != nil {
		return fmt.Errorf("listening on %s: %w", cfg.IMAPAddr, err)
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- server.Serve(imapsession.WrapListener(listener))
	}()

	// SMTP submission is an addition, and it must never be the reason a
	// working IMAP deployment stops serving. Every failure below is logged
	// and stepped over: a listener that cannot bind, a disabled address, a
	// missing Tailscale interface. A client then gets connection refused on
	// that port, which is loud, while mail keeps being readable.
	//
	// Two front doors, independently optional. 465 is implicit TLS; 587 is
	// the RFC 6409 port with mandatory STARTTLS, which is what clients
	// default to and what iOS Mail can reach at all.
	submissions := startSubmission(cfg, backendClient, tlsConfig, logger)

	shutdown := func() error {
		logger.Info("shutdown signal received, closing listeners")

		// Graceful: let an in-flight submission finish rather than
		// dropping a message the user already handed us.
		for _, sub := range submissions {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), smtpShutdownGrace)
			err := sub.server.Shutdown(shutdownCtx)
			cancel()
			<-sub.done
			if err != nil {
				logger.Error("smtp submission did not shut down cleanly",
					"listener", sub.name, "addr", sub.addr, "err", err)
			}
		}

		closeErr := server.Close()
		<-errCh // wait for Serve to return
		if closeErr != nil {
			return fmt.Errorf("closing imap server: %w", closeErr)
		}
		logger.Info("shutdown complete")
		return nil
	}

	select {
	case err := <-errCh:
		if err != nil {
			return fmt.Errorf("imap listener: %w", err)
		}
		return nil
	case <-ctx.Done():
		return shutdown()
	}
}

// smtpShutdownGrace bounds how long an in-flight submission may take to
// finish once a shutdown starts.
const smtpShutdownGrace = 30 * time.Second

// submissionListener is one running submission front door.
type submissionListener struct {
	name   string
	addr   string
	server *gosmtp.Server
	done   <-chan struct{}
}

// startSubmission brings up the submission listeners that are configured
// and can be bound. It never returns an error and never blocks startup:
// see the call site for why.
func startSubmission(cfg *config.Config, be *backend.Client, tlsConfig *tls.Config, logger *slog.Logger) []submissionListener {
	var running []submissionListener

	// 465: the listener terminates TLS, so the connection is encrypted
	// before go-smtp sees it and STARTTLS is not offered.
	if sub, ok := startOneSubmission(logger, "implicit-tls", cfg.SMTPAddr, config.EnvSMTPAddr,
		func() (net.Listener, error) { return tls.Listen("tcp", cfg.SMTPAddr, tlsConfig) },
		func() *gosmtp.Server {
			return smtpsession.NewImplicitTLSServer(be, smtpsession.Options{
				Domain: submissionDomain(cfg, cfg.SMTPAddr),
				Logger: logger,
			})
		},
		// Nothing that is not already TLS gets past the door.
		func(ln net.Listener) net.Listener { return smtpsession.WrapListener(ln) },
	); ok {
		running = append(running, sub)
	}

	// 587: a plain listener, upgraded in band. AUTH is neither advertised
	// nor accepted until STARTTLS has run, so this cannot leak a password.
	if sub, ok := startOneSubmission(logger, "starttls", cfg.SMTPStartTLSAddr, config.EnvSMTPStartTLSAddr,
		func() (net.Listener, error) { return net.Listen("tcp", cfg.SMTPStartTLSAddr) },
		func() *gosmtp.Server {
			return smtpsession.NewSTARTTLSServer(be, tlsConfig, smtpsession.Options{
				Domain: submissionDomain(cfg, cfg.SMTPStartTLSAddr),
				Logger: logger,
			})
		},
		// No wrapper: the connection is cleartext by design until the
		// client issues STARTTLS.
		func(ln net.Listener) net.Listener { return ln },
	); ok {
		running = append(running, sub)
	}

	if len(running) == 0 {
		logger.Warn("no smtp submission listener is running; outgoing mail will not work",
			"hint", "set "+config.EnvSMTPAddr+" or "+config.EnvSMTPStartTLSAddr)
	}
	return running
}

func startOneSubmission(
	logger *slog.Logger,
	name, addr, envVar string,
	listen func() (net.Listener, error),
	build func() *gosmtp.Server,
	wrap func(net.Listener) net.Listener,
) (submissionListener, bool) {
	if addr == "" {
		logger.Info("smtp submission listener disabled",
			"listener", name, "hint", "set "+envVar+" to enable")
		return submissionListener{}, false
	}

	ln, err := listen()
	if err != nil {
		logger.Error("smtp submission listener could not bind, continuing without it",
			"listener", name, "addr", addr, "err", err)
		return submissionListener{}, false
	}

	server := build()
	done := make(chan struct{})

	logger.Info("smtp submission listening",
		"listener", name, "addr", addr, "max_message_bytes", server.MaxMessageBytes)

	go func() {
		defer close(done)
		if err := server.Serve(wrap(ln)); err != nil {
			logger.Error("smtp submission listener stopped", "listener", name, "err", err)
		}
	}()

	return submissionListener{name: name, addr: addr, server: server, done: done}, true
}

// submissionDomain is the hostname announced in the SMTP greeting.
func submissionDomain(cfg *config.Config, addr string) string {
	if host, _, err := net.SplitHostPort(addr); err == nil && host != "" {
		return host
	}
	return "agentic-imapd"
}

// newLogger builds a slog.Logger writing to stderr at the level named by
// levelName (debug, info, warn, error; case-insensitive). Unrecognized
// values fall back to info.
func newLogger(levelName string) *slog.Logger {
	var level slog.Level
	switch strings.ToLower(strings.TrimSpace(levelName)) {
	case "debug":
		level = slog.LevelDebug
	case "warn", "warning":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}
	handler := slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level})
	return slog.New(handler)
}

// printfLogger adapts *slog.Logger to imapserver.Logger's Printf-based
// interface.
type printfLogger struct {
	l *slog.Logger
}

func (p printfLogger) Printf(format string, args ...interface{}) {
	p.l.Error(fmt.Sprintf(format, args...))
}

// debugWriter returns a writer for go-imap's protocol trace, or nil to disable
// it. Enabled only at debug level: the trace contains LOGIN lines and therefore
// app passwords in clear.
func debugWriter(levelName string) io.Writer {
	if strings.ToLower(strings.TrimSpace(levelName)) != "debug" {
		return nil
	}
	return os.Stderr
}
