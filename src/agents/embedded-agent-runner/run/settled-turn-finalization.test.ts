import { beforeEach, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { AgentRunTerminalOutcomeError } from "../../agent-run-terminal-error.js";
import { createAssistantTurnBudget } from "../../assistant-turn-budget.js";
import { InvalidSettledTurnFinalizationError } from "../../harness/settled-turn-finalization-outcome.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createUsageAccumulator } from "../usage-accumulator.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";

const backendMocks = vi.hoisted(() => ({
  runSettledFinalization: vi.fn(),
}));

vi.mock("./backend.js", () => ({
  runEmbeddedSettledTurnFinalizationWithBackend: backendMocks.runSettledFinalization,
}));

function settledFailedAttempt(): EmbeddedRunAttemptWithReceiptEvidence {
  const assistant = buildEmbeddedRunnerAssistant({
    stopReason: "toolUse",
    content: [
      { type: "toolCall", id: "tool-read", name: "read", arguments: {} },
      { type: "toolCall", id: "tool-exec", name: "exec", arguments: {} },
    ],
  });
  const messagesSnapshot = [
    assistant,
    { role: "toolResult", toolCallId: "tool-read", toolName: "read", isError: false },
    { role: "toolResult", toolCallId: "tool-exec", toolName: "exec", isError: true },
  ] as never;
  const attempt = makeEmbeddedRunnerAttempt({
    terminal: {
      kind: "failed",
      source: "compaction",
      error: new Error("native context compaction failed"),
    },
    sessionIdUsed: "session-settled",
    sessionFileUsed: "/tmp/session-settled.jsonl",
    assistantTexts: [],
    toolMetas: [
      { toolName: "read", isError: false, replaySafe: true },
      { toolName: "exec", isError: true, replaySafe: false },
    ],
    successfulCronAdds: 1,
    latestMcpAppChannelView: { viewId: "view-after-tools" },
    itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
    messagesSnapshot,
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    settledTurnFinalizationContext: { source: "openclaw-transcript", messages: messagesSnapshot },
    lastToolError: {
      toolName: "exec",
      error: "post-processing error",
      errorCode: "SYSTEM_RUN_DENIED",
    },
    codeModeEngaged: true,
    assistantTurns: 1,
    bridgeCalls: { search: 1, describe: 2, call: 3 },
  });
  return { ...attempt, successfulNestedToolNames: ["memory_search"] };
}

function finalizationInput(attempt: ReturnType<typeof settledFailedAttempt>) {
  const usageAccumulator = createUsageAccumulator();
  usageAccumulator.assistantTurns = 1;
  usageAccumulator.bridgeCalls = { search: 1, describe: 2, call: 3 };
  return {
    initial: {
      attempt,
      attemptAssistant: attempt.currentAttemptAssistant,
      currentAttemptCompletedAssistant: undefined,
      sessionIdUsed: attempt.sessionIdUsed,
      sessionFileUsed: attempt.sessionFileUsed,
      terminalState: resolveEmbeddedRunAttemptTerminalState({
        attempt,
        assistant: attempt.currentAttemptAssistant,
      }),
      attemptCompactionCount: 0,
    },
    terminalBase: {
      runParams: {
        admittedRunContext: createTestAdmittedRunContext("run-settled"),
        sessionId: "session-settled",
        runId: "run-settled",
        workspaceDir: "/tmp/openclaw-test",
        prompt: "finish the task",
        trigger: "cron",
        terminalReplyExpectation: "required",
        timeoutMs: 60_000,
        sourceReplyDeliveryMode: "message_tool_only",
      },
      provider: "openai",
      model: "gpt-5.6-luna",
      activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
      authProfileStore: { version: 1, profiles: {} },
      outerContextTokenMeta: {},
      usageAccumulator,
      contextRecoveryState: createEmbeddedRunContextRecoveryState(),
      resolvedToolResultFormat: "markdown",
    },
    lastRunPromptUsage: undefined,
    finalization: {
      preparedAttempt: {
        runId: "run-settled",
        sessionId: "session-settled",
        workspaceDir: "/tmp/openclaw-test",
        prompt: "finish the task",
        timeoutMs: 60_000,
      },
      harness: {
        id: "test-harness",
        label: "Test harness",
        supports: () => ({ supported: true }),
        runAttempt: vi.fn(),
        finalizeSettledTurn: vi.fn(),
      },
      modelApi: "openai-responses",
      executionContract: undefined,
      hasTerminalToolPresentation: false,
      noteLaneTaskProgress: vi.fn(),
    },
  } as unknown as Parameters<typeof prepareTerminalWithSettledTurnFinalization>[0];
}

describe("prepareTerminalWithSettledTurnFinalization", () => {
  beforeEach(() => {
    backendMocks.runSettledFinalization.mockReset();
  });

  it("replaces a settled failed-tool warning with failure-honest final output", async () => {
    const attempt = settledFailedAttempt();
    const finalAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "The exec tool failed: post-processing error." }],
    });
    backendMocks.runSettledFinalization.mockResolvedValueOnce({
      outcome: "answered",
      result: {
        assistant: finalAssistant,
        usage: finalAssistant.usage,
        diagnosticTrace: { traceId: "trace-final", spanId: "span-final" },
      },
    });

    const result = await prepareTerminalWithSettledTurnFinalization(finalizationInput(attempt));

    expect(backendMocks.runSettledFinalization).toHaveBeenCalledOnce();
    const [preparedAttempt, settledAttempt] =
      backendMocks.runSettledFinalization.mock.calls[0] ?? [];
    expect(preparedAttempt).toMatchObject({
      operation: "settled-tool-finalization",
      disableTools: true,
      skipPreparedUserTurnMessage: true,
      suppressNextUserMessagePersistence: true,
      initialReplayState: { replayInvalid: false, hadPotentialSideEffects: false },
    });
    expect(settledAttempt).toBe(attempt);
    expect(result.finalizationOutcome).toBe("answered");
    expect(result.prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({ text: "The exec tool failed: post-processing error." }),
    ]);
    expect(getReplyPayloadMetadata(result.prepared.payloadsWithToolMedia?.[0] ?? {})).toMatchObject(
      {
        deliverDespiteSourceReplySuppression: true,
      },
    );
    expect(result.attempt).toMatchObject({
      latestMcpAppChannelView: { viewId: "view-after-tools" },
      successfulCronAdds: 1,
      successfulNestedToolNames: ["memory_search"],
      codeModeEngaged: true,
      itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
      replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    expect(result.prepared.agentMeta).toMatchObject({
      codeModeEngaged: true,
      assistantTurns: 2,
      bridgeCalls: { search: 1, describe: 2, call: 3 },
    });
    expect(result.prepared.failureSignal).toEqual({
      kind: "execution_denied",
      source: "tool",
      toolName: "exec",
      code: "SYSTEM_RUN_DENIED",
      message: "post-processing error",
      fatalForCron: true,
    });
  });

  it("preserves the settled runtime context window through isolated finalization", async () => {
    const attempt = {
      ...settledFailedAttempt(),
      agentHarnessId: "codex",
      contextTokens: 1_000_000,
      contextTokensSource: "runtime" as const,
    };
    const input = finalizationInput(attempt);
    input.terminalBase.outerContextTokenMeta = { contextTokens: 272_000 };
    input.finalization.preparedAttempt.agentHarnessId = "codex";
    const finalAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "The exec tool failed: post-processing error." }],
    });
    backendMocks.runSettledFinalization.mockResolvedValueOnce({
      outcome: "answered",
      result: {
        assistant: finalAssistant,
        usage: finalAssistant.usage,
        diagnosticTrace: { traceId: "trace-final", spanId: "span-final" },
      },
    });

    const result = await prepareTerminalWithSettledTurnFinalization(input);

    expect(result.attempt).toMatchObject({
      agentHarnessId: "codex",
      contextTokens: 1_000_000,
      contextTokensSource: "runtime",
    });
    expect(result.prepared.agentMeta).toMatchObject({
      agentHarnessId: "codex",
      contextTokens: 1_000_000,
      contextTokensSource: "runtime",
    });
  });

  it("fails closed and preserves the initial terminal preparation", async () => {
    const attempt = settledFailedAttempt();
    backendMocks.runSettledFinalization.mockRejectedValueOnce(new Error("finalizer failed"));

    const result = await prepareTerminalWithSettledTurnFinalization(finalizationInput(attempt));

    expect(result.finalizationOutcome).toBe("failed");
    expect(result.attempt).toBe(attempt);
    expect(result.prepared.payloadsWithToolMedia?.[0]).toMatchObject({ isError: true });
  });

  it("admits only one budget-reserved isolated finalizer", async () => {
    const attempt = settledFailedAttempt();
    const input = finalizationInput(attempt);
    const budget = createAssistantTurnBudget(2);
    input.terminalBase.runParams.assistantTurnBudget = budget;
    const finalAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "Final answer." }],
    });
    backendMocks.runSettledFinalization.mockResolvedValueOnce({
      outcome: "answered",
      result: { assistant: finalAssistant, usage: finalAssistant.usage },
    });

    const first = await prepareTerminalWithSettledTurnFinalization(input);
    const second = await prepareTerminalWithSettledTurnFinalization(input);

    expect(first.finalizationOutcome).toBe("answered");
    expect(second.finalizationOutcome).toBe("failed");
    expect(budget.finalizationStarted).toBe(true);
    expect(backendMocks.runSettledFinalization).toHaveBeenCalledOnce();
  });

  it("uses the exhausted budget's reserved finalizer for an unsupported provider", async () => {
    const attempt = settledFailedAttempt();
    const input = finalizationInput(attempt);
    const budget = createAssistantTurnBudget(2);
    budget.beginAttempt().recordCompletedTurn();
    input.terminalBase.runParams.assistantTurnBudget = budget;
    input.terminalBase.activeErrorContext = {
      provider: "unsupported-provider",
      model: "unsupported-model",
    };
    input.finalization.modelApi = undefined;
    const finalAssistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "Final answer after the settled tools." }],
    });
    backendMocks.runSettledFinalization.mockResolvedValueOnce({
      outcome: "answered",
      result: { assistant: finalAssistant, usage: finalAssistant.usage },
    });

    const result = await prepareTerminalWithSettledTurnFinalization(input);

    expect(result.finalizationOutcome).toBe("answered");
    expect(budget.finalizationStarted).toBe(true);
    expect(backendMocks.runSettledFinalization).toHaveBeenCalledOnce();
  });

  it("keeps unsupported providers blocked without an exhausted trusted budget", async () => {
    const attempt = settledFailedAttempt();
    const input = finalizationInput(attempt);
    input.terminalBase.activeErrorContext = {
      provider: "unsupported-provider",
      model: "unsupported-model",
    };
    input.finalization.modelApi = undefined;

    const result = await prepareTerminalWithSettledTurnFinalization(input);

    expect(result.finalizationOutcome).toBe("not-attempted");
    expect(backendMocks.runSettledFinalization).not.toHaveBeenCalled();
  });

  it("counts usage from a completed finalizer that violates the no-tools contract", async () => {
    const attempt = settledFailedAttempt();
    const input = finalizationInput(attempt);
    const finalizerUsage = { input: 7, output: 3, total: 10 };
    backendMocks.runSettledFinalization.mockRejectedValueOnce(
      new InvalidSettledTurnFinalizationError(
        "Settled-turn finalization returned a tool call",
        finalizerUsage,
      ),
    );

    const result = await prepareTerminalWithSettledTurnFinalization(input);

    expect(result.finalizationOutcome).toBe("failed");
    expect(result.prepared.agentMeta).toMatchObject({
      assistantTurns: 2,
      usage: expect.objectContaining({ input: 7, output: 3, total: 10 }),
    });
  });

  it("propagates cancellation during the isolated finalizer without counting a turn", async () => {
    const attempt = settledFailedAttempt();
    const input = finalizationInput(attempt);
    const budget = createAssistantTurnBudget(2);
    const controller = new AbortController();
    input.terminalBase.runParams.assistantTurnBudget = budget;
    input.terminalBase.runParams.abortSignal = controller.signal;
    backendMocks.runSettledFinalization.mockImplementationOnce(
      async (preparedAttempt: { abortSignal?: AbortSignal }) =>
        await new Promise((_, reject) => {
          preparedAttempt.abortSignal?.addEventListener(
            "abort",
            () => {
              const reason = preparedAttempt.abortSignal?.reason;
              reject(reason instanceof Error ? reason : new Error("finalizer aborted"));
            },
            { once: true },
          );
        }),
    );

    const resultPromise = prepareTerminalWithSettledTurnFinalization(input);
    controller.abort(new Error("operator cancel"));

    await expect(resultPromise).rejects.toThrow("operator cancel");
    expect(input.terminalBase.usageAccumulator.assistantTurns).toBe(1);
    expect(budget.finalizationStarted).toBe(true);
  });

  it("propagates a finalizer-owned timeout instead of downgrading it to max-turns", async () => {
    const attempt = settledFailedAttempt();
    const timeout = new AgentRunTerminalOutcomeError(new Error("finalizer deadline elapsed"), {
      reason: "hard_timeout",
      status: "timeout",
      timeoutPhase: "provider",
      providerStarted: true,
    });
    backendMocks.runSettledFinalization.mockRejectedValueOnce(timeout);

    await expect(
      prepareTerminalWithSettledTurnFinalization(finalizationInput(attempt)),
    ).rejects.toBe(timeout);
  });
});
