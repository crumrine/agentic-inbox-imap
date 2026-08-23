// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"errors"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"

	"github.com/crumrine/agentic-inbox-imap/gateway/internal/backend"
)

// storeSilent runs a STORE with .SILENT so no FetchWriter is needed.
// imapserver.FetchWriter cannot be built outside the library, so the
// untagged-FETCH behaviour is covered at protocol level instead.
func storeSilent(t *testing.T, s *Session, numSet imap.NumSet, op imap.StoreFlagsOp, flags ...imap.Flag) {
	t.Helper()
	err := s.Store(nil, numSet, &imap.StoreFlags{Op: op, Silent: true, Flags: flags}, nil)
	if err != nil {
		t.Fatalf("STORE: %v", err)
	}
}

// snapshotFlags reads a message's flags back out of the session snapshot.
func snapshotFlags(t *testing.T, s *Session, uid uint32) []string {
	t.Helper()
	_, sel := s.snapshot()
	msg, ok := sel.byUID[uid]
	if !ok {
		t.Fatalf("uid %d is not in the snapshot", uid)
	}
	out := append([]string(nil), msg.Flags...)
	sort.Strings(out)
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestStoreAddFlags(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	// uid 12 starts with \Flagged only.
	storeSilent(t, s, imap.UIDSetNum(12), imap.StoreFlagsAdd, imap.FlagSeen)

	if got, want := be.flagsFor("inbox", 12), []string{`\Flagged`, `\Seen`}; !equalStrings(got, want) {
		t.Errorf("backend flags = %v, want %v", got, want)
	}
	if got, want := snapshotFlags(t, s, 12), []string{`\Flagged`, `\Seen`}; !equalStrings(got, want) {
		t.Errorf("snapshot flags = %v, want %v", got, want)
	}

	// The wire payload must be an add, not a replace.
	updates := be.lastFlagUpdates()
	if len(updates) != 1 || updates[0].UID != 12 {
		t.Fatalf("updates = %+v", updates)
	}
	if !equalStrings(updates[0].Add, []string{`\Seen`}) || len(updates[0].Remove) != 0 {
		t.Errorf("update = %+v, want add [\\Seen] and no removals", updates[0])
	}
}

func TestStoreRemoveFlags(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	// uid 9 starts with \Seen \Flagged $Important.
	storeSilent(t, s, imap.UIDSetNum(9), imap.StoreFlagsDel, imap.FlagFlagged)

	if got, want := snapshotFlags(t, s, 9), []string{`$Important`, `\Seen`}; !equalStrings(got, want) {
		t.Errorf("snapshot flags = %v, want %v", got, want)
	}
	updates := be.lastFlagUpdates()
	if len(updates[0].Add) != 0 || !equalStrings(updates[0].Remove, []string{`\Flagged`}) {
		t.Errorf("update = %+v, want remove [\\Flagged] and no additions", updates[0])
	}
}

// TestStoreReplaceFlags: a replace has to clear what it does not name,
// which the endpoint's add/remove shape expresses as an explicit removal
// list.
func TestStoreReplaceFlags(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	// uid 9 starts with \Seen \Flagged $Important; replace with \Answered.
	storeSilent(t, s, imap.UIDSetNum(9), imap.StoreFlagsSet, imap.FlagAnswered)

	if got, want := snapshotFlags(t, s, 9), []string{`\Answered`}; !equalStrings(got, want) {
		t.Errorf("snapshot flags = %v, want %v", got, want)
	}
	if got, want := be.flagsFor("inbox", 9), []string{`\Answered`}; !equalStrings(got, want) {
		t.Errorf("backend flags = %v, want %v", got, want)
	}

	// The removal list covers every storable system flag not named, plus
	// the keyword the snapshot knew about, so a stale cache cannot leave a
	// flag behind.
	updates := be.lastFlagUpdates()
	remove := append([]string(nil), updates[0].Remove...)
	sort.Strings(remove)
	want := []string{`$Important`, `\Deleted`, `\Flagged`, `\Seen`}
	if !equalStrings(remove, want) {
		t.Errorf("remove = %v, want %v", remove, want)
	}
}

func TestStoreReplaceWithNoFlagsClearsEverything(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	storeSilent(t, s, imap.UIDSetNum(9), imap.StoreFlagsSet)

	if got := snapshotFlags(t, s, 9); len(got) != 0 {
		t.Errorf("snapshot flags = %v, want none", got)
	}
}

func TestStoreBySequenceNumber(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	// Sequence 2 is uid 9. Getting this wrong is how a client marks the
	// wrong message read.
	storeSilent(t, s, imap.SeqSetNum(2), imap.StoreFlagsAdd, imap.FlagAnswered)

	updates := be.lastFlagUpdates()
	if len(updates) != 1 || updates[0].UID != 9 {
		t.Fatalf("updates = %+v, want a single update for uid 9", updates)
	}
	if !strings.Contains(strings.Join(snapshotFlags(t, s, 9), " "), `\Answered`) {
		t.Errorf("uid 9 flags = %v, want \\Answered", snapshotFlags(t, s, 9))
	}
	// And nothing else was touched.
	if got := snapshotFlags(t, s, 5); !equalStrings(got, []string{`\Seen`}) {
		t.Errorf("uid 5 flags = %v, want them unchanged", got)
	}
}

func TestStoreOverARange(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	storeSilent(t, s, imap.SeqSet{{Start: 1, Stop: 3}}, imap.StoreFlagsAdd, imap.FlagSeen)

	updates := be.lastFlagUpdates()
	if len(updates) != 3 {
		t.Fatalf("updates = %+v, want one per message", updates)
	}
	for _, uid := range []uint32{5, 9, 12} {
		if !strings.Contains(strings.Join(snapshotFlags(t, s, uid), " "), `\Seen`) {
			t.Errorf("uid %d flags = %v, want \\Seen", uid, snapshotFlags(t, s, uid))
		}
	}
	// One batch, not three round trips.
	if got := be.setFlagsCallCount(); got != 1 {
		t.Errorf("SetFlags calls = %d, want 1 batched call", got)
	}
}

// TestStoreSkipsVanishedMessage: the Worker omits UIDs it does not know.
// One dead message must not cost the rest of the range.
func TestStoreSkipsVanishedMessage(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	be.removeMessage("inbox", 9)

	storeSilent(t, s, imap.SeqSet{{Start: 1, Stop: 3}}, imap.StoreFlagsAdd, imap.FlagSeen)

	for _, uid := range []uint32{5, 12} {
		if !strings.Contains(strings.Join(snapshotFlags(t, s, uid), " "), `\Seen`) {
			t.Errorf("uid %d flags = %v, want \\Seen despite uid 9 being gone", uid, snapshotFlags(t, s, uid))
		}
	}
	// The vanished message keeps whatever the snapshot last knew.
	if got := snapshotFlags(t, s, 9); !equalStrings(got, []string{`$Important`, `\Flagged`, `\Seen`}) {
		t.Errorf("uid 9 flags = %v, want the pre-store snapshot values", got)
	}
}

// TestStoreIgnoresUnsettableFlags: \Draft and \Recent are dropped rather
// than rejected. Failing a command over one unsupported flag is the class
// of thing that put iOS into a reconnect loop.
func TestStoreIgnoresUnsettableFlags(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	storeSilent(t, s, imap.UIDSetNum(12), imap.StoreFlagsAdd, imap.FlagDraft, flagRecent, imap.FlagSeen)

	updates := be.lastFlagUpdates()
	if !equalStrings(updates[0].Add, []string{`\Seen`}) {
		t.Errorf("add = %v, want only [\\Seen]", updates[0].Add)
	}
	if got := snapshotFlags(t, s, 12); !equalStrings(got, []string{`\Flagged`, `\Seen`}) {
		t.Errorf("snapshot flags = %v", got)
	}
}

// TestStoreWithOnlyUnsettableFlagsSkipsTheBackend: nothing to do means no
// round trip, and still no error.
func TestStoreWithOnlyUnsettableFlagsSkipsTheBackend(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	storeSilent(t, s, imap.UIDSetNum(12), imap.StoreFlagsAdd, imap.FlagDraft)

	if got := be.setFlagsCallCount(); got != 0 {
		t.Errorf("SetFlags calls = %d, want 0 for a no-op STORE", got)
	}
	if got := snapshotFlags(t, s, 12); !equalStrings(got, []string{`\Flagged`}) {
		t.Errorf("snapshot flags = %v, want them unchanged", got)
	}
}

func TestStoreCustomKeyword(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	storeSilent(t, s, imap.UIDSetNum(5), imap.StoreFlagsAdd, imap.Flag("$Label1"))

	if got, want := snapshotFlags(t, s, 5), []string{`$Label1`, `\Seen`}; !equalStrings(got, want) {
		t.Errorf("snapshot flags = %v, want %v", got, want)
	}
}

func TestStoreBackendFailureIsACleanIMAPError(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	be.mu.Lock()
	be.setFlagsErr = &backend.APIError{Kind: backend.ErrKindServer, StatusCode: 503, Body: "upstream https://inbox.internal down"}
	be.mu.Unlock()

	err := s.Store(nil, imap.UIDSetNum(5), &imap.StoreFlags{Op: imap.StoreFlagsAdd, Silent: true, Flags: []imap.Flag{imap.FlagSeen}}, nil)
	if err == nil {
		t.Fatal("STORE succeeded against a failing backend")
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
	// The snapshot must not have moved.
	if got := snapshotFlags(t, s, 5); !equalStrings(got, []string{`\Seen`}) {
		t.Errorf("snapshot flags = %v after a failed STORE", got)
	}
}

func TestStoreRejectsCondStore(t *testing.T) {
	s := newSelectedSession(t, newFakeBackend(t))
	err := s.Store(nil, imap.UIDSetNum(5), &imap.StoreFlags{Op: imap.StoreFlagsAdd, Silent: true, Flags: []imap.Flag{imap.FlagSeen}},
		&imap.StoreOptions{UnchangedSince: 1})
	if err == nil {
		t.Fatal("STORE UNCHANGEDSINCE succeeded, want NO")
	}
}

func TestStoreWithoutSelection(t *testing.T) {
	s := newLoggedInSession(t, newFakeBackend(t))
	if err := s.Store(nil, imap.UIDSetNum(5), &imap.StoreFlags{Op: imap.StoreFlagsAdd, Silent: true}, nil); err != errNoMailboxSelected {
		t.Errorf("err = %#v, want errNoMailboxSelected", err)
	}
}

// TestStoreRefusedOnExaminedMailbox: EXAMINE opens the mailbox read-only,
// and PERMANENTFLAGS said so, so a STORE against it is answered plainly
// rather than silently accepted.
func TestStoreRefusedOnExaminedMailbox(t *testing.T) {
	be := newFakeBackend(t)
	s := newLoggedInSession(t, be)
	if _, err := s.Select("INBOX", &imap.SelectOptions{ReadOnly: true}); err != nil {
		t.Fatalf("EXAMINE: %v", err)
	}

	err := s.Store(nil, imap.UIDSetNum(5), &imap.StoreFlags{Op: imap.StoreFlagsAdd, Silent: true, Flags: []imap.Flag{imap.FlagSeen}}, nil)
	if err == nil {
		t.Fatal("STORE on an examined mailbox succeeded")
	}
	var imapErr *imap.Error
	if !errors.As(err, &imapErr) || imapErr.Type != imap.StatusResponseTypeNo {
		t.Errorf("err = %#v, want a NO", err)
	}
	if got := be.setFlagsCallCount(); got != 0 {
		t.Errorf("SetFlags calls = %d, want 0", got)
	}
}

// TestStoreDeltaTable pins the add/remove algebra directly.
func TestStoreDeltaTable(t *testing.T) {
	tests := []struct {
		name       string
		op         imap.StoreFlagsOp
		flags      []imap.Flag
		current    []string
		wantAdd    []string
		wantRemove []string
	}{
		{
			"add one", imap.StoreFlagsAdd, []imap.Flag{imap.FlagSeen}, nil,
			[]string{`\Seen`}, []string{},
		},
		{
			"add is case-insensitive and canonicalised", imap.StoreFlagsAdd, []imap.Flag{`\seen`}, nil,
			[]string{`\Seen`}, []string{},
		},
		{
			"duplicates collapse", imap.StoreFlagsAdd, []imap.Flag{imap.FlagSeen, `\SEEN`}, nil,
			[]string{`\Seen`}, []string{},
		},
		{
			"remove one", imap.StoreFlagsDel, []imap.Flag{imap.FlagFlagged}, []string{`\Flagged`},
			[]string{}, []string{`\Flagged`},
		},
		{
			"unsettable flags dropped", imap.StoreFlagsAdd, []imap.Flag{imap.FlagDraft, flagRecent}, nil,
			[]string{}, []string{},
		},
		{
			"replace clears the rest", imap.StoreFlagsSet, []imap.Flag{imap.FlagSeen}, []string{`$Label`},
			[]string{`\Seen`}, []string{`$Label`, `\Answered`, `\Deleted`, `\Flagged`},
		},
		{
			"replace with nothing clears everything storable", imap.StoreFlagsSet, nil, nil,
			[]string{}, []string{`\Answered`, `\Deleted`, `\Flagged`, `\Seen`},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			add, remove := storeDelta(&imap.StoreFlags{Op: tc.op, Flags: tc.flags}, tc.current)
			sort.Strings(add)
			sort.Strings(remove)
			if !equalStrings(add, tc.wantAdd) {
				t.Errorf("add = %v, want %v", add, tc.wantAdd)
			}
			if !equalStrings(remove, tc.wantRemove) {
				t.Errorf("remove = %v, want %v", remove, tc.wantRemove)
			}
		})
	}
}

// ---------------------------------------------------------------------
// Protocol level: the untagged FETCH behaviour and the iOS sequence
// ---------------------------------------------------------------------

// TestStoreSilentEmitsNothing is the half that is easy to get backwards.
// iOS uses .SILENT, so echoing anyway would double the traffic on the
// hottest command in a sync.
func TestStoreSilentEmitsNothing(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))

	lines := c.do(`UID STORE 12 +FLAGS.SILENT (\Seen)`)
	requireOK(t, lines)
	for _, line := range lines {
		if strings.Contains(line, "FETCH") {
			t.Errorf("SILENT STORE emitted %q, want no untagged FETCH", line)
		}
	}
	if len(lines) != 1 {
		t.Errorf("SILENT STORE response = %q, want only the tagged completion", lines)
	}
}

