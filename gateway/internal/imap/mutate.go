// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"context"
	"math"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"

	"github.com/crumrine/agentic-inbox/gateway/internal/backend"
)

// Session implements MOVE, so go-imap may advertise the capability. A
// client that sees MOVE prefers it over COPY + STORE \Deleted + EXPUNGE,
// which is three commands and three chances to half-fail.
var _ imapserver.SessionMove = (*Session)(nil)

// expungeWriter is the subset of *imapserver.ExpungeWriter used here.
// Extracting it lets Expunge be tested without a live connection.
type expungeWriter interface {
	WriteExpunge(seqNum uint32) error
}

// Expunge implements EXPUNGE, UID EXPUNGE and the expunge half of CLOSE.
//
// go-imap routes all three here and distinguishes them only by the uids
// argument and by whether the writer is connected:
//
//   - EXPUNGE      uids == nil, writer connected
//   - UID EXPUNGE  uids != nil, writer connected
//   - CLOSE        uids == nil, writer with no connection
//
// The CLOSE case needs no special handling. Its ExpungeWriter drops every
// write, which is exactly right: RFC 9051 section 6.4.2 says CLOSE expunges
// without sending untagged EXPUNGE responses.
//
// # Sequence numbers
//
// This is the only operation that shrinks a selection, and expunging
// renumbers: removing message 2 of 4 makes the old 3 and 4 become 2 and 3.
// The untagged responses are emitted in DESCENDING sequence order, so that
// each removal only renumbers messages the client has already been told
// about. Emitting ascending would require subtracting the number of
// already-reported removals from every subsequent sequence number, and
// getting that arithmetic wrong points clients at the wrong message.
func (s *Session) Expunge(w *imapserver.ExpungeWriter, uids *imap.UIDSet) error {
	var ew expungeWriter
	if w != nil {
		ew = w
	}
	return s.expunge(ew, uids)
}

func (s *Session) expunge(w expungeWriter, uids *imap.UIDSet) error {
	mailbox, sel := s.snapshot()
	if sel == nil {
		return errNoMailboxSelected
	}
	if sel.readOnly {
		if uids == nil {
			// CLOSE on an examined mailbox: unselect quietly, expunge
			// nothing. Failing here would break CLOSE, which is legal on a
			// read-only mailbox.
			return nil
		}
		return &imap.Error{
			Type: imap.StatusResponseTypeNo,
			Code: imap.ResponseCodeCannot,
			Text: "Mailbox is open read-only, reselect it with SELECT to expunge",
		}
	}

	// A nil set means "every message carrying \Deleted", which only the
	// Worker can decide. A non-nil set is UID EXPUNGE, where RFC 4315
	// restricts the operation to messages that are both named and
	// \Deleted; the \Deleted half is filtered here against the snapshot so
	// that a client naming an undeleted message cannot destroy it even if
	// the endpoint would have obliged.
	var request []uint32
	if uids != nil {
		static, ok := sel.staticNumSet(*uids).(imap.UIDSet)
		if !ok {
			return errClientBug("UID EXPUNGE requires a UID set")
		}
		for _, msg := range sel.msgs {
			if !static.Contains(imap.UID(msg.UID)) {
				continue
			}
			if !newFlagSet(msg.Flags).has(imap.FlagDeleted) {
				continue
			}
			request = append(request, msg.UID)
		}
		if len(request) == 0 {
			return nil
		}
	}

	ctx, cancel := s.context()
	defer cancel()

	expunged, err := s.backend.Expunge(ctx, mailbox, sel.folderKey, request)
	if err != nil {
		return mapBackendError(err, "Mailbox does not exist")
	}
	return s.reportExpunged(w, sel, expunged)
}

// reportExpunged tells the client which messages went, then shrinks the
// snapshot to match. UIDs the snapshot never held are ignored: the client
// was never told they existed, so there is no sequence number to withdraw.
func (s *Session) reportExpunged(w expungeWriter, sel *selection, expunged []uint32) error {
	if len(expunged) == 0 {
		return nil
	}

	seqNums := sel.seqNumsFor(expunged) // descending
	if w != nil {
		for _, seqNum := range seqNums {
			if err := w.WriteExpunge(seqNum); err != nil {
				return err
			}
		}
	}
	s.applyExpunged(expunged)
	return nil
}

// applyExpunged removes messages from whatever selection is current.
//
// This is the deliberate exception to the append-only rule that Poll and
// Idle follow. Those two refuse to shrink because a message deleted
// elsewhere must not vanish under a client that was never sent an EXPUNGE;
// it stays in the snapshot and simply fails to fetch. Here the client has
// just been sent those EXPUNGE responses, so its view and the snapshot
// shrink together, which is the only condition under which shrinking is
// safe.
func (s *Session) applyExpunged(uids []uint32) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sel == nil {
		return
	}
	s.sel = s.sel.withoutUIDs(uids)
}

