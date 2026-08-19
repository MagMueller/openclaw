import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const LEASE_VERSION = 1;
const LEASE_LIVENESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PROCESS_INSTANCE_ID = randomUUID();
const OWNED_ROOT_PATTERN = /^ocbh-[a-f0-9]{16}$/;
const OWNED_NAME_PATTERN = /^oc_[a-f0-9]{16}$/;
const activeLeasePaths = new Set<string>();

export type BrowserHarnessCloudLease = {
  version: 1;
  ownerPid: number;
  ownerInstanceId: string;
  /** Added after v1 shipped; absent legacy leases use existence plus the age ceiling. */
  ownerStartToken?: string | null;
  root: string;
  name: string;
  createdAt: string;
};

export type BrowserHarnessCloudLeaseLiveness = {
  nowMs?: number;
  processExists?: (pid: number) => boolean;
  readProcessStartToken?: (pid: number) => string | null;
};

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

function leaseDirectory(): string {
  return path.join(resolveStateDir(), "browser", "harness-cloud-leases");
}

async function fsyncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

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

function parseLease(raw: string, leasePath: string): BrowserHarnessCloudLease {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid Browser Harness cloud lease JSON: ${leasePath}`, { cause: error });
  }
  if (!isBrowserHarnessCloudLease(value)) {
    throw new Error(`Invalid Browser Harness cloud lease: ${leasePath}`);
  }
  assertOwnedRoot(value.root);
  return value;
}

function leasePathForRoot(root: string): string {
  const id = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24);
  return path.join(leaseDirectory(), `${id}.json`);
}

async function removeLeaseFile(leasePath: string): Promise<void> {
  try {
    await unlink(leasePath);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  activeLeasePaths.delete(leasePath);
  await fsyncDirectory(path.dirname(leasePath));
}

function ownerProcessMayStillBeActive(
  lease: BrowserHarnessCloudLease,
  leasePath: string,
  liveness: BrowserHarnessCloudLeaseLiveness,
): boolean {
  if (activeLeasePaths.has(leasePath)) {
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

export async function hasBrowserHarnessCloudLeases(): Promise<boolean> {
  try {
    return (await readdir(leaseDirectory())).some((entry) => entry.endsWith(".json"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function acquireBrowserHarnessCloudLease(params: {
  root: string;
  name: string;
}): Promise<string> {
  assertOwnedRoot(params.root);
  if (!OWNED_NAME_PATTERN.test(params.name)) {
    throw new Error(`Invalid Browser Harness cloud lease name: ${JSON.stringify(params.name)}`);
  }
  const directory = leaseDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const leasePath = leasePathForRoot(params.root);
  const pendingPath = path.join(
    directory,
    `.${path.basename(leasePath)}.${process.pid}.${randomUUID()}.pending`,
  );
  const lease: BrowserHarnessCloudLease = {
    version: LEASE_VERSION,
    ownerPid: process.pid,
    ownerInstanceId: PROCESS_INSTANCE_ID,
    ownerStartToken: PROCESS_START_TOKEN,
    root: path.resolve(params.root),
    name: params.name,
    createdAt: new Date().toISOString(),
  };
  activeLeasePaths.add(leasePath);
  let committed = false;
  try {
    await writeFile(pendingPath, `${JSON.stringify(lease)}\n`, { mode: 0o600, flag: "wx" });
    const handle = await open(pendingPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(pendingPath, leasePath);
    await fsyncDirectory(directory);
    committed = true;
  } finally {
    await unlink(pendingPath).catch(() => undefined);
    if (!committed) {
      activeLeasePaths.delete(leasePath);
    }
  }
  return leasePath;
}

export function deactivateBrowserHarnessCloudLease(leasePath: string): void {
  activeLeasePaths.delete(leasePath);
}

export async function releaseBrowserHarnessCloudLease(leasePath: string): Promise<void> {
  await removeLeaseFile(leasePath);
}

export async function reconcileStaleBrowserHarnessCloudLeases(params: {
  cleanup: (lease: BrowserHarnessCloudLease) => Promise<void>;
  liveness?: BrowserHarnessCloudLeaseLiveness;
}): Promise<number> {
  const directory = leaseDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entries = await readdir(directory, { withFileTypes: true });
  let recovered = 0;
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith(".json")) {
      continue;
    }
    const leasePath = path.join(directory, entry.name);
    const stats = await lstat(leasePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Invalid Browser Harness cloud lease file: ${leasePath}`);
    }
    const lease = parseLease(await readFile(leasePath, "utf8"), leasePath);
    if (ownerProcessMayStillBeActive(lease, leasePath, params.liveness ?? {})) {
      continue;
    }
    await params.cleanup(lease);
    await removeLeaseFile(leasePath);
    await rm(lease.root, { recursive: true, force: true });
    recovered += 1;
  }
  return recovered;
}
