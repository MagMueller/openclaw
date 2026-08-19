import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireBrowserHarnessCloudLease,
  deactivateBrowserHarnessCloudLease,
  hasBrowserHarnessCloudLeases,
  openBrowserHarnessCloudLeaseStore,
  reconcileStaleBrowserHarnessCloudLeases,
  releaseBrowserHarnessCloudLease,
  type BrowserHarnessCloudLeaseHandle,
  type BrowserHarnessCloudLeaseStore,
} from "./browser-harness-cloud-leases.js";

const BROWSER_HARNESS_CLOUD_LEASE_NAMESPACE = "browser.harness-cloud-leases";
type StoredBrowserHarnessCloudLease = {
  version: 1;
  leaseId: string;
  ownerPid: number;
  ownerInstanceId: string;
  ownerStartToken?: string | null;
  root: string;
  name: string;
  createdAt: string;
};

describe("Browser Harness durable cloud leases", () => {
  const roots: string[] = [];

  afterEach(async () => {
    resetPluginStateStoreForTests();
    await Promise.all(
      roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
    );
  });

  function openStore(stateDir: string): BrowserHarnessCloudLeaseStore {
    return openBrowserHarnessCloudLeaseStore((options) =>
      createPluginStateKeyedStoreForTests("browser", {
        ...options,
        env: { OPENCLAW_STATE_DIR: stateDir },
      }),
    );
  }

  async function setupLease(id: string) {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-bh-lease-state-"));
    roots.push(stateDir);
    const store = openStore(stateDir);
    const root = path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", `ocbh-${id}`);
    roots.push(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const handle = await acquireBrowserHarnessCloudLease({
      store,
      root,
      name: `oc_${id}`,
    });
    return { handle, root, stateDir, store };
  }

  async function mutateLease(
    store: BrowserHarnessCloudLeaseStore,
    handle: BrowserHarnessCloudLeaseHandle,
    mutate: (lease: StoredBrowserHarnessCloudLease) => StoredBrowserHarnessCloudLease,
  ): Promise<void> {
    const current = await store.lookup(handle.key);
    if (!current || typeof current !== "object") {
      throw new Error("expected Browser Harness cloud lease");
    }
    await store.register(handle.key, mutate(current as StoredBrowserHarnessCloudLease));
  }

  it("persists a non-expiring canonical SQLite plugin-state row", async () => {
    const { handle, stateDir, store } = await setupLease("1212121212121212");

    await expect(hasBrowserHarnessCloudLeases(store)).resolves.toBe(true);
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    const row = database.db
      .prepare(
        `SELECT plugin_id, namespace, entry_key, expires_at
         FROM plugin_state_entries
         WHERE plugin_id = ? AND namespace = ?`,
      )
      .get("browser", BROWSER_HARNESS_CLOUD_LEASE_NAMESPACE);
    expect(row).toEqual({
      plugin_id: "browser",
      namespace: BROWSER_HARNESS_CLOUD_LEASE_NAMESPACE,
      entry_key: handle.key,
      expires_at: null,
    });
    await expect(
      stat(path.join(stateDir, "browser", "harness-cloud-leases")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await releaseBrowserHarnessCloudLease(store, handle);
    await expect(hasBrowserHarnessCloudLeases(store)).resolves.toBe(false);
  });

  it("skips a lease that is still active in this process", async () => {
    const { handle, store } = await setupLease("1111111111111111");

    await expect(
      reconcileStaleBrowserHarnessCloudLeases({
        store,
        cleanup: async () => {
          throw new Error("active lease must not be stopped");
        },
      }),
    ).resolves.toBe(0);

    await releaseBrowserHarnessCloudLease(store, handle);
  });

  it("recovers an abandoned lease after reopening the canonical store", async () => {
    const { handle, root, stateDir } = await setupLease("2222222222222222");
    deactivateBrowserHarnessCloudLease(handle);
    closeOpenClawStateDatabaseForTest();
    const reopened = openStore(stateDir);
    const cleaned: string[] = [];

    await expect(
      reconcileStaleBrowserHarnessCloudLeases({
        store: reopened,
        cleanup: async (lease) => {
          cleaned.push(lease.name);
        },
      }),
    ).resolves.toBe(1);

    expect(cleaned).toEqual(["oc_2222222222222222"]);
    await expect(rm(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains an abandoned lease and runtime when provider cleanup fails", async () => {
    const { handle, root, store } = await setupLease("3333333333333333");
    deactivateBrowserHarnessCloudLease(handle);

    await expect(
      reconcileStaleBrowserHarnessCloudLeases({
        store,
        cleanup: async () => {
          throw new Error("provider unavailable");
        },
      }),
    ).rejects.toThrow("provider unavailable");

    await expect(stat(root)).resolves.toMatchObject({});
    await expect(store.lookup(handle.key)).resolves.toMatchObject({ leaseId: handle.leaseId });
    await releaseBrowserHarnessCloudLease(store, handle);
  });

  it("fails closed instead of overwriting an existing runtime-root lease", async () => {
    const { handle, root, store } = await setupLease("4444444444444444");

    await expect(
      acquireBrowserHarnessCloudLease({
        store,
        root,
        name: "oc_4444444444444444",
      }),
    ).rejects.toThrow("already exists");

    await releaseBrowserHarnessCloudLease(store, handle);
  });

  it("does not conditionally release a replacement generation", async () => {
    const { handle, store } = await setupLease("4545454545454545");
    await mutateLease(store, handle, (lease) => ({ ...lease, leaseId: "replacement-generation" }));

    await expect(releaseBrowserHarnessCloudLease(store, handle)).rejects.toThrow(
      "generation changed",
    );
    await expect(store.lookup(handle.key)).resolves.toMatchObject({
      leaseId: "replacement-generation",
    });
  });

  it("reclaims a lease when a live PID has a different process-start identity", async () => {
    const { handle, store } = await setupLease("5555555555555555");
    await mutateLease(store, handle, (lease) => ({
      ...lease,
      ownerPid: 4242,
      ownerStartToken: "linux:old",
    }));
    deactivateBrowserHarnessCloudLease(handle);

    await expect(
      reconcileStaleBrowserHarnessCloudLeases({
        store,
        cleanup: async () => undefined,
        liveness: {
          processExists: () => true,
          readProcessStartToken: () => "linux:new",
        },
      }),
    ).resolves.toBe(1);
  });

  it("keeps a live-PID lease when its process-start identity is temporarily unreadable", async () => {
    const { handle, store } = await setupLease("5656565656565656");
    await mutateLease(store, handle, (lease) => ({
      ...lease,
      ownerPid: 4242,
      ownerStartToken: "linux:known",
    }));
    deactivateBrowserHarnessCloudLease(handle);

    await expect(
      reconcileStaleBrowserHarnessCloudLeases({
        store,
        cleanup: async () => {
          throw new Error("unreadable identity is not proof that the owner died");
        },
        liveness: {
          processExists: () => true,
          readProcessStartToken: () => null,
        },
      }),
    ).resolves.toBe(0);

    await releaseBrowserHarnessCloudLease(store, handle);
  });

  it("expires existence-only leases instead of trusting a recycled PID forever", async () => {
    const { handle, store } = await setupLease("6666666666666666");
    let createdAtMs = 0;
    await mutateLease(store, handle, (lease) => {
      createdAtMs = Date.parse(lease.createdAt);
      const { ownerStartToken: _ownerStartToken, ...legacy } = lease;
      return legacy;
    });
    deactivateBrowserHarnessCloudLease(handle);

    await expect(
      reconcileStaleBrowserHarnessCloudLeases({
        store,
        cleanup: async () => undefined,
        liveness: {
          nowMs: createdAtMs + 25 * 60 * 60 * 1000,
          processExists: () => true,
        },
      }),
    ).resolves.toBe(1);
  });
});
