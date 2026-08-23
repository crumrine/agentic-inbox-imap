package imap

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"

	"github.com/crumrine/agentic-inbox/gateway/internal/backend"
)

// syncUpdateWriter is a recordingUpdateWriter that is safe to read while
// the idle goroutine is writing to it, and can announce that an update
// arrived.
type syncUpdateWriter struct {
	mu     sync.Mutex
	exists []uint32
	got    chan uint32
	err    error
}

func newSyncUpdateWriter() *syncUpdateWriter {
	return &syncUpdateWriter{got: make(chan uint32, 16)}
}

func (w *syncUpdateWriter) WriteNumMessages(n uint32) error {
	w.mu.Lock()
	w.exists = append(w.exists, n)
	err := w.err
	w.mu.Unlock()

	select {
	case w.got <- n:
	default:
	}
	return err
}

func (w *syncUpdateWriter) snapshot() []uint32 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]uint32(nil), w.exists...)
}

// idleSession builds a selected session with both timers wound right down.
// Both are needed: the idle tick schedules the refresh, and the poll
// interval is a floor that would otherwise skip it.
func idleSession(t *testing.T, be Backend, idle time.Duration) *Session {
	t.Helper()
	return newSelectedSession(t, be, WithPollInterval(0), WithIdleInterval(idle))
}

// runIdle starts Idle in the background and returns a stop func plus a
// channel carrying its return value.
func runIdle(t *testing.T, s *Session, w updateWriter) (stop func(), done <-chan error) {
	t.Helper()

	stopCh := make(chan struct{})
	errCh := make(chan error, 1)
	go func() { errCh <- s.idle(w, stopCh) }()

	var once sync.Once
	closeStop := func() { once.Do(func() { close(stopCh) }) }
	t.Cleanup(closeStop)
	return closeStop, errCh
}

// TestIdleBlocksUntilStop is the core of the iOS Mail fix. Returning early
// leaves the client committed to an idle the server has already abandoned.
func TestIdleBlocksUntilStop(t *testing.T) {
	s := idleSession(t, newFakeBackend(t), time.Hour)
	stop, done := runIdle(t, s, newSyncUpdateWriter())

	select {
	case err := <-done:
		t.Fatalf("Idle returned %v before stop closed", err)
	case <-time.After(150 * time.Millisecond):
	}

	stop()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Idle returned %v, want nil", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Idle did not return after stop closed")
	}
}

// TestIdleHonoursStopPromptly: the interval is an hour, so returning has
// to come from the stop channel and not from waiting out a tick.
func TestIdleHonoursStopPromptly(t *testing.T) {
	s := idleSession(t, newFakeBackend(t), time.Hour)
	stop, done := runIdle(t, s, newSyncUpdateWriter())

	// Let the entry refresh finish first, so what is measured is the wait.
	time.Sleep(50 * time.Millisecond)

	start := time.Now()
	stop()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Idle returned %v, want nil", err)
		}
		if elapsed := time.Since(start); elapsed > 2*time.Second {
			t.Errorf("Idle took %v to notice stop, want well inside the %v interval", elapsed, time.Hour)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Idle did not return after stop closed")
	}
}

