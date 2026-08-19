import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transportMocks = vi.hoisted(() => ({
  screenshot: vi.fn(async (params: { path: string }) => {
    await writeFile(params.path, Buffer.from("png"));
  }),
  cleanup: vi.fn(async () => {}),
  prepare: vi.fn(async (params: { target: "chrome" | "cloud" | "profile" }) => ({
    executable: "/opt/browser harness/bin/browser-harness",
    env: {
      BH_RUNTIME_DIR: "/tmp/oc-bh/run",
      BH_TMP_DIR: "/tmp/oc-bh/tmp",
      BU_NAME: "oc_session",
      BH_TELEMETRY: "0",
      BROWSER_HARNESS_TELEMETRY: "0",
      ANONYMIZED_TELEMETRY: "0",
    },
    name: "oc_session",
    target: params.target,
    cleanup: transportMocks.cleanup,
  })),
}));

vi.mock("./browser-harness-transport.js", () => ({
  captureBrowserHarnessScreenshot: transportMocks.screenshot,
  prepareBrowserHarnessRuntime: transportMocks.prepare,
}));

const setupToolMocks = vi.hoisted(() => ({
  imageResultFromFile: vi.fn(async () => ({
    content: [{ type: "image" as const, data: "image-data", mimeType: "image/png" }],
    details: { path: "/workspace/.openclaw/browser/screenshot.png" },
  })),
}));

vi.mock("./sdk-setup-tools.js", () => setupToolMocks);

import { createBrowserHarnessTool } from "./browser-harness-tool.js";
import { BrowserHarnessToolSchema } from "./browser-harness-tool.schema.js";

