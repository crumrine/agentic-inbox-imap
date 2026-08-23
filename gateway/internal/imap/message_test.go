// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"

	"github.com/crumrine/agentic-inbox-imap/gateway/internal/backend"
)

func TestImapFlagsNormalisation(t *testing.T) {
	tests := []struct {
		name string
		in   []string
		want []imap.Flag
	}{
		{"canonical", []string{"\\Seen", "\\Flagged"}, []imap.Flag{imap.FlagSeen, imap.FlagFlagged}},
		{"lower case with backslash", []string{"\\seen"}, []imap.Flag{imap.FlagSeen}},
		{"bare name", []string{"seen", "Answered"}, []imap.Flag{imap.FlagSeen, imap.FlagAnswered}},
		{"keyword passes through", []string{"$Important", "custom-tag"}, []imap.Flag{imap.Flag("$Important"), imap.Flag("custom-tag")}},
		{"duplicates collapse", []string{"\\Seen", "seen", "\\SEEN"}, []imap.Flag{imap.FlagSeen}},
		{"recent is dropped", []string{"\\Recent", "\\Seen"}, []imap.Flag{imap.FlagSeen}},
		{"blank is dropped", []string{"", "   ", "\\Seen"}, []imap.Flag{imap.FlagSeen}},
		{"none", nil, []imap.Flag{}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := imapFlags(tc.in)
			if len(got) != len(tc.want) {
				t.Fatalf("flags = %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("flags = %v, want %v", got, tc.want)
					break
				}
			}
		})
	}
}

func TestFlagSetIsCaseInsensitive(t *testing.T) {
	fs := newFlagSet([]string{"\\Seen", "$Important"})
	for _, f := range []imap.Flag{imap.FlagSeen, imap.Flag("\\seen"), imap.Flag("$important")} {
		if !fs.has(f) {
			t.Errorf("flagSet.has(%q) = false, want true", f)
		}
	}
	if fs.has(imap.FlagDeleted) {
		t.Error("flagSet reports \\Deleted, which was never set")
	}
}

func TestEnvelopeFromMetadata(t *testing.T) {
	msg := &backend.Message{
		Envelope: backend.Envelope{
			Subject:   "Hello world",
			From:      []backend.Address{{Name: "Alice Example", Address: "alice@example.com"}},
			To:        []backend.Address{{Address: "user@example.com"}, {Name: "Broken", Address: "no-at-sign"}},
			Cc:        []backend.Address{{Name: "Carol", Address: "carol@example.com"}},
			MessageID: "<msg-5@example.com>",
			InReplyTo: "<parent@example.com>",
			Date:      "Mon, 02 Jan 2006 15:04:05 -0700",
		},
	}
	env := envelopeFrom(msg)

	if env.Subject != "Hello world" {
		t.Errorf("Subject = %q", env.Subject)
	}
	// Angle brackets must be stripped: go-imap's encoder adds them back.
	if env.MessageID != "msg-5@example.com" {
		t.Errorf("MessageID = %q, want it without angle brackets", env.MessageID)
	}
	if len(env.InReplyTo) != 1 || env.InReplyTo[0] != "parent@example.com" {
		t.Errorf("InReplyTo = %v", env.InReplyTo)
	}
	if len(env.From) != 1 || env.From[0].Mailbox != "alice" || env.From[0].Host != "example.com" || env.From[0].Name != "Alice Example" {
		t.Errorf("From = %+v", env.From)
	}
	// An address with no host cannot be represented; it is dropped rather
	// than emitted as a malformed envelope address.
	if len(env.To) != 1 || env.To[0].Addr() != "user@example.com" {
		t.Errorf("To = %+v, want just the well-formed address", env.To)
	}
	if len(env.Cc) != 1 || env.Cc[0].Addr() != "carol@example.com" {
		t.Errorf("Cc = %+v", env.Cc)
	}
	want := time.Date(2006, 1, 2, 15, 4, 5, 0, time.FixedZone("", -7*3600))
	if !env.Date.Equal(want) {
		t.Errorf("Date = %v, want %v", env.Date, want)
	}
}

func TestEnvelopeFromMetadataWithUnparseableDate(t *testing.T) {
	msg := &backend.Message{Envelope: backend.Envelope{Date: "not a date"}}
	if got := envelopeFrom(msg); !got.Date.IsZero() {
		t.Errorf("Date = %v, want the zero time so the encoder writes NIL", got.Date)
	}
}

func TestParseDateAcceptsRFC3339(t *testing.T) {
	got, ok := parseDate("2026-02-04T12:00:00Z")
	if !ok {
		t.Fatal("RFC 3339 date was rejected")
	}
	if !got.Equal(time.Date(2026, 2, 4, 12, 0, 0, 0, time.UTC)) {
		t.Errorf("date = %v", got)
	}
}

func TestFolderNameMapping(t *testing.T) {
	inbox := backend.Folder{ID: "inbox", Name: "Inbox"}
	if got := folderIMAPName(&inbox); got != "INBOX" {
		t.Errorf("folderIMAPName = %q, want INBOX", got)
	}
	if got := folderKey(&inbox); got != "inbox" {
		t.Errorf("folderKey = %q, want the folder id", got)
	}
	noID := backend.Folder{Name: "Archive"}
	if got := folderKey(&noID); got != "Archive" {
		t.Errorf("folderKey with no id = %q, want the name", got)
	}
	if !mailboxNameEqual("INBOX", "inbox") {
		t.Error("INBOX must compare case-insensitively")
	}
	if mailboxNameEqual("Archive", "archive") {
		t.Error("non-INBOX names must compare case-sensitively")
	}
}

func TestFetchNeedsRaw(t *testing.T) {
	tests := []struct {
		name    string
		options imap.FetchOptions
		want    bool
	}{
		{"metadata only", imap.FetchOptions{UID: true, Flags: true, InternalDate: true, RFC822Size: true, Envelope: true}, false},
		// BODYSTRUCTURE is deliberately absent from this decision. Whether
		// it needs the message depends on the Worker having precomputed
		// one, which only the MessageStore knows; Fetch asks it rather
		// than pre-emptively downloading.
		{"body structure alone does not force a raw fetch", imap.FetchOptions{BodyStructure: &imap.FetchItemBodyStructure{}}, false},
		{"body section", imap.FetchOptions{BodySection: []*imap.FetchItemBodySection{{}}}, true},
		{"binary section", imap.FetchOptions{BinarySection: []*imap.FetchItemBinarySection{{}}}, true},
		{"binary size", imap.FetchOptions{BinarySectionSize: []*imap.FetchItemBinarySectionSize{{}}}, true},
		{"empty", imap.FetchOptions{}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			options := tc.options
			if got := fetchNeedsRaw(&options); got != tc.want {
				t.Errorf("fetchNeedsRaw = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestSpecialUseAttr(t *testing.T) {
	tests := map[string]imap.MailboxAttr{
		"Sent":    imap.MailboxAttrSent,
		"drafts":  imap.MailboxAttrDrafts,
		"Trash":   imap.MailboxAttrTrash,
		"Junk":    imap.MailboxAttrJunk,
		"Archive": imap.MailboxAttrArchive,
		"INBOX":   "",
		"Project": "",
	}
	for name, want := range tests {
		if got := specialUseAttr(name); got != want {
			t.Errorf("specialUseAttr(%q) = %q, want %q", name, got, want)
		}
	}
}
