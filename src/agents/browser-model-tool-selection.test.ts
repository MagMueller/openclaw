import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { selectBrowserModelTool } from "./browser-model-tool-selection.js";
import type { AnyAgentTool } from "./tools/common.js";

function tool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: vi.fn(async () => ({ content: [], details: {} })),
  };
}

describe("selectBrowserModelTool", () => {
  it("makes Browser Harness the browser tool when exec survived policy", () => {
    const native = tool("browser");
    const harness = tool("browser_exec");
    const selected = selectBrowserModelTool({
      tools: [native, harness, tool("exec")],
      preferHarness: true,
      sandboxed: false,
    });

    expect(selected.map((candidate) => candidate.name)).toEqual(["browser", "exec"]);
    expect(selected[0]).toBe(harness);
  });

  it.each([
    { label: "exec denied", tools: [tool("browser"), tool("browser_exec")], sandboxed: false },
    {
      label: "sandboxed",
      tools: [tool("browser"), tool("browser_exec"), tool("exec")],
      sandboxed: true,
    },
  ])("keeps native browser when $label without probing Harness", ({ tools, sandboxed }) => {
    const native = tools[0];
    const preflight = vi.fn(() => true);
    const harness = tools.find((candidate) => candidate.name === "browser_exec");
    if (harness) {
      harness.selectionPreflight = preflight;
    }
    const selected = selectBrowserModelTool({ tools, preferHarness: true, sandboxed });
    expect(selected).toContain(native);
    expect(selected.some((candidate) => candidate.name === "browser_exec")).toBe(false);
    expect(preflight).not.toHaveBeenCalled();
  });

  it("honors the native engine override", () => {
    const native = tool("browser");
    const harness = tool("browser_exec");
    harness.selectionPreflight = vi.fn(() => true);
    const selected = selectBrowserModelTool({
      tools: [native, harness, tool("exec")],
      preferHarness: false,
      sandboxed: false,
    });
    expect(selected).toContain(native);
    expect(selected.some((candidate) => candidate.name === "browser_exec")).toBe(false);
    expect(harness.selectionPreflight).not.toHaveBeenCalled();
  });

  it("cannot resurrect Browser Harness after browser policy denied the native capability", () => {
    const harness = tool("browser_exec");
    harness.selectionPreflight = vi.fn(() => true);
    const selected = selectBrowserModelTool({
      tools: [harness, tool("exec")],
      preferHarness: true,
      sandboxed: false,
    });

    expect(selected.some((candidate) => candidate.name === "browser")).toBe(false);
    expect(selected).not.toContain(harness);
    expect(harness.selectionPreflight).not.toHaveBeenCalled();
  });

  it("keeps native in auto mode when final-policy preflight reports unavailable", () => {
    const native = tool("browser");
    const harness = tool("browser_exec");
    harness.selectionPreflight = vi.fn(() => false);

    const selected = selectBrowserModelTool({
      tools: [native, harness, tool("exec")],
      preferHarness: true,
      sandboxed: false,
    });

    expect(selected).toContain(native);
    expect(selected).not.toContain(harness);
    expect(harness.selectionPreflight).toHaveBeenCalledOnce();
  });

  it("fails closed to native when a deferred availability check throws", () => {
    const native = tool("browser");
    const harness = tool("browser_exec");
    harness.selectionPreflight = vi.fn(() => {
      throw new Error("probe failed");
    });

    const selected = selectBrowserModelTool({
      tools: [native, harness, tool("exec")],
      preferHarness: true,
      sandboxed: false,
    });

    expect(selected).toContain(native);
    expect(selected).not.toContain(harness);
  });

  it("keeps an explicitly required Harness tool so it can report its preflight error", () => {
    const native = tool("browser");
    const harness = tool("browser_exec");
    harness.selectionPreflight = vi.fn(() => false);

    const selected = selectBrowserModelTool({
      tools: [native, harness, tool("exec")],
      preferHarness: true,
      requireHarness: true,
      sandboxed: false,
    });

    expect(selected).toContain(harness);
    expect(selected).not.toContain(native);
    expect(harness.name).toBe("browser");
    expect(harness.selectionPreflight).toHaveBeenCalledOnce();
  });
});
