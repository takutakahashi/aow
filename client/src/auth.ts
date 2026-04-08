/**
 * Authentication helpers for the ACP WebSocket server.
 *
 * WebSocket connections begin with an HTTP Upgrade request, so standard HTTP
 * authentication mechanisms (Bearer token, Basic auth, API key headers) can be
 * applied directly at the handshake stage — before the WebSocket is established.
 *
 * The `ws` library exposes a `verifyClient` callback that receives the HTTP
 * Upgrade request and can accept or reject the connection. This module provides
 * the {@link VerifyClientFn} type and a set of built-in factory functions for
 * common authentication schemes.
 *
 * @example Bearer token
 * ```ts
 * const server = new WebSocketACPServer({
 *   port: 3000,
 *   command: "my-agent",
 *   verifyClient: bearerAuth(["secret-token-alice", "secret-token-bob"]),
 * });
 * ```
 *
 * @example Custom async validator (e.g. database lookup)
 * ```ts
 * const server = new WebSocketACPServer({
 *   port: 3000,
 *   command: "my-agent",
 *   verifyClient: async ({ req }) => {
 *     const token = req.headers["authorization"]?.split(" ")[1] ?? "";
 *     return await db.tokens.isValid(token);
 *   },
 * });
 * ```
 */

import type { IncomingMessage } from "node:http";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Information about the incoming WebSocket upgrade request,
 * as provided by the `ws` library's `verifyClient` callback.
 */
export interface VerifyClientInfo {
  /** The raw Node.js HTTP request for the WebSocket upgrade */
  req: IncomingMessage;
  /** Value of the `Origin` header, or an empty string if absent */
  origin: string;
  /** Whether the connection was made over TLS (i.e. `wss://`) */
  secure: boolean;
}

/**
 * Authentication callback for the WebSocket server.
 *
 * Return (or resolve) `true` to allow the connection, `false` to reject it
 * with HTTP 401 Unauthorized. Rejecting with a custom status code is possible
 * via the lower-level `ws` `verifyClient` API; this interface keeps things simple.
 *
 * May be synchronous or asynchronous.
 */
export type VerifyClientFn = (
  info: VerifyClientInfo
) => boolean | Promise<boolean>;

// ─── Built-in helpers ─────────────────────────────────────────────────────────

/**
 * Bearer token authentication.
 *
 * Accepts connections whose `Authorization` header matches
 * `Bearer <token>` for any token in `validTokens`.
 *
 * @param validTokens - Iterable of accepted token strings
 */
export function bearerAuth(validTokens: Iterable<string>): VerifyClientFn {
  const tokens = new Set(validTokens);
  return ({ req }) => {
    const auth = req.headers["authorization"] ?? "";
    const spaceIdx = auth.indexOf(" ");
    if (spaceIdx === -1) return false;
    const scheme = auth.slice(0, spaceIdx).toLowerCase();
    const token = auth.slice(spaceIdx + 1);
    return scheme === "bearer" && tokens.has(token);
  };
}

/**
 * HTTP Basic authentication.
 *
 * Accepts connections whose `Authorization: Basic <base64(user:pass)>` header
 * matches an entry in `credentials`.
 *
 * ⚠️ Always use TLS (`wss://`) in production — Basic auth credentials are only
 * base64-encoded, not encrypted.
 *
 * @param credentials - Map of `{ username: password }`
 */
export function basicAuth(
  credentials: Record<string, string>
): VerifyClientFn {
  return ({ req }) => {
    const auth = req.headers["authorization"] ?? "";
    const spaceIdx = auth.indexOf(" ");
    if (spaceIdx === -1) return false;
    const scheme = auth.slice(0, spaceIdx).toLowerCase();
    if (scheme !== "basic") return false;
    const encoded = auth.slice(spaceIdx + 1);
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const colonIdx = decoded.indexOf(":");
    if (colonIdx === -1) return false;
    const user = decoded.slice(0, colonIdx);
    const pass = decoded.slice(colonIdx + 1);
    return Object.prototype.hasOwnProperty.call(credentials, user) &&
      credentials[user] === pass;
  };
}

/**
 * API key authentication via an arbitrary HTTP header.
 *
 * Accepts connections that include a matching `<header>: <key>` in their
 * upgrade request. Header name matching is case-insensitive (HTTP spec).
 *
 * @param header - Header name (e.g. `"x-api-key"`)
 * @param validKeys - Iterable of accepted key strings
 *
 * @example
 * ```ts
 * verifyClient: apiKeyAuth("x-api-key", ["key1", "key2"])
 * ```
 */
export function apiKeyAuth(
  header: string,
  validKeys: Iterable<string>
): VerifyClientFn {
  const keys = new Set(validKeys);
  const normalizedHeader = header.toLowerCase();
  return ({ req }) => {
    const value = req.headers[normalizedHeader];
    if (typeof value !== "string") return false;
    return keys.has(value);
  };
}

/**
 * Combines multiple {@link VerifyClientFn}s with OR semantics.
 *
 * The connection is accepted if **any** of the provided verifiers returns `true`.
 * Useful when the server supports multiple authentication methods simultaneously.
 *
 * @param verifiers - One or more VerifyClientFn instances
 *
 * @example
 * ```ts
 * verifyClient: anyAuth(
 *   bearerAuth(["service-token"]),
 *   apiKeyAuth("x-api-key", ["ui-key"]),
 * )
 * ```
 */
export function anyAuth(...verifiers: VerifyClientFn[]): VerifyClientFn {
  return async (info) => {
    for (const verifier of verifiers) {
      if (await verifier(info)) return true;
    }
    return false;
  };
}
