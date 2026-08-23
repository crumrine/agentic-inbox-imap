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

	"github.com/crumrine/agentic-inbox/gateway/internal/backend"
)

const appendBody = "From: me@example.com\r\n" +
	"To: user@example.com\r\n" +
	"Subject: a saved draft\r\n" +
	"Message-ID: <draft-1@example.com>\r\n" +
	"Content-Type: text/plain; charset=utf-8\r\n" +
	"\r\n" +
	"half written thought\r\n"

func TestAppendReturnsAppendUID(t *testing.T) {
	be := newFakeBackend(t)
	s := newLoggedInSession(t, be)

	data, err := s.Append("Archive", newTrackingLiteral(appendBody), nil)
	if err != nil {
		t.Fatalf("APPEND: %v", err)
	}
	if data == nil {
		t.Fatal("APPEND returned no data, so go-imap cannot emit APPENDUID")
	}
	// Archive starts empty with uidNext 1 and uidValidity 1712345679.
	if data.UID != 1 {
		t.Errorf("UID = %d, want 1", data.UID)
	}
	if data.UIDValidity != 1712345679 {
		t.Errorf("UIDVALIDITY = %d, want the destination folder's", data.UIDValidity)
	}

	call, ok := be.lastAppend()
	if !ok {
		t.Fatal("the backend was never called")
	}
	if call.folder != "archive" {
		t.Errorf("folder = %q, want the folder id", call.folder)
	}
	if call.body != appendBody {
		t.Errorf("body = %q, want it byte-for-byte", call.body)
	}
	if call.size != int64(len(appendBody)) {
		t.Errorf("size = %d, want %d", call.size, len(appendBody))
	}
}

func TestAppendPassesFlagsAndInternalDate(t *testing.T) {
	be := newFakeBackend(t)
	s := newLoggedInSession(t, be)

	when := time.Date(2026, 8, 22, 22, 5, 3, 0, time.UTC)
	_, err := s.Append("Archive", newTrackingLiteral(appendBody), &imap.AppendOptions{
		Flags: []imap.Flag{imap.FlagSeen, imap.FlagDraft},
		Time:  when,
	})
	if err != nil {
		t.Fatalf("APPEND: %v", err)
	}

	call, _ := be.lastAppend()
	if !equalStrings(call.flags, []string{`\Seen`, `\Draft`}) {
		t.Errorf("flags = %v, want [\\Seen \\Draft]", call.flags)
	}
	if !call.internalDate.Equal(when) {
		t.Errorf("internalDate = %v, want %v", call.internalDate, when)
	}
}

// TestAppendKeepsDraftButDropsRecent pins the deliberate asymmetry with
// STORE. A STORE cannot change what kind of message something is, so it
// ignores \Draft; an APPEND is creating the message, so the client's
// \Draft is exactly the information the Worker needs.
func TestAppendKeepsDraftButDropsRecent(t *testing.T) {
	be := newFakeBackend(t)
	s := newLoggedInSession(t, be)

	_, err := s.Append("Archive", newTrackingLiteral(appendBody), &imap.AppendOptions{
		Flags: []imap.Flag{imap.FlagDraft, flagRecent, imap.FlagSeen, `\draft`},
	})
	if err != nil {
		t.Fatalf("APPEND: %v", err)
	}
	call, _ := be.lastAppend()
	if !equalStrings(call.flags, []string{`\Draft`, `\Seen`}) {
		t.Errorf("flags = %v, want [\\Draft \\Seen]: \\Recent dropped, duplicates collapsed", call.flags)
	}
}

