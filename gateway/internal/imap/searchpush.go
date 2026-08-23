// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"context"
	"strconv"
	"strings"

	"github.com/emersion/go-imap/v2"

	"github.com/crumrine/agentic-inbox-imap/gateway/internal/backend"
)

// SEARCH push-down (DEV-695).
//
// Search evaluates every criterion locally, message by message, and
// downloads the raw message for anything the metadata payload cannot answer
// — BODY, TEXT, BCC, a custom header. That is bounded (see
// maxSearchRawFetches) but slow: SEARCH TEXT "invoice" over a large folder
// pulls thousands of messages to find three.
//
// The Worker's search endpoint answers the half it can from SQLite. What
// comes back is deliberately only half an answer, and the whole of this
// file exists to finish it correctly:
//
//	uids is the set of messages satisfying every criterion named in
//	handled, and NOTHING ELSE has been applied.
//
// Top-level IMAP search keys are a conjunction, so uids is always a
// superset of the true answer and the gateway completes it by applying the
// unhandled criteria to those uids and to nothing else. Applying them to
// anything wider is wasted work; applying them to anything narrower is a
// wrong answer.
//
// # This is an optimisation, and it fails open
//
// Any error, timeout, non-200 or response the gateway cannot reconcile with
// what it sent drops straight back to the local path. A slow SEARCH is a
// nuisance; a SEARCH that answers NO makes a real client drop the
// connection and retry in a loop, which is the recurring lesson of this
// gateway (see docs/imap-gateway.md).
//
// # Bcc differs on purpose
//
// The endpoint answers a BCC search from the stored bcc column. The local
// path parses the Bcc header out of the raw message, which a recipient's
// copy almost never carries — Bcc is not part of an IMAP envelope and is
// stripped in transit. The column is the authoritative record of who was
// blind-copied, so when the endpoint reports bcc as handled its answer is
// both cheaper and better than the local one. It is therefore never
// re-evaluated here, and the two paths will legitimately disagree.
//
// # Two other places the paths can disagree
//
// The endpoint evaluates against the folder as it is now; the local path
// evaluates against this session's snapshot. A message deleted underneath
// the snapshot is dropped by the push-down and kept by the local path, and
// a flag another client changed since SELECT is read fresh by one and stale
// by the other. Both readings are legal — RFC 9051 fixes sequence numbers
// for the life of a selection, not flags — and the fresher answer is the
// better one.

// searchDateLayout is how a date criterion is rendered for the endpoint,
// which compares whole UTC days. go-imap parses an IMAP date ("1-Feb-2026")
// into a UTC midnight, so this loses nothing.
const searchDateLayout = "2006-01-02"

// serverSearchHeaderKeys mirrors SEARCH_FIELD_BY_HEADER in
// workers/imap/search.ts: the header keys the endpoint can answer.
//
// It is used ONLY to decide whether calling the endpoint is worth a round
// trip. Nothing about correctness depends on it: what the endpoint actually
// evaluated comes back in the response's handled list, and a stale copy of
// this map can therefore cost a wasted request but never a wrong answer.
//
// Note that it is not the same set as envelopeHeaderKeys, which is what the
// *gateway* can answer without a download: bcc is here and not there (the
// endpoint has a column, the gateway would need the raw bytes), and date is
// there and not here (the gateway holds the envelope date, the endpoint
// stores the header as free text it cannot compare).
var serverSearchHeaderKeys = map[string]struct{}{
	"subject":     {},
	"from":        {},
	"to":          {},
	"cc":          {},
	"bcc":         {},
	"message-id":  {},
	"in-reply-to": {},
}

