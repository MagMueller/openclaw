import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildExecRunConfig } from "./agent-exec.js";

describe("agent exec browser authority", () => {
  it("does not widen an explicitly configured messaging profile", () => {
    const config = buildExecRunConfig({
      base: { tools: { profile: "messaging" } },
      cwd: "/run/here",
    });

    expect(config.tools?.profile).toBe("messaging");
    expect(config.tools?.alsoAllow).toBeUndefined();
  });

  it.each([
    {
      label: "agent defaults",
      base: {
        agents: { defaults: { tools: { profile: "messaging" } } },
      } as unknown as OpenClawConfig,
    },
    {
      label: "named agent",
      base: { agents: { entries: { main: { tools: { profile: "messaging" } } } } },
    },
  ] satisfies Array<{ label: string; base: OpenClawConfig }>)(
    "does not add a global browser grant over $label tool policy",
    ({ base }) => {
      const config = buildExecRunConfig({ base, cwd: "/run/here" });

      expect(config.tools?.alsoAllow).toBeUndefined();
    },
  );
});
