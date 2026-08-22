import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { resolveNodeHostExecutable } from "openclaw/plugin-sdk/node-host";
import {
  runCommandWithTimeout,
  type CommandOptions,
  type SpawnResult,
} from "openclaw/plugin-sdk/process-runtime";
import {
  BrowserUseCliToolSchema,
  describeBrowserUseCliTool,
} from "./browser-use-cli-tool.schema.js";
import { writeExternalFileWithinOutputRoot } from "./browser/output-files.js";
import { resolvePreferredOpenClawTmpDir } from "./infra/tmp-openclaw-dir.js";
import { imageResultFromFile } from "./sdk-setup-tools.js";

const DEFAULT_TIMEOUT_SECONDS = 120;
const PREFLIGHT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_CHARS = 30_000;
const OUTPUT_HEAD_CHARS = 22_000;
const OUTPUT_TAIL_CHARS = 6_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const DAEMON_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MINIMUM_BROWSER_HARNESS_VERSION = [0, 1, 10] as const;

export type BrowserUseCliRuntime = {
  executable: string;
  pathEnv: string;
  lang: string;
  runtimeDir: string;
  daemonName: string;
};

type RunCommand = (argv: string[], options: CommandOptions) => Promise<SpawnResult>;

function pythonStringLiteral(value: string): string {
  return JSON.stringify(value);
}

function capOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) {
    return value;
  }
  const omitted = value.length - OUTPUT_HEAD_CHARS - OUTPUT_TAIL_CHARS;
  return `${value.slice(0, OUTPUT_HEAD_CHARS)}\n...[${omitted} chars truncated]...\n${value.slice(-OUTPUT_TAIL_CHARS)}`;
}

function textResult(text: string, details: Record<string, unknown>): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function readInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

function readTimeoutSeconds(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 900) {
    throw new Error("timeoutSeconds must be an integer between 1 and 900");
  }
  return Number(value);
}

