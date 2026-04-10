// Package bridge provides the WebSocket ↔ stdio bridge for the ACP server.
//
// Session persistence
//
// Unlike a simple transparent proxy, this implementation keeps agent processes
// alive after a WebSocket disconnects so that the conversation context is
// preserved.  When a client reconnects and sends session/resume the bridge
// routes the new WebSocket to the still-running agent process.
//
// Connection flow
//
//  1. A fresh "temp" agent is spawned immediately on every new WS connection.
//     This ensures initialize can be answered without delay.
//  2. The bridge watches for session/new and session/resume messages:
//     - session/new:    use the temp agent; capture the ACP session ID from
//       the response and register it in the global store.
//     - session/resume (known ID): kill the temp agent, subscribe the new
//       WS to the existing agent, and forward session/resume to it.
//     - session/resume (unknown ID): keep the temp agent, silently rewrite
//       the call to session/new so the agent creates a fresh session.
//  3. All other messages (including initialize) are forwarded immediately.
//  4. On WS disconnect the agent is kept alive for the next resume.
//  5. On agent exit the session is removed from the store.
package bridge

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os/exec"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// wsWriteTimeout is the per-message deadline for WebSocket writes.
const wsWriteTimeout = 30 * time.Second

// Config holds the command used to spawn the ACP agent for each connection.
type Config struct {
	Command string
	Args    []string
	Env     []string
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
// pipeline.  Call startFanOut() after to begin routing output.
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

	log.Printf("[bridge] spawned agent pid=%d cmd=%s", cmd.Process.Pid, cfg.Command)

	a := &agentProc{
		cmd:          cmd,
		stdin:        stdin,
		outCh:        make(chan []byte, outChanCapacity),
		done:         make(chan struct{}),
		lastActivity: time.Now(),
	}

	// Drain stdout → outCh so the agent is never blocked on writes.
	go func() {
		defer close(a.done)
		defer close(a.outCh)
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 1<<20), 10<<20)
		for scanner.Scan() {
			line := scanner.Bytes()
			if len(line) == 0 {
				continue
			}
			cp := make([]byte, len(line))
			copy(cp, line)
			log.Printf("[bridge] stdout→outCh: %s", cp)
			select {
			case a.outCh <- cp:
			default:
				log.Printf("[bridge] stdout buffer full — dropping line")
			}
		}
		if err := scanner.Err(); err != nil {
			log.Printf("[bridge] scanner error: %v", err)
		}
		log.Printf("[bridge] stdout drain goroutine exiting (pid=%d)", cmd.Process.Pid)
	}()

	return a, nil
}

// ─── Handle ───────────────────────────────────────────────────────────────────

