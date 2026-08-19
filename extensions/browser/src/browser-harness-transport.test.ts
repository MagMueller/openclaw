import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertStableHarnessWebSocketEndpoint,
  prepareBrowserHarnessRuntime,
} from "./browser-harness-transport.js";

describe("Browser Harness CDP subprocess boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

  it.runIf(process.platform !== "win32")(
    "reuses an evaluation-owned daemon and requires every model call to keep using it",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-bh-reuse-"));
      const runtimeDir = path.join(root, "runtime");
      vi.stubEnv("BH_ORCHESTRATOR_EXISTING_DAEMON", "1");
      vi.stubEnv("BH_RUNTIME_DIR", runtimeDir);
      vi.stubEnv("BU_NAME", "eval_owned");
      try {
        const runtime = await prepareBrowserHarnessRuntime({
          browserConfig: undefined,
          target: "cloud",
          sessionId: "reuse-daemon-session",
          workspaceDir: root,
          executablePath: "/usr/bin/true",
        });

        expect(runtime.name).toBe("eval_owned");
        expect(runtime.env.BH_RUNTIME_DIR).toBe(runtimeDir);
        expect(runtime.env.BH_REQUIRE_EXISTING_DAEMON).toBe("1");
        expect(runtime.env.BU_CDP_WS).toBeUndefined();
        await runtime.cleanup();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