// TestAppendStreamsWithoutBuffering is the memory-safety guarantee. If the
// session read the literal into memory first, the backend would be handed
// an already-drained reader; streaming means nothing has been consumed when
// the request starts.
func TestAppendStreamsWithoutBuffering(t *testing.T) {
	be := newFakeBackend(t)
	s := newLoggedInSession(t, be)

	// Large enough that buffering would be an obvious allocation.
	big := strings.Repeat("x", 4<<20)
	lit := newTrackingLiteral(big)
	be.mu.Lock()
	be.appendWatch = lit
	be.mu.Unlock()

	if _, err := s.Append("Archive", lit, nil); err != nil {
		t.Fatalf("APPEND: %v", err)
	}

	call, _ := be.lastAppend()
	if !call.watched {
		t.Fatal("the fake was not watching the literal, so this test proves nothing")
	}
	if call.consumedAtEntry != 0 {
		t.Errorf("%d bytes of the literal were already read when the backend was called; the body is being buffered",
			call.consumedAtEntry)
	}
	if !call.watchedReader {
		t.Error("the backend was handed a different reader than the literal; the body is being copied rather than streamed")
	}
	if lit.consumed() != int64(len(big)) {
		t.Errorf("literal consumed %d bytes, want all %d", lit.consumed(), len(big))
	}
	if call.size != int64(len(big)) {
		t.Errorf("size = %d, want %d", call.size, len(big))
	}
}

// TestAppendDeduplicationSurfacesTheExistingUID: clients APPEND a Sent copy
// after submission and the app records its own, so the Worker returns the
// message that already exists rather than writing a second one. The UID it
// returns is the one the client must be told about.
func TestAppendDeduplicationSurfacesTheExistingUID(t *testing.T) {
	be := newFakeBackend(t)
	be.mu.Lock()
	be.dedupNext = &backend.AppendResult{UID: 42, UIDValidity: 1712345680, Deduplicated: true}
	be.mu.Unlock()

	s := newLoggedInSession(t, be)
	data, err := s.Append("Sent", newTrackingLiteral(appendBody), nil)
	if err != nil {
		t.Fatalf("APPEND: %v", err)
	}
	if data.UID != 42 || data.UIDValidity != 1712345680 {
		t.Errorf("APPENDUID = %+v, want the existing message's uid 42", data)
	}
	// Nothing new was stored.
	if got := be.uidsIn("sent"); len(got) != 0 {
		t.Errorf("sent folder = %v, want no new message written", got)
	}
}

func TestAppendToMissingMailboxSaysTryCreate(t *testing.T) {
	s := newLoggedInSession(t, newFakeBackend(t))

	_, err := s.Append("NoSuchFolder", newTrackingLiteral(appendBody), nil)
	var imapErr *imap.Error
	if !errors.As(err, &imapErr) {
		t.Fatalf("err = %#v, want *imap.Error", err)
	}
	if imapErr.Code != imap.ResponseCodeTryCreate {
		t.Errorf("err = %v, want NO [TRYCREATE]", imapErr)
	}
}

