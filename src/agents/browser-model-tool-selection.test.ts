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
  ])("keeps native browser when $label", ({ tools, sandboxed }) => {
    const native = tools[0];
    const selected = selectBrowserModelTool({ tools, preferHarness: true, sandboxed });
    expect(selected).toContain(native);
    expect(selected.some((candidate) => candidate.name === "browser_exec")).toBe(false);
  });

  it("honors the native engine override", () => {
    const native = tool("browser");
    const selected = selectBrowserModelTool({
      tools: [native, tool("browser_exec"), tool("exec")],
      preferHarness: false,
      sandboxed: false,
    });
    expect(selected).toContain(native);
    expect(selected.some((candidate) => candidate.name === "browser_exec")).toBe(false);
  });

  it("cannot resurrect Browser Harness after browser policy denied the native capability", () => {
    const harness = tool("browser_exec");
    const selected = selectBrowserModelTool({
      tools: [harness, tool("exec")],
      preferHarness: true,
      sandboxed: false,
    });

    expect(selected.some((candidate) => candidate.name === "browser")).toBe(false);
    expect(selected).not.toContain(harness);
  });
});
