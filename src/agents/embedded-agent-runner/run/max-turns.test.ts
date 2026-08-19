import { describe, expect, it } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { buildMaxTurnsResult, canReturnVisibleAnswerAtMaxTurns } from "./max-turns.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

describe("buildMaxTurnsResult", () => {
  it("returns a blocked, replay-invalid max_turns terminal", () => {
    const result = buildMaxTurnsResult({
      maxTurns: 35,
      durationMs: 123,
      agentMeta: {
        sessionId: "session-limit",
        provider: "openai",
        model: "gpt-5.6-sol",
        assistantTurns: 35,
      },
      attempt: makeEmbeddedRunnerAttempt({ finalPromptText: "finish" }),
      attemptToolSummary: { calls: 1, tools: ["browser"], failures: 0 },
      finalPromptText: "finish",
    });

    expect(result).toMatchObject({
      payloads: [
        {
          isError: true,
          text: "Agent reached the configured maximum of 35 turns before producing a final answer.",
        },
      ],
      meta: {
        replayInvalid: true,
        livenessState: "blocked",
        error: { kind: "max_turns" },
        agentMeta: { assistantTurns: 35 },
        toolSummary: { calls: 1, tools: ["browser"], failures: 0 },
      },
    });
  });

  it("returns an already-visible settled answer without spending the finalizer slot", () => {
    const assistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "done" }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      currentAttemptAssistant: assistant,
      currentAttemptCompletedAssistant: assistant,
    });

    expect(
      canReturnVisibleAnswerAtMaxTurns({
        attempt,
        finalizationOutcome: "not-attempted",
        finalAssistantVisibleText: "done",
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: "unsettled tool activity",
      override: { itemLifecycle: { startedCount: 1, completedCount: 0, activeCount: 1 } },
    },
    {
      name: "async tool activity",
      override: { toolMetas: [{ toolName: "exec", asyncStarted: true }] },
    },
    {
      name: "accepted session spawn",
      override: {
        acceptedSessionSpawns: [{ runId: "child-run", childSessionKey: "agent:main:child" }],
      },
    },
    {
      name: "approval activity",
      override: { didSendDeterministicApprovalPrompt: true },
    },
    {
      name: "completed delivery",
      override: { didSendViaMessagingTool: true, messagingToolSentTexts: ["sent"] },
    },
  ] satisfies Array<{ name: string; override: Partial<EmbeddedRunAttemptResult> }>)(
    "fails closed for $name even when the ordinary turn contains text",
    ({ override }) => {
      const assistant = buildEmbeddedRunnerAssistant({
        content: [{ type: "text", text: "partial" }],
      });
      const attempt = makeEmbeddedRunnerAttempt({
        currentAttemptAssistant: assistant,
        currentAttemptCompletedAssistant: assistant,
        ...override,
      });

      expect(
        canReturnVisibleAnswerAtMaxTurns({
          attempt,
          finalizationOutcome: "not-attempted",
          finalAssistantVisibleText: "partial",
        }),
      ).toBe(false);
    },
  );
});
