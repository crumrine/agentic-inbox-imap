// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"context"

	"github.com/emersion/go-imap/v2"

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
	// SetFlags applies a batch of per-message flag changes and returns each
	// message's complete resulting flag set. UIDs the Worker does not know
	// are omitted from the result rather than reported as an error.
	SetFlags(ctx context.Context, mailbox, folder string, updates []backend.FlagUpdate) ([]backend.FlagResult, error)
	// Copy copies messages into another folder, leaving the source alone,
	// and returns a source-UID to destination-UID pair per message.
	Copy(ctx context.Context, mailbox, folder string, uids []uint32, destination string) ([]backend.CopiedMessage, error)
	// Move moves messages into another folder. The source UIDs cease to
	// exist in the source folder.
	Move(ctx context.Context, mailbox, folder string, uids []uint32, destination string) ([]backend.CopiedMessage, error)
	// Expunge removes messages from a folder and returns the source UIDs
	// actually removed. A nil uids slice means every message carrying
	// \Deleted; a non-nil one restricts the operation to those UIDs.
	Expunge(ctx context.Context, mailbox, folder string, uids []uint32) ([]uint32, error)
}

// Compile-time proof that the real client satisfies the interface, so a
// signature change in internal/backend breaks the build here rather than at
// the call site in cmd/agentic-imapd.
var _ Backend = (*backend.Client)(nil)

// ServerCaps is the capability set agentic-imapd advertises. It lives here
// so the daemon and the tests cannot drift apart on it.
//
// go-imap only emits a capability that appears in its own allow-list, and
// it panics at connection setup if MOVE is advertised without the session
// implementing imapserver.SessionMove, so this set and the Session's method
// set have to be changed together.
//
//   - IMAP4rev1 is the baseline and must be present.
//   - MOVE (RFC 6851) is worth advertising because a client that sees it
//     uses one command where it would otherwise send COPY, STORE \Deleted
//     and EXPUNGE, each of which can fail separately.
//   - UIDPLUS (RFC 4315) is what makes UID EXPUNGE available and COPYUID
//     meaningful. Both are genuinely supported: the copy and move endpoints
//     return real source-to-destination UID pairs, and the destination's
//     UIDVALIDITY comes from the folder record resolving the destination
//     already fetched. Nothing in the response code is invented.
//
// APPENDUID, UIDPLUS's third part, does not arise: APPEND is not served.
func ServerCaps() imap.CapSet {
	return imap.CapSet{
		imap.CapIMAP4rev1: {},
		imap.CapMove:      {},
		imap.CapUIDPlus:   {},
	}
}
