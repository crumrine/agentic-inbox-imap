// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/emersion/go-imap/v2"

	"github.com/crumrine/agentic-inbox-imap/gateway/internal/backend"
)

// answerSearch installs a canned response for the push-down endpoint.
//
// The responses here are hand-written rather than derived from the fake's
// messages on purpose: the contract says the gateway must trust `uids` and
// apply only the unhandled criteria to it, so a fake that re-derived the
// right answer could not tell a gateway that honours that from one that
// quietly re-evaluates everything.
func answerSearch(be *fakeBackend, page *backend.SearchPage) {
	be.mu.Lock()
	defer be.mu.Unlock()
	be.searchFunc = func(*backend.SearchCriteria) (*backend.SearchPage, error) {
		return page, nil
	}
}

func failSearch(be *fakeBackend, err error) {
	be.mu.Lock()
	defer be.mu.Unlock()
	be.searchFunc = func(*backend.SearchCriteria) (*backend.SearchPage, error) {
		return nil, err
	}
}

// wireJSON renders the criteria the session sent, so a test can assert on
// the exact request body rather than on a Go struct that omitempty might
// still drop.
func wireJSON(t *testing.T, criteria *backend.SearchCriteria) string {
	t.Helper()
	b, err := json.Marshal(criteria)
	if err != nil {
		t.Fatalf("marshalling criteria: %v", err)
	}
	return string(b)
}

func onlySearchCall(t *testing.T, be *fakeBackend) *backend.SearchCriteria {
	t.Helper()
	calls := be.searchCalls()
	if len(calls) != 1 {
		t.Fatalf("search endpoint called %d times, want 1", len(calls))
	}
	return calls[0]
}

// TestSearchPushdownAnswersBccWithoutDownloading is the happy path, and the
// case the endpoint exists for: BCC cannot be answered from an IMAP
// envelope, so the local path downloads every message in the folder to
// parse a header that a recipient's copy usually does not even carry.
func TestSearchPushdownAnswersBccWithoutDownloading(t *testing.T) {
	be := newFakeBackend(t)
	answerSearch(be, &backend.SearchPage{
		UIDs:      []uint32{12},
		Partial:   false,
		Handled:   []string{"header[0]"},
		Unhandled: []string{},
		Scanned:   3,
	})
	s := newSelectedSession(t, be)

	got := searchUIDs(t, s, &imap.SearchCriteria{
		Header: []imap.SearchCriteriaHeaderField{{Key: "Bcc", Value: "hidden"}},
	})
	if !equalUint32s(got, []uint32{12}) {
		t.Errorf("uids = %v, want [12]", got)
	}
	if _, _, _, raw := be.counters(); raw != 0 {
		t.Errorf("RawMessage calls = %d, want 0: a fully handled search must not download anything", raw)
	}

	want := `{"header":[{"key":"Bcc","value":"hidden"}]}`
	if got := wireJSON(t, onlySearchCall(t, be)); got != want {
		t.Errorf("criteria sent = %s, want %s", got, want)
	}
}

// TestSearchPushdownDoesNotSecondGuessBcc pins the one place the two paths
// deliberately disagree. The endpoint answers BCC from the stored column,
// which is the authoritative record of who was blind-copied; the raw
// message has no Bcc header at all. Re-evaluating it locally would discard
// the better answer.
func TestSearchPushdownDoesNotSecondGuessBcc(t *testing.T) {
	be := newFakeBackend(t)
	// uid 9's raw message carries no Bcc header whatsoever.
	answerSearch(be, &backend.SearchPage{
		UIDs:    []uint32{9},
		Handled: []string{"header[0]"},
		Scanned: 3,
	})
	s := newSelectedSession(t, be)

	got := searchUIDs(t, s, &imap.SearchCriteria{
		Header: []imap.SearchCriteriaHeaderField{{Key: "Bcc", Value: "hidden"}},
	})
	if !equalUint32s(got, []uint32{9}) {
		t.Errorf("uids = %v, want [9]: the stored bcc column is the answer, not the raw header", got)
	}
	if _, _, _, raw := be.counters(); raw != 0 {
		t.Errorf("RawMessage calls = %d, want 0", raw)
	}
}

