/**
 * In-memory turn budget owned by one trusted local agent invocation.
 *
 * The ordinary loop receives maxTurns - 1 slots. The remaining slot is reserved
 * for one isolated, capability-free final answer after a settled tool turn.
 */
export type AssistantTurnBudget = {
  readonly maxTurns: number;
  readonly ordinaryTurnLimit: number;
  readonly completedOrdinaryTurns: number;
  readonly finalizationStarted: boolean;
  readonly remainingOrdinaryTurns: number;
  beginAttempt(): AssistantTurnAttemptBudget;
  tryBeginFinalization(): boolean;
};

export type AssistantTurnAttemptBudget = {
  readonly reachedLimit: boolean;
  /** Records a fully completed assistant turn after its tool batch has settled. */
  recordCompletedTurn(): boolean;
  /** Reconciles error/abort turns that terminate before the graceful-stop hook. */
  reconcileCompletedTurns(completedTurns: number): void;
};

export function createAssistantTurnBudget(maxTurns: number): AssistantTurnBudget {
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 2) {
    throw new Error("Assistant turn budget must be an integer greater than or equal to 2");
  }
  const ordinaryTurnLimit = maxTurns - 1;
  let completedOrdinaryTurns = 0;
  let finalizationStarted = false;

  const budget: AssistantTurnBudget = {
    maxTurns,
    ordinaryTurnLimit,
    get completedOrdinaryTurns() {
      return completedOrdinaryTurns;
    },
    get finalizationStarted() {
      return finalizationStarted;
    },
    get remainingOrdinaryTurns() {
      return Math.max(0, ordinaryTurnLimit - completedOrdinaryTurns);
    },
    beginAttempt() {
      let recordedTurns = 0;
      let reachedLimit = false;
      return {
        get reachedLimit() {
          return reachedLimit;
        },
        recordCompletedTurn() {
          recordedTurns += 1;
          if (completedOrdinaryTurns < ordinaryTurnLimit) {
            completedOrdinaryTurns += 1;
          }
          reachedLimit = completedOrdinaryTurns >= ordinaryTurnLimit;
          return reachedLimit;
        },
        reconcileCompletedTurns(completedTurns: number) {
          const normalized =
            Number.isSafeInteger(completedTurns) && completedTurns > 0 ? completedTurns : 0;
          while (recordedTurns < normalized && completedOrdinaryTurns < ordinaryTurnLimit) {
            recordedTurns += 1;
            completedOrdinaryTurns += 1;
          }
          reachedLimit = completedOrdinaryTurns >= ordinaryTurnLimit;
        },
      };
    },
    tryBeginFinalization() {
      if (finalizationStarted || completedOrdinaryTurns >= maxTurns) {
        return false;
      }
      finalizationStarted = true;
      return true;
    },
  };
  return budget;
}
