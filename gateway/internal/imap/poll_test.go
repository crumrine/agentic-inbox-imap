// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"

	"github.com/crumrine/agentic-inbox/gateway/internal/backend"
)

// recordingUpdateWriter stands in for *imapserver.UpdateWriter, which the
// library will not let anything outside itself construct.
type recordingUpdateWriter struct {
	exists []uint32
	err    error
}

func (w *recordingUpdateWriter) WriteNumMessages(n uint32) error {
	w.exists = append(w.exists, n)
	return w.err
}

// newMessage builds a metadata record for a message the fake will deliver.
// The UID is assigned by the fake, mirroring the Worker.
func newMessage(subject, from string, when time.Time, flags ...string) backend.Message {
	return backend.Message{
		Flags:        flags,
		InternalDate: when,
		Envelope: backend.Envelope{
			Subject:   subject,
			From:      []backend.Address{{Address: from}},
			To:        []backend.Address{{Address: testMailbox}},
			MessageID: "<" + subject + "@example.com>",
			Date:      when.Format(time.RFC1123Z),
		},
		HasRaw: true,
	}
}

func seqToUID(sel *selection) map[uint32]uint32 {
	out := make(map[uint32]uint32, len(sel.msgs))
	for i, msg := range sel.msgs {
		out[uint32(i+1)] = msg.UID
	}
	return out
}

// TestPollWithNoChangeMakesNoMetadataCall pins the cheap path. Poll runs
// after every authenticated command, so the common case must cost one
// folders call and nothing else.
func TestPollWithNoChangeMakesNoMetadataCall(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(0))

	_, foldersAfterSelect, messagesAfterSelect, _ := be.counters()

	for i := 0; i < 3; i++ {
		if err := s.poll(&recordingUpdateWriter{}); err != nil {
			t.Fatalf("poll: %v", err)
		}
	}

	_, folders, messages, raw := be.counters()
	if messages != messagesAfterSelect {
		t.Errorf("Messages calls = %d, want %d: an unchanged folder must not cost a metadata listing",
			messages, messagesAfterSelect)
	}
	if folders != foldersAfterSelect+3 {
		t.Errorf("Folders calls = %d, want %d (one per poll)", folders, foldersAfterSelect+3)
	}
	if raw != 0 {
		t.Errorf("RawMessage calls = %d, want 0", raw)
	}
}

func TestPollWithNoChangeEmitsNoExists(t *testing.T) {
	s := newSelectedSession(t, newFakeBackend(t), WithPollInterval(0))
	w := &recordingUpdateWriter{}
	if err := s.poll(w); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if len(w.exists) != 0 {
		t.Errorf("EXISTS responses = %v, want none when nothing changed", w.exists)
	}
}

// TestPollAppendsNewMailWithoutRenumbering is the core of the refresh: new
// messages extend the tail, every existing sequence number keeps its UID,
// and the new message is fetchable by its sequence number in the same
// session.
func TestPollAppendsNewMailWithoutRenumbering(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(0))

	_, before := s.snapshot()
	beforeMap := seqToUID(before)
	if len(beforeMap) != 3 {
		t.Fatalf("snapshot has %d messages, want 3", len(beforeMap))
	}

	uid := be.deliver(t, "inbox", newMessage("Fresh mail", "dave@example.com", time.Now()), rawMsg5)
	if uid != 13 {
		t.Fatalf("delivered UID = %d, want 13 (the folder's uidNext)", uid)
	}

	w := &recordingUpdateWriter{}
	if err := s.poll(w); err != nil {
		t.Fatalf("poll: %v", err)
	}

	if len(w.exists) != 1 || w.exists[0] != 4 {
		t.Fatalf("EXISTS responses = %v, want exactly [4]", w.exists)
	}

	_, after := s.snapshot()
	afterMap := seqToUID(after)
	if len(afterMap) != 4 {
		t.Fatalf("snapshot has %d messages after poll, want 4", len(afterMap))
	}
	for seqNum, wantUID := range beforeMap {
		if afterMap[seqNum] != wantUID {
			t.Errorf("sequence %d moved from UID %d to UID %d; existing numbers must not shift",
				seqNum, wantUID, afterMap[seqNum])
		}
	}
	if afterMap[4] != uid {
		t.Errorf("sequence 4 -> UID %d, want %d", afterMap[4], uid)
	}
	if after.uidNext <= uid {
		t.Errorf("uidNext = %d, want it past the newest UID %d", after.uidNext, uid)
	}
	if after.byUID[uid] == nil {
		t.Error("the new message is missing from the UID index")
	}

	// The new message must be reachable by sequence number without a
	// re-SELECT: that is the whole point of the refresh.
	var fetched []uint32
	if err := after.forEach(imap.SeqSetNum(4), func(seqNum uint32, msg *backend.Message) error {
		fetched = append(fetched, msg.UID)
		return nil
	}); err != nil {
		t.Fatalf("forEach: %v", err)
	}
	if !equalUint32s(fetched, []uint32{uid}) {
		t.Errorf("FETCH 4 resolved to %v, want [%d]", fetched, uid)
	}
}

