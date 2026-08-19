import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acquireBrowserHarnessCloudLease,
  deactivateBrowserHarnessCloudLease,
  reconcileStaleBrowserHarnessCloudLeases,
  releaseBrowserHarnessCloudLease,
  type BrowserHarnessCloudLeaseHandle,
  type BrowserHarnessCloudLeaseStore,
} from "./browser-harness-cloud-leases.js";
import { assertStableHarnessWebSocketEndpoint } from "./browser-harness-endpoint.js";
import {
  BROWSER_HARNESS_ORCHESTRATOR_EXISTING_DAEMON_ENV,
  hasBrowserHarnessOrchestratorBinding,
} from "./browser-harness-orchestrator.js";
import {
  appendCdpPath,
  assertCdpEndpointAllowed,
  fetchJson,
  isWebSocketUrl,
  redactCdpErrorText,
  scopeCdpPolicyToConfiguredEndpoint,
} from "./browser/cdp.helpers.js";
import { browserStart } from "./browser/client.js";
import { resolveProfile } from "./browser/config.js";
import type { BrowserConfig } from "./config/config.js";
import { getBrowserControlState, startBrowserControlServiceFromConfig } from "./control-service.js";

const BOOTSTRAP_TIMEOUT_MS = 90_000;
const BOOTSTRAP_KILL_GRACE_MS = 2_000;
const MAX_BOOTSTRAP_OUTPUT_BYTES = 16 * 1024;
const INSTALL_HINT =
  "Browser Harness is not installed. Run: uv tool install --python 3.12 browser-harness";
const DAEMON_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type BrowserHarnessTarget = "chrome" | "cloud" | "profile";

export type BrowserHarnessRuntime = {
  executable: string;
  env: Record<string, string>;
  name: string;
  profile?: string;
  target: BrowserHarnessTarget;
  cleanup: () => Promise<void>;
};

