// Package bridge provides the WebSocket ↔ stdio bridge for the ACP server.
//
// Session persistence
//
// Unlike a simple transparent proxy, this implementation keeps agent processes
// alive after a WebSocket disconnects so that the conversation context is
// preserved.  When a client reconnects and sends session/resume the bridge
// routes the new WebSocket to the still-running agent process.
//
// Key behaviours:
//   - session/new   → spawn a fresh agent; capture the ACP session ID from the
//     response and register it in the global store.
//   - session/resume with known ID → reuse the existing agent (subscribe new WS).
//   - session/resume with unknown ID → spawn a new agent and convert the call to
//     session/new so the client gets a valid session.
//   - WS disconnect → keep agent alive; fan-out goroutine discards stdout until
//     the next reconnect.
//   - Agent exit    → remove session from store and close any WS subscriber.
package bridge

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os/exec"
	"time"

	"github.com/gorilla/websocket"
)

// wsWriteTimeout is the per-message deadline for WebSocket writes.
const wsWriteTimeout = 30 * time.Second

// Config holds the command used to spawn the ACP agent for each connection.
type Config struct {
	// Command is the executable to run (e.g. "node").
	Command string
	// Args are passed to the command (e.g. ["dist/my-agent.js"]).
	Args []string
	// Env contains additional environment variables (KEY=VALUE).
	Env []string
}

// ─── JSON-RPC helpers ─────────────────────────────────────────────────────────