func TestPollAppendsSeveralMessagesInUIDOrder(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(0))

	first := be.deliver(t, "inbox", newMessage("one", "a@example.com", time.Now()), rawMsg5)
	second := be.deliver(t, "inbox", newMessage("two", "b@example.com", time.Now()), rawMsg12)

	w := &recordingUpdateWriter{}
	if err := s.poll(w); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if len(w.exists) != 1 || w.exists[0] != 5 {
		t.Errorf("EXISTS responses = %v, want exactly [5]", w.exists)
	}

	_, after := s.snapshot()
	want := []uint32{5, 9, 12, first, second}
	var got []uint32
	for _, msg := range after.msgs {
		got = append(got, msg.UID)
	}
	if !equalUint32s(got, want) {
		t.Errorf("snapshot UIDs = %v, want %v (ascending)", got, want)
	}
}

// TestPollBackendErrorReturnsNilAndKeepsSnapshot covers the constraint that
// matters most operationally: Poll runs after every command, so a Worker
// hiccup must not fail whatever the client just asked for.
func TestPollBackendErrorReturnsNilAndKeepsSnapshot(t *testing.T) {
	cases := []struct {
		name   string
		break_ func(be *fakeBackend)
	}{
		{"folders call fails", func(be *fakeBackend) {
			be.mu.Lock()
			be.foldersErr = &backend.APIError{Kind: backend.ErrKindServer, StatusCode: 503}
			be.mu.Unlock()
		}},
		{"metadata call fails", func(be *fakeBackend) {
			be.mu.Lock()
			be.messagesErr = &backend.APIError{Kind: backend.ErrKindServer, StatusCode: 502}
			be.mu.Unlock()
		}},
		{"selected folder disappears", func(be *fakeBackend) {
			be.mu.Lock()
			be.folders = be.folders[1:]
			be.mu.Unlock()
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			be := newFakeBackend(t)
			s := newSelectedSession(t, be, WithPollInterval(0))
			_, before := s.snapshot()
			beforeMap := seqToUID(before)

			// Deliver first so the metadata-failure case actually reaches
			// the metadata call.
			be.deliver(t, "inbox", newMessage("late", "e@example.com", time.Now()), rawMsg5)
			tc.break_(be)

			w := &recordingUpdateWriter{}
			if err := s.poll(w); err != nil {
				t.Fatalf("poll returned %v; a backend failure must not fail the client's command", err)
			}
			if len(w.exists) != 0 {
				t.Errorf("EXISTS responses = %v, want none after a failed refresh", w.exists)
			}

			_, after := s.snapshot()
			if after == nil {
				t.Fatal("the selection was dropped by a failed poll")
			}
			afterMap := seqToUID(after)
			if len(afterMap) != len(beforeMap) {
				t.Fatalf("snapshot grew to %d messages despite the failure, want %d", len(afterMap), len(beforeMap))
			}
			for seqNum, wantUID := range beforeMap {
				if afterMap[seqNum] != wantUID {
					t.Errorf("sequence %d changed from UID %d to %d", seqNum, wantUID, afterMap[seqNum])
				}
			}
		})
	}
}

// TestPollDoesNotShrinkOnRemoval is the append-only guarantee. Removing an
// entry mid-session would renumber everything after it, and phase 1 has no
// EXPUNGE sequencing to announce that safely.
func TestPollDoesNotShrinkOnRemoval(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(0))

	be.removeMessage("inbox", 9)
	be.deliver(t, "inbox", newMessage("after the removal", "f@example.com", time.Now()), rawMsg5)

	w := &recordingUpdateWriter{}
	if err := s.poll(w); err != nil {
		t.Fatalf("poll: %v", err)
	}

	_, after := s.snapshot()
	var got []uint32
	for _, msg := range after.msgs {
		got = append(got, msg.UID)
	}
	if !equalUint32s(got, []uint32{5, 9, 12, 13}) {
		t.Errorf("snapshot UIDs = %v, want [5 9 12 13]: the removed message must stay until reselect", got)
	}
	if len(w.exists) != 1 || w.exists[0] != 4 {
		t.Errorf("EXISTS responses = %v, want [4]", w.exists)
	}
}

