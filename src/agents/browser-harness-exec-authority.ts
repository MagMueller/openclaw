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
 * Browser Harness accepts arbitrary Python on stdin. Only expose it when the
 * exact host-exec posture is already approval-free; otherwise a seemingly safe
 * binary approval could persist authority for different Python later.
 */
export function hasApprovalFreeBrowserHarnessExecAuthority(params: {
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
    // Existing/corrupt approval state is a security boundary. Normal exec will
    // surface its detailed migration or parse error if the operator calls it.
    return false;
  }
}
