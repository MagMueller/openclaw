import { describe, expect, it } from "vitest";
import { hasActiveRunOrSubagent, hasRecordedInteraction } from "./community-invite-cohort.ts";

describe("hasRecordedInteraction", () => {
  it("is false for an empty session list", () => {
    expect(hasRecordedInteraction([])).toBe(false);
  });

  it("is false when every session exists but was never interacted with", () => {
    // Onboarding and agents can both create a session with nobody at the
    // keyboard; a session object alone must not read as real usage.
    expect(hasRecordedInteraction([{}, { lastInteractionAt: undefined }])).toBe(false);
  });

  it("is true once any session carries a recorded human turn", () => {
    expect(hasRecordedInteraction([{}, { lastInteractionAt: 1_700_000_000_000 }])).toBe(true);
  });
});

describe("hasActiveRunOrSubagent", () => {
  it("is false for an empty session list", () => {
    expect(hasActiveRunOrSubagent([])).toBe(false);
  });

  it("is false when no session has a run or subagent in flight", () => {
    expect(hasActiveRunOrSubagent([{ hasActiveRun: false }, {}])).toBe(false);
  });

  it("is true when any session has an active run", () => {
    expect(hasActiveRunOrSubagent([{}, { hasActiveRun: true }])).toBe(true);
  });

  it("is true when any session has an active subagent run", () => {
    expect(hasActiveRunOrSubagent([{}, { hasActiveSubagentRun: true }])).toBe(true);
  });
});
