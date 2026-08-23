// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Package imap implements the IMAP protocol session for agentic-imapd. It
// plugs the Worker-backed client in internal/backend into
// github.com/emersion/go-imap/v2/imapserver.
//
// Scope: CAPABILITY, NOOP, LOGOUT, AUTHENTICATE PLAIN, LOGIN, LIST, LSUB,
// STATUS, SELECT, EXAMINE, CLOSE, UNSELECT, SEARCH, FETCH, IDLE, STORE of
// message flags, COPY, MOVE, EXPUNGE and APPEND. Only mailbox management
// (CREATE, DELETE, RENAME, SUBSCRIBE) still answers NO.
//
// The write commands are here because refusing them is not a survivable
// degradation. iOS Mail sets \Seen on display, deletes with
// \Deleted + EXPUNGE, and APPENDs to save a draft; a NO to any of them put
// it into a reconnect loop in which no message ever rendered.
//
// The session holds no durable state. The only thing it retains between
// commands is the selected folder's sequence-number snapshot and a bounded
// in-memory LRU of raw message bodies, both of which die with the
// connection.
//
// The snapshot grows append-only, from two callers sharing one
// implementation on purpose: Poll, which go-imap calls after every command,
// and Idle, which runs the same refresh on a timer while a client holds an
// IDLE open. See poll.
//
// It shrinks in exactly one place, Expunge, and only ever alongside the
// untagged EXPUNGE responses that tell the client to renumber too. A
// message that disappears for any other reason, such as a deletion in the
// web UI, stays in the snapshot and simply fails to fetch; letting Poll
// drop it would renumber the mailbox under a client that was never told.
// See mutate.go.
package imap

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"

	"github.com/crumrine/agentic-inbox-imap/gateway/internal/backend"
)

const (
	// mailboxDelim is the hierarchy delimiter reported to clients. The
	// Worker's folder namespace is flat today; the delimiter still has to
	// be a real character so clients can build a folder tree later.
	mailboxDelim = '/'

	// DefaultOperationTimeout bounds one logical IMAP command's worth of
	// backend calls. It is generous because a SELECT of a large folder is
	// one metadata call for the whole folder.
	DefaultOperationTimeout = 120 * time.Second

	// DefaultMaxSearchRawFetches bounds how many raw messages a single
	// SEARCH may download before the gateway gives up with NO [LIMIT].
	// Without it, "SEARCH BODY foo" on a 50k-message folder would pull the
	// entire archive through the Worker.
	DefaultMaxSearchRawFetches = 2000

	// DefaultPollInterval is the minimum wall time between two refreshes of
	// the selected folder. Poll runs after every authenticated command, so
	// without a floor a client streaming a few hundred FETCHes during an
	// initial sync would issue a folders call for each one.
	DefaultPollInterval = 5 * time.Second

	// DefaultMessagePageSize is the page size requested from the Worker's
	// metadata endpoint. It is stated explicitly on every call: an absent
	// limit is the server's *ceiling* (1000), not "everything", so relying
	// on the default silently truncates any larger folder.
	DefaultMessagePageSize = 1000

	// DefaultIdleInterval is how often an IDLE refreshes the selected
	// folder. It is much slower than DefaultPollInterval on purpose: a
	// command-driven poll is a floor on bursty traffic, whereas this one
	// runs unattended for up to 29 minutes, and 30s is the freshness a
	// mail client expects from a mailbox it is watching.
	DefaultIdleInterval = 30 * time.Second

	// DefaultMaxAppendBytes bounds a single APPEND. It matches
	// DefaultMaxMessageBytes deliberately: a message the gateway will
	// accept must also be one it can serve back, and the fetch path
	// refuses anything larger.
	//
	// go-imap enforces it before the literal is accepted, so an oversize
	// APPEND is refused with NO [TOOBIG] rather than uploaded and then
	// rejected. See Session.AppendLimit.
	DefaultMaxAppendBytes = DefaultMaxMessageBytes

	// DefaultMaxFolderMessages bounds how many messages one selection may
	// hold. IMAP requires the whole sequence-number mapping of the selected
	// folder to be known up front, so the snapshot cannot be lazy; this is
	// the point where a folder is too big for a stateless gateway to serve
	// and SELECT answers NO [LIMIT] instead of showing a prefix of it.
	DefaultMaxFolderMessages = 50000
)

// systemFlags is the FLAGS list advertised on SELECT/EXAMINE. The backend
// can also return arbitrary keywords per message; those are passed through
// on FETCH but not advertised here.
var systemFlags = []imap.Flag{
	imap.FlagSeen,
	imap.FlagAnswered,
	imap.FlagFlagged,
	imap.FlagDeleted,
	imap.FlagDraft,
}

// storableSystemFlags are the system flags STORE will persist.
//
// \Draft is absent because draft-ness is a property of the folder in the
// Worker's model, not a per-message flag, and \Recent is absent because it
// is not settable by definition (RFC 9051 section 2.3.2) and this gateway
// reports zero recent messages anyway. Both are ignored rather than
// rejected: a client that sets them is not doing anything wrong, and
// failing the command over one unsupported flag is how iOS Mail ends up in
// a reconnect loop.
var storableSystemFlags = []imap.Flag{
	imap.FlagSeen,
	imap.FlagAnswered,
	imap.FlagFlagged,
	imap.FlagDeleted,
}

// permanentFlags is the PERMANENTFLAGS list sent on SELECT/EXAMINE: the
// flags STORE persists, plus \* meaning custom keywords are accepted too.
//
// This is what a client reads to decide whether to attempt a STORE at all,
// so it has to match what Store actually does.
var permanentFlags = append(append([]imap.Flag{}, storableSystemFlags...), imap.FlagWildcard)

// storable reports whether STORE will act on a flag.
func storable(f imap.Flag) bool {
	if f == "" {
		return false
	}
	switch canonicalFlag(f) {
	case canonicalFlag(imap.FlagDraft), canonicalFlag(flagRecent):
		return false
	}
	return true
}

