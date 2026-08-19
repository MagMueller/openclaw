import { formatErrorMessage } from "../../../infra/errors.js";
import {
  retireSessionMcpRuntime,
  retireSessionMcpRuntimeForSessionKey,
} from "../../agent-bundle-mcp-tools.js";
import { runAgentCleanupStep } from "../../run-cleanup-timeout.js";
import { log } from "../logger.js";
import { clearProviderPromptState } from "../provider-prompt-state.js";
import { forgetPromptBuildDrainCacheForRun } from "./attempt-prompt-helpers.js";
import type { RunEmbeddedAgentParams } from "./params.js";

/** Releases run-scoped owners after every prepared-loop terminal path. */
export async function cleanupPreparedEmbeddedLoop(input: {
  runParams: RunEmbeddedAgentParams;
  maybeEmitFastModeAutoResetBestEffort: () => Promise<void>;
  stopRuntimeAuthRefreshTimer: () => void;
  ownsContextEngineLogicalTurnLease: boolean;
  contextEngineLogicalTurnLease: { dispose: () => Promise<void> };
}): Promise<void> {
  const params = input.runParams;
  if (params.isFinalFallbackAttempt !== false) {
    await input.maybeEmitFastModeAutoResetBestEffort();
  }
  forgetPromptBuildDrainCacheForRun(params.runId);
  clearProviderPromptState(params.runId);
  input.stopRuntimeAuthRefreshTimer();
  if (input.ownsContextEngineLogicalTurnLease) {
    await runAgentCleanupStep({
      runId: params.runId,
      sessionId: params.sessionId,
      step: "context-engine-dispose",
      log,
      cleanup: async () => await input.contextEngineLogicalTurnLease.dispose(),
    });
  }
  if (params.cleanupBundleMcpOnRunEnd !== true) {
    return;
  }
  await runAgentCleanupStep({
    runId: params.runId,
    sessionId: params.sessionId,
    step: "bundle-mcp-retire",
    log,
    cleanup: async () => {
      const onError = (error: unknown, sessionId: string) => {
        log.warn(
          `bundle-mcp cleanup failed after run for ${sessionId}: ${formatErrorMessage(error)}`,
        );
      };
      const retiredBySessionKey = await retireSessionMcpRuntimeForSessionKey({
        sessionKey: params.sessionKey,
        reason: "embedded-run-end",
        preserveActiveLeases: true,
        onError,
      });
      if (!retiredBySessionKey) {
        await retireSessionMcpRuntime({
          sessionId: params.sessionId,
          reason: "embedded-run-end",
          preserveActiveLeases: true,
          onError,
        });
      }
    },
  });
}
