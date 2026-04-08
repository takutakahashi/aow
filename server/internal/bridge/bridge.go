// Package bridge provides the WebSocket ↔ stdio bridge for the ACP server.
//
// For each accepted WebSocket connection, [Handle] spawns the configured agent
// command as a subprocess and pipes ACP messages bidirectionally:
//
//	WS text frame → child stdin  (each frame is a complete JSON-RPC message; a newline is appended)
//	child stdout line → WS frame (each newline-terminated line is sent as a text frame)
//
// The bridge is transparent: it does not interpret ACP messages. All protocol
// handling is end-to-end between the remote client and the agent process.
package bridge

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os/exec"
	"time"

	"github.com/gorilla/websocket"
)

// wsWriteTimeout is the per-message deadline for WebSocket writes.
// A slow or stalled client will be disconnected after this duration
// rather than blocking the stdout relay goroutine indefinitely.
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

// Handle bridges a gorilla WebSocket connection to a freshly spawned agent process.
// It blocks until both sides of the bridge have closed, then returns.
func Handle(conn *websocket.Conn, cfg Config) {
	// Spawn the agent process
	cmd := exec.Command(cfg.Command, cfg.Args...) //nolint:gosec
	cmd.Env = append(cmd.Environ(), cfg.Env...)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		log.Printf("bridge: StdinPipe: %v", err)
		_ = conn.Close()
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		log.Printf("bridge: StdoutPipe: %v", err)
		_ = conn.Close()
		return
	}
	// Relay agent stderr to server stderr for debuggability
	cmd.Stderr = log.Writer()

	if err := cmd.Start(); err != nil {
		log.Printf("bridge: start agent: %v", err)
		_ = conn.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "failed to start agent"))
		_ = conn.Close()
		return
	}

	done := make(chan struct{}, 2)

	// ── WS → stdin ───────────────────────────────────────────────────────────
	// Each WebSocket text frame is one complete JSON-RPC message.
	// The stdio agent (ndJsonStream) expects newline-delimited JSON,
	// so we append '\n' after each frame.
	go func() {
		defer func() {
			_ = stdin.Close()
			done <- struct{}{}
		}()
		for {
			mt, msg, err := conn.ReadMessage()
			if err != nil {
				// Normal close or network error — stop the loop
				return
			}
			if mt != websocket.TextMessage {
				continue // ACP uses only text frames
			}
			if _, err := fmt.Fprintf(stdin, "%s\n", msg); err != nil {
				return
			}
		}
	}()

	// ── stdout → WS ──────────────────────────────────────────────────────────
	// The agent writes one JSON-RPC message per line.
	// We strip the trailing newline and send as a WebSocket text frame.
	go func() {
		defer func() {
			done <- struct{}{}
		}()
		scanner := bufio.NewScanner(stdout)
		// Allow large messages (default is 64 KiB)
		scanner.Buffer(make([]byte, 0, 1<<20), 10<<20) // up to 10 MiB per message
		for scanner.Scan() {
			line := scanner.Bytes()
			if len(line) == 0 {
				continue
			}
			// Set a per-write deadline so a slow/stalled client cannot block
			// this goroutine (and thus the agent's stdout) indefinitely.
			_ = conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
			if err := conn.WriteMessage(websocket.TextMessage, line); err != nil {
				return
			}
		}
	}()

	// Wait for both goroutines to finish
	<-done
	<-done

	// Terminate the agent if still running
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	_ = cmd.Wait()

	// Close the WebSocket gracefully
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_ = conn.WriteMessage(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, "agent exited"))
	_ = conn.Close()
}

// pipeCloser wraps an io.WriteCloser so that closing it also signals the
// reader end. Used internally to stop the stdin pump.
func init() {
	// Ensure unused import is not flagged — io is used in the signature below.
	_ = io.Discard
}
