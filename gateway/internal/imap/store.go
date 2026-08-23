// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"sort"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"

	"github.com/crumrine/agentic-inbox-imap/gateway/internal/backend"
)

// storeTarget is one message selected by a STORE, paired with the sequence
// number the client must see in any untagged FETCH.
type storeTarget struct {
	seqNum uint32
	msg    *backend.Message
}

// Store implements STORE and UID STORE for flag changes.
//
// This is not an optional nicety. iOS Mail marks a message \Seen the moment
// it displays it; when that STORE was refused, the client treated the NO as
// a fatal server error, dropped the connection, reconnected and repeated
// the same sequence indefinitely, never rendering the message. A refused
// flag write is a hard failure, not a degraded experience.
func (s *Session) Store(w *imapserver.FetchWriter, numSet imap.NumSet, flags *imap.StoreFlags, options *imap.StoreOptions) error {
	mailbox, sel := s.snapshot()
	if sel == nil {
		return errNoMailboxSelected
	}
	if flags == nil {
		return errClientBug("STORE requires a flag list")
	}
	if sel.readOnly {
		// The client opened this mailbox with EXAMINE. PERMANENTFLAGS said
		// nothing was settable, so this is a client bug, but answer it
		// plainly rather than pretending the write happened.
		return &imap.Error{
			Type: imap.StatusResponseTypeNo,
			Code: imap.ResponseCodeCannot,
			Text: "Mailbox is open read-only, reselect it with SELECT to change flags",
		}
	}
	if options != nil && options.UnchangedSince != 0 {
		return errUnsupported("STORE UNCHANGEDSINCE (CONDSTORE)")
	}
	if imap.IsSearchRes(numSet) {
		return errUnsupported("the SEARCHRES '$' marker")
	}

	var targets []storeTarget
	_ = sel.forEach(numSet, func(seqNum uint32, msg *backend.Message) error {
		targets = append(targets, storeTarget{seqNum: seqNum, msg: msg})
		return nil
	})
	if len(targets) == 0 {
		return nil
	}

	updates := make([]backend.FlagUpdate, 0, len(targets))
	effective := false
	for _, t := range targets {
		add, remove := storeDelta(flags, t.msg.Flags)
		if len(add) > 0 || len(remove) > 0 {
			effective = true
		}
		updates = append(updates, backend.FlagUpdate{UID: t.msg.UID, Add: add, Remove: remove})
	}

	// results carries each message's complete resulting flag set, which is
	// what the untagged FETCH must report.
	var results []backend.FlagResult
	if effective {
		ctx, cancel := s.context()
		defer cancel()

		var err error
		results, err = s.backend.SetFlags(ctx, mailbox, sel.folderKey, updates)
		if err != nil {
			return mapBackendError(err, "Mailbox does not exist")
		}
		s.applyFlagResults(results)
	} else {
		// Nothing storable was named, e.g. STORE +FLAGS (\Draft). Skip the
		// round trip and answer from the snapshot: the client still gets an
		// accurate flag list, which is all the command promised.
		results = make([]backend.FlagResult, 0, len(targets))
		for _, t := range targets {
			results = append(results, backend.FlagResult{UID: t.msg.UID, Flags: t.msg.Flags})
		}
	}

	// .SILENT means the client does not want the echo. iOS uses it, so
	// emitting anyway would silently double the response traffic on the
	// hottest command in a sync.
	if flags.Silent || w == nil {
		return nil
	}

	byUID := make(map[uint32][]string, len(results))
	for _, r := range results {
		byUID[r.UID] = r.Flags
	}

	// RFC 9051 section 6.4.8: the untagged FETCH for a UID STORE should
	// carry the UID, since that is how the client asked for the message.
	_, wantUID := numSet.(imap.UIDSet)

	for _, t := range targets {
		updated, ok := byUID[t.msg.UID]
		if !ok {
			// The Worker omits UIDs it does not know, which is how a
			// message deleted underneath the snapshot reports itself. Leave
			// it out of the response rather than failing the range.
			s.logVanished(mailbox, sel.folderKey, t.msg.UID)
			continue
		}

		// CreateMessage takes the connection's write lock; Close releases
		// it. Every path below must reach Close or the connection wedges.
		rw := w.CreateMessage(t.seqNum)
		if wantUID {
			rw.WriteUID(imap.UID(t.msg.UID))
		}
		rw.WriteFlags(imapFlags(updated))
		if err := rw.Close(); err != nil {
			return err
		}
	}
	return nil
}

// applyFlagResults folds the authoritative flag sets back into the
// snapshot, so a FETCH FLAGS later in the same session agrees with the
// STORE that preceded it.
//
// It matches on UID against whatever selection is current rather than the
// one Store started from: Poll or Idle may have grown the snapshot while
// the flag write was in flight, and dropping the update because the
// pointer moved would leave the session reporting stale flags.
func (s *Session) applyFlagResults(results []backend.FlagResult) {
	if len(results) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sel == nil {
		return
	}
	s.sel = s.sel.withFlags(results)
}

// storeDelta turns one STORE operation into the add/remove pair the
// Worker's flags endpoint takes. current is the snapshot's cached flag list
// for the message, used only to work out what a replace has to clear.
func storeDelta(store *imap.StoreFlags, current []string) (add, remove []string) {
	named := make([]imap.Flag, 0, len(store.Flags))
	seen := make(map[imap.Flag]struct{}, len(store.Flags))
	for _, raw := range store.Flags {
		f := normalizeFlag(string(raw))
		if !storable(f) {
			continue // \Draft and \Recent are ignored, not rejected
		}
		key := canonicalFlag(f)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		named = append(named, f)
	}

	switch store.Op {
	case imap.StoreFlagsAdd:
		return flagStrings(named), []string{}
	case imap.StoreFlagsDel:
		return []string{}, flagStrings(named)
	}

	// Replace. Clear every storable flag that is not in the target set: the
	// system flags unconditionally, plus any keyword the snapshot believes
	// is set. Naming a flag that is not actually set is a no-op on the
	// Worker, and doing it unconditionally is what keeps replace correct
	// when the cached flags have drifted.
	drop := make(map[imap.Flag]imap.Flag, len(storableSystemFlags)+len(current))
	for _, f := range storableSystemFlags {
		drop[canonicalFlag(f)] = f
	}
	for _, raw := range current {
		f := normalizeFlag(raw)
		if storable(f) {
			drop[canonicalFlag(f)] = f
		}
	}
	for _, f := range named {
		delete(drop, canonicalFlag(f))
	}

	remove = make([]string, 0, len(drop))
	for _, f := range drop {
		remove = append(remove, string(f))
	}
	// Deterministic order: the wire payload is easier to read in a trace
	// and to assert on in a test.
	sort.Strings(remove)

	return flagStrings(named), remove
}

func flagStrings(flags []imap.Flag) []string {
	out := make([]string, 0, len(flags))
	for _, f := range flags {
		out = append(out, string(f))
	}
	return out
}
