// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"

	"github.com/crumrine/agentic-inbox-imap/gateway/internal/backend"
)

// recordingExpungeWriter captures untagged EXPUNGE sequence numbers in the
// order they were emitted. Order is the whole point: each one renumbers
// everything after it on the client side.
type recordingExpungeWriter struct {
	seqNums []uint32
	err     error
}

func (w *recordingExpungeWriter) WriteExpunge(seqNum uint32) error {
	w.seqNums = append(w.seqNums, seqNum)
	return w.err
}

// markDeleted sets \Deleted on the given UIDs through the real STORE path,
// so the tests exercise the same state a client would create.
func markDeleted(t *testing.T, s *Session, uids ...uint32) {
	t.Helper()
	set := imap.UIDSet{}
	for _, uid := range uids {
		set.AddNum(imap.UID(uid))
	}
	if err := s.Store(nil, set, &imap.StoreFlags{
		Op:     imap.StoreFlagsAdd,
		Silent: true,
		Flags:  []imap.Flag{imap.FlagDeleted},
	}, nil); err != nil {
		t.Fatalf("marking \\Deleted: %v", err)
	}
}

func snapshotUIDs(t *testing.T, s *Session) []uint32 {
	t.Helper()
	_, sel := s.snapshot()
	out := make([]uint32, 0, len(sel.msgs))
	for _, msg := range sel.msgs {
		out = append(out, msg.UID)
	}
	return out
}

// ---------------------------------------------------------------------
// EXPUNGE and renumbering
// ---------------------------------------------------------------------

// TestExpungeFromTheMiddleRenumbers is the core risk in this change.
// Removing message 2 of 3 makes the old 3 become 2, and a client that
// applied our untagged responses must agree with our snapshot afterwards.
func TestExpungeFromTheMiddleRenumbers(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	// Snapshot is uid 5, 9, 12 at sequence 1, 2, 3. Delete the middle one.
	markDeleted(t, s, 9)

	w := &recordingExpungeWriter{}
	if err := s.expunge(w, nil); err != nil {
		t.Fatalf("EXPUNGE: %v", err)
	}
	if !equalUint32s(w.seqNums, []uint32{2}) {
		t.Fatalf("untagged EXPUNGE = %v, want [2]", w.seqNums)
	}
	if got := snapshotUIDs(t, s); !equalUint32s(got, []uint32{5, 12}) {
		t.Fatalf("snapshot = %v, want [5 12]", got)
	}

	// The old sequence 3 is now sequence 2, which is what the client
	// believes after applying the EXPUNGE.
	_, sel := s.snapshot()
	var got []uint32
	if err := sel.forEach(imap.SeqSetNum(2), func(_ uint32, msg *backend.Message) error {
		got = append(got, msg.UID)
		return nil
	}); err != nil {
		t.Fatalf("forEach: %v", err)
	}
	if !equalUint32s(got, []uint32{12}) {
		t.Errorf("sequence 2 after the expunge resolves to %v, want [12]", got)
	}
}

// TestExpungeEmitsDescendingSequenceNumbers pins the ordering decision.
// Ascending would need each number reduced by the count of lower ones
// already reported; descending needs no arithmetic, so that is what this
// implementation does and this test is what stops it drifting.
func TestExpungeEmitsDescendingSequenceNumbers(t *testing.T) {
	be := newFakeBackend(t)
	seedFolder(t, be, "inbox", 6)
	s := newLoggedInSession(t, be)
	if _, err := s.Select("INBOX", nil); err != nil {
		t.Fatalf("Select: %v", err)
	}

	// UIDs 1..6 at sequence 1..6. Delete the 2nd, 4th and 5th.
	markDeleted(t, s, 2, 4, 5)

	w := &recordingExpungeWriter{}
	if err := s.expunge(w, nil); err != nil {
		t.Fatalf("EXPUNGE: %v", err)
	}
	if !equalUint32s(w.seqNums, []uint32{5, 4, 2}) {
		t.Fatalf("untagged EXPUNGE = %v, want [5 4 2] (descending)", w.seqNums)
	}

	// Replay them the way a client does and check we end up agreeing.
	client := []uint32{1, 2, 3, 4, 5, 6} // uids, indexed by sequence-1
	for _, seqNum := range w.seqNums {
		client = append(client[:seqNum-1], client[seqNum:]...)
	}
	if !equalUint32s(client, []uint32{1, 3, 6}) {
		t.Fatalf("a client replaying %v ends up with %v, want [1 3 6]", w.seqNums, client)
	}
	if got := snapshotUIDs(t, s); !equalUint32s(got, client) {
		t.Errorf("snapshot = %v but the client believes %v; they must agree", got, client)
	}
}