func TestAppendBackendFailureIsACleanIMAPError(t *testing.T) {
	be := newFakeBackend(t)
	be.mu.Lock()
	be.appendErr = &backend.APIError{Kind: backend.ErrKindServer, StatusCode: 503, Body: "upstream https://inbox.internal down"}
	be.mu.Unlock()

	s := newLoggedInSession(t, be)
	_, err := s.Append("Archive", newTrackingLiteral(appendBody), nil)
	if err == nil {
		t.Fatal("APPEND succeeded against a failing backend")
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
}

func TestAppendRequiresAuthentication(t *testing.T) {
	s := NewSession(newFakeBackend(t))
	if _, err := s.Append("Archive", newTrackingLiteral(appendBody), nil); err != errNotAuthenticated {
		t.Errorf("err = %#v, want errNotAuthenticated", err)
	}
}

func TestAppendNilLiteralIsAClientBug(t *testing.T) {
	s := newLoggedInSession(t, newFakeBackend(t))
	_, err := s.Append("Archive", nil, nil)
	var imapErr *imap.Error
	if !errors.As(err, &imapErr) || imapErr.Type != imap.StatusResponseTypeBad {
		t.Errorf("err = %#v, want a BAD", err)
	}
}

func TestAppendLimitMatchesTheFetchCap(t *testing.T) {
	s := NewSession(newFakeBackend(t))
	if got, want := s.AppendLimit(), uint32(DefaultMaxMessageBytes); got != want {
		t.Errorf("AppendLimit = %d, want %d: what can be appended must also be fetchable", got, want)
	}

	custom := NewSession(newFakeBackend(t), WithMaxAppendBytes(1024))
	if got := custom.AppendLimit(); got != 1024 {
		t.Errorf("AppendLimit = %d, want 1024", got)
	}
}

// TestAppendIntoSelectedFolderBecomesVisible covers the visibility
// decision: the snapshot is not grown directly, but the interval floor is
// cleared so the Poll go-imap runs straight after APPEND does real work.
func TestAppendIntoSelectedFolderBecomesVisible(t *testing.T) {
	be := newFakeBackend(t)
	// A long poll interval, so only the floor being cleared can make the
	// following poll do anything.
	s := newSelectedSession(t, be, WithPollInterval(time.Hour))

	if _, err := s.Append("INBOX", newTrackingLiteral(appendBody), nil); err != nil {
		t.Fatalf("APPEND: %v", err)
	}

	w := &recordingUpdateWriter{}
	if err := s.poll(t.Context(), w); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if len(w.exists) != 1 || w.exists[0] != 4 {
		t.Fatalf("EXISTS = %v, want [4] straight after the append", w.exists)
	}
	if got := snapshotUIDs(t, s); !equalUint32s(got, []uint32{5, 9, 12, 13}) {
		t.Errorf("snapshot = %v, want the appended message at the tail", got)
	}
}

// TestAppendIntoAnotherFolderLeavesTheFloorAlone: only an append into the
// selected folder is worth interrupting the throttle for.
func TestAppendIntoAnotherFolderLeavesTheFloorAlone(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(time.Hour))

	_, foldersBefore, _, _ := be.counters()
	if _, err := s.Append("Archive", newTrackingLiteral(appendBody), nil); err != nil {
		t.Fatalf("APPEND: %v", err)
	}

	w := &recordingUpdateWriter{}
	if err := s.poll(t.Context(), w); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if len(w.exists) != 0 {
		t.Errorf("EXISTS = %v, want none: the append went elsewhere", w.exists)
	}
	// The append itself resolves the destination, so one folders call is
	// expected; the poll must not have added another.
	if _, folders, _, _ := be.counters(); folders != foldersBefore+1 {
		t.Errorf("Folders calls = %d, want %d", folders, foldersBefore+1)
	}
}

// ---------------------------------------------------------------------
// Protocol level
// ---------------------------------------------------------------------

func TestCapabilityAdvertisesAppendLimit(t *testing.T) {
	c := startRawClient(t, newFakeBackend(t))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))

	lines := c.do("CAPABILITY")
	requireOK(t, lines)
	want := "APPENDLIMIT=" + itoa(int(DefaultMaxAppendBytes))
	if !strings.Contains(strings.Join(lines, "\n"), want) {
		t.Errorf("CAPABILITY = %q, want %q", lines, want)
	}
}

