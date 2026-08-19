import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { agentExecCommand, classifyAgentExecResult } from "./agent-exec.js";

function createRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function successResult() {
  return {
    payloads: [{ text: "done" }],
    meta: {
      durationMs: 25,
      finalAssistantVisibleText: "done",
      agentMeta: {
        sessionId: "session-result",
        provider: "openai",
        model: "gpt-5.6-sol",
      },
    },
  };
}

describe("agent exec max-turns", () => {
  it("preserves the max-turns terminal kind", () => {
    const envelope = classifyAgentExecResult({
      payloads: [{ text: "turn limit reached", isError: true }],
      meta: {
        durationMs: 10,
        error: { kind: "max_turns", message: "turn limit reached" },
      },
    });

    expect(envelope).toMatchObject({
      ok: false,
      status: "error",
      error: { kind: "max_turns", message: "turn limit reached" },
    });
  });

  it("rejects a value that cannot reserve a finalizer turn", async () => {
    const runAgent = vi.fn(async () => successResult());

    const result = await agentExecCommand(
      "inspect",
      { maxTurns: "1", json: true },
      createRuntime(),
      { runAgent },
    );

    expect(result).toMatchObject({
      exitCode: 1,
      envelope: { status: "error", error: { kind: "exception" } },
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("passes one shared in-memory budget only through local agent exec", async () => {
    let observedBudget: Record<string, unknown> | undefined;

    const result = await agentExecCommand("inspect", { maxTurns: "2" }, createRuntime(), {
      runAgent: vi.fn(async (options) => {
        observedBudget = options.assistantTurnBudget as Record<string, unknown>;
        return successResult();
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(observedBudget).toMatchObject({
      maxTurns: 2,
      ordinaryTurnLimit: 1,
      completedOrdinaryTurns: 0,
      remainingOrdinaryTurns: 1,
    });
    expect(observedBudget?.beginAttempt).toEqual(expect.any(Function));
  });
});
