import {
  loadExecApprovals,
  maxAsk,
  minSecurity,
  resolveExecApprovalsFromFile,
  resolveExecModePolicy,
  type ExecAsk,
  type ExecMode,
  type ExecSecurity,
} from "../infra/exec-approvals.js";

/**
 * Whether an installed plugin may consume host exec without bypassing an
 * approval boundary. Final model-tool policy still has to retain `exec` and
 * the exact plugin tool before the run-local capability is activated.
 */
export function hasApprovalFreeHostExecAuthority(params: {
  agentId?: string;
  mode?: ExecMode;
  security?: ExecSecurity;
  ask?: ExecAsk;
  bypassHostApprovalFloors?: boolean;
}): boolean {
  const modePolicy = resolveExecModePolicy({
    mode: params.mode,
    security: params.security ?? "full",
    ask: params.ask ?? "off",
  });
  if (params.bypassHostApprovalFloors === true) {
    return modePolicy.security === "full" && modePolicy.ask === "off";
  }
  try {
    const hostPolicy = resolveExecApprovalsFromFile({
      file: loadExecApprovals(),
      agentId: params.agentId,
      overrides: { security: "full", ask: "off" },
    }).agent;
    return (
      minSecurity(modePolicy.security, hostPolicy.security) === "full" &&
      maxAsk(modePolicy.ask, hostPolicy.ask) === "off"
    );
  } catch {
    return false;
  }
}
