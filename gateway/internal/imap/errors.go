// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"errors"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"

	"github.com/crumrine/agentic-inbox-imap/gateway/internal/backend"
)

// errMessageTooLarge is returned by the message store when a raw message
// exceeds the per-message buffer cap. It is an internal sentinel; clients
// see a NO [LIMIT] response, never this text.
var errMessageTooLarge = errors.New("imap: raw message exceeds the gateway's per-message size limit")

// errFolderTooLarge is returned when a folder holds more messages than one
// selection may hold. It is an internal sentinel; clients see NO [LIMIT].
var errFolderTooLarge = errors.New("imap: folder holds more messages than the gateway can serve in one selection")

// mapBackendError converts an error from the Backend into an *imap.Error
// suitable for returning to a mail client.
//
// It never embeds the underlying error. Backend errors can carry response
// body excerpts and, in the transport case, URLs; none of that belongs on
// the wire to a mail client, and go-imap only logs errors it cannot
// recognise as an *imap.Error, so returning a sanitised *imap.Error also
// keeps backend detail out of the server log.
//
// notFoundText is the client-visible text used for a 404 from the Worker.
// It must be a constant string, never interpolated with anything derived
// from credentials.
func mapBackendError(err error, notFoundText string) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, backend.ErrAuthFailed):
		return imapserver.ErrAuthFailed
	case errors.Is(err, backend.ErrNotFound):
		return &imap.Error{
			Type: imap.StatusResponseTypeNo,
			Code: imap.ResponseCodeNonExistent,
			Text: notFoundText,
		}
	case errors.Is(err, errMessageTooLarge):
		return &imap.Error{
			Type: imap.StatusResponseTypeNo,
			Code: imap.ResponseCodeLimit,
			Text: "Message is too large to serve over IMAP",
		}
	case errors.Is(err, errFolderTooLarge):
		return &imap.Error{
			Type: imap.StatusResponseTypeNo,
			Code: imap.ResponseCodeLimit,
			Text: "Folder holds too many messages to serve over IMAP",
		}
	default:
		// backend.ErrServer, transport failures, context deadlines and
		// JSON decode failures all land here.
		return &imap.Error{
			Type: imap.StatusResponseTypeNo,
			Code: imap.ResponseCodeUnavailable,
			Text: "Backend temporarily unavailable, try again",
		}
	}
}

// errNotYetSupported builds the response for a mutating command the
// gateway does not implement yet.
//
// Flag writes are served (see Store); moving, copying, appending and
// expunging messages are phase 2. The distinction matters to a client:
// PERMANENTFLAGS advertises what STORE will accept, and everything below
// is what remains genuinely absent.
func errNotYetSupported(command string) error {
	return &imap.Error{
		Type: imap.StatusResponseTypeNo,
		Code: imap.ResponseCodeCannot,
		Text: command + " is not supported by this gateway yet",
	}
}

// errUnsupported builds the response returned for a command or argument the
// gateway understands but deliberately refuses to guess at. Answering a
// SEARCH we cannot evaluate would be worse than answering NO.
func errUnsupported(what string) error {
	return &imap.Error{
		Type: imap.StatusResponseTypeNo,
		Code: imap.ResponseCodeCannot,
		Text: what + " is not supported by this gateway",
	}
}

// errNoMailboxSelected is returned when a selected-state operation runs
// without a live selection. go-imap checks connection state before
// dispatching, so this is a defence against a state bug rather than an
// expected path — but it must be an error, never a nil-map panic.
var errNoMailboxSelected = &imap.Error{
	Type: imap.StatusResponseTypeBad,
	Code: imap.ResponseCodeClientBug,
	Text: "No mailbox selected",
}

// errNotAuthenticated is returned when an authenticated-state operation
// runs before a successful LOGIN.
var errNotAuthenticated = &imap.Error{
	Type: imap.StatusResponseTypeBad,
	Code: imap.ResponseCodeClientBug,
	Text: "Not authenticated",
}

// errClientBug reports a command the client should not have sent. go-imap
// keeps its own equivalent unexported.
func errClientBug(text string) error {
	return &imap.Error{
		Type: imap.StatusResponseTypeBad,
		Code: imap.ResponseCodeClientBug,
		Text: text,
	}
}