// selection is the frozen view of a folder taken at SELECT/EXAMINE time.
//
// IMAP sequence numbers are positions within the selected folder and must
// not shift for the life of the selection. The backend is UID-oriented, so
// the mapping lives here: msgs[i] has sequence number i+1, and msgs is
// sorted by ascending UID, which is the ordering IMAP requires.
type selection struct {
	// folderKey is the identifier used on the wire to the Worker.
	folderKey string
	// name is the mailbox name as the client should see it.
	name string

	uidValidity uint32
	uidNext     uint32

	// readOnly records that the client used EXAMINE rather than SELECT.
	// RFC 9051 section 6.3.2 makes an examined mailbox read-only, so STORE
	// is refused for the life of such a selection.
	readOnly bool

	msgs  []*backend.Message
	byUID map[uint32]*backend.Message
}

func (sel *selection) numMessages() uint32 { return uint32(len(sel.msgs)) }

// maxUID returns the highest UID in the snapshot, used to resolve "*" in a
// UID set. It is deliberately the highest UID present rather than
// uidNext-1: "*" means the largest number in use, and a folder whose newest
// message arrived after our snapshot must still resolve "*" inside the
// snapshot, or FETCH would report a message we cannot serve.
func (sel *selection) maxUID() uint32 {
	if len(sel.msgs) == 0 {
		return 0
	}
	return sel.msgs[len(sel.msgs)-1].UID
}

// appending returns a copy of the snapshot with newMsgs added to the tail
// and uidNext advanced. It never renumbers or drops an existing entry:
// sequence numbers must keep their meaning for the life of the selection,
// and a message that vanishes from the backend mid-session stays visible
// until the client re-selects. Removing it here would require EXPUNGE
// sequencing, which phase 1 does not implement.
//
// The result is a new *selection so that a Fetch or Search already
// iterating the old one keeps a consistent view.
func (sel *selection) appending(newMsgs []*backend.Message, uidNext uint32) *selection {
	msgs := make([]*backend.Message, len(sel.msgs), len(sel.msgs)+len(newMsgs))
	copy(msgs, sel.msgs)
	msgs = append(msgs, newMsgs...)

	byUID := make(map[uint32]*backend.Message, len(msgs))
	for _, m := range msgs {
		byUID[m.UID] = m
	}

	return &selection{
		folderKey:   sel.folderKey,
		name:        sel.name,
		uidValidity: sel.uidValidity,
		uidNext:     uidNext,
		readOnly:    sel.readOnly,
		msgs:        msgs,
		byUID:       byUID,
	}
}

// withFlags returns a copy of the snapshot with the given messages' flags
// replaced, so a FETCH FLAGS after a STORE in the same session agrees with
// what was just written.
//
// It never mutates an existing *backend.Message. A Fetch, Search or Idle
// already walking the previous selection holds pointers into it, and
// rewriting flags underneath them would be a data race; instead the
// affected entries are replaced with fresh values and the whole selection
// is swapped. Messages not named in results keep their existing pointer.
func (sel *selection) withFlags(results []backend.FlagResult) *selection {
	if len(results) == 0 {
		return sel
	}
	byResult := make(map[uint32][]string, len(results))
	for _, r := range results {
		byResult[r.UID] = r.Flags
	}

	msgs := make([]*backend.Message, len(sel.msgs))
	byUID := make(map[uint32]*backend.Message, len(sel.msgs))
	changed := false
	for i, msg := range sel.msgs {
		if flags, ok := byResult[msg.UID]; ok {
			updated := *msg
			updated.Flags = append([]string(nil), flags...)
			msgs[i] = &updated
			changed = true
		} else {
			msgs[i] = msg
		}
		byUID[msgs[i].UID] = msgs[i]
	}
	if !changed {
		return sel
	}

	return &selection{
		folderKey:   sel.folderKey,
		name:        sel.name,
		uidValidity: sel.uidValidity,
		uidNext:     sel.uidNext,
		readOnly:    sel.readOnly,
		msgs:        msgs,
		byUID:       byUID,
	}
}

// withoutUIDs returns a copy of the snapshot with the given messages
// removed, which renumbers every message after each removal.
//
// This is the one operation that shrinks a selection, and it exists only
// because the client asked for it. Everything else about the snapshot is
// append-only precisely so that sequence numbers cannot move under a
// client's feet; here they must, and the caller is responsible for having
// already told the client via untagged EXPUNGE responses.
//
// Like withFlags it is copy-on-write: a Fetch, Search or Idle walking the
// previous selection keeps a consistent view of it.
func (sel *selection) withoutUIDs(uids []uint32) *selection {
	if len(uids) == 0 {
		return sel
	}
	drop := make(map[uint32]struct{}, len(uids))
	for _, uid := range uids {
		drop[uid] = struct{}{}
	}

	msgs := make([]*backend.Message, 0, len(sel.msgs))
	for _, msg := range sel.msgs {
		if _, gone := drop[msg.UID]; gone {
			continue
		}
		msgs = append(msgs, msg)
	}
	if len(msgs) == len(sel.msgs) {
		return sel
	}

	byUID := make(map[uint32]*backend.Message, len(msgs))
	for _, msg := range msgs {
		byUID[msg.UID] = msg
	}

	return &selection{
		folderKey:   sel.folderKey,
		name:        sel.name,
		uidValidity: sel.uidValidity,
		// UIDNEXT never goes backwards: the UIDs just freed are not reused.
		uidNext:  sel.uidNext,
		readOnly: sel.readOnly,
		msgs:     msgs,
		byUID:    byUID,
	}
}

// seqNumsFor maps UIDs to their sequence numbers in this snapshot,
// descending. UIDs the snapshot does not hold are skipped: the client was
// never told about them, so there is no sequence number to report.
//
// Descending is what makes untagged EXPUNGE safe to emit without
// arithmetic. Each EXPUNGE renumbers every message after it, so removing
// the highest first leaves the lower numbers still valid. See Expunge.
func (sel *selection) seqNumsFor(uids []uint32) []uint32 {
	if len(uids) == 0 {
		return nil
	}
	want := make(map[uint32]struct{}, len(uids))
	for _, uid := range uids {
		want[uid] = struct{}{}
	}

	// Walking msgs in order yields ascending sequence numbers, so a
	// straight reverse is all that is needed; no sort.
	seqNums := make([]uint32, 0, len(uids))
	for i, msg := range sel.msgs {
		if _, ok := want[msg.UID]; ok {
			seqNums = append(seqNums, uint32(i+1))
		}
	}
	for i, j := 0, len(seqNums)-1; i < j; i, j = i+1, j-1 {
		seqNums[i], seqNums[j] = seqNums[j], seqNums[i]
	}
	return seqNums
}