// TestSearchPushdownAppliesUnhandledToExactlyTheReturnedUIDs is the rule the
// whole contract rests on.
//
// The fake answers SINCE with {9, 12}, leaving out uid 5 even though its
// internal date would qualify. That is not a realistic answer, and that is
// the point: the only way to pass is to take `uids` as given and apply the
// unhandled BODY term to those two messages and to nothing else. A gateway
// that re-derived SINCE itself, or that ran BODY over the whole snapshot,
// would answer [5 9 12].
func TestSearchPushdownAppliesUnhandledToExactlyTheReturnedUIDs(t *testing.T) {
	be := newFakeBackend(t)
	answerSearch(be, &backend.SearchPage{
		UIDs:      []uint32{9, 12},
		Partial:   true,
		Handled:   []string{"since"},
		Unhandled: []string{"body[0]"},
		Scanned:   3,
	})
	s := newSelectedSession(t, be)

	// "s" appears in every message body, so BODY rules nothing out on its
	// own and the result is exactly the set the endpoint returned.
	got := searchUIDs(t, s, &imap.SearchCriteria{
		Since: date(t, "2006-01-01"),
		Body:  []string{"s"},
	})
	if !equalUint32s(got, []uint32{9, 12}) {
		t.Errorf("uids = %v, want [9 12]", got)
	}
	if n := be.rawCallsFor(5); n != 0 {
		t.Errorf("uid 5 downloaded %d times; the endpoint excluded it, so nothing may touch it", n)
	}
	if n := be.rawCallsFor(9); n != 1 {
		t.Errorf("uid 9 downloaded %d times, want 1", n)
	}
	if n := be.rawCallsFor(12); n != 1 {
		t.Errorf("uid 12 downloaded %d times, want 1", n)
	}

	want := `{"since":"2006-01-01","body":["s"]}`
	if got := wireJSON(t, onlySearchCall(t, be)); got != want {
		t.Errorf("criteria sent = %s, want %s", got, want)
	}
}

// TestSearchPushdownMapsPositionalHeaderTokens is the fiddly part: two
// HEADER terms share the key "Subject", so only the position in the request
// distinguishes them.
//
// The endpoint reports header[1] handled and header[0] unhandled. Applying
// the wrong one is not a crash, it is a different result set: header[0]
// ("Invoice") leaves uid 12, header[1] ("o") leaves all three.
func TestSearchPushdownMapsPositionalHeaderTokens(t *testing.T) {
	be := newFakeBackend(t)
	answerSearch(be, &backend.SearchPage{
		UIDs:      []uint32{5, 9, 12},
		Partial:   true,
		Handled:   []string{"header[1]"},
		Unhandled: []string{"header[0]", "body[0]"},
		Scanned:   3,
	})
	s := newSelectedSession(t, be)

	got := searchUIDs(t, s, &imap.SearchCriteria{
		Header: []imap.SearchCriteriaHeaderField{
			{Key: "Subject", Value: "Invoice"},
			{Key: "Subject", Value: "o"},
		},
		Body: []string{"s"},
	})
	if !equalUint32s(got, []uint32{12}) {
		t.Errorf("uids = %v, want [12]: header[0] is the unhandled term, not header[1]", got)
	}
	// Only uid 12 survives the re-applied header term, so it is the only
	// message the BODY term ever needs.
	if n := be.rawCallsFor(12); n != 1 {
		t.Errorf("uid 12 downloaded %d times, want 1", n)
	}
	if n := be.rawCallsFor(5) + be.rawCallsFor(9); n != 0 {
		t.Errorf("uids 5 and 9 downloaded %d times, want 0", n)
	}

	want := `{"header":[{"key":"Subject","value":"Invoice"},{"key":"Subject","value":"o"}],"body":["s"]}`
	if got := wireJSON(t, onlySearchCall(t, be)); got != want {
		t.Errorf("criteria sent = %s, want %s", got, want)
	}
}

