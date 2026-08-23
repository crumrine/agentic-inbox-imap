// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"
	gomessage "github.com/emersion/go-message"
	"github.com/emersion/go-message/mail"

	"github.com/crumrine/agentic-inbox-imap/gateway/internal/backend"
)

// errMessageVanished unwinds the match of a message that disappeared from
// the backend mid-search. Search turns it into "this message does not
// match" rather than a failed command; it never reaches a client.
var errMessageVanished = errors.New("imap: message vanished during search")

// errSearchBudget is returned when a SEARCH would have to download more raw
// messages than the session allows.
var errSearchBudget = &imap.Error{
	Type: imap.StatusResponseTypeNo,
	Code: imap.ResponseCodeLimit,
	Text: "SEARCH would need to download too many messages, narrow the search",
}

// envelopeHeaderKeys are the header fields the metadata payload can answer
// without downloading the message. Anything else falls through to the raw
// body, which is slow but correct.
//
// Bcc is deliberately absent: it is not part of an IMAP envelope, so
// answering SEARCH BCC from metadata would silently miss every match.
var envelopeHeaderKeys = map[string]struct{}{
	"from":        {},
	"to":          {},
	"cc":          {},
	"subject":     {},
	"message-id":  {},
	"in-reply-to": {},
	"date":        {},
}

// Search implements SEARCH and UID SEARCH.
//
// Criteria the gateway cannot evaluate are refused. A SEARCH that quietly
// ignores a term returns the wrong messages, and a mail client has no way
// to tell that happened; a NO is recoverable, a wrong result set is not.
func (s *Session) Search(kind imapserver.NumKind, criteria *imap.SearchCriteria, options *imap.SearchOptions) (*imap.SearchData, error) {
	mailbox, sel, err := s.selected()
	if err != nil {
		return nil, err
	}
	if options != nil && options.ReturnSave {
		// SEARCHRES would require remembering the result set and honouring
		// "$" in later commands. Not implemented, so say so.
		return nil, errUnsupported("SEARCH RETURN (SAVE) / SEARCHRES")
	}
	if criteria == nil {
		criteria = &imap.SearchCriteria{}
	}
	if err := validateCriteria(criteria); err != nil {
		return nil, err
	}
	staticizeCriteria(sel, criteria)

	ctx, cancel := s.context()
	defer cancel()

	budget := s.maxSearchRawFetches

	// Ask the Worker to answer the half it can from its own storage, which
	// turns a folder-wide raw download into a handful of fetches. What
	// comes back narrows the candidate set to keep and leaves the criteria
	// it did not evaluate in effective; see searchpush.go. A nil result
	// means the push-down was skipped or failed, and nothing below changes.
	effective := criteria
	var keep map[uint32]struct{}
	if pushed := s.pushDownSearch(ctx, mailbox, sel, criteria); pushed != nil {
		keep, effective = pushed.keep, pushed.residual
	}

	var (
		data   imap.SearchData
		seqSet imap.SeqSet
		uidSet imap.UIDSet
	)

	for i, msg := range sel.msgs {
		seqNum := uint32(i + 1)
		if keep != nil {
			// The endpoint's uids satisfy every criterion it applied, and
			// only those, so the rest of the search runs against exactly
			// this set: anything wider is wasted work, anything narrower is
			// a wrong answer.
			if _, ok := keep[msg.UID]; !ok {
				continue
			}
		}
		mc := &messageCriteria{
			ctx:     ctx,
			store:   s.store,
			mailbox: mailbox,
			folder:  sel.folderKey,
			msg:     msg,
			seqNum:  seqNum,
			flags:   newFlagSet(msg.Flags),
			budget:  &budget,
		}

		ok, err := mc.match(effective)
		if err != nil {
			if errors.Is(err, errMessageVanished) {
				continue
			}
			return nil, err
		}
		if !ok {
			continue
		}

		var num uint32
		switch kind {
		case imapserver.NumKindSeq:
			seqSet.AddNum(seqNum)
			num = seqNum
		case imapserver.NumKindUID:
			uidSet.AddNum(imap.UID(msg.UID))
			num = msg.UID
		}
		if data.Min == 0 || num < data.Min {
			data.Min = num
		}
		if num > data.Max {
			data.Max = num
		}
		data.Count++
	}

	// All must always hold a typed value, even when empty: go-imap type
	// switches on it and cannot encode a nil interface.
	switch kind {
	case imapserver.NumKindUID:
		data.All = uidSet
	default:
		data.All = seqSet
	}
	return &data, nil
}