func TestStoreNonSilentEmitsUntaggedFetch(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))

	lines := c.do(`STORE 3 +FLAGS (\Seen)`)
	requireOK(t, lines)

	var fetch string
	for _, line := range lines {
		if strings.Contains(line, "FETCH") {
			fetch = line
		}
	}
	if fetch == "" {
		t.Fatalf("non-silent STORE = %q, want an untagged FETCH", lines)
	}
	if !strings.HasPrefix(fetch, "* 3 FETCH ") {
		t.Errorf("untagged FETCH = %q, want it for sequence number 3", fetch)
	}
	if !strings.Contains(fetch, `\Seen`) || !strings.Contains(fetch, `\Flagged`) {
		t.Errorf("untagged FETCH = %q, want the complete resulting flag set", fetch)
	}
	// A sequence-number STORE need not carry UID.
	if strings.Contains(fetch, "UID") {
		t.Errorf("untagged FETCH = %q, unexpected UID for a sequence-number STORE", fetch)
	}
}

// TestUIDStoreEmitsUID: RFC 9051 says the echo for a UID STORE should carry
// the UID, since that is how the client named the message.
func TestUIDStoreEmitsUID(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))

	lines := c.do(`UID STORE 9 -FLAGS (\Flagged)`)
	requireOK(t, lines)

	var fetch string
	for _, line := range lines {
		if strings.Contains(line, "FETCH") {
			fetch = line
		}
	}
	if fetch == "" {
		t.Fatalf("UID STORE = %q, want an untagged FETCH", lines)
	}
	if !strings.Contains(fetch, "UID 9") {
		t.Errorf("untagged FETCH = %q, want UID 9", fetch)
	}
	if strings.Contains(fetch, `\Flagged`) {
		t.Errorf("untagged FETCH = %q, still lists the flag that was removed", fetch)
	}
}