// TestIdleEmitsExistsForMailDeliveredWhileIdling is the behaviour the
// client is waiting for: an update with no command from the client.
func TestIdleEmitsExistsForMailDeliveredWhileIdling(t *testing.T) {
	be := newFakeBackend(t)
	s := idleSession(t, be, 10*time.Millisecond)
	w := newSyncUpdateWriter()
	stop, done := runIdle(t, s, w)

	uid := be.deliver(t, "inbox", newMessage("while idling", "idle@example.com", time.Now()), rawMsg5)

	select {
	case n := <-w.got:
		if n != 4 {
			t.Fatalf("EXISTS = %d, want 4", n)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no EXISTS was emitted for mail delivered during IDLE")
	}

	stop()
	if err := <-done; err != nil {
		t.Fatalf("Idle returned %v, want nil", err)
	}

	// The sequence number the client was just told about must resolve to
	// the message that actually arrived.
	_, sel := s.snapshot()
	if sel.numMessages() != 4 {
		t.Fatalf("snapshot holds %d messages, want 4", sel.numMessages())
	}
	var got []uint32
	if err := sel.forEach(imap.SeqSetNum(4), func(_ uint32, msg *backend.Message) error {
		got = append(got, msg.UID)
		return nil
	}); err != nil {
		t.Fatalf("forEach: %v", err)
	}
	if !equalUint32s(got, []uint32{uid}) {
		t.Errorf("sequence 4 resolves to %v, want [%d]", got, uid)
	}
}

// TestIdleDoesNotRenumberDuringIdle: the growth path is append-only, and
// an idle refresh must not be the thing that breaks that.
func TestIdleDoesNotRenumberDuringIdle(t *testing.T) {
	be := newFakeBackend(t)
	s := idleSession(t, be, 10*time.Millisecond)

	_, before := s.snapshot()
	beforeMap := seqToUID(before)

	w := newSyncUpdateWriter()
	stop, done := runIdle(t, s, w)

	be.removeMessage("inbox", 9) // deleted underneath the selection
	be.deliver(t, "inbox", newMessage("new one", "x@example.com", time.Now()), rawMsg5)

	select {
	case <-w.got:
	case <-time.After(5 * time.Second):
		t.Fatal("no EXISTS emitted")
	}
	stop()
	if err := <-done; err != nil {
		t.Fatalf("Idle: %v", err)
	}

	_, after := s.snapshot()
	afterMap := seqToUID(after)
	for seqNum, wantUID := range beforeMap {
		if afterMap[seqNum] != wantUID {
			t.Errorf("sequence %d moved from UID %d to %d during IDLE", seqNum, wantUID, afterMap[seqNum])
		}
	}
	if len(afterMap) != len(beforeMap)+1 {
		t.Errorf("snapshot holds %d messages, want %d", len(afterMap), len(beforeMap)+1)
	}
}

// TestIdleEmitsNothingWhenUIDNextHasNotMoved: an idle mailbox must stay
// quiet, or clients re-sync on every tick for nothing.
func TestIdleEmitsNothingWhenNothingChanged(t *testing.T) {
	be := newFakeBackend(t)
	s := idleSession(t, be, 10*time.Millisecond)
	w := newSyncUpdateWriter()
	stop, done := runIdle(t, s, w)

	time.Sleep(200 * time.Millisecond) // many ticks
	stop()
	if err := <-done; err != nil {
		t.Fatalf("Idle: %v", err)
	}

	if got := w.snapshot(); len(got) != 0 {
		t.Errorf("EXISTS responses = %v, want none from an unchanged folder", got)
	}
	// And the cheap path held: no metadata listing for an unchanged folder.
	_, folders, messages, _ := be.counters()
	if folders < 2 {
		t.Errorf("Folders calls = %d, want the idle loop to have polled at least twice", folders)
	}
	if messages != 2 {
		t.Errorf("Messages calls = %d, want only the 2 from SELECT's paging", messages)
	}
}

// TestIdleSurvivesBackendFailure: a Worker hiccup must not end the idle or
// disturb the snapshot.
func TestIdleSurvivesBackendFailure(t *testing.T) {
	be := newFakeBackend(t)
	s := idleSession(t, be, 10*time.Millisecond)

	_, before := s.snapshot()
	beforeMap := seqToUID(before)

	w := newSyncUpdateWriter()
	stop, done := runIdle(t, s, w)

	be.mu.Lock()
	be.foldersErr = &backend.APIError{Kind: backend.ErrKindServer, StatusCode: 503}
	be.mu.Unlock()

	time.Sleep(120 * time.Millisecond) // several failing ticks

	// Still idling.
	select {
	case err := <-done:
		t.Fatalf("Idle returned %v during a backend outage; it must keep idling", err)
	default:
	}

	// Recovery: once the backend comes back, updates resume.
	be.mu.Lock()
	be.foldersErr = nil
	be.mu.Unlock()
	be.deliver(t, "inbox", newMessage("after recovery", "y@example.com", time.Now()), rawMsg5)

	select {
	case n := <-w.got:
		if n != 4 {
			t.Errorf("EXISTS = %d, want 4", n)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no EXISTS after the backend recovered")
	}

	stop()
	if err := <-done; err != nil {
		t.Fatalf("Idle returned %v, want nil", err)
	}

	_, after := s.snapshot()
	afterMap := seqToUID(after)
	for seqNum, wantUID := range beforeMap {
		if afterMap[seqNum] != wantUID {
			t.Errorf("sequence %d changed from UID %d to %d across the outage", seqNum, wantUID, afterMap[seqNum])
		}
	}
}

func TestIdleWithNilStopReturnsImmediately(t *testing.T) {
	s := idleSession(t, newFakeBackend(t), time.Hour)

	done := make(chan error, 1)
	go func() { done <- s.Idle(nil, nil) }()

	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Idle(nil, nil) = %v, want nil", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Idle with a nil stop channel blocked forever")
	}
}