// TestSearchPushdownFallsBackOnFailure covers every way the endpoint can
// let the gateway down. None of them may fail the SEARCH: each must produce
// the same answer the gateway would have reached on its own, by downloading
// all three messages and parsing the Bcc header out of them.
func TestSearchPushdownFallsBackOnFailure(t *testing.T) {
	tests := []struct {
		name string
		err  error
		page *backend.SearchPage
	}{
		{
			name: "413 search too large",
			err:  &backend.APIError{Kind: backend.ErrKindUnknown, StatusCode: 413, Body: `{"error":"Search too large"}`},
		},
		{
			name: "400 criteria the Worker does not know",
			err:  &backend.APIError{Kind: backend.ErrKindUnknown, StatusCode: 400, Body: `{"error":"Invalid request"}`},
		},
		{
			name: "404 endpoint not deployed",
			err:  &backend.APIError{Kind: backend.ErrKindNotFound, StatusCode: 404, Body: `{"error":"Not found"}`},
		},
		{
			name: "500 from the Worker",
			err:  &backend.APIError{Kind: backend.ErrKindServer, StatusCode: 500},
		},
		{
			name: "transport error",
			err:  &backend.APIError{Kind: backend.ErrKindServer, Err: errors.New("connection refused")},
		},
		{
			name: "timeout",
			err:  context.DeadlineExceeded,
		},
		{
			name: "empty response",
			page: nil,
		},
		{
			name: "token naming a term that was never sent",
			page: &backend.SearchPage{UIDs: []uint32{12}, Handled: []string{"flag[0]"}},
		},
		{
			name: "a sent term reported neither handled nor unhandled",
			page: &backend.SearchPage{UIDs: []uint32{12}, Handled: []string{}},
		},
		{
			name: "the same token reported twice",
			page: &backend.SearchPage{
				UIDs:      []uint32{12},
				Partial:   true,
				Handled:   []string{"header[0]"},
				Unhandled: []string{"header[0]"},
			},
		},
		{
			name: "partial disagrees with the unhandled list",
			page: &backend.SearchPage{UIDs: []uint32{12}, Partial: true, Handled: []string{"header[0]"}},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			be := newFakeBackend(t)
			if tc.err != nil {
				failSearch(be, tc.err)
			} else {
				answerSearch(be, tc.page)
			}
			s := newSelectedSession(t, be)

			got := searchUIDs(t, s, &imap.SearchCriteria{
				Header: []imap.SearchCriteriaHeaderField{{Key: "Bcc", Value: "hidden"}},
			})
			if !equalUint32s(got, []uint32{12}) {
				t.Errorf("uids = %v, want [12] from full local evaluation", got)
			}
			if _, _, _, raw := be.counters(); raw != 3 {
				t.Errorf("RawMessage calls = %d, want 3: the local path must have run over the whole snapshot", raw)
			}
			if n := len(be.searchCalls()); n != 1 {
				t.Errorf("search endpoint called %d times, want 1", n)
			}
		})
	}
}

// TestSearchPushdownSkipped covers the searches that must not pay for a
// round trip: the ones the gateway already answers for free, and the ones
// the endpoint could not narrow at all.
func TestSearchPushdownSkipped(t *testing.T) {
	tests := []struct {
		name     string
		criteria imap.SearchCriteria
		opts     []Option
	}{
		{"metadata only", imap.SearchCriteria{Flag: []imap.Flag{imap.FlagSeen}}, nil},
		{"ALL", imap.SearchCriteria{}, nil},
		{"envelope header only", imap.SearchCriteria{
			Header: []imap.SearchCriteriaHeaderField{{Key: "From", Value: "alice"}},
		}, nil},
		{"nothing the endpoint could narrow", imap.SearchCriteria{Body: []string{"pineapples"}}, nil},
		{"disabled", imap.SearchCriteria{
			Flag: []imap.Flag{imap.FlagSeen},
			Body: []string{"pineapples"},
		}, []Option{WithSearchPushdown(false)}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			be := newFakeBackend(t)
			// Any call at all would answer with this, so a session that
			// wrongly pushed down would be caught by the uid assertion too.
			answerSearch(be, &backend.SearchPage{UIDs: []uint32{}, Handled: []string{}})
			s := newSelectedSession(t, be, tc.opts...)

			criteria := tc.criteria
			searchUIDs(t, s, &criteria)
			if n := len(be.searchCalls()); n != 0 {
				t.Errorf("search endpoint called %d times, want 0", n)
			}
		})
	}
}