// TestPollIgnoresUIDValidityChange: once UIDVALIDITY moves, every UID the
// client holds refers to a different folder generation. Growing across
// that boundary would mix two generations in one snapshot.
func TestPollIgnoresUIDValidityChange(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(0))

	be.deliver(t, "inbox", newMessage("post rebuild", "g@example.com", time.Now()), rawMsg5)
	be.setUIDValidity("inbox", 999)

	w := &recordingUpdateWriter{}
	if err := s.poll(w); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if len(w.exists) != 0 {
		t.Errorf("EXISTS responses = %v, want none across a UIDVALIDITY change", w.exists)
	}
	_, after := s.snapshot()
	if after.numMessages() != 3 {
		t.Errorf("snapshot has %d messages, want the original 3", after.numMessages())
	}
	if after.uidValidity != 1712345678 {
		t.Errorf("uidValidity = %d, want the selected generation", after.uidValidity)
	}
}

// TestPollSkipsOutOfOrderUID guards the ascending-UID invariant: a message
// that shows up with a UID below the current maximum cannot be appended
// without renumbering, so it waits for the next SELECT.
func TestPollSkipsOutOfOrderUID(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(0))

	be.mu.Lock()
	// UID 11 is below the snapshot's maximum of 12, but the folder's
	// uidNext still advances, so the refresh will look.
	be.messages["inbox"] = append(be.messages["inbox"], backend.Message{
		UID:          11,
		InternalDate: time.Now(),
		RFC822Size:   int64(len(rawMsg5)),
	})
	for i := range be.folders {
		if be.folders[i].ID == "inbox" {
			be.folders[i].UIDNext = 20
		}
	}
	be.mu.Unlock()

	w := &recordingUpdateWriter{}
	if err := s.poll(w); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if len(w.exists) != 0 {
		t.Errorf("EXISTS responses = %v, want none: UID 11 cannot be appended after UID 12", w.exists)
	}

	_, after := s.snapshot()
	var got []uint32
	for _, msg := range after.msgs {
		got = append(got, msg.UID)
	}
	if !equalUint32s(got, []uint32{5, 9, 12}) {
		t.Errorf("snapshot UIDs = %v, want the original [5 9 12]", got)
	}
	// uidNext must still advance so the next poll does not re-run the
	// same listing forever.
	if after.uidNext != 20 {
		t.Errorf("uidNext = %d, want 20", after.uidNext)
	}
}

// TestPollIntervalThrottlesBackendCalls checks the floor that keeps Poll
// off the critical path of a burst of FETCHes.
func TestPollIntervalThrottlesBackendCalls(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(time.Hour))

	_, foldersAfterSelect, _, _ := be.counters()
	for i := 0; i < 10; i++ {
		if err := s.poll(&recordingUpdateWriter{}); err != nil {
			t.Fatalf("poll: %v", err)
		}
	}
	if _, folders, _, _ := be.counters(); folders != foldersAfterSelect {
		t.Errorf("Folders calls = %d, want %d: SELECT just built the snapshot, so polls inside the interval must be skipped",
			folders, foldersAfterSelect)
	}

	// Once the interval has elapsed, the next poll does the work.
	s.mu.Lock()
	s.lastPoll = time.Now().Add(-2 * time.Hour)
	s.mu.Unlock()

	if err := s.poll(&recordingUpdateWriter{}); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if _, folders, _, _ := be.counters(); folders != foldersAfterSelect+1 {
		t.Errorf("Folders calls = %d, want %d after the interval elapsed", folders, foldersAfterSelect+1)
	}
}

func TestPollWithoutSelectionDoesNothing(t *testing.T) {
	be := newFakeBackend(t)
	s := newLoggedInSession(t, be, WithPollInterval(0))

	_, foldersBefore, messagesBefore, _ := be.counters()
	if err := s.poll(&recordingUpdateWriter{}); err != nil {
		t.Fatalf("poll: %v", err)
	}
	_, folders, messages, _ := be.counters()
	if folders != foldersBefore || messages != messagesBefore {
		t.Errorf("poll without a selection made backend calls: folders %d->%d, messages %d->%d",
			foldersBefore, folders, messagesBefore, messages)
	}
}

