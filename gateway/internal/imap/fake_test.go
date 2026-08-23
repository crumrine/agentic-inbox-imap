// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"context"
	"io"
	"net"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-imap/v2/imapserver"

	"github.com/crumrine/agentic-inbox-imap/gateway/internal/backend"
)

const (
	testMailbox  = "user@example.com"
	testPassword = "correct-horse-battery-staple"

	// fakeMaxLimit mirrors IMAP_MESSAGES_MAX_LIMIT in the Worker
	// (workers/durableObject/index.ts): the ceiling an absent limit is
	// clamped to.
	fakeMaxLimit = 1000
)

// Raw messages used by the fake. Line endings are CRLF because that is what
// a real .eml carries and what byte offsets in a partial fetch depend on.
var (
	rawMsg5 = strings.Join([]string{
		"From: Alice Example <alice@example.com>",
		"To: user@example.com",
		"Subject: Hello world",
		"Date: Mon, 02 Jan 2006 15:04:05 -0700",
		"Message-ID: <msg-5@example.com>",
		"X-Custom: alpha",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"This is the first body, it mentions strawberries.",
		"",
	}, "\r\n")

	rawMsg9 = strings.Join([]string{
		"From: Bob Example <bob@example.com>",
		"To: user@example.com",
		"Subject: Meeting notes",
		"Date: Tue, 03 Jan 2006 09:00:00 -0700",
		"Message-ID: <msg-9@example.com>",
		"MIME-Version: 1.0",
		`Content-Type: multipart/alternative; boundary="bnd42"`,
		"",
		"--bnd42",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"plain part about pineapples",
		"--bnd42",
		"Content-Type: text/html; charset=utf-8",
		"",
		"<p>html part about pineapples</p>",
		"--bnd42--",
		"",
	}, "\r\n")

	rawMsg12 = strings.Join([]string{
		"From: Carol Example <carol@example.com>",
		"To: user@example.com",
		"Bcc: hidden@example.com",
		"Subject: Invoice 2026",
		"Date: Wed, 04 Feb 2026 12:00:00 +0000",
		"Message-ID: <msg-12@example.com>",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"bananas are due on receipt",
		"",
	}, "\r\n")
)

func mustTime(t *testing.T, layout, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(layout, value)
	if err != nil {
		t.Fatalf("parsing %q: %v", value, err)
	}
	return parsed
}

// fakeBackend is an in-memory Backend with call counters, so tests can
// assert on what the session did NOT do as well as what it did.
type fakeBackend struct {
	mu sync.Mutex

	folders  []backend.Folder
	messages map[string][]backend.Message
	raw      map[string]map[uint32]string

	// suppressContentLength makes RawMessage report an unknown body size,
	// the way a chunked response would.
	suppressContentLength bool

	// maxLimit is the server-side page ceiling. Zero means fakeMaxLimit.
	// Like the Worker, an absent or over-large caller limit is clamped to
	// it, so a caller that does not page sees only the oldest page.
	maxLimit int

	// appendCalls records every APPEND the session made.
	appendCalls []appendCall

	// dedupNext makes the next Append report a deduplicated hit rather
	// than storing anything.
	dedupNext *backend.AppendResult

	// appendWatch is the literal a test handed to APPEND. The fake samples
	// its consumption on entry, which is how buffering is detected. It is
	// watched directly rather than type-asserted off the reader the
	// backend receives, because a buffering gateway would hand over a
	// different reader entirely and the assertion would pass vacuously.
	appendWatch *trackingLiteral

	// searchFunc answers the SEARCH push-down endpoint. Nil means the
	// Worker has no such endpoint, which is what the fake reports by
	// default so every pre-existing test still exercises the local path.
	searchFunc func(criteria *backend.SearchCriteria) (*backend.SearchPage, error)

	// searchRequests records every criteria object put on the wire.
	searchRequests []*backend.SearchCriteria

	// Injected failures.
	appendErr   error
	copyErr     error
	moveErr     error
	expungeErr  error
	setFlagsErr error
	authErr     error
	foldersErr  error
	messagesErr error
	rawErr      error

	// setFlagsCalls records every batch handed to SetFlags, so tests can
	// assert on the exact add/remove pairs put on the wire.
	setFlagsCalls [][]backend.FlagUpdate

	// transferCalls and expungeCalls record what COPY, MOVE and EXPUNGE
	// asked for. expungeCalls stores a nil entry for the unrestricted form,
	// which is a different request from an empty list.
	transferCalls []transferCall
	expungeCalls  [][]uint32

	// Counters.
	authCalls     int
	foldersCalls  int
	messagesCalls int
	rawCalls      int
	rawByUID      map[uint32]int

	// Everything ever passed as a password, so a test can prove the
	// session forwarded exactly what the client sent and nothing else.
	seenPasswords []string
}