// Handle bridges a WebSocket connection to an agent with session persistence.
func Handle(conn *websocket.Conn, cfg Config) {
	defer func() { _ = conn.Close() }()

	// ── Spawn a "temp" agent immediately ─────────────────────────────────────
	// We need a running agent right away so that 'initialize' can be answered
	// without waiting for session/new or session/resume.
	tempAgent, err := spawnAgentProc(cfg)
	if err != nil {
		log.Printf("[bridge] spawn temp agent: %v", err)
		_ = conn.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "failed to start agent"))
		return
	}
	tempSub := tempAgent.subscribe()
	tempAgent.startFanOut()
	log.Printf("[bridge] Handle: temp agent spawned, starting writer goroutine")

	// ── Session routing state ─────────────────────────────────────────────────
	var (
		agentMu        sync.Mutex
		curAgent       = tempAgent
		curSub         = tempSub
		sessionMsgID   json.RawMessage // ID of the session/new call
		registeredID   string          // ACP session ID registered in this connection
		intercepted    bool            // true once session/new or session/resume is handled
	)

	// newSubCh lets the main loop signal the writer goroutine to switch channels.
	// Capacity-1 so the sender never blocks.
	newSubCh := make(chan chan []byte, 1)

	// ── WS writer goroutine ───────────────────────────────────────────────────
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		agentMu.Lock()
		sub := curSub
		agentMu.Unlock()
		log.Printf("[bridge] writer goroutine started, waiting on sub channel")

		for {
			select {
			case line, ok := <-sub:
				if !ok {
					// sub was closed (agent exit or explicit unsubscribe).
					// Wait for a replacement sub, or exit if newSubCh is closed.
					log.Printf("[bridge] writer: sub closed, waiting for newSubCh")
					newSub, ok := <-newSubCh
					if !ok {
						log.Printf("[bridge] writer: newSubCh closed, exiting")
						return
					}
					sub = newSub
					log.Printf("[bridge] writer: switched to new sub")
					continue
				}

				log.Printf("[bridge] writer: received line from agent (%d bytes)", len(line))

				// Capture ACP session ID from session/new response.
				if len(sessionMsgID) > 0 && registeredID == "" {
					var resp rpcMsg
					if json.Unmarshal(line, &resp) == nil &&
						len(resp.ID) > 0 && len(resp.Result) > 0 && len(resp.Error) == 0 &&
						string(resp.ID) == string(sessionMsgID) {
						var result sessionNewResult
						if json.Unmarshal(resp.Result, &result) == nil && result.SessionID != "" {
							registeredID = result.SessionID
							agentMu.Lock()
							a := curAgent
							agentMu.Unlock()
							globalStore.register(registeredID, a)
						}
					}
				}

				_ = conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
				if err := conn.WriteMessage(websocket.TextMessage, line); err != nil {
					log.Printf("[bridge] writer: WS write error: %v", err)
					return
				}
				log.Printf("[bridge] writer: forwarded to WS (%d bytes)", len(line))

			case newSub, ok := <-newSubCh:
				if !ok {
					log.Printf("[bridge] writer: newSubCh closed, exiting")
					return
				}
				sub = newSub
				log.Printf("[bridge] writer: switched to new sub via select")
			}
		}
	}()

	// ── WS reader / routing loop ──────────────────────────────────────────────
	for {
		mt, raw, err := conn.ReadMessage()
		if err != nil {
			log.Printf("[bridge] reader: ReadMessage error: %v", err)
			break
		}
		if mt != websocket.TextMessage {
			continue
		}

		log.Printf("[bridge] reader: received from WS (%d bytes): %s", len(raw), raw)

		if !intercepted {
			var rpc rpcMsg
			if jsonErr := json.Unmarshal(raw, &rpc); jsonErr == nil {
				switch rpc.Method {
				case "session/resume":
					var p sessionResumeParams
					if len(rpc.Params) > 0 {
						_ = json.Unmarshal(rpc.Params, &p)
					}

					if p.SessionID != "" {
						if existing, ok := globalStore.get(p.SessionID); ok {
							log.Printf("[bridge] resuming existing session %s", p.SessionID)
							existing.touch()

							// Switch: abandon temp agent, use existing.
							// 1. Unsubscribe from temp agent (closes tempSub → writer blocks on newSubCh).
							tempAgent.unsubscribe(tempSub)
							// 2. Kill the temp agent process (it was never registered).
							if tempAgent.cmd.Process != nil {
								_ = tempAgent.cmd.Process.Kill()
							}
							_ = tempAgent.cmd.Wait()

							// 3. Subscribe to existing agent.
							newSub := existing.subscribe()
							agentMu.Lock()
							curAgent = existing
							curSub = newSub
							agentMu.Unlock()

							// 4. Hand new sub to writer goroutine.
							newSubCh <- newSub

							// 5. Forward session/resume to existing agent.
							if _, fwErr := fmt.Fprintf(existing.stdin, "%s\n", raw); fwErr != nil {
								log.Printf("[bridge] session/resume write: %v", fwErr)
							}
							intercepted = true
							continue
						}
					}

					// Session not found — keep temp agent, convert to session/new.
					log.Printf("[bridge] session %s not found — spawning fresh session", p.SessionID)
					cwd := p.CWD
					if cwd == "" {
						cwd = "/"
					}
					newParams, _ := json.Marshal(sessionNewParams{
						CWD: cwd, MCPServers: []interface{}{},
					})
					converted, _ := json.Marshal(rpcMsg{
						JSONRPC: "2.0",
						ID:      rpc.ID,
						Method:  "session/new",
						Params:  newParams,
					})
					sessionMsgID = rpc.ID
					agentMu.Lock()
					a := curAgent
					agentMu.Unlock()
					log.Printf("[bridge] forwarding converted session/new to agent stdin")
					if _, fwErr := fmt.Fprintf(a.stdin, "%s\n", converted); fwErr != nil {
						log.Printf("[bridge] converted session/new write: %v", fwErr)
					}
					intercepted = true
					continue

				case "session/new":
					sessionMsgID = rpc.ID
					intercepted = true
					// Fall through to forward the message.
				}
			}
		}

		// Forward to current agent.
		agentMu.Lock()
		a := curAgent
		agentMu.Unlock()
		a.touch()
		log.Printf("[bridge] forwarding %q to agent stdin", func() string {
			var rpc rpcMsg
			if json.Unmarshal(raw, &rpc) == nil {
				return rpc.Method
			}
			return "(unknown)"
		}())
		if _, fwErr := fmt.Fprintf(a.stdin, "%s\n", raw); fwErr != nil {
			log.Printf("[bridge] stdin write: %v", fwErr)
			break
		}
	}

	// ── WS disconnected ───────────────────────────────────────────────────────
	// Close newSubCh to signal the writer goroutine to exit.
	close(newSubCh)

	// Unsubscribe from the current agent so the fan-out stops forwarding
	// to the now-dead WS.
	agentMu.Lock()
	a := curAgent
	s := curSub
	agentMu.Unlock()
	a.unsubscribe(s)

	// Wait for writer to finish.
	<-writerDone

	// Check whether the agent itself exited.
	select {
	case <-a.done:
		// Agent process ended — clean up.
		if registeredID != "" {
			globalStore.delete(registeredID)
			log.Printf("[bridge] agent exited, removed session %s", registeredID)
		}
		if a.cmd.Process != nil {
			_ = a.cmd.Process.Kill()
		}
		_ = a.cmd.Wait()
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		_ = conn.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, "agent exited"))
	default:
		// Agent still running — keep alive for session resume.
		if registeredID != "" {
			log.Printf("[bridge] WS disconnected; agent kept alive for session %s", registeredID)
		}
	}
}