// TestStoreThenFetchAgrees: a client that stores and then re-fetches in the
// same session must not be told two different things.
func TestStoreThenFetchAgrees(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))

	requireOK(t, c.do(`UID STORE 12 +FLAGS.SILENT (\Seen \Answered)`))

	lines := c.do("UID FETCH 12 (UID FLAGS)")
	requireOK(t, lines)
	joined := strings.Join(lines, "\n")
	for _, want := range []string{`\Seen`, `\Answered`, `\Flagged`} {
		if !strings.Contains(joined, want) {
			t.Errorf("FETCH after STORE = %q, missing %q", joined, want)
		}
	}
}

// TestIOSStoreSequence replays the loop captured from the live client. The
// STORE must be answered OK and the connection must survive into IDLE;
// previously the NO here caused a teardown and an endless reconnect.
func TestIOSStoreSequence(t *testing.T) {
	be := newFakeBackend(t)
	c := startRawClient(t, be, WithPollInterval(0), WithIdleInterval(50*time.Millisecond))

	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))

	listing := c.do("UID FETCH 1:* (UID FLAGS)")
	requireOK(t, listing)
	if !strings.Contains(strings.Join(listing, "\n"), "UID 12") {
		t.Fatalf("UID FETCH 1:* = %q", listing)
	}

	store := c.do(`UID STORE 12 +FLAGS.SILENT (\Seen)`)
	requireOK(t, store)
	if strings.Contains(strings.Join(store, "\n"), "NO") {
		t.Fatalf("UID STORE = %q, want OK", store)
	}

	// Straight into IDLE, as the client does.
	c.seq++
	tag := "t" + itoa(c.seq)
	if _, err := c.conn.Write([]byte(tag + " IDLE\r\n")); err != nil {
		t.Fatalf("writing IDLE: %v", err)
	}
	if cont := c.readLine(); !strings.HasPrefix(cont, "+ ") {
		t.Fatalf("IDLE continuation = %q", cont)
	}
	if _, err := c.conn.Write([]byte("DONE\r\n")); err != nil {
		t.Fatalf("writing DONE: %v", err)
	}
	if final := c.readLine(); !strings.Contains(final, " OK") {
		t.Fatalf("IDLE completion = %q, want OK", final)
	}

	// The flag actually landed.
	if got := be.flagsFor("inbox", 12); !strings.Contains(strings.Join(got, " "), `\Seen`) {
		t.Errorf("backend flags for uid 12 = %v, want \\Seen", got)
	}
	requireOK(t, c.do("NOOP"))
}
