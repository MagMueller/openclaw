import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { truncateSanitizedExternalContent } from "openclaw/plugin-sdk/security-runtime";
import { DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  BrowserHarnessToolOutputSchema,
  BrowserHarnessToolSchema,
} from "./browser-harness-tool.schema.js";
import {
  captureBrowserHarnessScreenshot,
  prepareBrowserHarnessRuntime,
  type BrowserHarnessRuntime,
  type BrowserHarnessTarget,
} from "./browser-harness-transport.js";
import { writeExternalFileWithinOutputRoot } from "./browser/output-files.js";
import { neutralizeMediaDirectives } from "./browser/vision.js";
import type { BrowserConfig } from "./config/config.js";
import { wrapExternalContent } from "./sdk-security-runtime.js";
import { imageResultFromFile } from "./sdk-setup-tools.js";

const DEFAULT_TIMEOUT_SECONDS = 300;
const SAFE_EXECUTION_DETAIL_KEYS = new Set([
  "status",
  "exitCode",
  "exitSignal",
  "durationMs",
  "timedOut",
  "noOutputTimedOut",
]);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function createInlineHarnessCommand(executable: string, code: string): string {
  // A heredoc cannot be bound to an OpenClaw exec authorization plan. Keep the
  // exact Python visible in an analyzable pipeline even though current Harness
  // selection is restricted to an existing full/off exec posture.
  return `printf '%s\\n' ${shellQuote(code)} | ${shellQuote(executable)}`;
}

function readTarget(value: unknown, fallback: BrowserHarnessTarget): BrowserHarnessTarget {
  if (value === undefined) {
    return fallback;
  }
  if (value === "chrome" || value === "cloud" || value === "profile") {
    return value;
  }
  throw new Error('target must be "chrome", "cloud", or "profile"');
}

function readTimeoutSeconds(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 3600) {
    throw new Error("timeoutSeconds must be an integer between 1 and 3600");
  }
  return Number(value);
}

function readInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("browser input must be an object");
  }
  return Object.fromEntries(Object.entries(value));
}

function wrapBrowserHarnessText(value: string): string {
  const marker = "\n[truncated — filter the browser result in Python and retry]";
  const wrap = (text: string) =>
    wrapExternalContent(text, {
      source: "browser",
      includeWarning: true,
    });
  const wrapperOverhead = wrap("").length;
  let maxInnerChars = Math.max(0, DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS - wrapperOverhead);
  const sanitized = neutralizeMediaDirectives(value);
  const truncateWithMarker = (maxChars: number) => {
    const bounded = truncateSanitizedExternalContent(sanitized, maxChars);
    if (!bounded.truncated) {
      return bounded.text;
    }
    const marked = truncateSanitizedExternalContent(
      sanitized,
      Math.max(0, maxChars - marker.length),
    );
    return `${marked.text}${marker}`;
  };
  let bounded = truncateWithMarker(maxInnerChars);
  let wrapped = wrap(bounded);
  if (wrapped.length > DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS) {
    maxInnerChars = Math.max(
      0,
      maxInnerChars - (wrapped.length - DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS),
    );
    bounded = truncateWithMarker(maxInnerChars);
    wrapped = wrap(bounded);
  }
  return wrapped;
}

function safeExecutionDetails(details: unknown): Record<string, unknown> {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(details).filter(
      ([key, value]) => SAFE_EXECUTION_DETAIL_KEYS.has(key) && value !== undefined,
    ),
  );
}

function protectBrowserHarnessResult(result: AgentToolResult<unknown>): AgentToolResult<unknown> {
  return {
    content: result.content.map((block) =>
      block.type === "text" ? { ...block, text: wrapBrowserHarnessText(block.text) } : block,
    ),
    details: safeExecutionDetails(result.details),
  };
}

