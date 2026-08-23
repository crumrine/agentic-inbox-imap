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

	"github.com/crumrine/agentic-inbox/gateway/internal/backend"
)

func newLoggedInSession(t *testing.T, be Backend, opts ...Option) *Session {
	t.Helper()
	s := NewSession(be, opts...)
	if err := s.Login(testMailbox, testPassword); err != nil {
		t.Fatalf("Login: %v", err)
	}
	return s
}

func newSelectedSession(t *testing.T, be Backend, opts ...Option) *Session {
	t.Helper()
	s := newLoggedInSession(t, be, opts...)
	if _, err := s.Select("INBOX", nil); err != nil {
		t.Fatalf("Select: %v", err)
	}
	return s
}

// ---------------------------------------------------------------------
// LOGIN
// ---------------------------------------------------------------------

func TestLoginSuccess(t *testing.T) {
	be := newFakeBackend(t)
	s := NewSession(be)

	if err := s.Login(testMailbox, testPassword); err != nil {
		t.Fatalf("Login: %v", err)
	}
	mailbox, sel := s.snapshot()
	if mailbox != testMailbox {
		t.Errorf("mailbox = %q, want %q", mailbox, testMailbox)
	}
	if sel != nil {
		t.Errorf("selection = %+v, want nil right after login", sel)
	}
	if auth, _, _, _ := be.counters(); auth != 1 {
		t.Errorf("Authenticate calls = %d, want 1", auth)
	}
}

func TestLoginFailureMapsToAuthFailed(t *testing.T) {
	be := newFakeBackend(t)
	s := NewSession(be)

	err := s.Login(testMailbox, "wrong-password")
	if err == nil {
		t.Fatal("Login with a bad password succeeded")
	}
	if err != imapserver.ErrAuthFailed {
		t.Errorf("err = %#v, want imapserver.ErrAuthFailed", err)
	}
	if mailbox, _ := s.snapshot(); mailbox != "" {
		t.Errorf("mailbox = %q after a failed login, want empty", mailbox)
	}
}

// TestLoginFailureDoesNotLeakCredentials is the important one: the backend
// error carries a response-body excerpt, and the session must not forward
// any of it, nor the password, to the client.
func TestLoginFailureDoesNotLeakCredentials(t *testing.T) {
	const secret = "hunter2-super-secret"

	be := newFakeBackend(t)
	be.authErr = &backend.APIError{
		Kind:       backend.ErrKindAuthFailed,
		StatusCode: 401,
		Body:       `{"error":"bad password ` + secret + ` for user@example.com","token":"cf-access-abc123"}`,
	}
	s := NewSession(be)

	err := s.Login(testMailbox, secret)
	if err == nil {
		t.Fatal("Login succeeded, want failure")
	}
	text := err.Error()
	for _, forbidden := range []string{secret, "cf-access-abc123", "bad password", "401"} {
		if strings.Contains(text, forbidden) {
			t.Errorf("error text %q leaks %q", text, forbidden)
		}
	}

	// The password must still have reached the backend verbatim: the
	// no-leak rule is about what comes back out, not about mangling input.
	be.mu.Lock()
	seen := append([]string(nil), be.seenPasswords...)
	be.mu.Unlock()
	if len(seen) != 1 || seen[0] != secret {
		t.Errorf("backend saw passwords %v, want exactly [%q]", len(seen), secret)
	}
}

func TestLoginBackendFailureIsTemporary(t *testing.T) {
	be := newFakeBackend(t)
	be.authErr = &backend.APIError{Kind: backend.ErrKindServer, StatusCode: 503, Body: "upstream down"}
	s := NewSession(be)

	err := s.Login(testMailbox, testPassword)
	var imapErr *imap.Error
	if !errors.As(err, &imapErr) {
		t.Fatalf("err = %#v, want *imap.Error", err)
	}
	if imapErr.Type != imap.StatusResponseTypeNo || imapErr.Code != imap.ResponseCodeUnavailable {
		t.Errorf("err = %v, want NO [UNAVAILABLE]", imapErr)
	}
	if strings.Contains(err.Error(), "upstream down") {
		t.Errorf("error text %q leaks the backend response body", err.Error())
	}
}

