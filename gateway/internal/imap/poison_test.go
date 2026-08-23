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
	"github.com/emersion/go-imap/v2/imapserver"

	"github.com/crumrine/agentic-inbox-imap/gateway/internal/backend"
)

// selectedStateCommands is every entry point that operates on the
// snapshot. They must fail together the moment it stops describing
// reality: one of them still answering is the bug this poisoning exists to
// prevent.
func selectedStateCommands() map[string]func(*Session) error {
	return map[string]func(*Session) error{
		"Fetch": func(s *Session) error {
			// A sequence number the snapshot does not hold: if poisoning
			// ever regressed, this returns nil and the test says so,
			// rather than panicking on the nil FetchWriter that
			// imapserver alone can construct.
			return s.Fetch(nil, imap.SeqSetNum(999), &imap.FetchOptions{UID: true})
		},
		"Search": func(s *Session) error {
			_, err := s.Search(imapserver.NumKindUID, &imap.SearchCriteria{}, &imap.SearchOptions{ReturnAll: true})
			return err
		},
		"Store": func(s *Session) error {
			return s.Store(nil, imap.UIDSetNum(5), &imap.StoreFlags{
				Op: imap.StoreFlagsAdd, Silent: true, Flags: []imap.Flag{imap.FlagSeen},
			}, nil)
		},
		"Copy": func(s *Session) error {
			_, err := s.Copy(imap.UIDSetNum(5), "Archive")
			return err
		},
		"Move": func(s *Session) error {
			return s.Move(nil, imap.UIDSetNum(5), "Archive")
		},
		"UIDExpunge": func(s *Session) error {
			set := imap.UIDSetNum(5)
			return s.expunge(&recordingExpungeWriter{}, &set)
		},
	}
}

// poisonByUIDValidityChange replaces the folder generation underneath a
// live selection and drives one poll, which is what a client sitting on an
// open mailbox would do on its next NOOP.
func poisonByUIDValidityChange(t *testing.T, s *Session, be *fakeBackend) {
	t.Helper()
	be.setUIDValidity("inbox", 999)
	if err := s.poll(t.Context(), &recordingUpdateWriter{}); err != nil {
		t.Fatalf("poll: %v", err)
	}
}

func TestUIDValidityChangePoisonsEverySelectedCommand(t *testing.T) {
	for name, run := range selectedStateCommands() {
		t.Run(name, func(t *testing.T) {
			be := newFakeBackend(t)
			s := newSelectedSession(t, be, WithPollInterval(0))
			poisonByUIDValidityChange(t, s, be)

			err := run(s)
			if err == nil {
				t.Fatalf("%s succeeded against a folder generation the client cannot address", name)
			}
			if !errors.Is(err, errMailboxReselectRequired) {
				t.Fatalf("%s err = %#v, want errMailboxReselectRequired", name, err)
			}

			var imapErr *imap.Error
			if !errors.As(err, &imapErr) {
				t.Fatalf("err = %#v, want *imap.Error", err)
			}
			if imapErr.Type != imap.StatusResponseTypeNo {
				t.Errorf("err = %v, want a NO: the client did nothing wrong", imapErr)
			}
			// The text has to name the recovery, or a client retries the
			// same doomed command instead of resyncing.
			if !strings.Contains(strings.ToLower(imapErr.Text), "reselect") {
				t.Errorf("err text = %q, want it to tell the client to reselect", imapErr.Text)
			}
		})
	}
}

// TestPoisonedSelectionIsNotRenumberedOrShrunk: poisoning refuses to serve
// the snapshot, it does not quietly rewrite it. The append-only invariant
// still holds, because the client was never sent an EXPUNGE.
func TestPoisonedSelectionIsNotRenumberedOrShrunk(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(0))
	before := snapshotUIDs(t, s)

	poisonByUIDValidityChange(t, s, be)

	if got := snapshotUIDs(t, s); !equalUint32s(got, before) {
		t.Errorf("snapshot = %v, want it left exactly as %v", got, before)
	}
}

// TestPoisonedSelectionStopsPolling: there is nothing worth fetching for a
// snapshot that is already known to be wrong, and growing it would add
// messages from a generation the client cannot address.
func TestPoisonedSelectionStopsPolling(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(0))
	poisonByUIDValidityChange(t, s, be)

	_, foldersAfterPoison, messagesAfterPoison, _ := be.counters()
	for i := 0; i < 3; i++ {
		if err := s.poll(t.Context(), &recordingUpdateWriter{}); err != nil {
			t.Fatalf("poll after poisoning: %v", err)
		}
	}
	_, folders, messages, _ := be.counters()
	if folders != foldersAfterPoison || messages != messagesAfterPoison {
		t.Errorf("polling continued after poisoning: folders %d->%d, messages %d->%d",
			foldersAfterPoison, folders, messagesAfterPoison, messages)
	}
}

