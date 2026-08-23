// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"

	"github.com/crumrine/agentic-inbox/gateway/internal/backend"
)

// seedFolder fills a folder with n messages, UIDs 1..n, and returns the
// total RFC822 size. Sizes vary per message so a truncated sum cannot
// coincidentally match the real one.
func seedFolder(t *testing.T, be *fakeBackend, folderID string, n int) int64 {
	t.Helper()

	msgs := make([]backend.Message, 0, n)
	raw := map[uint32]string{}
	var total int64
	for i := 1; i <= n; i++ {
		uid := uint32(i)
		size := int64(100 + i)
		total += size
		msgs = append(msgs, backend.Message{
			UID:          uid,
			InternalDate: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(i) * time.Minute),
			RFC822Size:   size,
			Envelope: backend.Envelope{
				Subject:   "message " + itoa(i),
				From:      []backend.Address{{Address: "sender@example.com"}},
				To:        []backend.Address{{Address: testMailbox}},
				MessageID: "<m" + itoa(i) + "@example.com>",
			},
			HasRaw: true,
		})
		raw[uid] = rawMsg5
	}

	be.mu.Lock()
	be.messages[folderID] = msgs
	be.raw[folderID] = raw
	for i := range be.folders {
		if be.folders[i].ID == folderID {
			be.folders[i].UIDNext = uint32(n + 1)
			be.folders[i].Exists = uint32(n)
			be.folders[i].Unseen = uint32(n)
		}
	}
	be.mu.Unlock()
	return total
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// TestSelectPagesPastTheServerCeiling is the regression test for the
// truncation bug. The Worker clamps an absent or over-large limit to its
// own ceiling, so a folder larger than one page must be read with a paging
// loop or the session sees only the oldest page.
func TestSelectPagesPastTheServerCeiling(t *testing.T) {
	const (
		ceiling = 10
		total   = 35 // three full pages plus a partial one
	)

	be := newFakeBackend(t)
	be.maxLimit = ceiling
	seedFolder(t, be, "inbox", total)

	s := newLoggedInSession(t, be, WithMessagePageSize(ceiling))
	data, err := s.Select("INBOX", nil)
	if err != nil {
		t.Fatalf("Select: %v", err)
	}
	if data.NumMessages != total {
		t.Fatalf("EXISTS = %d, want %d: the folder was truncated to the server's page ceiling", data.NumMessages, total)
	}
	if data.UIDNext != imap.UID(total+1) {
		t.Errorf("UIDNEXT = %d, want %d", data.UIDNext, total+1)
	}

	_, sel := s.snapshot()
	for i, msg := range sel.msgs {
		if msg.UID != uint32(i+1) {
			t.Fatalf("sequence %d -> UID %d, want %d", i+1, msg.UID, i+1)
		}
	}
}

// TestSelectPagesWhenTheServerClampsBelowTheRequest covers the subtler
// half: asking for a page larger than the server's ceiling means every
// "full" page comes back short, so a loop that stops on a short page would
// still truncate.
func TestSelectPagesWhenTheServerClampsBelowTheRequest(t *testing.T) {
	be := newFakeBackend(t)
	be.maxLimit = 7
	seedFolder(t, be, "inbox", 30)

	// Ask for 1000 per page; the fake, like the Worker, silently gives 7.
	s := newLoggedInSession(t, be, WithMessagePageSize(1000))
	data, err := s.Select("INBOX", nil)
	if err != nil {
		t.Fatalf("Select: %v", err)
	}
	if data.NumMessages != 30 {
		t.Fatalf("EXISTS = %d, want 30: a short page is not proof the folder ended", data.NumMessages)
	}
}

// TestSelectSequenceNumbersAtThePageBoundary checks the messages either
// side of a page seam, which is where an off-by-one in the inclusive
// sinceUid would duplicate or drop a message.
func TestSelectSequenceNumbersAtThePageBoundary(t *testing.T) {
	const ceiling = 10

	be := newFakeBackend(t)
	be.maxLimit = ceiling
	seedFolder(t, be, "inbox", 25)

	s := newLoggedInSession(t, be, WithMessagePageSize(ceiling))
	if _, err := s.Select("INBOX", nil); err != nil {
		t.Fatalf("Select: %v", err)
	}
	_, sel := s.snapshot()

	if got := int(sel.numMessages()); got != 25 {
		t.Fatalf("snapshot holds %d messages, want 25", got)
	}
	// Sequence numbers 10 and 11 straddle the first seam, 20 and 21 the
	// second. A duplicated boundary message would shift everything after.
	for _, seqNum := range []uint32{1, 10, 11, 20, 21, 25} {
		var got []uint32
		if err := sel.forEach(imap.SeqSetNum(seqNum), func(_ uint32, msg *backend.Message) error {
			got = append(got, msg.UID)
			return nil
		}); err != nil {
			t.Fatalf("forEach: %v", err)
		}
		if !equalUint32s(got, []uint32{seqNum}) {
			t.Errorf("sequence %d resolved to UIDs %v, want [%d]", seqNum, got, seqNum)
		}
	}
}