func TestLoginUnknownMailboxLooksLikeAuthFailure(t *testing.T) {
	be := newFakeBackend(t)
	be.authErr = &backend.APIError{Kind: backend.ErrKindNotFound, StatusCode: 404}
	s := NewSession(be)

	if err := s.Login("nobody@example.com", testPassword); err != imapserver.ErrAuthFailed {
		t.Errorf("err = %#v, want imapserver.ErrAuthFailed (no mailbox enumeration)", err)
	}
}

func TestAuthenticatedCommandsRequireLogin(t *testing.T) {
	s := NewSession(newFakeBackend(t))

	if _, err := s.Select("INBOX", nil); err != errNotAuthenticated {
		t.Errorf("Select before login: err = %#v, want errNotAuthenticated", err)
	}
	if _, err := s.Status("INBOX", &imap.StatusOptions{NumMessages: true}); err != errNotAuthenticated {
		t.Errorf("Status before login: err = %#v, want errNotAuthenticated", err)
	}
}

// ---------------------------------------------------------------------
// SELECT / EXAMINE
// ---------------------------------------------------------------------

func TestSelectBuildsSeqNumMapping(t *testing.T) {
	be := newFakeBackend(t)
	s := newLoggedInSession(t, be)

	data, err := s.Select("INBOX", nil)
	if err != nil {
		t.Fatalf("Select: %v", err)
	}
	if data.NumMessages != 3 {
		t.Errorf("NumMessages = %d, want 3", data.NumMessages)
	}
	if data.UIDValidity != 1712345678 {
		t.Errorf("UIDValidity = %d, want 1712345678", data.UIDValidity)
	}
	if data.UIDNext != 13 {
		t.Errorf("UIDNext = %d, want 13", data.UIDNext)
	}
	// PERMANENTFLAGS must list what STORE will actually persist: it is what
	// a client reads to decide whether to try.
	if !sameFlags(data.PermanentFlags, permanentFlags) {
		t.Errorf("PermanentFlags = %v, want %v", data.PermanentFlags, permanentFlags)
	}
	// uid 5 is \Seen, uid 9 is \Seen, uid 12 is not: first unseen is seq 3.
	if data.FirstUnseenSeqNum != 3 {
		t.Errorf("FirstUnseenSeqNum = %d, want 3", data.FirstUnseenSeqNum)
	}

	_, sel := s.snapshot()
	if sel == nil {
		t.Fatal("no selection after Select")
	}
	want := []uint32{5, 9, 12}
	for i, wantUID := range want {
		seqNum := uint32(i + 1)
		if got := sel.msgs[i].UID; got != wantUID {
			t.Errorf("seq %d maps to uid %d, want %d", seqNum, got, wantUID)
		}
	}
	if sel.folderKey != "inbox" {
		t.Errorf("folderKey = %q, want %q", sel.folderKey, "inbox")
	}
}

func TestSelectInboxIsCaseInsensitive(t *testing.T) {
	s := newLoggedInSession(t, newFakeBackend(t))
	for _, name := range []string{"INBOX", "inbox", "InBoX"} {
		if _, err := s.Select(name, nil); err != nil {
			t.Errorf("Select(%q): %v", name, err)
		}
	}
	// A non-inbox folder stays case-sensitive.
	if _, err := s.Select("archive", nil); err == nil {
		t.Error("Select(\"archive\") succeeded, want NO: only INBOX is case-insensitive")
	}
	if _, err := s.Select("Archive", nil); err != nil {
		t.Errorf("Select(\"Archive\"): %v", err)
	}
}

func TestSelectUnknownMailbox(t *testing.T) {
	s := newLoggedInSession(t, newFakeBackend(t))
	_, err := s.Select("Nope", nil)
	var imapErr *imap.Error
	if !errors.As(err, &imapErr) {
		t.Fatalf("err = %#v, want *imap.Error", err)
	}
	if imapErr.Type != imap.StatusResponseTypeNo || imapErr.Code != imap.ResponseCodeNonExistent {
		t.Errorf("err = %v, want NO [NONEXISTENT]", imapErr)
	}
}

