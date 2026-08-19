import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBrowserPlugin } from "./plugin-registration.js";

const runtimeMocks = vi.hoisted(() => ({
  spawnSync: vi.fn(() => ({
    status: 0,
    stdout: "browser-harness 0.1.10\n",
    stderr: "",
  })),
  handleGatewayExtensionUpgrade: vi.fn(async () => true),
  cloudLeaseStore: {},
  hasBrowserHarnessCloudLeases: vi.fn(async () => false),
  reconcileBrowserHarnessCloudLeases: vi.fn(async () => 0),
  stopBrowserControlService: vi.fn(async () => undefined),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: runtimeMocks.spawnSync };
});

vi.mock("./register.runtime.js", () => ({
  stopBrowserControlService: runtimeMocks.stopBrowserControlService,
}));

vi.mock("./src/browser/extension-relay/gateway-relay-route.js", () => ({
  handleGatewayExtensionUpgrade: runtimeMocks.handleGatewayExtensionUpgrade,
}));

vi.mock("./src/browser-harness-cloud-leases.js", () => ({
  openBrowserHarnessCloudLeaseStore: vi.fn(() => runtimeMocks.cloudLeaseStore),
  hasBrowserHarnessCloudLeases: runtimeMocks.hasBrowserHarnessCloudLeases,
}));

vi.mock("./src/browser-harness-transport.js", () => ({
  reconcileBrowserHarnessCloudLeases: runtimeMocks.reconcileBrowserHarnessCloudLeases,
}));

vi.mock("./src/browser/session-tab-store.js", () => ({
  initializeBrowserSessionTabStore: vi.fn(),
}));

vi.mock("./src/browser/system-profile-import-state.js", () => ({
  configureSystemProfileImportStateStore: vi.fn(),
}));

function registerLifecycleCallbacks() {
  let route: Parameters<OpenClawPluginApi["registerHttpRoute"]>[0] | undefined;
  let service: OpenClawPluginService | undefined;
  registerBrowserPlugin(
    createTestPluginApi({
      runtime: {
        state: { openKeyedStore: vi.fn(), openSyncKeyedStore: vi.fn() },
      } as never,
      registerHttpRoute(value) {
        route = value;
      },
      registerService(value) {
        service = value;
      },
    }),
  );
  if (!route?.handleUpgrade || !service?.start || !service.stop) {
    throw new Error("expected browser relay route and service lifecycle");
  }
  return { handleUpgrade: route.handleUpgrade, start: service.start, stop: service.stop };
}

describe("browser relay shutdown registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.hasBrowserHarnessCloudLeases.mockResolvedValue(false);
    runtimeMocks.reconcileBrowserHarnessCloudLeases.mockResolvedValue(0);
  });

  it("reaps stale Browser Harness cloud leases during Gateway startup", async () => {
    runtimeMocks.hasBrowserHarnessCloudLeases.mockResolvedValue(true);
    runtimeMocks.reconcileBrowserHarnessCloudLeases.mockResolvedValue(1);
    const { start } = registerLifecycleCallbacks();

    await start({
      config: { browser: { enabled: true, harness: { executablePath: process.execPath } } },
    } as never);

    expect(runtimeMocks.reconcileBrowserHarnessCloudLeases).toHaveBeenCalledWith({
      browserConfig: { enabled: true, harness: { executablePath: process.execPath } },
      cloudLeaseStore: runtimeMocks.cloudLeaseStore,
      executablePath: process.execPath,
    });
  });

  it("reports and retries a failed startup lease recovery", async () => {
    vi.useFakeTimers();
    runtimeMocks.hasBrowserHarnessCloudLeases.mockResolvedValue(true);
    runtimeMocks.reconcileBrowserHarnessCloudLeases
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce(1);
    const serviceHealth = { reportFailure: vi.fn(), clearFailure: vi.fn() };
    const lifecycle = registerLifecycleCallbacks();
    try {
      await lifecycle.start({
        config: { browser: { harness: { executablePath: process.execPath } } },
        serviceHealth,
      } as never);

      expect(serviceHealth.reportFailure).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runtimeMocks.reconcileBrowserHarnessCloudLeases).toHaveBeenCalledTimes(2);
      expect(serviceHealth.clearFailure).toHaveBeenCalledOnce();
    } finally {
      await lifecycle.stop({} as never);
      vi.useRealTimers();
    }
  });

  it("keeps shutdown lazy until direct relay activity prepares teardown", async () => {
    const coldLifecycle = registerLifecycleCallbacks();

    await coldLifecycle.stop({} as never);

    expect(runtimeMocks.stopBrowserControlService).not.toHaveBeenCalled();

    const { handleUpgrade, stop } = registerLifecycleCallbacks();
    const req = {} as IncomingMessage;
    const socket = {} as Duplex;
    const head = Buffer.alloc(0);

    await expect(handleUpgrade(req, socket, head)).resolves.toBe(true);
    await stop({} as never);

    expect(runtimeMocks.handleGatewayExtensionUpgrade).toHaveBeenCalledWith(req, socket, head);
    expect(runtimeMocks.stopBrowserControlService).toHaveBeenCalledOnce();
  });
});
