/**
 * Minimal ACP echo agent for testing and examples.
 *
 * Communicates over stdio using the ndJsonStream transport (newline-delimited JSON).
 * Responds to `session/prompt` requests by echoing the last text block back to the
 * client prefixed with "Echo: ".
 *
 * Usage (as a standalone process):
 *   node dist/examples/echo-agent.js
 *
 * The WebSocketACPServer example starts this as a subprocess for each connection.
 */

import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import type { Agent } from "@agentclientprotocol/sdk";
import type {
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
} from "@agentclientprotocol/sdk";

// ─── stdio stream setup ───────────────────────────────────────────────────────

// Use the static Readable.toWeb / Writable.toWeb methods (Node.js 17+)
const stdinReadable = Readable.toWeb(
  process.stdin
) as ReadableStream<Uint8Array>;
const stdoutWritable = Writable.toWeb(
  process.stdout
) as WritableStream<Uint8Array>;
const stream = ndJsonStream(stdoutWritable, stdinReadable);

// ─── Agent implementation ─────────────────────────────────────────────────────

const _connection = new AgentSideConnection(
  (conn: AgentSideConnection): Agent => ({
    initialize(params: InitializeRequest): Promise<InitializeResponse> {
      return Promise.resolve({
        protocolVersion: params.protocolVersion,
        agentInfo: {
          name: "echo-agent",
          version: "0.1.0",
        },
        agentCapabilities: {},
      });
    },

    newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
      return Promise.resolve({
        sessionId: crypto.randomUUID(),
      });
    },

    authenticate(
      _params: AuthenticateRequest
    ): Promise<AuthenticateResponse | void> {
      // No authentication required by this agent
      return Promise.resolve();
    },

    cancel(_params: CancelNotification): Promise<void> {
      // No ongoing work to cancel in this simple echo agent
      return Promise.resolve();
    },

    async prompt(params: PromptRequest): Promise<PromptResponse> {
      // Find the last text block in the prompt and echo it
      const textBlock = [...params.prompt]
        .reverse()
        .find(
          (block): block is Extract<(typeof params.prompt)[number], { type: "text" }> =>
            block.type === "text"
        );

      const inputText = textBlock?.text ?? "(no text)";

      // Send a session update notification with the echoed text
      await conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `Echo: ${inputText}`,
          },
        },
      });

      return { stopReason: "end_turn" };
    },
  }),
  stream
);

// Keep the process alive until the connection stream closes
// (AgentSideConnection manages the stream lifecycle internally)