// validateCriteria walks the criteria tree and refuses anything the
// gateway cannot evaluate faithfully.
func validateCriteria(c *imap.SearchCriteria) error {
	if c.ModSeq != nil {
		return errUnsupported("SEARCH MODSEQ (CONDSTORE)")
	}
	for _, set := range c.UID {
		if imap.IsSearchRes(set) {
			return errUnsupported("the SEARCHRES '$' marker")
		}
	}
	for _, set := range c.SeqNum {
		if imap.IsSearchRes(set) {
			return errUnsupported("the SEARCHRES '$' marker")
		}
	}
	for i := range c.Not {
		if err := validateCriteria(&c.Not[i]); err != nil {
			return err
		}
	}
	for i := range c.Or {
		if err := validateCriteria(&c.Or[i][0]); err != nil {
			return err
		}
		if err := validateCriteria(&c.Or[i][1]); err != nil {
			return err
		}
	}
	return nil
}

// staticizeCriteria resolves "*" in every number set against the snapshot,
// replacing the slices rather than editing the caller's ranges in place.
func staticizeCriteria(sel *selection, c *imap.SearchCriteria) {
	if len(c.SeqNum) > 0 {
		out := make([]imap.SeqSet, len(c.SeqNum))
		for i := range c.SeqNum {
			out[i], _ = sel.staticNumSet(c.SeqNum[i]).(imap.SeqSet)
		}
		c.SeqNum = out
	}
	if len(c.UID) > 0 {
		out := make([]imap.UIDSet, len(c.UID))
		for i := range c.UID {
			out[i], _ = sel.staticNumSet(c.UID[i]).(imap.UIDSet)
		}
		c.UID = out
	}
	for i := range c.Not {
		staticizeCriteria(sel, &c.Not[i])
	}
	for i := range c.Or {
		staticizeCriteria(sel, &c.Or[i][0])
		staticizeCriteria(sel, &c.Or[i][1])
	}
}

// messageCriteria evaluates search criteria against one message, pulling
// the raw body only when a term actually needs it and only once per
// message.
type messageCriteria struct {
	ctx     context.Context
	store   MessageStore
	mailbox string
	folder  string
	msg     *backend.Message
	seqNum  uint32
	flags   flagSet

	// budget is shared across every message in one SEARCH.
	budget *int

	raw     []byte
	rawErr  error
	rawDone bool
}

// rawBytes fetches (once) the raw message, charging the shared budget.
func (m *messageCriteria) rawBytes() ([]byte, error) {
	if m.rawDone {
		return m.raw, m.rawErr
	}
	m.rawDone = true
	if *m.budget <= 0 {
		m.rawErr = errSearchBudget
		return nil, m.rawErr
	}
	*m.budget--

	raw, err := m.store.Raw(m.ctx, m.mailbox, m.folder, m.msg.UID)
	if err != nil {
		if vanished(err) {
			// The message was deleted underneath the snapshot. It cannot
			// match, and it must not abort the search: the app deletes and
			// renumbers rows routinely, so a long SEARCH BODY would
			// otherwise fail whenever the user saved a draft.
			m.rawErr = errMessageVanished
			return nil, m.rawErr
		}
		m.rawErr = mapBackendError(err, "Message no longer exists")
		return nil, m.rawErr
	}
	m.raw = raw
	return m.raw, nil
}