// Copy implements COPY and UID COPY.
func (s *Session) Copy(numSet imap.NumSet, dest string) (*imap.CopyData, error) {
	mailbox, sel, folder, uids, err := s.prepareTransfer(numSet, dest)
	if err != nil {
		return nil, err
	}
	if len(uids) == 0 {
		return nil, nil
	}

	ctx, cancel := s.context()
	defer cancel()

	copied, err := s.backend.Copy(ctx, mailbox, sel.folderKey, uids, folderKey(folder))
	if err != nil {
		return nil, mapBackendError(err, "Destination mailbox does not exist")
	}
	// The source folder is untouched by a copy, so the snapshot stands.
	return copyData(folder, copied), nil
}

// Move implements MOVE and UID MOVE (RFC 6851).
//
// The response order is fixed by the RFC: the COPYUID first, then an
// untagged EXPUNGE per message, then the tagged completion go-imap writes.
func (s *Session) Move(w *imapserver.MoveWriter, numSet imap.NumSet, dest string) error {
	mailbox, sel, folder, uids, err := s.prepareTransfer(numSet, dest)
	if err != nil {
		return err
	}
	if len(uids) == 0 {
		return nil
	}

	ctx, cancel := s.context()
	defer cancel()

	moved, err := s.backend.Move(ctx, mailbox, sel.folderKey, uids, folderKey(folder))
	if err != nil {
		return mapBackendError(err, "Destination mailbox does not exist")
	}
	if len(moved) == 0 {
		return nil
	}

	if w != nil {
		if err := w.WriteCopyData(copyData(folder, moved)); err != nil {
			return err
		}
	}

	// A moved message is gone from the source folder, so it expunges from
	// this selection exactly as EXPUNGE would, descending order and all.
	gone := make([]uint32, 0, len(moved))
	for _, m := range moved {
		gone = append(gone, m.SourceUID)
	}

	var ew expungeWriter
	if w != nil {
		ew = moveExpungeWriter{w}
	}
	return s.reportExpunged(ew, sel, gone)
}

// moveExpungeWriter adapts MoveWriter to the shared expunge reporting path,
// so MOVE and EXPUNGE cannot drift in how they renumber.
type moveExpungeWriter struct{ w *imapserver.MoveWriter }

func (m moveExpungeWriter) WriteExpunge(seqNum uint32) error {
	return m.w.WriteExpunge(seqNum)
}

// prepareTransfer resolves the destination mailbox and the source UIDs
// shared by COPY and MOVE.
func (s *Session) prepareTransfer(numSet imap.NumSet, dest string) (mailbox string, sel *selection, folder *backend.Folder, uids []uint32, err error) {
	mailbox, sel = s.snapshot()
	if sel == nil {
		return "", nil, nil, nil, errNoMailboxSelected
	}
	if imap.IsSearchRes(numSet) {
		return "", nil, nil, nil, errUnsupported("the SEARCHRES '$' marker")
	}

	ctx, cancel := s.context()
	defer cancel()

	folder, err = s.lookupFolder(ctx, mailbox, dest)
	if err != nil {
		// RFC 9051 section 6.4.7: a client may create the mailbox and retry
		// when the destination does not exist, and TRYCREATE is how it is
		// told that is worth doing.
		var imapErr *imap.Error
		if ok := asIMAPError(err, &imapErr); ok && imapErr.Code == imap.ResponseCodeNonExistent {
			return "", nil, nil, nil, &imap.Error{
				Type: imap.StatusResponseTypeNo,
				Code: imap.ResponseCodeTryCreate,
				Text: "Destination mailbox does not exist",
			}
		}
		return "", nil, nil, nil, err
	}

	_ = sel.forEach(numSet, func(_ uint32, msg *backend.Message) error {
		uids = append(uids, msg.UID)
		return nil
	})
	return mailbox, sel, folder, uids, nil
}

// copyData builds the COPYUID response code. Both halves are real: the
// source and destination UIDs come from the endpoint's pairs, and the
// destination UIDVALIDITY from the folder record that resolving the
// destination already fetched. Nothing here is guessed.
func copyData(dest *backend.Folder, pairs []backend.CopiedMessage) *imap.CopyData {
	if len(pairs) == 0 {
		return nil
	}
	data := &imap.CopyData{UIDValidity: dest.UIDValidity}
	for _, p := range pairs {
		data.SourceUIDs.AddNum(imap.UID(p.SourceUID))
		data.DestUIDs.AddNum(imap.UID(p.DestUID))
	}
	return data
}

