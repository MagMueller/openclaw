import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
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
const EXISTING_DAEMON_ENV = "OPENCLAW_BROWSER_HARNESS_EXISTING_DAEMON";
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
    const timeout = setTimeout(terminate, BOOTSTRAP_TIMEOUT_MS);
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

export function assertStableHarnessWebSocketEndpoint(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) === 0) {
    throw new Error(
      `Browser Harness cannot safely re-resolve remote CDP hostname ${JSON.stringify(parsed.hostname)}. Use browser.modelEngine=native for this profile until the Harness connection is routed through OpenClaw's pinned CDP broker.`,
    );
  }
  return wsUrl;
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
  target: BrowserHarnessTarget;
  profile?: string;
  sessionId: string;
  workspaceDir: string;
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
  const reuseExistingDaemon = params.target === "cloud" && process.env[EXISTING_DAEMON_ENV] === "1";
  const existingRuntimeDir = process.env.BH_RUNTIME_DIR?.trim();
  const existingName = process.env.BU_NAME?.trim();
  if (
    reuseExistingDaemon &&
    (!existingRuntimeDir ||
      !path.isAbsolute(existingRuntimeDir) ||
      !DAEMON_NAME_PATTERN.test(existingName ?? ""))
  ) {
    throw new Error(
      `${EXISTING_DAEMON_ENV}=1 requires an absolute BH_RUNTIME_DIR and a valid BU_NAME`,
    );
  }
  const runtimeDir = reuseExistingDaemon ? existingRuntimeDir! : ownedRuntimeDir;
  await Promise.all(
    [root, ...(reuseExistingDaemon ? [] : [runtimeDir]), tmpDir, homeDir].map(async (dir) => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }),
  );
  const name = reuseExistingDaemon ? existingName! : `oc_${slug}`;
  const executable =
    params.executablePath ??
    (params.browserConfig?.harness?.executablePath?.trim() || "browser-harness");
  const publicEnv = baseHarnessEnv({
    homeDir,
    runtimeDir,
    tmpDir,
    workspaceDir: params.workspaceDir,
    name,
  });
  const bootstrapEnv = { ...publicEnv };
  try {
    if (params.target === "cloud") {
      if (reuseExistingDaemon) {
        await runHarnessBootstrap({
          executable,
          env: publicEnv,
          code: "print(page_info())\n",
          signal: params.signal,
        });
      } else {
        if (process.env.BROWSER_USE_API_KEY) {
          bootstrapEnv.BROWSER_USE_API_KEY = process.env.BROWSER_USE_API_KEY;
        } else {
          // Trusted provisioning may use `browser-harness auth login`; keep the
          // model process on the isolated home configured in publicEnv.
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
        }
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
    // Browser Harness v0.1.9 logs the initial CDP WebSocket URL. Truncate that
    // bootstrap-only line before model Python can read the isolated log.
    await writeFile(path.join(tmpDir, "bu.log"), "", { mode: 0o600 });
  } catch (error) {
    if (!reuseExistingDaemon) {
      await runHarnessBootstrap({
        executable,
        env: publicEnv,
        ...(params.target === "cloud"
          ? { code: "stop_remote_daemon(NAME)\n" }
          : { args: ["--reload"] }),
      }).catch(() => undefined);
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
      await runHarnessBootstrap({
        executable,
        env: publicEnv,
        ...(params.target === "cloud"
          ? { code: "stop_remote_daemon(NAME)\n" }
          : { args: ["--reload"] }),
      });
      await rm(root, { recursive: true, force: true });
    },
  };
}