// firstUnseenSeqNum returns the sequence number of the first message
// without \Seen, or 0 if every message is seen.
func (sel *selection) firstUnseenSeqNum() uint32 {
	for i, msg := range sel.msgs {
		if !newFlagSet(msg.Flags).has(imap.FlagSeen) {
			return uint32(i + 1)
		}
	}
	return 0
}

// Session implements imapserver.Session against the Worker API.
//
// It is driven by a single connection goroutine, but Poll may be called
// from the IDLE goroutine, so all mutable state is guarded.
type Session struct {
	backend Backend
	store   MessageStore

	// ownedCache is non-nil when this session built its own default
	// MessageStore, so Close can release the buffered bodies.
	ownedCache *rawCache

	opTimeout           time.Duration
	maxSearchRawFetches int
	pollInterval        time.Duration
	idleInterval        time.Duration
	messagePageSize     int
	maxFolderMessages   int
	maxAppendBytes      int64

	// logger records backend trouble that the session deliberately hides
	// from the client, such as a failed refresh during Poll. It never
	// receives a password: Login is the only method handed one, and it
	// does not log.
	logger *slog.Logger

	mu       sync.Mutex
	mailbox  string
	sel      *selection
	lastPoll time.Time
}

// Option configures a Session built by NewSession.
type Option func(*Session)

// WithMessageStore replaces the default raw-message store. Intended for
// tests and for the eventual server-precomputed BODYSTRUCTURE backend.
func WithMessageStore(store MessageStore) Option {
	return func(s *Session) {
		s.store = store
		s.ownedCache = nil
	}
}

// WithOperationTimeout overrides the per-command backend timeout.
func WithOperationTimeout(d time.Duration) Option {
	return func(s *Session) {
		if d > 0 {
			s.opTimeout = d
		}
	}
}

// WithMaxSearchRawFetches overrides how many raw message downloads a single
// SEARCH may perform before returning NO [LIMIT].
func WithMaxSearchRawFetches(n int) Option {
	return func(s *Session) { s.maxSearchRawFetches = n }
}

// WithPollInterval overrides the minimum time between refreshes of the
// selected folder. Zero refreshes on every Poll, which is what the tests
// want and what a very low-traffic deployment could afford.
func WithPollInterval(d time.Duration) Option {
	return func(s *Session) {
		if d >= 0 {
			s.pollInterval = d
		}
	}
}

// WithIdleInterval overrides how often IDLE refreshes the selected folder.
//
// The refresh still passes through the WithPollInterval floor, which is a
// global minimum spacing between backend refreshes of one folder. Setting
// an idle interval below that floor therefore does nothing useful; tests
// that want a fast idle should set both.
func WithIdleInterval(d time.Duration) Option {
	return func(s *Session) {
		if d > 0 {
			s.idleInterval = d
		}
	}
}

// WithMessagePageSize overrides the page size used when listing folder
// metadata. Values above the Worker's own ceiling are harmless: the paging
// loop terminates on an empty page, not on a short one.
func WithMessagePageSize(n int) Option {
	return func(s *Session) {
		if n > 0 {
			s.messagePageSize = n
		}
	}
}

// WithMaxFolderMessages overrides how many messages a single selection may
// hold before SELECT gives up with NO [LIMIT].
func WithMaxFolderMessages(n int) Option {
	return func(s *Session) {
		if n > 0 {
			s.maxFolderMessages = n
		}
	}
}

// WithMaxAppendBytes overrides the largest message APPEND will accept.
func WithMaxAppendBytes(n int64) Option {
	return func(s *Session) {
		if n > 0 {
			s.maxAppendBytes = n
		}
	}
}

// WithLogger sets the logger used for backend failures the session swallows
// rather than surfacing to the client.
func WithLogger(l *slog.Logger) Option {
	return func(s *Session) {
		if l != nil {
			s.logger = l
		}
	}
}

// NewSession constructs a Session bound to the given backend. The session
// starts in the not-authenticated state.
func NewSession(b Backend, opts ...Option) *Session {
	store := newCachedStore(b, DefaultMaxCachedMessages, DefaultMaxCacheBytes, DefaultMaxMessageBytes)
	s := &Session{
		backend:             b,
		store:               store,
		ownedCache:          store.cache,
		opTimeout:           DefaultOperationTimeout,
		maxSearchRawFetches: DefaultMaxSearchRawFetches,
		pollInterval:        DefaultPollInterval,
		idleInterval:        DefaultIdleInterval,
		messagePageSize:     DefaultMessagePageSize,
		maxFolderMessages:   DefaultMaxFolderMessages,
		maxAppendBytes:      DefaultMaxAppendBytes,
		logger:              slog.New(slog.DiscardHandler),
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// context returns a per-operation context. imapserver.Session's methods
// take no context, so each command gets its own bounded one.
func (s *Session) context() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), s.opTimeout)
}

// snapshot returns the authenticated mailbox and the current selection.
func (s *Session) snapshot() (string, *selection) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.mailbox, s.sel
}

// ---------------------------------------------------------------------
// Not-authenticated state
// ---------------------------------------------------------------------

// Login verifies an app password against the Worker.
//
// password is never logged, never wrapped into a returned error, and never
// stored on the Session. mapBackendError builds every returned error from
// constant text, so no code path can put credential material on the wire or
// in the server log.
func (s *Session) Login(username, password string) error {
	ctx, cancel := s.context()
	defer cancel()

	res, err := s.backend.Authenticate(ctx, username, password)
	if err != nil {
		// A 404 from the auth endpoint means "no such mailbox", which is
		// an authentication failure as far as the client is concerned; do
		// not disclose which mailboxes exist.
		mapped := mapBackendError(err, "Authentication failed")
		if imapErr, ok := mapped.(*imap.Error); ok && imapErr.Code == imap.ResponseCodeNonExistent {
			return imapserver.ErrAuthFailed
		}
		return mapped
	}

	mailbox := username
	if res != nil && res.Mailbox != "" {
		mailbox = res.Mailbox
	}

	s.mu.Lock()
	s.mailbox = mailbox
	s.sel = nil
	s.mu.Unlock()
	return nil
}

