import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../test-support.js";
import { createBrowserUseCliTool } from "./browser-use-cli-tool.js";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2f7z8AAAAASUVORK5CYII=",
  "base64",
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createFixture() {
  const workspaceDir = tempDirs.make("oc-bu-cli-test-");
  const cleanups: Array<(reason: string) => Promise<void>> = [];
  const execute = vi.fn(async (_id: string, params: unknown) => {
    const command = (params as { command: string }).command;
    const screenshotPath = /capture_screenshot\(("[^"]+")/.exec(command)?.[1];
    if (screenshotPath) {
      await fs.writeFile(JSON.parse(screenshotPath) as string, tinyPng);
    }
    return {
      content: [{ type: "text" as const, text: "ok" }],
      details: { status: "completed", exitCode: 0, secret: "must-not-leak" },
    };
  });
  const tool = createBrowserUseCliTool({
    exec: { execute: execute as never },
    workspaceDir,
    registerRunCleanup: (cleanup) => cleanups.push(cleanup),
    env: {
      PATH: "/trusted/bin:/usr/bin",
      BH_RUNTIME_DIR: "/tmp/browser-harness-runtime",
      BU_NAME: "eval_browser",
      BROWSER_USE_API_KEY: "must-not-reach-model-exec",
    },
  });
  return { cleanups, execute, tool, workspaceDir };
}

describe("Browser Use CLI tool", () => {
  it("uses Laith-compatible actions with a policy-bound clean environment", async () => {
    const { cleanups, execute, tool, workspaceDir } = await createFixture();

    expect(tool.name).toBe("browser");
    expect(tool.description).toContain("Browser Use CLI 3.0");
    const result = await tool.execute("open-1", {
      action: "open",
      url: "https://example.com/?q='quoted'",
    });

    expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
    expect(result.details).toEqual({ action: "open", status: "completed", exitCode: 0 });
    const params = execute.mock.calls[0]?.[1] as { command?: string; workdir?: string };
    expect(params.workdir).toBe(workspaceDir);
    expect(params.command).toContain("env -i");
    expect(params.command).toContain("BH_REQUIRE_EXISTING_DAEMON='1'");
    expect(params.command).toContain("BH_TELEMETRY='0'");
    expect(params.command).not.toContain("BROWSER_USE_API_KEY");
    expect(params.command).toContain("new_tab(");
    expect(cleanups).toHaveLength(1);
    await cleanups[0]!("test");
  });

  it("returns a retained PNG for the screenshot action", async () => {
    const { tool, workspaceDir } = await createFixture();

    const result = await tool.execute("shot-1", { action: "screenshot", fullPage: true });

    expect(result.content.some((block) => block.type === "image")).toBe(true);
    const files = await fs.readdir(path.join(workspaceDir, ".openclaw", "browser"));
    expect(files).toHaveLength(1);
    await expect(
      fs.readFile(path.join(workspaceDir, ".openclaw", "browser", files[0]!)),
    ).resolves.toEqual(tinyPng);
  });

  it("fails closed without an exact orchestrator daemon identity", async () => {
    const workspaceDir = tempDirs.make("oc-bu-cli-invalid-");
    const tool = createBrowserUseCliTool({
      exec: { execute: vi.fn() as never },
      workspaceDir,
      registerRunCleanup: vi.fn(),
      env: { BH_RUNTIME_DIR: "relative", BU_NAME: "bad name" },
    });

    await expect(
      tool.execute("open-1", { action: "open", url: "https://example.com" }),
    ).rejects.toThrow(/absolute BH_RUNTIME_DIR and a valid BU_NAME/);
  });
});
