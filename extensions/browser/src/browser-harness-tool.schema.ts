import { optionalStringEnum } from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";

const BROWSER_HARNESS_TARGETS = ["chrome", "cloud", "profile"] as const;

export const BrowserHarnessToolSchema = Type.Object(
  {
    code: Type.String({
      description:
        "Synchronous Python using Browser Harness helpers such as new_tab(), wait_for_load(), page_info(), cdp(), js(), click_at_xy(), fill_input(), and press_key(). There is no Playwright browser or page object and no asyncio setup. Print only the small result needed by the agent.",
    }),
    target: optionalStringEnum(BROWSER_HARNESS_TARGETS, {
      description:
        'Browser transport. Defaults to "chrome" (the user\'s OpenClaw extension); use "cloud" for Browser Use Cloud or "profile" for an OpenClaw CDP profile.',
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
