// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"bytes"
	"container/list"
	"context"
	"io"
	"sync"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"

	"github.com/crumrine/agentic-inbox-imap/gateway/internal/backend"
)

// Defaults for the per-session raw-message cache. The gateway is
// deliberately free of durable state, so this is the only place a message
// body is ever retained, and it is bounded in both directions.
const (
	// DefaultMaxCachedMessages bounds the number of cached raw messages.
	DefaultMaxCachedMessages = 32
	// DefaultMaxCacheBytes bounds the total bytes held by the cache.
	DefaultMaxCacheBytes int64 = 32 << 20 // 32 MiB
	// DefaultMaxMessageBytes bounds a single raw message. A message larger
	// than this is refused with NO [LIMIT] rather than buffered.
	DefaultMaxMessageBytes int64 = 24 << 20 // 24 MiB
)

// MessageStore supplies the per-message data the Worker's metadata endpoint
// deliberately does not carry: the original RFC822 bytes and the
// BODYSTRUCTURE derived from them.
//
// Session depends on this interface, not on Backend, for everything that
// needs the message body. When the Worker learns to precompute
// BODYSTRUCTURE, only an implementation of this interface changes; no
// session logic moves.
//
// Implementations must be safe for concurrent use. The byte slice returned
// by Raw is shared with the cache and must not be modified by callers.
type MessageStore interface {
	Raw(ctx context.Context, mailbox, folder string, uid uint32) ([]byte, error)

	// BodyStructure returns the structure of one message.
	//
	// It takes the whole metadata row rather than a UID because the row is
	// where the Worker's precomputed structure arrives. This is the swap
	// the interface was introduced for: an implementation can answer from
	// the payload when it is there and read the message when it is not,
	// without the session knowing which happened.
	BodyStructure(ctx context.Context, mailbox, folder string, msg *backend.Message) (imap.BodyStructure, error)
}

// rawKey identifies a cached message. Folder is part of the key because
// UIDs are per folder, not per mailbox.
type rawKey struct {
	mailbox string
	folder  string
	uid     uint32
}

// rawEntry is one cached message: the raw bytes plus a lazily parsed body
// structure, so a BODYSTRUCTURE followed by another BODYSTRUCTURE parses
// once.
type rawEntry struct {
	key rawKey
	raw []byte

	bsOnce sync.Once
	bs     imap.BodyStructure
}

func (e *rawEntry) bodyStructure() imap.BodyStructure {
	e.bsOnce.Do(func() {
		e.bs = imapserver.ExtractBodyStructure(bytes.NewReader(e.raw))
	})
	return e.bs
}

// rawCache is a bounded LRU over raw messages, capped by both entry count
// and total bytes.
type rawCache struct {
	mu         sync.Mutex
	maxEntries int
	maxBytes   int64

	bytes int64
	ll    *list.List // front = most recently used, values are *rawEntry
	index map[rawKey]*list.Element
}

func newRawCache(maxEntries int, maxBytes int64) *rawCache {
	if maxEntries <= 0 {
		maxEntries = DefaultMaxCachedMessages
	}
	if maxBytes <= 0 {
		maxBytes = DefaultMaxCacheBytes
	}
	return &rawCache{
		maxEntries: maxEntries,
		maxBytes:   maxBytes,
		ll:         list.New(),
		index:      make(map[rawKey]*list.Element),
	}
}

func (c *rawCache) get(k rawKey) (*rawEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.index[k]
	if !ok {
		return nil, false
	}
	c.ll.MoveToFront(el)
	return el.Value.(*rawEntry), true
}

// put inserts e, evicting least-recently-used entries until both bounds
// hold. An entry larger than maxBytes on its own is simply not cached.
func (c *rawCache) put(e *rawEntry) {
	size := int64(len(e.raw))
	c.mu.Lock()
	defer c.mu.Unlock()

	if el, ok := c.index[e.key]; ok {
		old := el.Value.(*rawEntry)
		c.bytes -= int64(len(old.raw))
		el.Value = e
		c.bytes += size
		c.ll.MoveToFront(el)
		c.evictLocked()
		return
	}

	if size > c.maxBytes {
		return
	}

	c.index[e.key] = c.ll.PushFront(e)
	c.bytes += size
	c.evictLocked()
}

