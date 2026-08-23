// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"strings"
	"testing"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
)

// collectFetch runs a FETCH over the real protocol and returns the buffers.
func collectFetch(t *testing.T, client *imapclient.Client, numSet imap.NumSet, options *imap.FetchOptions) []*imapclient.FetchMessageBuffer {
	t.Helper()
	msgs, err := client.Fetch(numSet, options).Collect()
	if err != nil {
		t.Fatalf("FETCH: %v", err)
	}
	return msgs
}

// TestFetchMetadataOnlyNeverTouchesRaw is the load-bearing performance
// guarantee: a client syncing a folder asks for UID/FLAGS/INTERNALDATE/
// RFC822.SIZE/ENVELOPE, and none of that may pull message bodies.
func TestFetchMetadataOnlyNeverTouchesRaw(t *testing.T) {
	be := newFakeBackend(t)
	client := startTestServer(t, be)
	loginAndSelect(t, client, "INBOX")

	msgs := collectFetch(t, client, imap.SeqSetNum(1, 2, 3), &imap.FetchOptions{
		UID:          true,
		Flags:        true,
		InternalDate: true,
		RFC822Size:   true,
		Envelope:     true,
	})
	if len(msgs) != 3 {
		t.Fatalf("got %d messages, want 3", len(msgs))
	}
	if _, _, _, raw := be.counters(); raw != 0 {
		t.Fatalf("RawMessage calls = %d, want 0 for a metadata-only FETCH", raw)
	}

	first := msgs[0]
	if first.UID != 5 {
		t.Errorf("seq 1 UID = %d, want 5", first.UID)
	}
	if first.RFC822Size != int64(len(rawMsg5)) {
		t.Errorf("RFC822.SIZE = %d, want %d", first.RFC822Size, len(rawMsg5))
	}
	if first.Envelope == nil || first.Envelope.Subject != "Hello world" {
		t.Errorf("envelope = %+v, want subject %q", first.Envelope, "Hello world")
	}
	if len(first.Envelope.From) != 1 || first.Envelope.From[0].Addr() != "alice@example.com" {
		t.Errorf("envelope From = %+v", first.Envelope.From)
	}
	if first.Envelope.MessageID != "msg-5@example.com" {
		t.Errorf("envelope Message-ID = %q, want %q (no angle brackets)", first.Envelope.MessageID, "msg-5@example.com")
	}
	if first.InternalDate.IsZero() {
		t.Error("INTERNALDATE is zero")
	}
	if !hasFlag(first.Flags, imap.FlagSeen) {
		t.Errorf("flags = %v, want \\Seen", first.Flags)
	}
}

func hasFlag(flags []imap.Flag, want imap.Flag) bool {
	for _, f := range flags {
		if strings.EqualFold(string(f), string(want)) {
			return true
		}
	}
	return false
}

// TestFetchBySequenceNumberReturnsRightUID is the mapping test. The fake
// returns messages out of UID order on purpose; a client asking for
// sequence 2 must get UID 9, not whatever the backend listed second.
func TestFetchBySequenceNumberReturnsRightUID(t *testing.T) {
	client := startTestServer(t, newFakeBackend(t))
	loginAndSelect(t, client, "INBOX")

	want := map[uint32]imap.UID{1: 5, 2: 9, 3: 12}
	for seqNum, wantUID := range want {
		msgs := collectFetch(t, client, imap.SeqSetNum(seqNum), &imap.FetchOptions{UID: true, Envelope: true})
		if len(msgs) != 1 {
			t.Fatalf("seq %d: got %d messages, want 1", seqNum, len(msgs))
		}
		if msgs[0].SeqNum != seqNum {
			t.Errorf("response seq num = %d, want %d", msgs[0].SeqNum, seqNum)
		}
		if msgs[0].UID != wantUID {
			t.Errorf("seq %d -> UID %d, want %d", seqNum, msgs[0].UID, wantUID)
		}
	}
}