// TestExpungeAdjacentMessages is the case where an off-by-one in the
// ordering is easiest to hide: consecutive sequence numbers.
func TestExpungeAdjacentMessages(t *testing.T) {
	be := newFakeBackend(t)
	seedFolder(t, be, "inbox", 5)
	s := newLoggedInSession(t, be)
	if _, err := s.Select("INBOX", nil); err != nil {
		t.Fatalf("Select: %v", err)
	}
	markDeleted(t, s, 2, 3)

	w := &recordingExpungeWriter{}
	if err := s.expunge(w, nil); err != nil {
		t.Fatalf("EXPUNGE: %v", err)
	}
	if !equalUint32s(w.seqNums, []uint32{3, 2}) {
		t.Fatalf("untagged EXPUNGE = %v, want [3 2]", w.seqNums)
	}

	client := []uint32{1, 2, 3, 4, 5}
	for _, seqNum := range w.seqNums {
		client = append(client[:seqNum-1], client[seqNum:]...)
	}
	if !equalUint32s(client, []uint32{1, 4, 5}) {
		t.Fatalf("client ends with %v, want [1 4 5]", client)
	}
	if got := snapshotUIDs(t, s); !equalUint32s(got, client) {
		t.Errorf("snapshot = %v, client = %v", got, client)
	}
}

func TestExpungeWithNothingDeletedIsANoop(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	w := &recordingExpungeWriter{}
	if err := s.expunge(w, nil); err != nil {
		t.Fatalf("EXPUNGE: %v", err)
	}
	if len(w.seqNums) != 0 {
		t.Errorf("untagged EXPUNGE = %v, want none", w.seqNums)
	}
	if got := snapshotUIDs(t, s); !equalUint32s(got, []uint32{5, 9, 12}) {
		t.Errorf("snapshot = %v, want it unchanged", got)
	}
}

// TestUIDExpungeRestrictsToTheNamedSet: RFC 4315 says only messages that
// are both named and \Deleted are removed.
func TestUIDExpungeRestrictsToTheNamedSet(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	markDeleted(t, s, 5, 12)

	set := imap.UIDSetNum(12)
	w := &recordingExpungeWriter{}
	if err := s.expunge(w, &set); err != nil {
		t.Fatalf("UID EXPUNGE: %v", err)
	}
	if !equalUint32s(w.seqNums, []uint32{3}) {
		t.Errorf("untagged EXPUNGE = %v, want [3]", w.seqNums)
	}
	if got := snapshotUIDs(t, s); !equalUint32s(got, []uint32{5, 9}) {
		t.Errorf("snapshot = %v, want uid 5 kept despite being \\Deleted", got)
	}
	// The request must have named only the deleted-and-selected message.
	if uids, ok := be.lastExpungeRequest(); !ok || !equalUint32s(uids, []uint32{12}) {
		t.Errorf("expunge request = %v, want [12]", uids)
	}
}

// TestUIDExpungeIgnoresUndeletedMessages guards against destroying a
// message a client named but never marked. The filter is applied here as
// well as server-side, because a stray UID EXPUNGE must not be able to
// delete live mail even if the endpoint would oblige.
func TestUIDExpungeIgnoresUndeletedMessages(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	set := imap.UIDSetNum(5, 9, 12) // none are \Deleted
	w := &recordingExpungeWriter{}
	if err := s.expunge(w, &set); err != nil {
		t.Fatalf("UID EXPUNGE: %v", err)
	}
	if len(w.seqNums) != 0 {
		t.Errorf("untagged EXPUNGE = %v, want none", w.seqNums)
	}
	if _, called := be.lastExpungeRequest(); called {
		t.Error("the backend was called for a UID EXPUNGE with nothing deleted")
	}
	if got := snapshotUIDs(t, s); !equalUint32s(got, []uint32{5, 9, 12}) {
		t.Errorf("snapshot = %v, want it intact", got)
	}
}

