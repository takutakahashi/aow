/**
 * WebSocket ACP server.
 *
 * Listens for incoming WebSocket connections and, for each one, spawns an
 * ACP-compatible agent process via stdio. Incoming WebSocket frames are
 * forwarded to the agent's stdin, and the agent's stdout is forwarded back
 * as WebSocket frames.
 *
 * The server acts as a **transparent proxy** — it does not interpret ACP
 * messages itself. All protocol handling is end-to-end between the remote
 * client library and the spawned agent process.
 *
 * ```
 * [WS Client] <── WebSocket ──> [WebSocketACPServer] <── stdio ──> [Agent process]
 * ```
 *
 * @example
 * ```ts
 * import { WebSocketACPServer, bearerAuth } from "acp-websocket-transport";
 *
 * const server = new WebSocketACPServer({
 *   port: 3000,
 *   command: "node",
 *   args: ["dist/my-agent.js"],
 *   verifyClient: bearerAuth(["my-secret-token"]),
 * });
 *
 * await server.listening();
 * console.log("Listening on", server.address);
 * ```
 */

import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { Stream } from "@agentclientprotocol/sdk";
import { wsStream } from "./transport.js";
import type { VerifyClientFn, VerifyClientInfo } from "./auth.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Error context indicating which subsystem produced the error. */
export type ErrorContext = "websocket" | "process" | "bridge";

/**
 * Configuration options for {@link WebSocketACPServer}.
 */
export interface WebSocketACPServerOptions {
  /**
   * TCP port to listen on.
   * Use `0` to let the OS pick an available port (useful in tests).
   */
  port: number;

  /**
   * The command to spawn for each incoming WebSocket connection.
   * This should be the path to an ACP-compatible agent executable.
   *
   * @example "node"
   * @example "/usr/bin/my-agent"
   */
  command: string;

  /** Arguments to pass to the spawned command. */
  args?: string[];

  /**
   * Additional environment variables merged into the spawned process's
   * environment (on top of the current `process.env`).
   */
  env?: Record<string, string>;

  /**
   * Hostname / IP address to bind to.
   * @default "localhost"
   */
  host?: string;

  /**
   * Optional authentication callback invoked on every incoming WebSocket
   * upgrade request. Return `true` to allow the connection or `false` to
   * reject it with HTTP 401.
   *
   * If omitted, all connections are accepted (no authentication).
   *
   * @see {@link bearerAuth}, {@link basicAuth}, {@link apiKeyAuth}, {@link anyAuth}
   */
  verifyClient?: VerifyClientFn;

  /**
   * Called when an unhandled error occurs in any subsystem.
   * Useful for logging — the server attempts to recover gracefully regardless.
   */
  onError?: (err: Error, context: ErrorContext) => void;
}

// ─── Server ───────────────────────────────────────────────────────────────────

/**
 * WebSocket server that bridges ACP clients to stdio-based ACP agent processes.
 *
 * Each accepted WebSocket connection spawns one agent subprocess. The connection
 * and subprocess lifecycles are tied together:
 * - Agent exits → WebSocket is closed with code 1001
 * - WebSocket closes → agent receives SIGTERM (then SIGKILL after 5 s)
 */
export class WebSocketACPServer {
  private readonly wss: WebSocketServer;
  private readonly sessions = new Map<WebSocket, ChildProcess>();
  private readonly options: WebSocketACPServerOptions;

  constructor(options: WebSocketACPServerOptions) {
    this.options = options;

    this.wss = new WebSocketServer({
      port: options.port,
      host: options.host ?? "localhost",
      // Wire verifyClient when provided
      ...(options.verifyClient != null
        ? {
            verifyClient: (
              info: VerifyClientInfo,
              done: (
                result: boolean,
                code?: number,
                message?: string
              ) => void
            ) => {
              Promise.resolve(options.verifyClient!(info))
                .then((ok) =>
                  done(ok, ok ? 200 : 401, ok ? "OK" : "Unauthorized")
                )
                .catch((err: Error) => {
                  options.onError?.(err, "websocket");
                  done(false, 500, "Internal Server Error");
                });
            },
          }
        : {}),
    });

    this.wss.on("connection", this.handleConnection.bind(this));
    this.wss.on("error", (err: Error) => {
      options.onError?.(err, "websocket");
    });
  }

  // ─── Connection handler ─────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    const { command, args = [], env = {}, onError } = this.options;