// TestStatusSizeSumsTheWholeFolder is the STATUS half of the same bug: the
// figure is reported as an exact byte count, so summing one page presents a
// fraction of the folder as if it were the total.
func TestStatusSizeSumsTheWholeFolder(t *testing.T) {
	const ceiling = 10

	be := newFakeBackend(t)
	be.maxLimit = ceiling
	want := seedFolder(t, be, "inbox", 35)

	s := newLoggedInSession(t, be, WithMessagePageSize(ceiling))
	data, err := s.Status("INBOX", &imap.StatusOptions{Size: true})
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if data.Size == nil {
		t.Fatal("Size is nil")
	}
	if *data.Size != want {
		t.Errorf("STATUS SIZE = %d, want %d (the whole folder, not one page)", *data.Size, want)
	}
}

// TestPollPagesABurstLargerThanOnePage: if more than a page of mail arrives
// between two polls, a single capped listing would read only part of it and
// then advance uidNext past the rest, hiding it for the life of the
// selection.
func TestPollPagesABurstLargerThanOnePage(t *testing.T) {
	const ceiling = 5

	be := newFakeBackend(t)
	be.maxLimit = ceiling
	seedFolder(t, be, "inbox", 3)

	s := newLoggedInSession(t, be, WithMessagePageSize(ceiling), WithPollInterval(0))
	if _, err := s.Select("INBOX", nil); err != nil {
		t.Fatalf("Select: %v", err)
	}

	for i := 0; i < 12; i++ {
		be.deliver(t, "inbox", newMessage("burst "+itoa(i), "burst@example.com", time.Now()), rawMsg5)
	}

	w := &recordingUpdateWriter{}
	if err := s.poll(context.Background(), w); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if len(w.exists) != 1 || w.exists[0] != 15 {
		t.Fatalf("EXISTS = %v, want [15]", w.exists)
	}

	_, sel := s.snapshot()
	if sel.numMessages() != 15 {
		t.Errorf("snapshot holds %d messages, want 15", sel.numMessages())
	}
	// A second poll must find nothing left over.
	w2 := &recordingUpdateWriter{}
	if err := s.poll(context.Background(), w2); err != nil {
		t.Fatalf("second poll: %v", err)
	}
	if len(w2.exists) != 0 {
		t.Errorf("second poll emitted %v, want nothing left to collect", w2.exists)
	}
}

// TestSelectRefusesAFolderOverTheLimit: too big to serve is answered
// honestly rather than by showing a prefix.
func TestSelectRefusesAFolderOverTheLimit(t *testing.T) {
	be := newFakeBackend(t)
	be.maxLimit = 10
	seedFolder(t, be, "inbox", 40)

	s := newLoggedInSession(t, be, WithMessagePageSize(10), WithMaxFolderMessages(25))
	_, err := s.Select("INBOX", nil)
	if err == nil {
		t.Fatal("Select succeeded on an oversize folder; a prefix must never be presented as the folder")
	}
	var imapErr *imap.Error
	if !errors.As(err, &imapErr) {
		t.Fatalf("err = %#v, want *imap.Error", err)
	}
	if imapErr.Code != imap.ResponseCodeLimit {
		t.Errorf("err = %v, want NO [LIMIT]", imapErr)
	}
}

func TestListMessagesTerminatesWhenTheBackendIgnoresSinceUID(t *testing.T) {
	be := &stuckBackend{fakeBackend: newFakeBackend(t)}
	seedFolder(t, be.fakeBackend, "inbox", 12)

	s := newLoggedInSession(t, be, WithMessagePageSize(5))
	// The backend replays the first page forever. The listing must stop
	// rather than hang, even though the result is incomplete.
	done := make(chan struct{})
	go func() {
		defer close(done)
		if _, err := s.Select("INBOX", nil); err != nil {
			t.Errorf("Select: %v", err)
		}
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("Select did not terminate against a backend that ignores sinceUid")
	}
}

// stuckBackend models a backend that ignores sinceUid entirely, so every
// page is the first page. The listing must notice it is making no forward
// progress and stop, rather than loop forever.
type stuckBackend struct {
	*fakeBackend
}

