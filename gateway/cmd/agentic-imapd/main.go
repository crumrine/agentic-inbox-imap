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
// The IMAP session (internal/imap.Session) is read-only: it serves
// CAPABILITY, NOOP, LOGOUT, AUTHENTICATE PLAIN, LOGIN, LIST, LSUB, STATUS,
// SELECT, EXAMINE, CLOSE, UNSELECT, SEARCH and FETCH. Every mutating
// command answers NO. Writes and submission are phase 2.
package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/emersion/go-imap/v2/imapserver"

	"github.com/crumrine/agentic-inbox/gateway/internal/backend"
	"github.com/crumrine/agentic-inbox/gateway/internal/config"
	imapsession "github.com/crumrine/agentic-inbox/gateway/internal/imap"
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

	select {
	case err := <-errCh:
		if err != nil {
			return fmt.Errorf("imap listener: %w", err)
		}
		return nil
	case <-ctx.Done():
		logger.Info("shutdown signal received, closing listener")
		closeErr := server.Close()
		<-errCh // wait for Serve to return
		if closeErr != nil {
			return fmt.Errorf("closing imap server: %w", closeErr)
		}
		logger.Info("shutdown complete")
		return nil
	}
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
