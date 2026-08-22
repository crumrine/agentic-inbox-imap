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

	backendClient, err := backend.New(cfg.InboxURL.String(), cfg.AccessClientID, cfg.AccessClientSecret)
	if err != nil {
		return fmt.Errorf("building backend client: %w", err)
	}
	defer backendClient.Close()

	cert, err := tls.LoadX509KeyPair(cfg.TLSCertFile, cfg.TLSKeyFile)
	if err != nil {
		return fmt.Errorf("loading TLS certificate: %w", err)
	}

	server := imapserver.New(&imapserver.Options{
		NewSession: func(conn *imapserver.Conn) (imapserver.Session, *imapserver.GreetingData, error) {
			return imapsession.NewSession(backendClient, imapsession.WithLogger(logger)), nil, nil
		},
		TLSConfig: &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		},
		Logger: printfLogger{logger},
	})

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		errCh <- server.ListenAndServeTLS(cfg.IMAPAddr)
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
		<-errCh // wait for ListenAndServeTLS to return
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
