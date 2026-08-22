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

	"github.com/crumrine/agentic-inbox/gateway/internal/backend"
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

	// Injected failures.
	authErr     error
	foldersErr  error
	messagesErr error
	rawErr      error

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

type testLogger struct{ t *testing.T }

func (l testLogger) Printf(format string, args ...interface{}) {
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
		InsecureAuth: true,
		Logger:       testLogger{t},
	})

	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()

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