    // Spawn the agent process with all stdio piped
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    this.sessions.set(ws, child);

    // Relay agent stderr → server stderr for debuggability
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[${command} stderr] ${chunk.toString()}`);
    });

    // Build the stdio Stream for the agent
    // ndJsonStream(output, input):
    //   output = WritableStream the SDK writes messages TO  (→ child stdin)
    //   input  = ReadableStream the SDK reads messages FROM (← child stdout)
    const agentStream: Stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
    );

    // Build the WebSocket Stream for the remote client
    const clientStream: Stream = wsStream(ws);

    // Acquire readers upfront so each pump can cancel the other's reader
    // when an error occurs, preventing the peer from blocking indefinitely.
    const agentReader = agentStream.readable.getReader();
    const clientReader = clientStream.readable.getReader();

    // Bidirectional bridge (transparent proxy — no ACP interpretation)
    void this.pumpWithReader(
      clientReader,
      agentStream.writable,
      "client → agent",
      onError,
      () => { agentReader.cancel("client pump closed").catch(() => {}); }
    );
    void this.pumpWithReader(
      agentReader,
      clientStream.writable,
      "agent → client",
      onError,
      () => { clientReader.cancel("agent pump closed").catch(() => {}); }
    );

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    // Agent exits → close WebSocket
    child.on("exit", (code, signal) => {
      this.sessions.delete(ws);
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close(1001, `Agent exited (${signal ?? String(code)})`);
      }
    });

    child.on("error", (err: Error) => {
      onError?.(err, "process");
      this.sessions.delete(ws);
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close(1011, "Agent process error");
      }
    });

    // WebSocket closes → terminate agent
    ws.on("close", () => {
      this.sessions.delete(ws);
      if (!child.killed) {
        child.kill("SIGTERM");
        // Grace period: escalate to SIGKILL after 5 s if the process persists
        const t = setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5_000);
        // Don't prevent the Node.js event loop from exiting due to this timer
        if (typeof t.unref === "function") t.unref();
      }
    });
  }

  // ─── Stream pump ────────────────────────────────────────────────────────────

  /**
   * Reads all messages from `reader` and writes them to `dst`.
   * On error: forwards to `onError`, invokes `cancelPeer` to unblock the
   * opposite pump direction, then aborts the writer.
   *
   * Callers must acquire `reader` before calling this method so that both
   * pump directions can hold references to each other's reader for
   * cross-cancellation.
   */
  private async pumpWithReader(
    reader: ReadableStreamDefaultReader<unknown>,
    dst: WritableStream<unknown>,
    _label: string,
    onError?: (err: Error, context: ErrorContext) => void,
    cancelPeer?: () => void
  ): Promise<void> {
    const writer = dst.getWriter();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
      await writer.close();
    } catch (err) {
      onError?.(err as Error, "bridge");
      // Cancel the peer direction so it doesn't block waiting for messages
      // that will never arrive after this side has failed.
      cancelPeer?.();
      await writer.abort(err).catch(() => {
        /* ignore secondary errors during abort */
      });
    } finally {
      reader.releaseLock();
      writer.releaseLock();
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Returns a Promise that resolves once the server is bound and listening.
   * Useful for waiting before connecting clients in tests or examples.
   */
  listening(): Promise<void> {
    return new Promise((resolve) => {
      if (this.wss.address() !== null) {
        // Already listening
        resolve();
      } else {
        this.wss.once("listening", resolve);
      }
    });
  }

  /**
   * Closes the server: stops accepting new connections, terminates all active
   * agent sessions, and resolves once the underlying server socket is closed.
   */
  async close(): Promise<void> {
    // Hard-terminate all active connections so wss.close() callback fires promptly
    for (const [ws, child] of this.sessions) {
      child.kill("SIGTERM");
      ws.terminate(); // immediately destroy the socket (no close handshake needed)
    }
    this.sessions.clear();

    return new Promise((resolve, reject) => {
      this.wss.close((err) => {
        if (err != null) reject(err);
        else resolve();
      });
      // Safety net: resolve after 2 s in case the callback stalls
      setTimeout(resolve, 2_000).unref?.();
    });
  }

  /**
   * The address the server is listening on, or `null` if not yet listening.
   * Cast to `AddressInfo` after calling {@link listening()} when binding to a
   * numeric port (including `0`).
   */
  get address() {
    return this.wss.address();
  }
}
