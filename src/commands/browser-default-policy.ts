import { listAgentEntries } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Whether setup may add browser without widening any authored tool policy. */
export function shouldAddDefaultBrowser(config: OpenClawConfig): boolean {
  const implicitDefaults = config.agents?.defaults;
  const implicitDefaultTools =
    implicitDefaults && "tools" in implicitDefaults ? implicitDefaults.tools : undefined;
  if (
    implicitDefaultTools !== undefined ||
    listAgentEntries(config).some((entry) => entry.tools !== undefined)
  ) {
    return false;
  }
  const tools = config.tools;
  return !(
    tools?.profile !== undefined ||
    tools?.allow !== undefined ||
    tools?.alsoAllow !== undefined ||
    tools?.deny !== undefined ||
    tools?.byProvider !== undefined ||
    tools?.toolsBySender !== undefined
  );
}
