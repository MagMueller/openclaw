export const BROWSER_HARNESS_ORCHESTRATOR_EXISTING_DAEMON_ENV = "BH_ORCHESTRATOR_EXISTING_DAEMON";

export function hasBrowserHarnessOrchestratorBinding(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[BROWSER_HARNESS_ORCHESTRATOR_EXISTING_DAEMON_ENV] === "1";
}