// searchRequest is a criteria tree translated for the endpoint, together
// with everything needed to finish the job locally afterwards.
type searchRequest struct {
	// wire is the request body's "criteria".
	wire *backend.SearchCriteria

	// residual holds the terms that were never put on the wire at all, and
	// which the gateway must therefore always evaluate itself. The
	// unhandled terms are added to a copy of it by reconcile.
	residual imap.SearchCriteria

	// restore maps a positional token — exactly as the endpoint will name
	// it in handled/unhandled — back to the original go-imap term it came
	// from. Positional rather than keyed, because two header terms can
	// share a key and must stay distinguishable.
	restore map[string]func(dst *imap.SearchCriteria)
}

// buildSearchRequest translates criteria for the endpoint.
//
// Criteria must already have been through staticizeCriteria, so no number
// set still contains "*".
func buildSearchRequest(c *imap.SearchCriteria) *searchRequest {
	req := &searchRequest{
		wire:    &backend.SearchCriteria{},
		restore: make(map[string]func(dst *imap.SearchCriteria)),
	}

	// SeqNum is never sent. Sequence numbers are positions in this
	// session's snapshot, not a property of the mailbox, so the endpoint
	// has no way to evaluate them and no field to carry them.
	req.residual.SeqNum = c.SeqNum

	if len(c.UID) > 0 {
		// The wire format carries one disjunction of uid ranges; go-imap
		// carries a conjunction of sets, each of which is itself a
		// disjunction. Only the first set is expressible. The rest stay
		// local, which costs nothing — a uid test needs no download.
		ranges := wireUIDRanges(c.UID[0])
		if ranges != nil {
			first := c.UID[0]
			req.wire.UID = ranges
			req.restore["uid"] = func(dst *imap.SearchCriteria) { dst.UID = append(dst.UID, first) }
		} else {
			req.residual.UID = append(req.residual.UID, c.UID[0])
		}
		req.residual.UID = append(req.residual.UID, c.UID[1:]...)
	}

	if !c.Since.IsZero() {
		since := c.Since
		req.wire.Since = since.Format(searchDateLayout)
		req.restore["since"] = func(dst *imap.SearchCriteria) { dst.Since = since }
	}
	if !c.Before.IsZero() {
		before := c.Before
		req.wire.Before = before.Format(searchDateLayout)
		req.restore["before"] = func(dst *imap.SearchCriteria) { dst.Before = before }
	}
	// SENTSINCE and SENTBEFORE are reported unhandled by today's endpoint
	// (the Date header is stored as free text it cannot compare), so these
	// come straight back. They are sent anyway rather than held back: the
	// contract is a faithful mirror of the criteria, and a Worker that
	// learns to answer them benefits this gateway with no change here.
	if !c.SentSince.IsZero() {
		sentSince := c.SentSince
		req.wire.SentSince = sentSince.Format(searchDateLayout)
		req.restore["sentSince"] = func(dst *imap.SearchCriteria) { dst.SentSince = sentSince }
	}
	if !c.SentBefore.IsZero() {
		sentBefore := c.SentBefore
		req.wire.SentBefore = sentBefore.Format(searchDateLayout)
		req.restore["sentBefore"] = func(dst *imap.SearchCriteria) { dst.SentBefore = sentBefore }
	}

	for i, f := range c.Flag {
		flag := f
		req.wire.Flag = append(req.wire.Flag, string(flag))
		req.restore["flag["+strconv.Itoa(i)+"]"] = func(dst *imap.SearchCriteria) {
			dst.Flag = append(dst.Flag, flag)
		}
	}
	for i, f := range c.NotFlag {
		flag := f
		req.wire.NotFlag = append(req.wire.NotFlag, string(flag))
		req.restore["notFlag["+strconv.Itoa(i)+"]"] = func(dst *imap.SearchCriteria) {
			dst.NotFlag = append(dst.NotFlag, flag)
		}
	}

	if c.Larger != 0 {
		larger := c.Larger
		req.wire.Larger = larger
		req.restore["larger"] = func(dst *imap.SearchCriteria) { dst.Larger = larger }
	}
	if c.Smaller != 0 {
		smaller := c.Smaller
		req.wire.Smaller = smaller
		req.restore["smaller"] = func(dst *imap.SearchCriteria) { dst.Smaller = smaller }
	}

	for i, h := range c.Header {
		field := h
		req.wire.Header = append(req.wire.Header, backend.SearchHeaderField{Key: field.Key, Value: field.Value})
		req.restore["header["+strconv.Itoa(i)+"]"] = func(dst *imap.SearchCriteria) {
			dst.Header = append(dst.Header, field)
		}
	}

	// BODY and TEXT always come back unhandled, for the reason set out in
	// workers/imap/search.ts: the stored body column is the parsed body the
	// app rendered, not the message's parts. They are still sent, so that
	// the endpoint reports them and the accounting in reconcile stays
	// exact rather than relying on this build's idea of what it answers.
	for i, s := range c.Body {
		pattern := s
		req.wire.Body = append(req.wire.Body, pattern)
		req.restore["body["+strconv.Itoa(i)+"]"] = func(dst *imap.SearchCriteria) {
			dst.Body = append(dst.Body, pattern)
		}
	}
	for i, s := range c.Text {
		pattern := s
		req.wire.Text = append(req.wire.Text, pattern)
		req.restore["text["+strconv.Itoa(i)+"]"] = func(dst *imap.SearchCriteria) {
			dst.Text = append(dst.Text, pattern)
		}
	}

	// A NOT or OR branch is one token, and the endpoint handles it only
	// when every leaf inside it is evaluable. A branch this gateway cannot
	// express in full is therefore not sent at all: sending a truncated
	// negation would let the endpoint report as handled something it only
	// half applied, turning a superset into a subset.
	//
	// The token index is the branch's position in the request, not in the
	// original criteria, because a dropped branch shifts everything after
	// it.
	for i := range c.Not {
		child := &c.Not[i]
		if !searchBranchSendable(child) {
			req.residual.Not = append(req.residual.Not, *child)
			continue
		}
		original := *child
		token := "not[" + strconv.Itoa(len(req.wire.Not)) + "]"
		req.wire.Not = append(req.wire.Not, wireCriteria(child))
		req.restore[token] = func(dst *imap.SearchCriteria) { dst.Not = append(dst.Not, original) }
	}
	for i := range c.Or {
		pair := &c.Or[i]
		if !searchBranchSendable(&pair[0]) || !searchBranchSendable(&pair[1]) {
			req.residual.Or = append(req.residual.Or, *pair)
			continue
		}
		original := *pair
		token := "or[" + strconv.Itoa(len(req.wire.Or)) + "]"
		var wired [2]backend.SearchCriteria
		wired[0] = wireCriteria(&pair[0])
		wired[1] = wireCriteria(&pair[1])
		req.wire.Or = append(req.wire.Or, wired)
		req.restore[token] = func(dst *imap.SearchCriteria) { dst.Or = append(dst.Or, original) }
	}

	return req
}