func asIMAPError(err error, target **imap.Error) bool {
	e, ok := err.(*imap.Error)
	if ok {
		*target = e
	}
	return ok
}

// Session advertises an APPEND size limit, which makes go-imap emit
// APPENDLIMIT in CAPABILITY and, more usefully, refuse an oversize literal
// with NO [TOOBIG] before a single byte of it is accepted.
var _ imapserver.SessionAppendLimit = (*Session)(nil)

// AppendLimit is the largest message APPEND will take, in bytes.
func (s *Session) AppendLimit() uint32 {
	limit := s.maxAppendBytes
	if limit <= 0 {
		limit = DefaultMaxAppendBytes
	}
	if limit > math.MaxUint32 {
		limit = math.MaxUint32
	}
	return uint32(limit)
}

// Append implements APPEND, streaming the client's literal straight through
// to the Worker.
//
// # The literal
//
// go-imap has already written the "+ Ready for literal data" continuation
// by the time this is called, so the client is committed to sending the
// body whatever happens here. It does not need draining on the error paths:
// imapserver.handleAppend runs io.Copy(io.Discard, lit) unconditionally the
// moment this returns, error or not, which is what keeps the connection in
// sync. Draining here as well would only read the same bytes twice.
//
// The body is handed to the backend as a reader and never buffered. An
// APPEND is the one request whose size the client chooses, so buffering it
// is the single place a client could make this process allocate
// arbitrarily. AppendLimit caps it besides, before the upload starts.
func (s *Session) Append(mailbox string, r imap.LiteralReader, options *imap.AppendOptions) (*imap.AppendData, error) {
	name, sel := s.snapshot()
	if name == "" {
		return nil, errNotAuthenticated
	}
	if r == nil {
		return nil, errClientBug("APPEND requires a message literal")
	}

	// Resolving the destination is a small JSON call, so it keeps the
	// session's ordinary bound.
	lookupCtx, cancelLookup := s.context()
	folder, err := s.lookupFolder(lookupCtx, name, mailbox)
	cancelLookup()
	if err != nil {
		var imapErr *imap.Error
		if ok := asIMAPError(err, &imapErr); ok && imapErr.Code == imap.ResponseCodeNonExistent {
			// RFC 9051 section 6.3.12: TRYCREATE tells the client that
			// creating the mailbox and retrying is worth doing.
			return nil, &imap.Error{
				Type: imap.StatusResponseTypeNo,
				Code: imap.ResponseCodeTryCreate,
				Text: "Destination mailbox does not exist",
			}
		}
		return nil, err
	}

	var opts backend.AppendOptions
	if options != nil {
		opts.Flags = appendFlagStrings(options.Flags)
		opts.Time = options.Time
	}

	// No session-level deadline on the upload itself. The transfer is
	// bounded by the backend client's own upload timeout, which is sized
	// for a body rather than for a round trip; wrapping it in the
	// session's operation timeout would reimpose exactly the bound that is
	// wrong here.
	result, err := s.backend.Append(context.Background(), name, folderKey(folder), r, r.Size(), opts)
	if err != nil {
		return nil, mapBackendError(err, "Destination mailbox does not exist")
	}

	// Visibility in the selected folder is left to the ordinary refresh
	// rather than grown here directly. Two reasons: the append response
	// carries only a UID, so synthesising a snapshot entry would mean
	// inventing an envelope, size and internal date that the metadata
	// endpoint may later contradict; and refresh already holds every
	// append-only invariant, which a second growth path would have to
	// duplicate and could drift from.
	//
	// It is not deferred in practice. imapserver.handleAppend calls Poll
	// immediately after this returns and before the tagged completion, so
	// clearing the interval floor makes that poll do real work and the
	// EXISTS arrives within the same command.
	if sel != nil && sel.folderKey == folderKey(folder) {
		s.invalidatePollFloor()
	}

	return &imap.AppendData{
		UID:         imap.UID(result.UID),
		UIDValidity: result.UIDValidity,
	}, nil
}

// appendFlagStrings canonicalises the flags an APPEND may set.
//
// Unlike STORE this keeps \Draft: a STORE cannot change what kind of
// message something is, because draft-ness follows the folder, but an
// APPEND is creating the message and the client is describing what it is
// creating. \Recent is still dropped, being unsettable by definition.
func appendFlagStrings(flags []imap.Flag) []string {
	out := make([]string, 0, len(flags))
	seen := make(map[imap.Flag]struct{}, len(flags))
	for _, raw := range flags {
		f := normalizeFlag(string(raw))
		if f == "" || canonicalFlag(f) == canonicalFlag(flagRecent) {
			continue
		}
		key := canonicalFlag(f)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, string(f))
	}
	return out
}
