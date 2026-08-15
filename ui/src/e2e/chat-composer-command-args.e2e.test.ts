// Control UI E2E covers staged slash command arguments end to end.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI staged command arguments",
});

const ARTIFACT_DIR = path.resolve(".artifacts/control-ui-e2e/command-args");
const VIEWPORT = { height: 900, width: 1280 } as const;
const THEMES = ["light", "dark"] as const;

type Theme = (typeof THEMES)[number];

/**
 * No command catalog is published, so the composer keeps the browser-safe
 * fallback registry. Every command exercised below is therefore a real builtin
 * with its real declared arguments — including the provider-dependent choice
 * sets that this PR resolves locally.
 */
function startupResponse(sessionId: string) {
  return {
    agentsList: {
      agents: [{ id: "main", name: "OpenClaw" }],
      defaultId: "main",
      mainKey: "main",
      scope: "agent" as const,
    },
    messages: [],
    metadata: { models: [] },
    sessionId,
    thinkingLevel: null,
  };
}

type Fixture = {
  page: Page;
  gateway: Awaited<ReturnType<typeof installMockGateway>>;
  composer: ReturnType<Page["locator"]>;
  menu: ReturnType<Page["locator"]>;
  stagePrefix: ReturnType<Page["locator"]>;
  stageHint: ReturnType<Page["locator"]>;
  shot: (name: string) => Promise<void>;
  optionLabels: () => Promise<string[]>;
  sentMessages: () => Promise<unknown[]>;
};

