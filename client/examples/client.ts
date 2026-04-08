/**
 * Example: connect to the ACP WebSocket server with the client library.
 *
 * Usage (start the server first):
 *   node dist/examples/server.js
 *   node dist/examples/client.js
 */

import { createClientConnection } from "../src/index.js";
import type { SessionNotification } from "@agentclientprotocol/sdk";

const { connection, close } = await createClientConnection(
  "ws://localhost:3000",
  {
    // Optional: supply auth credentials
    // ...withBearerToken("my-secret-token"),

    toClient: (_agent) => ({
      sessionUpdate: async (params: SessionNotification) => {
        const { update } = params;
        if (
          "content" in update &&
          update.content != null &&
          !Array.isArray(update.content) &&
          update.content.type === "text" &&
          "text" in update.content
        ) {
          console.log(`[agent] ${update.content.text}`);
        }
      },
      requestPermission: async () => ({
        outcome: "allow_once" as const,
      }),
    }),
  }
);

// ── ACP handshake ─────────────────────────────────────────────────────────────

const initResult = await connection.initialize({
  protocolVersion: 0,
  clientInfo: { name: "example-client", version: "0.1.0" },
  clientCapabilities: {},
});

console.log(
  `Connected to agent: ${initResult.agentInfo?.name} v${initResult.agentInfo?.version}`
);

// ── Create a session ──────────────────────────────────────────────────────────

const session = await connection.newSession({
  cwd: process.cwd(),
  mcpServers: [],
});

console.log(`Session created: ${session.sessionId}`);

// ── Send a prompt ─────────────────────────────────────────────────────────────

console.log(`Sending prompt…`);
const result = await connection.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: "Hello from the example client!" }],
});

console.log(`Turn ended with stopReason: ${result.stopReason}`);

// ── Cleanup ───────────────────────────────────────────────────────────────────

close();
console.log("Connection closed.");
