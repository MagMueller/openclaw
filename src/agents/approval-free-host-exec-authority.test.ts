import { describe, expect, it } from "vitest";
import { hasApprovalFreeHostExecAuthority } from "./approval-free-host-exec-authority.js";

describe("hasApprovalFreeHostExecAuthority", () => {
  it.each([
    { mode: "full", security: "full", ask: "off", expected: true },
    { mode: "allowlist", security: "allowlist", ask: "off", expected: false },
    { mode: "ask", security: "allowlist", ask: "on-miss", expected: false },
  ] as const)("returns $expected for $mode/$security/$ask", ({ expected, ...config }) => {
    expect(
      hasApprovalFreeHostExecAuthority({
        ...config,
        bypassHostApprovalFloors: true,
      }),
    ).toBe(expected);
  });
});
