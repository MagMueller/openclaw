import { beforeEach, describe, expect, it, vi } from "vitest";

const approvalMocks = vi.hoisted(() => ({
  load: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  return {
    ...original,
    loadExecApprovals: approvalMocks.load,
    resolveExecApprovalsFromFile: approvalMocks.resolve,
  };
});

import { hasApprovalFreeBrowserHarnessExecAuthority } from "./browser-harness-exec-authority.js";

describe("hasApprovalFreeBrowserHarnessExecAuthority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    approvalMocks.load.mockReturnValue({ version: 1 });
    approvalMocks.resolve.mockReturnValue({ agent: { security: "full", ask: "off" } });
  });

  it("uses the same full/off defaults as gateway exec", () => {
    expect(hasApprovalFreeBrowserHarnessExecAuthority({ agentId: "main" })).toBe(true);
  });

  it.each([
    { security: "allowlist" as const, ask: "off" as const },
    { security: "full" as const, ask: "on-miss" as const },
    { security: "deny" as const, ask: "off" as const },
  ])("rejects a stricter persisted host policy: $security/$ask", ({ security, ask }) => {
    approvalMocks.resolve.mockReturnValue({ agent: { security, ask } });
    expect(hasApprovalFreeBrowserHarnessExecAuthority({ agentId: "main" })).toBe(false);
  });

  it("honors explicit full-session authority without consulting persisted floors", () => {
    approvalMocks.load.mockImplementation(() => {
      throw new Error("must not load");
    });
    expect(
      hasApprovalFreeBrowserHarnessExecAuthority({
        mode: "full",
        bypassHostApprovalFloors: true,
      }),
    ).toBe(true);
  });

  it("fails closed when approval state cannot be resolved", () => {
    approvalMocks.load.mockImplementation(() => {
      throw new Error("migration required");
    });
    expect(hasApprovalFreeBrowserHarnessExecAuthority({})).toBe(false);
  });
});
