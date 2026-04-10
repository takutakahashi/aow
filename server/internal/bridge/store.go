// Package bridge provides the WebSocket ↔ stdio bridge for the ACP server.
package bridge

import (
	"io"
	"log"
	"os/exec"
	"sync"
	"time"
)

const (
	// outChanCapacity is the buffer size of the stdout drain channel per agent.
	// Large enough to absorb a full streaming response while the WS is reconnecting.
	outChanCapacity = 8192

	// subChanCapacity is the buffer size of the per-WS subscriber channel.
	subChanCapacity = 512

	// sessionTTL defines how long an idle agent is kept alive after
	// the WebSocket disconnects.
	sessionTTL = 2 * time.Hour

	// cleanupInterval is how often the cleanup goroutine runs.
	cleanupInterval = 10 * time.Minute
)

// agentProc holds a running agent process and its I/O plumbing.
// It supports multiple WebSocket connections across its lifetime via
// subscribe / unsubscribe.
type agentProc struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser

	// outCh receives lines from the agent stdout drain goroutine.
	// It is always being consumed by the fan-out goroutine to prevent
	// the agent from blocking on writes.
	outCh chan []byte

	// done is closed when the stdout drain goroutine exits (agent process ended).
	done chan struct{}

	// subMu protects sub.
	subMu sync.Mutex
	// sub is the channel for the currently connected WebSocket.
	// nil when no WebSocket is connected.
	sub chan []byte

	// lastActivity is updated on every stdin write or subscriber change.
	mu           sync.Mutex
	lastActivity time.Time
}

// touch records recent activity (call while holding no locks).
func (a *agentProc) touch() {
	a.mu.Lock()
	a.lastActivity = time.Now()
	a.mu.Unlock()
}

// subscribe creates a new subscriber channel for the caller.
// Any previous subscriber is replaced and its channel is closed.
func (a *agentProc) subscribe() chan []byte {
	ch := make(chan []byte, subChanCapacity)
	a.subMu.Lock()
	old := a.sub
	a.sub = ch
	a.subMu.Unlock()
	if old != nil {
		close(old) // causes the old WS goroutine to exit cleanly
	}
	a.touch()
	return ch
}

// unsubscribe removes ch as the active subscriber (if it still is) and closes it.
// Safe to call even if ch was already replaced by a newer subscribe.
func (a *agentProc) unsubscribe(ch chan []byte) {
	a.subMu.Lock()
	if a.sub == ch {
		a.sub = nil
		close(ch)
	}
	a.subMu.Unlock()
}

// startFanOut launches the goroutine that continuously reads from outCh and
// forwards to the current subscriber (if any). Lines are silently dropped
// when there is no subscriber, which prevents the agent from blocking on stdout.
// The goroutine exits when outCh is closed (agent process ended).
func (a *agentProc) startFanOut() {
	go func() {
		for line := range a.outCh {
			a.subMu.Lock()
			sub := a.sub
			a.subMu.Unlock()
			if sub == nil {
				continue // no WS connected — discard to keep agent unblocked
			}
			select {
			case sub <- line:
			default:
				// Subscriber channel full — drop to keep fan-out unblocked.
				log.Printf("[bridge] subscriber channel full, dropping line")
			}
		}
		// outCh closed: agent exited. Close the current subscriber so its
		// consumer goroutine exits cleanly.
		a.subMu.Lock()
		if a.sub != nil {
			close(a.sub)
			a.sub = nil
		}
		a.subMu.Unlock()
	}()
}

// ─── Session Store ────────────────────────────────────────────────────────────

// sessionStore maps ACP session IDs to live agent processes.
type sessionStore struct {
	mu       sync.RWMutex
	sessions map[string]*agentProc
}

// globalStore is the process-wide ACP session registry.
var globalStore = &sessionStore{sessions: make(map[string]*agentProc)}

func init() {
	go globalStore.cleanupLoop()
}

func (s *sessionStore) register(id string, a *agentProc) {
	s.mu.Lock()
	s.sessions[id] = a
	s.mu.Unlock()
	log.Printf("[bridge] registered session %s", id)
}

func (s *sessionStore) get(id string) (*agentProc, bool) {
	s.mu.RLock()
	a, ok := s.sessions[id]
	s.mu.RUnlock()
	return a, ok
}

func (s *sessionStore) delete(id string) {
	s.mu.Lock()
	delete(s.sessions, id)
	s.mu.Unlock()
}

func (s *sessionStore) cleanupLoop() {
	t := time.NewTicker(cleanupInterval)
	defer t.Stop()
	for range t.C {
		s.cleanup()
	}
}

func (s *sessionStore) cleanup() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, a := range s.sessions {
		a.mu.Lock()
		idle := time.Since(a.lastActivity)
		a.mu.Unlock()
		if idle > sessionTTL {
			log.Printf("[bridge] evicting idle session %s (idle %v)", id, idle)
			if a.cmd.Process != nil {
				_ = a.cmd.Process.Kill()
			}
			delete(s.sessions, id)
		}
	}
}
