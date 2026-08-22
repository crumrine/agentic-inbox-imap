// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/emersion/go-imap/v2"

	"github.com/crumrine/agentic-inbox/gateway/internal/backend"
)

func TestCachedStoreFetchesOncePerMessage(t *testing.T) {
	be := newFakeBackend(t)
	store := newCachedStore(be, DefaultMaxCachedMessages, DefaultMaxCacheBytes, DefaultMaxMessageBytes)
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		raw, err := store.Raw(ctx, testMailbox, "inbox", 5)
		if err != nil {
			t.Fatalf("Raw: %v", err)
		}
		if string(raw) != rawMsg5 {
			t.Fatalf("Raw returned %d bytes, want the whole message", len(raw))
		}
	}
	if got := be.rawCallsFor(5); got != 1 {
		t.Errorf("RawMessage calls = %d, want 1", got)
	}
}

func TestCachedStoreParsesBodyStructureOnce(t *testing.T) {
	be := newFakeBackend(t)
	store := newCachedStore(be, DefaultMaxCachedMessages, DefaultMaxCacheBytes, DefaultMaxMessageBytes)
	ctx := context.Background()

	first, err := store.BodyStructure(ctx, testMailbox, "inbox", 9)
	if err != nil {
		t.Fatalf("BodyStructure: %v", err)
	}
	second, err := store.BodyStructure(ctx, testMailbox, "inbox", 9)
	if err != nil {
		t.Fatalf("BodyStructure: %v", err)
	}
	if first != second {
		t.Error("BodyStructure re-parsed the message instead of reusing the cached value")
	}
	if got := be.rawCallsFor(9); got != 1 {
		t.Errorf("RawMessage calls = %d, want 1", got)
	}
	if _, ok := first.(*imap.BodyStructureMultiPart); !ok {
		t.Errorf("body structure = %T, want *imap.BodyStructureMultiPart", first)
	}
}

// TestCachedStoreEvictsByEntryCount pins the bound: with room for one
// message, fetching a second must evict the first.
func TestCachedStoreEvictsByEntryCount(t *testing.T) {
	be := newFakeBackend(t)
	store := newCachedStore(be, 1, DefaultMaxCacheBytes, DefaultMaxMessageBytes)
	ctx := context.Background()

	for _, uid := range []uint32{5, 9, 5} {
		if _, err := store.Raw(ctx, testMailbox, "inbox", uid); err != nil {
			t.Fatalf("Raw(%d): %v", uid, err)
		}
	}
	if store.cache.len() != 1 {
		t.Errorf("cache holds %d entries, want 1", store.cache.len())
	}
	if got := be.rawCallsFor(5); got != 2 {
		t.Errorf("RawMessage calls for uid 5 = %d, want 2 (evicted then refetched)", got)
	}
}

func TestCachedStoreEvictsByTotalBytes(t *testing.T) {
	be := newFakeBackend(t)
	// Room for roughly one message, so the second fetch must evict.
	store := newCachedStore(be, 100, int64(len(rawMsg5))+16, DefaultMaxMessageBytes)
	ctx := context.Background()

	if _, err := store.Raw(ctx, testMailbox, "inbox", 5); err != nil {
		t.Fatalf("Raw(5): %v", err)
	}
	if _, err := store.Raw(ctx, testMailbox, "inbox", 9); err != nil {
		t.Fatalf("Raw(9): %v", err)
	}
	if store.cache.len() != 1 {
		t.Errorf("cache holds %d entries, want 1 after the byte bound kicked in", store.cache.len())
	}
}

func TestCachedStoreKeysIncludeFolder(t *testing.T) {
	be := newFakeBackend(t)
	// UIDs are per folder, so the same UID in two folders is two messages.
	be.raw["sent"] = map[uint32]string{5: rawMsg12}
	store := newCachedStore(be, DefaultMaxCachedMessages, DefaultMaxCacheBytes, DefaultMaxMessageBytes)
	ctx := context.Background()

	inbox, err := store.Raw(ctx, testMailbox, "inbox", 5)
	if err != nil {
		t.Fatalf("Raw(inbox, 5): %v", err)
	}
	sent, err := store.Raw(ctx, testMailbox, "sent", 5)
	if err != nil {
		t.Fatalf("Raw(sent, 5): %v", err)
	}
	if string(inbox) == string(sent) {
		t.Error("the cache returned the inbox message for the sent folder: the folder is missing from the key")
	}
}

