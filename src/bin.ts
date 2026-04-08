#!/usr/bin/env node
/**
 * acp-ws-server — CLI entry point for the ACP WebSocket server.
 *
 * Usage:
 *   acp-ws-server [options] -- <command> [args...]
 *
 * Everything after `--` is the command used to spawn the ACP agent process
 * for each incoming WebSocket connection.
 *
 * Options:
 *   --port, -p <n>          TCP port to listen on (default: 3000)
 *   --host <host>           Hostname/IP to bind to (default: localhost)
 *   --bearer-token <tok>    Accept only connections with this Bearer token
 *                           (repeatable for multiple valid tokens)
 *   --api-key-header <hdr>  Header name used for API key auth (e.g. x-api-key)
 *   --api-key <key>         API key value; requires --api-key-header
 *                           (repeatable for multiple valid keys)
 *   --help, -h              Show this help message
 *
 * Examples:
 *   acp-ws-server -- node dist/my-agent.js
 *   acp-ws-server --port 8080 -- python my_agent.py --model gpt-4
 *   acp-ws-server --bearer-token secret -- node dist/my-agent.js
 *   acp-ws-server --api-key-header x-api-key --api-key abc123 -- node dist/agent.js
 */

import { parseArgs } from "node:util";
import { WebSocketACPServer } from "./server.js";
import { bearerAuth, apiKeyAuth, anyAuth } from "./auth.js";
import type { VerifyClientFn } from "./auth.js";

// ─── Parse arguments ──────────────────────────────────────────────────────────

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    port:            { type: "string",  short: "p", default: "3000" },
    host:            { type: "string",  default: "localhost" },
    "bearer-token":  { type: "string",  multiple: true },
    "api-key-header":{ type: "string" },
    "api-key":       { type: "string",  multiple: true },
    help:            { type: "boolean", short: "h", default: false },
  },
});

// ─── Help ─────────────────────────────────────────────────────────────────────

if (values.help) {
  console.log(`\
acp-ws-server — ACP WebSocket transport server

Usage:
  acp-ws-server [options] -- <command> [args...]

Options:
  --port, -p <n>            TCP port to listen on (default: 3000)
  --host <host>             Hostname/IP to bind to (default: localhost)
  --bearer-token <token>    Accept only Bearer <token>. Repeatable.
  --api-key-header <header> Header name for API key auth (e.g. x-api-key)
  --api-key <key>           Valid API key. Repeatable. Requires --api-key-header.
  --help, -h                Show this help

Examples:
  acp-ws-server -- node dist/my-agent.js
  acp-ws-server --port 8080 -- python my_agent.py
  acp-ws-server --bearer-token secret -- node dist/my-agent.js
  acp-ws-server --api-key-header x-api-key --api-key k1 --api-key k2 -- node dist/agent.js
`);
  process.exit(0);
}

// ─── Validate: positionals must contain the agent command ────────────────────

if (positionals.length === 0) {
  console.error(
    "error: no agent command provided.\n" +
    "Usage: acp-ws-server [options] -- <command> [args...]\n" +
    "Run with --help for details."
  );
  process.exit(1);
}

const [command, ...args] = positionals as [string, ...string[]];

// ─── Auth ─────────────────────────────────────────────────────────────────────

const verifiers: VerifyClientFn[] = [];

const bearerTokens = values["bearer-token"];
if (bearerTokens != null && bearerTokens.length > 0) {
  verifiers.push(bearerAuth(bearerTokens));
}

const apiKeyHeader = values["api-key-header"];
const apiKeys = values["api-key"];
if (apiKeyHeader != null) {
  if (apiKeys == null || apiKeys.length === 0) {
    console.error("error: --api-key-header requires at least one --api-key value.");
    process.exit(1);
  }
  verifiers.push(apiKeyAuth(apiKeyHeader, apiKeys));
} else if (apiKeys != null && apiKeys.length > 0) {
  console.error("error: --api-key requires --api-key-header.");
  process.exit(1);
}

const verifyClient: VerifyClientFn | undefined =
  verifiers.length === 0 ? undefined :
  verifiers.length === 1 ? verifiers[0] :
  anyAuth(...verifiers);

// ─── Start server ─────────────────────────────────────────────────────────────

const port = parseInt(values.port ?? "3000", 10);
if (Number.isNaN(port) || port < 1 || port > 65535) {
  console.error(`error: invalid port: ${values.port}`);
  process.exit(1);
}

const serverOptions = {
  port,
  host: values.host,
  command,
  args,
  onError: (err: Error, ctx: import("./server.js").ErrorContext) => {
    console.error(`[acp-ws-server] ${ctx} error:`, err.message);
  },
  ...(verifyClient != null ? { verifyClient } : {}),
};

const server = new WebSocketACPServer(serverOptions);

await server.listening();

const addr = server.address;
const boundAddr = typeof addr === "object" && addr !== null
  ? `${addr.address}:${addr.port}`
  : String(addr);

console.log(`acp-ws-server listening on ws://${boundAddr}`);
console.log(`agent command: ${command}${args.length ? " " + args.join(" ") : ""}`);
if (verifyClient != null) {
  const methods: string[] = [];
  if (bearerTokens != null && bearerTokens.length > 0) methods.push("bearer-token");
  if (apiKeyHeader != null) methods.push(`api-key (${apiKeyHeader})`);
  console.log(`authentication: ${methods.join(", ")}`);
} else {
  console.log("authentication: none (all connections accepted)");
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    console.log(`\nReceived ${signal} — shutting down…`);
    await server.close();
    process.exit(0);
  });
}
