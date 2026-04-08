import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import { WebSocketACPServer } from "../src/server.js";
import { bearerAuth } from "../src/auth.js";
import type { AnyMessage } from "@agentclientprotocol/sdk";

/** Absolute path to the compiled echo-agent. Built by tsc before tests run. */
const ECHO_AGENT = new URL("../dist/examples/echo-agent.js", import.meta.url)
  .pathname;

// ─── helpers ─────────────────────────────────────────────────────────────────

function openWs(port: number, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`, { headers });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/**
 * Collects all messages from a WebSocket into a queue.
 * Returns a function that pops the next message (waiting if necessary).
 */
function messageQueue(ws: WebSocket): () => Promise<AnyMessage> {
  const queue: AnyMessage[] = [];
  const waiters: Array<(msg: AnyMessage) => void> = [];
  const errorWaiters: Array<(err: Error) => void> = [];

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as AnyMessage;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      queue.push(msg);
    }
  });

  ws.on("error", (err) => {
    for (const ew of errorWaiters.splice(0)) ew(err);
  });

  ws.on("close", () => {
    const err = new Error("WebSocket closed");
    for (const ew of errorWaiters.splice(0)) ew(err);
    for (const w of waiters.splice(0)) w({ jsonrpc: "2.0", method: "_closed" });
  });

  return () =>
    new Promise<AnyMessage>((resolve, reject) => {
      const queued = queue.shift();
      if (queued != null) {
        resolve(queued);
      } else {
        waiters.push(resolve);
        errorWaiters.push(reject);
      }
    });
}

async function sendAndReceive(
  nextMsg: () => Promise<AnyMessage>,
  ws: WebSocket,
  msg: AnyMessage
): Promise<AnyMessage> {
  const p = nextMsg();
  ws.send(JSON.stringify(msg));
  return p;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("WebSocketACPServer (no auth)", () => {
  let server: WebSocketACPServer;
  let port: number;

  beforeAll(async () => {
    server = new WebSocketACPServer({
      port: 0,
      command: "node",
      args: [ECHO_AGENT],
    });
    await server.listening();
    port = (server.address as AddressInfo).port;
  });

  afterAll(async () => {
    await server.close().catch(() => { /* ignore cleanup errors */ });
  });

  it("accepts a connection and reflects an initialize request", async () => {
    const ws = await openWs(port);
    const nextMsg = messageQueue(ws);

    const req: AnyMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 0,
        clientInfo: { name: "test-client", version: "0.0.1" },
        clientCapabilities: {},
      },
    };

    const response = await sendAndReceive(nextMsg, ws, req);

    expect((response as { id: unknown }).id).toBe(1);
    expect(
      (response as { result?: { agentInfo?: { name?: string } } }).result
        ?.agentInfo?.name
    ).toBe("echo-agent");

    ws.close();
    await new Promise<void>((r) => setTimeout(r, 200));
  });

  it("handles multiple sequential requests", async () => {
    const ws = await openWs(port);
    const nextMsg = messageQueue(ws);

    const initReq: AnyMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 0,
        clientInfo: { name: "test-client", version: "0.0.1" },
        clientCapabilities: {},
      },
    };
    await sendAndReceive(nextMsg, ws, initReq);

    const sessionReq: AnyMessage = {
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: {
        cwd: "/tmp",
        mcpServers: [],
      },
    };
    const sessionResp = await sendAndReceive(nextMsg, ws, sessionReq);
    const sessionId = (sessionResp as { result?: { sessionId?: string } })
      .result?.sessionId;
    expect(typeof sessionId).toBe("string");
    expect(sessionId!.length).toBeGreaterThan(0);

    ws.close();
    await new Promise<void>((r) => setTimeout(r, 200));
  });

  it("closes the WebSocket when the agent process exits", async () => {
    const ws = await openWs(port);
    const nextMsg = messageQueue(ws);

    const initReq: AnyMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 0, clientCapabilities: {} },
    };
    await sendAndReceive(nextMsg, ws, initReq);

    const closePromise = new Promise<number>((resolve) =>
      ws.once("close", (code) => resolve(code))
    );
    ws.close(1000);
    const code = await closePromise;
    expect(code).toBe(1000);
  });
});

describe("WebSocketACPServer (bearer auth)", () => {
  let server: WebSocketACPServer;
  let port: number;

  beforeAll(async () => {
    server = new WebSocketACPServer({
      port: 0,
      command: "node",
      args: [ECHO_AGENT],
      verifyClient: bearerAuth(["valid-token"]),
    });
    await server.listening();
    port = (server.address as AddressInfo).port;
  });

  afterAll(async () => {
    await server.close().catch(() => { /* ignore cleanup errors */ });
  });

  it("accepts a connection with a valid bearer token", async () => {
    const ws = await openWs(port, { Authorization: "Bearer valid-token" });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await new Promise<void>((r) => setTimeout(r, 300));
  });

  it("rejects a connection with an invalid token (HTTP 401)", async () => {
    await expect(
      openWs(port, { Authorization: "Bearer wrong-token" })
    ).rejects.toThrow();
  });

  it("rejects a connection with no Authorization header", async () => {
    await expect(openWs(port)).rejects.toThrow();
  });
});