var _ Backend = (*fakeBackend)(nil)

func newFakeBackend(t *testing.T) *fakeBackend {
	t.Helper()
	return &fakeBackend{
		folders: []backend.Folder{
			{ID: "inbox", Name: "Inbox", UIDValidity: 1712345678, UIDNext: 13, Exists: 3, Unseen: 2, Recent: 0},
			{ID: "archive", Name: "Archive", UIDValidity: 1712345679, UIDNext: 1, Exists: 0, Unseen: 0, Recent: 0},
			{ID: "sent", Name: "Sent", UIDValidity: 1712345680, UIDNext: 4, Exists: 3, Unseen: 0, Recent: 0},
		},
		messages: map[string][]backend.Message{
			// Deliberately out of UID order: SELECT must sort, because
			// sequence numbers are defined by ascending UID.
			"inbox": {
				{
					UID:          12,
					Flags:        []string{"\\Flagged"},
					InternalDate: mustTime(t, time.RFC3339, "2026-02-04T12:00:00Z"),
					RFC822Size:   int64(len(rawMsg12)),
					Envelope: backend.Envelope{
						Subject:   "Invoice 2026",
						From:      []backend.Address{{Name: "Carol Example", Address: "carol@example.com"}},
						To:        []backend.Address{{Address: "user@example.com"}},
						MessageID: "<msg-12@example.com>",
						Date:      "Wed, 04 Feb 2026 12:00:00 +0000",
					},
					HasRaw: true,
				},
				{
					UID:          5,
					Flags:        []string{"\\Seen"},
					InternalDate: mustTime(t, time.RFC3339, "2006-01-02T22:04:05Z"),
					RFC822Size:   int64(len(rawMsg5)),
					Envelope: backend.Envelope{
						Subject:   "Hello world",
						From:      []backend.Address{{Name: "Alice Example", Address: "alice@example.com"}},
						To:        []backend.Address{{Address: "user@example.com"}},
						MessageID: "<msg-5@example.com>",
						Date:      "Mon, 02 Jan 2006 15:04:05 -0700",
					},
					HasRaw: true,
				},
				{
					UID:          9,
					Flags:        []string{"\\Seen", "\\Flagged", "$Important"},
					InternalDate: mustTime(t, time.RFC3339, "2006-01-03T16:00:00Z"),
					RFC822Size:   int64(len(rawMsg9)),
					Envelope: backend.Envelope{
						Subject:   "Meeting notes",
						From:      []backend.Address{{Name: "Bob Example", Address: "bob@example.com"}},
						To:        []backend.Address{{Address: "user@example.com"}},
						MessageID: "<msg-9@example.com>",
						Date:      "Tue, 03 Jan 2006 09:00:00 -0700",
					},
					HasRaw: true,
				},
			},
			"archive": {},
			"sent":    {},
		},
		raw: map[string]map[uint32]string{
			"inbox": {5: rawMsg5, 9: rawMsg9, 12: rawMsg12},
		},
		rawByUID: map[uint32]int{},
	}
}

func (f *fakeBackend) counters() (auth, folders, messages, raw int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.authCalls, f.foldersCalls, f.messagesCalls, f.rawCalls
}

func (f *fakeBackend) rawCallsFor(uid uint32) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.rawByUID[uid]
}

func (f *fakeBackend) Authenticate(ctx context.Context, mailbox, password string) (*backend.AuthResult, error) {
	f.mu.Lock()
	f.authCalls++
	f.seenPasswords = append(f.seenPasswords, password)
	err := f.authErr
	f.mu.Unlock()

	if err != nil {
		return nil, err
	}
	if mailbox != testMailbox || password != testPassword {
		return nil, &backend.APIError{Kind: backend.ErrKindAuthFailed, StatusCode: 401, Body: "invalid credentials"}
	}
	return &backend.AuthResult{Mailbox: testMailbox}, nil
}