// Close releases session resources. It is called once per connection on
// teardown and must not fail, or go-imap logs a spurious error.
func (s *Session) Close() error {
	s.mu.Lock()
	s.sel = nil
	s.mailbox = ""
	s.mu.Unlock()
	if s.ownedCache != nil {
		s.ownedCache.purge()
	}
	return nil
}

// ---------------------------------------------------------------------
// Authenticated state
// ---------------------------------------------------------------------

// folderKey returns the identifier used in Worker URLs for a folder. The
// Worker's folder records carry both a stable id and a display name; the id
// is what the API path expects. Keeping this in one function is what makes
// the choice reversible.
func folderKey(f *backend.Folder) string {
	if f.ID != "" {
		return f.ID
	}
	return f.Name
}

// folderIMAPName returns the mailbox name a client should see. IMAP
// requires the inbox to be named INBOX, case-insensitively; the Worker may
// well call it "Inbox".
func folderIMAPName(f *backend.Folder) string {
	if strings.EqualFold(f.Name, "INBOX") {
		return "INBOX"
	}
	return f.Name
}

// mailboxNameEqual compares two mailbox names with IMAP's rule: INBOX is
// case-insensitive, everything else is case-sensitive.
func mailboxNameEqual(a, b string) bool {
	if strings.EqualFold(a, "INBOX") || strings.EqualFold(b, "INBOX") {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// lookupFolder finds a folder by the mailbox name a client used.
func (s *Session) lookupFolder(ctx context.Context, mailbox, name string) (*backend.Folder, error) {
	folders, err := s.backend.Folders(ctx, mailbox)
	if err != nil {
		return nil, mapBackendError(err, "Mailbox does not exist")
	}
	for i := range folders {
		if mailboxNameEqual(folderIMAPName(&folders[i]), name) {
			return &folders[i], nil
		}
	}
	return nil, &imap.Error{
		Type: imap.StatusResponseTypeNo,
		Code: imap.ResponseCodeNonExistent,
		Text: "Mailbox does not exist",
	}
}

// listMessages pages the Worker's metadata endpoint from sinceUID (which
// the API treats as inclusive) to the end of the folder, and returns every
// message plus the folder's UIDNEXT.
//
// Paging is mandatory, not an optimisation. The endpoint clamps an absent
// or over-large limit to a server-side ceiling, so a single call returns
// the *oldest* page of a large folder and nothing else. Selecting on that
// would report a wrong EXISTS and hide every newer message permanently,
// because the snapshot's uidNext would already be past them.
//
// Termination is on a page that yields no new message, deliberately rather
// than on a short page: the server may clamp the page size below what was
// asked for, in which case a "short" page is really a full one. That costs
// one extra round trip per listing and buys correctness under clamping,
// under tail deletions (which leave uidNext far above the highest live
// UID), and against a stale uidNext.
//
// budget caps the number of messages accumulated; exceeding it is an error
// rather than a truncation, because a truncated listing is exactly the bug
// this function exists to prevent.
func (s *Session) listMessages(ctx context.Context, mailbox, folder string, sinceUID uint32, budget int) ([]backend.Message, uint32, error) {
	pageSize := s.messagePageSize
	if pageSize <= 0 {
		pageSize = DefaultMessagePageSize
	}

	var (
		all      []backend.Message
		uidNext  uint32
		lastUID  uint32
		haveLast bool
	)

	for {
		page, err := s.backend.Messages(ctx, mailbox, folder, backend.MessagesOptions{
			SinceUID: sinceUID,
			Limit:    pageSize,
		})
		if err != nil {
			return nil, 0, err
		}
		if page.UIDNext > uidNext {
			uidNext = page.UIDNext
		}

		// Count only messages that move us forward. A backend that ignores
		// sinceUid would otherwise replay the same page forever.
		fresh := 0
		for i := range page.Messages {
			msg := page.Messages[i]
			if haveLast && msg.UID <= lastUID {
				continue
			}
			all = append(all, msg)
			lastUID = msg.UID
			haveLast = true
			fresh++
		}

		if budget > 0 && len(all) > budget {
			return nil, 0, errFolderTooLarge
		}
		if fresh == 0 {
			break
		}
		if lastUID == math.MaxUint32 {
			break
		}
		sinceUID = lastUID + 1
	}

	if haveLast && uidNext <= lastUID {
		uidNext = lastUID + 1
	}
	return all, uidNext, nil
}

// Select implements SELECT and EXAMINE.
//
// This is where the sequence-number snapshot is built. Nothing else in the
// session may reorder or resize it.
func (s *Session) Select(mailbox string, options *imap.SelectOptions) (*imap.SelectData, error) {
	if options != nil && options.CondStore {
		return nil, errUnsupported("CONDSTORE")
	}

	name, _ := s.snapshot()
	if name == "" {
		return nil, errNotAuthenticated
	}

	ctx, cancel := s.context()
	defer cancel()

	folder, err := s.lookupFolder(ctx, name, mailbox)
	if err != nil {
		return nil, err
	}

	key := folderKey(folder)
	listed, listedUIDNext, err := s.listMessages(ctx, name, key, 0, s.maxFolderMessages)
	if err != nil {
		return nil, mapBackendError(err, "Mailbox does not exist")
	}

	msgs := make([]*backend.Message, 0, len(listed))
	for i := range listed {
		msgs = append(msgs, &listed[i])
	}
	// IMAP requires ascending UID order; do not trust the Worker to have
	// sorted, because getting this wrong is exactly how a client ends up
	// displaying the wrong message for a sequence number.
	sort.Slice(msgs, func(i, j int) bool { return msgs[i].UID < msgs[j].UID })

	byUID := make(map[uint32]*backend.Message, len(msgs))
	for _, m := range msgs {
		byUID[m.UID] = m
	}

	uidNext := listedUIDNext
	if uidNext == 0 {
		uidNext = folder.UIDNext
	}
	if len(msgs) > 0 && uidNext <= msgs[len(msgs)-1].UID {
		uidNext = msgs[len(msgs)-1].UID + 1
	}

	sel := &selection{
		folderKey:   key,
		name:        folderIMAPName(folder),
		uidValidity: folder.UIDValidity,
		uidNext:     uidNext,
		readOnly:    options != nil && options.ReadOnly,
		msgs:        msgs,
		byUID:       byUID,
	}

	s.mu.Lock()
	s.sel = sel
	// The snapshot is brand new; there is nothing for the next Poll to
	// discover for at least one interval.
	s.lastPoll = time.Now()
	s.mu.Unlock()

	// An examined mailbox cannot be changed, so it must not claim
	// otherwise: PERMANENTFLAGS is what a client reads to decide whether to
	// attempt a STORE at all.
	permanent := permanentFlags
	if sel.readOnly {
		permanent = []imap.Flag{}
	}

	return &imap.SelectData{
		Flags:             systemFlags,
		PermanentFlags:    permanent,
		NumMessages:       sel.numMessages(),
		NumRecent:         0,
		FirstUnseenSeqNum: sel.firstUnseenSeqNum(),
		UIDNext:           imap.UID(sel.uidNext),
		UIDValidity:       sel.uidValidity,
	}, nil
}

// Unselect drops the current selection. CLOSE and UNSELECT both land here.
func (s *Session) Unselect() error {
	s.mu.Lock()
	s.sel = nil
	s.mu.Unlock()
	return nil
}

// listWriter is the subset of *imapserver.ListWriter this package uses.
// Extracting it lets LIST and LSUB be tested without a live connection,
// since imapserver.ListWriter can only be built by the server itself.
type listWriter interface {
	WriteList(data *imap.ListData) error
}

// List implements LIST and LSUB. Every folder is treated as subscribed:
// the Worker has no per-client subscription concept, and hiding folders
// from LSUB would make them invisible in clients that only issue LSUB.
func (s *Session) List(w *imapserver.ListWriter, ref string, patterns []string, options *imap.ListOptions) error {
	return s.listInto(w, ref, patterns, options)
}

func (s *Session) listInto(w listWriter, ref string, patterns []string, options *imap.ListOptions) error {
	mailbox, _ := s.snapshot()
	if mailbox == "" {
		return errNotAuthenticated
	}
	if len(patterns) == 0 {
		// RFC 9051: an empty pattern is a request for the delimiter.
		return w.WriteList(&imap.ListData{
			Attrs:   []imap.MailboxAttr{imap.MailboxAttrNoSelect},
			Delim:   mailboxDelim,
			Mailbox: "",
		})
	}

	ctx, cancel := s.context()
	defer cancel()

	folders, err := s.backend.Folders(ctx, mailbox)
	if err != nil {
		return mapBackendError(err, "Mailbox does not exist")
	}

	for i := range folders {
		folder := &folders[i]
		name := folderIMAPName(folder)

		matched := false
		for _, pattern := range patterns {
			if imapserver.MatchList(name, mailboxDelim, ref, pattern) {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}
		if options != nil && options.SelectSpecialUse && specialUseAttr(name) == "" {
			continue
		}

		data := &imap.ListData{
			Delim:   mailboxDelim,
			Mailbox: name,
		}
		if options != nil && (options.SelectSubscribed || options.ReturnSubscribed) {
			data.Attrs = append(data.Attrs, imap.MailboxAttrSubscribed)
		}
		if options != nil && options.ReturnChildren {
			data.Attrs = append(data.Attrs, imap.MailboxAttrHasNoChildren)
		}
		if options != nil && (options.ReturnSpecialUse || options.SelectSpecialUse) {
			if attr := specialUseAttr(name); attr != "" {
				data.Attrs = append(data.Attrs, attr)
			}
		}
		if options != nil && options.ReturnStatus != nil {
			status, err := s.statusFor(ctx, mailbox, folder, options.ReturnStatus)
			if err != nil {
				return err
			}
			data.Status = status
		}

		if err := w.WriteList(data); err != nil {
			return err
		}
	}
	return nil
}

// specialUseAttr guesses a folder's special-use role from its name. The
// Worker does not record roles yet; a wrong guess here only affects which
// icon a client draws, never which messages it shows.
func specialUseAttr(name string) imap.MailboxAttr {
	switch strings.ToLower(name) {
	case "sent", "sent items", "sent messages":
		return imap.MailboxAttrSent
	case "drafts", "draft":
		return imap.MailboxAttrDrafts
	case "trash", "deleted items", "deleted messages":
		return imap.MailboxAttrTrash
	case "junk", "spam":
		return imap.MailboxAttrJunk
	case "archive":
		return imap.MailboxAttrArchive
	default:
		return ""
	}
}

// Status implements STATUS.
//
// Every requested field must be populated: go-imap's STATUS encoder
// dereferences the pointer fields for whichever items the client asked for,
// so leaving one nil is a server panic, not a missing item.
func (s *Session) Status(mailbox string, options *imap.StatusOptions) (*imap.StatusData, error) {
	name, _ := s.snapshot()
	if name == "" {
		return nil, errNotAuthenticated
	}
	if options != nil && options.HighestModSeq {
		return nil, errUnsupported("STATUS HIGHESTMODSEQ (CONDSTORE)")
	}

	ctx, cancel := s.context()
	defer cancel()

	folder, err := s.lookupFolder(ctx, name, mailbox)
	if err != nil {
		return nil, err
	}
	return s.statusFor(ctx, name, folder, options)
}

func (s *Session) statusFor(ctx context.Context, mailbox string, folder *backend.Folder, options *imap.StatusOptions) (*imap.StatusData, error) {
	data := &imap.StatusData{Mailbox: folderIMAPName(folder)}
	if options == nil {
		return data, nil
	}

	if options.NumMessages {
		n := folder.Exists
		data.NumMessages = &n
	}
	if options.NumRecent {
		n := folder.Recent
		data.NumRecent = &n
	}
	if options.NumUnseen {
		n := folder.Unseen
		data.NumUnseen = &n
	}
	if options.NumDeleted {
		// Read-only: no message can carry \Deleted.
		var n uint32
		data.NumDeleted = &n
	}
	if options.UIDNext {
		data.UIDNext = imap.UID(folder.UIDNext)
	}
	if options.UIDValidity {
		data.UIDValidity = folder.UIDValidity
	}
	if options.DeletedStorage {
		var n int64
		data.DeletedStorage = &n
	}
	if options.Size {
		// SIZE is the only STATUS item the folders payload cannot answer,
		// so it costs a full metadata listing. It has to be the *whole*
		// folder: STATUS SIZE is reported as an exact byte count, and
		// summing one capped page would present a fraction of the real
		// figure as if it were exact.
		messages, _, err := s.listMessages(ctx, mailbox, folderKey(folder), 0, s.maxFolderMessages)
		if err != nil {
			return nil, mapBackendError(err, "Mailbox does not exist")
		}
		var total int64
		for i := range messages {
			total += messages[i].RFC822Size
		}
		data.Size = &total
	}
	return data, nil
}

// updateWriter is the subset of *imapserver.UpdateWriter this package uses.
// Extracting it lets Poll be tested without a live connection, since
// imapserver.UpdateWriter can only be built by the server itself.
type updateWriter interface {
	WriteNumMessages(n uint32) error
}

// Poll delivers unilateral updates after a command. go-imap calls it after
// every command in the authenticated and selected states, which is how a
// client that is not idling learns that new mail arrived.
//
// It refreshes the selected folder append-only. New messages extend the
// snapshot and produce an EXISTS; nothing already in the snapshot is ever
// renumbered or removed, because shrinking a mailbox mid-session needs
// EXPUNGE sequencing that phase 1 does not implement.
//
// A backend failure is never propagated. Poll runs after every command, so
// returning an error here would turn a transient Worker hiccup into a
// failure of whatever the client just asked for; the session logs it and
// carries on with the snapshot it already has.
func (s *Session) Poll(w *imapserver.UpdateWriter, allowExpunge bool) error {
	// Guard against handing poll a non-nil interface wrapping a nil
	// pointer, which would nil-deref on the first write.
	var uw updateWriter
	if w != nil {
		uw = w
	}
	return s.poll(context.Background(), uw)
}

// poll is the single implementation of "refresh the selection and tell the
// client if it grew". Both Poll and Idle go through it, deliberately: two
// copies of the append-only growth rules would drift, and the failure that
// drift produces is a client showing the wrong message for a sequence
// number.
//
// parent lets a caller cancel an in-flight refresh. Poll passes a
// background context because go-imap is waiting on it anyway; Idle passes
// one wired to its stop channel so a DONE is not held up by a slow backend.
func (s *Session) poll(parent context.Context, w updateWriter) error {
	mailbox, sel, ok := s.beginPoll()
	if !ok {
		return nil
	}

	ctx, cancel := context.WithTimeout(parent, s.opTimeout)
	defer cancel()

	grown, ok := s.refresh(ctx, mailbox, sel)
	if !ok {
		return nil
	}

	// Only announce a count that actually changed. Repeating EXISTS with
	// the same number is legal but makes some clients re-sync for nothing.
	if w == nil || grown.numMessages() == sel.numMessages() {
		return nil
	}
	// A write failure is a broken connection, not a backend problem: the
	// response stream may now be half-written, and continuing to write
	// into a desynchronised stream is worse than stopping. Unlike every
	// other error here, it propagates.
	return w.WriteNumMessages(grown.numMessages())
}

// invalidatePollFloor clears the interval floor so the very next Poll does
// real work. Used after this session changes the selected folder itself,
// where waiting out the floor would mean the client is told about its own
// APPEND seconds late or not at all.
func (s *Session) invalidatePollFloor() {
	s.mu.Lock()
	s.lastPoll = time.Time{}
	s.mu.Unlock()
}

// beginPoll decides whether this Poll should do any work, and records the
// attempt so the interval floor applies to failures too.
func (s *Session) beginPoll() (mailbox string, sel *selection, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.mailbox == "" || s.sel == nil {
		return "", nil, false
	}
	if s.pollInterval > 0 && time.Since(s.lastPoll) < s.pollInterval {
		return "", nil, false
	}
	s.lastPoll = time.Now()
	return s.mailbox, s.sel, true
}

// refresh looks for messages appended since sel was taken and, if it finds
// any, installs a grown snapshot. It returns the snapshot now in force and
// whether the refresh completed; on any backend trouble it returns false
// and leaves the existing snapshot untouched.
func (s *Session) refresh(ctx context.Context, mailbox string, sel *selection) (*selection, bool) {
	folders, err := s.backend.Folders(ctx, mailbox)
	if err != nil {
		s.logger.Warn("imap: refreshing folder list during poll failed, serving the existing snapshot",
			"mailbox", mailbox, "folder", sel.folderKey, "err", err)
		return nil, false
	}

	var folder *backend.Folder
	for i := range folders {
		if folderKey(&folders[i]) == sel.folderKey {
			folder = &folders[i]
			break
		}
	}
	if folder == nil {
		// The folder was deleted underneath us. Reporting that needs a
		// mailbox-closed response the session cannot send from Poll, so
		// keep serving the snapshot until the client re-selects.
		s.logger.Warn("imap: selected folder is gone from the backend, keeping the existing snapshot",
			"mailbox", mailbox, "folder", sel.folderKey)
		return nil, false
	}
	if folder.UIDValidity != sel.uidValidity {
		// UIDVALIDITY changed, so every UID the client holds is stale. The
		// only correct recovery is a re-SELECT, which the client must
		// initiate; growing the snapshot across the boundary would hand
		// out UIDs from two different generations of the folder.
		s.logger.Warn("imap: UIDVALIDITY changed mid-session, the client must reselect",
			"mailbox", mailbox, "folder", sel.folderKey,
			"selected", sel.uidValidity, "current", folder.UIDValidity)
		return nil, false
	}

	// The cheap check: if the folder has not issued a UID past the one we
	// already know about, nothing was appended and no metadata call is
	// needed. This is the common case on every NOOP.
	if folder.UIDNext <= sel.uidNext {
		return sel, true
	}

	// Page the tail, for the same reason SELECT does: a burst of more than
	// one page of new mail would otherwise be half-read, and the advanced
	// uidNext would hide the remainder for the life of the selection.
	budget := s.maxFolderMessages - len(sel.msgs)
	if budget <= 0 {
		s.logger.Warn("imap: selection is already at the message limit, not growing it",
			"mailbox", mailbox, "folder", sel.folderKey, "messages", len(sel.msgs))
		return nil, false
	}
	listed, listedUIDNext, err := s.listMessages(ctx, mailbox, sel.folderKey, sel.uidNext, budget)
	if err != nil {
		s.logger.Warn("imap: fetching new message metadata during poll failed, serving the existing snapshot",
			"mailbox", mailbox, "folder", sel.folderKey, "sinceUid", sel.uidNext, "err", err)
		return nil, false
	}

	appended := appendedMessages(sel, listed)
	uidNext := nextUID(sel, folder, listedUIDNext, appended)
	if len(appended) == 0 {
		// uidNext moved but nothing is visible to us yet (the message was
		// deleted again, or is not ours to see). Record the advance so the
		// next poll does not re-run the same listing.
		if uidNext > sel.uidNext {
			s.installGrown(sel, sel.appending(nil, uidNext))
		}
		return sel, true
	}

	grown := sel.appending(appended, uidNext)
	s.installGrown(sel, grown)
	return grown, true
}

// appendedMessages picks out the messages that may be added to the tail of
// the snapshot: strictly newer than every UID already in it, and not
// already present. Sorting matters because sequence numbers are positions
// in ascending UID order.
//
// A message whose UID is lower than the current maximum is skipped rather
// than inserted. Inserting it would shift the sequence number of every
// message after it, which is precisely the renumbering that breaks clients.
// It becomes visible on the next SELECT.
func appendedMessages(sel *selection, candidates []backend.Message) []*backend.Message {
	maxUID := sel.maxUID()

	out := make([]*backend.Message, 0, len(candidates))
	for i := range candidates {
		msg := &candidates[i]
		if msg.UID <= maxUID {
			continue
		}
		if _, dup := sel.byUID[msg.UID]; dup {
			continue
		}
		out = append(out, msg)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UID < out[j].UID })

	// Defend against a backend that returns the same UID twice.
	deduped := out[:0]
	var prev uint32
	for _, msg := range out {
		if len(deduped) > 0 && msg.UID == prev {
			continue
		}
		deduped = append(deduped, msg)
		prev = msg.UID
	}
	return deduped
}

// nextUID picks the UIDNEXT to record on the grown snapshot. It only ever
// moves forward, so a backend that briefly reports a lower value cannot
// make the session re-listen to UIDs it has already seen.
func nextUID(sel *selection, folder *backend.Folder, listedUIDNext uint32, appended []*backend.Message) uint32 {
	uidNext := sel.uidNext
	if listedUIDNext > uidNext {
		uidNext = listedUIDNext
	}
	if folder.UIDNext > uidNext {
		uidNext = folder.UIDNext
	}
	if n := len(appended); n > 0 && appended[n-1].UID >= uidNext {
		uidNext = appended[n-1].UID + 1
	}
	return uidNext
}

// installGrown swaps in the grown snapshot, unless a SELECT replaced the
// selection while the refresh was in flight.
func (s *Session) installGrown(previous, grown *selection) {
	s.mu.Lock()
	if s.sel == previous {
		s.sel = grown
	}
	s.mu.Unlock()
}

// Idle implements IDLE by polling the backend until the client sends DONE.
//
// It must block until stop closes. go-imap writes the "+ idling"
// continuation before calling this and then waits on the socket for DONE,
// so an Idle that returns early does not reach the client: the response
// sits undelivered until the client gives up waiting for updates and sends
// DONE anyway, at which point it receives a completion for a command it
// thought was healthy. Returning an error here is what hung iOS Mail on
// "Checking for Mail".
//
// Refusing IDLE is not an option either. imapserver.availableCaps()
// appends it unconditionally whenever IMAP4rev1 is enabled, so real
// clients will always use it.
//
// The polling is the same refresh Poll performs, on a slower timer.
// DEV-674 tracks replacing it with a push channel from the Durable Object,
// which is the right answer; this is the one that makes clients work now.
func (s *Session) Idle(w *imapserver.UpdateWriter, stop <-chan struct{}) error {
	var uw updateWriter
	if w != nil {
		uw = w
	}
	return s.idle(uw, stop)
}

func (s *Session) idle(w updateWriter, stop <-chan struct{}) error {
	if stop == nil {
		// go-imap always supplies a channel. A nil one would mean blocking
		// forever with no way out, so fail fast rather than wedge a
		// connection.
		return nil
	}

	interval := s.idleInterval
	if interval <= 0 {
		interval = DefaultIdleInterval
	}

	// Bind a context to stop so a refresh already in flight is abandoned
	// when DONE arrives, instead of making the client wait out a slow
	// backend call. The watcher exits by either branch, so it cannot leak.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-stop:
			cancel()
		case <-ctx.Done():
		}
	}()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		// Check stop before doing any work, so a DONE that arrives during
		// the previous refresh is honoured immediately.
		select {
		case <-stop:
			return nil
		default:
		}

		// One refresh on entry as well as on every tick: mail may already
		// have arrived between SELECT and IDLE, and the post-SELECT Poll
		// would have been inside the interval floor and skipped it.
		if err := s.poll(ctx, w); err != nil {
			// Only a failed write reaches here; a backend failure is
			// swallowed inside poll. The connection is unusable, so there
			// is nothing to keep idling for.
			return err
		}

		select {
		case <-stop:
			return nil
		case <-ticker.C:
		}
	}
}