func TestUIDFetchSelectsByUID(t *testing.T) {
	client := startTestServer(t, newFakeBackend(t))
	loginAndSelect(t, client, "INBOX")

	msgs, err := client.Fetch(imap.UIDSetNum(9), &imap.FetchOptions{Envelope: true}).Collect()
	if err != nil {
		t.Fatalf("UID FETCH: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("got %d messages, want 1", len(msgs))
	}
	if msgs[0].UID != 9 {
		t.Errorf("UID = %d, want 9", msgs[0].UID)
	}
	if msgs[0].SeqNum != 2 {
		t.Errorf("SeqNum = %d, want 2", msgs[0].SeqNum)
	}
	if msgs[0].Envelope.Subject != "Meeting notes" {
		t.Errorf("subject = %q", msgs[0].Envelope.Subject)
	}
}

// TestFetchBodyStructureUsesRawAndCaches covers both halves of the lazy
// raw-fetch design: BODYSTRUCTURE does download the message, and a second
// FETCH for the same UID is served from the session's LRU.
func TestFetchBodyStructureUsesRawAndCaches(t *testing.T) {
	be := newFakeBackend(t)
	client := startTestServer(t, be)
	loginAndSelect(t, client, "INBOX")

	msgs := collectFetch(t, client, imap.SeqSetNum(2), &imap.FetchOptions{
		BodyStructure: &imap.FetchItemBodyStructure{Extended: true},
	})
	if len(msgs) != 1 {
		t.Fatalf("got %d messages, want 1", len(msgs))
	}
	if _, _, _, raw := be.counters(); raw != 1 {
		t.Fatalf("RawMessage calls = %d after BODYSTRUCTURE, want 1", raw)
	}

	multi, ok := msgs[0].BodyStructure.(*imap.BodyStructureMultiPart)
	if !ok {
		t.Fatalf("body structure = %T, want *imap.BodyStructureMultiPart", msgs[0].BodyStructure)
	}
	if multi.MediaType() != "multipart/alternative" {
		t.Errorf("media type = %q, want multipart/alternative", multi.MediaType())
	}
	if len(multi.Children) != 2 {
		t.Fatalf("children = %d, want 2", len(multi.Children))
	}
	if multi.Children[0].MediaType() != "text/plain" || multi.Children[1].MediaType() != "text/html" {
		t.Errorf("child media types = %q, %q", multi.Children[0].MediaType(), multi.Children[1].MediaType())
	}

	// Second fetch of the same UID: the LRU must absorb it.
	collectFetch(t, client, imap.SeqSetNum(2), &imap.FetchOptions{
		BodySection: []*imap.FetchItemBodySection{{}},
	})
	if _, _, _, raw := be.counters(); raw != 1 {
		t.Errorf("RawMessage calls = %d after a second body fetch of the same UID, want 1 (cache miss)", raw)
	}
	if got := be.rawCallsFor(9); got != 1 {
		t.Errorf("RawMessage calls for uid 9 = %d, want 1", got)
	}
}

func TestFetchWholeBody(t *testing.T) {
	client := startTestServer(t, newFakeBackend(t))
	loginAndSelect(t, client, "INBOX")

	section := &imap.FetchItemBodySection{}
	msgs := collectFetch(t, client, imap.SeqSetNum(1), &imap.FetchOptions{
		BodySection: []*imap.FetchItemBodySection{section},
	})
	got := string(msgs[0].FindBodySection(section))
	if got != rawMsg5 {
		t.Errorf("BODY[] = %q\nwant %q", got, rawMsg5)
	}
}

func TestFetchBodyHeaderAndText(t *testing.T) {
	client := startTestServer(t, newFakeBackend(t))
	loginAndSelect(t, client, "INBOX")

	header := &imap.FetchItemBodySection{Specifier: imap.PartSpecifierHeader}
	text := &imap.FetchItemBodySection{Specifier: imap.PartSpecifierText}
	msgs := collectFetch(t, client, imap.SeqSetNum(1), &imap.FetchOptions{
		BodySection: []*imap.FetchItemBodySection{header, text},
	})

	gotHeader := string(msgs[0].FindBodySection(header))
	if !strings.Contains(gotHeader, "Subject: Hello world") {
		t.Errorf("BODY[HEADER] = %q, missing the Subject field", gotHeader)
	}
	if strings.Contains(gotHeader, "strawberries") {
		t.Errorf("BODY[HEADER] = %q, must not include the body", gotHeader)
	}

	gotText := string(msgs[0].FindBodySection(text))
	wantText := "This is the first body, it mentions strawberries.\r\n"
	if gotText != wantText {
		t.Errorf("BODY[TEXT] = %q, want %q", gotText, wantText)
	}
}

// TestFetchHeaderFieldsFiltersHeaders checks that BODY[HEADER.FIELDS (...)]
// returns the requested fields and nothing else.
func TestFetchHeaderFieldsFiltersHeaders(t *testing.T) {
	client := startTestServer(t, newFakeBackend(t))
	loginAndSelect(t, client, "INBOX")

	// Deliberately lower case: header field names are case-insensitive.
	section := &imap.FetchItemBodySection{
		Specifier:    imap.PartSpecifierHeader,
		HeaderFields: []string{"subject", "from"},
	}
	msgs := collectFetch(t, client, imap.SeqSetNum(1), &imap.FetchOptions{
		BodySection: []*imap.FetchItemBodySection{section},
	})

	got := string(msgs[0].FindBodySection(section))
	for _, want := range []string{"From: Alice Example <alice@example.com>", "Subject: Hello world"} {
		if !strings.Contains(got, want) {
			t.Errorf("BODY[HEADER.FIELDS (SUBJECT FROM)] = %q, missing %q", got, want)
		}
	}
	for _, unwanted := range []string{"X-Custom", "Message-ID", "Content-Type", "To:", "Date:"} {
		if strings.Contains(got, unwanted) {
			t.Errorf("BODY[HEADER.FIELDS (SUBJECT FROM)] = %q, leaked %q", got, unwanted)
		}
	}
	if !strings.HasSuffix(got, "\r\n\r\n") {
		t.Errorf("BODY[HEADER.FIELDS (...)] = %q, must end with a blank line", got)
	}
}

func TestFetchHeaderFieldsNot(t *testing.T) {
	client := startTestServer(t, newFakeBackend(t))
	loginAndSelect(t, client, "INBOX")

	section := &imap.FetchItemBodySection{
		Specifier:       imap.PartSpecifierHeader,
		HeaderFieldsNot: []string{"X-Custom"},
	}
	msgs := collectFetch(t, client, imap.SeqSetNum(1), &imap.FetchOptions{
		BodySection: []*imap.FetchItemBodySection{section},
	})
	got := string(msgs[0].FindBodySection(section))
	if strings.Contains(got, "X-Custom") {
		t.Errorf("BODY[HEADER.FIELDS.NOT (X-Custom)] = %q, still contains X-Custom", got)
	}
	if !strings.Contains(got, "Subject: Hello world") {
		t.Errorf("BODY[HEADER.FIELDS.NOT (X-Custom)] = %q, dropped Subject", got)
	}
}

// TestFetchPartialRange covers the <n.m> byte range, including a range that
// runs past the end of the section.
func TestFetchPartialRange(t *testing.T) {
	const body = "This is the first body, it mentions strawberries.\r\n"

	tests := []struct {
		name   string
		offset int64
		size   int64
		want   string
	}{
		{"prefix", 0, 4, body[0:4]},
		{"middle", 5, 2, body[5:7]},
		{"past the end is truncated", 40, 1000, body[40:]},
		{"offset beyond the section is empty", int64(len(body)) + 10, 5, ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client := startTestServer(t, newFakeBackend(t))
			loginAndSelect(t, client, "INBOX")

			section := &imap.FetchItemBodySection{
				Specifier: imap.PartSpecifierText,
				Partial:   &imap.SectionPartial{Offset: tc.offset, Size: tc.size},
			}
			msgs := collectFetch(t, client, imap.SeqSetNum(1), &imap.FetchOptions{
				BodySection: []*imap.FetchItemBodySection{section},
			})
			got := string(msgs[0].FindBodySection(section))
			if got != tc.want {
				t.Errorf("BODY[TEXT]<%d.%d> = %q, want %q", tc.offset, tc.size, got, tc.want)
			}
		})
	}
}

