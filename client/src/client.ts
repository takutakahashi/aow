/**
 * ACP WebSocket client library.
 *
 * Provides a high-level `createClientConnection` function that opens a WebSocket
 * to an {@link WebSocketACPServer} (or any ACP-over-WebSocket server) and returns
 * a fully initialized `ClientSideConnection` from `@agentclientprotocol/sdk`.
 *
 * Authentication helpers (`withBearerToken`, `withBasicAuth`, `withApiKey`) generate
 * the `wsOptions` fragment needed to pass credentials during the HTTP upgrade handshake.
 *
 * @example Bearer token
 * ```ts
 * import { createClientConnection, withBearerToken } from "acp-websocket-transport";
 *
 * const { connection, close } = await createClientConnection(
 *   "ws://localhost:3000",
 *   {
 *     ...withBearerToken("my-secret"),
 *     toClient: (agent) => ({
 *       sessionUpdate: async (params) => { console.log(params); },
 *       requestPermission: async () => ({ outcome: "allow_once" }),
 *     }),
 *   }
 * );
 *
 * const init = await connection.initialize({ protocolVersion: 0, clientCapabilities: {} });
 * console.log(init.agentInfo);
 * close();
 * ```
 */

import WebSocket from "ws";
import { ClientSideConnection } from "@agentclientprotocol/sdk";
import type { Stream } from "@agentclientprotocol/sdk";
import { wsStream } from "./transport.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Factory function type accepted by `ClientSideConnection`. */
type ToClientFactory = ConstructorParameters<typeof ClientSideConnection>[0];

/**
 * Options for {@link createClientConnection}.
 */
export interface ClientConnectionOptions {
  /**
   * Factory that creates the `Client` handler for incoming agent requests
   * (e.g. `session/update` notifications, `session/request_permission`).
   *
   * If omitted, a no-op handler is used — suitable for fire-and-forget or
   * when the caller only needs to make outgoing requests.
   */
  toClient?: ToClientFactory;

  /**
   * WebSocket subprotocols to negotiate during the upgrade handshake.
   */
  protocols?: string | string[];

  /**
   * Additional options passed directly to the `ws` WebSocket constructor.
   * Use this to set custom headers (e.g. authentication) or TLS options.
   *
   * @see {@link withBearerToken}, {@link withBasicAuth}, {@link withApiKey}
   */
  wsOptions?: WebSocket.ClientOptions;

  /**
   * Milliseconds to wait for the WebSocket connection to open.
   * @default 10000
   */
  connectTimeout?: number;
}

/**
 * The result of {@link createClientConnection}.
 */
export interface ClientConnection {
  /** The ACP `ClientSideConnection` — use this to call agent methods. */
  connection: ClientSideConnection;
  /** The underlying bidirectional stream (rarely needed directly). */
  stream: Stream;
  /** Closes the WebSocket and tears down the connection. */
  close: () => void;
}

// ─── Connection factory ───────────────────────────────────────────────────────

/**
 * Opens a WebSocket connection to an ACP server and returns a
 * `ClientSideConnection` ready for use.
 *
 * @param url  WebSocket URL of the ACP server (e.g. `"ws://localhost:3000"`)
 * @param options  Optional configuration (auth headers, client handler, timeout)
 * @throws If the WebSocket fails to open within `connectTimeout` ms
 */
export async function createClientConnection(
  url: string | URL,
  options: ClientConnectionOptions = {}
): Promise<ClientConnection> {
  const { toClient, protocols, wsOptions, connectTimeout = 10_000 } = options;

  const ws = new WebSocket(url, protocols, wsOptions);

  await waitForOpen(ws, connectTimeout);

  const stream = wsStream(ws);

  // Default no-op client for callers that only make outgoing requests
  const noopClient: ToClientFactory = () => ({
    sessionUpdate: async () => {},
    requestPermission: async () => ({
      outcome: "reject_once" as const,
    }),
  });

  const connection = new ClientSideConnection(toClient ?? noopClient, stream);

  const close = () => ws.close(1000, "Client closed");

  return { connection, stream, close };
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

/**
 * Returns the `wsOptions` fragment needed to authenticate with a Bearer token.
 *
 * Spread this into the options passed to {@link createClientConnection}:
 * ```ts
 * await createClientConnection(url, { ...withBearerToken("tok"), toClient });
 * ```
 */
export function withBearerToken(
  token: string
): Pick<ClientConnectionOptions, "wsOptions"> {
  return {
    wsOptions: { headers: { Authorization: `Bearer ${token}` } },
  };
}

/**
 * Returns the `wsOptions` fragment needed for HTTP Basic authentication.
 *
 * ⚠️ Use TLS (`wss://`) in production — credentials are only base64-encoded.
 */
export function withBasicAuth(
  username: string,
  password: string
): Pick<ClientConnectionOptions, "wsOptions"> {
  const encoded = Buffer.from(`${username}:${password}`).toString("base64");
  return {
    wsOptions: { headers: { Authorization: `Basic ${encoded}` } },
  };
}

/**
 * Returns the `wsOptions` fragment needed to authenticate via an arbitrary
 * HTTP header (e.g. an API key).
 *
 * @param header  Header name (e.g. `"x-api-key"`)
 * @param key     The key value
 */
export function withApiKey(
  header: string,
  key: string
): Pick<ClientConnectionOptions, "wsOptions"> {
  return {
    wsOptions: { headers: { [header]: key } },
  };
}

// ─── Internals ────────────────────────────────────────────────────────────────

/**
 * Waits for a WebSocket to transition to the OPEN state, with a timeout.
 */
function waitForOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      ws.terminate();
      reject(
        new Error(`WebSocket connection timed out after ${timeoutMs}ms`)
      );
    }, timeoutMs);

    const cleanup = () => clearTimeout(timer);

    ws.once("open", () => {
      cleanup();
      resolve();
    });

    ws.once("error", (err: Error) => {
      cleanup();
      reject(err);
    });

    ws.once("close", (code: number, reason: Buffer) => {
      cleanup();
      reject(
        new Error(
          `WebSocket closed before open: ${code} ${reason.toString()}`
        )
      );
    });
  });
}
