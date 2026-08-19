import { isIP } from "node:net";

/** Whether a subprocess can reuse the endpoint without performing a second DNS resolution. */
export function hasStableHarnessEndpointHostname(endpointUrl: string): boolean {
  try {
    const hostname = new URL(endpointUrl).hostname.replace(/^\[|\]$/g, "");
    return isIP(hostname) !== 0;
  } catch {
    return false;
  }
}

/** Reject endpoints the external Harness subprocess could resolve differently. */
export function assertStableHarnessWebSocketEndpoint(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  if (!hasStableHarnessEndpointHostname(wsUrl)) {
    throw new Error(
      `Browser Harness cannot safely re-resolve remote CDP hostname ${JSON.stringify(parsed.hostname)}. Use browser.modelEngine=native for this profile until the Harness connection is routed through OpenClaw's pinned CDP broker.`,
    );
  }
  return wsUrl;
}