// TestExpungeNilUIDsSendsTheUnrestrictedRequest: the two request shapes are
// different, and only the Worker can decide which messages carry \Deleted
// when the client did not name any.
func TestExpungeNilUIDsSendsTheUnrestrictedRequest(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)
	markDeleted(t, s, 9)

	if err := s.expunge(&recordingExpungeWriter{}, nil); err != nil {
		t.Fatalf("EXPUNGE: %v", err)
	}
	uids, called := be.lastExpungeRequest()
	if !called {
		t.Fatal("the backend was not called")
	}
	if uids != nil {
		t.Errorf("expunge request = %v, want nil so the Worker applies the \\Deleted rule", uids)
	}
}

// TestExpungeSkipsUIDsTheSnapshotNeverHeld: the Worker may report removing
// a message that arrived after our snapshot. There is no sequence number to
// withdraw, so it must not be reported.
func TestExpungeSkipsUIDsTheSnapshotNeverHeld(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)
	_, sel := s.snapshot()

	w := &recordingExpungeWriter{}
	// 99 is not in the snapshot; 9 is sequence 2.
	if err := s.reportExpunged(w, sel, []uint32{9, 99}); err != nil {
		t.Fatalf("reportExpunged: %v", err)
	}
	if !equalUint32s(w.seqNums, []uint32{2}) {
		t.Errorf("untagged EXPUNGE = %v, want only [2]", w.seqNums)
	}
	if got := snapshotUIDs(t, s); !equalUint32s(got, []uint32{5, 12}) {
		t.Errorf("snapshot = %v", got)
	}
}

func TestExpungeBackendFailureIsACleanIMAPError(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)
	markDeleted(t, s, 9)

	be.mu.Lock()
	be.expungeErr = &backend.APIError{Kind: backend.ErrKindServer, StatusCode: 503, Body: "upstream https://inbox.internal down"}
	be.mu.Unlock()

	w := &recordingExpungeWriter{}
	err := s.expunge(w, nil)
	if err == nil {
		t.Fatal("EXPUNGE succeeded against a failing backend")
	}
	var imapErr *imap.Error
	if !errors.As(err, &imapErr) {
		t.Fatalf("err = %#v, want *imap.Error", err)
	}
	if imapErr.Code != imap.ResponseCodeUnavailable {
		t.Errorf("err = %v, want NO [UNAVAILABLE]", imapErr)
	}
	if strings.Contains(err.Error(), "inbox.internal") {
		t.Errorf("error %q leaks the backend URL", err.Error())
	}
	if len(w.seqNums) != 0 {
		t.Errorf("untagged EXPUNGE = %v, want none after a failure", w.seqNums)
	}
	if got := snapshotUIDs(t, s); !equalUint32s(got, []uint32{5, 9, 12}) {
		t.Errorf("snapshot = %v, want it unchanged after a failure", got)
	}
}

func TestExpungeRefusedOnExaminedMailbox(t *testing.T) {
	be := newFakeBackend(t)
	s := newLoggedInSession(t, be)
	if _, err := s.Select("INBOX", &imap.SelectOptions{ReadOnly: true}); err != nil {
		t.Fatalf("EXAMINE: %v", err)
	}

	set := imap.UIDSetNum(5)
	if err := s.expunge(&recordingExpungeWriter{}, &set); err == nil {
		t.Error("UID EXPUNGE on an examined mailbox succeeded")
	}
	// CLOSE must still work on it.
	if err := s.expunge(&recordingExpungeWriter{}, nil); err != nil {
		t.Errorf("CLOSE path on an examined mailbox: %v, want nil", err)
	}
}

// ---------------------------------------------------------------------
// COPY
// ---------------------------------------------------------------------

func TestCopyLeavesTheSource(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	data, err := s.Copy(imap.UIDSetNum(5, 9), "Archive")
	if err != nil {
		t.Fatalf("COPY: %v", err)
	}
	if got := snapshotUIDs(t, s); !equalUint32s(got, []uint32{5, 9, 12}) {
		t.Errorf("snapshot = %v, want the source untouched by a copy", got)
	}
	if got := be.uidsIn("inbox"); !equalUint32s(got, []uint32{5, 9, 12}) {
		t.Errorf("source folder = %v, want it untouched", got)
	}
	if got := be.uidsIn("archive"); len(got) != 2 {
		t.Errorf("destination folder = %v, want two messages", got)
	}

	if data == nil {
		t.Fatal("COPY returned no COPYUID data")
	}
	if data.UIDValidity != 1712345679 {
		t.Errorf("COPYUID validity = %d, want the destination's", data.UIDValidity)
	}
	if got := data.SourceUIDs.String(); got != "5,9" {
		t.Errorf("COPYUID source set = %q, want 5,9", got)
	}
	if data.DestUIDs.String() == "" {
		t.Error("COPYUID destination set is empty")
	}

	transfer, _ := be.lastTransfer()
	if transfer.op != "copy" || transfer.destination != "archive" {
		t.Errorf("transfer = %+v, want a copy to the archive folder id", transfer)
	}
}