func (f *fakeBackend) Folders(ctx context.Context, mailbox string) ([]backend.Folder, error) {
	f.mu.Lock()
	f.foldersCalls++
	err := f.foldersErr
	out := append([]backend.Folder(nil), f.folders...)
	f.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (f *fakeBackend) Messages(ctx context.Context, mailbox, folder string, opts backend.MessagesOptions) (*backend.MessagesPage, error) {
	f.mu.Lock()
	f.messagesCalls++
	err := f.messagesErr
	stored, ok := f.messages[folder]
	// Copy under the lock: deliver appends to the same slice.
	msgs := append([]backend.Message(nil), stored...)
	var uidNext uint32
	for _, folderRec := range f.folders {
		if folderRec.ID == folder {
			uidNext = folderRec.UIDNext
		}
	}
	f.mu.Unlock()

	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, &backend.APIError{Kind: backend.ErrKindNotFound, StatusCode: 404}
	}

	// Mirror the Worker: ascending UID, sinceUid inclusive, and an absent
	// or over-large limit clamped to the server ceiling rather than
	// treated as "everything". Getting this wrong in the fake is what let
	// the gateway's missing paging loop go unnoticed.
	sort.Slice(msgs, func(i, j int) bool { return msgs[i].UID < msgs[j].UID })

	limit := f.maxLimit
	if limit <= 0 {
		limit = fakeMaxLimit
	}
	if opts.Limit > 0 && opts.Limit < limit {
		limit = opts.Limit
	}

	out := make([]backend.Message, 0, limit)
	for _, m := range msgs {
		if m.UID < opts.SinceUID {
			continue
		}
		if len(out) == limit {
			break
		}
		out = append(out, m)
	}
	return &backend.MessagesPage{Messages: out, UIDNext: uidNext}, nil
}

// deliver appends a message to a folder the way the Worker would: the
// message gets the folder's next UID, and the folder's counters move.
func (f *fakeBackend) deliver(t *testing.T, folderID string, msg backend.Message, raw string) uint32 {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()

	var folder *backend.Folder
	for i := range f.folders {
		if f.folders[i].ID == folderID {
			folder = &f.folders[i]
			break
		}
	}
	if folder == nil {
		t.Fatalf("no such folder %q in the fake", folderID)
	}

	uid := folder.UIDNext
	msg.UID = uid
	if msg.RFC822Size == 0 {
		msg.RFC822Size = int64(len(raw))
	}
	f.messages[folderID] = append(f.messages[folderID], msg)
	if raw != "" {
		if f.raw[folderID] == nil {
			f.raw[folderID] = map[uint32]string{}
		}
		f.raw[folderID][uid] = raw
	}
	folder.UIDNext = uid + 1
	folder.Exists++
	if !newFlagSet(msg.Flags).has(imap.FlagSeen) {
		folder.Unseen++
	}
	return uid
}

// removeMessage drops a message from a folder without touching uidNext,
// the way a delete on the Worker side would look to the gateway.
func (f *fakeBackend) removeMessage(folderID string, uid uint32) {
	f.mu.Lock()
	defer f.mu.Unlock()
	msgs := f.messages[folderID]
	out := msgs[:0]
	for _, m := range msgs {
		if m.UID != uid {
			out = append(out, m)
		}
	}
	f.messages[folderID] = out
}

// setUIDValidity simulates a folder being recreated underneath the session.
func (f *fakeBackend) setUIDValidity(folderID string, v uint32) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := range f.folders {
		if f.folders[i].ID == folderID {
			f.folders[i].UIDValidity = v
		}
	}
}

func (f *fakeBackend) RawMessage(ctx context.Context, mailbox, folder string, uid uint32) (*backend.RawMessageReader, error) {
	f.mu.Lock()
	f.rawCalls++
	f.rawByUID[uid]++
	err := f.rawErr
	body, ok := f.raw[folder][uid]
	suppress := f.suppressContentLength
	f.mu.Unlock()

	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, &backend.APIError{Kind: backend.ErrKindNotFound, StatusCode: 404}
	}
	size := int64(len(body))
	if suppress {
		size = -1
	}
	return &backend.RawMessageReader{
		ReadCloser: io.NopCloser(strings.NewReader(body)),
		Size:       size,
	}, nil
}

