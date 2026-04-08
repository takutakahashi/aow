import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  bearerAuth,
  basicAuth,
  apiKeyAuth,
  anyAuth,
} from "../src/auth.js";
import type { VerifyClientInfo } from "../src/auth.js";

/** Creates a minimal mock VerifyClientInfo with the given headers. */
function mockInfo(headers: Record<string, string>): VerifyClientInfo {
  // IncomingMessage headers are lowercase by the Node.js HTTP parser
  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    lowerHeaders[k.toLowerCase()] = v;
  }
  return {
    req: { headers: lowerHeaders } as unknown as IncomingMessage,
    origin: "",
    secure: false,
  };
}

// ─── bearerAuth ───────────────────────────────────────────────────────────────

describe("bearerAuth", () => {
  const verify = bearerAuth(["token-alice", "token-bob"]);

  it("accepts a valid bearer token", () => {
    expect(verify(mockInfo({ authorization: "Bearer token-alice" }))).toBe(
      true
    );
    expect(verify(mockInfo({ authorization: "Bearer token-bob" }))).toBe(true);
  });

  it("rejects an unknown token", () => {
    expect(verify(mockInfo({ authorization: "Bearer unknown" }))).toBe(false);
  });

  it("is case-sensitive for the token value", () => {
    expect(verify(mockInfo({ authorization: "Bearer TOKEN-ALICE" }))).toBe(
      false
    );
  });

  it("is case-insensitive for the 'Bearer' scheme keyword", () => {
    expect(verify(mockInfo({ authorization: "bearer token-alice" }))).toBe(
      true
    );
    expect(verify(mockInfo({ authorization: "BEARER token-alice" }))).toBe(
      true
    );
  });

  it("rejects a non-bearer scheme", () => {
    expect(verify(mockInfo({ authorization: "Basic dG9rZW4tYWxpY2U=" }))).toBe(
      false
    );
  });

  it("rejects a missing Authorization header", () => {
    expect(verify(mockInfo({}))).toBe(false);
  });

  it("rejects a malformed Authorization header with no space", () => {
    expect(verify(mockInfo({ authorization: "BearerNoSpace" }))).toBe(false);
  });
});

// ─── basicAuth ────────────────────────────────────────────────────────────────

describe("basicAuth", () => {
  const verify = basicAuth({ alice: "pass1", bob: "pass2" });

  it("accepts valid credentials", () => {
    const encoded = Buffer.from("alice:pass1").toString("base64");
    expect(verify(mockInfo({ authorization: `Basic ${encoded}` }))).toBe(true);
  });

  it("rejects wrong password", () => {
    const encoded = Buffer.from("alice:wrong").toString("base64");
    expect(verify(mockInfo({ authorization: `Basic ${encoded}` }))).toBe(false);
  });

  it("rejects unknown user", () => {
    const encoded = Buffer.from("charlie:pass1").toString("base64");
    expect(verify(mockInfo({ authorization: `Basic ${encoded}` }))).toBe(false);
  });

  it("is case-insensitive for the 'Basic' scheme keyword", () => {
    const encoded = Buffer.from("alice:pass1").toString("base64");
    expect(verify(mockInfo({ authorization: `basic ${encoded}` }))).toBe(true);
  });

  it("handles passwords containing colons correctly", () => {
    const verifyColonPass = basicAuth({ user: "pass:with:colons" });
    const encoded = Buffer.from("user:pass:with:colons").toString("base64");
    expect(
      verifyColonPass(mockInfo({ authorization: `Basic ${encoded}` }))
    ).toBe(true);
  });

  it("rejects missing Authorization header", () => {
    expect(verify(mockInfo({}))).toBe(false);
  });

  it("rejects a non-basic scheme", () => {
    expect(verify(mockInfo({ authorization: "Bearer alice:pass1" }))).toBe(
      false
    );
  });
});

// ─── apiKeyAuth ───────────────────────────────────────────────────────────────

describe("apiKeyAuth", () => {
  const verify = apiKeyAuth("x-api-key", ["key1", "key2"]);

  it("accepts a valid API key", () => {
    expect(verify(mockInfo({ "x-api-key": "key1" }))).toBe(true);
    expect(verify(mockInfo({ "x-api-key": "key2" }))).toBe(true);
  });

  it("rejects an unknown key", () => {
    expect(verify(mockInfo({ "x-api-key": "key3" }))).toBe(false);
  });

  it("is case-insensitive for the header name", () => {
    // Node.js lowercases header names, but the factory itself normalises too
    const verifyUpper = apiKeyAuth("X-API-Key", ["key1"]);
    expect(verifyUpper(mockInfo({ "x-api-key": "key1" }))).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(verify(mockInfo({}))).toBe(false);
  });

  it("rejects an empty key", () => {
    expect(verify(mockInfo({ "x-api-key": "" }))).toBe(false);
  });
});

// ─── anyAuth ──────────────────────────────────────────────────────────────────

describe("anyAuth", () => {
  const bearer = bearerAuth(["bearer-tok"]);
  const apiKey = apiKeyAuth("x-api-key", ["api-key-tok"]);
  const combined = anyAuth(bearer, apiKey);

  it("accepts if the first verifier passes", async () => {
    expect(
      await combined(mockInfo({ authorization: "Bearer bearer-tok" }))
    ).toBe(true);
  });

  it("accepts if the second verifier passes", async () => {
    expect(await combined(mockInfo({ "x-api-key": "api-key-tok" }))).toBe(
      true
    );
  });

  it("rejects if no verifier passes", async () => {
    expect(await combined(mockInfo({}))).toBe(false);
  });

  it("accepts with an async verifier", async () => {
    const asyncVerifier = anyAuth(async (_info) => true);
    expect(await asyncVerifier(mockInfo({}))).toBe(true);
  });
});
