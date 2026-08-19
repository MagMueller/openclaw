import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireBrowserHarnessCloudLease,
  deactivateBrowserHarnessCloudLease,
  hasBrowserHarnessCloudLeases,
  reconcileStaleBrowserHarnessCloudLeases,
  releaseBrowserHarnessCloudLease,
} from "./browser-harness-cloud-leases.js";

const fileSystemMocks = vi.hoisted(() => ({
  afterRename: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      await fileSystemMocks.afterRename?.();
    },
  };
});

describe("Browser Harness durable cloud leases", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    fileSystemMocks.afterRename = undefined;
    await Promise.all(
      roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
    );
  });

  async function setupLease(id: string) {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-bh-lease-state-"));
    roots.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const root = path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", `ocbh-${id}`);
    roots.push(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const leasePath = await acquireBrowserHarnessCloudLease({ root, name: `oc_${id}` });
    return { leasePath, root };
  }

  it("skips a lease that is still active in this process", async () => {
    const { leasePath } = await setupLease("1111111111111111");

    await expect(
      reconcileStaleBrowserHarnessCloudLeases({
        cleanup: async () => {
          throw new Error("active lease must not be stopped");
        },
      }),
    ).resolves.toBe(0);

    await releaseBrowserHarnessCloudLease(leasePath);
  });

  it("detects a durable lease without provisioning a browser", async () => {
    const { leasePath } = await setupLease("1212121212121212");

    await expect(hasBrowserHarnessCloudLeases()).resolves.toBe(true);

    await releaseBrowserHarnessCloudLease(leasePath);
    await expect(hasBrowserHarnessCloudLeases()).resolves.toBe(false);
  });

  it("marks a lease active before its durable rename becomes observable", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-bh-lease-state-"));
    roots.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const root = path.join(
      process.platform === "win32" ? os.tmpdir() : "/tmp",
      "ocbh-1313131313131313",
    );
    roots.push(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    let signalPublished: (() => void) | undefined;
    const published = new Promise<void>((resolve) => {
      signalPublished = resolve;
    });
    let allowRenameToReturn: (() => void) | undefined;
    const renameGate = new Promise<void>((resolve) => {
      allowRenameToReturn = resolve;
    });
    fileSystemMocks.afterRename = async () => {
      signalPublished?.();
      await renameGate;
    };

    const acquire = acquireBrowserHarnessCloudLease({
      root,
      name: "oc_1313131313131313",
    });
    await published;
    await expect(
      reconcileStaleBrowserHarnessCloudLeases({
        cleanup: async () => {
          throw new Error("published active lease must not be reclaimed");
        },
      }),
    ).resolves.toBe(0);
    allowRenameToReturn?.();
    const leasePath = await acquire;
    await releaseBrowserHarnessCloudLease(leasePath);
  });

  it("recovers an abandoned lease and removes its runtime only after cleanup", async () => {
    const { leasePath, root } = await setupLease("2222222222222222");
    deactivateBrowserHarnessCloudLease(leasePath);
    const cleaned: string[] = [];

    await expect(
      reconcileStaleBrowserHarnessCloudLeases({
        cleanup: async (lease) => {
          cleaned.push(lease.name);
        },
      }),
    ).resolves.toBe(1);

    expect(cleaned).toEqual(["oc_2222222222222222"]);
    await expect(rm(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains an abandoned lease and runtime when provider cleanup fails", async () => {
    const { leasePath, root } = await setupLease("3333333333333333");
    deactivateBrowserHarnessCloudLease(leasePath);

    await expect(
      reconcileStaleBrowserHarnessCloudLeases({
        cleanup: async () => {
          throw new Error("provider unavailable");
        },
      }),
    ).rejects.toThrow("provider unavailable");

    await expect(stat(root)).resolves.toMatchObject({});
    await releaseBrowserHarnessCloudLease(leasePath);
  });

  it("reclaims a lease when a live PID has a different process-start identity", async () => {
    const { leasePath } = await setupLease("5555555555555555");
    const lease = JSON.parse(await readFile(leasePath, "utf8"));
    lease.ownerPid = 4242;
    lease.ownerStartToken = "linux:old";
    await writeFile(leasePath, `${JSON.stringify(lease)}\n`);
    deactivateBrowserHarnessCloudLease(leasePath);

    await expect(
      reconcileStaleBrowserHarnessCloudLeases({
        cleanup: async () => undefined,
        liveness: {
          processExists: () => true,
          readProcessStartToken: () => "linux:new",
        },
      }),
    ).resolves.toBe(1);
  });

  it("keeps a live-PID lease when its process-start identity is temporarily unreadable", async () => {
    const { leasePath } = await setupLease("5656565656565656");
    const lease = JSON.parse(await readFile(leasePath, "utf8"));
    lease.ownerPid = 4242;
    lease.ownerStartToken = "linux:known";
    await writeFile(leasePath, `${JSON.stringify(lease)}\n`);
    deactivateBrowserHarnessCloudLease(leasePath);

    await expect(
      reconcileStaleBrowserHarnessCloudLeases({
        cleanup: async () => {
          throw new Error("unreadable identity is not proof that the owner died");
        },
        liveness: {
          processExists: () => true,
          readProcessStartToken: () => null,
        },
      }),
    ).resolves.toBe(0);

    await releaseBrowserHarnessCloudLease(leasePath);
  });

  it("expires existence-only leases instead of trusting a recycled PID forever", async () => {
    const { leasePath } = await setupLease("6666666666666666");
    const lease = JSON.parse(await readFile(leasePath, "utf8"));
    lease.ownerPid = 4242;
    delete lease.ownerStartToken;
    const createdAtMs = Date.parse(lease.createdAt);
    await writeFile(leasePath, `${JSON.stringify(lease)}\n`);
    deactivateBrowserHarnessCloudLease(leasePath);

    await expect(
      reconcileStaleBrowserHarnessCloudLeases({
        cleanup: async () => undefined,
        liveness: {
          nowMs: createdAtMs + 25 * 60 * 60 * 1000,
          processExists: () => true,
        },
      }),
    ).resolves.toBe(1);
  });
});