describe("createBrowserHarnessTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits a provider-safe flat target enum", () => {
    const serialized = JSON.stringify(BrowserHarnessToolSchema);
    expect(serialized).not.toContain('"anyOf"');
    expect(serialized).toContain('"enum":["chrome","cloud","profile"]');
  });

  it("runs exact model Python through the approved exec broker with no browser credential", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "done" }],
      details: { status: "completed", aggregated: "done" },
    }));
    const tool = createBrowserHarnessTool({
      exec: { execute },
      getBrowserConfig: () => ({ harness: { defaultTarget: "chrome" } }),
      sessionId: "session-1",
      workspaceDir: "/workspace",
    });

    const result = await tool.execute("call-1", { code: "print(page_info())" });

    expect(transportMocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "chrome",
        sessionId: expect.stringMatching(/^session-1:/),
      }),
    );
    const execArgs = execute.mock.calls[0]?.[1];
    expect(execArgs).toMatchObject({
      host: "gateway",
      background: false,
      workdir: "/workspace",
      env: expect.objectContaining({
        BH_TELEMETRY: "0",
        BROWSER_HARNESS_TELEMETRY: "0",
        ANONYMIZED_TELEMETRY: "0",
      }),
    });
    expect(execArgs?.command).toContain("print(page_info())");
    expect(execArgs?.command).toContain("printf '%s\\n'");
    expect(execArgs?.command).not.toContain("<<");
    expect(JSON.stringify(execArgs?.env)).not.toMatch(/CDP|API_KEY|TOKEN/);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
    });
    expect(result.details).toEqual({ status: "completed" });
    expect(JSON.stringify(result.details)).not.toContain("aggregated");
  });

  it("defangs media directives and caps browser-controlled output", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: `MEDIA:/tmp/leak.png\n${"x".repeat(200_000)}` }],
      details: { status: "completed", exitCode: 0, durationMs: 12, aggregated: "secret copy" },
    }));
    const tool = createBrowserHarnessTool({
      exec: { execute },
      getBrowserConfig: () => ({}),
      sessionId: "session-output",
      workspaceDir: "/workspace",
    });

    const result = await tool.execute("call-output", { code: "print(page_info())" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(text).not.toContain("\nMEDIA:");
    expect(text).toContain("[truncated");
    expect(text.length).toBeLessThanOrEqual(64_000);
    expect(result.details).toEqual({ status: "completed", exitCode: 0, durationMs: 12 });
  });

  it("cleans up a one-shot cloud browser after execution", async () => {
    const execute = vi.fn(async () => ({ content: [], details: { status: "completed" } }));
    const tool = createBrowserHarnessTool({
      exec: { execute },
      getBrowserConfig: () => ({ harness: { defaultTarget: "cloud" } }),
      sessionId: "session-2",
      workspaceDir: "/workspace",
      oneShotCliRun: true,
    });

    await tool.execute("call-2", { code: "print(page_info())" });

    expect(transportMocks.cleanup).toHaveBeenCalledOnce();
  });

  it("keeps one browser for the full agent run when a cleanup owner exists", async () => {
    const execute = vi.fn(async () => ({ content: [], details: { status: "completed" } }));
    let runCleanup: ((reason: string) => Promise<void>) | undefined;
    const tool = createBrowserHarnessTool({
      exec: { execute },
      getBrowserConfig: () => ({ harness: { defaultTarget: "cloud" } }),
      sessionId: "session-run-owned",
      workspaceDir: "/workspace",
      oneShotCliRun: true,
      registerRunCleanup: (cleanup) => {
        runCleanup = cleanup;
      },
    });

    await tool.execute("call-a", { code: "print(page_info())" });
    await tool.execute("call-b", { code: "print(page_info())" });

    expect(transportMocks.prepare).toHaveBeenCalledOnce();
    expect(transportMocks.cleanup).not.toHaveBeenCalled();
    await runCleanup?.("completion");
    expect(transportMocks.cleanup).toHaveBeenCalledOnce();
  });

  it("can return a post-program screenshot as a vision observation", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-browser-harness-test-"));
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "acted" }],
      details: { status: "completed" },
    }));
    const tool = createBrowserHarnessTool({
      exec: { execute },
      getBrowserConfig: () => ({}),
      sessionId: "session-shot",
      workspaceDir,
    });

    try {
      const result = await tool.execute("call-shot", {
        code: "print(page_info())",
        screenshot: true,
        fullPage: true,
      });

      expect(transportMocks.screenshot).toHaveBeenCalledWith(
        expect.objectContaining({ fullPage: true, path: expect.stringMatching(/\.png\.part$/) }),
      );
      expect(result.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "image", mimeType: "image/png" })]),
      );
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("restarts the runtime when an explicit OpenClaw profile changes", async () => {
    const execute = vi.fn(async () => ({ content: [], details: { status: "completed" } }));
    transportMocks.prepare
      .mockResolvedValueOnce({
        executable: "browser-harness",
        env: {},
        name: "oc_session",
        target: "profile",
        profile: "work",
        cleanup: transportMocks.cleanup,
      })
      .mockResolvedValueOnce({
        executable: "browser-harness",
        env: {},
        name: "oc_session",
        target: "profile",
        profile: "remote",
        cleanup: transportMocks.cleanup,
      });
    const tool = createBrowserHarnessTool({
      exec: { execute },
      getBrowserConfig: () => ({}),
      sessionId: "session-profile",
      workspaceDir: "/workspace",
    });

    await tool.execute("call-work", {
      code: "print(page_info())",
      target: "profile",
      profile: "work",
    });
    await tool.execute("call-remote", {
      code: "print(page_info())",
      target: "profile",
      profile: "remote",
    });

    expect(transportMocks.prepare).toHaveBeenCalledTimes(2);
    expect(transportMocks.cleanup).toHaveBeenCalledOnce();
  });

  it("fails closed when sandbox policy blocks host browser control", async () => {
    const tool = createBrowserHarnessTool({
      exec: { execute: vi.fn() },
      getBrowserConfig: () => ({}),
      sessionId: "session-3",
      workspaceDir: "/workspace",
      allowHostControl: false,
    });

    await expect(tool.execute("call-3", { code: "print(page_info())" })).rejects.toThrow(
      "disabled by sandbox policy",
    );
    expect(transportMocks.prepare).not.toHaveBeenCalled();
  });

  it("fails closed when browser control is disabled", async () => {
    const tool = createBrowserHarnessTool({
      exec: { execute: vi.fn() },
      getBrowserConfig: () => ({ enabled: false }),
      sessionId: "session-disabled",
      workspaceDir: "/workspace",
    });

    await expect(tool.execute("call-disabled", { code: "print(page_info())" })).rejects.toThrow(
      "browser.enabled=false",
    );
    expect(transportMocks.prepare).not.toHaveBeenCalled();
  });
});