function parseVersion(value: string): readonly [number, number, number] | undefined {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isSupportedVersion(version: readonly [number, number, number]): boolean {
  for (let index = 0; index < MINIMUM_BROWSER_HARNESS_VERSION.length; index += 1) {
    const actual = version[index] ?? 0;
    const minimum = MINIMUM_BROWSER_HARNESS_VERSION[index] ?? 0;
    if (actual !== minimum) {
      return actual > minimum;
    }
  }
  return true;
}

function resolveRuntimeIdentity(
  env: NodeJS.ProcessEnv,
): Pick<BrowserUseCliRuntime, "runtimeDir" | "daemonName"> | undefined {
  const runtimeDir = env.BH_RUNTIME_DIR?.trim();
  const daemonName = env.BU_NAME?.trim();
  if (
    !runtimeDir ||
    !path.isAbsolute(runtimeDir) ||
    !daemonName ||
    !DAEMON_NAME_PATTERN.test(daemonName)
  ) {
    return undefined;
  }
  return { runtimeDir, daemonName };
}

function buildRuntimeEnv(params: {
  runtime: BrowserUseCliRuntime;
  workspaceDir: string;
  homeDir: string;
  tmpDir: string;
}): Record<string, string> {
  return {
    PATH: params.runtime.pathEnv,
    LANG: params.runtime.lang,
    HOME: params.homeDir,
    BH_HOME: params.homeDir,
    BH_CONFIG_DIR: params.homeDir,
    BH_AUTH_PATH: path.join(params.homeDir, "auth.json"),
    BH_RUNTIME_DIR: params.runtime.runtimeDir,
    BH_TMP_DIR: params.tmpDir,
    BH_AGENT_WORKSPACE: params.workspaceDir,
    BU_NAME: params.runtime.daemonName,
    BH_REQUIRE_EXISTING_DAEMON: "1",
    BH_TELEMETRY: "0",
    BROWSER_HARNESS_TELEMETRY: "0",
    ANONYMIZED_TELEMETRY: "0",
    BH_RECORD: "0",
    BH_UPDATE_CHECK: "0",
    BH_OPEN_LIVE_URL: "0",
  };
}

async function withEphemeralRuntimeEnv<T>(params: {
  runtime: BrowserUseCliRuntime;
  workspaceDir: string;
  run: (env: Record<string, string>) => Promise<T>;
}): Promise<T> {
  const root = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "oc-bh-cli-"));
  const homeDir = path.join(root, "home");
  const tmpDir = path.join(root, "tmp");
  try {
    await Promise.all([homeDir, tmpDir].map(async (dir) => await mkdir(dir, { mode: 0o700 })));
    return await params.run(
      buildRuntimeEnv({
        runtime: params.runtime,
        workspaceDir: params.workspaceDir,
        homeDir,
        tmpDir,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Resolve and verify the exact Browser Harness binary and existing daemon before replacement. */
export function prepareBrowserUseCliRuntime(params: {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
}): BrowserUseCliRuntime | undefined {
  if (process.platform === "win32") {
    return undefined;
  }
  const env = params.env ?? process.env;
  const identity = resolveRuntimeIdentity(env);
  const pathEnv = env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  if (!identity) {
    return undefined;
  }
  const resolved = resolveNodeHostExecutable("browser-harness", {
    env,
    pathEnv,
    strategy: "direct",
  });
  if (!resolved) {
    return undefined;
  }
  let executable: string;
  try {
    executable = realpathSync(resolved.executable);
  } catch {
    return undefined;
  }
  const runtime: BrowserUseCliRuntime = {
    executable,
    pathEnv: resolved.pathEnv ?? pathEnv,
    lang: env.LANG ?? "C.UTF-8",
    ...identity,
  };
  let root: string | undefined;
  try {
    root = mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "oc-bh-probe-"));
    const homeDir = path.join(root, "home");
    const tmpDir = path.join(root, "tmp");
    mkdirSync(homeDir, { mode: 0o700 });
    mkdirSync(tmpDir, { mode: 0o700 });
    const probeEnv = buildRuntimeEnv({
      runtime,
      workspaceDir: params.workspaceDir,
      homeDir,
      tmpDir,
    });
    const version = spawnSync(executable, ["--version"], {
      cwd: params.workspaceDir,
      env: probeEnv,
      encoding: "utf8",
      timeout: PREFLIGHT_TIMEOUT_MS,
      maxBuffer: MAX_CAPTURE_BYTES,
      windowsHide: true,
    });
    const parsedVersion = version.status === 0 ? parseVersion(version.stdout) : undefined;
    if (!parsedVersion || !isSupportedVersion(parsedVersion)) {
      return undefined;
    }
    const daemon = spawnSync(executable, [], {
      cwd: params.workspaceDir,
      env: probeEnv,
      encoding: "utf8",
      input: "list_tabs()\n",
      timeout: PREFLIGHT_TIMEOUT_MS,
      maxBuffer: MAX_CAPTURE_BYTES,
      windowsHide: true,
    });
    return daemon.status === 0 ? runtime : undefined;
  } catch {
    return undefined;
  } finally {
    if (root) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup after a bounded readiness probe.
      }
    }
  }
}

function normalizeCommandResult(
  action: string,
  result: SpawnResult,
  durationMs: number,
): AgentToolResult<unknown> {
  const failed = result.code !== 0 || result.termination !== "exit";
  const output = failed
    ? [result.stdout, result.stderr].filter((value) => value.trim()).join("\n")
    : result.stdout;
  const text = output.trim()
    ? capOutput(output)
    : failed
      ? "Browser call failed without diagnostic output."
      : "(no output — print(...) values you need)";
  return textResult(text, {
    action,
    status: failed ? "failed" : "completed",
    exitCode: result.code,
    ...(result.signal ? { exitSignal: result.signal } : {}),
    durationMs,
    timedOut: result.termination === "timeout",
    noOutputTimedOut: result.termination === "no-output-timeout",
  });
}

function isFailedCommandResult(result: AgentToolResult<unknown> | undefined): boolean {
  const details = result?.details;
  return Boolean(
    details && typeof details === "object" && Reflect.get(details, "status") === "failed",
  );
}