func TestCopyToMissingMailboxSaysTryCreate(t *testing.T) {
	s := newSelectedSession(t, newFakeBackend(t))
	_, err := s.Copy(imap.UIDSetNum(5), "NoSuchFolder")
	var imapErr *imap.Error
	if !errors.As(err, &imapErr) {
		t.Fatalf("err = %#v, want *imap.Error", err)
	}
	if imapErr.Code != imap.ResponseCodeTryCreate {
		t.Errorf("err = %v, want NO [TRYCREATE]", imapErr)
	}
}

func TestCopyBackendFailureIsACleanIMAPError(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)
	be.mu.Lock()
	be.copyErr = &backend.APIError{Kind: backend.ErrKindServer, StatusCode: 502}
	be.mu.Unlock()

	_, err := s.Copy(imap.UIDSetNum(5), "Archive")
	var imapErr *imap.Error
	if !errors.As(err, &imapErr) || imapErr.Type != imap.StatusResponseTypeNo {
		t.Fatalf("err = %#v, want a NO", err)
	}
}

func TestCopySkipsVanishedUID(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)
	be.removeMessage("inbox", 9)

	data, err := s.Copy(imap.UIDSetNum(5, 9, 12), "Archive")
	if err != nil {
		t.Fatalf("COPY: %v", err)
	}
	if got := data.SourceUIDs.String(); got != "5,12" {
		t.Errorf("COPYUID source set = %q, want only the messages that existed", got)
	}
}

// ---------------------------------------------------------------------
// MOVE
// ---------------------------------------------------------------------

// moveRecorder stands in for *imapserver.MoveWriter at the unit level.
type moveRecorder struct {
	copyData *imap.CopyData
	seqNums  []uint32
}

func (m *moveRecorder) WriteExpunge(seqNum uint32) error {
	m.seqNums = append(m.seqNums, seqNum)
	return nil
}

// moveViaSession exercises the same body Move uses, with a recorder in
// place of the writer imapserver would supply.
func moveViaSession(t *testing.T, s *Session, be *fakeBackend, numSet imap.NumSet, dest string) *moveRecorder {
	t.Helper()
	rec := &moveRecorder{}

	mailbox, sel, folder, uids, err := s.prepareTransfer(numSet, dest)
	if err != nil {
		t.Fatalf("prepareTransfer: %v", err)
	}
	moved, err := be.Move(t.Context(), mailbox, sel.folderKey, uids, folderKey(folder))
	if err != nil {
		t.Fatalf("Move: %v", err)
	}
	rec.copyData = copyData(folder, moved)

	gone := make([]uint32, 0, len(moved))
	for _, m := range moved {
		gone = append(gone, m.SourceUID)
	}
	if err := s.reportExpunged(rec, sel, gone); err != nil {
		t.Fatalf("reportExpunged: %v", err)
	}
	return rec
}

func TestMoveRemovesFromTheSource(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	rec := moveViaSession(t, s, be, imap.UIDSetNum(9), "Archive")

	if !equalUint32s(rec.seqNums, []uint32{2}) {
		t.Errorf("untagged EXPUNGE = %v, want [2]", rec.seqNums)
	}
	if got := snapshotUIDs(t, s); !equalUint32s(got, []uint32{5, 12}) {
		t.Errorf("snapshot = %v, want the moved message gone", got)
	}
	if got := be.uidsIn("inbox"); !equalUint32s(got, []uint32{5, 12}) {
		t.Errorf("source folder = %v", got)
	}
	if got := be.uidsIn("archive"); len(got) != 1 {
		t.Errorf("destination folder = %v, want one message", got)
	}
	if rec.copyData == nil || rec.copyData.SourceUIDs.String() != "9" {
		t.Errorf("COPYUID = %+v, want source 9", rec.copyData)
	}
}

