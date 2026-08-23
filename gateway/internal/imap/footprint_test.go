// Copyright (c) 2026 Brian Crumrine
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

package imap

import (
	"fmt"
	"runtime"
	"testing"
	"time"

	"github.com/crumrine/agentic-inbox-imap/gateway/internal/backend"
)

// footprintMessages builds metadata rows shaped like real mail: a threaded
// subject, three addresses with display names, and full message
// identifiers. Envelope strings are most of the cost, so a fixture with
// short placeholder values would flatter the measurement.
func footprintMessages(n int) []backend.Message {
	out := make([]backend.Message, n)
	for i := range out {
		uid := uint32(i + 1)
		out[i] = backend.Message{
			UID:          uid,
			Flags:        []string{`\Seen`},
			InternalDate: time.Now(),
			RFC822Size:   48000,
			Envelope: backend.Envelope{
				Subject:   fmt.Sprintf("Re: quarterly planning discussion thread %d", uid),
				From:      []backend.Address{{Name: "Alice Example", Address: "alice.example@partner.example.com"}},
				To:        []backend.Address{{Name: "User Example", Address: "user@example.com"}},
				Cc:        []backend.Address{{Name: "Bob Example", Address: "bob@example.com"}},
				MessageID: fmt.Sprintf("<CAF%d.abcdef0123456789@mail.example.com>", uid),
				InReplyTo: fmt.Sprintf("<CAF%d.9876543210fedcba@mail.example.com>", uid-1),
				Date:      "Mon, 02 Jan 2026 15:04:05 -0700",
			},
			HasRaw: true,
		}
	}
	return out
}

// buildFootprintSelection assembles a selection the way Select does.
func buildFootprintSelection(listed []backend.Message) *selection {
	msgs := make([]*backend.Message, 0, len(listed))
	for i := range listed {
		msgs = append(msgs, &listed[i])
	}
	byUID := make(map[uint32]*backend.Message, len(msgs))
	for _, m := range msgs {
		byUID[m.UID] = m
	}
	return &selection{msgs: msgs, byUID: byUID}
}

// BenchmarkSelectionFootprint reports the retained heap cost of one
// selected folder, in bytes per message.
//
// This is the number DefaultMaxFolderMessages is derived from, so it lives
// here rather than in a comment that would quietly go stale: adding a field
// to backend.Message moves it, and the ceiling should move with it.
//
//	go test ./internal/imap -run XXX -bench SelectionFootprint -benchtime 1x
func BenchmarkSelectionFootprint(b *testing.B) {
	for _, n := range []int{10_000, 50_000} {
		b.Run(fmt.Sprintf("messages=%d", n), func(b *testing.B) {
			// Measured once, not per iteration: this is a memory
			// question, and repeating it only adds GC noise.
			b.ResetTimer()

			runtime.GC()
			var before runtime.MemStats
			runtime.ReadMemStats(&before)

			sel := buildFootprintSelection(footprintMessages(n))

			runtime.GC()
			var after runtime.MemStats
			runtime.ReadMemStats(&after)

			retained := after.HeapAlloc - before.HeapAlloc
			runtime.KeepAlive(sel)

			b.ReportMetric(float64(retained)/float64(n), "B/msg")
			b.ReportMetric(float64(retained)/(1<<20), "MiB-total")
		})
	}
}

// TestSelectionFootprintIsInTheExpectedRange guards the assumption behind
// DefaultMaxFolderMessages without turning a memory measurement into a
// flaky exact-value assertion.
//
// The bound is deliberately loose: it catches a field that doubles the row,
// not ordinary allocator variation. If this fails, re-run
// BenchmarkSelectionFootprint and reconsider the ceiling rather than just
// widening the bound.
func TestSelectionFootprintIsInTheExpectedRange(t *testing.T) {
	const (
		n         = 20_000
		maxPerMsg = 1200 // measured ~500; a doubled row should be caught
		minPerMsg = 100  // a collapse this large means the fixture stopped being realistic
	)

	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)

	sel := buildFootprintSelection(footprintMessages(n))

	runtime.GC()
	var after runtime.MemStats
	runtime.ReadMemStats(&after)

	retained := after.HeapAlloc - before.HeapAlloc
	runtime.KeepAlive(sel)

	perMsg := retained / n
	t.Logf("selection of %d messages retains %.1f MiB, %d bytes per message; "+
		"DefaultMaxFolderMessages=%d implies about %.0f MiB per selected folder",
		n, float64(retained)/(1<<20), perMsg,
		DefaultMaxFolderMessages, float64(perMsg)*DefaultMaxFolderMessages/(1<<20))

	if perMsg > maxPerMsg {
		t.Errorf("selection costs %d bytes per message, above the %d assumed by DefaultMaxFolderMessages",
			perMsg, maxPerMsg)
	}
	if perMsg < minPerMsg {
		t.Errorf("selection costs only %d bytes per message; the fixture is probably no longer realistic",
			perMsg)
	}
}