// ---------------------------------------------------------------------
// Selected state
// ---------------------------------------------------------------------

// staticNumSet resolves "*" against the snapshot, so a dynamic set becomes
// a concrete one before it is used to pick messages.
func (sel *selection) staticNumSet(numSet imap.NumSet) imap.NumSet {
	switch set := numSet.(type) {
	case imap.SeqSet:
		out := make(imap.SeqSet, len(set))
		copy(out, set)
		max := sel.numMessages()
		for i := range out {
			staticNumRange(&out[i].Start, &out[i].Stop, max)
		}
		return out
	case imap.UIDSet:
		out := make(imap.UIDSet, len(set))
		copy(out, set)
		max := sel.maxUID()
		for i := range out {
			staticNumRange((*uint32)(&out[i].Start), (*uint32)(&out[i].Stop), max)
		}
		return out
	default:
		return numSet
	}
}

func staticNumRange(start, stop *uint32, max uint32) {
	dyn := false
	if *start == 0 {
		*start = max
		dyn = true
	}
	if *stop == 0 {
		*stop = max
		dyn = true
	}
	if dyn && *start > *stop {
		*start, *stop = *stop, *start
	}
}

// forEach walks the snapshot in sequence order, invoking f for every
// message the number set selects. f receives the 1-based sequence number,
// which is the number the client must see in the response.
func (sel *selection) forEach(numSet imap.NumSet, f func(seqNum uint32, msg *backend.Message) error) error {
	static := sel.staticNumSet(numSet)
	for i, msg := range sel.msgs {
		seqNum := uint32(i + 1)

		var contains bool
		switch set := static.(type) {
		case imap.SeqSet:
			contains = set.Contains(seqNum)
		case imap.UIDSet:
			contains = set.Contains(imap.UID(msg.UID))
		}
		if !contains {
			continue
		}
		if err := f(seqNum, msg); err != nil {
			return err
		}
	}
	return nil
}

