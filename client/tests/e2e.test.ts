/**
 * End-to-end tests: Client library → WebSocketACPServer → echo-agent process.
 *
 * These tests exercise the full stack:
 *   createClientConnection  →  WebSocketACPServer  →  echo-agent (stdio)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocketACPServer } from "../src/server.js";
import { createClientConnection, withBearerToken } from "../src/client.js";
import { bearerAuth } from "../src/auth.js";

const ECHO_AGENT = new URL("../dist/examples/echo-agent.js", import.meta.url)
  .pathname;

// ─── No-auth E2E ──────────────────────────────────────────────────────────────

describe("E2E (no auth)", () => {
  let server: WebSocketACPServer;
  let wsUrl: string;

  beforeAll(async () => {
    server = new WebSocketACPServer({
      port: 0,
      command: "node",
      args: [ECHO_AGENT],
    });
    await server.listening();
    const { port } = server.address as AddressInfo;
    wsUrl = `ws://localhost:${port}`;
  });

  afterAll(async () => {
    await server.close().catch(() => { /* ignore */ });
  });

  it("completes initialize → session/new → prompt flow", async () => {
    const updates: string[] = [];

    const { connection, close } = await createClientConnection(wsUrl, {
      toClient: (_agent) => ({
        sessionUpdate: async (params) => {
          const { update } = params;
          if ("content" in update && update.content.type === "text") {
            updates.push(update.content.text);
          }
        },
        requestPermission: async () => ({ outcome: "allow_once" as const }),
      }),
    });

    // 1. Initialize
    const init = await connection.initialize({
      protocolVersion: 0,
      clientInfo: { name: "e2e-test", version: "0.0.1" },
      clientCapabilities: {},
    });
    expect(init.agentInfo?.name).toBe("echo-agent");

    // 2. Create session
    const session = await connection.newSession({
      cwd: "/tmp",
      mcpServers: [],
    });
    expect(typeof session.sessionId).toBe("string");
    expect(session.sessionId.length).toBeGreaterThan(0);

    // 3. Send prompt
    const result = await connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Hello, world!" }],
    });
    expect(result.stopReason).toBe("end_turn");

    // 4. The echo agent sends a session/update notification before responding
    expect(updates.some((t) => t.includes("Echo: Hello, world!"))).toBe(true);

    close();
    await new Promise<void>((r) => setTimeout(r, 200));
  });

  it("handles multiple sessions on the same server", async () => {
    // Open two independent client connections (each gets its own agent process)
    const { connection: c1, close: close1 } = await createClientConnection(wsUrl);
    const { connection: c2, close: close2 } = await createClientConnection(wsUrl);

    const [init1, init2] = await Promise.all([
      c1.initialize({ protocolVersion: 0, clientCapabilities: {} }),
      c2.initialize({ protocolVersion: 0, clientCapabilities: {} }),
    ]);

    expect(init1.agentInfo?.name).toBe("echo-agent");
    expect(init2.agentInfo?.name).toBe("echo-agent");

    const [sess1, sess2] = await Promise.all([
      c1.newSession({ cwd: "/tmp", mcpServers: [] }),
      c2.newSession({ cwd: "/tmp", mcpServers: [] }),
    ]);

    // Each connection has its own independent session
    expect(sess1.sessionId).not.toBe(sess2.sessionId);

    close1();
    close2();
    await new Promise<void>((r) => setTimeout(r, 200));
  });
});

// ─── Bearer-auth E2E ──────────────────────────────────────────────────────────

describe("E2E (bearer auth)", () => {
  const VALID_TOKEN = "e2e-test-token";
  let server: WebSocketACPServer;
  let wsUrl: string;

  beforeAll(async () => {
    server = new WebSocketACPServer({
      port: 0,
      command: "node",
      args: [ECHO_AGENT],
      verifyClient: bearerAuth([VALID_TOKEN]),
    });
    await server.listening();
    const { port } = server.address as AddressInfo;
    wsUrl = `ws://localhost:${port}`;
  });

  afterAll(async () => {
    await server.close().catch(() => { /* ignore */ });
  });

  it("connects successfully with the correct token", async () => {
    const { connection, close } = await createClientConnection(wsUrl, {
      ...withBearerToken(VALID_TOKEN),
    });

    const init = await connection.initialize({
      protocolVersion: 0,
      clientCapabilities: {},
    });
    expect(init.agentInfo?.name).toBe("echo-agent");

    close();
    await new Promise<void>((r) => setTimeout(r, 200));
  });

  it("rejects connection with a wrong token", async () => {
    await expect(
      createClientConnection(wsUrl, {
        ...withBearerToken("wrong-token"),
        connectTimeout: 3000,
      })
    ).rejects.toThrow();
  });

  it("rejects connection with no token", async () => {
    await expect(
      createClientConnection(wsUrl, { connectTimeout: 3000 })
    ).rejects.toThrow();
  });
});
