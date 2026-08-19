import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBrowserPlugin } from "../../extensions/browser/plugin-registration.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRecord } from "../plugins/registry-types.js";
import { getPluginToolMeta, resolvePluginTools } from "../plugins/tools.js";
import { selectBrowserModelTool } from "./browser-model-tool-selection.js";
import {
  getPreparedPluginRuntimeLoadContext,
  prepareOwnedPluginLoadContext,
} from "./prepared-model-runtime.plugin-context.js";
import { applyToolPolicyPipeline } from "./tool-policy-pipeline.js";
import type { AnyAgentTool } from "./tools/common.js";

function execTool(): AnyAgentTool {
  return {
    name: "exec",
    label: "exec",
    description: "exec",
    parameters: Type.Object({}),
    execute: vi.fn(async () => ({ content: [], details: {} })),
  };
}

function schemaDeclaresProperty(schema: unknown, property: string): boolean {
  if (!schema || typeof schema !== "object") {
    return false;
  }
  const record = schema as Record<string, unknown>;
  if (
    record.properties &&
    typeof record.properties === "object" &&
    Object.hasOwn(record.properties, property)
  ) {
    return true;
  }
  return Object.values(record).some((value) =>
    Array.isArray(value)
      ? value.some((entry) => schemaDeclaresProperty(entry, property))
      : schemaDeclaresProperty(value, property),
  );
}

