import { isSilentReplyText } from "../../auto-reply/tokens.js";
import { AgentRunTerminalOutcomeError } from "../agent-run-terminal-error.js";
import {
  buildAgentRunTerminalOutcomeFromAttempt,
  classifyAgentRunTerminalOutcome,
  normalizeAgentRunAttemptTerminal,
} from "../agent-run-terminal-outcome.js";
import { resolveFinalAssistantVisibleText } from "../embedded-agent-runner/run/helpers.js";
import {
  EmptySettledTurnFinalizationError,
  InvalidSettledTurnFinalizationError,
} from "./settled-turn-finalization-outcome.js";
import type {
  AgentHarnessAttemptResult,
  AgentHarnessSettledTurnFinalizationResult,
} from "./types.js";

const ALLOWED_SETTLED_FINALIZATION_RESULT_KEYS = new Set([
  "assistant",
  "usage",
  "assistantTranscriptOwned",
  "assistantTranscriptIdempotencyKey",
  "assistantMessageIndex",
  "diagnosticTrace",
]);

const SETTLED_TURN_FINALIZATION_IDLE_TIMEOUT_MESSAGE =
  "Settled-turn finalization model stream timed out waiting for output";

function invalidFinalizationResult(
  message: string,
  result: Pick<AgentHarnessSettledTurnFinalizationResult, "usage">,
): InvalidSettledTurnFinalizationError {
  return new InvalidSettledTurnFinalizationError(message, result.usage);
}

function assistantContainsToolCall(
  assistant: AgentHarnessSettledTurnFinalizationResult["assistant"],
): boolean {
  return assistant.content.some(
    (block) => block !== null && typeof block === "object" && block.type === "toolCall",
  );
}

/**
 * Validates the deliberately narrow finalizer result before core turns it into
 * a terminal reply. Capability and delivery fields cannot cross this contract.
 */
export function assertSettledTurnFinalizationResult(
  result: AgentHarnessSettledTurnFinalizationResult,
): AgentHarnessSettledTurnFinalizationResult {
  const unknownKey = Object.keys(result).find(
    (key) => !ALLOWED_SETTLED_FINALIZATION_RESULT_KEYS.has(key),
  );
  if (unknownKey) {
    throw invalidFinalizationResult(
      `Settled-turn finalization returned unsupported result field: ${unknownKey}`,
      result,
    );
  }
  if (!result.assistant || result.assistant.role !== "assistant") {
    throw invalidFinalizationResult(
      "Settled-turn finalization did not return an assistant message",
      result,
    );
  }
  if (result.assistant.stopReason === "toolUse" || assistantContainsToolCall(result.assistant)) {
    throw invalidFinalizationResult("Settled-turn finalization returned a tool call", result);
  }
  if (result.assistant.stopReason !== "stop") {
    throw invalidFinalizationResult(
      `Settled-turn finalization returned unsuccessful stop reason: ${result.assistant.stopReason}`,
      result,
    );
  }
  if (
    result.assistantMessageIndex !== undefined &&
    (!Number.isSafeInteger(result.assistantMessageIndex) || result.assistantMessageIndex < 0)
  ) {
    throw invalidFinalizationResult(
      "Settled-turn finalization returned an invalid assistant message index",
      result,
    );
  }
  resolveSettledTurnFinalizationText(result);
  return result;
}

export function resolveSettledTurnFinalizationText(
  result: AgentHarnessSettledTurnFinalizationResult,
): string {
  const text = resolveFinalAssistantVisibleText(result.assistant);
  if (!text) {
    throw new EmptySettledTurnFinalizationError(result);
  }
  if (isSilentReplyText(text)) {
    throw invalidFinalizationResult(
      "Settled-turn finalization completed without a visible answer",
      result,
    );
  }
  return text;
}

/**
 * Projects a harness-owned full attempt engine into the narrow finalization
 * contract, rejecting canonical failure or capability evidence first.
 */
