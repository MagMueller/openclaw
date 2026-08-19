import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
/**
 * Browser plugin registration helpers. This file keeps registration lazy while
 * advertising Browser tools, services, node-host commands, and audits.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginSecurityAuditCollector,
  OpenClawPluginService,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import { createSubsystemLogger, isTruthyEnvValue } from "openclaw/plugin-sdk/runtime-env";
import { isBrowserMachineOutput } from "./cli-output-mode.js";
import {
  BROWSER_REQUEST_GATEWAY_METHOD,
  BROWSER_REQUEST_GATEWAY_SCOPE,
} from "./src/browser-gateway-contract.js";
import {
  openBrowserHarnessCloudLeaseStore,
  type BrowserHarnessCloudLeaseStore,
} from "./src/browser-harness-cloud-leases.js";
import { hasBrowserHarnessOrchestratorBinding } from "./src/browser-harness-orchestrator.js";
import {
  BrowserHarnessToolOutputSchema,
  BrowserHarnessToolSchema,
  describeBrowserHarnessTool,
} from "./src/browser-harness-tool.schema.js";
import {
  BROWSER_PROXY_COMMAND,
  BROWSER_PROXY_UPLOAD_COMMAND,
} from "./src/browser-node-commands.js";
import { parseBrowserTabToolBinding } from "./src/browser-tool-binding.js";
import { describeBrowserTool } from "./src/browser-tool-description.js";
import {
  BrowserToolOutputSchema,
  createBrowserToolSchema,
  resolveBrowserToolCapabilities,
} from "./src/browser-tool.schema.js";
import { resolveBrowserConfig, resolveProfile } from "./src/browser/config.js";
import { getBrowserProfileCapabilities } from "./src/browser/profile-capabilities.js";
import { initializeBrowserSessionTabStore } from "./src/browser/session-tab-store.js";
import {
  configureSystemProfileImportStateStore,
  type SystemProfileImportState,
} from "./src/browser/system-profile-import-state.js";

const EAGER_BROWSER_CONTROL_SERVICE_ENV = "OPENCLAW_EAGER_BROWSER_CONTROL_SERVER";
const CLOUD_LEASE_REAP_RETRY_MS = 60_000;
const MIN_BROWSER_HARNESS_VERSION = [0, 1, 10] as const;
const logger = createSubsystemLogger("browser");
const browserHarnessVersionCache = new Map<string, { fingerprint: string; supported: boolean }>();

function resolveExecutablePath(command: string): string | null {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  const baseCandidates = hasPathSeparator
    ? [path.resolve(command)]
    : (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((entry) => path.join(entry, command));
  const suffixes =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const candidate of baseCandidates) {
    for (const suffix of suffixes) {
      const resolvedCandidate = candidate.endsWith(suffix) ? candidate : `${candidate}${suffix}`;
      try {
        accessSync(resolvedCandidate, fsConstants.X_OK);
        return realpathSync(resolvedCandidate);
      } catch {
        // Keep searching PATH/PATHEXT candidates.
      }
    }
  }
  return null;
}

function isSupportedBrowserHarness(executable: string): boolean {
  let fingerprint: string;
  try {
    const stats = statSync(executable);
    fingerprint = [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(":");
  } catch {
    browserHarnessVersionCache.delete(executable);
    return false;
  }
  const cached = browserHarnessVersionCache.get(executable);
  if (cached?.fingerprint === fingerprint) {
    return cached.supported;
  }
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      LANG: process.env.LANG ?? "C.UTF-8",
    },
    maxBuffer: 4 * 1024,
    timeout: 2_000,
    windowsHide: true,
  });
  const version = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(
    /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/,
  );
  const major = Number(version?.[1] ?? Number.NaN);
  const minor = Number(version?.[2] ?? Number.NaN);
  const patch = Number(version?.[3] ?? Number.NaN);
  const supported = Boolean(
    !result.error &&
    result.status === 0 &&
    version &&
    (major > MIN_BROWSER_HARNESS_VERSION[0] ||
      (major === MIN_BROWSER_HARNESS_VERSION[0] &&
        (minor > MIN_BROWSER_HARNESS_VERSION[1] ||
          (minor === MIN_BROWSER_HARNESS_VERSION[1] && patch >= MIN_BROWSER_HARNESS_VERSION[2])))),
  );
  browserHarnessVersionCache.set(executable, { fingerprint, supported });
  return supported;
}

const loadBrowserRegistrationRuntimeModule = createLazyRuntimeModule(
  () => import("./register.runtime.js"),
);

function deriveChatTypeFromSessionKey(
  sessionKey: string | undefined,
): "direct" | "group" | "channel" | undefined {
  const tokens = new Set(sessionKey?.toLowerCase().split(":").filter(Boolean) ?? []);
  if (tokens.has("group")) {
    return "group";
  }
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("direct") || tokens.has("dm")) {
    return "direct";
  }
  return undefined;
}

const BROWSER_CLI_DESCRIPTOR = {
  name: "browser",
  description: "Manage OpenClaw's dedicated browser (Chrome/Chromium)",
  hasSubcommands: true,
  machineOutput: isBrowserMachineOutput,
};

function createLazyBrowserTool(
  opts?: {
    sandboxBridgeUrl?: string;
    allowHostControl?: boolean;
    agentSessionKey?: string;
    agentDir?: string;
    workspaceDir?: string;
    activeModel?: {
      provider?: string;
      model?: string;
    };
    mediaScope?: {
      sessionKey?: string;
      channel?: string;
      chatType?: string;
    };
    runToolBinding?: unknown;
  },
  config?: OpenClawPluginToolContext["runtimeConfig"],
): AnyAgentTool {
  const bindingResult =
    opts?.runToolBinding === undefined
      ? undefined
      : parseBrowserTabToolBinding(opts.runToolBinding);
  if (bindingResult && !bindingResult.ok) {
    throw new Error(`invalid browser run binding: ${bindingResult.error}`);
  }
  const targetDefault = opts?.sandboxBridgeUrl ? "sandbox" : "host";
  const hostHint =
    opts?.allowHostControl === false ? "Host target blocked by policy." : "Host target allowed.";
  const boundProfile =
    bindingResult?.ok && bindingResult.binding.target === "host"
      ? resolveProfile(resolveBrowserConfig(config?.browser, config), bindingResult.binding.profile)
      : undefined;
  const capabilities = resolveBrowserToolCapabilities({
    tabBound: bindingResult?.ok,
    evaluateEnabled: config?.browser?.evaluateEnabled !== false,
    ...(boundProfile ? { profileCapabilities: getBrowserProfileCapabilities(boundProfile) } : {}),
  });
  return {
    label: "Browser",
    name: "browser",
    resultContentSource: "network",
    description: describeBrowserTool({ targetDefault, hostHint, capabilities }),
    parameters: createBrowserToolSchema(capabilities),
    outputSchema: BrowserToolOutputSchema,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const { createBrowserTool } = await loadBrowserRegistrationRuntimeModule();
      const tool = createBrowserTool(
        bindingResult?.ok
          ? {
              ...opts,
              runToolBinding: bindingResult.binding,
              toolCapabilities: capabilities,
            }
          : { ...opts, toolCapabilities: capabilities },
      );
      return await tool.execute(toolCallId, args, signal, onUpdate);
    },
  };
}

function createLazyBrowserHarnessTool(
  ctx: OpenClawPluginToolContext,
  cloudLeaseStore: BrowserHarnessCloudLeaseStore,
): AnyAgentTool | null {
  const exec = ctx.browser?.harnessExec;
  const sessionId = ctx.sessionId?.trim();
  const workspaceDir = ctx.workspaceDir?.trim();
  const hasBrowserBinding = Boolean(ctx.toolBindings && Object.hasOwn(ctx.toolBindings, "browser"));
  const browserConfig = (ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config)?.browser;
  const engine = browserConfig?.modelEngine ?? "auto";
  const orchestratorBound = hasBrowserHarnessOrchestratorBinding();
  const harnessDefaultTarget = orchestratorBound
    ? "cloud"
    : (browserConfig?.harness?.defaultTarget ?? "chrome");
  if (
    !exec ||
    !sessionId ||
    !workspaceDir ||
    ctx.sandboxed ||
    hasBrowserBinding ||
    engine === "native"
  ) {
    return null;
  }
  const requestedExecutable = browserConfig?.harness?.executablePath?.trim() || "browser-harness";
  let preflight:
    | { executable: string | null; supported: boolean; error: string | undefined }
    | undefined;
  const resolvePreflight = () => {
    if (preflight) {
      return preflight;
    }
    const executable = resolveExecutablePath(requestedExecutable);
    const supported = executable ? isSupportedBrowserHarness(executable) : false;
    preflight = {
      executable,
      supported,
      error: supported
        ? undefined
        : executable
          ? `Browser Harness ${MIN_BROWSER_HARNESS_VERSION.join(".")} or newer is required`
          : `Browser Harness executable not found: ${JSON.stringify(requestedExecutable)}`,
    };
    return preflight;
  };
  let loadedTool: AnyAgentTool | undefined;
  return {
    label: "Browser",
    name: "browser_exec",
    resultContentSource: "network",
    description: describeBrowserHarnessTool({
      defaultTarget: harnessDefaultTarget,
      orchestratorBound,
    }),
    parameters: BrowserHarnessToolSchema,
    outputSchema: BrowserHarnessToolOutputSchema,
    // The final selector calls this only after browser + exec policy survived.
    // Keeping the executable probe here also prevents descriptor caching from
    // moving this run-specific check back ahead of policy.
    selectionPreflight: () => resolvePreflight().supported,
    execute: async (toolCallId, args, signal, onUpdate) => {
      if (!loadedTool) {
        const resolved = resolvePreflight();
        const { createBrowserHarnessTool } = await loadBrowserRegistrationRuntimeModule();
        loadedTool = createBrowserHarnessTool({
          exec,
          cloudLeaseStore,
          getBrowserConfig: () =>
            (ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config)?.browser,
          sessionId,
          workspaceDir,
          allowHostControl: ctx.browser?.allowHostControl,
          oneShotCliRun: ctx.oneShotCliRun,
          ephemeralRunState: ctx.ephemeralRunState,
          registerRunCleanup: ctx.registerRunCleanup,
          ...(resolved.executable ? { executablePath: resolved.executable } : {}),
          ...(resolved.error ? { preflightError: resolved.error } : {}),
        });
      }
      return await loadedTool.execute(toolCallId, args, signal, onUpdate);
    },
  };
}

function createBrowserToolOptions(ctx: OpenClawPluginToolContext): {
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
  agentSessionKey?: string;
  agentDir?: string;
  workspaceDir?: string;
  activeModel?: {
    provider?: string;
    model?: string;
  };
  mediaScope?: {
    sessionKey?: string;
    channel?: string;
    chatType?: string;
  };
  runToolBinding?: unknown;
} {
  const mediaChannel = ctx.deliveryContext?.channel ?? ctx.messageChannel;
  const mediaChatType = deriveChatTypeFromSessionKey(ctx.sessionKey);
  return {
    ...(ctx.browser?.sandboxBridgeUrl ? { sandboxBridgeUrl: ctx.browser.sandboxBridgeUrl } : {}),
    ...(ctx.browser?.allowHostControl !== undefined
      ? { allowHostControl: ctx.browser.allowHostControl }
      : {}),
    ...(ctx.sessionKey ? { agentSessionKey: ctx.sessionKey } : {}),
    ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
    ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
    ...(ctx.activeModel?.provider || ctx.activeModel?.modelId
      ? {
          activeModel: {
            provider: ctx.activeModel.provider,
            model: ctx.activeModel.modelId,
          },
        }
      : {}),
    ...(ctx.sessionKey || mediaChannel
      ? {
          mediaScope: {
            ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
            ...(mediaChannel ? { channel: mediaChannel } : {}),
            ...(mediaChatType ? { chatType: mediaChatType } : {}),
          },
        }
      : {}),
    ...(ctx.toolBindings && Object.hasOwn(ctx.toolBindings, "browser")
      ? { runToolBinding: ctx.toolBindings.browser }
      : {}),
  };
}

/** Browser plugin reload policy. */
export const browserPluginReload = {
  restartPrefixes: ["browser"],
  hotPrefixes: ["browser.profiles"],
};

