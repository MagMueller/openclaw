import { describe, expect, it } from "vitest";
import { createAssistantTurnBudget } from "./assistant-turn-budget.js";

describe("assistant turn budget", () => {
  it("shares the ordinary cap across attempts and admits one finalizer", () => {
    const budget = createAssistantTurnBudget(4);
    const firstAttempt = budget.beginAttempt();

    expect(firstAttempt.recordCompletedTurn()).toBe(false);
    expect(firstAttempt.recordCompletedTurn()).toBe(false);
    expect(budget.remainingOrdinaryTurns).toBe(1);

    const retryAttempt = budget.beginAttempt();
    retryAttempt.reconcileCompletedTurns(1);

    expect(retryAttempt.reachedLimit).toBe(true);
    expect(budget.completedOrdinaryTurns).toBe(3);
    expect(budget.remainingOrdinaryTurns).toBe(0);
    expect(budget.tryBeginFinalization()).toBe(true);
    expect(budget.tryBeginFinalization()).toBe(false);
  });

  it("rejects budgets that cannot reserve an ordinary and finalizer turn", () => {
    expect(() => createAssistantTurnBudget(1)).toThrow("greater than or equal to 2");
  });
});