// reconcile turns a response into the criteria still to be evaluated
// locally, or reports that the response cannot be trusted.
//
// The accounting is deliberately strict: every token the gateway sent must
// come back exactly once, in handled or in unhandled, and nothing else may
// appear. A term reported in neither is a term nobody applied and nobody
// admitted to skipping, which is exactly the silent wrong answer this whole
// contract exists to prevent — so it is treated as a broken response and
// the search falls back to local evaluation.
func (req *searchRequest) reconcile(page *backend.SearchPage) (*imap.SearchCriteria, bool) {
	if page == nil {
		return nil, false
	}
	if page.Partial != (len(page.Unhandled) > 0) {
		return nil, false
	}

	seen := make(map[string]struct{}, len(req.restore))
	for _, token := range page.Handled {
		if _, known := req.restore[token]; !known {
			return nil, false
		}
		if _, dup := seen[token]; dup {
			return nil, false
		}
		seen[token] = struct{}{}
	}

	residual := req.residual
	for _, token := range page.Unhandled {
		apply, known := req.restore[token]
		if !known {
			return nil, false
		}
		if _, dup := seen[token]; dup {
			return nil, false
		}
		seen[token] = struct{}{}
		apply(&residual)
	}

	if len(seen) != len(req.restore) {
		return nil, false
	}
	return &residual, true
}