// TestMissingFolderPoisonsToo covers the other way a snapshot stops
// describing reality. A successful folder listing that omits the selected
// folder is a definite statement, not a blip: a blip is a transport error,
// which keeps the snapshot instead.
func TestMissingFolderPoisonsToo(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(0))

	be.mu.Lock()
	be.folders = be.folders[1:] // drop inbox
	be.mu.Unlock()

	if err := s.poll(t.Context(), &recordingUpdateWriter{}); err != nil {
		t.Fatalf("poll: %v", err)
	}

	_, _, err := s.selected()
	if !errors.Is(err, errMailboxGone) {
		t.Fatalf("err = %#v, want errMailboxGone", err)
	}
}

// TestTransientFolderFailureDoesNotPoison is the other side of that line.
// A backend that cannot answer says nothing about the folder, so the
// snapshot must survive: poisoning on a hiccup would force a resync every
// time the Worker blinked.
func TestTransientFolderFailureDoesNotPoison(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(0))

	be.mu.Lock()
	be.foldersErr = &backend.APIError{Kind: backend.ErrKindServer, StatusCode: 503}
	be.mu.Unlock()

	if err := s.poll(t.Context(), &recordingUpdateWriter{}); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if _, _, err := s.selected(); err != nil {
		t.Errorf("selection was poisoned by a transient folders failure: %v", err)
	}
	if _, err := s.Search(imapserver.NumKindUID, &imap.SearchCriteria{}, &imap.SearchOptions{ReturnAll: true}); err != nil {
		t.Errorf("SEARCH after a transient folders failure = %v, want it to still work", err)
	}
}

// TestUIDValidityChangeDuringIdlePoisons: IDLE runs the same refresh on a
// timer, so it has to poison identically. A client that idles for half an
// hour is exactly the one most likely to be holding a stale generation.
func TestUIDValidityChangeDuringIdlePoisons(t *testing.T) {
	be := newFakeBackend(t)
	s := idleSession(t, be, 10*time.Millisecond)

	w := newSyncUpdateWriter()
	stop, done := runIdle(t, s, w)

	be.setUIDValidity("inbox", 999)

	// Wait for the idle loop to notice.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, _, err := s.selected(); errors.Is(err, errMailboxReselectRequired) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("IDLE never noticed the UIDVALIDITY change")
		}
		time.Sleep(5 * time.Millisecond)
	}

	// IDLE itself keeps running until the client says DONE; the failure is
	// for the next command to report.
	select {
	case err := <-done:
		t.Fatalf("Idle returned %v on poisoning; it must block until stop", err)
	default:
	}

	stop()
	if err := <-done; err != nil {
		t.Fatalf("Idle returned %v, want nil", err)
	}
	if got := w.snapshot(); len(got) != 0 {
		t.Errorf("EXISTS = %v, want none across a generation change", got)
	}
}

// TestReselectRecoversFromPoisoning is the whole point: the client is told
// what to do, and doing it works.
func TestReselectRecoversFromPoisoning(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(0))
	poisonByUIDValidityChange(t, s, be)

	if _, _, err := s.selected(); !errors.Is(err, errMailboxReselectRequired) {
		t.Fatalf("the selection was not poisoned: %v", err)
	}

	data, err := s.Select("INBOX", nil)
	if err != nil {
		t.Fatalf("reselect: %v", err)
	}
	if data.UIDValidity != 999 {
		t.Errorf("UIDVALIDITY = %d, want the new generation 999", data.UIDValidity)
	}

	if _, _, err := s.selected(); err != nil {
		t.Errorf("selection is still poisoned after a reselect: %v", err)
	}
	if _, err := s.Search(imapserver.NumKindUID, &imap.SearchCriteria{}, &imap.SearchOptions{ReturnAll: true}); err != nil {
		t.Errorf("SEARCH after reselect = %v, want it to work", err)
	}
}

// TestUnselectClearsPoisoning: CLOSE and UNSELECT are the other recovery,
// and a poisoned selection must not survive into the next one.
func TestUnselectClearsPoisoning(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(0))
	poisonByUIDValidityChange(t, s, be)

	if err := s.Unselect(); err != nil {
		t.Fatalf("Unselect: %v", err)
	}
	if _, err := s.Select("Archive", nil); err != nil {
		t.Fatalf("Select after Unselect: %v", err)
	}
	if _, _, err := s.selected(); err != nil {
		t.Errorf("a fresh selection inherited the fault: %v", err)
	}
}