func (c *rawCache) evictLocked() {
	for c.ll.Len() > c.maxEntries || c.bytes > c.maxBytes {
		el := c.ll.Back()
		if el == nil {
			return
		}
		ent := el.Value.(*rawEntry)
		c.ll.Remove(el)
		delete(c.index, ent.key)
		c.bytes -= int64(len(ent.raw))
	}
}

func (c *rawCache) len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ll.Len()
}

// purge drops every cached message. Called when a session closes so a long
// lived process does not hold message bodies for dead connections.
func (c *rawCache) purge() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ll.Init()
	c.index = make(map[rawKey]*list.Element)
	c.bytes = 0
}

// cachedStore is the default MessageStore: it fetches raw bytes from the
// Backend on demand and keeps them in a bounded LRU.
type cachedStore struct {
	be              Backend
	cache           *rawCache
	maxMessageBytes int64

	// fetching serialises concurrent misses for the same key so two
	// parallel FETCHes of one message make one backend call.
	fetching sync.Map // rawKey -> *sync.Mutex
}

var _ MessageStore = (*cachedStore)(nil)

func newCachedStore(be Backend, maxEntries int, maxBytes, maxMessageBytes int64) *cachedStore {
	if maxMessageBytes <= 0 {
		maxMessageBytes = DefaultMaxMessageBytes
	}
	return &cachedStore{
		be:              be,
		cache:           newRawCache(maxEntries, maxBytes),
		maxMessageBytes: maxMessageBytes,
	}
}

func (s *cachedStore) entry(ctx context.Context, mailbox, folder string, uid uint32) (*rawEntry, error) {
	k := rawKey{mailbox: mailbox, folder: folder, uid: uid}
	if e, ok := s.cache.get(k); ok {
		return e, nil
	}

	lockAny, _ := s.fetching.LoadOrStore(k, &sync.Mutex{})
	lock := lockAny.(*sync.Mutex)
	lock.Lock()
	defer func() {
		lock.Unlock()
		s.fetching.Delete(k)
	}()

	// Another goroutine may have populated the entry while we waited.
	if e, ok := s.cache.get(k); ok {
		return e, nil
	}

	rc, err := s.be.RawMessage(ctx, mailbox, folder, uid)
	if err != nil {
		return nil, err
	}
	defer rc.Close()

	if rc.Size > 0 && rc.Size > s.maxMessageBytes {
		return nil, errMessageTooLarge
	}

	// Read one byte past the cap so an undeclared oversize body is caught
	// too, rather than trusting Content-Length.
	raw, err := io.ReadAll(io.LimitReader(rc, s.maxMessageBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > s.maxMessageBytes {
		return nil, errMessageTooLarge
	}

	e := &rawEntry{key: k, raw: raw}
	s.cache.put(e)
	return e, nil
}

func (s *cachedStore) Raw(ctx context.Context, mailbox, folder string, uid uint32) ([]byte, error) {
	e, err := s.entry(ctx, mailbox, folder, uid)
	if err != nil {
		return nil, err
	}
	return e.raw, nil
}

// BodyStructure prefers the Worker's precomputed structure and derives one
// from the raw message when there is none.
//
// The fallback is not an edge case. The field is additive, nothing was
// backfilled, and the deriver declines rather than approximating whenever a
// message is outside what it can represent exactly, so most of an existing
// mailbox still takes the slow path. Both paths must produce the same
// bytes on the wire; TestPrecomputedMatchesDerived pins that.
func (s *cachedStore) BodyStructure(ctx context.Context, mailbox, folder string, msg *backend.Message) (imap.BodyStructure, error) {
	if msg == nil {
		return nil, errMessageVanished
	}
	if bs := decodeBodyStructure(msg.BodyStructure); bs != nil {
		// No R2 GET, no parse. This is the whole point of the field.
		return bs, nil
	}

	e, err := s.entry(ctx, mailbox, folder, msg.UID)
	if err != nil {
		return nil, err
	}
	return e.bodyStructure(), nil
}