/** Node-host command descriptors exposed by the Browser plugin. */
function createBrowserProxyNodeHostCommand(command: string): OpenClawPluginNodeHostCommand {
  return {
    command,
    cap: "browser",
    isAvailable: ({ config }) =>
      config.browser?.enabled !== false && config.nodeHost?.browserProxy?.enabled !== false,
    handle: async (paramsJSON, _io, context) => {
      const { runBrowserProxyCommand } = await loadBrowserRegistrationRuntimeModule();
      return await runBrowserProxyCommand(paramsJSON, command, context?.signal);
    },
    ...(command === BROWSER_PROXY_UPLOAD_COMMAND
      ? {
          watchAvailability: () => {
            void loadBrowserRegistrationRuntimeModule()
              .then(({ ensureBrowserProxyUploadCleanup }) => ensureBrowserProxyUploadCleanup())
              .catch((error: unknown) => {
                logger.warn(`browser proxy upload cleanup startup failed: ${String(error)}`);
              });
          },
        }
      : {}),
  };
}

export const browserPluginNodeHostCommands: OpenClawPluginNodeHostCommand[] = [
  createBrowserProxyNodeHostCommand(BROWSER_PROXY_COMMAND),
  createBrowserProxyNodeHostCommand(BROWSER_PROXY_UPLOAD_COMMAND),
];

