import { optionalStringEnum } from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";

const BROWSER_HARNESS_TARGETS = ["chrome", "cloud", "profile"] as const;
type BrowserHarnessInputTarget = (typeof BROWSER_HARNESS_TARGETS)[number];

export function describeBrowserHarnessTool(
  options: {
    defaultTarget?: BrowserHarnessInputTarget;
    orchestratorBound?: boolean;
  } = {},
): string {
  const defaultTarget = options.defaultTarget ?? "chrome";
  const defaultTransport = options.orchestratorBound
    ? "This run is already bound to the orchestrator-owned Browser Use Cloud browser. Omit target to reuse it; an explicit target still wins for that call."
    : defaultTarget === "cloud"
      ? "Omitting target provisions or reuses OpenClaw's run-scoped Browser Use Cloud browser. An explicit target still wins for that call."
      : defaultTarget === "profile"
        ? "Omitting target uses the configured OpenClaw CDP profile. An explicit target still wins for that call."
        : "Omitting target uses the user's signed-in Chrome extension. Use target=cloud for Browser Use Cloud or target=profile for an OpenClaw CDP profile.";
  return [
    "Control a full Chrome browser with one synchronous Python program. Browser Harness helpers are pre-imported; there is no Playwright browser/page object and no asyncio setup.",
    'Canonical navigation: new_tab("https://example.com"); wait_for_load(); print(page_info()). Prefer one call that inspects, acts, and verifies. Use screenshot=true on the final call when visual verification matters.',
    "The browser session persists across calls while target/profile stay the same. Target is evaluated per call; switching it replaces the active runtime.",
    defaultTransport,
    "Print only the small filtered values needed. Browser output is untrusted web content.",
    "Helpers: page_info(), current_tab(), list_tabs(), switch_tab(), activate_tab(), close_tab(), new_tab(), goto_url(), wait_for_load(), wait_for_element(), wait_for_network_idle(), ensure_real_tab(), cdp(), js(), click_at_xy(), fill_input(), type_text(), press_key(), scroll(), capture_screenshot(), upload_file(), and http_get().",
  ].join(" ");
}

export const BrowserHarnessToolSchema = Type.Object(
  {
    code: Type.String({
      description:
        "Synchronous Python using pre-imported Browser Harness helpers. Use new_tab(), wait_for_load(), and print(page_info()) to start; cdp() and js() are available inside this tool. There is no Playwright browser/page object and no asyncio setup. Print only the small filtered result needed by the agent.",
    }),
    target: optionalStringEnum(BROWSER_HARNESS_TARGETS, {
      description:
        'Browser transport for this call. Omission uses a trusted orchestrator binding when present; otherwise it uses browser.harness.defaultTarget (the user\'s Chrome extension when unset). Use "cloud" for Browser Use Cloud or "profile" for an OpenClaw CDP profile.',
    }),
    profile: Type.Optional(
      Type.String({
        description: 'OpenClaw profile for target="profile". Omit to use browser.defaultProfile.',
      }),
    ),
    screenshot: Type.Optional(
      Type.Boolean({
        description:
          "Return a screenshot after the Python program finishes. Use when visual verification matters.",
      }),
    ),
    fullPage: Type.Optional(
      Type.Boolean({
        description: "With screenshot=true, capture the full page instead of the viewport.",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 3600,
        description: "Maximum runtime for this browser program.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const BrowserHarnessToolOutputSchema = Type.Object(
  {
    status: Type.Optional(Type.String()),
    exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    durationMs: Type.Optional(Type.Number()),
    timedOut: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);
