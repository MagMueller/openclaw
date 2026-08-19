import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";

const LEASE_VERSION = 1;
const LEASE_LIVENESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PROCESS_INSTANCE_ID = randomUUID();
const OWNED_ROOT_PATTERN = /^ocbh-[a-f0-9]{16}$/;
const OWNED_NAME_PATTERN = /^oc_[a-f0-9]{16}$/;
const activeLeaseIds = new Set<string>();

const BROWSER_HARNESS_CLOUD_LEASE_NAMESPACE = "browser.harness-cloud-leases";
const BROWSER_HARNESS_CLOUD_LEASE_MAX_ENTRIES = 4096;

type BrowserHarnessCloudLease = {
  version: 1;
  leaseId: string;
  ownerPid: number;
  ownerInstanceId: string;
  /** Added after v1 shipped; absent legacy leases use existence plus the age ceiling. */
  ownerStartToken?: string | null;
  root: string;
  name: string;
  createdAt: string;
};

export type BrowserHarnessCloudLeaseStore = PluginStateKeyedStore<unknown>;

export type BrowserHarnessCloudLeaseHandle = {
  key: string;
  leaseId: string;
};

type BrowserHarnessCloudLeaseLiveness = {
  nowMs?: number;
  processExists?: (pid: number) => boolean;
  readProcessStartToken?: (pid: number) => string | null;
};