// fetchNeedsRaw reports whether any requested item can only be answered
// from the original message bytes. Metadata-only FETCHes must never trigger
// a raw download; a full-folder sync in Apple Mail is exactly that.
func fetchNeedsRaw(options *imap.FetchOptions) bool {
	return options.BodyStructure != nil ||
		len(options.BodySection) > 0 ||
		len(options.BinarySection) > 0 ||
		len(options.BinarySectionSize) > 0
}

// vanished reports whether err means "that UID is not there any more", as
// opposed to a genuine backend failure.
//
// The distinction matters because the snapshot is append-only while the app
// deletes and renumbers rows underneath it as a matter of routine: saving a
// draft is delete-then-create, and moving a message retires its UID in the
// source folder. A client's next "UID FETCH 1:* (BODY[])" therefore hits
// dead UIDs often, and RFC 9051 explicitly allows a server to omit a
// message that no longer exists from the response. Failing the whole
// command instead would drop every message after the first dead one, and
// keep doing so until the client re-selects.
func vanished(err error) bool {
	return errors.Is(err, backend.ErrNotFound)
}

func (s *Session) logVanished(mailbox, folder string, uid uint32) {
	s.logger.Debug("imap: message vanished from the backend, omitting it from the response",
		"mailbox", mailbox, "folder", folder, "uid", uid)
}

