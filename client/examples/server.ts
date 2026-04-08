/**
 * Example: start the ACP WebSocket server.
 *
 * Usage:
 *   node dist/examples/server.js
 *
 * Then run the client example in a separate terminal:
 *   node dist/examples/client.js
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketACPServer, bearerAuth } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const echoAgentPath = join(__dirname, "echo-agent.js");

const server = new WebSocketACPServer({
  port: 3000,
  command: "node",
  args: [echoAgentPath],

  // Optional: enable bearer token authentication
  // verifyClient: bearerAuth(["my-secret-token"]),

  onError: (err, ctx) => {
    console.error(`[server error / ${ctx}]`, err.message);
  },
});

await server.listening();
console.log(`ACP WebSocket server listening on ws://localhost:3000`);
console.log("Press Ctrl-C to stop.");

// Graceful shutdown
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    console.log(`\nReceived ${signal} — shutting down…`);
    await server.close();
    process.exit(0);
  });
}