func TestMoveOfSeveralEmitsDescendingExpunges(t *testing.T) {
	be := newFakeBackend(t)
	seedFolder(t, be, "inbox", 5)
	s := newLoggedInSession(t, be)
	if _, err := s.Select("INBOX", nil); err != nil {
		t.Fatalf("Select: %v", err)
	}

	rec := moveViaSession(t, s, be, imap.UIDSetNum(2, 4), "Archive")

	if !equalUint32s(rec.seqNums, []uint32{4, 2}) {
		t.Fatalf("untagged EXPUNGE = %v, want [4 2] descending", rec.seqNums)
	}
	if got := snapshotUIDs(t, s); !equalUint32s(got, []uint32{1, 3, 5}) {
		t.Errorf("snapshot = %v, want [1 3 5]", got)
	}
}

func TestMoveToMissingMailboxSaysTryCreate(t *testing.T) {
	s := newSelectedSession(t, newFakeBackend(t))
	err := s.Move(nil, imap.UIDSetNum(5), "NoSuchFolder")
	var imapErr *imap.Error
	if !errors.As(err, &imapErr) || imapErr.Code != imap.ResponseCodeTryCreate {
		t.Errorf("err = %#v, want NO [TRYCREATE]", err)
	}
}

func TestMoveBackendFailureLeavesTheSnapshotAlone(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)
	be.mu.Lock()
	be.moveErr = &backend.APIError{Kind: backend.ErrKindServer, StatusCode: 500}
	be.mu.Unlock()

	err := s.Move(nil, imap.UIDSetNum(9), "Archive")
	var imapErr *imap.Error
	if !errors.As(err, &imapErr) || imapErr.Type != imap.StatusResponseTypeNo {
		t.Fatalf("err = %#v, want a NO", err)
	}
	if got := snapshotUIDs(t, s); !equalUint32s(got, []uint32{5, 9, 12}) {
		t.Errorf("snapshot = %v, want it unchanged after a failed move", got)
	}
}

func TestMoveWithoutSelection(t *testing.T) {
	s := newLoggedInSession(t, newFakeBackend(t))
	if err := s.Move(nil, imap.UIDSetNum(5), "Archive"); err != errNoMailboxSelected {
		t.Errorf("err = %#v, want errNoMailboxSelected", err)
	}
}

// ---------------------------------------------------------------------
// Poll and Idle must still refuse to shrink
// ---------------------------------------------------------------------

// TestPollStillWillNotShrinkAfterServerSideDeletion is the other half of
// the shrink rule. A message removed elsewhere has had no EXPUNGE sent for
// it, so it must stay addressable rather than silently renumbering the
// mailbox under the client.
func TestPollStillWillNotShrinkAfterServerSideDeletion(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(0))

	be.removeMessage("inbox", 9) // vanished in the web UI, not by us

	if err := s.poll(t.Context(), &recordingUpdateWriter{}); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if got := snapshotUIDs(t, s); !equalUint32s(got, []uint32{5, 9, 12}) {
		t.Errorf("snapshot = %v; Poll must not shrink without an EXPUNGE response", got)
	}
}

// TestExpungeShrinksWherePollWillNot states the separation directly: the
// same disappearance, one discovered by Poll and one performed by us.
func TestExpungeShrinksWherePollWillNot(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(0))

	markDeleted(t, s, 9)
	if err := s.poll(t.Context(), &recordingUpdateWriter{}); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if got := snapshotUIDs(t, s); !equalUint32s(got, []uint32{5, 9, 12}) {
		t.Fatalf("marking \\Deleted must not itself shrink anything: %v", got)
	}

	if err := s.expunge(&recordingExpungeWriter{}, nil); err != nil {
		t.Fatalf("EXPUNGE: %v", err)
	}
	if got := snapshotUIDs(t, s); !equalUint32s(got, []uint32{5, 12}) {
		t.Errorf("snapshot = %v, want the expunged message gone", got)
	}
}

// ---------------------------------------------------------------------
// Protocol level
// ---------------------------------------------------------------------