type rpcMsg struct {
	JSONRPC string          `json:"jsonrpc,omitempty"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   json.RawMessage `json:"error,omitempty"`
}

type sessionNewResult struct {
	SessionID string `json:"sessionId"`
}

type sessionResumeParams struct {
	SessionID string `json:"sessionId"`
	CWD       string `json:"cwd"`
}

type sessionNewParams struct {
	CWD        string        `json:"cwd"`
	MCPServers []interface{} `json:"mcpServers"`
}

// ─── Agent lifecycle ──────────────────────────────────────────────────────────

// spawnAgentProc starts a new agent subprocess and wires up the stdout drain
// pipeline.  Callers must call startFanOut() after setting up any initial
// subscriber to ensure lines aren't lost.
func spawnAgentProc(cfg Config) (*agentProc, error) {
	cmd := exec.Command(cfg.Command, cfg.Args...) //nolint:gosec
	cmd.Env = append(cmd.Environ(), cfg.Env...)
	cmd.Stderr = log.Writer()

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("start agent: %w", err)
	}

	a := &agentProc{
		cmd:          cmd,
		stdin:        stdin,
		outCh:        make(chan []byte, outChanCapacity),
		done:         make(chan struct{}),
		lastActivity: time.Now(),
	}

	// Drain stdout → outCh continuously so the agent is never blocked on writes.
	go func() {
		defer close(a.done)
		defer close(a.outCh)
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 1<<20), 10<<20) // up to 10 MiB per line
		for scanner.Scan() {
			line := scanner.Bytes()
			if len(line) == 0 {
				continue
			}
			cp := make([]byte, len(line))
			copy(cp, line)
			select {
			case a.outCh <- cp:
			default:
				log.Printf("[bridge] stdout buffer full — dropping line")
			}
		}
	}()

	return a, nil
}

// ─── Handle ───────────────────────────────────────────────────────────────────

// Handle bridges a WebSocket connection to an agent process.
// It implements session persistence: the agent stays alive after the WS closes
// and can be reconnected via session/resume on the next connection.
func Handle(conn *websocket.Conn, cfg Config) {
	// ── Phase 1: identify the target agent ───────────────────────────────────
	// Read incoming messages until we see session/new or session/resume.
	// Other messages (e.g. "initialize") are buffered and forwarded once
	// we know the agent.

	var agent *agentProc
	var sub chan []byte
	var preflight [][]byte       // messages to replay to a freshly spawned agent
	var sessionMsgID []byte      // ID of the session/new RPC (to capture the response)
	var registeredSessionID string // ACP session ID registered by this connection

	prefixReadLoop:
	for {
		mt, raw, err := conn.ReadMessage()
		if err != nil {
			// WS closed before handshake finished.
			return
		}
		if mt != websocket.TextMessage {
			continue
		}

		var rpc rpcMsg
		if err := json.Unmarshal(raw, &rpc); err != nil {
			// Unparseable — buffer and forward when we know the agent.
			preflight = append(preflight, raw)
			continue
		}

		switch rpc.Method {
		case "session/resume":
			// Try to reconnect to an existing live agent.
			var p sessionResumeParams
			if len(rpc.Params) > 0 {
				_ = json.Unmarshal(rpc.Params, &p)
			}

			if p.SessionID != "" {
				if existing, ok := globalStore.get(p.SessionID); ok {
					log.Printf("[bridge] resuming existing session %s", p.SessionID)
					existing.touch()
					agent = existing
					sub = agent.subscribe()
					// Forward session/resume to agent (skip preflight — agent is already
					// initialized and the session is already open).
					if _, err := fmt.Fprintf(agent.stdin, "%s\n", raw); err != nil {
						log.Printf("[bridge] session/resume stdin write failed: %v — spawning new", err)
						agent = nil
						sub = nil
					} else {
						break prefixReadLoop
					}
				} else {
					log.Printf("[bridge] session %s not found in store — spawning new agent", p.SessionID)
				}
			}

			// Session not found (first connect, pod restart, or TTL expiry):
			// spawn a new agent and convert session/resume → session/new.
			// The client receives a fresh session ID, but the proxy will update
			// the K8s annotation on the next WS disconnect.
			newAgent, spawnErr := spawnAgentProc(cfg)
			if spawnErr != nil {
				log.Printf("[bridge] spawn agent: %v", spawnErr)
				_ = conn.WriteMessage(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "failed to start agent"))
				_ = conn.Close()
				return
			}
			agent = newAgent
			sub = agent.subscribe()
			agent.startFanOut()

			// Forward pre-flight messages.
			for _, pm := range preflight {
				if _, fwErr := fmt.Fprintf(agent.stdin, "%s\n", pm); fwErr != nil {
					log.Printf("[bridge] preflight write: %v", fwErr)
				}
			}
			preflight = nil

			// Rewrite session/resume → session/new.
			cwd := p.CWD
			if cwd == "" {
				cwd = "/"
			}
			newParams, _ := json.Marshal(sessionNewParams{
				CWD:        cwd,
				MCPServers: []interface{}{},
			})
			converted, _ := json.Marshal(rpcMsg{
				JSONRPC: "2.0",
				ID:      rpc.ID,
				Method:  "session/new",
				Params:  newParams,
			})
			if _, fwErr := fmt.Fprintf(agent.stdin, "%s\n", converted); fwErr != nil {
				log.Printf("[bridge] converted session/new write: %v", fwErr)
			}
			sessionMsgID = rpc.ID
			break prefixReadLoop

		case "session/new":
			// Spawn a fresh agent.
			newAgent, spawnErr := spawnAgentProc(cfg)
			if spawnErr != nil {
				log.Printf("[bridge] spawn agent: %v", spawnErr)
				_ = conn.WriteMessage(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "failed to start agent"))
				_ = conn.Close()
				return
			}
			agent = newAgent
			sub = agent.subscribe()
			agent.startFanOut()

			// Forward buffered pre-flight messages first.
			for _, pm := range preflight {
				if _, fwErr := fmt.Fprintf(agent.stdin, "%s\n", pm); fwErr != nil {
					log.Printf("[bridge] preflight write: %v", fwErr)
				}
			}
			preflight = nil

			if _, fwErr := fmt.Fprintf(agent.stdin, "%s\n", raw); fwErr != nil {
				log.Printf("[bridge] session/new write: %v", fwErr)
			}
			sessionMsgID = rpc.ID
			break prefixReadLoop

		default:
			// Pre-session message (e.g. "initialize") — buffer it.
			preflight = append(preflight, raw)
		}
	}

	if agent == nil {
		return
	}

	// ── Phase 2: bidirectional bridge ────────────────────────────────────────
	errCh := make(chan error, 2)

	// WS → agent stdin
	go func() {
		for {
			mt, raw, err := conn.ReadMessage()
			if err != nil {
				errCh <- fmt.Errorf("ws read: %w", err)
				return
			}
			if mt != websocket.TextMessage {
				continue
			}
			agent.touch()
			if _, err := fmt.Fprintf(agent.stdin, "%s\n", raw); err != nil {
				errCh <- fmt.Errorf("stdin write: %w", err)
				return
			}
		}
	}()

	// subscriber → WS  (also watches for agent/session registration)
	go func() {
		for line := range sub {
			agent.touch()

			// Capture ACP session ID from session/new (or converted session/resume) response.
			if len(sessionMsgID) > 0 && registeredSessionID == "" {
				var resp rpcMsg
				if json.Unmarshal(line, &resp) == nil &&
					len(resp.ID) > 0 && len(resp.Result) > 0 && len(resp.Error) == 0 &&
					string(resp.ID) == string(sessionMsgID) {
					var result sessionNewResult
					if json.Unmarshal(resp.Result, &result) == nil && result.SessionID != "" {
						registeredSessionID = result.SessionID
						globalStore.register(registeredSessionID, agent)
					}
				}
			}

			_ = conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
			if err := conn.WriteMessage(websocket.TextMessage, line); err != nil {
				errCh <- fmt.Errorf("ws write: %w", err)
				return
			}
		}
		// sub was closed: either agent exited or a new WS stole the subscription.
		errCh <- fmt.Errorf("subscriber channel closed")
	}()

	bridgeErr := <-errCh
	log.Printf("[bridge] bridge ended: %v", bridgeErr)

	// Unsubscribe so the fan-out goroutine stops forwarding to our (now dead) WS.
	agent.unsubscribe(sub)

	// Check if the agent itself exited (done channel closed).
	select {
	case <-agent.done:
		// Agent process ended — clean up from store.
		if registeredSessionID != "" {
			globalStore.delete(registeredSessionID)
			log.Printf("[bridge] agent exited, removed session %s", registeredSessionID)
		}
		if agent.cmd.Process != nil {
			_ = agent.cmd.Process.Kill()
		}
		_ = agent.cmd.Wait()
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		_ = conn.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, "agent exited"))
	default:
		// WS disconnected but agent is still running — keep it alive for resume.
		log.Printf("[bridge] WS disconnected; agent kept alive for session %s", registeredSessionID)
	}

	_ = conn.Close()
}