func TestFetchSubPart(t *testing.T) {
	client := startTestServer(t, newFakeBackend(t))
	loginAndSelect(t, client, "INBOX")

	section := &imap.FetchItemBodySection{Part: []int{1}}
	msgs := collectFetch(t, client, imap.SeqSetNum(2), &imap.FetchOptions{
		BodySection: []*imap.FetchItemBodySection{section},
	})
	got := string(msgs[0].FindBodySection(section))
	if !strings.Contains(got, "plain part about pineapples") {
		t.Errorf("BODY[1] = %q, want the text/plain part", got)
	}
	if strings.Contains(got, "html part") {
		t.Errorf("BODY[1] = %q, leaked the html part", got)
	}
}

// TestFetchMixedItemsFetchesRawOnce proves the raw download is per message,
// not per requested item.
func TestFetchMixedItemsFetchesRawOnce(t *testing.T) {
	be := newFakeBackend(t)
	client := startTestServer(t, be)
	loginAndSelect(t, client, "INBOX")

	header := &imap.FetchItemBodySection{Specifier: imap.PartSpecifierHeader}
	text := &imap.FetchItemBodySection{Specifier: imap.PartSpecifierText}
	collectFetch(t, client, imap.SeqSetNum(1), &imap.FetchOptions{
		UID:           true,
		Envelope:      true,
		BodyStructure: &imap.FetchItemBodyStructure{Extended: true},
		BodySection:   []*imap.FetchItemBodySection{header, text},
	})
	if got := be.rawCallsFor(5); got != 1 {
		t.Errorf("RawMessage calls for uid 5 = %d, want 1", got)
	}
}