// TestSearchPushdownKeepsSequenceNumbersLocal proves the one field the wire
// format deliberately lacks stays behind. Sequence numbers are positions in
// this session's snapshot, so the endpoint cannot evaluate them and must
// not be told about them.
func TestSearchPushdownKeepsSequenceNumbersLocal(t *testing.T) {
	tests := []struct {
		name   string
		seqNum imap.SeqSet
		want   []uint32
	}{
		// Snapshot order is 5, 9, 12, so seq 1:2 is uids 5 and 9.
		{"matching sequence range", imap.SeqSetNum(1, 2), []uint32{9}},
		{"non-matching sequence range", imap.SeqSetNum(1), nil},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			be := newFakeBackend(t)
			answerSearch(be, &backend.SearchPage{
				UIDs:      []uint32{5, 9},
				Partial:   true,
				Handled:   []string{"flag[0]"},
				Unhandled: []string{"body[0]"},
				Scanned:   3,
			})
			s := newSelectedSession(t, be)

			got := searchUIDs(t, s, &imap.SearchCriteria{
				SeqNum: []imap.SeqSet{tc.seqNum},
				Flag:   []imap.Flag{imap.FlagSeen},
				Body:   []string{"pineapples"},
			})
			if !equalUint32s(got, tc.want) {
				t.Errorf("uids = %v, want %v", got, tc.want)
			}

			want := `{"flag":["\\Seen"],"body":["pineapples"]}`
			if got := wireJSON(t, onlySearchCall(t, be)); got != want {
				t.Errorf("criteria sent = %s, want %s", got, want)
			}
		})
	}
}

// TestSearchPushdownSendsOnlyTheFirstUIDSet: go-imap carries a conjunction
// of uid sets, the wire format one disjunction of ranges. The rest stay
// local, which costs nothing.
func TestSearchPushdownSendsOnlyTheFirstUIDSet(t *testing.T) {
	be := newFakeBackend(t)
	answerSearch(be, &backend.SearchPage{
		UIDs:      []uint32{5, 9},
		Partial:   true,
		Handled:   []string{"uid"},
		Unhandled: []string{"body[0]"},
		Scanned:   2,
	})
	s := newSelectedSession(t, be)

	got := searchUIDs(t, s, &imap.SearchCriteria{
		UID:  []imap.UIDSet{imap.UIDSetNum(5, 9), imap.UIDSetNum(9, 12)},
		Body: []string{"s"},
	})
	// The second set is applied locally and rules out uid 5.
	if !equalUint32s(got, []uint32{9}) {
		t.Errorf("uids = %v, want [9]", got)
	}

	want := `{"uid":[{"start":5,"end":5},{"start":9,"end":9}],"body":["s"]}`
	if got := wireJSON(t, onlySearchCall(t, be)); got != want {
		t.Errorf("criteria sent = %s, want %s", got, want)
	}
}

// TestSearchPushdownDropsBranchesItCannotExpress: a NOT is one token, and
// the endpoint reports it handled only if it evaluated all of it. A branch
// holding a sequence number cannot be expressed at all, so sending a
// truncated version of it would invite exactly the "handled, but only
// half" answer that turns a superset into a subset.
func TestSearchPushdownDropsBranchesItCannotExpress(t *testing.T) {
	be := newFakeBackend(t)
	answerSearch(be, &backend.SearchPage{
		UIDs:      []uint32{5, 9},
		Partial:   true,
		Handled:   []string{"flag[0]"},
		Unhandled: []string{"body[0]"},
		Scanned:   3,
	})
	s := newSelectedSession(t, be)

	got := searchUIDs(t, s, &imap.SearchCriteria{
		// NOT (sequence number 1), i.e. everything except uid 5.
		Not:  []imap.SearchCriteria{{SeqNum: []imap.SeqSet{imap.SeqSetNum(1)}}},
		Flag: []imap.Flag{imap.FlagSeen},
		Body: []string{"s"},
	})
	if !equalUint32s(got, []uint32{9}) {
		t.Errorf("uids = %v, want [9]", got)
	}

	want := `{"flag":["\\Seen"],"body":["s"]}`
	if got := wireJSON(t, onlySearchCall(t, be)); got != want {
		t.Errorf("criteria sent = %s, want %s", got, want)
	}
}