// searchPushdown is a successful push-down: which snapshot messages
// survived the criteria the endpoint evaluated, and what is left to
// evaluate locally against them.
type searchPushdown struct {
	// keep holds the uids the endpoint returned. The search must consider
	// these and no others.
	keep map[uint32]struct{}
	// residual is what the endpoint did not apply.
	residual *imap.SearchCriteria
}

// pushDownSearch asks the Worker to narrow the search, returning nil
// whenever the gateway should just evaluate everything itself.
func (s *Session) pushDownSearch(ctx context.Context, mailbox string, sel *selection, c *imap.SearchCriteria) *searchPushdown {
	if !s.searchPushdown || len(sel.msgs) == 0 {
		return nil
	}
	// Only worth a round trip when the local path would otherwise have to
	// download messages AND there is something the endpoint can narrow on.
	// Both are heuristics about cost, never about correctness: SEARCH
	// UNSEEN is already free locally, and asking the endpoint to evaluate
	// nothing would add latency to the commands a mail client issues most.
	if !searchNeedsRaw(c) || !searchHasPushableTerm(c) {
		return nil
	}

	req := buildSearchRequest(c)
	page, err := s.backend.Search(ctx, mailbox, sel.folderKey, req.wire)
	if err != nil {
		// Every failure lands here: 400 (criteria the Worker does not
		// know), 404, 413 (the search would examine too many rows to
		// answer at all), 5xx, a transport error, a timeout. None of them
		// may fail the SEARCH.
		s.logger.Debug("imap: search push-down unavailable, evaluating locally",
			"mailbox", mailbox, "folder", sel.folderKey, "err", err)
		return nil
	}

	residual, ok := req.reconcile(page)
	if !ok {
		// A response that cannot be reconciled with the request is not a
		// smaller answer, it is an unknown one: some term was neither
		// applied nor reported, and there is no way to tell which.
		s.logger.Warn("imap: search push-down response does not account for every criterion sent, evaluating locally",
			"mailbox", mailbox, "folder", sel.folderKey, "sent", len(req.restore))
		return nil
	}

	keep := make(map[uint32]struct{}, len(page.UIDs))
	for _, uid := range page.UIDs {
		keep[uid] = struct{}{}
	}
	return &searchPushdown{keep: keep, residual: residual}
}

// searchNeedsRaw reports whether evaluating these criteria locally could
// require downloading raw messages. It mirrors the fall-through in
// messageCriteria: BODY and TEXT always need the body, and so does any
// header key the envelope cannot answer.
//
// SENTSINCE/SENTBEFORE are not counted. They only reach the raw message
// when the envelope date is unparseable, which is rare enough that
// assuming it would make every dated search pay for a round trip.
func searchNeedsRaw(c *imap.SearchCriteria) bool {
	if len(c.Body) > 0 || len(c.Text) > 0 {
		return true
	}
	for _, h := range c.Header {
		if _, ok := envelopeHeaderKeys[strings.ToLower(strings.TrimSpace(h.Key))]; !ok {
			return true
		}
	}
	for i := range c.Not {
		if searchNeedsRaw(&c.Not[i]) {
			return true
		}
	}
	for i := range c.Or {
		if searchNeedsRaw(&c.Or[i][0]) || searchNeedsRaw(&c.Or[i][1]) {
			return true
		}
	}
	return false
}

