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

import type { BrowserHarnessCloudLeaseStore } from "./browser-harness-cloud-leases.js";
import { createBrowserHarnessTool } from "./browser-harness-tool.js";
import { BrowserHarnessToolSchema } from "./browser-harness-tool.schema.js";

const cloudLeaseStore = {} as BrowserHarnessCloudLeaseStore;

describe("createBrowserHarnessTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
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
      cloudLeaseStore,
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
    const execArgs = (execute.mock.calls[0] as unknown[] | undefined)?.[1] as
      | { command: string; env?: Record<string, string> }
      | undefined;
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

  it("reuses a trusted orchestrator Cloud binding when target is omitted", async () => {
    vi.stubEnv("BH_ORCHESTRATOR_EXISTING_DAEMON", "1");
    const execute = vi.fn(async () => ({ content: [], details: { status: "completed" } }));
    const tool = createBrowserHarnessTool({
      exec: { execute },
      cloudLeaseStore,
      getBrowserConfig: () => ({ harness: { defaultTarget: "chrome" } }),
      sessionId: "session-orchestrated",
      workspaceDir: "/workspace",
    });

    await tool.execute("call-default", { code: "print(page_info())" });
    await tool.execute("call-explicit-cloud", {
      code: "print(page_info())",
      target: "cloud",
    });

    expect(transportMocks.prepare).toHaveBeenCalledOnce();
    expect(transportMocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ target: "cloud" }),
    );
    expect(tool.description).toContain("already bound to the orchestrator-owned Browser Use Cloud");
  });

  it("honors an explicit target over a trusted orchestrator Cloud binding", async () => {
    vi.stubEnv("BH_ORCHESTRATOR_EXISTING_DAEMON", "1");
    const execute = vi.fn(async () => ({ content: [], details: { status: "completed" } }));
    const tool = createBrowserHarnessTool({
      exec: { execute },
      cloudLeaseStore,
      getBrowserConfig: () => ({}),
      sessionId: "session-explicit-target",
      workspaceDir: "/workspace",
    });

    await tool.execute("call-explicit", {
      code: "print(page_info())",
      target: "chrome",
    });

    expect(transportMocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ target: "chrome" }),
    );
  });

  it.each([
    {
      target: "cloud" as const,
      expected: "run-scoped Browser Use Cloud browser",
    },
    {
      target: "profile" as const,
      expected: "configured OpenClaw CDP profile",
    },
  ])("describes a configured $target default without claiming an orchestrator binding", (test) => {
    const tool = createBrowserHarnessTool({
      exec: { execute: vi.fn() },
      cloudLeaseStore,
      getBrowserConfig: () => ({ harness: { defaultTarget: test.target } }),
      sessionId: `session-described-${test.target}`,
      workspaceDir: "/workspace",
    });

    expect(tool.description).toContain(test.expected);
    expect(tool.description).not.toContain("orchestrator-owned");
  });

  it("defangs media directives and caps browser-controlled output", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: `MEDIA:/tmp/leak.png\n${"x".repeat(200_000)}` }],
      details: { status: "completed", exitCode: 0, durationMs: 12, aggregated: "secret copy" },
    }));
    const tool = createBrowserHarnessTool({
      exec: { execute },
      cloudLeaseStore,
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

  it("turns generic exec outcomes into actionable browser feedback", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        content: [{ type: "text" as const, text: "(no output)" }],
        details: { status: "completed", exitCode: 0 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text" as const, text: "Traceback: failed" }],
        details: { status: "completed", exitCode: 1 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text" as const, text: "Command timed out." }],
        details: { status: "failed", timedOut: true },
      });
    const tool = createBrowserHarnessTool({
      exec: { execute },
      cloudLeaseStore,
      getBrowserConfig: () => ({}),
      sessionId: "session-feedback",
      workspaceDir: "/workspace",
    });

    const noOutput = await tool.execute("call-no-output", { code: "page_info()" });
    const failed = await tool.execute("call-failed", { code: "raise RuntimeError()" });
    const timedOut = await tool.execute("call-timeout", { code: "wait_for_load()" });

    expect(noOutput.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("Use print(...)") }),
    ]);
    expect(failed.content[0]).toMatchObject({
      text: expect.stringContaining("Browser program failed with exit code 1"),
    });
    expect(failed.content[1]).toMatchObject({
      text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
    });
    expect(timedOut.content[0]).toMatchObject({
      text: expect.stringContaining("Browser program timed out"),
    });
  });

  it("cleans up a one-shot cloud browser after execution", async () => {
    const execute = vi.fn(async () => ({ content: [], details: { status: "completed" } }));
    const tool = createBrowserHarnessTool({
      exec: { execute },
      cloudLeaseStore,
      getBrowserConfig: () => ({ harness: { defaultTarget: "cloud" } }),
      sessionId: "session-2",
      workspaceDir: "/workspace",
      oneShotCliRun: true,
      ephemeralRunState: true,
    });

    await tool.execute("call-2", { code: "print(page_info())" });

    expect(transportMocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ allowCloudProvisioning: false, target: "cloud" }),
    );
    expect(transportMocks.cleanup).toHaveBeenCalledOnce();
  });

  it("keeps one browser for the full agent run when a cleanup owner exists", async () => {
    const execute = vi.fn(async () => ({ content: [], details: { status: "completed" } }));
    let runCleanup: ((reason: string) => Promise<void>) | undefined;
    const tool = createBrowserHarnessTool({
      exec: { execute },
      cloudLeaseStore,
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
    expect(transportMocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ allowCloudProvisioning: true, target: "cloud" }),
    );
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
      cloudLeaseStore,
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

  it("preserves successful browser output when the optional screenshot fails", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-browser-harness-test-"));
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "primary observation" }],
      details: { status: "completed", exitCode: 0 },
    }));
    transportMocks.screenshot.mockRejectedValueOnce(
      new Error("sensitive-cdp-endpoint screenshot timeout"),
    );
    const tool = createBrowserHarnessTool({
      exec: { execute },
      cloudLeaseStore,
      getBrowserConfig: () => ({}),
      sessionId: "session-shot-failure",
      workspaceDir,
      oneShotCliRun: true,
    });

    try {
      const result = await tool.execute("call-shot-failure", {
        code: 'print("primary observation")',
        screenshot: true,
      });
      const serialized = JSON.stringify(result);

      expect(serialized).toContain("primary observation");
      expect(serialized).toContain("post-program screenshot failed");
      expect(serialized).not.toContain("sensitive-cdp-endpoint");
      expect(result.details).toMatchObject({ screenshot: { status: "failed" } });
      expect(transportMocks.cleanup).toHaveBeenCalledOnce();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("preserves cancellation identity when screenshot capture fails", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-browser-harness-test-"));
    const cancellation = new Error("cancelled by caller");
    const controller = new AbortController();
    controller.abort(cancellation);
    transportMocks.screenshot.mockRejectedValueOnce(new Error("sensitive screenshot error"));
    const tool = createBrowserHarnessTool({
      exec: {
        execute: vi.fn(async () => ({
          content: [{ type: "text" as const, text: "primary observation" }],
          details: { status: "completed" },
        })),
      },
      cloudLeaseStore,
      getBrowserConfig: () => ({}),
      sessionId: "session-shot-cancel",
      workspaceDir,
    });

    try {
      await expect(
        tool.execute(
          "call-shot-cancel",
          { code: 'print("primary observation")', screenshot: true },
          controller.signal,
        ),
      ).rejects.toBe(cancellation);
      expect(transportMocks.cleanup).toHaveBeenCalledOnce();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("restarts the runtime when an explicit OpenClaw profile changes", async () => {
    const execute = vi.fn(async () => ({ content: [], details: { status: "completed" } }));
    transportMocks.prepare
      .mockResolvedValueOnce({
        executable: "browser-harness",
        env: {
          BH_RUNTIME_DIR: "/tmp/oc-bh/run",
          BH_TMP_DIR: "/tmp/oc-bh/tmp",
          BU_NAME: "oc_session",
          BH_TELEMETRY: "0",
          BROWSER_HARNESS_TELEMETRY: "0",
          ANONYMIZED_TELEMETRY: "0",
        },
        name: "oc_session",
        target: "profile",
        profile: "work",
        cleanup: transportMocks.cleanup,
      } as Awaited<ReturnType<typeof transportMocks.prepare>> & { profile: string })
      .mockResolvedValueOnce({
        executable: "browser-harness",
        env: {
          BH_RUNTIME_DIR: "/tmp/oc-bh/run",
          BH_TMP_DIR: "/tmp/oc-bh/tmp",
          BU_NAME: "oc_session",
          BH_TELEMETRY: "0",
          BROWSER_HARNESS_TELEMETRY: "0",
          ANONYMIZED_TELEMETRY: "0",
        },
        name: "oc_session",
        target: "profile",
        profile: "remote",
        cleanup: transportMocks.cleanup,
      } as Awaited<ReturnType<typeof transportMocks.prepare>> & { profile: string });
    const tool = createBrowserHarnessTool({
      exec: { execute },
      cloudLeaseStore,
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
      cloudLeaseStore,
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
      cloudLeaseStore,
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
