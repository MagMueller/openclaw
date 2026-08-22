import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import {
  BrowserUseCliToolSchema,
  describeBrowserUseCliTool,
} from "./browser-use-cli-tool.schema.js";
import { writeExternalFileWithinOutputRoot } from "./browser/output-files.js";
import { resolvePreferredOpenClawTmpDir } from "./infra/tmp-openclaw-dir.js";
import { imageResultFromFile } from "./sdk-setup-tools.js";

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_OUTPUT_CHARS = 30_000;
const OUTPUT_HEAD_CHARS = 22_000;
const OUTPUT_TAIL_CHARS = 6_000;
const DAEMON_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

type Runtime = { env: Record<string, string> };

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

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

function safeExecDetails(details: unknown): Record<string, unknown> {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return {};
  }
  const allowed = new Set([
    "status",
    "exitCode",
    "exitSignal",
    "durationMs",
    "timedOut",
    "noOutputTimedOut",
  ]);
  return Object.fromEntries(
    Object.entries(details).filter(([key, value]) => allowed.has(key) && value !== undefined),
  );
}

function normalizeExecResult(
  action: string,
  result: AgentToolResult<unknown>,
): AgentToolResult<unknown> {
  const content = result.content.map((block) =>
    block.type === "text" ? { ...block, text: capOutput(block.text) } : block,
  );
  if (content.every((block) => block.type === "text" && !block.text.trim())) {
    content.push({ type: "text", text: "(no output — print(...) values you need)" });
  }
  return { content, details: { action, ...safeExecDetails(result.details) } };
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

function createHarnessCommand(code: string, env: Record<string, string>): string {
  const assignments = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return `printf '%s\\n' ${shellQuote(code)} | env -i ${assignments} browser-harness`;
}

export function createBrowserUseCliTool(opts: {
  exec: Pick<AnyAgentTool, "execute">;
  workspaceDir: string;
  registerRunCleanup: (cleanup: (reason: string) => Promise<void>) => void;
  env?: NodeJS.ProcessEnv;
}): AnyAgentTool {
  const processEnv = opts.env ?? process.env;
  let runtimePromise: Promise<Runtime> | undefined;

  const ensureRuntime = async (): Promise<Runtime> => {
    runtimePromise ??= (async () => {
      const runtimeDir = processEnv.BH_RUNTIME_DIR?.trim();
      const name = processEnv.BU_NAME?.trim();
      if (!runtimeDir || !path.isAbsolute(runtimeDir) || !name || !DAEMON_NAME_PATTERN.test(name)) {
        throw new Error(
          "BH_ORCHESTRATOR_EXISTING_DAEMON=1 requires an absolute BH_RUNTIME_DIR and a valid BU_NAME",
        );
      }
      const root = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "oc-bh-cli-"));
      const home = path.join(root, "home");
      const tmp = path.join(root, "tmp");
      try {
        await Promise.all([home, tmp].map(async (dir) => await mkdir(dir, { mode: 0o700 })));
        opts.registerRunCleanup(async () => {
          await rm(root, { recursive: true, force: true });
        });
        return {
          env: {
            PATH: processEnv.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            LANG: processEnv.LANG ?? "C.UTF-8",
            HOME: home,
            BH_HOME: home,
            BH_CONFIG_DIR: home,
            BH_AUTH_PATH: path.join(home, "auth.json"),
            BH_RUNTIME_DIR: runtimeDir,
            BH_TMP_DIR: tmp,
            BH_AGENT_WORKSPACE: opts.workspaceDir,
            BU_NAME: name,
            BH_REQUIRE_EXISTING_DAEMON: "1",
            BH_TELEMETRY: "0",
            BROWSER_HARNESS_TELEMETRY: "0",
            ANONYMIZED_TELEMETRY: "0",
            BH_RECORD: "0",
            BH_UPDATE_CHECK: "0",
            BH_OPEN_LIVE_URL: "0",
          },
        };
      } catch (error) {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    })();
    return await runtimePromise;
  };

  const run = async (
    toolCallId: string,
    action: string,
    code: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>> => {
    const runtime = await ensureRuntime();
    return normalizeExecResult(
      action,
      await opts.exec.execute(
        `${toolCallId}:browser-use-cli`,
        {
          command: createHarnessCommand(code, runtime.env),
          workdir: opts.workspaceDir,
          host: "gateway",
          background: false,
          timeoutSeconds,
        },
        signal,
      ),
    );
  };

  return {
    label: "Browser",
    name: "browser",
    resultContentSource: "network",
    description: describeBrowserUseCliTool(),
    parameters: BrowserUseCliToolSchema,
    execute: async (toolCallId, args, signal) => {
      const input = readInput(args);
      const action = typeof input.action === "string" ? input.action : "";
      const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
      if (action === "status" || action === "start") {
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
          toolCallId,
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
        return await run(toolCallId, action, code, timeoutSeconds, signal);
      }
      if (action === "screenshot") {
        const screenshotDir = path.join(opts.workspaceDir, ".openclaw", "browser");
        const screenshotPath = path.join(
          screenshotDir,
          `screenshot-${createHash("sha256").update(toolCallId).digest("hex").slice(0, 16)}.png`,
        );
        const fullPage = input.fullPage === true;
        let captureResult: AgentToolResult<unknown> | undefined;
        try {
          const result = await writeExternalFileWithinOutputRoot({
            rootDir: screenshotDir,
            path: screenshotPath,
            write: async (safePath) => {
              captureResult = await run(
                toolCallId,
                action,
                `capture_screenshot(${pythonStringLiteral(safePath)}, full=${fullPage ? "True" : "False"})`,
                timeoutSeconds,
                signal,
              );
            },
          });
          const details = safeExecDetails(captureResult?.details);
          if (
            captureResult &&
            (details.timedOut === true ||
              details.status === "failed" ||
              (typeof details.exitCode === "number" && details.exitCode !== 0))
          ) {
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
            {
              action,
              screenshot: "failed",
              ...safeExecDetails(captureResult?.details),
            },
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
