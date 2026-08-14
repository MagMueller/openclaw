// Composer argument staging: one stage per declared argument, never a chat turn.
import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { defineChatCommand } from "../../../../../src/auto-reply/commands-registry.shared.js";
import { makeSlashCommand } from "../../../lib/chat/commands.ln.ts";
import { SLASH_COMMANDS, type SlashCommandDef } from "../../../lib/chat/commands.ts";
import {
  commitSlashArgValue,
  isSlashMenuVisible,
  renderSlashMenu,
  selectSlashCommand,
  updateSlashMenu,
} from "./chat-composer-slash-menu.ts";
import { getChatComposerState, resetChatComposerState } from "./chat-composer-state.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";

const PANE_ID = "slash-arg-stage-pane";

type Harness = {
  props: ChatComposerProps;
  container: HTMLElement;
  requestUpdate: () => void;
  sent: string[];
  draft: () => string;
  stage: () => ReturnType<typeof getChatComposerState>["slashMenuStage"];
  prefix: () => string;
  hint: () => string;
  type: (draft: string) => void;
  pick: (value: string) => void;
  options: () => HTMLElement[];
  activeOption: () => HTMLElement | null;
};

function createHarness(): Harness {
  const container = document.createElement("div");
  document.body.append(container);
  const sent: string[] = [];
  let draft = "";
  const props = {
    paneId: PANE_ID,
    // A getter keeps `props.draft` in step with the committed value, matching the
    // reactive host property the composer reads between renders.
    get draft() {
      return draft;
    },
    getDraft: () => draft,
    onDraftChange: (next: string) => {
      draft = next;
    },
    // Mirrors the host: a bare send reads the draft, so this records the text
    // the send owner would actually receive rather than composer state.
    onSend: () => {
      sent.push(draft);
    },
  } as unknown as ChatComposerProps;

  const requestUpdate = () => {
    const state = getChatComposerState(PANE_ID);
    render(
      html`${isSlashMenuVisible(state) ? renderSlashMenu(requestUpdate, props, draft) : nothing}`,
      container,
    );
  };

  return {
    props,
    container,
    requestUpdate,
    sent,
    draft: () => draft,
    stage: () => getChatComposerState(PANE_ID).slashMenuStage,
    prefix: () => container.querySelector(".slash-menu-group__prefix")?.textContent?.trim() ?? "",
    hint: () => container.querySelector(".slash-menu-group__hint")?.textContent?.trim() ?? "",
    // Mirrors typing into the message textarea: the draft is the only input, so
    // the stage is whatever the current command text implies.
    type: (next: string) => {
      draft = next;
      updateSlashMenu(next, requestUpdate, props);
    },
    pick: (value: string) => commitSlashArgValue(value, props, requestUpdate),
    options: () => [...container.querySelectorAll<HTMLElement>("[role='option']")],
    activeOption: () => container.querySelector<HTMLElement>(".slash-menu-item--active"),
  };
}

function requireCommand(name: string): SlashCommandDef {
  const command = SLASH_COMMANDS.find((entry) => entry.name === name);
  if (!command) {
    throw new Error(`missing slash command /${name}`);
  }
  return command;
}

function openCommand(harness: Harness, command: SlashCommandDef): void {
  selectSlashCommand(command, harness.props, harness.requestUpdate);
}

afterEach(() => {
  resetChatComposerState(PANE_ID);
  document.body.innerHTML = "";
});

