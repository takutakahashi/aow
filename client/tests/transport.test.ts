import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { wsStream } from "../src/transport.js";
import type { AnyMessage } from "@agentclientprotocol/sdk";

/** Opens a local WebSocket server and a connected client, returns both sockets. */
async function createPair(): Promise<{
  wss: WebSocketServer;
  serverWs: WebSocket;
  clientWs: WebSocket;
}> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const { port } = wss.address() as AddressInfo;

  const [serverWs, clientWs] = await new Promise<[WebSocket, WebSocket]>(
    (resolve) => {
      const client = new WebSocket(`ws://localhost:${port}`);
      wss.once("connection", (server) => {
        // Ensure the client open event has also fired
        if (client.readyState === WebSocket.OPEN) {
          resolve([server, client]);
        } else {
          client.once("open", () => resolve([server, client]));
        }
      });
    }
  );

  return { wss, serverWs, clientWs };
}

describe("wsStream", () => {
  let wss: WebSocketServer;
  let serverWs: WebSocket;
  let clientWs: WebSocket;

  beforeEach(async () => {
    ({ wss, serverWs, clientWs } = await createPair());
  });

  afterEach(async () => {
    // Terminate connections first so wss.close() callback fires promptly
    serverWs.terminate();
    clientWs.terminate();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
      // Safety timeout in case close callback stalls
      setTimeout(resolve, 500);
    });
  });

  // ── readable ──────────────────────────────────────────────────────────

  it("enqueues a parsed AnyMessage when a text frame arrives", async () => {
    const stream = wsStream(serverWs);
    const reader = stream.readable.getReader();

    const msg: AnyMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: {},
    };
    clientWs.send(JSON.stringify(msg));

    const { done, value } = await reader.read();
    expect(done).toBe(false);
    expect(value).toEqual(msg);
    reader.releaseLock();
  });

  it("ignores binary frames silently", async () => {
    const stream = wsStream(serverWs);
    const reader = stream.readable.getReader();

    // Send a binary frame, then a text frame — only the text one should arrive
    clientWs.send(Buffer.from([0x01, 0x02, 0x03])); // binary
    const textMsg: AnyMessage = { jsonrpc: "2.0", method: "notify" };
    clientWs.send(JSON.stringify(textMsg));

    const { done, value } = await reader.read();
    expect(done).toBe(false);
    expect(value).toEqual(textMsg);
    reader.releaseLock();
  });

  it("errors the readable when a malformed JSON frame arrives", async () => {
    const stream = wsStream(serverWs);
    const reader = stream.readable.getReader();

    clientWs.send("not-valid-json{{{");

    await expect(reader.read()).rejects.toThrow(SyntaxError);
    reader.releaseLock();
  });

  it("closes the readable when the remote WebSocket closes", async () => {
    const stream = wsStream(serverWs);
    const reader = stream.readable.getReader();

    clientWs.close(1000);

    const { done } = await reader.read();
    expect(done).toBe(true);
    reader.releaseLock();
  });

  // ── writable ──────────────────────────────────────────────────────────

  it("sends a JSON text frame when writing to the writable", async () => {
    const stream = wsStream(clientWs);
    const writer = stream.writable.getWriter();

    const received: string[] = [];
    serverWs.on("message", (data) => received.push(data.toString("utf8")));

    const msg: AnyMessage = { jsonrpc: "2.0", method: "notify" };
    await writer.write(msg);

    // Wait for the frame to arrive
    await new Promise<void>((resolve) => {
      const check = () =>
        received.length > 0 ? resolve() : setTimeout(check, 10);
      check();
    });

    expect(JSON.parse(received[0]!)).toEqual(msg);
    writer.releaseLock();
  });

  it("serialises multiple writes in order", async () => {
    const stream = wsStream(clientWs);
    const writer = stream.writable.getWriter();

    const received: AnyMessage[] = [];
    serverWs.on("message", (data) =>
      received.push(JSON.parse(data.toString("utf8")) as AnyMessage)
    );

    const msgs: AnyMessage[] = [
      { jsonrpc: "2.0", id: 1, method: "first", params: {} },
      { jsonrpc: "2.0", id: 2, method: "second", params: {} },
      { jsonrpc: "2.0", id: 3, method: "third", params: {} },
    ];
    for (const m of msgs) await writer.write(m);

    await new Promise<void>((resolve) => {
      const check = () =>
        received.length >= msgs.length ? resolve() : setTimeout(check, 10);
      check();
    });

    expect(received).toEqual(msgs);
    writer.releaseLock();
  });

  // ── round-trip ────────────────────────────────────────────────────────

  it("supports a full round-trip through two wsStream instances", async () => {
    const serverStream = wsStream(serverWs);
    const clientStream = wsStream(clientWs);

    const writer = clientStream.writable.getWriter();
    const reader = serverStream.readable.getReader();

    const request: AnyMessage = {
      jsonrpc: "2.0",
      id: 42,
      method: "session/prompt",
      params: { sessionId: "s1", text: "hello" },
    };
    await writer.write(request);

    const { value } = await reader.read();
    expect(value).toEqual(request);

    writer.releaseLock();
    reader.releaseLock();
  });
});
