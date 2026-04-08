// acp-ws-server — WebSocket transport server for ACP (Agent Client Protocol).
//
// Each accepted WebSocket connection spawns one ACP-compatible agent process
// via stdio. The server acts as a transparent proxy: it pipes raw JSON-RPC
// messages between the remote client and the agent process without interpreting
// the protocol.
//
// Authentication is intentionally NOT handled here — delegate it to a reverse
// proxy (nginx, Caddy, Envoy, …) sitting in front of this server.
// X-Forwarded-For / X-Forwarded-Proto / X-Real-IP headers are logged for
// observability.
//
// Usage:
//
//	acp-ws-server [options] -- <command> [args...]
//
// Everything after "--" is the command used to spawn the agent process.
//
// Options:
//
//	--port, -p <n>   TCP port to listen on (default: 3000)
//	--host <host>    Hostname/IP to bind to (default: localhost)
//	--help, -h       Print this help and exit
//
// Examples:
//
//	acp-ws-server -- node dist/my-agent.js
//	acp-ws-server --port 8080 -- python my_agent.py --model gpt-4
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/takutakahashi/aow/server/internal/bridge"
)

func main() {
	// ── flags ─────────────────────────────────────────────────────────────────
	fs := flag.NewFlagSet("acp-ws-server", flag.ExitOnError)
	fs.Usage = func() {
		fmt.Fprintf(os.Stderr, `acp-ws-server — ACP WebSocket transport server

Usage:
  acp-ws-server [options] -- <command> [args...]

Options:
  --port, -p <n>   TCP port to listen on (default: 3000)
  --host <host>    Hostname/IP to bind to (default: localhost)
  --help, -h       Show this help

Note:
  Authentication is handled by a reverse proxy (nginx, Caddy, Envoy, …).
  X-Forwarded-For / X-Real-IP headers are preserved and logged.

Examples:
  acp-ws-server -- node dist/my-agent.js
  acp-ws-server --port 8080 -- python my_agent.py --model gpt-4
`)
	}

	port := fs.Int("port", 3000, "TCP port to listen on")
	fs.IntVar(port, "p", 3000, "TCP port to listen on (shorthand)")
	host := fs.String("host", "localhost", "Hostname/IP to bind to")
	help := fs.Bool("help", false, "Show help")
	fs.BoolVar(help, "h", false, "Show help (shorthand)")

	if err := fs.Parse(os.Args[1:]); err != nil {
		os.Exit(1)
	}

	if *help {
		fs.Usage()
		os.Exit(0)
	}

	// ── agent command (everything after --) ───────────────────────────────────
	remaining := fs.Args()
	if len(remaining) == 0 {
		fmt.Fprintf(os.Stderr,
			"error: no agent command provided.\n"+
				"Usage: acp-ws-server [options] -- <command> [args...]\n"+
				"Run with --help for details.\n")
		os.Exit(1)
	}
	agentCommand := remaining[0]
	agentArgs := remaining[1:]

	// ── validate port ─────────────────────────────────────────────────────────
	if *port < 1 || *port > 65535 {
		fmt.Fprintf(os.Stderr, "error: invalid port: %d\n", *port)
		os.Exit(1)
	}

	// ── WebSocket upgrader ────────────────────────────────────────────────────
	// CheckOrigin always returns true: origin enforcement is the reverse proxy's
	// responsibility, not this server's.
	// ⚠️  Do NOT expose this server directly to the internet without a reverse
	// proxy (nginx, Caddy, Envoy, …) that enforces origin and authentication.
	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true },
	}

	bridgeCfg := bridge.Config{
		Command: agentCommand,
		Args:    agentArgs,
	}

	// ── HTTP handler ──────────────────────────────────────────────────────────
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Log the client identity as seen by the reverse proxy.
		// Sanitize header values to prevent log injection via embedded newlines.
		sanitize := func(s string) string {
			return strings.NewReplacer("\n", "", "\r", "").Replace(s)
		}
		clientIP := sanitize(r.Header.Get("X-Real-IP"))
		if clientIP == "" {
			clientIP = sanitize(r.Header.Get("X-Forwarded-For"))
		}
		if clientIP == "" {
			clientIP = r.RemoteAddr
		}
		log.Printf("new connection from %s (proto=%s)", clientIP, sanitize(r.Header.Get("X-Forwarded-Proto")))

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("ws upgrade: %v", err)
			return
		}

		go bridge.Handle(conn, bridgeCfg)
	})

	// ── listener ──────────────────────────────────────────────────────────────
	addr := fmt.Sprintf("%s:%d", *host, *port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("listen %s: %v", addr, err)
	}

	boundAddr := ln.Addr().(*net.TCPAddr)
	log.Printf("acp-ws-server listening on ws://%s", boundAddr)
	log.Printf("agent command: %s %v", agentCommand, agentArgs)
	log.Printf("authentication: delegated to reverse proxy")

	server := &http.Server{}

	// ── graceful shutdown ─────────────────────────────────────────────────────
	// On SIGTERM / SIGINT, stop accepting new connections and give in-flight
	// WebSocket sessions up to 30 s to finish before forcing a close.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-sigCh
		log.Printf("received %s — shutting down (30 s drain)", sig)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}()

	if err := server.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server: %v", err)
	}
}
