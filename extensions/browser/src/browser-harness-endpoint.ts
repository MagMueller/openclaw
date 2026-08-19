import { isIP } from "node:net";

/** Reject endpoints the external Harness subprocess could resolve differently. */
export function assertStableHarnessWebSocketEndpoint(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) === 0) {
    throw new Error(
      `Browser Harness cannot safely re-resolve remote CDP hostname ${JSON.stringify(parsed.hostname)}. Use browser.modelEngine=native for this profile until the Harness connection is routed through OpenClaw's pinned CDP broker.`,
    );
  }
  return wsUrl;
}