// SetFlags mirrors the Worker: add then remove, per message, returning the
// complete resulting flag set. Unknown UIDs are silently omitted from the
// result, which is how a deleted message reports itself.
// Search answers the SEARCH push-down endpoint.
//
// With no searchFunc configured it reports 404, the way a Worker that never
// deployed the endpoint would, so the session must fall back to evaluating
// the whole search locally.
func (f *fakeBackend) Search(ctx context.Context, mailbox, folder string, criteria *backend.SearchCriteria) (*backend.SearchPage, error) {
	f.mu.Lock()
	f.searchRequests = append(f.searchRequests, criteria)
	fn := f.searchFunc
	f.mu.Unlock()

	if fn == nil {
		return nil, &backend.APIError{Kind: backend.ErrKindNotFound, StatusCode: 404, Body: `{"error":"Not found"}`}
	}
	return fn(criteria)
}

// searchCalls returns every criteria object the session sent to the search
// endpoint, in order.
func (f *fakeBackend) searchCalls() []*backend.SearchCriteria {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*backend.SearchCriteria(nil), f.searchRequests...)
}

func (f *fakeBackend) SetFlags(ctx context.Context, mailbox, folder string, updates []backend.FlagUpdate) ([]backend.FlagResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.setFlagsCalls = append(f.setFlagsCalls, append([]backend.FlagUpdate(nil), updates...))
	if f.setFlagsErr != nil {
		return nil, f.setFlagsErr
	}

	msgs, ok := f.messages[folder]
	if !ok {
		return nil, &backend.APIError{Kind: backend.ErrKindNotFound, StatusCode: 404}
	}

	results := make([]backend.FlagResult, 0, len(updates))
	for _, u := range updates {
		idx := -1
		for i := range msgs {
			if msgs[i].UID == u.UID {
				idx = i
				break
			}
		}
		if idx < 0 {
			continue // unknown uid: omitted, not an error
		}

		set := map[string]string{} // canonical -> as stored
		for _, existing := range msgs[idx].Flags {
			set[strings.ToLower(existing)] = existing
		}
		for _, add := range u.Add {
			set[strings.ToLower(add)] = add
		}
		for _, remove := range u.Remove {
			delete(set, strings.ToLower(remove))
		}

		flags := make([]string, 0, len(set))
		for _, v := range set {
			flags = append(flags, v)
		}
		sort.Strings(flags)

		msgs[idx].Flags = flags
		results = append(results, backend.FlagResult{UID: u.UID, Flags: flags})
	}
	f.messages[folder] = msgs
	return results, nil
}

// flagsFor reports a message's stored flags, for asserting that a STORE
// actually reached the backend.
func (f *fakeBackend) flagsFor(folderID string, uid uint32) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, m := range f.messages[folderID] {
		if m.UID == uid {
			return append([]string(nil), m.Flags...)
		}
	}
	return nil
}

// lastFlagUpdates returns the most recent batch sent to SetFlags.
func (f *fakeBackend) lastFlagUpdates() []backend.FlagUpdate {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.setFlagsCalls) == 0 {
		return nil
	}
	return f.setFlagsCalls[len(f.setFlagsCalls)-1]
}

func (f *fakeBackend) setFlagsCallCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.setFlagsCalls)
}

// transferCall records one COPY or MOVE request.
type transferCall struct {
	op          string
	folder      string
	uids        []uint32
	destination string
}

func (f *fakeBackend) transferLocked(folder, destination string, uids []uint32, remove bool) ([]backend.CopiedMessage, error) {
	msgs, ok := f.messages[folder]
	if !ok {
		return nil, &backend.APIError{Kind: backend.ErrKindNotFound, StatusCode: 404}
	}
	if _, ok := f.messages[destination]; !ok {
		return nil, &backend.APIError{Kind: backend.ErrKindNotFound, StatusCode: 404}
	}

	want := make(map[uint32]struct{}, len(uids))
	for _, uid := range uids {
		want[uid] = struct{}{}
	}

	out := make([]backend.CopiedMessage, 0, len(uids))
	kept := msgs[:0:0]
	for _, msg := range msgs {
		if _, ok := want[msg.UID]; !ok {
			kept = append(kept, msg)
			continue
		}
		src := msg
		destUID := f.copyInto(src, folder, destination)
		out = append(out, backend.CopiedMessage{SourceUID: msg.UID, DestUID: destUID})
		if !remove {
			kept = append(kept, msg)
		}
	}
	if remove {
		f.messages[folder] = kept
		f.recountLocked(folder)
	}
	// Ascending by source uid, as the endpoint returns them.
	sort.Slice(out, func(i, j int) bool { return out[i].SourceUID < out[j].SourceUID })
	return out, nil
}