// TestListReportsFolders covers the LIST mapping from the folders payload.
func TestListReportsFolders(t *testing.T) {
	client := startTestServer(t, newFakeBackend(t))
	if err := client.Login(testMailbox, testPassword).Wait(); err != nil {
		t.Fatalf("LOGIN: %v", err)
	}

	entries, err := client.List("", "*", nil).Collect()
	if err != nil {
		t.Fatalf("LIST: %v", err)
	}
	got := make(map[string]rune, len(entries))
	for _, e := range entries {
		got[e.Mailbox] = e.Delim
	}
	// "Inbox" in the backend must surface as IMAP's mandatory "INBOX".
	for _, want := range []string{"INBOX", "Archive", "Sent"} {
		delim, ok := got[want]
		if !ok {
			t.Errorf("LIST is missing %q; got %v", want, got)
			continue
		}
		if delim != '/' {
			t.Errorf("%s delimiter = %q, want '/'", want, delim)
		}
	}
	if len(got) != 3 {
		t.Errorf("LIST returned %d mailboxes, want 3: %v", len(got), got)
	}
}

func TestListPatternMatching(t *testing.T) {
	client := startTestServer(t, newFakeBackend(t))
	if err := client.Login(testMailbox, testPassword).Wait(); err != nil {
		t.Fatalf("LOGIN: %v", err)
	}

	entries, err := client.List("", "A*", nil).Collect()
	if err != nil {
		t.Fatalf("LIST: %v", err)
	}
	if len(entries) != 1 || entries[0].Mailbox != "Archive" {
		t.Errorf("LIST \"\" \"A*\" = %+v, want just Archive", entries)
	}
}

func TestStatusOverTheWire(t *testing.T) {
	client := startTestServer(t, newFakeBackend(t))
	if err := client.Login(testMailbox, testPassword).Wait(); err != nil {
		t.Fatalf("LOGIN: %v", err)
	}

	// Ask for every item the encoder dereferences a pointer for; a nil
	// would panic the server rather than fail this call.
	data, err := client.Status("INBOX", &imap.StatusOptions{
		NumMessages: true,
		NumUnseen:   true,
		NumDeleted:  true,
		UIDNext:     true,
		UIDValidity: true,
		Size:        true,
	}).Wait()
	if err != nil {
		t.Fatalf("STATUS: %v", err)
	}
	if data.NumMessages == nil || *data.NumMessages != 3 {
		t.Errorf("MESSAGES = %v, want 3", data.NumMessages)
	}
	if data.UIDValidity != 1712345678 {
		t.Errorf("UIDVALIDITY = %d", data.UIDValidity)
	}
}

