// Full-entry coverage for the local assistant-turn budget and reserved finalizer.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantTurnBudget } from "../assistant-turn-budget.js";
import type { AssistantTurnAttemptBudget } from "../assistant-turn-budget.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedBuildEmbeddedRunPayloads,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

describe("runEmbeddedAgent max-turn finalization", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetSharedRunIntegrationHarnessMocks();
    useOpenAIPlatformAuthFixture();
  });

  it("settles one tool turn and returns exactly one capability-free final answer at maxTurns=2", async () => {
    const budget = createAssistantTurnBudget(2);
    const toolEffect = vi.fn();
    const persistedMessages: NonNullable<EmbeddedRunAttemptResult["messagesSnapshot"]> = [];
    const toolAssistant = makeAssistantMessageFixture({
      stopReason: "toolUse",
      errorMessage: undefined,
      content: [{ type: "toolCall", id: "effect-1", name: "test_effect", arguments: {} }],
    });
    const toolResult = {
      role: "toolResult" as const,
      toolCallId: "effect-1",
      toolName: "test_effect",
      isError: false,
      content: [{ type: "text" as const, text: "effect complete" }],
      timestamp: 1,
    };
    const finalAssistant = makeAssistantMessageFixture({
      stopReason: "stop",
      errorMessage: undefined,
      content: [{ type: "text", text: "The effect completed once." }],
    });

    mockedBuildEmbeddedRunPayloads.mockImplementation(({ currentAssistant }) =>
      currentAssistant === finalAssistant ? [{ text: "The effect completed once." }] : [],
    );
    mockedRunEmbeddedAttempt.mockImplementation(async (attemptParams) => {
      if (attemptParams.disableTools) {
        return makeAttemptResult({
          assistantTexts: ["The effect completed once."],
          lastAssistant: finalAssistant,
          currentAttemptAssistant: finalAssistant,
          currentAttemptCompletedAssistant: finalAssistant,
          assistantTurns: 1,
        });
      }

      toolEffect();
      persistedMessages.push(toolAssistant, toolResult);
      const internalParams = attemptParams as typeof attemptParams & {
        assistantTurnAttemptBudget?: AssistantTurnAttemptBudget;
      };
      expect(internalParams.assistantTurnAttemptBudget?.recordCompletedTurn()).toBe(true);
      return makeAttemptResult({
        assistantTexts: [],
        lastAssistant: toolAssistant,
        currentAttemptAssistant: toolAssistant,
        currentAttemptCompletedAssistant: toolAssistant,
        assistantTurns: 1,
        toolMetas: [{ toolName: "test_effect", isError: false, replaySafe: false }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        messagesSnapshot: persistedMessages,
        currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.6-luna",
      runId: "run-max-turns-finalizer",
      agentHarnessRuntimeOverride: "openclaw",
      assistantTurnBudget: budget,
      terminalReplyExpectation: "required",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(toolEffect).toHaveBeenCalledOnce();
    expect(persistedMessages).toEqual([toolAssistant, toolResult]);
    expect(mockedRunEmbeddedAttempt.mock.calls[1]?.[0]).toMatchObject({
      operation: "settled-tool-finalization",
      disableTools: true,
      skipPreparedUserTurnMessage: true,
      suppressNextUserMessagePersistence: true,
      initialReplayState: { replayInvalid: false, hadPotentialSideEffects: false },
    });
    expect(budget).toMatchObject({
      completedOrdinaryTurns: 1,
      finalizationStarted: true,
      remainingOrdinaryTurns: 0,
    });
    expect(result).toMatchObject({
      payloads: [{ text: "The effect completed once." }],
      meta: {
        livenessState: "working",
        agentMeta: { assistantTurns: 2 },
        toolSummary: { calls: 1, tools: ["test_effect"], failures: 0 },
      },
    });
    expect(result.meta.error).toBeUndefined();
  });

  it("keeps a prompt timeout authoritative when the ordinary-turn budget is exhausted", async () => {
    const budget = createAssistantTurnBudget(2);
    const toolAssistant = makeAssistantMessageFixture({
      stopReason: "toolUse",
      errorMessage: undefined,
      content: [{ type: "toolCall", id: "timeout-1", name: "test_effect", arguments: {} }],
    });
    const toolResult = {
      role: "toolResult" as const,
      toolCallId: "timeout-1",
      toolName: "test_effect",
      isError: false,
      content: [{ type: "text" as const, text: "effect complete" }],
      timestamp: 1,
    };
    mockedBuildEmbeddedRunPayloads.mockReturnValue([]);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      const internalParams = attemptParams as typeof attemptParams & {
        assistantTurnAttemptBudget?: AssistantTurnAttemptBudget;
      };
      expect(internalParams.assistantTurnAttemptBudget?.recordCompletedTurn()).toBe(true);
      return makeAttemptResult({
        terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
        assistantTexts: [],
        lastAssistant: toolAssistant,
        currentAttemptAssistant: toolAssistant,
        currentAttemptCompletedAssistant: toolAssistant,
        assistantTurns: 1,
        toolMetas: [{ toolName: "test_effect", isError: false, replaySafe: false }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        messagesSnapshot: [toolAssistant, toolResult],
        currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.6-luna",
      runId: "run-max-turns-timeout-precedence",
      agentHarnessRuntimeOverride: "openclaw",
      assistantTurnBudget: budget,
      terminalReplyExpectation: "required",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    expect(budget.finalizationStarted).toBe(false);
    expect(result.payloads).toEqual([
      { text: expect.stringContaining("timed out"), isError: true },
    ]);
    expect(result.meta).toMatchObject({
      timeoutPhase: "provider",
      providerStarted: true,
      toolSummary: { calls: 1, tools: ["test_effect"], failures: 0 },
    });
    expect(result.meta.error?.kind).not.toBe("max_turns");
  });

  it("keeps cancellation authoritative when the ordinary-turn budget is exhausted", async () => {
    const budget = createAssistantTurnBudget(2);
    const abortedAssistant = makeAssistantMessageFixture({
      stopReason: "aborted",
      errorMessage: undefined,
      content: [],
    });
    mockedBuildEmbeddedRunPayloads.mockReturnValue([]);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      const internalParams = attemptParams as typeof attemptParams & {
        assistantTurnAttemptBudget?: AssistantTurnAttemptBudget;
      };
      expect(internalParams.assistantTurnAttemptBudget?.recordCompletedTurn()).toBe(true);
      return makeAttemptResult({
        terminal: { kind: "aborted", source: "external" },
        assistantTexts: [],
        lastAssistant: abortedAssistant,
        currentAttemptAssistant: abortedAssistant,
        currentAttemptCompletedAssistant: abortedAssistant,
        assistantTurns: 1,
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.6-luna",
      runId: "run-max-turns-cancel-precedence",
      agentHarnessRuntimeOverride: "openclaw",
      assistantTurnBudget: budget,
      terminalReplyExpectation: "required",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    expect(budget.finalizationStarted).toBe(false);
    expect(result.meta.aborted).toBe(true);
    expect(result.meta.error?.kind).not.toBe("max_turns");
  });

  it("surfaces an exhausted Codex completion timeout despite prior delivery", async () => {
    const budget = createAssistantTurnBudget(2);
    const timeoutMessage =
      "Codex stopped before confirming the turn was complete; verify delivered work.";
    mockedBuildEmbeddedRunPayloads.mockReturnValue([]);
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      const internalParams = attemptParams as typeof attemptParams & {
        assistantTurnAttemptBudget?: AssistantTurnAttemptBudget;
      };
      expect(internalParams.assistantTurnAttemptBudget?.recordCompletedTurn()).toBe(true);
      return makeAttemptResult({
        terminal: {
          kind: "timeout",
          phase: "prompt",
          source: "runtime",
          aborted: true,
          failure: { source: "prompt", error: new Error("turn completion idle timeout") },
        },
        assistantTexts: [],
        assistantTurns: 1,
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["already delivered"],
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        promptTimeoutOutcome: {
          message: timeoutMessage,
          replayInvalid: true,
          livenessState: "abandoned",
        },
        codexAppServerFailure: {
          kind: "turn_completion_idle_timeout",
          turnWatchTimeoutKind: "completion",
          transport: "stdio",
          threadId: "thread-1",
          turnId: "turn-1",
          replaySafe: false,
          replayBlockedReason: "potential_side_effect",
        },
      });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "codex",
      model: "gpt-5.5",
      runId: "run-max-turns-codex-completion-timeout",
      agentHarnessRuntimeOverride: "openclaw",
      assistantTurnBudget: budget,
      terminalReplyExpectation: "required",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    expect(budget.finalizationStarted).toBe(false);
    expect(result.payloads).toEqual([{ text: timeoutMessage, isError: true }]);
    expect(result.meta).toMatchObject({
      replayInvalid: true,
      livenessState: "abandoned",
      error: { kind: "incomplete_turn", fallbackSafe: false },
    });
    expect(result.meta.error?.kind).not.toBe("max_turns");
  });

  it.each([
    {
      label: "empty",
      finalAssistant: makeAssistantMessageFixture({
        stopReason: "stop",
        errorMessage: undefined,
        content: [],
      }),
    },
    {
      label: "tool-calling",
      finalAssistant: makeAssistantMessageFixture({
        stopReason: "toolUse",
        errorMessage: undefined,
        content: [{ type: "toolCall", id: "forbidden-1", name: "write", arguments: {} }],
      }),
    },
  ])("fails $label finalization as max_turns without a second finalizer", async (testCase) => {
    const budget = createAssistantTurnBudget(2);
    const toolAssistant = makeAssistantMessageFixture({
      stopReason: "toolUse",
      errorMessage: undefined,
      content: [{ type: "toolCall", id: "effect-1", name: "test_effect", arguments: {} }],
    });
    const toolResult = {
      role: "toolResult" as const,
      toolCallId: "effect-1",
      toolName: "test_effect",
      isError: false,
      content: [{ type: "text" as const, text: "effect complete" }],
      timestamp: 1,
    };
    mockedBuildEmbeddedRunPayloads.mockReturnValue([]);
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (attemptParams) => {
        const internalParams = attemptParams as typeof attemptParams & {
          assistantTurnAttemptBudget?: AssistantTurnAttemptBudget;
        };
        expect(internalParams.assistantTurnAttemptBudget?.recordCompletedTurn()).toBe(true);
        return makeAttemptResult({
          assistantTexts: [],
          lastAssistant: toolAssistant,
          currentAttemptAssistant: toolAssistant,
          currentAttemptCompletedAssistant: toolAssistant,
          assistantTurns: 1,
          toolMetas: [{ toolName: "test_effect", isError: false, replaySafe: false }],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          messagesSnapshot: [toolAssistant, toolResult],
          currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        });
      })
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          lastAssistant: testCase.finalAssistant,
          currentAttemptAssistant: testCase.finalAssistant,
          currentAttemptCompletedAssistant: testCase.finalAssistant,
          assistantTurns: 1,
        }),
      );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.6-luna",
      runId: `run-max-turns-${testCase.label}-finalizer`,
      agentHarnessRuntimeOverride: "openclaw",
      assistantTurnBudget: budget,
      terminalReplyExpectation: "required",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(budget.finalizationStarted).toBe(true);
    expect(result.meta.error).toMatchObject({ kind: "max_turns" });
    expect(result.meta.toolSummary).toEqual({
      calls: 1,
      tools: ["test_effect"],
      failures: 0,
    });
  });
});