// Fetch implements FETCH and UID FETCH.
func (s *Session) Fetch(w *imapserver.FetchWriter, numSet imap.NumSet, options *imap.FetchOptions) error {
	mailbox, sel := s.snapshot()
	if sel == nil {
		return errNoMailboxSelected
	}
	if options.ModSeq || options.ChangedSince != 0 {
		return errUnsupported("FETCH MODSEQ / CHANGEDSINCE (CONDSTORE)")
	}
	if imap.IsSearchRes(numSet) {
		return errUnsupported("the SEARCHRES '$' marker")
	}

	needRaw := fetchNeedsRaw(options)

	ctx, cancel := s.context()
	defer cancel()

	return sel.forEach(numSet, func(seqNum uint32, msg *backend.Message) error {
		var entry rawData
		if needRaw {
			raw, err := s.store.Raw(ctx, mailbox, sel.folderKey, msg.UID)
			if err != nil {
				if vanished(err) {
					s.logVanished(mailbox, sel.folderKey, msg.UID)
					return nil
				}
				return mapBackendError(err, "Message no longer exists")
			}
			entry.raw = raw
			if options.BodyStructure != nil {
				bs, err := s.store.BodyStructure(ctx, mailbox, sel.folderKey, msg.UID)
				if err != nil {
					if vanished(err) {
						s.logVanished(mailbox, sel.folderKey, msg.UID)
						return nil
					}
					return mapBackendError(err, "Message no longer exists")
				}
				entry.bs = bs
			}
		}

		// CreateMessage takes the connection's write lock; Close releases
		// it. Every path below must reach Close or the connection wedges.
		rw := w.CreateMessage(seqNum)
		writeErr := writeMessage(rw, msg, options, entry)
		closeErr := rw.Close()
		if writeErr != nil {
			return writeErr
		}
		return closeErr
	})
}