// TestCloseSucceedsOnAPoisonedSelection is the trap this could have been.
// go-imap only calls Unselect when Expunge returns nil, so failing the
// CLOSE path would leave a client unable to close the mailbox it was just
// told to close and reselect.
func TestCloseSucceedsOnAPoisonedSelection(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(0))
	poisonByUIDValidityChange(t, s, be)

	// The CLOSE path: nil UID set.
	if err := s.expunge(&recordingExpungeWriter{}, nil); err != nil {
		t.Fatalf("CLOSE on a poisoned selection = %v, want nil so the client can recover", err)
	}
	if err := s.Unselect(); err != nil {
		t.Fatalf("Unselect: %v", err)
	}
	// Nothing was expunged: the UIDs may now name different messages.
	if _, called := be.lastExpungeRequest(); called {
		t.Error("CLOSE expunged against a replaced folder generation")
	}
}

// TestPoisonDoesNotLeakToAConcurrentReselect guards the installGrown-style
// check: a refresh in flight must not poison a selection that has already
// been replaced.
func TestPoisonDoesNotLeakToAConcurrentReselect(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(0))
	_, stale := s.snapshot()

	// A fresh SELECT lands first.
	if _, err := s.Select("INBOX", nil); err != nil {
		t.Fatalf("Select: %v", err)
	}

	// Now the older refresh reports its finding against the snapshot it
	// started from.
	s.poisonSelection(stale, errMailboxReselectRequired)

	if _, _, err := s.selected(); err != nil {
		t.Errorf("the new selection was poisoned by a stale refresh: %v", err)
	}
}

// TestAuthenticatedCommandsSurvivePoisoning: poisoning is about the
// selection, not the mailbox. LIST, STATUS and SELECT must keep working or
// the client cannot find out what to reselect.
func TestAuthenticatedCommandsSurvivePoisoning(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(0))
	poisonByUIDValidityChange(t, s, be)

	w := &recordingListWriter{}
	if err := s.listInto(w, "", []string{"*"}, &imap.ListOptions{}); err != nil {
		t.Errorf("LIST while poisoned: %v", err)
	}
	if len(w.entries) == 0 {
		t.Error("LIST returned nothing while poisoned")
	}
	if _, err := s.Status("INBOX", &imap.StatusOptions{NumMessages: true}); err != nil {
		t.Errorf("STATUS while poisoned: %v", err)
	}
}

// ---------------------------------------------------------------------
// Protocol level
// ---------------------------------------------------------------------

// TestPoisonedSelectionOverTheWire is the client's experience: a clean NO
// naming the recovery, a connection that survives, and a reselect that
// works.
func TestPoisonedSelectionOverTheWire(t *testing.T) {
	be := newFakeBackend(t)
	c := startRawClient(t, be, WithPollInterval(0))

	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))

	be.setUIDValidity("inbox", 999)

	// A NOOP drives the poll that notices. NOOP itself does not touch the
	// snapshot, so it still succeeds.
	requireOK(t, c.do("NOOP"))

	lines := c.do("FETCH 1 (UID)")
	requireNo(t, lines)
	final := lastLine(lines)
	if !strings.Contains(strings.ToLower(final), "reselect") {
		t.Errorf("FETCH = %q, want the client told to reselect", final)
	}

	// The connection survives.
	requireOK(t, c.do("NOOP"))

	// And the advertised recovery works, end to end.
	sel := c.do("SELECT INBOX")
	requireOK(t, sel)
	if !strings.Contains(strings.Join(sel, "\n"), "[UIDVALIDITY 999]") {
		t.Errorf("SELECT = %q, want the new UIDVALIDITY", sel)
	}
	fetch := c.do("FETCH 1 (UID)")
	requireOK(t, fetch)
	if !strings.Contains(strings.Join(fetch, "\n"), "UID 5") {
		t.Errorf("FETCH after reselect = %q, want UID 5", fetch)
	}
}

// TestCloseRecoversAPoisonedSelectionOverTheWire: the other recovery a
// client may reach for.
func TestCloseRecoversAPoisonedSelectionOverTheWire(t *testing.T) {
	be := newFakeBackend(t)
	c := startRawClient(t, be, WithPollInterval(0))

	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))
	be.setUIDValidity("inbox", 999)
	requireOK(t, c.do("NOOP"))
	requireNo(t, c.do("FETCH 1 (UID)"))

	requireOK(t, c.do("CLOSE"))
	requireOK(t, c.do("SELECT INBOX"))
	requireOK(t, c.do("FETCH 1 (UID)"))
}