// TestWriteCommandsAnswerNoAndKeepTheConnection walks the out-of-scope
// commands over the real protocol: each must produce a tagged NO, and the
// connection must stay usable afterwards. A panic or a desynchronised
// literal would show up here as a broken follow-up command.
func TestWriteCommandsAnswerNoAndKeepTheConnection(t *testing.T) {
	client := startTestServer(t, newFakeBackend(t))
	loginAndSelect(t, client, "INBOX")

	checks := []struct {
		name string
		run  func() error
	}{
		{"CREATE", func() error { return client.Create("New", nil).Wait() }},
		{"DELETE", func() error { return client.Delete("Archive").Wait() }},
		{"RENAME", func() error { return client.Rename("Archive", "Old", nil).Wait() }},
		{"SUBSCRIBE", func() error { return client.Subscribe("Archive").Wait() }},
		{"UNSUBSCRIBE", func() error { return client.Unsubscribe("Archive").Wait() }},
		{"APPEND", func() error {
			const body = "Subject: nope\r\n\r\nbody\r\n"
			cmd := client.Append("INBOX", int64(len(body)), nil)
			if _, err := cmd.Write([]byte(body)); err != nil {
				return err
			}
			if err := cmd.Close(); err != nil {
				return err
			}
			_, err := cmd.Wait()
			return err
		}},
	}

	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			if err := check.run(); err == nil {
				t.Fatalf("%s succeeded, want NO", check.name)
			}
			// The connection must survive the refusal.
			if err := client.Noop().Wait(); err != nil {
				t.Fatalf("NOOP after %s failed, connection is broken: %v", check.name, err)
			}
		})
	}
}

// TestExpungeWithNothingMarkedReportsNothing: a bare EXPUNGE over a
// mailbox where nothing carries \Deleted must succeed and report no
// removals, rather than erroring or inventing one.
func TestExpungeWithNothingMarkedReportsNothing(t *testing.T) {
	client := startTestServer(t, newFakeBackend(t))
	loginAndSelect(t, client, "INBOX")

	seqNums, err := client.Expunge().Collect()
	if err != nil {
		t.Fatalf("EXPUNGE: %v", err)
	}
	if len(seqNums) != 0 {
		t.Errorf("EXPUNGE reported %v expunged, want none", seqNums)
	}
}

// TestExpungeOverTheWireReportsSequenceNumbers is the same path with
// something actually marked, driven by go-imap's own client so the
// untagged responses are parsed rather than string-matched.
func TestExpungeOverTheWireReportsSequenceNumbers(t *testing.T) {
	be := newFakeBackend(t)
	client := startTestServer(t, be)
	loginAndSelect(t, client, "INBOX")

	if _, err := client.Store(imap.UIDSetNum(9), &imap.StoreFlags{
		Op:     imap.StoreFlagsAdd,
		Silent: true,
		Flags:  []imap.Flag{imap.FlagDeleted},
	}, nil).Collect(); err != nil {
		t.Fatalf("STORE: %v", err)
	}

	seqNums, err := client.Expunge().Collect()
	if err != nil {
		t.Fatalf("EXPUNGE: %v", err)
	}
	if len(seqNums) != 1 || seqNums[0] != 2 {
		t.Fatalf("EXPUNGE reported %v, want [2]", seqNums)
	}

	// The client's own view has renumbered; ours must match it.
	msgs, err := client.Fetch(imap.SeqSetNum(2), &imap.FetchOptions{UID: true}).Collect()
	if err != nil {
		t.Fatalf("FETCH: %v", err)
	}
	if len(msgs) != 1 || msgs[0].UID != 12 {
		t.Errorf("sequence 2 after the expunge = %+v, want UID 12", msgs)
	}
}

func TestUnselectAndReselect(t *testing.T) {
	client := startTestServer(t, newFakeBackend(t))
	loginAndSelect(t, client, "INBOX")

	if err := client.Unselect().Wait(); err != nil {
		t.Fatalf("UNSELECT: %v", err)
	}
	data, err := client.Select("Sent", nil).Wait()
	if err != nil {
		t.Fatalf("SELECT Sent: %v", err)
	}
	if data.NumMessages != 0 {
		t.Errorf("Sent NumMessages = %d, want 0", data.NumMessages)
	}
	if data.UIDValidity != 1712345680 {
		t.Errorf("Sent UIDVALIDITY = %d, want 1712345680", data.UIDValidity)
	}
}

func TestLogout(t *testing.T) {
	client := startTestServer(t, newFakeBackend(t))
	if err := client.Login(testMailbox, testPassword).Wait(); err != nil {
		t.Fatalf("LOGIN: %v", err)
	}
	if err := client.Logout().Wait(); err != nil {
		t.Fatalf("LOGOUT: %v", err)
	}
}
