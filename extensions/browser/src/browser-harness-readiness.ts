import type { BrowserServerState } from "./browser/server-context.types.js";

type BrowserControlStateReader = () => BrowserServerState | null;

let readBrowserControlState: BrowserControlStateReader | undefined;

/** Install the Browser runtime's in-process state reader without eagerly loading that runtime. */
export function configureBrowserHarnessReadinessStateReader(
  reader: BrowserControlStateReader | undefined,
): void {
  readBrowserControlState = reader;
}

/**
 * True only while the exact extension-backed profile relay has completed its extension hello.
 * This deliberately exposes no relay handle, credential, endpoint, or browser identity.
 */
export function isBrowserHarnessExtensionTargetReady(profileName: string): boolean {
  try {
    const state = readBrowserControlState?.();
    const profiles = state?.resolved.profiles;
    const profile = profiles && Object.hasOwn(profiles, profileName) ? profiles[profileName] : null;
    if (profile?.driver !== "extension") {
      return false;
    }
    return state?.extensionRelays?.get(profileName)?.bridge.extensionConnected === true;
  } catch {
    return false;
  }
}
