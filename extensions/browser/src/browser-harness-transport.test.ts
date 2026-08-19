import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireBrowserHarnessCloudLease,
  deactivateBrowserHarnessCloudLease,
  hasBrowserHarnessCloudLeases,
  openBrowserHarnessCloudLeaseStore,
  reconcileStaleBrowserHarnessCloudLeases,
} from "./browser-harness-cloud-leases.js";
import { assertStableHarnessWebSocketEndpoint } from "./browser-harness-endpoint.js";
import { prepareBrowserHarnessRuntime } from "./browser-harness-transport.js";

describe("Browser Harness CDP subprocess boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetPluginStateStoreForTests();
  });

  const openCloudLeaseStore = (stateDir: string) =>
    openBrowserHarnessCloudLeaseStore((options) =>
      createPluginStateKeyedStoreForTests("browser", {
        ...options,
        env: { OPENCLAW_STATE_DIR: stateDir },
      }),
    );

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
      const cloudLeaseStore = openCloudLeaseStore(path.join(root, "state"));
      const executable = path.join(root, "assert-existing-daemon.sh");
      await writeFile(
        executable,
        '#!/bin/sh\n[ "$BH_REQUIRE_EXISTING_DAEMON" = "1" ] || exit 42\n',
        { mode: 0o755 },
      );
      vi.stubEnv("BH_ORCHESTRATOR_EXISTING_DAEMON", "1");
      vi.stubEnv("BH_RUNTIME_DIR", runtimeDir);
      vi.stubEnv("BU_NAME", "eval_owned");
      try {
        const runtime = await prepareBrowserHarnessRuntime({
          browserConfig: undefined,
          cloudLeaseStore,
          target: "cloud",
          sessionId: "reuse-daemon-session",
          workspaceDir: root,
          executablePath: executable,
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

  it("fails closed before a one-shot run can self-provision a cloud browser", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-bh-one-shot-cloud-"));
    const cloudLeaseStore = openCloudLeaseStore(path.join(root, "state"));
    try {
      await expect(
        prepareBrowserHarnessRuntime({
          browserConfig: undefined,
          cloudLeaseStore,
          target: "cloud",
          sessionId: "ephemeral-one-shot",
          workspaceDir: root,
          executablePath: "/usr/bin/true",
          allowCloudProvisioning: false,
        }),
      ).rejects.toThrow("crash-recovery state is ephemeral");
      await expect(hasBrowserHarnessCloudLeases(cloudLeaseStore)).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "reconciles a prior crashed OpenClaw cloud lease before provisioning another browser",
    async () => {
      const testRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-bh-reconcile-"));
      const stateDir = path.join(testRoot, "state");
      const executable = path.join(testRoot, "fake-browser-harness.sh");
      const staleRoot = "/tmp/ocbh-4444444444444444";
      await mkdir(staleRoot, { recursive: true, mode: 0o700 });
      await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const cloudLeaseStore = openCloudLeaseStore(stateDir);
      const staleLease = await acquireBrowserHarnessCloudLease({
        store: cloudLeaseStore,
        root: staleRoot,
        name: "oc_4444444444444444",
      });
      deactivateBrowserHarnessCloudLease(staleLease);
      try {
        const runtime = await prepareBrowserHarnessRuntime({
          browserConfig: undefined,
          cloudLeaseStore,
          target: "cloud",
          sessionId: "fresh-cloud-session",
          workspaceDir: testRoot,
          executablePath: executable,
        });

        await expect(rm(staleRoot)).rejects.toMatchObject({ code: "ENOENT" });
        await runtime.cleanup();
      } finally {
        await rm(staleRoot, { recursive: true, force: true });
        await rm(testRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "makes a failed normal cloud cleanup immediately recoverable in the same process",
    async () => {
      const testRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-bh-cleanup-retry-"));
      const stateDir = path.join(testRoot, "state");
      const executable = path.join(testRoot, "fake-browser-harness.sh");
      await writeFile(
        executable,
        [
          "#!/bin/sh",
          'code="$(cat)"',
          'case "$code" in',
          "  *stop_remote_daemon*) exit 42 ;;",
          "esac",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const cloudLeaseStore = openCloudLeaseStore(stateDir);
      try {
        const runtime = await prepareBrowserHarnessRuntime({
          browserConfig: undefined,
          cloudLeaseStore,
          target: "cloud",
          sessionId: "cleanup-retry-session",
          workspaceDir: testRoot,
          executablePath: executable,
        });

        await expect(runtime.cleanup()).rejects.toThrow("Browser Harness bootstrap failed");
        const cleaned: string[] = [];
        await expect(
          reconcileStaleBrowserHarnessCloudLeases({
            store: cloudLeaseStore,
            cleanup: async (lease) => {
              cleaned.push(lease.name);
            },
          }),
        ).resolves.toBe(1);
        expect(cleaned).toEqual([runtime.name]);
      } finally {
        await rm(testRoot, { recursive: true, force: true });
      }
    },
  );
});
