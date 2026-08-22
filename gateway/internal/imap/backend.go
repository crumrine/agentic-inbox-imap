// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"context"

	"github.com/crumrine/agentic-inbox/gateway/internal/backend"
)

// Backend is the subset of the Worker API the IMAP session depends on. It
// exists so the session can be unit-tested against a fake without standing
// up an HTTP server, and so a future transport (WebSocket, gRPC, whatever)
// can be swapped in without touching session logic.
//
// *backend.Client satisfies it; see the assertion below.
type Backend interface {
	// Authenticate verifies an app password for a mailbox.
	Authenticate(ctx context.Context, mailbox, password string) (*backend.AuthResult, error)
	// Folders lists every folder in a mailbox with its IMAP counters.
	Folders(ctx context.Context, mailbox string) ([]backend.Folder, error)
	// Messages lists message metadata for a folder. The metadata payload
	// deliberately does not include BODYSTRUCTURE or raw bytes.
	Messages(ctx context.Context, mailbox, folder string, opts backend.MessagesOptions) (*backend.MessagesPage, error)
	// RawMessage streams the original RFC822 bytes of one message.
	RawMessage(ctx context.Context, mailbox, folder string, uid uint32) (*backend.RawMessageReader, error)
}

// Compile-time proof that the real client satisfies the interface, so a
// signature change in internal/backend breaks the build here rather than at
// the call site in cmd/agentic-imapd.
var _ Backend = (*backend.Client)(nil)