// rawData carries the lazily fetched artifacts for one message through the
// fetch writer.
type rawData struct {
	raw []byte
	bs  imap.BodyStructure
}

func writeMessage(rw *imapserver.FetchResponseWriter, msg *backend.Message, options *imap.FetchOptions, data rawData) error {
	if options.UID {
		rw.WriteUID(imap.UID(msg.UID))
	}
	if options.Flags {
		rw.WriteFlags(imapFlags(msg.Flags))
	}
	if options.InternalDate {
		rw.WriteInternalDate(msg.InternalDate)
	}
	if options.RFC822Size {
		rw.WriteRFC822Size(msg.RFC822Size)
	}
	if options.Envelope {
		rw.WriteEnvelope(envelopeFrom(msg))
	}
	if options.BodyStructure != nil && data.bs != nil {
		rw.WriteBodyStructure(data.bs)
	}

	for _, section := range options.BodySection {
		buf := imapserver.ExtractBodySection(bytes.NewReader(data.raw), section)
		wc := rw.WriteBodySection(section, int64(len(buf)))
		_, writeErr := wc.Write(buf)
		closeErr := wc.Close()
		if writeErr != nil {
			return writeErr
		}
		if closeErr != nil {
			return closeErr
		}
	}

	for _, section := range options.BinarySection {
		buf := imapserver.ExtractBinarySection(bytes.NewReader(data.raw), section)
		wc := rw.WriteBinarySection(section, int64(len(buf)))
		_, writeErr := wc.Write(buf)
		closeErr := wc.Close()
		if writeErr != nil {
			return writeErr
		}
		if closeErr != nil {
			return closeErr
		}
	}

	for _, section := range options.BinarySectionSize {
		rw.WriteBinarySectionSize(section, imapserver.ExtractBinarySectionSize(bytes.NewReader(data.raw), section))
	}

	return nil
}

// ---------------------------------------------------------------------
// Out of scope in phase 1: every mutating command answers NO cleanly.
// ---------------------------------------------------------------------

func (s *Session) Create(mailbox string, options *imap.CreateOptions) error {
	return errNotYetSupported("CREATE")
}

func (s *Session) Delete(mailbox string) error {
	return errNotYetSupported("DELETE")
}

func (s *Session) Rename(mailbox, newName string, options *imap.RenameOptions) error {
	return errNotYetSupported("RENAME")
}

func (s *Session) Subscribe(mailbox string) error {
	return errNotYetSupported("SUBSCRIBE")
}

func (s *Session) Unsubscribe(mailbox string) error {
	return errNotYetSupported("UNSUBSCRIBE")
}

// Compile-time assertion that Session satisfies imapserver.Session, so a
// signature drift in the pinned go-imap version is caught at build time.
var _ imapserver.Session = (*Session)(nil)
