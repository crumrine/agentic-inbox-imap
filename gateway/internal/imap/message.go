// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"io"
	"net/mail"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"

	"github.com/crumrine/agentic-inbox/gateway/internal/backend"
)

// systemFlagByName maps a bare flag name (no leading backslash, lower
// case) to its canonical IMAP flag, so the gateway tolerates a backend that
// reports "Seen" or "\\seen" as readily as "\\Seen".
var systemFlagByName = map[string]imap.Flag{
	"seen":     imap.FlagSeen,
	"answered": imap.FlagAnswered,
	"flagged":  imap.FlagFlagged,
	"deleted":  imap.FlagDeleted,
	"draft":    imap.FlagDraft,
	"recent":   flagRecent,
}

// flagRecent is \Recent. The gateway never reports a message as recent
// (RECENT is always 0), so this exists only to recognise and drop the flag
// if the backend sends it.
const flagRecent = imap.Flag("\\Recent")

// normalizeFlag canonicalises one backend flag string. Unknown values are
// passed through as keywords rather than dropped: a custom keyword the
// gateway does not recognise is still the user's data.
func normalizeFlag(s string) imap.Flag {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	name := s
	if strings.HasPrefix(name, "\\") {
		name = name[1:]
	}
	if f, ok := systemFlagByName[strings.ToLower(name)]; ok {
		return f
	}
	return imap.Flag(s)
}

// imapFlags converts the backend's flag strings into the FLAGS list sent to
// a client. \Recent is dropped because the gateway always reports zero
// recent messages, and claiming both would be inconsistent.
func imapFlags(flags []string) []imap.Flag {
	out := make([]imap.Flag, 0, len(flags))
	seen := make(map[imap.Flag]struct{}, len(flags))
	for _, raw := range flags {
		f := normalizeFlag(raw)
		if f == "" || f == flagRecent {
			continue
		}
		if _, dup := seen[f]; dup {
			continue
		}
		seen[f] = struct{}{}
		out = append(out, f)
	}
	return out
}

// flagSet is a canonicalised set of a message's flags, for SEARCH.
type flagSet map[imap.Flag]struct{}

func newFlagSet(flags []string) flagSet {
	fs := make(flagSet, len(flags))
	for _, f := range imapFlags(flags) {
		fs[canonicalFlag(f)] = struct{}{}
	}
	return fs
}

func (fs flagSet) has(f imap.Flag) bool {
	_, ok := fs[canonicalFlag(f)]
	return ok
}

// canonicalFlag lower-cases a flag. IMAP system flags are case-insensitive
// and keywords are case-insensitive too (RFC 9051 section 2.3.2).
func canonicalFlag(f imap.Flag) imap.Flag {
	return imap.Flag(strings.ToLower(string(f)))
}

// envelopeFrom builds an IMAP ENVELOPE from the metadata payload, with no
// raw message needed. Sender and Reply-To are left nil: go-imap's encoder
// substitutes From for both, which is what RFC 9051 requires when the
// headers are absent.
func envelopeFrom(msg *backend.Message) *imap.Envelope {
	env := &imap.Envelope{
		Subject:   msg.Envelope.Subject,
		From:      imapAddresses(msg.Envelope.From),
		To:        imapAddresses(msg.Envelope.To),
		Cc:        imapAddresses(msg.Envelope.Cc),
		MessageID: trimAngles(msg.Envelope.MessageID),
	}
	if t, ok := parseDate(msg.Envelope.Date); ok {
		env.Date = t
	}
	if ref := trimAngles(msg.Envelope.InReplyTo); ref != "" {
		env.InReplyTo = []string{ref}
	}
	return env
}

func imapAddresses(addrs []backend.Address) []imap.Address {
	if len(addrs) == 0 {
		return nil
	}
	out := make([]imap.Address, 0, len(addrs))
	for _, a := range addrs {
		mbox, host, ok := strings.Cut(a.Address, "@")
		if !ok {
			// An address with no host is not representable in an IMAP
			// envelope address structure; go-imap's own extractor drops
			// these too.
			continue
		}
		out = append(out, imap.Address{Name: a.Name, Mailbox: mbox, Host: host})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// trimAngles strips the angle brackets around a message identifier.
// go-imap's encoder adds them back, so carrying them here would double
// them up.
func trimAngles(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "<")
	s = strings.TrimSuffix(s, ">")
	return s
}

// parseDate parses an RFC 5322 date string.
func parseDate(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	if t, err := mail.ParseDate(s); err == nil {
		return t, true
	}
	// Some producers emit RFC 3339 instead of RFC 5322.
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, true
	}
	return time.Time{}, false
}

// discard drains a reader, used to keep the connection in sync when a
// command's literal has to be thrown away.
func discard(r io.Reader) (int64, error) {
	return io.Copy(io.Discard, r)
}