func (b *stuckBackend) Messages(ctx context.Context, mailbox, folder string, opts backend.MessagesOptions) (*backend.MessagesPage, error) {
	return b.fakeBackend.Messages(ctx, mailbox, folder, backend.MessagesOptions{Limit: opts.Limit})
}

// TestFetchSkipsAVanishedMessage is the regression test for one dead UID
// failing an entire range. The app deletes and renumbers rows routinely
// (saving a draft is delete-then-create), so this is the common case, not
// an edge case.
func TestFetchSkipsAVanishedMessage(t *testing.T) {
	be := newFakeBackend(t)
	c := startRawClient(t, be, WithPollInterval(0))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))

	// The middle message disappears from the backend after SELECT, the way
	// a draft save or an archive in the web UI would retire its UID.
	be.mu.Lock()
	delete(be.raw["inbox"], 9)
	be.mu.Unlock()

	lines := c.do("FETCH 1:3 (UID BODY.PEEK[])")
	requireOK(t, lines)

	joined := strings.Join(lines, "\n")
	for _, want := range []string{"UID 5", "UID 12"} {
		if !strings.Contains(joined, want) {
			t.Errorf("FETCH 1:3 = %q, missing %q: a dead UID must not drop the messages around it", joined, want)
		}
	}
	if strings.Contains(joined, "UID 9") {
		t.Errorf("FETCH 1:3 = %q, want the vanished message omitted", joined)
	}
}

// TestFetchMetadataIsUnaffectedByAVanishedMessage: metadata comes from the
// snapshot, so a dead UID changes nothing there. Only body fetches, which
// go to the backend, can discover the message is gone.
func TestFetchMetadataIsUnaffectedByAVanishedMessage(t *testing.T) {
	be := newFakeBackend(t)
	c := startRawClient(t, be, WithPollInterval(0))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))

	be.mu.Lock()
	delete(be.raw["inbox"], 9)
	be.mu.Unlock()

	lines := c.do("FETCH 1:3 (UID FLAGS)")
	requireOK(t, lines)
	joined := strings.Join(lines, "\n")
	for _, want := range []string{"UID 5", "UID 9", "UID 12"} {
		if !strings.Contains(joined, want) {
			t.Errorf("FETCH 1:3 (UID FLAGS) = %q, missing %q", joined, want)
		}
	}
}

// TestFetchStillFailsOnARealBackendError: skipping must be reserved for
// "this UID is gone". A 5xx is a genuine failure and has to surface, or a
// broken Worker would look like an empty mailbox.
func TestFetchStillFailsOnARealBackendError(t *testing.T) {
	be := newFakeBackend(t)
	c := startRawClient(t, be, WithPollInterval(0))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("SELECT INBOX"))

	be.mu.Lock()
	be.rawErr = &backend.APIError{Kind: backend.ErrKindServer, StatusCode: 503}
	be.mu.Unlock()

	lines := c.do("FETCH 1:3 (UID BODY.PEEK[])")
	requireNo(t, lines)
	if !strings.Contains(lastLine(lines), "UNAVAILABLE") {
		t.Errorf("FETCH against a failing backend = %q, want NO [UNAVAILABLE]", lastLine(lines))
	}

	// The connection survives, and recovers once the backend does.
	be.mu.Lock()
	be.rawErr = nil
	be.mu.Unlock()
	recovered := c.do("FETCH 1 (UID BODY.PEEK[])")
	requireOK(t, recovered)
	if !strings.Contains(strings.Join(recovered, "\n"), "UID 5") {
		t.Errorf("FETCH after recovery = %q, want UID 5", recovered)
	}
}

// TestSearchSkipsAVanishedMessage: the same failure mode reaches SEARCH,
// which pulls raw bodies for BODY/TEXT terms.
func TestSearchSkipsAVanishedMessage(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	be.mu.Lock()
	delete(be.raw["inbox"], 5)
	be.mu.Unlock()

	// uid 5 is the one containing "strawberries"; it is gone, so it cannot
	// match, but the search itself must still complete.
	got := searchUIDs(t, s, &imap.SearchCriteria{Body: []string{"bananas"}})
	if !equalUint32s(got, []uint32{12}) {
		t.Errorf("SEARCH BODY bananas = %v, want [12]", got)
	}
}

func TestSearchStillFailsOnARealBackendError(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	be.mu.Lock()
	be.rawErr = &backend.APIError{Kind: backend.ErrKindServer, StatusCode: 503}
	be.mu.Unlock()

	if _, err := s.Search(imapserver.NumKindUID, &imap.SearchCriteria{Body: []string{"anything"}}, &imap.SearchOptions{ReturnAll: true}); err == nil {
		t.Fatal("SEARCH succeeded against a failing backend; a 5xx must not read as 'no matches'")
	}
}