describe("slash command argument staging", () => {
  it("runs an argument-free command straight from the menu", () => {
    const harness = createHarness();
    openCommand(harness, requireCommand("help"));

    expect(harness.stage()).toBeNull();
    expect(harness.sent).toEqual(["/help"]);
  });

  it("puts the real command text in the draft when a stage opens", () => {
    const harness = createHarness();
    openCommand(harness, requireCommand("tools"));

    // The draft is the single source of the pending command: the message box
    // shows exactly what will be sent, so dismissing the menu loses nothing.
    expect(harness.draft()).toBe("/tools ");
    expect(harness.stage()?.arg.name).toBe("mode");
    expect(
      harness
        .options()
        .map((option) => option.querySelector(".slash-menu-name")?.textContent?.trim()),
    ).toEqual(["compact", "verbose"]);
    expect(harness.hint()).toBe("mode");
    expect(harness.sent).toEqual([]);
  });

  it("offers resolved provider-dependent choices for /think", () => {
    const harness = createHarness();
    openCommand(harness, requireCommand("think"));

    expect(harness.stage()?.choices.map((choice) => choice.value)).toContain("high");
    expect(harness.options().length).toBeGreaterThan(1);
  });

  it("runs a single-argument command once its choice is picked", () => {
    const harness = createHarness();
    openCommand(harness, requireCommand("tools"));
    harness.pick("verbose");

    expect(harness.sent).toEqual(["/tools verbose"]);
    expect(harness.stage()).toBeNull();
  });

  it("chains a composite command instead of firing on the first choice", () => {
    const harness = createHarness();
    openCommand(harness, requireCommand("session"));
    harness.pick("idle");

    // The premature-dispatch bug: picking the action used to run the command.
    expect(harness.sent).toEqual([]);
    expect(harness.stage()?.arg.name).toBe("value");
    expect(harness.draft()).toBe("/session idle ");
    expect(harness.prefix()).toBe("/session idle");

    harness.pick("24h");

    expect(harness.sent).toEqual(["/session idle 24h"]);
  });

  it("accepts an empty optional trailing argument and runs what was collected", () => {
    const harness = createHarness();
    openCommand(harness, requireCommand("session"));
    harness.pick("idle");
    harness.pick("");

    expect(harness.sent).toEqual(["/session idle"]);
  });

  it("collects a free-form value for value-only commands", () => {
    const harness = createHarness();
    openCommand(harness, requireCommand("name"));

    expect(harness.stage()?.choices).toEqual([]);
    expect(harness.hint()).toBe("title");

    harness.pick("release prep");

    expect(harness.sent).toEqual(["/name release prep"]);
  });

  it("derives the same stage from a hand-typed command tail", () => {
    const harness = createHarness();
    harness.type("/session ");

    // A typed command and a menu-picked one converge on one state machine, so
    // the menu offers the same options either way.
    expect(harness.stage()?.arg.name).toBe("action");
    expect(
      harness
        .options()
        .map((option) => option.querySelector(".slash-menu-name")?.textContent?.trim()),
    ).toEqual(["idle", "max-age"]);

    harness.type("/session idle ");
    expect(harness.stage()?.arg.name).toBe("value");
    expect(harness.prefix()).toBe("/session idle");
  });

  it("filters choices from the typed tail and keeps the highlight in range", () => {
    const harness = createHarness();
    harness.type("/tools comp");

    expect(harness.options()).toHaveLength(1);
    expect(harness.options()[0]?.textContent).toContain("compact");
  });

  it("opens no stage for a command that parses its own raw tail", () => {
    const harness = createHarness();
    openCommand(harness, requireCommand("config"));

    // /config declares argsParsing "none", so the composer hands it a free draft
    // rather than serializing a stepped menu into syntax it never accepts.
    expect(harness.stage()).toBeNull();
    expect(harness.draft()).toBe("/config ");
    expect(harness.sent).toEqual([]);
  });

  it("degrades a dynamic argument the catalog could not resolve to a value stage", () => {
    const harness = createHarness();
    openCommand(
      harness,
      makeSlashCommand("plugin-think", {
        description: "Plugin thinking control.",
        definition: defineChatCommand({
          key: "plugin-think",
          description: "Plugin thinking control.",
          args: [{ name: "level", description: "Thinking level", type: "string" }],
        }),
      }),
    );

    expect(harness.stage()?.choices).toEqual([]);
    expect(harness.hint()).toBe("level");

    harness.pick("high");
    expect(harness.sent).toEqual(["/plugin-think high"]);
  });

  it("renders choice labels rather than raw values", () => {
    const harness = createHarness();
    openCommand(
      harness,
      makeSlashCommand("plugin-fast", {
        description: "Plugin fast mode.",
        definition: defineChatCommand({
          key: "plugin-fast",
          description: "Plugin fast mode.",
          args: [
            {
              name: "mode",
              description: "Fast mode",
              type: "string",
              choices: [{ value: "auto", label: "auto (45 sec)" }],
            },
          ],
        }),
      }),
    );

    // The label is what the operator reads; the value is what gets sent.
    expect(harness.container.querySelector(".slash-menu-name")?.textContent).toBe("auto (45 sec)");
    harness.pick("auto");
    expect(harness.sent).toEqual(["/plugin-fast auto"]);
  });
});
