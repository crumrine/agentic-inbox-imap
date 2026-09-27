// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/crumrine/agentic-inbox-imap/gateway/internal/backend"
	"github.com/emersion/go-imap/v2"
)

func TestStatusPreservesMailboxNames(t *testing.T) {
	for _, tc := range []struct {
		name string
		ok   bool
		id   string
	}{
		{"INBOX", true, "inbox"}, {"inBoX", true, "inbox"},
		{"Archive", true, "archive"}, {"archive", false, ""},
		{"missing", false, ""}, {"Projects/2026", true, "custom"},
		{"custom", false, ""}, {"Collision", true, "second"},
		{"projects/2026", false, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			be := newFakeBackend(t)
			be.folders = append(be.folders,
				backend.Folder{ID: "custom", Name: "Projects/2026", UIDValidity: 77},
				backend.Folder{ID: "Collision", Name: "Other", UIDValidity: 88},
				backend.Folder{ID: "second", Name: "Collision", UIDValidity: 99})
			s := newLoggedInSession(t, be)
			data, err := s.Status(tc.name, &imap.StatusOptions{UIDValidity: true})
			if !tc.ok {
				var ie *imap.Error
				if !errors.As(err, &ie) || ie.Code != imap.ResponseCodeNonExistent {
					t.Fatalf("error = %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for _, f := range be.folders {
				if f.ID == tc.id && data.UIDValidity != f.UIDValidity {
					t.Fatalf("wrong folder: %+v", data)
				}
			}
			if tc.name != "Collision" {
				_, folders, messages, _ := be.counters()
				if folders != 0 || messages != 0 || be.statusCount() != 1 {
					t.Fatalf("folders=%d messages=%d status=%d", folders, messages, be.statusCount())
				}
			}
		})
	}
}

func TestRefreshRejectsDeletedFolderNameAlias(t *testing.T) {
	be := newFakeBackend(t)
	s := newSelectedSession(t, be, WithPollInterval(0))
	be.mu.Lock()
	be.folders = []backend.Folder{{ID: "replacement", Name: "inbox", UIDValidity: 1712345678, UIDNext: 13}}
	be.mu.Unlock()
	if err := s.Poll(nil, true); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.selFault == nil {
		t.Fatal("deleted selection was not poisoned")
	}
}

// Exercise the actual IMAP session and HTTP backend client together. All data
// is synthetic; no production mailbox, credentials, or outbound email is used.
func TestFolderStatusHTTPProtocol(t *testing.T) {
	be := newFakeBackend(t)
	var folders, statuses atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var result any
		var err error
		switch {
		case strings.HasSuffix(r.URL.Path, "/auth"):
			result = &backend.AuthResult{Mailbox: testMailbox}
		case strings.HasSuffix(r.URL.Path, "/folders"):
			folders.Add(1)
			result, err = be.Folders(r.Context(), testMailbox)
		case strings.HasSuffix(r.URL.Path, "/status"):
			statuses.Add(1)
			parts := strings.Split(r.URL.Path, "/")
			result, err = be.FolderStatus(r.Context(), testMailbox, parts[len(parts)-2])
		case strings.HasSuffix(r.URL.Path, "/messages"):
			since, _ := strconv.ParseUint(r.URL.Query().Get("sinceUid"), 10, 32)
			result, err = be.Messages(r.Context(), testMailbox, "inbox", backend.MessagesOptions{SinceUID: uint32(since)})
		default:
			t.Errorf("unexpected request: %s", r.URL)
			http.NotFound(w, r)
			return
		}
		if err != nil {
			http.Error(w, "fixture failure", 503)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(result); err != nil {
			t.Error(err)
		}
	}))
	t.Cleanup(srv.Close)
	client, err := backend.New(srv.URL, "synthetic-id", "synthetic-secret")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	c := startRawClient(t, client, WithPollInterval(0), WithIdleInterval(10*time.Millisecond))
	requireOK(t, c.do("LOGIN %s %s", testMailbox, testPassword))
	requireOK(t, c.do("STATUS INBOX (MESSAGES UIDNEXT UIDVALIDITY UNSEEN RECENT)"))
	if folders.Load() != 0 || statuses.Load() != 1 {
		t.Fatalf("STATUS routes: folders=%d status=%d", folders.Load(), statuses.Load())
	}
	requireOK(t, c.do("SELECT INBOX"))
	beforeFolders, beforeStatuses := folders.Load(), statuses.Load()
	for i := 0; i < 3; i++ {
		requireOK(t, c.do("NOOP"))
	}
	if folders.Load() != beforeFolders || statuses.Load() != beforeStatuses+3 {
		t.Fatalf("three NOOPs: folders delta=%d status delta=%d", folders.Load()-beforeFolders, statuses.Load()-beforeStatuses)
	}
	c.seq++
	tag := fmt.Sprintf("t%d", c.seq)
	if _, err := c.conn.Write([]byte(tag + " IDLE\r\n")); err != nil {
		t.Fatal(err)
	}
	if line := c.readLine(); !strings.HasPrefix(line, "+ ") {
		t.Fatalf("IDLE: %s", line)
	}
	deadline := time.Now().Add(5 * time.Second)
	idleStart := statuses.Load()
	for statuses.Load() < idleStart+3 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if statuses.Load() < idleStart+3 {
		t.Fatal("IDLE did not poll")
	}
	be.deliver(t, "inbox", newMessage("HTTP idle delivery", "sender@example.com", time.Now()), rawMsg5)
	if line := c.readLine(); line != "* 4 EXISTS" {
		t.Fatalf("IDLE update: %s", line)
	}
	if _, err := c.conn.Write([]byte("DONE\r\n")); err != nil {
		t.Fatal(err)
	}
	if line := c.readLine(); !strings.Contains(line, " OK") {
		t.Fatalf("DONE: %s", line)
	}
	if folders.Load() != beforeFolders {
		t.Fatalf("IDLE listed folders: %d -> %d", beforeFolders, folders.Load())
	}
	requireOK(t, c.do("FETCH 4 (UID)"))
	t.Logf("three NOOPs: 0 /folders, 3 /status; IDLE: 0 additional /folders; total /status=%d", statuses.Load())
}