describe("Browser Harness assembled registry surface", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "crosses actual plugin registration, policy expansion, and final engine selection",
    () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bh-assembly-"));
      tempDirs.push(tempDir);
      const executable = path.join(tempDir, "browser-harness");
      const probeMarker = path.join(tempDir, "version-probed");
      fs.writeFileSync(
        executable,
        `#!/bin/sh\nprintf '%s\\n' 'browser-harness 0.1.10'\ntouch '${probeMarker}'\n`,
        { mode: 0o755 },
      );
      let factory: OpenClawPluginToolFactory | undefined;
      const openKeyedStore = vi.fn(() => ({
        register: vi.fn(async () => undefined),
        registerIfAbsent: vi.fn(async () => true),
        lookup: vi.fn(async () => undefined),
        consume: vi.fn(async () => undefined),
        delete: vi.fn(async () => false),
        entries: vi.fn(async () => []),
        clear: vi.fn(async () => undefined),
      }));
      const openSyncKeyedStore = vi.fn(() => ({
        register: vi.fn(),
        registerIfAbsent: vi.fn(() => true),
        lookup: vi.fn(() => undefined),
        consume: vi.fn(() => undefined),
        delete: vi.fn(() => false),
        entries: vi.fn(() => []),
        clear: vi.fn(),
      }));
      registerBrowserPlugin(
        createTestPluginApi({
          id: "browser",
          name: "Browser",
          source: "test",
          rootDir: path.resolve("extensions/browser"),
          runtime: {
            state: { openKeyedStore, openSyncKeyedStore },
          } as unknown as OpenClawPluginApi["runtime"],
          registerTool: (tool) => {
            factory = tool as OpenClawPluginToolFactory;
          },
        }),
      );
      if (!factory) {
        throw new Error("browser plugin did not register its tool factory");
      }
      const config = {
        browser: {
          enabled: true,
          modelEngine: "auto",
          harness: { executablePath: executable },
        },
        plugins: { allow: ["browser"], entries: { browser: { enabled: true } } },
      } as OpenClawConfig;
      const registry = createEmptyPluginRegistry();
      registry.plugins.push({
        id: "browser",
        name: "Browser",
        source: "test",
        origin: "bundled",
        enabled: true,
        status: "loaded",
        format: "bundle",
        imported: true,
      } as PluginRecord);
      registry.tools.push({
        pluginId: "browser",
        pluginName: "Browser",
        factory,
        names: ["browser", "browser_exec"],
        declaredNames: ["browser", "browser_exec"],
        optional: false,
        origin: "bundled",
        source: "test",
      });
      const metadataSnapshot = createPluginMetadataSnapshot({
        config,
        manifestRegistry: makeRegistry([
          {
            id: "browser",
            channels: [],
            origin: "bundled",
            contracts: { tools: ["browser", "browser_exec"] },
          },
        ]),
        workspaceDir: tempDir,
      });
      const env = { ...process.env, VITEST: "true" };
      prepareOwnedPluginLoadContext(
        { agentDir: tempDir, config, workspaceDir: tempDir },
        env,
        registry,
        metadataSnapshot,
      );
      const loadContext = getPreparedPluginRuntimeLoadContext(registry);
      if (!loadContext) {
        throw new Error("browser plugin runtime context was not prepared");
      }
      const toolContext = {
        config,
        runtimeConfig: config,
        workspaceDir: tempDir,
        sessionId: "browser-harness-assembly",
        oneShotCliRun: true,
        registerRunCleanup: vi.fn(),
        browser: {
          allowHostControl: true,
          harnessExec: { execute: vi.fn() },
        },
      };
      const pluginTools = resolvePluginTools({
        context: toolContext,
        env,
        toolAllowlist: ["browser"],
        preparedRuntime: { loadContext, metadataSnapshot, registry },
      });
      const repeatedPluginTools = resolvePluginTools({
        context: toolContext,
        env,
        toolAllowlist: ["browser"],
        preparedRuntime: { loadContext, metadataSnapshot, registry },
      });
      expect(
        repeatedPluginTools.find((tool) => tool.name === "browser_exec")?.selectionPreflight,
      ).toBeTypeOf("function");
      expect(fs.existsSync(probeMarker)).toBe(false);
      const filtered = applyToolPolicyPipeline({
        tools: [...pluginTools, execTool()],
        toolMeta: (tool) => getPluginToolMeta(tool),
        warn: vi.fn(),
        steps: [{ label: "assembled profile", policy: { allow: ["browser", "exec"] } }],
      });
      expect(fs.existsSync(probeMarker)).toBe(false);
      const selected = selectBrowserModelTool({
        tools: filtered,
        preferHarness: true,
        sandboxed: false,
      });
      expect(fs.existsSync(probeMarker)).toBe(true);

      const browserTools = selected.filter((tool) => tool.name === "browser");
      expect(browserTools).toHaveLength(1);
      expect(selected.some((tool) => tool.name === "browser_exec")).toBe(false);
      expect(selected.some((tool) => tool.name === "exec")).toBe(true);
      expect(schemaDeclaresProperty(browserTools[0]?.parameters, "code")).toBe(true);
      expect(schemaDeclaresProperty(browserTools[0]?.parameters, "action")).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not probe an external Harness executable when final browser policy denied it",
    () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bh-denied-"));
      tempDirs.push(tempDir);
      const executable = path.join(tempDir, "browser-harness");
      const probeMarker = path.join(tempDir, "version-probed");
      fs.writeFileSync(
        executable,
        `#!/bin/sh\nprintf '%s\\n' 'browser-harness 0.1.10'\ntouch '${probeMarker}'\n`,
        { mode: 0o755 },
      );
      let factory: OpenClawPluginToolFactory | undefined;
      registerBrowserPlugin(
        createTestPluginApi({
          id: "browser",
          name: "Browser",
          source: "test",
          rootDir: path.resolve("extensions/browser"),
          runtime: {
            state: {
              openKeyedStore: vi.fn(() => ({
                register: vi.fn(),
                registerIfAbsent: vi.fn(() => true),
                lookup: vi.fn(),
                consume: vi.fn(),
                delete: vi.fn(() => false),
                entries: vi.fn(() => []),
                clear: vi.fn(),
              })),
              openSyncKeyedStore: vi.fn(() => ({
                register: vi.fn(),
                registerIfAbsent: vi.fn(() => true),
                lookup: vi.fn(),
                consume: vi.fn(),
                delete: vi.fn(() => false),
                entries: vi.fn(() => []),
                clear: vi.fn(),
              })),
            },
          } as unknown as OpenClawPluginApi["runtime"],
          registerTool: (tool) => {
            factory = tool as OpenClawPluginToolFactory;
          },
        }),
      );
      const candidates = factory?.({
        config: {
          browser: { modelEngine: "auto", harness: { executablePath: executable } },
        },
        sessionId: "denied-browser",
        workspaceDir: tempDir,
        browser: { harnessExec: { execute: vi.fn() } },
      });
      if (!Array.isArray(candidates)) {
        throw new Error("expected native and Harness browser candidates");
      }
      const filtered = candidates.filter((candidate) => candidate.name !== "browser");
      const selected = selectBrowserModelTool({
        tools: [...filtered, execTool()],
        preferHarness: true,
        sandboxed: false,
      });

      expect(selected.some((candidate) => candidate.name === "browser")).toBe(false);
      expect(fs.existsSync(probeMarker)).toBe(false);
    },
  );
});