// copyInto appends src to destination with a fresh UID and carries its raw
// body across.
func (f *fakeBackend) copyInto(src backend.Message, srcFolder, destination string) uint32 {
	var dest *backend.Folder
	for i := range f.folders {
		if f.folders[i].ID == destination {
			dest = &f.folders[i]
			break
		}
	}
	if dest == nil {
		return 0
	}

	uid := dest.UIDNext
	copied := src
	copied.UID = uid
	copied.Flags = append([]string(nil), src.Flags...)
	f.messages[destination] = append(f.messages[destination], copied)

	if raw, ok := f.raw[srcFolder][src.UID]; ok {
		if f.raw[destination] == nil {
			f.raw[destination] = map[uint32]string{}
		}
		f.raw[destination][uid] = raw
	}

	dest.UIDNext = uid + 1
	dest.Exists++
	return uid
}

func (f *fakeBackend) recountLocked(folderID string) {
	for i := range f.folders {
		if f.folders[i].ID != folderID {
			continue
		}
		msgs := f.messages[folderID]
		f.folders[i].Exists = uint32(len(msgs))
		var unseen uint32
		for _, m := range msgs {
			if !newFlagSet(m.Flags).has(imap.FlagSeen) {
				unseen++
			}
		}
		f.folders[i].Unseen = unseen
	}
}

func (f *fakeBackend) Copy(ctx context.Context, mailbox, folder string, uids []uint32, destination string) ([]backend.CopiedMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.transferCalls = append(f.transferCalls, transferCall{"copy", folder, append([]uint32(nil), uids...), destination})
	if f.copyErr != nil {
		return nil, f.copyErr
	}
	return f.transferLocked(folder, destination, uids, false)
}

func (f *fakeBackend) Move(ctx context.Context, mailbox, folder string, uids []uint32, destination string) ([]backend.CopiedMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.transferCalls = append(f.transferCalls, transferCall{"move", folder, append([]uint32(nil), uids...), destination})
	if f.moveErr != nil {
		return nil, f.moveErr
	}
	return f.transferLocked(folder, destination, uids, true)
}

// Expunge mirrors the Worker: a nil uids slice means every message with
// \Deleted, a non-nil one restricts it to those UIDs. Whether the removed
// message lands in Trash or is destroyed is the Worker's business and
// invisible over IMAP, so the fake just removes it from the folder.
func (f *fakeBackend) Expunge(ctx context.Context, mailbox, folder string, uids []uint32) ([]uint32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if uids == nil {
		f.expungeCalls = append(f.expungeCalls, nil)
	} else {
		f.expungeCalls = append(f.expungeCalls, append([]uint32(nil), uids...))
	}
	if f.expungeErr != nil {
		return nil, f.expungeErr
	}

	msgs, ok := f.messages[folder]
	if !ok {
		return nil, &backend.APIError{Kind: backend.ErrKindNotFound, StatusCode: 404}
	}

	var want map[uint32]struct{}
	if uids != nil {
		want = make(map[uint32]struct{}, len(uids))
		for _, uid := range uids {
			want[uid] = struct{}{}
		}
	}

	var expunged []uint32
	kept := msgs[:0:0]
	for _, msg := range msgs {
		deleted := newFlagSet(msg.Flags).has(imap.FlagDeleted)
		named := want == nil || func() bool { _, ok := want[msg.UID]; return ok }()
		if deleted && named {
			expunged = append(expunged, msg.UID)
			delete(f.raw[folder], msg.UID)
			continue
		}
		kept = append(kept, msg)
	}
	f.messages[folder] = kept
	f.recountLocked(folder)
	sort.Slice(expunged, func(i, j int) bool { return expunged[i] < expunged[j] })
	return expunged, nil
}

func (f *fakeBackend) lastExpungeRequest() (uids []uint32, called bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.expungeCalls) == 0 {
		return nil, false
	}
	return f.expungeCalls[len(f.expungeCalls)-1], true
}

func (f *fakeBackend) lastTransfer() (transferCall, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.transferCalls) == 0 {
		return transferCall{}, false
	}
	return f.transferCalls[len(f.transferCalls)-1], true
}