func TestCapabilityAdvertisesMoveAndUIDPlus(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))

	lines := c.do("CAPABILITY")
	requireOK(t, lines)
	joined := strings.Join(lines, "\n")
	for _, want := range []string{"MOVE", "UIDPLUS"} {
		if !strings.Contains(joined, want) {
			t.Errorf("CAPABILITY = %q, missing %q", joined, want)
		}
	}
}

// TestIOSDeleteSequence replays swipe-to-delete: mark \Deleted, then
// expunge. Both must be answered OK and the connection must survive, or the
// reconnect loop we just fixed for STORE comes straight back.
func TestIOSDeleteSequence(t *testing.T) {
	be := newFakeBackend(t)
	c := startRawClient(t, be, WithPollInterval(0), WithIdleInterval(50*time.Millisecond))

	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))

	requireOK(t, c.do(`UID STORE 9 +FLAGS.SILENT (\Deleted)`))

	expunge := c.do("UID EXPUNGE 9")
	requireOK(t, expunge)
	if !strings.Contains(strings.Join(expunge, "\n"), "* 2 EXPUNGE") {
		t.Fatalf("UID EXPUNGE = %q, want an untagged * 2 EXPUNGE", expunge)
	}

	// The message is gone from the folder the client is looking at.
	if got := be.uidsIn("inbox"); !equalUint32s(got, []uint32{5, 12}) {
		t.Errorf("inbox = %v, want uid 9 removed", got)
	}

	// And the renumbering holds: what was sequence 3 is now sequence 2.
	fetch := c.do("FETCH 2 (UID)")
	requireOK(t, fetch)
	if !strings.Contains(strings.Join(fetch, "\n"), "UID 12") {
		t.Errorf("FETCH 2 after the expunge = %q, want UID 12", fetch)
	}

	requireOK(t, c.do("NOOP"))
}

// TestMoveOverTheWire covers the response order RFC 6851 fixes: COPYUID
// first, then the untagged EXPUNGE, then the tagged completion.
func TestMoveOverTheWire(t *testing.T) {
	be := newFakeBackend(t)
	c := startRawClient(t, be, WithPollInterval(0))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))

	lines := c.do("UID MOVE 9 Archive")
	requireOK(t, lines)

	joined := strings.Join(lines, "\n")
	copyIdx := strings.Index(joined, "COPYUID")
	expungeIdx := strings.Index(joined, "EXPUNGE")
	if copyIdx < 0 {
		t.Fatalf("MOVE = %q, want a COPYUID", lines)
	}
	if expungeIdx < 0 {
		t.Fatalf("MOVE = %q, want an untagged EXPUNGE", lines)
	}
	if copyIdx > expungeIdx {
		t.Errorf("MOVE = %q, want COPYUID before the EXPUNGE", lines)
	}
	if !strings.Contains(joined, "* 2 EXPUNGE") {
		t.Errorf("MOVE = %q, want * 2 EXPUNGE", lines)
	}

	if got := be.uidsIn("inbox"); !equalUint32s(got, []uint32{5, 12}) {
		t.Errorf("inbox = %v, want the moved message gone", got)
	}
	if got := be.uidsIn("archive"); len(got) != 1 {
		t.Errorf("archive = %v, want the moved message", got)
	}
	requireOK(t, c.do("NOOP"))
}

func TestCopyOverTheWireEmitsCopyUID(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))

	lines := c.do("UID COPY 5 Archive")
	requireOK(t, lines)
	if !strings.Contains(lastLine(lines), "COPYUID 1712345679 5 1") {
		t.Errorf("UID COPY = %q, want COPYUID with the destination validity and uid", lastLine(lines))
	}
}

func TestCloseExpungesWithoutUntaggedResponses(t *testing.T) {
	be := newFakeBackend(t)
	c := startRawClient(t, be, WithPollInterval(0))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))
	requireOK(t, c.do(`UID STORE 9 +FLAGS.SILENT (\Deleted)`))

	lines := c.do("CLOSE")
	requireOK(t, lines)
	// RFC 9051 section 6.4.2: CLOSE expunges but sends no EXPUNGE responses.
	if strings.Contains(strings.Join(lines, "\n"), "EXPUNGE") {
		t.Errorf("CLOSE = %q, want no untagged EXPUNGE responses", lines)
	}
	if got := be.uidsIn("inbox"); !equalUint32s(got, []uint32{5, 12}) {
		t.Errorf("inbox = %v, want CLOSE to have expunged uid 9", got)
	}
}