// entity parses the raw message. A fresh entity is returned each call
// because reading its body consumes the underlying reader.
func (m *messageCriteria) entity() (*gomessage.Entity, error) {
	raw, err := m.rawBytes()
	if err != nil {
		return nil, err
	}
	ent, entErr := gomessage.Read(bytes.NewReader(raw))
	if ent == nil {
		// gomessage.Read returns a usable entity alongside an
		// unknown-charset error; only a nil entity is fatal.
		if entErr == nil {
			entErr = io.ErrUnexpectedEOF
		}
		return nil, &imap.Error{
			Type: imap.StatusResponseTypeNo,
			Code: imap.ResponseCodeServerBug,
			Text: "Message could not be parsed",
		}
	}
	return ent, nil
}

func (m *messageCriteria) match(c *imap.SearchCriteria) (bool, error) {
	// Cheapest first: everything below the header section is answered from
	// the metadata payload with no network traffic.
	for _, set := range c.SeqNum {
		if !set.Contains(m.seqNum) {
			return false, nil
		}
	}
	for _, set := range c.UID {
		if !set.Contains(imap.UID(m.msg.UID)) {
			return false, nil
		}
	}
	if !matchDate(m.msg.InternalDate, c.Since, c.Before) {
		return false, nil
	}
	for _, f := range c.Flag {
		if !m.flags.has(f) {
			return false, nil
		}
	}
	for _, f := range c.NotFlag {
		if m.flags.has(f) {
			return false, nil
		}
	}
	if c.Larger != 0 && m.msg.RFC822Size <= c.Larger {
		return false, nil
	}
	if c.Smaller != 0 && m.msg.RFC822Size >= c.Smaller {
		return false, nil
	}

	for _, field := range c.Header {
		ok, err := m.matchHeader(field.Key, field.Value)
		if err != nil {
			return false, err
		}
		if !ok {
			return false, nil
		}
	}

	if !c.SentSince.IsZero() || !c.SentBefore.IsZero() {
		t, err := m.sentDate()
		if err != nil {
			return false, err
		}
		if t.IsZero() || !matchDate(t, c.SentSince, c.SentBefore) {
			return false, nil
		}
	}

	// TEXT and BODY need the message body.
	for _, text := range c.Text {
		ok, err := m.matchText(text, true)
		if err != nil {
			return false, err
		}
		if !ok {
			return false, nil
		}
	}
	for _, body := range c.Body {
		ok, err := m.matchText(body, false)
		if err != nil {
			return false, err
		}
		if !ok {
			return false, nil
		}
	}

	for i := range c.Not {
		ok, err := m.match(&c.Not[i])
		if err != nil {
			return false, err
		}
		if ok {
			return false, nil
		}
	}
	for i := range c.Or {
		left, err := m.match(&c.Or[i][0])
		if err != nil {
			return false, err
		}
		if left {
			continue
		}
		right, err := m.match(&c.Or[i][1])
		if err != nil {
			return false, err
		}
		if !right {
			return false, nil
		}
	}

	return true, nil
}

// matchHeader implements the HEADER, FROM, TO, CC, BCC and SUBJECT keys.
// An empty pattern means "this header is present".
func (m *messageCriteria) matchHeader(key, pattern string) (bool, error) {
	lower := strings.ToLower(strings.TrimSpace(key))
	if _, ok := envelopeHeaderKeys[lower]; ok {
		return matchStrings(m.envelopeHeaderValues(lower), pattern), nil
	}

	ent, err := m.entity()
	if err != nil {
		return false, err
	}
	var values []string
	for fields := ent.Header.FieldsByKey(key); fields.Next(); {
		v, err := fields.Text()
		if err != nil {
			v = fields.Value()
		}
		values = append(values, v)
	}
	return matchStrings(values, pattern), nil
}