func (f *fakeBackend) uidsIn(folderID string) []uint32 {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]uint32, 0, len(f.messages[folderID]))
	for _, m := range f.messages[folderID] {
		out = append(out, m.UID)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// appendCall records one APPEND, including how much of the literal had
// already been consumed when the backend was handed it. That last field is
// what proves the gateway streams instead of buffering.
type appendCall struct {
	folder       string
	flags        []string
	internalDate time.Time
	size         int64
	body         string

	// consumedAtEntry is how many bytes had been read out of the watched
	// literal when the backend was called. Streaming leaves it at zero.
	consumedAtEntry int64
	// watchedReader is true when the reader handed over is the very
	// literal the test created, rather than a copy of its contents.
	watchedReader bool
	// watched is true when a literal was being watched at all, so a test
	// cannot pass by forgetting to set one up.
	watched bool
}

func (f *fakeBackend) Append(ctx context.Context, mailbox, folder string, body io.Reader, size int64, opts backend.AppendOptions) (*backend.AppendResult, error) {
	call := appendCall{
		folder:       folder,
		flags:        append([]string(nil), opts.Flags...),
		internalDate: opts.Time,
		size:         size,
	}
	f.mu.Lock()
	injected := f.appendErr
	dedup := f.dedupNext
	watch := f.appendWatch
	f.mu.Unlock()

	if watch != nil {
		call.watched = true
		call.consumedAtEntry = watch.consumed()
		call.watchedReader = body == io.Reader(watch)
	}

	if injected != nil {
		// Record before returning so a test can still see the attempt, but
		// leave the literal untouched: go-imap drains it.
		f.mu.Lock()
		f.appendCalls = append(f.appendCalls, call)
		f.mu.Unlock()
		return nil, injected
	}

	// Read the body the way a real client would: streamed, never assumed
	// to fit anywhere in particular.
	var buf strings.Builder
	if _, err := io.Copy(&buf, body); err != nil {
		return nil, err
	}
	call.body = buf.String()

	f.mu.Lock()
	defer f.mu.Unlock()
	f.appendCalls = append(f.appendCalls, call)

	if dedup != nil {
		f.dedupNext = nil
		return dedup, nil
	}

	var dest *backend.Folder
	for i := range f.folders {
		if f.folders[i].ID == folder {
			dest = &f.folders[i]
			break
		}
	}
	if dest == nil {
		return nil, &backend.APIError{Kind: backend.ErrKindNotFound, StatusCode: 404}
	}

	uid := dest.UIDNext
	msg := backend.Message{
		UID:          uid,
		Flags:        append([]string(nil), opts.Flags...),
		InternalDate: opts.Time,
		RFC822Size:   int64(len(call.body)),
		Envelope: backend.Envelope{
			Subject:   "appended",
			From:      []backend.Address{{Address: "sender@example.com"}},
			To:        []backend.Address{{Address: testMailbox}},
			MessageID: "<appended-" + itoa(int(uid)) + "@example.com>",
		},
		HasRaw: true,
	}
	if msg.InternalDate.IsZero() {
		msg.InternalDate = time.Now()
	}
	f.messages[folder] = append(f.messages[folder], msg)
	if f.raw[folder] == nil {
		f.raw[folder] = map[uint32]string{}
	}
	f.raw[folder][uid] = call.body
	dest.UIDNext = uid + 1
	dest.Exists++
	if !newFlagSet(msg.Flags).has(imap.FlagSeen) {
		dest.Unseen++
	}

	return &backend.AppendResult{UID: uid, UIDValidity: dest.UIDValidity}, nil
}

func (f *fakeBackend) lastAppend() (appendCall, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.appendCalls) == 0 {
		return appendCall{}, false
	}
	return f.appendCalls[len(f.appendCalls)-1], true
}

// trackingLiteral is an imap.LiteralReader that counts what has been read
// out of it, so a test can tell streaming from buffering.
type trackingLiteral struct {
	mu   sync.Mutex
	src  *strings.Reader
	size int64
	n    int64
}

func newTrackingLiteral(body string) *trackingLiteral {
	return &trackingLiteral{src: strings.NewReader(body), size: int64(len(body))}
}

func (l *trackingLiteral) Read(p []byte) (int, error) {
	n, err := l.src.Read(p)
	l.mu.Lock()
	l.n += int64(n)
	l.mu.Unlock()
	return n, err
}

func (l *trackingLiteral) Size() int64 { return l.size }

func (l *trackingLiteral) consumed() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.n
}

