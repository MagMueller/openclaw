// Pure session facts behind the community invite's cohort and live-eligibility
// checks in app-host.ts. Kept out of community-invite.runtime.ts (the lazy,
// post-qualification chunk) because these run on every render to decide whether
// that chunk should even load — a static import here must stay eager.

/** True once any session on the account carries a recorded human turn. A session
 * existing is not proof anyone used it — onboarding and agents can both create
 * one with nobody at the keyboard — so this reads the actual interaction fact
 * rather than counting session objects or page loads. */
export function hasRecordedInteraction(
  sessions: ReadonlyArray<{ lastInteractionAt?: number }>,
): boolean {
  return sessions.some((session) => typeof session.lastInteractionAt === "number");
}

/** True while any session has a run or subagent run in flight. The card must
 * defer to that: the operator may need to keep watching it, and a corner card
 * competing for attention during live output is the wrong moment to ask. */
export function hasActiveRunOrSubagent(
  sessions: ReadonlyArray<{ hasActiveRun?: boolean; hasActiveSubagentRun?: boolean }>,
): boolean {
  return sessions.some(
    (session) => session.hasActiveRun === true || session.hasActiveSubagentRun === true,
  );
}
