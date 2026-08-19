import { describe, expect, it } from "vitest";
import { assertStableHarnessWebSocketEndpoint } from "./browser-harness-transport.js";

describe("Browser Harness CDP subprocess boundary", () => {
  it.each([
    "ws://127.0.0.1:9222/devtools/browser/id",
    "ws://[::1]:9222/devtools/browser/id",
    "wss://203.0.113.10/devtools/browser/id",
  ])("accepts a pre-resolved IP endpoint: %s", (url) => {
    expect(assertStableHarnessWebSocketEndpoint(url)).toBe(url);
  });

  it("rejects a hostname that the subprocess could re-resolve without leaking credentials", () => {
    const credentialed =
      "wss://relay-user:relay-secret@provider.example/devtools/browser/id?token=query-secret";

    expect(() => assertStableHarnessWebSocketEndpoint(credentialed)).toThrow(
      'remote CDP hostname "provider.example"',
    );
    try {
      assertStableHarnessWebSocketEndpoint(credentialed);
    } catch (error) {
      expect(String(error)).not.toMatch(/relay-secret|query-secret|relay-user/);
    }
  });
});