// searchHasPushableTerm reports whether the endpoint is likely to narrow
// anything, so a search made entirely of terms it cannot answer does not
// pay for a request that would return the whole folder.
//
// Only top-level terms count: a nested one can only narrow through the
// NOT or OR that contains it, which is itself a top-level term.
func searchHasPushableTerm(c *imap.SearchCriteria) bool {
	if len(c.UID) > 0 || !c.Since.IsZero() || !c.Before.IsZero() {
		return true
	}
	if len(c.Flag) > 0 || len(c.NotFlag) > 0 {
		return true
	}
	if c.Larger != 0 || c.Smaller != 0 {
		return true
	}
	if len(c.Not) > 0 || len(c.Or) > 0 {
		return true
	}
	for _, h := range c.Header {
		if _, ok := serverSearchHeaderKeys[strings.ToLower(strings.TrimSpace(h.Key))]; ok {
			return true
		}
	}
	return false
}

// searchBranchSendable reports whether a whole NOT or OR branch can be put
// on the wire without losing a term.
func searchBranchSendable(c *imap.SearchCriteria) bool {
	if len(c.SeqNum) > 0 || c.ModSeq != nil {
		return false
	}
	// One node carries a single disjunction of uid ranges, so a
	// conjunction of two sets has nowhere to go.
	if len(c.UID) > 1 {
		return false
	}
	for i := range c.UID {
		if wireUIDRanges(c.UID[i]) == nil {
			return false
		}
	}
	for i := range c.Not {
		if !searchBranchSendable(&c.Not[i]) {
			return false
		}
	}
	for i := range c.Or {
		if !searchBranchSendable(&c.Or[i][0]) || !searchBranchSendable(&c.Or[i][1]) {
			return false
		}
	}
	return true
}

// wireCriteria translates a branch that searchBranchSendable has already
// approved. It carries no token accounting: the branch is one token, and
// the endpoint reports it handled only if it evaluated all of it.
func wireCriteria(c *imap.SearchCriteria) backend.SearchCriteria {
	var out backend.SearchCriteria

	if len(c.UID) == 1 {
		out.UID = wireUIDRanges(c.UID[0])
	}
	if !c.Since.IsZero() {
		out.Since = c.Since.Format(searchDateLayout)
	}
	if !c.Before.IsZero() {
		out.Before = c.Before.Format(searchDateLayout)
	}
	if !c.SentSince.IsZero() {
		out.SentSince = c.SentSince.Format(searchDateLayout)
	}
	if !c.SentBefore.IsZero() {
		out.SentBefore = c.SentBefore.Format(searchDateLayout)
	}
	for _, f := range c.Flag {
		out.Flag = append(out.Flag, string(f))
	}
	for _, f := range c.NotFlag {
		out.NotFlag = append(out.NotFlag, string(f))
	}
	out.Larger = c.Larger
	out.Smaller = c.Smaller
	for _, h := range c.Header {
		out.Header = append(out.Header, backend.SearchHeaderField{Key: h.Key, Value: h.Value})
	}
	out.Body = append(out.Body, c.Body...)
	out.Text = append(out.Text, c.Text...)
	for i := range c.Not {
		out.Not = append(out.Not, wireCriteria(&c.Not[i]))
	}
	for i := range c.Or {
		var pair [2]backend.SearchCriteria
		pair[0] = wireCriteria(&c.Or[i][0])
		pair[1] = wireCriteria(&c.Or[i][1])
		out.Or = append(out.Or, pair)
	}
	return out
}

// wireUIDRanges converts a uid set, or returns nil when it cannot be
// expressed on the wire: an empty set (which the endpoint would ignore, and
// then report no token for), or one still carrying "*" or the SEARCHRES
// marker. Both are evaluated locally instead.
func wireUIDRanges(set imap.UIDSet) []backend.SearchUIDRange {
	if len(set) == 0 || set.Dynamic() {
		return nil
	}
	out := make([]backend.SearchUIDRange, 0, len(set))
	for _, r := range set {
		if r.Start == 0 || r.Stop == 0 {
			return nil
		}
		out = append(out, backend.SearchUIDRange{Start: uint32(r.Start), End: uint32(r.Stop)})
	}
	return out
}