export function createBrowserUseCliTool(opts: {
  runtime: BrowserUseCliRuntime;
  workspaceDir: string;
  runCommand?: RunCommand;
}): AnyAgentTool {
  const runCommand = opts.runCommand ?? runCommandWithTimeout;
  const run = async (
    action: string,
    code: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>> =>
    await withEphemeralRuntimeEnv({
      runtime: opts.runtime,
      workspaceDir: opts.workspaceDir,
      run: async (env) => {
        const startedAt = Date.now();
        const result = await runCommand([opts.runtime.executable], {
          cwd: opts.workspaceDir,
          input: `${code}\n`,
          baseEnv: {},
          env,
          timeoutMs: timeoutSeconds * 1_000,
          signal,
          killProcessTree: true,
          maxOutputBytes: MAX_CAPTURE_BYTES,
        });
        if (signal?.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error("Browser call aborted", { cause: signal.reason });
        }
        return normalizeCommandResult(action, result, Date.now() - startedAt);
      },
    });

  return {
    label: "Browser",
    name: "browser",
    resultContentSource: "network",
    description: describeBrowserUseCliTool(),
    parameters: BrowserUseCliToolSchema,
    execute: async (_toolCallId, args, signal) => {
      const input = readInput(args);
      const action = typeof input.action === "string" ? input.action : "";
      const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
      if (action === "status" || action === "start") {
        const probe = await run(action, "list_tabs()", timeoutSeconds, signal);
        if (isFailedCommandResult(probe)) {
          return probe;
        }
        return textResult(
          "Browser Use Cloud is ready. The run orchestrator owns this persistent browser and its cleanup.",
          { action, orchestratorOwned: true },
        );
      }
      if (action === "stop") {
        return textResult(
          "Browser cleanup remains with the run orchestrator and will happen automatically.",
          { action, orchestratorOwned: true },
        );
      }
      if (action === "open") {
        const url = typeof input.url === "string" ? input.url.trim() : "";
        if (!url) {
          return textResult("action=open requires url.", { action, error: "missing_url" });
        }
        return await run(
          action,
          `new_tab(${pythonStringLiteral(url)})\nwait_for_load()\nprint(page_info())`,
          timeoutSeconds,
          signal,
        );
      }
      if (action === "exec") {
        const code = typeof input.code === "string" ? input.code : "";
        if (!code.trim()) {
          return textResult("action=exec requires code.", { action, error: "missing_code" });
        }
        return await run(action, code, timeoutSeconds, signal);
      }
      if (action === "screenshot") {
        const screenshotDir = path.join(opts.workspaceDir, ".openclaw", "browser");
        const screenshotPath = path.join(
          screenshotDir,
          `screenshot-${createHash("sha256").update(_toolCallId).digest("hex").slice(0, 16)}.png`,
        );
        const fullPage = input.fullPage === true;
        let captureResult: AgentToolResult<unknown> | undefined;
        try {
          const result = await writeExternalFileWithinOutputRoot({
            rootDir: screenshotDir,
            path: screenshotPath,
            write: async (safePath) => {
              captureResult = await run(
                action,
                `capture_screenshot(${pythonStringLiteral(safePath)}, full=${fullPage ? "True" : "False"})`,
                timeoutSeconds,
                signal,
              );
            },
          });
          if (captureResult && isFailedCommandResult(captureResult)) {
            return captureResult;
          }
          return await imageResultFromFile({
            label: "browser screenshot",
            path: result,
            details: { action, orchestratorOwned: true, media: { outbound: false } },
          });
        } catch {
          if (signal?.aborted) {
            throw signal.reason instanceof Error
              ? signal.reason
              : new Error("Browser screenshot aborted", { cause: signal.reason });
          }
          return textResult(
            "The browser screenshot failed. Inspect the page with action=exec, then retry screenshot.",
            { action, screenshot: "failed" },
          );
        }
      }
      return textResult(
        `Unknown action ${JSON.stringify(action)}. Use one of: status, start, stop, open, screenshot, exec.`,
        { action, error: "unknown_action" },
      );
    },
  };
}
