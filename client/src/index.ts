/**
 * acp-websocket-transport
 *
 * WebSocket transport layer for ACP (Agent Client Protocol).
 *
 * ## Architecture
 *
 * ```
 * [Client Library] <── WebSocket ──> [WebSocketACPServer] <── stdio ──> [ACP Agent]
 * ```
 *
 * The server acts as a transparent proxy: it spawns one ACP agent subprocess per
 * WebSocket connection and pipes raw JSON-RPC messages between them.
 *
 * Authentication is handled at the HTTP Upgrade handshake stage using standard
 * HTTP mechanisms (Bearer token, Basic auth, API key header).
 *
 * ## Quick start
 *
 * **Server:**
 * ```ts
 * import { WebSocketACPServer, bearerAuth } from "acp-websocket-transport";
 *
 * const server = new WebSocketACPServer({
 *   port: 3000,
 *   command: "node",
 *   args: ["dist/my-agent.js"],
 *   verifyClient: bearerAuth(["my-secret-token"]),
 * });
 * await server.listening();
 * ```
 *
 * **Client:**
 * ```ts
 * import { createClientConnection, withBearerToken } from "acp-websocket-transport";
 *
 * const { connection, close } = await createClientConnection(
 *   "ws://localhost:3000",
 *   withBearerToken("my-secret-token")
 * );
 *
 * const init = await connection.initialize({ protocolVersion: 0, clientCapabilities: {} });
 * console.log(init.agentInfo);
 * close();
 * ```
 */

// ── Transport primitive ───────────────────────────────────────────────────────

/**
 * Creates an ACP `Stream` from an open `ws` WebSocket.
 * This is the foundational building block — server and client both use it internally.
 */
export { wsStream } from "./transport.js";

// ── Server ────────────────────────────────────────────────────────────────────

export { WebSocketACPServer } from "./server.js";
export type { WebSocketACPServerOptions, ErrorContext } from "./server.js";

// ── Client ────────────────────────────────────────────────────────────────────

export { createClientConnection, withBearerToken, withBasicAuth, withApiKey } from "./client.js";
export type { ClientConnectionOptions, ClientConnection } from "./client.js";

// ── Auth helpers ──────────────────────────────────────────────────────────────

export { bearerAuth, basicAuth, apiKeyAuth, anyAuth } from "./auth.js";
export type { VerifyClientFn, VerifyClientInfo } from "./auth.js";