func TestPollTolerantOfNilWriter(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(0))
	be.deliver(t, "inbox", newMessage("no writer", "h@example.com", time.Now()), rawMsg5)

	// go-imap always passes a writer, but a nil must not panic, and the
	// snapshot must still grow so the next FETCH can see the message.
	if err := s.Poll(nil, true); err != nil {
		t.Fatalf("Poll(nil): %v", err)
	}
	if _, after := s.snapshot(); after.numMessages() != 4 {
		t.Errorf("snapshot has %d messages, want 4", after.numMessages())
	}
}

// TestNewMailAppearsAfterNoop is the end-to-end version, over the real
// protocol: a client sitting in INBOX issues NOOP, receives EXISTS, and can
// immediately fetch the new message by sequence number. This is the
// behaviour a mail client actually depends on.
func TestNewMailAppearsAfterNoop(t *testing.T) {
	be := newFakeBackend(t)
	c := startRawClient(t, be, WithPollInterval(0))

	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	selectLines := c.do("SELECT INBOX")
	requireOK(t, selectLines)
	if !strings.Contains(strings.Join(selectLines, "\n"), "* 3 EXISTS") {
		t.Fatalf("SELECT = %q, want 3 EXISTS", selectLines)
	}

	// Nothing new yet: NOOP must not invent an EXISTS.
	quiet := c.do("NOOP")
	requireOK(t, quiet)
	if strings.Contains(strings.Join(quiet, "\n"), "EXISTS") {
		t.Errorf("NOOP on an unchanged folder = %q, want no EXISTS", quiet)
	}

	uid := be.deliver(t, "inbox", newMessage("Fresh mail", "dave@example.com", time.Now()), rawMsg12)

	noop := c.do("NOOP")
	requireOK(t, noop)
	if !strings.Contains(strings.Join(noop, "\n"), "* 4 EXISTS") {
		t.Fatalf("NOOP after delivery = %q, want * 4 EXISTS", noop)
	}

	fetch := c.do("FETCH 4 (UID ENVELOPE)")
	requireOK(t, fetch)
	joined := strings.Join(fetch, "\n")
	if !strings.Contains(joined, "UID 13") {
		t.Errorf("FETCH 4 = %q, want UID %d", joined, uid)
	}
	if !strings.Contains(joined, "Fresh mail") {
		t.Errorf("FETCH 4 = %q, want the new message's subject", joined)
	}

	// And the body is reachable too, which means the raw path keyed off
	// the grown snapshot as well.
	body := c.do("UID FETCH %d (BODY.PEEK[TEXT])", uid)
	requireOK(t, body)
	if !strings.Contains(strings.Join(body, "\n"), "bananas") {
		t.Errorf("UID FETCH %d BODY[TEXT] = %q, want the delivered body", uid, body)
	}
}

// TestPollDuringFetchDoesNotDisturbTheRunningCommand checks the
// copy-on-write: go-imap polls after FETCH, so the FETCH that triggered the
// growth must still report the counts it started with.
func TestPollDuringFetchDoesNotDisturbTheRunningCommand(t *testing.T) {
	be := newFakeBackend(t)
	c := startRawClient(t, be, WithPollInterval(0))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))

	be.deliver(t, "inbox", newMessage("arrives mid-command", "i@example.com", time.Now()), rawMsg5)

	// "1:*" resolves against the snapshot taken when FETCH started, so it
	// must return the original three messages, and the EXISTS for the
	// fourth arrives after them.
	lines := c.do("FETCH 1:* (UID)")
	requireOK(t, lines)

	var fetchResponses, existsResponses int
	for _, line := range lines {
		if strings.Contains(line, " FETCH (") {
			fetchResponses++
		}
		if strings.HasSuffix(line, " EXISTS") {
			existsResponses++
		}
	}
	if fetchResponses != 3 {
		t.Errorf("FETCH 1:* returned %d messages, want the 3 in the snapshot at command start: %q", fetchResponses, lines)
	}
	if existsResponses != 1 {
		t.Errorf("got %d EXISTS responses, want 1: %q", existsResponses, lines)
	}

	// The next command sees the grown mailbox.
	next := c.do("FETCH 4 (UID)")
	requireOK(t, next)
	if !strings.Contains(strings.Join(next, "\n"), "UID 13") {
		t.Errorf("FETCH 4 = %q, want the newly appended UID", next)
	}
}