// TestIdleWithoutSelectionIsQuiet: IDLE is legal in the authenticated
// state, where there is nothing to refresh.
func TestIdleWithoutSelectionIsQuiet(t *testing.T) {
	be := newFakeBackend(t)
	s := newLoggedInSession(t, be, WithPollInterval(0), WithIdleInterval(10*time.Millisecond))

	w := newSyncUpdateWriter()
	stop, done := runIdle(t, s, w)
	time.Sleep(100 * time.Millisecond)
	stop()
	if err := <-done; err != nil {
		t.Fatalf("Idle: %v", err)
	}

	if got := w.snapshot(); len(got) != 0 {
		t.Errorf("EXISTS responses = %v, want none without a selection", got)
	}
	if _, folders, messages, _ := be.counters(); folders != 0 || messages != 0 {
		t.Errorf("backend was called without a selection: folders %d, messages %d", folders, messages)
	}
}

// TestIdleConcurrentWithCommands is the race test. go-imap runs Idle in its
// own goroutine while the connection goroutine reads, and both touch the
// selection; -race is the point of this one.
func TestIdleConcurrentWithCommands(t *testing.T) {
	be := newFakeBackend(t)
	s := idleSession(t, be, time.Millisecond)

	w := newSyncUpdateWriter()
	stop, done := runIdle(t, s, w)

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 25; j++ {
				// Concurrent readers of the selection.
				_, sel := s.snapshot()
				if sel != nil {
					_ = sel.numMessages()
					_ = sel.firstUnseenSeqNum()
					_ = sel.forEach(imap.SeqSet{{Start: 1, Stop: 0}}, func(uint32, *backend.Message) error { return nil })
				}
				// And a concurrent command-driven poll, which grows the
				// same snapshot the idle loop is growing.
				if err := s.poll(context.Background(), newSyncUpdateWriter()); err != nil {
					t.Errorf("poll: %v", err)
					return
				}
				if n == 0 && j%5 == 0 {
					be.deliver(t, "inbox", newMessage("concurrent", "z@example.com", time.Now()), rawMsg5)
				}
			}
		}(i)
	}
	wg.Wait()

	stop()
	if err := <-done; err != nil {
		t.Fatalf("Idle: %v", err)
	}

	// Whatever interleaving happened, the snapshot must still be sorted by
	// UID and free of duplicates: that is what sequence numbers mean.
	_, sel := s.snapshot()
	var prev uint32
	for i, msg := range sel.msgs {
		if i > 0 && msg.UID <= prev {
			t.Fatalf("snapshot is not strictly ascending at index %d: %d after %d", i, msg.UID, prev)
		}
		prev = msg.UID
	}
}