/** Security audit collectors contributed by the Browser plugin. */
export const browserSecurityAuditCollectors: OpenClawPluginSecurityAuditCollector[] = [
  async (ctx) => {
    const { collectBrowserSecurityAuditFindings } = await loadBrowserRegistrationRuntimeModule();
    return collectBrowserSecurityAuditFindings(ctx);
  },
];

function createLazyBrowserPluginService(
  cloudLeaseStore: BrowserHarnessCloudLeaseStore,
): OpenClawPluginService {
  let service: OpenClawPluginService | null = null;
  let leaseReaperTimer: NodeJS.Timeout | undefined;
  let leaseReaperPromise: Promise<void> | undefined;
  let leaseReaperFailed = false;
  let stopping = false;
  const loadService = async () => {
    if (!service) {
      const { createBrowserPluginService, stopBrowserControlService } =
        await loadBrowserRegistrationRuntimeModule();
      service = createBrowserPluginService({ stopOnDemand: stopBrowserControlService });
    }
    return service;
  };
  const scheduleLeaseReaper = (ctx: Parameters<OpenClawPluginService["start"]>[0]) => {
    if (stopping || leaseReaperTimer) {
      return;
    }
    leaseReaperTimer = setTimeout(() => {
      leaseReaperTimer = undefined;
      void runLeaseReaper(ctx);
    }, CLOUD_LEASE_REAP_RETRY_MS);
    leaseReaperTimer.unref?.();
  };
  const runLeaseReaper = async (ctx: Parameters<OpenClawPluginService["start"]>[0]) => {
    if (leaseReaperPromise) {
      return await leaseReaperPromise;
    }
    leaseReaperPromise = (async () => {
      try {
        const { hasBrowserHarnessCloudLeases } =
          await import("./src/browser-harness-cloud-leases.js");
        if (await hasBrowserHarnessCloudLeases(cloudLeaseStore)) {
          const configuredExecutable =
            ctx.config.browser?.harness?.executablePath?.trim() || "browser-harness";
          const executable = resolveExecutablePath(configuredExecutable);
          if (!executable || !isSupportedBrowserHarness(executable)) {
            throw new Error(
              "Browser Harness 0.1.10 or newer is required to recover stale cloud leases",
            );
          }
          const { reconcileBrowserHarnessCloudLeases } =
            await import("./src/browser-harness-transport.js");
          const recovered = await reconcileBrowserHarnessCloudLeases({
            browserConfig: ctx.config.browser,
            cloudLeaseStore,
            executablePath: executable,
          });
          if (recovered > 0) {
            logger.info(`recovered ${recovered} stale Browser Harness cloud lease(s)`);
          }
        }
        if (leaseReaperFailed) {
          ctx.serviceHealth?.clearFailure();
          leaseReaperFailed = false;
        }
      } catch (error) {
        leaseReaperFailed = true;
        ctx.serviceHealth?.reportFailure(error);
        logger.warn(`Browser Harness cloud lease recovery failed: ${String(error)}`);
        scheduleLeaseReaper(ctx);
      } finally {
        leaseReaperPromise = undefined;
      }
    })();
    return await leaseReaperPromise;
  };
  return {
    id: "browser-control",
    start: async (ctx) => {
      stopping = false;
      await runLeaseReaper(ctx);
      if (!isTruthyEnvValue(process.env[EAGER_BROWSER_CONTROL_SERVICE_ENV])) {
        return;
      }
      const loaded = await loadService();
      await loaded.start(ctx);
    },
    stop: async (ctx) => {
      stopping = true;
      if (leaseReaperTimer) {
        clearTimeout(leaseReaperTimer);
        leaseReaperTimer = undefined;
      }
      await leaseReaperPromise;
      if (!service) {
        const loadedRuntime = loadBrowserRegistrationRuntimeModule.peek();
        if (!loadedRuntime) {
          return;
        }
        const { stopBrowserControlService } = await loadedRuntime;
        await stopBrowserControlService();
        return;
      }
      await service.stop?.(ctx);
    },
  };
}