export function projectSettledTurnFinalizationAttemptResult(
  result: AgentHarnessAttemptResult,
): AgentHarnessSettledTurnFinalizationResult {
  const terminal =
    "terminal" in result ? result.terminal : normalizeAgentRunAttemptTerminal(result);
  const terminalOutcome = buildAgentRunTerminalOutcomeFromAttempt({
    terminal,
    promptTimeoutOutcome: result.promptTimeoutOutcome,
    assistant: result.currentAttemptAssistant,
  });
  const terminalClassification = classifyAgentRunTerminalOutcome(terminalOutcome);
  if (terminalClassification === "timeout" || terminalClassification === "cancellation") {
    const projectedOutcome =
      terminal.kind === "timeout" && terminal.source === "idle"
        ? { ...terminalOutcome, error: SETTLED_TURN_FINALIZATION_IDLE_TIMEOUT_MESSAGE }
        : terminalOutcome;
    throw new AgentRunTerminalOutcomeError(
      projectedOutcome.error ?? new Error("Settled-turn finalization was interrupted"),
      projectedOutcome,
    );
  }
  if (
    terminal.kind !== "ok" ||
    (result.compactionCount ?? 0) > 0 ||
    result.promptTimeoutOutcome ||
    result.preflightRecovery ||
    result.beforeAgentFinalizeRevisionReason ||
    result.codexAppServerFailure ||
    result.cloudCodeAssistFormatError
  ) {
    throw new InvalidSettledTurnFinalizationError(
      "Settled-turn finalization attempt did not complete successfully",
      result.attemptUsage,
    );
  }
  if (
    result.toolMetas.length > 0 ||
    result.itemLifecycle.startedCount > 0 ||
    result.itemLifecycle.completedCount > 0 ||
    result.itemLifecycle.activeCount > 0 ||
    result.replayMetadata.hadPotentialSideEffects ||
    !result.replayMetadata.replaySafe ||
    result.currentAttemptReplayMetadata?.hadPotentialSideEffects ||
    (result.currentAttemptReplayMetadata && !result.currentAttemptReplayMetadata.replaySafe) ||
    (result.clientToolCalls?.length ?? 0) > 0 ||
    (result.acceptedSessionSpawns?.length ?? 0) > 0 ||
    result.didSendViaMessagingTool ||
    result.didDeliverSourceReplyViaMessageTool ||
    result.didSendDeterministicApprovalPrompt ||
    result.messagingToolSentTexts.length > 0 ||
    result.messagingToolSentMediaUrls.length > 0 ||
    result.messagingToolSentTargets.length > 0 ||
    (result.messagingToolSourceReplyPayloads?.length ?? 0) > 0 ||
    result.heartbeatToolResponse ||
    (result.toolMediaUrls?.length ?? 0) > 0 ||
    (result.hostOwnedToolMediaUrls?.length ?? 0) > 0 ||
    result.toolAudioAsVoice ||
    result.toolTrustedLocalMedia ||
    result.hasToolMediaBlockReply ||
    result.lastToolError ||
    (result.successfulCronAdds ?? 0) > 0 ||
    result.yieldDetected
  ) {
    throw new InvalidSettledTurnFinalizationError(
      "Settled-turn finalization attempt reported capability activity",
      result.attemptUsage,
    );
  }
  const assistant = result.currentAttemptCompletedAssistant;
  if (!assistant) {
    throw new InvalidSettledTurnFinalizationError(
      "Settled-turn finalization attempt returned no completed assistant message",
      result.attemptUsage,
    );
  }
  return assertSettledTurnFinalizationResult({
    assistant,
    ...(result.attemptUsage ? { usage: result.attemptUsage } : {}),
    ...(result.assistantTranscriptOwned
      ? {
          assistantTranscriptOwned: true,
          ...(result.assistantTranscriptIdempotencyKey
            ? { assistantTranscriptIdempotencyKey: result.assistantTranscriptIdempotencyKey }
            : {}),
        }
      : result.lastAssistantTextMessageIndex !== undefined
        ? { assistantMessageIndex: result.lastAssistantTextMessageIndex }
        : {}),
    ...(result.diagnosticTrace ? { diagnosticTrace: result.diagnosticTrace } : {}),
  });
}