export function openBrowserHarnessCloudLeaseStore(
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
): BrowserHarnessCloudLeaseStore {
  return openKeyedStore<unknown>({
    namespace: BROWSER_HARNESS_CLOUD_LEASE_NAMESPACE,
    maxEntries: BROWSER_HARNESS_CLOUD_LEASE_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

function readProcessStartToken(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
      const startTime = fields[19];
      return startTime && /^\d+$/.test(startTime) ? `linux:${startTime}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const startedAt = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        env: { LC_ALL: "C", TZ: "UTC" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      }).trim();
      const timestamp = Date.parse(`${startedAt} UTC`);
      return Number.isFinite(timestamp) ? `darwin:${Math.floor(timestamp / 1000)}` : null;
    } catch {
      return null;
    }
  }
  return null;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

const PROCESS_START_TOKEN = readProcessStartToken(process.pid);

function assertOwnedRoot(root: string): void {
  const expectedParent = path.resolve(process.platform === "win32" ? os.tmpdir() : "/tmp");
  const resolved = path.resolve(root);
  if (
    path.dirname(resolved) !== expectedParent ||
    !OWNED_ROOT_PATTERN.test(path.basename(resolved))
  ) {
    throw new Error(`Invalid Browser Harness cloud lease root: ${JSON.stringify(root)}`);
  }
}

function isBrowserHarnessCloudLease(value: unknown): value is BrowserHarnessCloudLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (
    "version" in value &&
    value.version === LEASE_VERSION &&
    "leaseId" in value &&
    typeof value.leaseId === "string" &&
    value.leaseId.length >= 1 &&
    value.leaseId.length <= 128 &&
    "ownerPid" in value &&
    typeof value.ownerPid === "number" &&
    Number.isInteger(value.ownerPid) &&
    value.ownerPid >= 1 &&
    "ownerInstanceId" in value &&
    typeof value.ownerInstanceId === "string" &&
    value.ownerInstanceId.length <= 128 &&
    (!("ownerStartToken" in value) ||
      value.ownerStartToken === null ||
      typeof value.ownerStartToken === "string") &&
    "root" in value &&
    typeof value.root === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    OWNED_NAME_PATTERN.test(value.name) &&
    "createdAt" in value &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt))
  );
}

function parseLease(value: unknown, key: string): BrowserHarnessCloudLease {
  if (!isBrowserHarnessCloudLease(value)) {
    throw new Error(`Invalid Browser Harness cloud lease: ${key}`);
  }
  assertOwnedRoot(value.root);
  return value;
}

function leaseKeyForRoot(root: string): string {
  return `sha256:${createHash("sha256").update(path.resolve(root)).digest("hex")}`;
}

function ownerProcessMayStillBeActive(
  lease: BrowserHarnessCloudLease,
  liveness: BrowserHarnessCloudLeaseLiveness,
): boolean {
  if (activeLeaseIds.has(lease.leaseId)) {
    return true;
  }
  if (lease.ownerPid === process.pid) {
    // A lease from this PID that is absent from the in-memory active set came
    // from an earlier process instance or an abandoned preparation.
    return false;
  }
  const ageMs = (liveness.nowMs ?? Date.now()) - Date.parse(lease.createdAt);
  if (ageMs > LEASE_LIVENESS_MAX_AGE_MS) {
    return false;
  }
  const isAlive = (liveness.processExists ?? processExists)(lease.ownerPid);
  if (!isAlive) {
    return false;
  }
  if (lease.ownerStartToken === null || lease.ownerStartToken === undefined) {
    return true;
  }
  const observedStartToken = (liveness.readProcessStartToken ?? readProcessStartToken)(
    lease.ownerPid,
  );
  // An unreadable identity is not proof of PID reuse. Hold the lease until the
  // age ceiling, matching OpenClaw's other durable process-claim semantics.
  return observedStartToken === null || observedStartToken === lease.ownerStartToken;
}

export async function hasBrowserHarnessCloudLeases(
  store: BrowserHarnessCloudLeaseStore,
): Promise<boolean> {
  return (await store.entries()).length > 0;
}

export async function acquireBrowserHarnessCloudLease(params: {
  store: BrowserHarnessCloudLeaseStore;
  root: string;
  name: string;
}): Promise<BrowserHarnessCloudLeaseHandle> {
  assertOwnedRoot(params.root);
  if (!OWNED_NAME_PATTERN.test(params.name)) {
    throw new Error(`Invalid Browser Harness cloud lease name: ${JSON.stringify(params.name)}`);
  }
  const key = leaseKeyForRoot(params.root);
  const lease: BrowserHarnessCloudLease = {
    version: LEASE_VERSION,
    leaseId: randomUUID(),
    ownerPid: process.pid,
    ownerInstanceId: PROCESS_INSTANCE_ID,
    ownerStartToken: PROCESS_START_TOKEN,
    root: path.resolve(params.root),
    name: params.name,
    createdAt: new Date().toISOString(),
  };
  activeLeaseIds.add(lease.leaseId);
  try {
    if (!(await params.store.registerIfAbsent(key, lease))) {
      throw new Error(`Browser Harness cloud lease already exists: ${key}`);
    }
  } catch (error) {
    activeLeaseIds.delete(lease.leaseId);
    throw error;
  }
  return { key, leaseId: lease.leaseId };
}

export function deactivateBrowserHarnessCloudLease(handle: BrowserHarnessCloudLeaseHandle): void {
  activeLeaseIds.delete(handle.leaseId);
}

export async function releaseBrowserHarnessCloudLease(
  store: BrowserHarnessCloudLeaseStore,
  handle: BrowserHarnessCloudLeaseHandle,
): Promise<void> {
  try {
    const deleteIf = store.deleteIf;
    if (!deleteIf) {
      throw new Error("Browser Harness cloud lease store does not support conditional deletion");
    }
    const deleted = await deleteIf(handle.key, (value) => {
      const lease = parseLease(value, handle.key);
      return lease.leaseId === handle.leaseId;
    });
    if (!deleted) {
      throw new Error(
        `Browser Harness cloud lease generation changed before release: ${handle.key}`,
      );
    }
  } finally {
    activeLeaseIds.delete(handle.leaseId);
  }
}

export async function reconcileStaleBrowserHarnessCloudLeases(params: {
  store: BrowserHarnessCloudLeaseStore;
  cleanup: (lease: BrowserHarnessCloudLease) => Promise<void>;
  liveness?: BrowserHarnessCloudLeaseLiveness;
}): Promise<number> {
  const deleteIf = params.store.deleteIf;
  if (!deleteIf) {
    throw new Error("Browser Harness cloud lease store does not support conditional deletion");
  }
  const entries = (await params.store.entries()).toSorted((a, b) => a.key.localeCompare(b.key));
  let recovered = 0;
  for (const entry of entries) {
    const lease = parseLease(entry.value, entry.key);
    if (ownerProcessMayStillBeActive(lease, params.liveness ?? {})) {
      continue;
    }
    await params.cleanup(lease);
    const deleted = await deleteIf(entry.key, (value) => {
      const current = parseLease(value, entry.key);
      return current.leaseId === lease.leaseId;
    });
    if (!deleted) {
      throw new Error(
        `Browser Harness cloud lease generation changed during cleanup: ${entry.key}`,
      );
    }
    await rm(lease.root, { recursive: true, force: true });
    recovered += 1;
  }
  return recovered;
}