/** Register Browser tool factories, CLI, gateway methods, services, and audits. */
export function registerBrowserPlugin(api: OpenClawPluginApi) {
  initializeBrowserSessionTabStore(api.runtime);
  const cloudLeaseStore = openBrowserHarnessCloudLeaseStore((options) =>
    api.runtime.state.openKeyedStore(options),
  );
  configureSystemProfileImportStateStore(
    api.runtime.state.openKeyedStore<SystemProfileImportState>({
      namespace: "browser.system-profile-import",
      maxEntries: 1,
    }),
  );
  api.registerTool(((ctx: OpenClawPluginToolContext) => {
    const config = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
    const nativeTool = createLazyBrowserTool(createBrowserToolOptions(ctx), config);
    const harnessTool = createLazyBrowserHarnessTool(ctx, cloudLeaseStore);
    return harnessTool ? [nativeTool, harnessTool] : nativeTool;
  }) as OpenClawPluginToolFactory);
  api.registerCli(
    async ({ program }) => {
      const { registerBrowserCli } = await import("./src/cli/browser-cli.js");
      registerBrowserCli(program, process.argv, api.rootDir);
    },
    { commands: ["browser"], descriptors: [BROWSER_CLI_DESCRIPTOR] },
  );
  api.registerGatewayMethod(
    BROWSER_REQUEST_GATEWAY_METHOD,
    async (opts) => {
      const { handleBrowserGatewayRequest } = await loadBrowserRegistrationRuntimeModule();
      return await handleBrowserGatewayRequest(opts);
    },
    {
      scope: BROWSER_REQUEST_GATEWAY_SCOPE,
    },
  );
  // Remote extension relay: lets the Chrome extension connect directly to this
  // gateway over wss:// (no node host on the browser machine). auth:"plugin"
  // with no nodeCapability means the gateway does not pre-enforce token auth;
  // the handler self-validates the host-local relay secret. Path kept in sync
  // with GATEWAY_EXTENSION_RELAY_PATH (hardcoded here to stay lazy).
  api.registerHttpRoute({
    path: "/browser/extension",
    auth: "plugin",
    match: "exact",
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(426, { "Content-Type": "text/plain" });
      res.end("Upgrade Required: connect the OpenClaw Chrome extension over WebSocket.");
    },
    handleUpgrade: async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      // Direct relay activity prepares the teardown module consumed by lazy service shutdown.
      await loadBrowserRegistrationRuntimeModule();
      const { handleGatewayExtensionUpgrade } =
        await import("./src/browser/extension-relay/gateway-relay-route.js");
      return await handleGatewayExtensionUpgrade(req, socket, head);
    },
  });
  api.registerService(createLazyBrowserPluginService(cloudLeaseStore));
}