async function openChat(page: Page, theme: Theme, sessionId: string): Promise<Fixture> {
  const gateway = await installMockGateway(page, {
    methodResponses: { "chat.startup": startupResponse(sessionId) },
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  await gateway.waitForRequest("chat.startup");
  // Proves the forced colour scheme reached the app shell, so a "dark" artifact
  // can never be a light screenshot wearing a dark filename.
  await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(theme);

  const composer = page.locator(".agent-chat__composer-combobox textarea");
  await composer.waitFor({ state: "visible" });
  await expect.poll(() => composer.isEnabled()).toBe(true);

  const menu = page.locator(".slash-menu[role='listbox']");
  return {
    page,
    gateway,
    composer,
    menu,
    stagePrefix: page.locator(".slash-menu-group__prefix"),
    stageHint: page.locator(".slash-menu-group__hint"),
    // The slash menu is `position: absolute; bottom: 100%`, so it lives entirely
    // outside the composer shell's box. Clipping to the shell alone silently drops
    // the option list -- the exact thing these captures exist to show -- so union
    // the shell with the menu whenever the menu is open.
    shot: async (name: string) => {
      const shell = await page.locator(".agent-chat__composer-shell").boundingBox();
      if (!shell) {
        throw new Error(`composer shell not visible for shot ${name}`);
      }
      const popup = (await menu.isVisible()) ? await menu.boundingBox() : null;
      const top = Math.min(shell.y, popup?.y ?? shell.y);
      const bottom = Math.max(shell.y + shell.height, (popup?.y ?? 0) + (popup?.height ?? 0));
      const left = Math.min(shell.x, popup?.x ?? shell.x);
      const right = Math.max(shell.x + shell.width, (popup?.x ?? 0) + (popup?.width ?? 0));
      const pad = 8;
      await page.screenshot({
        animations: "disabled",
        clip: {
          x: Math.max(0, left - pad),
          y: Math.max(0, top - pad),
          width: right - left + pad * 2,
          height: bottom - top + pad * 2,
        },
        path: path.join(ARTIFACT_DIR, `${theme}-${name}.png`),
      });
    },
    optionLabels: () => menu.getByRole("option").locator(".slash-menu-name").allTextContents(),
    sentMessages: async () =>
      (await gateway.getRequests("chat.send")).map((request) =>
        typeof request.params === "object" && request.params !== null && "message" in request.params
          ? request.params.message
          : null,
      ),
  };
}

/** Opens the command menu and selects the highlighted entry. */
async function pickCommand(fixture: Fixture, typed: string): Promise<void> {
  await fixture.composer.fill(typed);
  await fixture.menu.waitFor({ state: "visible" });
}

async function waitForSentCount(fixture: Fixture, count: number): Promise<void> {
  await expect.poll(async () => (await fixture.sentMessages()).length).toBe(count);
}

suite.define(() => {
  for (const theme of THEMES) {
    it(`class A — argument-free commands run straight from the menu (${theme})`, async () => {
      await mkdir(ARTIFACT_DIR, { recursive: true });
      await suite.withPage({ colorScheme: theme, viewport: VIEWPORT }, async ({ page }) => {
        const f = await openChat(page, theme, `cmdargs-a-${theme}`);

        await pickCommand(f, "/help");
        await expect.poll(() => f.optionLabels()).toContain("/help");
        await f.shot("a1-menu-filtered");

        await f.composer.press("Enter");
        // No declared arguments: no stage, and the draft is consumed by the send.
        await expect.poll(() => f.menu.count()).toBe(0);
        await expect.poll(() => f.composer.inputValue()).toBe("");
        expect(await f.sentMessages()).toEqual([]);

        const noArgCommands = ["commands", "tasks", "whoami", "unfocus", "restart"];
        for (const [index, command] of noArgCommands.entries()) {
          await pickCommand(f, `/${command}`);
          await f.composer.press("Enter");
          await waitForSentCount(f, index + 1);
        }
        expect(await f.sentMessages()).toEqual([
          "/commands",
          "/tasks",
          "/whoami",
          "/unfocus",
          "/restart",
        ]);
        await f.shot("a2-executed");
      });
    });

    it(`class B — a single enum stages its choices and dispatches (${theme})`, async () => {
      await mkdir(ARTIFACT_DIR, { recursive: true });
      await suite.withPage({ colorScheme: theme, viewport: VIEWPORT }, async ({ page }) => {
        const f = await openChat(page, theme, `cmdargs-b-${theme}`);

        await pickCommand(f, "/tools");
        // The menu advertises how many options sit behind the command.
        await expect
          .poll(() => page.locator(".slash-menu-badge").first().textContent())
          .toContain("2");
        await f.shot("b1-menu-option-badge");

        await f.composer.press("Enter");
        await f.menu.waitFor({ state: "visible" });
        await expect.poll(() => f.optionLabels()).toEqual(["compact", "verbose"]);
        await expect.poll(() => f.composer.inputValue()).toBe("/tools ");
        await f.shot("b2-choices");

        await f.composer.fill("/tools invalid");
        await expect.poll(() => f.optionLabels()).toEqual([]);
        await f.composer.press("Enter");
        expect(await f.sentMessages()).toEqual([]);
        await expect.poll(() => f.stageHint.textContent()).toBe("Choose one of the listed values.");

        await f.composer.press("Escape");
        await pickCommand(f, "/tools");
        await f.composer.press("Enter");
        await f.menu.waitFor({ state: "visible" });
        await f.composer.press("Enter");
        await waitForSentCount(f, 1);
        expect(await f.sentMessages()).toEqual(["/tools"]);

        await pickCommand(f, "/tools");
        await f.composer.press("Enter");
        await f.menu.waitFor({ state: "visible" });

        // Arrow navigation moves the highlight; the staged input keeps focus.
        await f.composer.press("ArrowDown");
        await expect
          .poll(() => page.locator(".slash-menu-item--active .slash-menu-name").textContent())
          .toBe("verbose");
        await expect
          .poll(() => f.composer.evaluate((node) => document.activeElement === node))
          .toBe(true);
        await f.shot("b3-arrow-highlight");

        await f.composer.press("Enter");
        await waitForSentCount(f, 2);
        expect(await f.sentMessages()).toEqual(["/tools", "/tools verbose"]);
        await expect.poll(() => f.menu.count()).toBe(0);
        await f.shot("b4-dispatched");
      });
    });

    it(`class B-dyn — /think and /fast resolve their real option sets (${theme})`, async () => {
      await mkdir(ARTIFACT_DIR, { recursive: true });
      await suite.withPage({ colorScheme: theme, viewport: VIEWPORT }, async ({ page }) => {
        const f = await openChat(page, theme, `cmdargs-bdyn-${theme}`);

        await pickCommand(f, "/think");
        await f.composer.press("Enter");
        await f.menu.waitFor({ state: "visible" });
        // Previously this argument advertised nothing at all: the provider
        // dependent set was dropped and only a bare [level] hint remained.
        await expect
          .poll(() => f.optionLabels())
          .toEqual([
            "default",
            "off",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "adaptive",
            "max",
          ]);
        await f.shot("bdyn1-think-levels");

        // Filtering narrows the resolved set rather than the command list.
        await f.composer.fill("/think hi");
        await expect.poll(() => f.optionLabels()).toEqual(["high", "xhigh"]);
        await f.shot("bdyn2-think-filtered");

        await f.composer.press("Escape");
        await expect.poll(() => f.menu.count()).toBe(0);

        await pickCommand(f, "/fast");
        await f.composer.press("Enter");
        await f.menu.waitFor({ state: "visible" });
        const fastLabels = await f.optionLabels();
        expect(fastLabels.slice(0, 2)).toEqual(["on", "off"]);
        // The computed label survives instead of collapsing to its raw value.
        expect(fastLabels[2]).toMatch(/^auto \(\d+ sec\)$/u);
        await f.shot("bdyn3-fast-computed-label");
      });
    });

    it(`class C — a free-form value stages, cancels, and dispatches (${theme})`, async () => {
      await mkdir(ARTIFACT_DIR, { recursive: true });
      await suite.withPage({ colorScheme: theme, viewport: VIEWPORT }, async ({ page }) => {
        const f = await openChat(page, theme, `cmdargs-c-${theme}`);

        await pickCommand(f, "/name");
        await f.composer.press("Enter");
        await f.menu.waitFor({ state: "visible" });
        // The argument's own description becomes the prompt; a free-form value
        // has no options behind it, so the stage header is the whole menu.
        await expect
          .poll(() => f.stageHint.textContent())
          .toBe("New session name (omit to see a suggestion)");
        await expect.poll(() => f.optionLabels()).toEqual([]);
        await f.shot("c1-value-placeholder");

        // `title` is declared captureRemaining, so the whole tail stays one value:
        // the prompt must survive the space instead of committing "Release" and
        // treating "prep" as a filter over options that do not exist.
        await f.composer.fill("/name Release prep");
        await expect
          .poll(() => f.stageHint.textContent())
          .toBe("New session name (omit to see a suggestion)");
        await f.shot("c2-value-typed");

        // Escape closes the menu and keeps the text: the draft is the command,
        // so dismissing the option list must never throw away the operator's work.
        await f.composer.press("Escape");
        await expect.poll(() => f.menu.count()).toBe(0);
        await expect.poll(() => f.composer.inputValue()).toBe("/name Release prep");
        await expect
          .poll(() => f.composer.evaluate((node) => document.activeElement === node))
          .toBe(true);
        expect(await f.sentMessages()).toEqual([]);
        await f.shot("c3-escape-restored");

        await pickCommand(f, "/name");
        await f.composer.press("Enter");
        await f.menu.waitFor({ state: "visible" });
        await f.composer.fill("/name Release prep");
        await f.composer.press("Enter");
        await f.gateway.waitForRequest("chat.send");
        expect(await f.sentMessages()).toEqual(["/name Release prep"]);
        await f.shot("c4-dispatched");
      });
    });

    it(`class C — a required argument refuses to dispatch while empty (${theme})`, async () => {
      await mkdir(ARTIFACT_DIR, { recursive: true });
      await suite.withPage({ colorScheme: theme, viewport: VIEWPORT }, async ({ page }) => {
        const f = await openChat(page, theme, `cmdargs-creq-${theme}`);

        await pickCommand(f, "/redirect");
        await f.composer.press("Enter");
        await f.menu.waitFor({ state: "visible" });
        await expect.poll(() => f.stageHint.textContent()).toBe("Replacement message");
        await expect.poll(() => f.composer.getAttribute("aria-required")).toBe("true");
        await f.shot("creq1-required-empty");

        // The refusal has to be visible: an Enter that silently does nothing is
        // the worst outcome here, so the hint takes over and says why.
        await f.composer.press("Enter");
        expect(await f.sentMessages()).toEqual([]);
        await expect.poll(() => f.menu.count()).toBe(1);
        await expect.poll(() => f.stageHint.textContent()).toBe("Enter a value to continue");
        await expect.poll(() => f.composer.getAttribute("aria-invalid")).toBe("true");
        await f.shot("creq2-refused");

        // Typing clears the refusal instead of leaving a stale warning behind,
        // and the multi-word tail stays one captureRemaining value.
        await f.composer.fill("/redirect wrap it up");
        await expect.poll(() => f.stageHint.textContent()).toBe("Replacement message");
        await expect.poll(() => f.composer.getAttribute("aria-invalid")).toBe(null);
        await f.shot("creq3-recovered");
      });
    });

    it(`class D — a composite command chains every declared argument (${theme})`, async () => {
      await mkdir(ARTIFACT_DIR, { recursive: true });
      await suite.withPage({ colorScheme: theme, viewport: VIEWPORT }, async ({ page }) => {
        const f = await openChat(page, theme, `cmdargs-d-${theme}`);

        await pickCommand(f, "/session");
        await f.composer.press("Enter");
        await f.menu.waitFor({ state: "visible" });
        await expect.poll(() => f.optionLabels()).toEqual(["idle", "max-age"]);
        await f.shot("d1-action-choices");

        // An explicit action selection advances to the next argument without
        // dispatching /session idle before its duration is collected.
        await f.composer.fill("/session idle");
        await f.composer.press("Enter");
        expect(await f.sentMessages()).toEqual([]);
        await expect.poll(() => f.stagePrefix.textContent()).toBe("/session idle");
        // The second declared argument's description is the prompt for it.
        await expect.poll(() => f.stageHint.textContent()).toBe("Duration (24h, 90m) or off");
        await f.shot("d2-value-stage");

        await f.composer.fill("/session idle 24h");
        await expect.poll(() => f.stagePrefix.textContent()).toBe("/session idle");
        await f.shot("d3-duration-typed");

        await f.composer.press("Enter");
        await f.gateway.waitForRequest("chat.send");
        expect(await f.sentMessages()).toEqual(["/session idle 24h"]);
        await expect.poll(() => f.menu.count()).toBe(0);
        await f.shot("d4-dispatched");
      });
    });

    it(`class D-multi — a command that parses its own tail gets a free draft (${theme})`, async () => {
      await mkdir(ARTIFACT_DIR, { recursive: true });
      await suite.withPage({ colorScheme: theme, viewport: VIEWPORT }, async ({ page }) => {
        const f = await openChat(page, theme, `cmdargs-dmulti-${theme}`);

        // /exec declares arguments for native registration but sets
        // argsParsing "none" and its own formatter, so a stepped menu would
        // assemble space-joined text its parser rejects. The composer hands it
        // the real command text and lets the operator write the tail.
        await pickCommand(f, "/exec");
        await f.composer.press("Enter");
        await expect.poll(() => f.menu.count()).toBe(0);
        await expect.poll(() => f.composer.inputValue()).toBe("/exec ");
        await f.shot("dmulti1-free-draft");

        await f.composer.type("host=sandbox security=allowlist ask=on-miss node=worker-01");
        await f.composer.press("Enter");
        await f.gateway.waitForRequest("chat.send");
        expect(await f.sentMessages()).toEqual([
          "/exec host=sandbox security=allowlist ask=on-miss node=worker-01",
        ]);
        await f.shot("dmulti2-dispatched");
      });
    });

    it(`class F — accepted local argument tails reach the Gateway intact (${theme})`, async () => {
      await mkdir(ARTIFACT_DIR, { recursive: true });
      await suite.withPage({ colorScheme: theme, viewport: VIEWPORT }, async ({ page }) => {
        const f = await openChat(page, theme, `cmdargs-f-${theme}`);
        const cases = [
          ["/compact instructions", "/compact instructions"],
          ["/usage full", "/usage full"],
          ["/export-session path", "/export-session path"],
        ] as const;

        for (const [index, [draft, expected]] of cases.entries()) {
          await pickCommand(f, draft.slice(0, draft.indexOf(" ")));
          await f.composer.press("Enter");
          await f.menu.waitFor({ state: "visible" });
          await f.composer.fill(draft);
          await f.composer.press("Enter");
          await waitForSentCount(f, index + 1);
          expect(await f.sentMessages()).toContain(expected);
        }

        expect(await f.sentMessages()).toEqual(cases.map(([, expected]) => expected));
        await f.shot("f-accepted-values");
      });
    });

    it(`class E — untyped commands keep their existing free-text behaviour (${theme})`, async () => {
      await mkdir(ARTIFACT_DIR, { recursive: true });
      await suite.withPage({ colorScheme: theme, viewport: VIEWPORT }, async ({ page }) => {
        const f = await openChat(page, theme, `cmdargs-e-${theme}`);

        await pickCommand(f, "/status");
        await f.composer.press("Enter");
        // Declared non-goal: the catalog carries no argument shape for these, so
        // selection still writes the command into the draft and closes the menu.
        await expect.poll(() => f.menu.count()).toBe(0);
        await expect.poll(() => f.composer.inputValue()).toBe("/status ");
        await expect.poll(() => f.menu.count()).toBe(0);
        expect(await f.sentMessages()).toEqual([]);
        await f.shot("e1-untyped-unchanged");
      });
    });

    it(`accessibility — the staged input owns the combobox while staging (${theme})`, async () => {
      await mkdir(ARTIFACT_DIR, { recursive: true });
      await suite.withPage({ colorScheme: theme, viewport: VIEWPORT }, async ({ page }) => {
        const f = await openChat(page, theme, `cmdargs-a11y-${theme}`);

        await pickCommand(f, "/session");
        await f.composer.press("Enter");
        await f.menu.waitFor({ state: "visible" });

        // One input: the message textarea is the combobox, so it owns the role,
        // the listbox wiring, and the argument's accessible name.
        expect(await f.composer.getAttribute("role")).toBe("combobox");
        expect(await f.composer.getAttribute("aria-expanded")).toBe("true");
        expect(await f.composer.getAttribute("aria-controls")).toBeTruthy();
        expect(await f.composer.getAttribute("aria-activedescendant")).toBeTruthy();
        expect(await f.composer.getAttribute("aria-label")).toBe("Value for action");
        await f.shot("a11y1-staged-combobox");

        // Dispatching consumes the draft, so the stage's ARIA must go with it
        // rather than leaving the textarea pointing at a listbox that is gone.
        await f.composer.press("Enter");
        await f.composer.fill("/session idle 24h");
        await f.composer.press("Enter");
        await f.gateway.waitForRequest("chat.send");
        await expect.poll(() => f.menu.count()).toBe(0);
        expect(await f.composer.getAttribute("role")).toBeNull();
        expect(await f.composer.getAttribute("aria-controls")).toBeNull();
        expect(await f.composer.getAttribute("aria-expanded")).toBeNull();
        expect(await f.composer.getAttribute("aria-activedescendant")).toBeNull();
        await f.shot("a11y2-cleared-after-dispatch");
      });
    });
  }
});