func TestSelectRejectsCondStore(t *testing.T) {
	s := newLoggedInSession(t, newFakeBackend(t))
	if _, err := s.Select("INBOX", &imap.SelectOptions{CondStore: true}); err == nil {
		t.Error("Select with CondStore succeeded, want NO")
	}
}

func TestUnselectClearsSelection(t *testing.T) {
	s := newSelectedSession(t, newFakeBackend(t))
	if err := s.Unselect(); err != nil {
		t.Fatalf("Unselect: %v", err)
	}
	if _, sel := s.snapshot(); sel != nil {
		t.Error("selection survived Unselect")
	}
	if err := s.Fetch(nil, imap.SeqSetNum(1), &imap.FetchOptions{UID: true}); err != errNoMailboxSelected {
		t.Errorf("Fetch after Unselect: err = %#v, want errNoMailboxSelected", err)
	}
}

// ---------------------------------------------------------------------
// STATUS
// ---------------------------------------------------------------------

func TestStatusMapsFolderPayload(t *testing.T) {
	be := newFakeBackend(t)
	s := newLoggedInSession(t, be)

	data, err := s.Status("INBOX", &imap.StatusOptions{
		NumMessages: true,
		NumRecent:   true,
		NumUnseen:   true,
		NumDeleted:  true,
		UIDNext:     true,
		UIDValidity: true,
	})
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if data.Mailbox != "INBOX" {
		t.Errorf("Mailbox = %q, want INBOX", data.Mailbox)
	}
	// Every requested pointer field must be non-nil: go-imap's STATUS
	// encoder dereferences them, so a nil here is a server panic on the
	// wire, not a missing item.
	for name, ptr := range map[string]*uint32{
		"NumMessages": data.NumMessages,
		"NumRecent":   data.NumRecent,
		"NumUnseen":   data.NumUnseen,
		"NumDeleted":  data.NumDeleted,
	} {
		if ptr == nil {
			t.Fatalf("%s is nil, which would panic the STATUS encoder", name)
		}
	}
	if *data.NumMessages != 3 || *data.NumUnseen != 2 || *data.NumRecent != 0 || *data.NumDeleted != 0 {
		t.Errorf("counts = messages %d unseen %d recent %d deleted %d",
			*data.NumMessages, *data.NumUnseen, *data.NumRecent, *data.NumDeleted)
	}
	if data.UIDNext != 13 || data.UIDValidity != 1712345678 {
		t.Errorf("UIDNext = %d, UIDValidity = %d", data.UIDNext, data.UIDValidity)
	}

	// The folders payload answers all of that; no message listing needed.
	if _, _, messages, _ := be.counters(); messages != 0 {
		t.Errorf("Messages calls = %d, want 0 for a counts-only STATUS", messages)
	}
}

func TestStatusSizeSumsMessageSizes(t *testing.T) {
	be := newFakeBackend(t)
	s := newLoggedInSession(t, be)

	data, err := s.Status("INBOX", &imap.StatusOptions{Size: true})
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if data.Size == nil {
		t.Fatal("Size is nil, which would panic the STATUS encoder")
	}
	want := int64(len(rawMsg5) + len(rawMsg9) + len(rawMsg12))
	if *data.Size != want {
		t.Errorf("Size = %d, want %d", *data.Size, want)
	}
}

func TestStatusRejectsCondStore(t *testing.T) {
	s := newLoggedInSession(t, newFakeBackend(t))
	if _, err := s.Status("INBOX", &imap.StatusOptions{HighestModSeq: true}); err == nil {
		t.Error("STATUS HIGHESTMODSEQ succeeded, want NO")
	}
}

// ---------------------------------------------------------------------
// SEARCH
// ---------------------------------------------------------------------