// TestSearchPushdownSendsWholeBranches is the other half: a NOT or OR the
// gateway can express goes over as one token and comes back as one.
func TestSearchPushdownSendsWholeBranches(t *testing.T) {
	be := newFakeBackend(t)
	answerSearch(be, &backend.SearchPage{
		UIDs:      []uint32{5, 12},
		Partial:   true,
		Handled:   []string{"not[0]", "or[0]"},
		Unhandled: []string{"body[0]"},
		Scanned:   3,
	})
	s := newSelectedSession(t, be)

	got := searchUIDs(t, s, &imap.SearchCriteria{
		Not: []imap.SearchCriteria{{Flag: []imap.Flag{imap.Flag("$Important")}}},
		Or: [][2]imap.SearchCriteria{{
			{Header: []imap.SearchCriteriaHeaderField{{Key: "From", Value: "alice"}}},
			{Header: []imap.SearchCriteriaHeaderField{{Key: "From", Value: "carol"}}},
		}},
		Body: []string{"bananas"},
	})
	if !equalUint32s(got, []uint32{12}) {
		t.Errorf("uids = %v, want [12]", got)
	}

	want := `{"body":["bananas"],` +
		`"not":[{"flag":["$Important"]}],` +
		`"or":[[{"header":[{"key":"From","value":"alice"}]},{"header":[{"key":"From","value":"carol"}]}]]}`
	if got := wireJSON(t, onlySearchCall(t, be)); got != want {
		t.Errorf("criteria sent = %s, want %s", got, want)
	}
}

// TestSearchPushdownIgnoresUIDsOutsideTheSnapshot: the endpoint answers
// from the folder as it is now, which can hold messages that arrived after
// SELECT. Sequence numbers are fixed for the life of a selection, so a uid
// the snapshot has never seen cannot appear in the result.
func TestSearchPushdownIgnoresUIDsOutsideTheSnapshot(t *testing.T) {
	be := newFakeBackend(t)
	answerSearch(be, &backend.SearchPage{
		UIDs:    []uint32{12, 41, 99},
		Handled: []string{"header[0]"},
		Scanned: 5,
	})
	s := newSelectedSession(t, be)

	got := searchUIDs(t, s, &imap.SearchCriteria{
		Header: []imap.SearchCriteriaHeaderField{{Key: "Bcc", Value: "hidden"}},
	})
	if !equalUint32s(got, []uint32{12}) {
		t.Errorf("uids = %v, want [12]", got)
	}
}

// TestSearchPushdownSkippedOnAnEmptyFolder: there is nothing to narrow, so
// there is nothing to ask.
func TestSearchPushdownSkippedOnAnEmptyFolder(t *testing.T) {
	be := newFakeBackend(t)
	answerSearch(be, &backend.SearchPage{UIDs: []uint32{1}, Handled: []string{"header[0]"}})
	s := newLoggedInSession(t, be)
	if _, err := s.Select("Archive", nil); err != nil {
		t.Fatalf("Select: %v", err)
	}

	got := searchUIDs(t, s, &imap.SearchCriteria{
		Header: []imap.SearchCriteriaHeaderField{{Key: "Bcc", Value: "hidden"}},
	})
	if len(got) != 0 {
		t.Errorf("uids = %v, want none", got)
	}
	if n := len(be.searchCalls()); n != 0 {
		t.Errorf("search endpoint called %d times, want 0", n)
	}
}

// TestSearchPushdownDatesAreWholeDays: the endpoint compares UTC days, and
// go-imap parses an IMAP date into a UTC midnight, so the rendering has to
// be the plain date with no time and no zone.
func TestSearchPushdownDatesAreWholeDays(t *testing.T) {
	be := newFakeBackend(t)
	answerSearch(be, &backend.SearchPage{
		UIDs:      []uint32{},
		Partial:   true,
		Handled:   []string{"since", "before"},
		Unhandled: []string{"sentSince", "sentBefore", "text[0]"},
	})
	s := newSelectedSession(t, be)

	searchUIDs(t, s, &imap.SearchCriteria{
		Since:      date(t, "2026-01-01"),
		Before:     date(t, "2026-03-01"),
		SentSince:  date(t, "2025-12-25"),
		SentBefore: date(t, "2026-02-14"),
		Text:       []string{"invoice"},
	})

	want := `{"since":"2026-01-01","before":"2026-03-01",` +
		`"sentSince":"2025-12-25","sentBefore":"2026-02-14","text":["invoice"]}`
	if got := wireJSON(t, onlySearchCall(t, be)); got != want {
		t.Errorf("criteria sent = %s, want %s", got, want)
	}
}
