import type { AnyAgentTool } from "./tools/common.js";

/**
 * Select exactly one model-facing browser engine after every ordinary tool
 * policy has run. Browser Harness is exec-equivalent, so it is eligible only
 * when the same final surface also retained exec and the run is unsandboxed.
 */
export function selectBrowserModelTool(params: {
  tools: AnyAgentTool[];
  preferHarness: boolean;
  sandboxed: boolean;
}): AnyAgentTool[] {
  const nativeBrowser = params.tools.find((tool) => tool.name === "browser");
  const harnessBrowser = params.tools.find((tool) => tool.name === "browser_exec");
  const hasExec = params.tools.some((tool) => tool.name === "exec");
  const useHarness =
    params.preferHarness &&
    !params.sandboxed &&
    hasExec &&
    Boolean(nativeBrowser) &&
    Boolean(harnessBrowser);

  if (!useHarness) {
    return params.tools.filter((tool) => tool !== harnessBrowser);
  }

  if (!harnessBrowser) {
    return params.tools;
  }
  harnessBrowser.name = "browser";
  return params.tools.filter((tool) => tool !== nativeBrowser);
}