func TestCachedStoreRejectsOversizeMessage(t *testing.T) {
	be := newFakeBackend(t)
	store := newCachedStore(be, DefaultMaxCachedMessages, DefaultMaxCacheBytes, 10)
	_, err := store.Raw(context.Background(), testMailbox, "inbox", 5)
	if !errors.Is(err, errMessageTooLarge) {
		t.Fatalf("err = %v, want errMessageTooLarge", err)
	}
	if imapErr, ok := mapBackendError(err, "gone").(*imap.Error); !ok || imapErr.Code != imap.ResponseCodeLimit {
		t.Errorf("mapped error = %v, want NO [LIMIT]", mapBackendError(err, "gone"))
	}
}

// TestCachedStoreRejectsOversizeMessageWithoutContentLength covers the
// case where the backend does not declare a size: the read itself must be
// capped, not just the advertised length.
func TestCachedStoreRejectsOversizeMessageWithoutContentLength(t *testing.T) {
	be := newFakeBackend(t)
	be.suppressContentLength = true
	store := newCachedStore(be, DefaultMaxCachedMessages, DefaultMaxCacheBytes, 10)

	_, err := store.Raw(context.Background(), testMailbox, "inbox", 5)
	if !errors.Is(err, errMessageTooLarge) {
		t.Fatalf("err = %v, want errMessageTooLarge", err)
	}
}

func TestCachePurgeReleasesEverything(t *testing.T) {
	be := newFakeBackend(t)
	store := newCachedStore(be, DefaultMaxCachedMessages, DefaultMaxCacheBytes, DefaultMaxMessageBytes)
	ctx := context.Background()
	if _, err := store.Raw(ctx, testMailbox, "inbox", 5); err != nil {
		t.Fatalf("Raw: %v", err)
	}
	store.cache.purge()
	if store.cache.len() != 0 || store.cache.bytes != 0 {
		t.Errorf("after purge: %d entries, %d bytes", store.cache.len(), store.cache.bytes)
	}
}

// TestFetchSurvivesRawFailure checks the error path: a backend failure
// during a body fetch must become a clean NO, not a panic and not a
// half-written FETCH response.
func TestFetchSurvivesRawFailure(t *testing.T) {
	be := newFakeBackend(t)
	client := startTestServer(t, be)
	loginAndSelect(t, client, "INBOX")

	be.mu.Lock()
	be.rawErr = &backend.APIError{Kind: backend.ErrKindServer, StatusCode: 502, Body: "bad gateway from https://inbox.internal/api"}
	be.mu.Unlock()

	_, err := client.Fetch(imap.SeqSetNum(1), &imap.FetchOptions{
		BodySection: []*imap.FetchItemBodySection{{}},
	}).Collect()
	if err == nil {
		t.Fatal("FETCH succeeded despite a backend failure")
	}
	if strings.Contains(err.Error(), "inbox.internal") {
		t.Errorf("error %q leaks the backend URL", err.Error())
	}

	// The connection must still be usable.
	if err := client.Noop().Wait(); err != nil {
		t.Fatalf("NOOP after a failed FETCH: %v", err)
	}
}

func TestWithMessageStoreOverridesTheDefault(t *testing.T) {
	be := newFakeBackend(t)
	stub := &countingStore{raw: rawMsg5}
	s := newSelectedSession(t, be, WithMessageStore(stub))

	if s.ownedCache != nil {
		t.Error("ownedCache should be nil when a MessageStore is injected")
	}
	if _, err := s.store.Raw(context.Background(), testMailbox, "inbox", 5); err != nil {
		t.Fatalf("Raw: %v", err)
	}
	if stub.calls != 1 {
		t.Errorf("injected store calls = %d, want 1", stub.calls)
	}
	if _, _, _, raw := be.counters(); raw != 0 {
		t.Errorf("backend RawMessage calls = %d, want 0 when a store is injected", raw)
	}
}

type countingStore struct {
	raw   string
	calls int
}

func (s *countingStore) Raw(ctx context.Context, mailbox, folder string, uid uint32) ([]byte, error) {
	s.calls++
	return []byte(s.raw), nil
}

func (s *countingStore) BodyStructure(ctx context.Context, mailbox, folder string, uid uint32) (imap.BodyStructure, error) {
	s.calls++
	return nil, nil
}
