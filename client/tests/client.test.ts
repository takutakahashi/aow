import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import type { AddressInfo } from "node:net";
import {
  createClientConnection,
  withBearerToken,
  withBasicAuth,
  withApiKey,
} from "../src/client.js";

/** Creates a minimal echo WebSocket server for testing. */
async function createEchoServer(): Promise<{
  wss: WebSocketServer;
  port: number;
  connections: WebSocket[];
}> {
  const connections: WebSocket[] = [];
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws) => {
    connections.push(ws);
    // Echo all messages back (simulates an ACP agent stream)
    ws.on("message", (data) => ws.send(data));
  });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const port = (wss.address() as AddressInfo).port;
  return { wss, port, connections };
}

async function closeServer(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    wss.clients.forEach((ws) => ws.terminate());
    wss.close(() => resolve());
    setTimeout(resolve, 500);
  });
}

describe("createClientConnection", () => {
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    ({ wss, port } = await createEchoServer());
  });

  afterEach(async () => {
    await closeServer(wss);
  });

  it("opens a WebSocket and returns a ClientConnection", async () => {
    const { connection, stream, close } = await createClientConnection(
      `ws://localhost:${port}`
    );

    expect(connection).toBeDefined();
    expect(stream).toBeDefined();
    expect(typeof close).toBe("function");

    close();
  });

  it("resolves the connection once the WebSocket is open", async () => {
    const { close } = await createClientConnection(`ws://localhost:${port}`);
    // If we got here without an error, the connection is open
    expect(true).toBe(true);
    close();
  });

  it("rejects if the server is not reachable", async () => {
    await expect(
      createClientConnection("ws://localhost:1", { connectTimeout: 500 })
    ).rejects.toThrow();
  });

  it("rejects if the connection times out", async () => {
    // Point to a host that never responds to simulate a timeout
    // Use an unrouteable address (TEST-NET-1) to force a timeout
    await expect(
      createClientConnection("ws://192.0.2.1:9999", { connectTimeout: 200 })
    ).rejects.toThrow(/timed out/i);
  });

  it("calls close() to shut down the connection", async () => {
    const { close } = await createClientConnection(`ws://localhost:${port}`);

    // Should not throw
    expect(() => close()).not.toThrow();
  });
});

// ─── Auth helpers ─────────────────────────────────────────────────────────────

describe("withBearerToken", () => {
  it("returns wsOptions with Authorization: Bearer header", () => {
    const opts = withBearerToken("my-token");
    expect(opts.wsOptions?.headers).toMatchObject({
      Authorization: "Bearer my-token",
    });
  });
});

describe("withBasicAuth", () => {
  it("returns wsOptions with Authorization: Basic header", () => {
    const opts = withBasicAuth("user", "pass");
    const expected = Buffer.from("user:pass").toString("base64");
    expect(opts.wsOptions?.headers).toMatchObject({
      Authorization: `Basic ${expected}`,
    });
  });

  it("correctly encodes credentials with special characters", () => {
    const opts = withBasicAuth("user@example.com", "p@$$word:123");
    const expected = Buffer.from("user@example.com:p@$$word:123").toString(
      "base64"
    );
    expect(opts.wsOptions?.headers).toMatchObject({
      Authorization: `Basic ${expected}`,
    });
  });
});

describe("withApiKey", () => {
  it("returns wsOptions with the given header", () => {
    const opts = withApiKey("x-api-key", "abc123");
    expect(opts.wsOptions?.headers).toMatchObject({
      "x-api-key": "abc123",
    });
  });

  it("preserves the header name casing provided by the caller", () => {
    const opts = withApiKey("X-Custom-Auth", "token");
    expect(opts.wsOptions?.headers).toMatchObject({
      "X-Custom-Auth": "token",
    });
  });
});

// ─── auth headers reach the server ───────────────────────────────────────────

describe("auth headers in upgrade request", () => {
  it("sends the Authorization header during the WebSocket upgrade", async () => {
    const receivedHeaders: Record<string, string>[] = [];
    const wssAuth = new WebSocketServer({ port: 0 });
    wssAuth.on("connection", (_ws, req) => {
      receivedHeaders.push(req.headers as Record<string, string>);
    });
    await new Promise<void>((resolve) => wssAuth.once("listening", resolve));
    const authPort = (wssAuth.address() as AddressInfo).port;

    try {
      const { close } = await createClientConnection(
        `ws://localhost:${authPort}`,
        withBearerToken("test-bearer-token")
      );

      // Give the server a moment to record the headers
      await new Promise<void>((r) => setTimeout(r, 50));

      expect(receivedHeaders[0]?.["authorization"]).toBe(
        "Bearer test-bearer-token"
      );
      close();
    } finally {
      await closeServer(wssAuth);
    }
  });
});
