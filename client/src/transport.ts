/**
 * WebSocket transport for ACP (Agent Client Protocol).
 *
 * Converts a `ws` WebSocket into the SDK's {@link Stream} interface,
 * enabling ACP connections over WebSocket instead of stdio.
 *
 * Each WebSocket text frame carries exactly one JSON-encoded AnyMessage.
 * Binary frames are silently ignored (ACP only uses text frames).
 */

import type WebSocket from "ws";
import type { AnyMessage } from "@agentclientprotocol/sdk";
import type { Stream } from "@agentclientprotocol/sdk";

/**
 * Safely converts ws `RawData` (Buffer | ArrayBuffer | Buffer[]) to a UTF-8 string.
 * Handles all three variants that `ws` may produce for text frames.
 */
function rawDataToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) {
    // Buffer[] — concatenate all chunks first
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  // Buffer (most common case for text frames)
  return data.toString("utf8");
}

/**
 * Creates an ACP {@link Stream} from an open (or opening) `ws` WebSocket.
 *
 * Stream lifetime is tied to the WebSocket:
 * - WS `close` / `error` → readable stream closes / errors
 * - WritableStream `close()` → `ws.close(1000, ...)`
 * - WritableStream `abort()` → `ws.terminate()` (hard close)
 *
 * @param ws - An open or opening `ws` WebSocket instance
 * @returns Bidirectional ACP message stream
 */
export function wsStream(ws: WebSocket): Stream {
  // ─── Readable side ───────────────────────────────────────────────────
  // Buffers incoming frames until the consumer pulls them.
  // ReadableStream's built-in queue provides natural backpressure.

  let readableController!: ReadableStreamDefaultController<AnyMessage>;

  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      readableController = controller;

      ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
        // ACP uses only text frames; drop binary frames silently
        if (isBinary) return;

        const text = rawDataToString(data);
        let message: AnyMessage;
        try {
          message = JSON.parse(text) as AnyMessage;
        } catch {
          // Malformed JSON frame — close the readable with an error
          // so the connection layer can surface it to the caller.
          try {
            controller.error(
              new SyntaxError(
                `Invalid JSON in WebSocket frame: ${text.slice(0, 200)}`
              )
            );
          } catch {
            /* controller already closed/errored */
          }
          ws.close(1003, "Invalid JSON");
          return;
        }
        try {
          controller.enqueue(message);
        } catch {
          /* controller already closed */
        }
      });

      ws.on("close", () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });

      ws.on("error", (err: Error) => {
        try {
          controller.error(err);
        } catch {
          /* already errored */
        }
      });
    },

    cancel() {
      // Consumer cancelled the readable — close the WebSocket cleanly
      ws.close(1000, "Stream cancelled");
    },
  });

  // ─── Writable side ───────────────────────────────────────────────────
  // Serialises each AnyMessage to a JSON text frame and calls ws.send().
  // The Promise-based send callback provides backpressure to the
  // WritableStream's internal queue.

  const writable = new WritableStream<AnyMessage>({
    write(message: AnyMessage): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const payload = JSON.stringify(message);
        ws.send(payload, (err?: Error) => {
          if (err != null) reject(err);
          else resolve();
        });
      });
    },

    close() {
      ws.close(1000, "Stream closed");
    },

    abort(_reason?: unknown) {
      // Hard close — destroy the TCP socket immediately without a close frame
      ws.terminate();
    },
  });

  return { readable, writable };
}