func searchUIDs(t *testing.T, s *Session, criteria *imap.SearchCriteria) []uint32 {
	t.Helper()
	data, err := s.Search(imapserver.NumKindUID, criteria, &imap.SearchOptions{ReturnAll: true})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	var out []uint32
	for _, uid := range data.AllUIDs() {
		out = append(out, uint32(uid))
	}
	return out
}

func equalUint32s(a, b []uint32) bool {
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

func date(t *testing.T, s string) time.Time {
	t.Helper()
	parsed, err := time.Parse("2006-01-02", s)
	if err != nil {
		t.Fatalf("bad test date %q: %v", s, err)
	}
	return parsed
}

func TestSearchSupportedCriteria(t *testing.T) {
	tests := []struct {
		name     string
		criteria imap.SearchCriteria
		want     []uint32
	}{
		{"ALL", imap.SearchCriteria{}, []uint32{5, 9, 12}},
		{"UID set", imap.SearchCriteria{UID: []imap.UIDSet{imap.UIDSetNum(9, 12)}}, []uint32{9, 12}},
		{"UID range with star", imap.SearchCriteria{UID: []imap.UIDSet{{{Start: 9, Stop: 0}}}}, []uint32{9, 12}},
		{"sequence set", imap.SearchCriteria{SeqNum: []imap.SeqSet{imap.SeqSetNum(1, 2)}}, []uint32{5, 9}},
		{"sequence range with star", imap.SearchCriteria{SeqNum: []imap.SeqSet{{{Start: 2, Stop: 0}}}}, []uint32{9, 12}},
		{"SEEN", imap.SearchCriteria{Flag: []imap.Flag{imap.FlagSeen}}, []uint32{5, 9}},
		{"UNSEEN", imap.SearchCriteria{NotFlag: []imap.Flag{imap.FlagSeen}}, []uint32{12}},
		{"FLAGGED", imap.SearchCriteria{Flag: []imap.Flag{imap.FlagFlagged}}, []uint32{9, 12}},
		{"keyword", imap.SearchCriteria{Flag: []imap.Flag{imap.Flag("$Important")}}, []uint32{9}},
		{"FROM", imap.SearchCriteria{Header: []imap.SearchCriteriaHeaderField{{Key: "From", Value: "alice"}}}, []uint32{5}},
		{"FROM by display name", imap.SearchCriteria{Header: []imap.SearchCriteriaHeaderField{{Key: "From", Value: "Bob Example"}}}, []uint32{9}},
		{"TO", imap.SearchCriteria{Header: []imap.SearchCriteriaHeaderField{{Key: "To", Value: "user@example.com"}}}, []uint32{5, 9, 12}},
		{"SUBJECT", imap.SearchCriteria{Header: []imap.SearchCriteriaHeaderField{{Key: "Subject", Value: "invoice"}}}, []uint32{12}},
		{"BODY", imap.SearchCriteria{Body: []string{"pineapples"}}, []uint32{9}},
		{"TEXT matches body", imap.SearchCriteria{Text: []string{"strawberries"}}, []uint32{5}},
		{"TEXT matches header", imap.SearchCriteria{Text: []string{"Meeting notes"}}, []uint32{9}},
		{"BODY does not match header", imap.SearchCriteria{Body: []string{"Meeting notes"}}, nil},
		{"BCC falls back to raw", imap.SearchCriteria{Header: []imap.SearchCriteriaHeaderField{{Key: "Bcc", Value: "hidden"}}}, []uint32{12}},
		{"custom header falls back to raw", imap.SearchCriteria{Header: []imap.SearchCriteriaHeaderField{{Key: "X-Custom", Value: "alpha"}}}, []uint32{5}},
		{"SENTSINCE", imap.SearchCriteria{SentSince: date(t, "2026-01-01")}, []uint32{12}},
		{"LARGER", imap.SearchCriteria{Larger: int64(len(rawMsg5))}, []uint32{9}},
		{"SMALLER", imap.SearchCriteria{Smaller: int64(len(rawMsg9))}, []uint32{5, 12}},
		{"NOT", imap.SearchCriteria{Not: []imap.SearchCriteria{{Flag: []imap.Flag{imap.FlagSeen}}}}, []uint32{12}},
		{"OR", imap.SearchCriteria{Or: [][2]imap.SearchCriteria{{
			{Header: []imap.SearchCriteriaHeaderField{{Key: "From", Value: "alice"}}},
			{Header: []imap.SearchCriteriaHeaderField{{Key: "From", Value: "carol"}}},
		}}}, []uint32{5, 12}},
		{"AND of two terms", imap.SearchCriteria{
			Flag:   []imap.Flag{imap.FlagSeen},
			Header: []imap.SearchCriteriaHeaderField{{Key: "Subject", Value: "meeting"}},
		}, []uint32{9}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := newSelectedSession(t, newFakeBackend(t))
			criteria := tc.criteria
			got := searchUIDs(t, s, &criteria)
			if !equalUint32s(got, tc.want) {
				t.Errorf("uids = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestSearchSinceBefore(t *testing.T) {
	s := newSelectedSession(t, newFakeBackend(t))

	if got := searchUIDs(t, s, &imap.SearchCriteria{Since: date(t, "2026-01-01")}); !equalUint32s(got, []uint32{12}) {
		t.Errorf("SINCE 2026-01-01 = %v, want [12]", got)
	}
	if got := searchUIDs(t, s, &imap.SearchCriteria{Before: date(t, "2026-01-01")}); !equalUint32s(got, []uint32{5, 9}) {
		t.Errorf("BEFORE 2026-01-01 = %v, want [5 9]", got)
	}
	// BEFORE is exclusive of the given date.
	if got := searchUIDs(t, s, &imap.SearchCriteria{Before: date(t, "2006-01-03")}); !equalUint32s(got, []uint32{5}) {
		t.Errorf("BEFORE 2006-01-03 = %v, want [5]", got)
	}
}

func TestSearchBySeqNumKind(t *testing.T) {
	s := newSelectedSession(t, newFakeBackend(t))
	data, err := s.Search(imapserver.NumKindSeq, &imap.SearchCriteria{Flag: []imap.Flag{imap.FlagFlagged}}, &imap.SearchOptions{ReturnAll: true})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if got := data.AllSeqNums(); !equalUint32s(got, []uint32{2, 3}) {
		t.Errorf("seq nums = %v, want [2 3]", got)
	}
	if data.Count != 2 || data.Min != 2 || data.Max != 3 {
		t.Errorf("Count = %d, Min = %d, Max = %d; want 2, 2, 3", data.Count, data.Min, data.Max)
	}
}

func TestSearchEmptyResultIsTypedNumSet(t *testing.T) {
	s := newSelectedSession(t, newFakeBackend(t))
	for _, kind := range []imapserver.NumKind{imapserver.NumKindSeq, imapserver.NumKindUID} {
		data, err := s.Search(kind, &imap.SearchCriteria{Body: []string{"no such text anywhere"}}, &imap.SearchOptions{ReturnAll: true})
		if err != nil {
			t.Fatalf("Search: %v", err)
		}
		// go-imap type-switches on All and cannot encode a nil interface,
		// so an empty result must still carry a concrete set type.
		if data.All == nil {
			t.Fatalf("%v: All is a nil interface; the SEARCH response encoder would fail", kind)
		}
	}
}

// TestSearchMetadataOnlyDoesNotFetchRaw proves the lazy path: criteria that
// the metadata payload can answer must not pull message bodies.
func TestSearchMetadataOnlyDoesNotFetchRaw(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	searchUIDs(t, s, &imap.SearchCriteria{
		Flag:   []imap.Flag{imap.FlagSeen},
		Header: []imap.SearchCriteriaHeaderField{{Key: "Subject", Value: "hello"}},
		Since:  date(t, "2000-01-01"),
	})
	if _, _, _, raw := be.counters(); raw != 0 {
		t.Errorf("RawMessage calls = %d, want 0 for a metadata-only SEARCH", raw)
	}
}

// TestSearchShortCircuitsBeforeRaw proves the ordering: a cheap metadata
// term that rules a message out must run before the expensive body term.
func TestSearchShortCircuitsBeforeRaw(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be)

	// Only uid 12 is unseen, so only uid 12 should ever be downloaded.
	got := searchUIDs(t, s, &imap.SearchCriteria{
		NotFlag: []imap.Flag{imap.FlagSeen},
		Body:    []string{"bananas"},
	})
	if !equalUint32s(got, []uint32{12}) {
		t.Errorf("uids = %v, want [12]", got)
	}
	if _, _, _, raw := be.counters(); raw != 1 {
		t.Errorf("RawMessage calls = %d, want 1", raw)
	}
}

func TestSearchRawBudgetIsEnforced(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithMaxSearchRawFetches(1))

	_, err := s.Search(imapserver.NumKindUID, &imap.SearchCriteria{Body: []string{"pineapples"}}, &imap.SearchOptions{ReturnAll: true})
	var imapErr *imap.Error
	if !errors.As(err, &imapErr) {
		t.Fatalf("err = %#v, want *imap.Error", err)
	}
	if imapErr.Code != imap.ResponseCodeLimit {
		t.Errorf("err = %v, want NO [LIMIT]", imapErr)
	}
}

// TestSearchUnsupportedCriteriaError is the honesty test: an unevaluable
// term must produce an error, never a silently wrong result set.
func TestSearchUnsupportedCriteriaError(t *testing.T) {
	tests := []struct {
		name     string
		criteria imap.SearchCriteria
		options  imap.SearchOptions
	}{
		{"MODSEQ", imap.SearchCriteria{ModSeq: &imap.SearchCriteriaModSeq{ModSeq: 1}}, imap.SearchOptions{ReturnAll: true}},
		{"nested MODSEQ inside NOT", imap.SearchCriteria{
			Not: []imap.SearchCriteria{{ModSeq: &imap.SearchCriteriaModSeq{ModSeq: 1}}},
		}, imap.SearchOptions{ReturnAll: true}},
		{"nested MODSEQ inside OR", imap.SearchCriteria{
			Or: [][2]imap.SearchCriteria{{
				{Flag: []imap.Flag{imap.FlagSeen}},
				{ModSeq: &imap.SearchCriteriaModSeq{ModSeq: 1}},
			}},
		}, imap.SearchOptions{ReturnAll: true}},
		{"SEARCHRES marker", imap.SearchCriteria{UID: []imap.UIDSet{imap.SearchRes()}}, imap.SearchOptions{ReturnAll: true}},
		{"RETURN SAVE", imap.SearchCriteria{}, imap.SearchOptions{ReturnSave: true}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := newSelectedSession(t, newFakeBackend(t))
			criteria := tc.criteria
			options := tc.options
			data, err := s.Search(imapserver.NumKindUID, &criteria, &options)
			if err == nil {
				t.Fatalf("Search succeeded and returned %v; an unsupported criterion must be an error, not a wrong answer", data.AllUIDs())
			}
			var imapErr *imap.Error
			if !errors.As(err, &imapErr) {
				t.Fatalf("err = %#v, want *imap.Error so the client sees a clean NO", err)
			}
			if imapErr.Type != imap.StatusResponseTypeNo {
				t.Errorf("err = %v, want a NO response", imapErr)
			}
		})
	}
}

func TestSearchWithoutSelection(t *testing.T) {
	s := newLoggedInSession(t, newFakeBackend(t))
	if _, err := s.Search(imapserver.NumKindUID, &imap.SearchCriteria{}, &imap.SearchOptions{}); err != errNoMailboxSelected {
		t.Errorf("err = %#v, want errNoMailboxSelected", err)
	}
}

// ---------------------------------------------------------------------
// Out-of-scope commands
// ---------------------------------------------------------------------

// TestUnimplementedCommandsReturnCleanErrors exercises the mailbox
// management commands, which remain unimplemented. None may panic, none may
// nil-deref, and all must produce an *imap.Error the server turns into a
// NO.
func TestUnimplementedCommandsReturnCleanErrors(t *testing.T) {
	calls := map[string]func(s *Session) error{
		"Create":    func(s *Session) error { return s.Create("New", nil) },
		"Delete":    func(s *Session) error { return s.Delete("Archive") },
		"Rename":    func(s *Session) error { return s.Rename("Archive", "Old", nil) },
		"Subscribe": func(s *Session) error { return s.Subscribe("Archive") },
		"Unsubscr":  func(s *Session) error { return s.Unsubscribe("Archive") },
		// IDLE, STORE, COPY, MOVE, EXPUNGE and APPEND are deliberately
		// absent: they are implemented. See idle_test.go, store_test.go
		// and mutate_test.go.
	}

	for name, call := range calls {
		t.Run(name, func(t *testing.T) {
			s := newSelectedSession(t, newFakeBackend(t))
			defer func() {
				if v := recover(); v != nil {
					t.Fatalf("panicked: %v", v)
				}
			}()
			err := call(s)
			if err == nil {
				t.Fatal("succeeded, want a NO error")
			}
			var imapErr *imap.Error
			if !errors.As(err, &imapErr) {
				t.Fatalf("err = %#v, want *imap.Error", err)
			}
			if imapErr.Type != imap.StatusResponseTypeNo {
				t.Errorf("err = %v, want a NO response", imapErr)
			}
		})
	}
}

// TestCloseExpungeSucceeds covers the CLOSE path. go-imap implements CLOSE
// as Expunge(w, nil) followed by Unselect, so a nil UID set must not fail
// or CLOSE, which is in scope, breaks. With nothing marked \Deleted there
// is nothing to remove, but the call still has to succeed.
func TestCloseExpungeSucceeds(t *testing.T) {
	s := newSelectedSession(t, newFakeBackend(t))
	if err := s.Expunge(nil, nil); err != nil {
		t.Fatalf("Expunge(nil): %v; CLOSE would fail", err)
	}
	if err := s.Unselect(); err != nil {
		t.Fatalf("Unselect: %v", err)
	}
}

// TestPollNeverFails matters because go-imap calls Poll after every command
// in the authenticated and selected states: any error it returns becomes a
// failure of the command the client actually sent.
func TestPollNeverFails(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(0))

	for _, allowExpunge := range []bool{true, false} {
		if err := s.Poll(nil, allowExpunge); err != nil {
			t.Errorf("Poll(allowExpunge=%v): %v", allowExpunge, err)
		}
	}

	be.mu.Lock()
	be.foldersErr = &backend.APIError{Kind: backend.ErrKindServer, StatusCode: 503}
	be.mu.Unlock()
	if err := s.Poll(nil, true); err != nil {
		t.Errorf("Poll with a broken backend: %v, want nil", err)
	}

	// Not selected either.
	if err := s.Unselect(); err != nil {
		t.Fatalf("Unselect: %v", err)
	}
	if err := s.Poll(nil, true); err != nil {
		t.Errorf("Poll with no selection: %v, want nil", err)
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	s := newSelectedSession(t, newFakeBackend(t))
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if mailbox, sel := s.snapshot(); mailbox != "" || sel != nil {
		t.Errorf("state survived Close: mailbox %q, selection %v", mailbox, sel)
	}
}

// TestForEachResolvesStar covers "*" in a number set. It is a direct test
// of the snapshot rather than a protocol one because go-imap's own client
// filters dynamic sets out of the responses it collects.
func TestForEachResolvesStar(t *testing.T) {
	s := newSelectedSession(t, newFakeBackend(t))
	_, sel := s.snapshot()

	collect := func(numSet imap.NumSet) []uint32 {
		var uids []uint32
		err := sel.forEach(numSet, func(seqNum uint32, msg *backend.Message) error {
			uids = append(uids, msg.UID)
			return nil
		})
		if err != nil {
			t.Fatalf("forEach: %v", err)
		}
		return uids
	}

	tests := []struct {
		name   string
		numSet imap.NumSet
		want   []uint32
	}{
		{"seq *", imap.SeqSet{{Start: 0, Stop: 0}}, []uint32{12}},
		{"seq 2:*", imap.SeqSet{{Start: 2, Stop: 0}}, []uint32{9, 12}},
		{"seq 1:2", imap.SeqSet{{Start: 1, Stop: 2}}, []uint32{5, 9}},
		{"uid *", imap.UIDSet{{Start: 0, Stop: 0}}, []uint32{12}},
		{"uid 9:*", imap.UIDSet{{Start: 9, Stop: 0}}, []uint32{9, 12}},
		{"uid 1:8", imap.UIDSet{{Start: 1, Stop: 8}}, []uint32{5}},
		{"uid gap is skipped", imap.UIDSet{{Start: 6, Stop: 8}}, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := collect(tc.numSet); !equalUint32s(got, tc.want) {
				t.Errorf("uids = %v, want %v", got, tc.want)
			}
		})
	}

	// Resolving "*" must not mutate the caller's set: go-imap hands us the
	// decoded command value, and editing it in place would be a surprise.
	original := imap.SeqSet{{Start: 0, Stop: 0}}
	collect(original)
	if original[0].Start != 0 || original[0].Stop != 0 {
		t.Errorf("caller's SeqSet was mutated to %+v", original[0])
	}
}

func TestSelectServesExamineTheSameWay(t *testing.T) {
	s := newLoggedInSession(t, newFakeBackend(t))
	// EXAMINE reaches the session as Select with ReadOnly set. SELECT is
	// served read-only too, so the two must agree.
	examine, err := s.Select("INBOX", &imap.SelectOptions{ReadOnly: true})
	if err != nil {
		t.Fatalf("EXAMINE: %v", err)
	}
	selectData, err := s.Select("INBOX", &imap.SelectOptions{ReadOnly: false})
	if err != nil {
		t.Fatalf("SELECT: %v", err)
	}
	if examine.NumMessages != selectData.NumMessages || examine.UIDValidity != selectData.UIDValidity {
		t.Errorf("EXAMINE %+v differs from SELECT %+v", examine, selectData)
	}

	// The two differ in exactly one respect: an examined mailbox cannot be
	// changed, so it advertises no permanent flags and refuses STORE.
	if len(examine.PermanentFlags) != 0 {
		t.Errorf("EXAMINE PermanentFlags = %v, want empty", examine.PermanentFlags)
	}
	if !sameFlags(selectData.PermanentFlags, permanentFlags) {
		t.Errorf("SELECT PermanentFlags = %v, want %v", selectData.PermanentFlags, permanentFlags)
	}
}

// sameFlags compares two flag lists as sets, case-insensitively.
func sameFlags(got, want []imap.Flag) bool {
	if len(got) != len(want) {
		return false
	}
	seen := make(map[imap.Flag]int, len(got))
	for _, f := range got {
		seen[canonicalFlag(f)]++
	}
	for _, f := range want {
		seen[canonicalFlag(f)]--
	}
	for _, n := range seen {
		if n != 0 {
			return false
		}
	}
	return true
}

// TestListLSubPath covers the LSUB code path: go-imap turns LSUB into a
// List call with SelectSubscribed set. Every folder is reported as
// subscribed, so LSUB and LIST agree.
func TestListLSubPath(t *testing.T) {
	s := newLoggedInSession(t, newFakeBackend(t))
	w := &recordingListWriter{}
	if err := s.listInto(w, "", []string{"*"}, &imap.ListOptions{SelectSubscribed: true}); err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(w.entries) != 3 {
		t.Fatalf("LSUB returned %d mailboxes, want 3", len(w.entries))
	}
	for _, e := range w.entries {
		if !hasAttr(e.Attrs, imap.MailboxAttrSubscribed) {
			t.Errorf("%s attrs = %v, want \\Subscribed", e.Mailbox, e.Attrs)
		}
	}
}

func hasAttr(attrs []imap.MailboxAttr, want imap.MailboxAttr) bool {
	for _, a := range attrs {
		if a == want {
			return true
		}
	}
	return false
}

type recordingListWriter struct{ entries []*imap.ListData }

func (w *recordingListWriter) WriteList(data *imap.ListData) error {
	w.entries = append(w.entries, data)
	return nil
}