// setBodyStructure attaches a precomputed BODYSTRUCTURE to a stored
// message, the way the Worker's /messages payload now carries one.
func (f *fakeBackend) setBodyStructure(folderID string, uid uint32, node *backend.BodyStructureNode) {
	f.mu.Lock()
	defer f.mu.Unlock()
	msgs := f.messages[folderID]
	for i := range msgs {
		if msgs[i].UID == uid {
			msgs[i].BodyStructure = node
			return
		}
	}
	panic("fake: no such uid to attach a body structure to")
}

// ---------------------------------------------------------------------
// In-memory server harness
// ---------------------------------------------------------------------

// pipeListener hands out net.Pipe connections, so the tests never touch a
// real socket and never need a port.
type pipeListener struct {
	conns chan net.Conn
	done  chan struct{}
	once  sync.Once
}

type pipeAddr struct{}

func (pipeAddr) Network() string { return "pipe" }
func (pipeAddr) String() string  { return "pipe" }

func newPipeListener() *pipeListener {
	return &pipeListener{conns: make(chan net.Conn), done: make(chan struct{})}
}

func (l *pipeListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

func (l *pipeListener) Close() error {
	l.once.Do(func() { close(l.done) })
	return nil
}

func (l *pipeListener) Addr() net.Addr { return pipeAddr{} }

func (l *pipeListener) dial() (net.Conn, error) {
	server, client := net.Pipe()
	select {
	case l.conns <- server:
		return client, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

// testLogger forwards imapserver's log output to the test, and stops doing
// so once the test is over.
//
// That second half is load-bearing. go-imap serves each connection on its
// own goroutine which the harness cannot join: srv.Close() unblocks Serve
// but says nothing about the per-connection goroutines, and one of them
// will log "failed to read command: closed pipe" as it notices the
// teardown. Calling t.Logf after the test function has returned is a
// runtime panic, so this drops those late lines instead.
//
// The mutex is held across the Logf call and taken again by the disabling
// cleanup, so a log already in flight completes before the cleanup returns
// and none can start after it.
type testLogger struct {
	t    *testing.T
	mu   sync.Mutex
	done bool
}

func newTestLogger(t *testing.T) *testLogger {
	l := &testLogger{t: t}
	// Registered before any cleanup that tears down connections, so it runs
	// last: after this returns, nothing can reach t.Logf.
	t.Cleanup(func() {
		l.mu.Lock()
		l.done = true
		l.mu.Unlock()
	})
	return l
}

func (l *testLogger) Printf(format string, args ...interface{}) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.done {
		return
	}
	l.t.Logf("imapserver: "+format, args...)
}

// startTestServer runs a real imapserver backed by the session under test
// and returns a connected imapclient. This exercises the actual wire
// protocol, which is the only way to check things like BODY[HEADER.FIELDS]
// encoding or a partial range.
func startTestServer(t *testing.T, be Backend, opts ...Option) *imapclient.Client {
	t.Helper()

	ln := newPipeListener()
	srv := imapserver.New(&imapserver.Options{
		NewSession: func(conn *imapserver.Conn) (imapserver.Session, *imapserver.GreetingData, error) {
			return NewSession(be, opts...), nil, nil
		},
		Caps:         ServerCaps(),
		InsecureAuth: true,
		Logger:       newTestLogger(t),
	})

	// Serve through the same ID proxy production uses, so every test in
	// this package exercises its pass-through path as a side effect.
	// AllowCleartext is required because these are net.Pipe connections,
	// not TLS; production takes the default and rejects cleartext.
	served := make(chan error, 1)
	go func() { served <- srv.Serve(WrapListener(ln, AllowCleartext())) }()

	conn, err := ln.dial()
	if err != nil {
		t.Fatalf("dialing test listener: %v", err)
	}

	client := imapclient.New(conn, nil)
	t.Cleanup(func() {
		client.Close()
		srv.Close()
		ln.Close()
		<-served
	})
	return client
}

// loginAndSelect is the common preamble for selected-state tests.
func loginAndSelect(t *testing.T, client *imapclient.Client, mailbox string) *imap.SelectData {
	t.Helper()
	if err := client.Login(testMailbox, testPassword).Wait(); err != nil {
		t.Fatalf("LOGIN: %v", err)
	}
	data, err := client.Select(mailbox, nil).Wait()
	if err != nil {
		t.Fatalf("SELECT %s: %v", mailbox, err)
	}
	return data
}
