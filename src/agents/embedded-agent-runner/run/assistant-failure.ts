import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import type { FailoverReason } from "../../embedded-agent-helpers.js";
import type { TraceAttempt } from "../types.js";
import {
  handleEmbeddedAssistantFailure,
  type EmbeddedRunAssistantFailureOutcome,
} from "./assistant-failure-policy.js";
import type { normalizeEmbeddedRunAttempt } from "./attempt-normalization.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import type { createEmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";
import type { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";

type PreparedRuntime = Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>>;
type NormalizedAttempt = Extract<
  Awaited<ReturnType<typeof normalizeEmbeddedRunAttempt>>,
  { action: "proceed" }
>;
type FailoverRetryController = ReturnType<typeof createEmbeddedRunFailoverRetryController>;

/** Adapts prepared-loop ownership into the focused assistant-failure policy. */
export async function handlePreparedLoopAssistantFailure(input: {
  runInput: PreparedEmbeddedRunInput;
  preparedRuntime: PreparedRuntime;
  normalizedAttempt: NormalizedAttempt;
  failoverRetryController: FailoverRetryController;
  runtimeAuthRetry: boolean;
  thinkLevel: ThinkLevel;
  emptyErrorRetries: number;
  overloadProfileRotations: number;
  sameModelIdleTimeoutRetries: number;
  lastRetryFailoverReason: FailoverReason | null;
  authProfileId?: string;
  suspensionSessionId: string;
  traceAttempts: TraceAttempt[];
}): Promise<EmbeddedRunAssistantFailureOutcome> {
  const { runInput, preparedRuntime, normalizedAttempt, failoverRetryController } = input;
  const runtime = preparedRuntime.snapshot();
  const outcome = await handleEmbeddedAssistantFailure({
    runParams: runInput.runParams,
    attempt: normalizedAttempt.attempt,
    attemptAssistant: normalizedAttempt.attemptAssistant,
    currentAttemptAssistant: normalizedAttempt.currentAttemptAssistant,
    terminalState: normalizedAttempt.terminalState,
    activeErrorContext: normalizedAttempt.activeErrorContext,
    provider: preparedRuntime.provider,
    providerOwner: runtime.providerRuntimeHandle.plugin,
    modelId: preparedRuntime.modelId,
    model: preparedRuntime.model.id,
    thinkLevel: input.thinkLevel,
    getThinkLevel: () => preparedRuntime.snapshot().thinkLevel,
    attemptedThinking: preparedRuntime.attemptedThinking,
    fallbackConfigured: runInput.fallbackConfigured,
    pluginHarnessOwnsTransport: runtime.pluginHarnessOwnsTransport,
    canRestartForLiveSwitch: normalizedAttempt.canRestartForLiveSwitch,
    authProfileId: input.authProfileId,
    authProfileStore: preparedRuntime.attemptAuthProfileStore,
    runtimeAuthRetry: input.runtimeAuthRetry,
    maybeRefreshRuntimeAuthForAuthError: preparedRuntime.maybeRefreshRuntimeAuthForAuthError,
    resolveAuthProfileFailureReason: failoverRetryController.resolveAuthProfileFailureReason,
    emptyErrorRetries: input.emptyErrorRetries,
    overloadProfileRotations: input.overloadProfileRotations,
    overloadProfileRotationLimit: failoverRetryController.overloadProfileRotationLimit,
    sameModelIdleTimeoutRetries: input.sameModelIdleTimeoutRetries,
    previousRetryFailoverReason: input.lastRetryFailoverReason,
    maybeMarkAuthProfileFailure: failoverRetryController.maybeMarkAuthProfileFailure,
    maybeRetrySameModelRateLimit: failoverRetryController.maybeRetrySameModelRateLimit,
    maybeBackoffBeforeOverloadFailover: failoverRetryController.maybeBackoffBeforeOverloadFailover,
    advanceAuthProfile: failoverRetryController.advanceAuthProfile,
    advanceRateLimitAuthProfile: failoverRetryController.advanceRateLimitAuthProfile,
    traceAttempts: input.traceAttempts,
    suspendForFailure: runInput.suspendForFailure,
    suspensionSessionId: input.suspensionSessionId,
    agentDir: runInput.agentDir,
    isProbeSession: runInput.isProbeSession,
  });
  preparedRuntime.setThinkLevel(outcome.thinkLevel);
  if (!outcome.preserveSameModelRateLimitRetryCount) {
    failoverRetryController.resetSameModelRateLimitRetries();
  }
  return outcome;
}