function sessionSlug(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function baseHarnessEnv(params: {
  homeDir: string;
  runtimeDir: string;
  tmpDir: string;
  workspaceDir: string;
  name: string;
}): Record<string, string> {
  return {
    LANG: process.env.LANG ?? "C.UTF-8",
    ...(process.platform === "win32" && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
    BH_HOME: params.homeDir,
    BH_CONFIG_DIR: params.homeDir,
    BH_AUTH_PATH: path.join(params.homeDir, "auth.json"),
    BH_RUNTIME_DIR: params.runtimeDir,
    BH_TMP_DIR: params.tmpDir,
    BH_AGENT_WORKSPACE: params.workspaceDir,
    BU_NAME: params.name,
    BH_TELEMETRY: "0",
    BROWSER_HARNESS_TELEMETRY: "0",
    ANONYMIZED_TELEMETRY: "0",
    BH_RECORD: "0",
  };
}

function addCloudBootstrapCredentials(env: Record<string, string>): Record<string, string> {
  const bootstrapEnv = { ...env };
  if (process.env.BROWSER_USE_API_KEY) {
    bootstrapEnv.BROWSER_USE_API_KEY = process.env.BROWSER_USE_API_KEY;
    return bootstrapEnv;
  }
  // Trusted provisioning may use `browser-harness auth login`; keep the model
  // process on its isolated home while bootstrap/cleanup use the operator's
  // existing credential location without persisting credentials in a lease.
  for (const key of [
    "BH_HOME",
    "BROWSER_HARNESS_HOME",
    "BH_CONFIG_DIR",
    "BH_AUTH_PATH",
    "XDG_CONFIG_HOME",
  ]) {
    const value = process.env[key];
    if (value) {
      bootstrapEnv[key] = value;
    } else {
      delete bootstrapEnv[key];
    }
  }
  return bootstrapEnv;
}

export async function reconcileBrowserHarnessCloudLeases(params: {
  browserConfig: BrowserConfig | undefined;
  cloudLeaseStore: BrowserHarnessCloudLeaseStore;
  executablePath?: string;
  signal?: AbortSignal;
}): Promise<number> {
  const executable =
    params.executablePath ??
    (params.browserConfig?.harness?.executablePath?.trim() || "browser-harness");
  return await reconcileStaleBrowserHarnessCloudLeases({
    store: params.cloudLeaseStore,
    cleanup: async (lease) => {
      const staleEnv = addCloudBootstrapCredentials(
        baseHarnessEnv({
          homeDir: path.join(lease.root, "h"),
          runtimeDir: path.join(lease.root, "r"),
          tmpDir: path.join(lease.root, "t"),
          workspaceDir: path.join(lease.root, "w"),
          name: lease.name,
        }),
      );
      await runHarnessBootstrap({
        executable,
        env: staleEnv,
        code: "stop_remote_daemon(NAME)\n",
        signal: params.signal,
      });
    },
  });
}

async function runHarnessBootstrap(params: {
  executable: string;
  env: Record<string, string>;
  code?: string;
  args?: string[];
  signal?: AbortSignal;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(params.executable, params.args ?? [], {
      // PATH is trusted control-plane state used only to locate the fixed CLI
      // for bootstrap/cleanup. It is intentionally absent from model exec env.
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        ...params.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let output = "";
    const capture = (chunk: Buffer) => {
      if (output.length < MAX_BOOTSTRAP_OUTPUT_BYTES) {
        output += chunk.toString("utf8").slice(0, MAX_BOOTSTRAP_OUTPUT_BYTES - output.length);
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    let killTimer: NodeJS.Timeout | undefined;
    const signalChild = (signal: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to the direct child when its process group already exited.
        }
      }
      child.kill(signal);
    };
    const terminate = () => {
      signalChild("SIGTERM");
      killTimer ??= setTimeout(() => signalChild("SIGKILL"), BOOTSTRAP_KILL_GRACE_MS);
    };
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, BOOTSTRAP_TIMEOUT_MS);
    const abort = () => terminate();
    params.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      params.signal?.removeEventListener("abort", abort);
      reject(error.code === "ENOENT" ? new Error(INSTALL_HINT) : error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      params.signal?.removeEventListener("abort", abort);
      if (params.signal?.aborted) {
        reject(
          params.signal.reason instanceof Error
            ? params.signal.reason
            : new Error("Browser Harness bootstrap aborted", { cause: params.signal.reason }),
        );
      } else if (timedOut) {
        reject(new Error("Browser Harness bootstrap timed out"));
      } else if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Browser Harness bootstrap failed (${signal ?? `exit ${code ?? "unknown"}`}): ${redactCdpErrorText(output.trim()) || "no output"}`,
          ),
        );
      }
    });
    child.stdin.end(params.code ?? "");
  });
}

function pythonStringLiteral(value: string): string {
  return JSON.stringify(value);
}

export async function captureBrowserHarnessScreenshot(params: {
  runtime: BrowserHarnessRuntime;
  path: string;
  fullPage: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  await runHarnessBootstrap({
    executable: params.runtime.executable,
    env: params.runtime.env,
    code: `capture_screenshot(${pythonStringLiteral(params.path)}, full=${params.fullPage ? "True" : "False"})\n`,
    signal: params.signal,
  });
}

function addConfiguredCredentials(discoveredWsUrl: string, configuredCdpUrl: string): string {
  const configured = new URL(configuredCdpUrl);
  const discovered = new URL(discoveredWsUrl);
  if (configured.username && !discovered.username) {
    discovered.username = configured.username;
    discovered.password = configured.password;
  }
  return discovered.toString();
}

async function resolveProfileWebSocket(params: {
  profileName: string;
  signal?: AbortSignal;
}): Promise<string> {
  await startBrowserControlServiceFromConfig();
  await browserStart(undefined, { profile: params.profileName, signal: params.signal });
  const state = getBrowserControlState();
  if (!state) {
    throw new Error("OpenClaw browser control service did not start");
  }
  const profile = resolveProfile(state.resolved, params.profileName);
  if (!profile) {
    throw new Error(`Unknown OpenClaw browser profile: ${params.profileName}`);
  }
  if (profile.driver === "existing-session") {
    throw new Error(
      `profile=${JSON.stringify(params.profileName)} uses Chrome MCP, not CDP; use the chrome extension or a CDP profile`,
    );
  }
  await assertCdpEndpointAllowed(profile.cdpUrl, state.resolved.ssrfPolicy);
  const cdpControlPolicy = scopeCdpPolicyToConfiguredEndpoint(
    profile.cdpUrl,
    state.resolved.ssrfPolicy,
  );
  if (isWebSocketUrl(profile.cdpUrl) && new URL(profile.cdpUrl).pathname !== "/") {
    return assertStableHarnessWebSocketEndpoint(profile.cdpUrl);
  }
  const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
    appendCdpPath(profile.cdpUrl, "/json/version"),
    state.resolved.remoteCdpTimeoutMs,
    { signal: params.signal },
    cdpControlPolicy,
  );
  const discoveredWsUrl = version.webSocketDebuggerUrl?.trim();
  if (!discoveredWsUrl) {
    throw new Error(`Browser profile ${params.profileName} did not expose a CDP WebSocket URL`);
  }
  await assertCdpEndpointAllowed(discoveredWsUrl, cdpControlPolicy, {
    source: "discovered",
    configuredUrl: profile.cdpUrl,
  });
  return assertStableHarnessWebSocketEndpoint(
    addConfiguredCredentials(discoveredWsUrl, profile.cdpUrl),
  );
}

export async function prepareBrowserHarnessRuntime(params: {
  browserConfig: BrowserConfig | undefined;
  cloudLeaseStore: BrowserHarnessCloudLeaseStore;
  target: BrowserHarnessTarget;
  profile?: string;
  sessionId: string;
  workspaceDir: string;
  allowCloudProvisioning?: boolean;
  signal?: AbortSignal;
  executablePath?: string;
}): Promise<BrowserHarnessRuntime> {
  const slug = sessionSlug(params.sessionId);
  // AF_UNIX paths are capped at roughly 100 bytes on macOS. os.tmpdir() lives
  // under /var/folders there, so keep the daemon's socket root deliberately short.
  const shortTmpRoot = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const root = path.join(shortTmpRoot, `ocbh-${slug}`);
  const ownedRuntimeDir = path.join(root, "r");
  const tmpDir = path.join(root, "t");
  const homeDir = path.join(root, "h");
  const reuseExistingDaemon = params.target === "cloud" && hasBrowserHarnessOrchestratorBinding();
  const existingRuntimeDir = process.env.BH_RUNTIME_DIR?.trim();
  const existingName = process.env.BU_NAME?.trim();
  if (
    reuseExistingDaemon &&
    (!existingRuntimeDir ||
      !path.isAbsolute(existingRuntimeDir) ||
      !DAEMON_NAME_PATTERN.test(existingName ?? ""))
  ) {
    throw new Error(
      `${BROWSER_HARNESS_ORCHESTRATOR_EXISTING_DAEMON_ENV}=1 requires an absolute BH_RUNTIME_DIR and a valid BU_NAME`,
    );
  }
  if (
    params.target === "cloud" &&
    !reuseExistingDaemon &&
    params.allowCloudProvisioning === false
  ) {
    throw new Error(
      "A one-shot agent exec cannot provision a managed cloud browser because its crash-recovery state is ephemeral. Pre-provision an orchestrator-owned Browser Harness daemon or run through the Gateway.",
    );
  }
  const executable =
    params.executablePath ??
    (params.browserConfig?.harness?.executablePath?.trim() || "browser-harness");
  if (params.target === "cloud" && !reuseExistingDaemon) {
    await reconcileBrowserHarnessCloudLeases({
      browserConfig: params.browserConfig,
      cloudLeaseStore: params.cloudLeaseStore,
      executablePath: executable,
      signal: params.signal,
    });
  }
  const runtimeDir = reuseExistingDaemon ? existingRuntimeDir! : ownedRuntimeDir;
  await Promise.all(
    [root, ...(reuseExistingDaemon ? [] : [runtimeDir]), tmpDir, homeDir].map(async (dir) => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }),
  );
  const name = reuseExistingDaemon ? existingName! : `oc_${slug}`;
  const publicEnv = baseHarnessEnv({
    homeDir,
    runtimeDir,
    tmpDir,
    workspaceDir: params.workspaceDir,
    name,
  });
  const bootstrapEnv =
    params.target === "cloud" && !reuseExistingDaemon
      ? addCloudBootstrapCredentials(publicEnv)
      : { ...publicEnv };
  if (reuseExistingDaemon) {
    // The very first probe must fail closed too. Otherwise a stale eval-owned
    // socket could make Browser Harness self-heal onto an unrelated local Chrome.
    bootstrapEnv.BH_REQUIRE_EXISTING_DAEMON = "1";
  }
  let cloudLease: BrowserHarnessCloudLeaseHandle | undefined;
  try {
    if (params.target === "cloud") {
      if (reuseExistingDaemon) {
        await runHarnessBootstrap({
          executable,
          env: bootstrapEnv,
          code: "print(page_info())\n",
          signal: params.signal,
        });
      } else {
        // The durable lease exists before Browser Use Cloud provisioning. If
        // OpenClaw is SIGKILLed after the POST, the next process can find and
        // stop this exact browser without persisting its credential.
        cloudLease = await acquireBrowserHarnessCloudLease({
          store: params.cloudLeaseStore,
          root,
          name,
        });
        await runHarnessBootstrap({
          executable,
          env: bootstrapEnv,
          code: "start_remote_daemon(NAME)\n",
          signal: params.signal,
        });
      }
    } else {
      const profileName =
        params.target === "chrome"
          ? "chrome"
          : params.profile?.trim() || params.browserConfig?.defaultProfile || "openclaw";
      bootstrapEnv.BU_CDP_WS = await resolveProfileWebSocket({
        profileName,
        signal: params.signal,
      });
      await runHarnessBootstrap({
        executable,
        env: bootstrapEnv,
        code: "print(page_info())\n",
        signal: params.signal,
      });
    }
    // Older Browser Harness daemons logged the initial CDP WebSocket URL. Truncate that
    // bootstrap-only line before model Python can read the isolated log.
    await writeFile(path.join(tmpDir, "bu.log"), "", { mode: 0o600 });
    // Every later model/screenshot call must reuse the exact scoped daemon.
    // Never let Browser Harness recover by discovering a different local Chrome.
    publicEnv.BH_REQUIRE_EXISTING_DAEMON = "1";
  } catch (error) {
    let cleanupError: unknown;
    if (!reuseExistingDaemon && (params.target !== "cloud" || cloudLease)) {
      try {
        await runHarnessBootstrap({
          executable,
          env: params.target === "cloud" ? bootstrapEnv : publicEnv,
          ...(params.target === "cloud"
            ? { code: "stop_remote_daemon(NAME)\n" }
            : { args: ["--reload"] }),
        });
        if (cloudLease) {
          await releaseBrowserHarnessCloudLease(params.cloudLeaseStore, cloudLease);
        }
      } catch (stopError) {
        cleanupError = stopError;
      }
    }
    if (cleanupError) {
      if (cloudLease) {
        deactivateBrowserHarnessCloudLease(cloudLease);
      }
      // Keep the runtime/auth handle so an operator or retry can stop the
      // resource. Deleting it here would turn a cleanup failure into an orphan.
      const preparationError = new Error(
        "Browser Harness preparation failed and cleanup did not complete; runtime state was preserved for retry",
        { cause: error },
      );
      Object.defineProperty(preparationError, "cleanupError", { value: cleanupError });
      throw preparationError;
    }
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    executable,
    env: publicEnv,
    name,
    ...(params.target === "profile" ? { profile: params.profile?.trim() } : {}),
    target: params.target,
    cleanup: async () => {
      if (reuseExistingDaemon) {
        await rm(root, { recursive: true, force: true });
        return;
      }
      try {
        await runHarnessBootstrap({
          executable,
          env: params.target === "cloud" ? bootstrapEnv : publicEnv,
          ...(params.target === "cloud"
            ? { code: "stop_remote_daemon(NAME)\n" }
            : { args: ["--reload"] }),
        });
        if (cloudLease) {
          await releaseBrowserHarnessCloudLease(params.cloudLeaseStore, cloudLease);
        }
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        if (cloudLease) {
          deactivateBrowserHarnessCloudLease(cloudLease);
        }
        throw error;
      }
    },
  };
}