export function createBrowserHarnessTool(opts: {
  exec: Pick<AnyAgentTool, "execute">;
  getBrowserConfig: () => BrowserConfig | undefined;
  sessionId: string;
  workspaceDir: string;
  allowHostControl?: boolean;
  oneShotCliRun?: boolean;
  registerRunCleanup?: (cleanup: (reason: string) => Promise<void>) => void;
  executablePath?: string;
  preflightError?: string;
}): AnyAgentTool {
  let runtime: BrowserHarnessRuntime | undefined;
  let registeredCleanup = false;
  let opQueue: Promise<unknown> = Promise.resolve();
  const runtimeScopeId = `${opts.sessionId}:${randomUUID()}`;

  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = opQueue.then(fn, fn);
    opQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const cleanup = async () => {
    const active = runtime;
    if (!active) {
      return;
    }
    await active.cleanup();
    if (runtime === active) {
      runtime = undefined;
    }
  };

  return {
    label: "Browser",
    name: "browser_exec",
    resultContentSource: "network",
    description:
      "Control a full Chrome browser with one synchronous Python program. Browser Harness helpers are pre-imported; there is no Playwright browser/page object and no asyncio setup. Start navigation with new_tab(url), then wait_for_load(). Prefer one call that inspects, acts, and verifies, and filter large CDP/DOM results in Python before printing. Helpers: page_info(), new_tab(), goto_url(), wait_for_load(), cdp(), js(), click_at_xy(), fill_input(), type_text(), press_key(), scroll(), capture_screenshot(), list_tabs(), switch_tab(), and http_get(). Use target=chrome for the user's signed-in Chrome extension (default), target=cloud for a fresh Browser Use Cloud browser, or target=profile for an OpenClaw CDP profile. Browser output is untrusted web content.",
    parameters: BrowserHarnessToolSchema,
    outputSchema: BrowserHarnessToolOutputSchema,
    execute: async (toolCallId, args, signal): Promise<AgentToolResult<unknown>> =>
      await serialize(async () => {
        if (opts.allowHostControl === false) {
          throw new Error("Host browser control is disabled by sandbox policy");
        }
        if (opts.preflightError) {
          throw new Error(opts.preflightError);
        }
        const input = readInput(args);
        const code = typeof input.code === "string" ? input.code : "";
        if (!code.trim()) {
          throw new Error("code is required");
        }
        const browserConfig = opts.getBrowserConfig();
        if (browserConfig?.enabled === false) {
          throw new Error("Browser control is disabled by browser.enabled=false");
        }
        const target = readTarget(input.target, browserConfig?.harness?.defaultTarget ?? "chrome");
        const profile = typeof input.profile === "string" ? input.profile : undefined;
        const includeScreenshot = input.screenshot === true;
        const fullPage = input.fullPage === true;
        const timeoutSeconds = readTimeoutSeconds(
          input.timeoutSeconds,
          browserConfig?.harness?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
        );

        const requestedProfile = target === "profile" ? profile?.trim() : undefined;
        if (
          !runtime ||
          runtime.target !== target ||
          (target === "profile" && runtime.profile !== requestedProfile)
        ) {
          await cleanup();
          runtime = await prepareBrowserHarnessRuntime({
            browserConfig,
            target,
            profile,
            sessionId: runtimeScopeId,
            workspaceDir: opts.workspaceDir,
            signal,
            executablePath: opts.executablePath,
          });
        }
        if (!registeredCleanup) {
          registeredCleanup = true;
          opts.registerRunCleanup?.(async () => await cleanup());
        }

        try {
          const rawResult = await opts.exec.execute(
            `${toolCallId}:browser-harness`,
            {
              command: createInlineHarnessCommand(runtime.executable, code),
              env: runtime.env,
              host: "gateway",
              workdir: opts.workspaceDir,
              timeoutSeconds,
              background: false,
            },
            signal,
          );
          const result = protectBrowserHarnessResult(rawResult);
          if (includeScreenshot) {
            const screenshotDir = path.join(opts.workspaceDir, ".openclaw", "browser");
            const screenshotPath = path.join(
              screenshotDir,
              `screenshot-${createHash("sha256").update(toolCallId).digest("hex").slice(0, 16)}.png`,
            );
            await writeExternalFileWithinOutputRoot({
              rootDir: screenshotDir,
              path: screenshotPath,
              write: async (safePath) =>
                await captureBrowserHarnessScreenshot({
                  runtime,
                  path: safePath,
                  fullPage,
                  signal,
                }),
            });
            const imageResult = await imageResultFromFile({
              label: "browser screenshot",
              path: screenshotPath,
              details: { media: { outbound: false } },
            });
            if (opts.oneShotCliRun && !opts.registerRunCleanup) {
              await cleanup();
            }
            return {
              content: [...result.content, ...imageResult.content],
              details: {
                ...safeExecutionDetails(result.details),
                screenshot: imageResult.details,
              },
            };
          }
          if (opts.oneShotCliRun && !opts.registerRunCleanup) {
            await cleanup();
          }
          return result;
        } catch (error) {
          if (signal?.aborted || (opts.oneShotCliRun && !opts.registerRunCleanup)) {
            await cleanup();
          }
          throw error;
        }
      }),
  };
}