// envelopeHeaderValues renders the envelope fields that stand in for
// header text during SEARCH.
func (m *messageCriteria) envelopeHeaderValues(lowerKey string) []string {
	env := &m.msg.Envelope
	switch lowerKey {
	case "from":
		return addressTexts(env.From)
	case "to":
		return addressTexts(env.To)
	case "cc":
		return addressTexts(env.Cc)
	case "subject":
		return nonEmpty(env.Subject)
	case "message-id":
		return nonEmpty(env.MessageID)
	case "in-reply-to":
		return nonEmpty(env.InReplyTo)
	case "date":
		return nonEmpty(env.Date)
	default:
		return nil
	}
}

func (m *messageCriteria) sentDate() (time.Time, error) {
	if t, ok := parseDate(m.msg.Envelope.Date); ok {
		return t, nil
	}
	// The metadata payload had no usable Date; fall back to the message
	// itself rather than reporting a non-match we cannot justify.
	ent, err := m.entity()
	if err != nil {
		return time.Time{}, err
	}
	mh := mail.Header{Header: ent.Header}
	t, err := mh.Date()
	if err != nil {
		return time.Time{}, nil
	}
	return t, nil
}

// matchText implements BODY (body only) and TEXT (headers and body).
func (m *messageCriteria) matchText(pattern string, includeHeader bool) (bool, error) {
	if pattern == "" {
		return true, nil
	}
	ent, err := m.entity()
	if err != nil {
		return false, err
	}
	return matchEntity(ent, pattern, includeHeader), nil
}

func matchEntity(e *gomessage.Entity, pattern string, includeHeader bool) bool {
	if includeHeader && matchHeaderFields(e.Header.Fields(), pattern) {
		return true
	}

	if mr := e.MultipartReader(); mr != nil {
		for {
			part, err := mr.NextPart()
			if err == io.EOF {
				return false
			} else if err != nil {
				return false
			}
			if matchEntity(part, pattern, includeHeader) {
				return true
			}
		}
	}

	mediaType, _, err := e.Header.ContentType()
	if err != nil {
		return false
	}
	if !strings.HasPrefix(mediaType, "text/") && !strings.HasPrefix(mediaType, "message/") {
		return false
	}
	buf, err := io.ReadAll(e.Body)
	if err != nil {
		return false
	}
	return bytes.Contains(bytes.ToLower(buf), bytes.ToLower([]byte(pattern)))
}

func matchHeaderFields(fields gomessage.HeaderFields, pattern string) bool {
	if pattern == "" {
		return fields.Len() > 0
	}
	pattern = strings.ToLower(pattern)
	for fields.Next() {
		v, err := fields.Text()
		if err != nil {
			v = fields.Value()
		}
		if strings.Contains(strings.ToLower(v), pattern) {
			return true
		}
	}
	return false
}

// matchDate applies IMAP's zone-unaware date comparison (RFC 9051 requires
// the time and timezone to be ignored).
func matchDate(t, since, before time.Time) bool {
	t = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	if !since.IsZero() && t.Before(since) {
		return false
	}
	if !before.IsZero() && !t.Before(before) {
		return false
	}
	return true
}

func matchStrings(values []string, pattern string) bool {
	if pattern == "" {
		return len(values) > 0
	}
	pattern = strings.ToLower(pattern)
	for _, v := range values {
		if strings.Contains(strings.ToLower(v), pattern) {
			return true
		}
	}
	return false
}

// addressTexts renders envelope addresses the way they would appear in the
// header, so a substring search matches either the display name or the
// address.
func addressTexts(addrs []backend.Address) []string {
	out := make([]string, 0, len(addrs))
	for _, a := range addrs {
		switch {
		case a.Name != "" && a.Address != "":
			out = append(out, a.Name+" <"+a.Address+">")
		case a.Address != "":
			out = append(out, a.Address)
		case a.Name != "":
			out = append(out, a.Name)
		}
	}
	return out
}

func nonEmpty(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return []string{s}
}