// TestAppendOverTheWire is the whole path: send a real message as a
// literal, get APPENDUID back, then select the folder and read it out
// again.
func TestAppendOverTheWire(t *testing.T) {
	be := newFakeBackend(t)
	c := startRawClient(t, be, WithPollInterval(0))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))

	c.seq++
	tag := "t" + itoa(c.seq)
	cmd := tag + ` APPEND Archive (\Seen \Draft) {` + itoa(len(appendBody)) + "}\r\n"
	if _, err := c.conn.Write([]byte(cmd)); err != nil {
		t.Fatalf("writing APPEND: %v", err)
	}
	if cont := c.readLine(); !strings.HasPrefix(cont, "+ ") {
		t.Fatalf("expected a continuation request, got %q", cont)
	}
	if _, err := c.conn.Write([]byte(appendBody + "\r\n")); err != nil {
		t.Fatalf("writing the literal: %v", err)
	}

	final := c.readLine()
	if !strings.Contains(final, " OK") {
		t.Fatalf("APPEND = %q, want OK", final)
	}
	if !strings.Contains(final, "[APPENDUID 1712345679 1]") {
		t.Errorf("APPEND = %q, want an APPENDUID response code", final)
	}

	// Read it back out of the folder it landed in.
	requireOK(t, c.do("SELECT Archive"))
	fetch := c.do("UID FETCH 1 (UID FLAGS BODY.PEEK[])")
	requireOK(t, fetch)
	joined := strings.Join(fetch, "\n")
	for _, want := range []string{"UID 1", `\Seen`, `\Draft`, "half written thought", "Subject: a saved draft"} {
		if !strings.Contains(joined, want) {
			t.Errorf("FETCH after APPEND = %q, missing %q", joined, want)
		}
	}

	requireOK(t, c.do("NOOP"))
}

// TestAppendFailureKeepsTheConnectionUsable: the literal is on the wire
// whatever happens, so a refused APPEND must not desynchronise the stream.
func TestAppendFailureKeepsTheConnectionUsable(t *testing.T) {
	be := newFakeBackend(t)
	c := startRawClient(t, be, WithPollInterval(0))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))

	for _, tc := range []struct {
		name   string
		target string
		setup  func()
	}{
		{"unknown mailbox", "NoSuchFolder", func() {}},
		{"backend failure", "Archive", func() {
			be.mu.Lock()
			be.appendErr = &backend.APIError{Kind: backend.ErrKindServer, StatusCode: 503}
			be.mu.Unlock()
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.setup()

			c.seq++
			tag := "t" + itoa(c.seq)
			cmd := tag + " APPEND " + tc.target + " {" + itoa(len(appendBody)) + "}\r\n"
			if _, err := c.conn.Write([]byte(cmd)); err != nil {
				t.Fatalf("writing APPEND: %v", err)
			}
			if cont := c.readLine(); !strings.HasPrefix(cont, "+ ") {
				t.Fatalf("expected a continuation request, got %q", cont)
			}
			if _, err := c.conn.Write([]byte(appendBody + "\r\n")); err != nil {
				t.Fatalf("writing the literal: %v", err)
			}
			final := c.readLine()
			if !strings.Contains(final, " NO") {
				t.Fatalf("APPEND = %q, want NO", final)
			}

			// The whole literal must have been consumed, or this NOOP
			// would be parsed out of the leftover message body.
			requireOK(t, c.do("NOOP"))
		})
	}

	be.mu.Lock()
	be.appendErr = nil
	be.mu.Unlock()
	requireOK(t, c.do("LIST \"\" \"*\""))
}

// TestAppendOversizeIsRefusedBeforeTheUpload: AppendLimit lets go-imap
// reject a too-large literal without accepting a byte of it.
func TestAppendOversizeIsRefusedBeforeTheUpload(t *testing.T) {
	be := newFakeBackend(t)
	c := startRawClient(t, be, WithMaxAppendBytes(1024))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))

	c.seq++
	tag := "t" + itoa(c.seq)
	if _, err := c.conn.Write([]byte(tag + " APPEND Archive {99999}\r\n")); err != nil {
		t.Fatalf("writing APPEND: %v", err)
	}
	final := c.readLine()
	if !strings.Contains(final, " NO") {
		t.Fatalf("oversize APPEND = %q, want NO", final)
	}
	if !strings.Contains(final, "TOOBIG") {
		t.Errorf("oversize APPEND = %q, want a TOOBIG response code", final)
	}
	// No continuation was sent, so nothing was uploaded.
	if _, called := be.lastAppend(); called {
		t.Error("the backend was called for an oversize APPEND")
	}
	requireOK(t, c.do("NOOP"))
}
