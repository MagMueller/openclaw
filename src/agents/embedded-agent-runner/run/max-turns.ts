import { hasAcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import { hasCompletedMessagingToolDeliveryEvidence } from "../delivery-evidence.js";
import type { EmbeddedAgentMeta, EmbeddedAgentRunResult } from "../types.js";
import { hasAsyncActivity } from "./attempt-terminal-evidence.js";
import { buildEmbeddedRunBlockedResult } from "./blocked-run-result.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

function formatMaxTurnsMessage(maxTurns: number): string {
  return `Agent reached the configured maximum of ${maxTurns} turns before producing a final answer.`;
}

export function canReturnVisibleAnswerAtMaxTurns(input: {
  attempt: EmbeddedRunAttemptResult;
  finalizationOutcome: "answered" | "completed-empty" | "failed" | "not-attempted";
  finalAssistantVisibleText?: string;
}): boolean {
  if (input.finalizationOutcome === "answered") {
    return true;
  }
  const attempt = input.attempt;
  const lifecycle = attempt.itemLifecycle;
  const hasUnsettledWork =
    lifecycle.activeCount > 0 || lifecycle.startedCount !== lifecycle.completedCount;
  if (
    hasUnsettledWork ||
    hasAsyncActivity(attempt.toolMetas) ||
    hasAcceptedSessionSpawn(attempt.acceptedSessionSpawns) ||
    (attempt.clientToolCalls?.length ?? 0) > 0 ||
    attempt.yieldDetected === true ||
    attempt.didSendDeterministicApprovalPrompt === true ||
    hasCompletedMessagingToolDeliveryEvidence(attempt)
  ) {
    return false;
  }
  return (
    attempt.currentAttemptCompletedAssistant?.stopReason === "stop" &&
    Boolean(input.finalAssistantVisibleText)
  );
}

export function buildMaxTurnsResult(input: {
  maxTurns: number;
  durationMs: number;
  agentMeta: EmbeddedAgentMeta;
  attempt?: EmbeddedRunAttemptResult;
  attemptToolSummary?: EmbeddedAgentRunResult["meta"]["toolSummary"];
  finalPromptText?: string;
}): EmbeddedAgentRunResult {
  const message = formatMaxTurnsMessage(input.maxTurns);
  if (input.attempt) {
    const result = buildEmbeddedRunBlockedResult({
      text: message,
      errorKind: "max_turns",
      errorMessage: message,
      durationMs: input.durationMs,
      agentMeta: input.agentMeta,
      attempt: input.attempt,
      replayInvalid: true,
      finalPromptText: input.finalPromptText,
    });
    result.meta.toolSummary = input.attemptToolSummary;
    return result;
  }
  return {
    payloads: [{ text: message, isError: true }],
    meta: {
      durationMs: input.durationMs,
      agentMeta: input.agentMeta,
      replayInvalid: true,
      livenessState: "blocked",
      error: { kind: "max_turns", message },
    },
  };
}
