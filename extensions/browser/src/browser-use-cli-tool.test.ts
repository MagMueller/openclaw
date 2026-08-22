import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../test-support.js";
import {
  createBrowserUseCliTool,
  prepareBrowserUseCliRuntime,
  type BrowserUseCliRuntime,
} from "./browser-use-cli-tool.js";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2f7z8AAAAASUVORK5CYII=",
  "base64",
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createFixture() {
  const workspaceDir = tempDirs.make("oc-bu-cli-test-");
  const runtime: BrowserUseCliRuntime = {
    executable: "/trusted/bin/browser-harness",
    pathEnv: "/trusted/bin:/usr/bin",
    lang: "C.UTF-8",
    runtimeDir: "/tmp/browser-harness-runtime",
    daemonName: "eval_browser",
  };
  const runCommand = vi.fn(async (_argv: string[], options: { input?: string }) => {
    const code = options.input ?? "";
    const screenshotPath = /capture_screenshot\(("[^"]+")/.exec(code)?.[1];
    if (screenshotPath) {
      await fs.writeFile(JSON.parse(screenshotPath) as string, tinyPng);
    }
    return {
      stdout: "ok",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
    };
  });
  const tool = createBrowserUseCliTool({
    runtime,
    workspaceDir,
    runCommand: runCommand as never,
  });
  return { runCommand, runtime, tool, workspaceDir };
}

describe("Browser Use CLI tool", () => {
  it("uses Laith-compatible actions with a policy-bound clean environment", async () => {
    const { runCommand, runtime, tool, workspaceDir } = await createFixture();

    expect(tool.name).toBe("browser");
    expect(tool.description).toContain("Browser Use CLI 3.0");
    expect(tool.description).toContain("screenshot first to see the page");
    const result = await tool.execute("open-1", {
      action: "open",
      url: "https://example.com/?q='quoted'",
    });

    expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
    expect(result.details).toMatchObject({ action: "open", status: "completed", exitCode: 0 });
    const [argv, options] = runCommand.mock.calls[0] as unknown as [
      string[],
      { cwd?: string; input?: string; baseEnv?: NodeJS.ProcessEnv; env?: NodeJS.ProcessEnv },
    ];
    expect(argv).toEqual([runtime.executable]);
    expect(options.cwd).toBe(workspaceDir);
    expect(options.baseEnv).toEqual({});
    expect(options.input).toContain("new_tab(");
    expect(options.env).toMatchObject({
      BH_REQUIRE_EXISTING_DAEMON: "1",
      BH_TELEMETRY: "0",
      BH_RUNTIME_DIR: runtime.runtimeDir,
      BU_NAME: runtime.daemonName,
    });
    expect(options.env).not.toHaveProperty("BROWSER_USE_API_KEY");
  });

  it.each(["status", "start"] as const)(
    "validates Browser Harness and the daemon before reporting %s ready",
    async (action) => {
      const { runCommand, tool } = await createFixture();

      await expect(tool.execute(`${action}-1`, { action })).resolves.toMatchObject({
        details: { action, orchestratorOwned: true },
      });
      const options = runCommand.mock.calls[0]?.[1] as unknown as { input?: string };
      expect(options.input).toBe("list_tabs()\n");
    },
  );

  it("returns a failed daemon probe and reports ready only after recovery", async () => {
    const { runCommand, tool } = await createFixture();
    runCommand.mockResolvedValueOnce({
      stdout: "probe failed",
      stderr: "sensitive diagnostic",
      code: 1,
      signal: null,
      killed: false,
      termination: "exit",
    });

    const failed = await tool.execute("status-failed", { action: "status" });
    expect(failed).toMatchObject({
      content: [{ type: "text", text: "probe failed\nsensitive diagnostic" }],
      details: { action: "status", status: "failed", exitCode: 1 },
    });
    await expect(tool.execute("status-recovered", { action: "status" })).resolves.toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringContaining("Browser Use Cloud is ready"),
        },
      ],
      details: { action: "status", orchestratorOwned: true },
    });
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

  it("pins a supported executable and requires a live daemon before replacement", async () => {
    const workspaceDir = tempDirs.make("oc-bu-cli-preflight-");
    const binDir = path.join(workspaceDir, "bin");
    const readyPath = path.join(workspaceDir, "ready");
    const executable = path.join(binDir, "browser-harness");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(
      executable,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '0.1.10\\n'; exit 0; fi\n[ -f ${JSON.stringify(readyPath)} ] || exit 9\ninput=$(cat)\n[ "$input" = "list_tabs()" ]\n`,
      { mode: 0o755 },
    );
    const env = {
      PATH: `${binDir}:/usr/bin:/bin`,
      BH_RUNTIME_DIR: path.join(workspaceDir, "runtime"),
      BU_NAME: "eval_browser",
    };

    expect(prepareBrowserUseCliRuntime({ workspaceDir, env })).toBeUndefined();
    await fs.writeFile(readyPath, "ready");
    expect(prepareBrowserUseCliRuntime({ workspaceDir, env })).toMatchObject({
      executable: await fs.realpath(executable),
      runtimeDir: env.BH_RUNTIME_DIR,
      daemonName: env.BU_NAME,
    });
  });

  it("fails preflight for invalid daemon identity and old Browser Harness", async () => {
    const workspaceDir = tempDirs.make("oc-bu-cli-version-");
    const binDir = path.join(workspaceDir, "bin");
    const executable = path.join(binDir, "browser-harness");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(executable, "#!/bin/sh\nprintf '0.1.9\\n'\n", { mode: 0o755 });

    expect(
      prepareBrowserUseCliRuntime({
        workspaceDir,
        env: { PATH: `${binDir}:/usr/bin:/bin`, BH_RUNTIME_DIR: "relative", BU_NAME: "bad name" },
      }),
    ).toBeUndefined();
    expect(
      prepareBrowserUseCliRuntime({
        workspaceDir,
        env: {
          PATH: `${binDir}:/usr/bin:/bin`,
          BH_RUNTIME_DIR: path.join(workspaceDir, "runtime"),
          BU_NAME: "eval_browser",
        },
      }),
    ).toBeUndefined();
  });
});
