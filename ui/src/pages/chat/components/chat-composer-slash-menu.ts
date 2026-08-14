import { html, nothing, type TemplateResult } from "lit";
import {
  parseCommandArgs,
  splitCommandArgDraft,
} from "../../../../../src/auto-reply/commands-invocation.js";
import type { CommandArgValues } from "../../../../../src/auto-reply/commands-registry.types.js";
import { icons, type IconName } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import {
  acceptsSlashCommandArgs,
  buildSlashCommandText,
  getSlashCommandArgs,
  getSlashCommandCategoryLabel,
  getSlashCommandCompletions,
  getSlashCommandDescription,
  ownsRawArgumentTail,
  resolveSlashCommandArgChoices,
  SLASH_COMMANDS,
  type SlashCommandArgChoice,
  type SlashCommandArgScope,
  type SlashCommandCategory,
  type SlashCommandDef,
} from "../../../lib/chat/commands.ts";
import { exportChatMarkdown } from "../export.ts";
import { commitComposerDraft, getChatComposerState } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState, SlashArgStage } from "./chat-composer-types.ts";

export function resetSlashMenuState(state: ChatComposerState): void {
  state.slashMenuStage = null;
  state.slashMenuItems = [];
}

function hasVisibleSlashMenuState(state: ChatComposerState): boolean {
  return state.slashMenuOpen || state.slashMenuStage !== null || state.slashMenuItems.length > 0;
}

function closeSlashMenuIfNeeded(state: ChatComposerState, requestUpdate: () => void): void {
  if (!hasVisibleSlashMenuState(state)) {
    return;
  }
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  requestUpdate();
}

/**
 * Active model context for provider-dependent choices such as /think levels.
 * Without it those providers fall back to their own defaults, which can offer
 * levels the active model does not support.
 */
function getSlashArgScope(props: ChatComposerProps): SlashCommandArgScope | undefined {
  const model = props.sessions?.sessions?.find((row) => row.key === props.sessionKey)?.model;
  if (!model) {
    return undefined;
  }
  const separator = model.indexOf("/");
  if (separator === -1) {
    return { model };
  }
  return { provider: model.slice(0, separator), model: model.slice(separator + 1) };
}

function findSlashCommandByName(name: string): SlashCommandDef | undefined {
  const normalized = name.toLowerCase();
  return SLASH_COMMANDS.find(
    (command) =>
      command.name === normalized ||
      command.aliases?.some((alias) => alias.replace(/^\//u, "").toLowerCase() === normalized),
  );
}

/**
 * Builds the stage for the next argument still missing a value, or null when the
 * command needs nothing more. Commands that parse their own raw tail never get a
 * stage: their declared arguments describe the native registration surface, and
 * a stepped menu would assemble text the command does not accept.
 */
function buildSlashArgStage(
  command: SlashCommandDef,
  values: CommandArgValues,
  props: ChatComposerProps,
): SlashArgStage | null {
  if (!acceptsSlashCommandArgs(command) || ownsRawArgumentTail(command)) {
    return null;
  }
  const scope = getSlashArgScope(props);
  for (const arg of getSlashCommandArgs(command)) {
    if (values[arg.name] != null) {
      continue;
    }
    return {
      command,
      values,
      arg,
      choices: resolveSlashCommandArgChoices(command, arg, scope),
      input: "",
      needsValue: false,
    };
  }
  return null;
}

/** Command text assembled so far, shown as the staged input's prefix. */
function getSlashStagePrefix(stage: SlashArgStage): string {
  return buildSlashCommandText(stage.command, stage.values);
}

function openSlashArgStage(
  stage: SlashArgStage,
  props: ChatComposerProps,
  requestUpdate: () => void,
): void {
  const state = getChatComposerState(props.paneId);
  state.slashMenuStage = stage;
  state.slashMenuItems = [];
  state.slashMenuIndex = 0;
  state.slashMenuOpen = true;
  // The draft always carries the real command text. Keeping it there is what lets
  // the message box show exactly what will be sent, keeps a queued-message edit
  // from mistaking an open stage for an empty composer, and lets a typed command
  // and a menu-picked one share one state machine.
  commitComposerDraft(props, `${getSlashStagePrefix(stage)} `);
  requestUpdate();
}

/**
 * Runs the assembled command through the composer's normal send route. The text
 * comes from the canonical serializer, so a command that declares its own
 * argument format (`/exec host=…`, `/queue debounce:…`) is never space-joined
 * into syntax its parser rejects.
 */
function runStagedSlashCommand(
  command: SlashCommandDef,
  values: CommandArgValues,
  props: ChatComposerProps,
  requestUpdate: () => void,
): void {
  const state = getChatComposerState(props.paneId);
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  commitComposerDraft(props, buildSlashCommandText(command, values));
  props.onSend();
  queueMicrotask(() => state.composerTextarea?.focus({ preventScroll: true }));
  requestUpdate();
}

/**
 * Commits the current stage and advances to the next declared argument, running
 * the command once nothing remains. An empty value ends collection: that is what
 * keeps trailing optional arguments optional and keeps a bare invocation such as
 * `/think` (a status query, not a change) reachable from the menu.
 */
export function commitSlashArgValue(
  value: string,
  props: ChatComposerProps,
  requestUpdate: () => void,
): void {
  const state = getChatComposerState(props.paneId);
  const stage = state.slashMenuStage;
  if (!stage) {
    return;
  }
  const values = value ? { ...stage.values, [stage.arg.name]: value } : stage.values;
  const next = value ? buildSlashArgStage(stage.command, values, props) : null;
  if (next) {
    openSlashArgStage(next, props, requestUpdate);
    return;
  }
  runStagedSlashCommand(stage.command, values, props, requestUpdate);
}

/** Opens a stage for the chosen command, or prepares the draft when it takes none. */
function beginSlashCommand(
  cmd: SlashCommandDef,
  props: ChatComposerProps,
  requestUpdate: () => void,
  submit: boolean,
): void {
  const state = getChatComposerState(props.paneId);
  const stage = buildSlashArgStage(cmd, {}, props);
  if (stage) {
    openSlashArgStage(stage, props, requestUpdate);
    return;
  }
  // A command that takes no arguments must run bare instead of leaving a draft
  // the operator has to send by hand; one that owns its raw tail gets the draft
  // prepared so the tail can be typed in the message box.
  if (!acceptsSlashCommandArgs(cmd)) {
    state.slashMenuOpen = false;
    resetSlashMenuState(state);
    commitComposerDraft(props, `/${cmd.name}`);
    if (submit) {
      props.onSend();
    }
    requestUpdate();
    return;
  }
  commitComposerDraft(props, `/${cmd.name} `);
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  requestUpdate();
}

export function selectSlashCommand(
  cmd: SlashCommandDef,
  props: ChatComposerProps,
  requestUpdate: () => void,
) {
  beginSlashCommand(cmd, props, requestUpdate, true);
}

export function tabCompleteSlashCommand(
  cmd: SlashCommandDef,
  props: ChatComposerProps,
  requestUpdate: () => void,
) {
  beginSlashCommand(cmd, props, requestUpdate, false);
}

function requestSlashCommandRefresh(
  value: string,
  props: ChatComposerProps,
  requestUpdate: () => void,
  getCurrentValue?: () => string,
): void {
  const state = getChatComposerState(props.paneId);
  if (!props.onSlashIntent || state.slashCommandRefreshPending) {
    return;
  }
  const refresh = props.onSlashIntent();
  if (!refresh || typeof refresh.then !== "function") {
    return;
  }
  state.slashCommandRefreshPending = true;
  void Promise.resolve(refresh).finally(() => {
    state.slashCommandRefreshPending = false;
    const nextValue = getCurrentValue?.() ?? props.getDraft?.() ?? value;
    if (!nextValue.startsWith("/")) {
      closeSlashMenuIfNeeded(state, requestUpdate);
      return;
    }
    updateSlashMenu(nextValue, requestUpdate, props, { skipSlashIntent: true });
  });
}

/**
 * Derives the menu from the draft. A bare `/name` fragment lists commands; once
 * a separator is typed the same stage machinery the menu uses takes over, so
 * `/tools ` offers its options instead of closing the suggestions.
 */
export function updateSlashMenu(
  value: string,
  requestUpdate: () => void,
  props: ChatComposerProps,
  opts: { skipSlashIntent?: boolean } = {},
  getCurrentValue?: () => string,
): void {
  const state = getChatComposerState(props.paneId);
  const commandMatch = value.match(/^\/(\S*)$/u);
  if (commandMatch) {
    if (!opts.skipSlashIntent) {
      requestSlashCommandRefresh(value, props, requestUpdate, getCurrentValue);
    }
    const items = getSlashCommandCompletions(commandMatch[1] ?? "", { showAll: true });
    state.slashMenuItems = items;
    state.slashMenuOpen = items.length > 0;
    state.slashMenuIndex = 0;
    state.slashMenuStage = null;
    requestUpdate();
    return;
  }

  const argMatch = value.match(/^\/(\S+)\s([\s\S]*)$/u);
  const command = argMatch ? findSlashCommandByName(argMatch[1] ?? "") : undefined;
  if (!argMatch || !command) {
    closeSlashMenuIfNeeded(state, requestUpdate);
    return;
  }
  // The segment still being typed filters the current argument's options rather
  // than committing a value, so it is held back from the parsed set. The split
  // follows the executor's own rule: an argument declared captureRemaining owns
  // the whole tail, so `/name Release prep` keeps typing one title instead of
  // committing "Release" and filtering on "prep".
  const { committed, input } = splitCommandArgDraft(command.definition, argMatch[2] ?? "");
  const parsed = parseCommandArgs(command.definition, committed);
  const stage = buildSlashArgStage(command, parsed?.values ?? {}, props);
  if (!stage) {
    closeSlashMenuIfNeeded(state, requestUpdate);
    return;
  }
  stage.input = input;
  state.slashMenuStage = stage;
  state.slashMenuItems = [];
  state.slashMenuIndex = 0;
  state.slashMenuOpen = true;
  requestUpdate();
}

function slashOptionIdSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "item"
  );
}

export function paneDomId(paneId: string, suffix: string): string {
  return `chat-${encodeURIComponent(paneId)}-${suffix}`;
}

function getSlashCommandOptionId(paneId: string, cmd: SlashCommandDef): string {
  return paneDomId(paneId, `slash-option-command-${slashOptionIdSegment(cmd.name)}`);
}

function getSlashArgOptionId(paneId: string, commandName: string, arg: string): string {
  return paneDomId(
    paneId,
    `slash-option-arg-${slashOptionIdSegment(commandName)}-${slashOptionIdSegment(arg)}`,
  );
}

/** Choices left after the stage's filter; empty on a free-value stage. */
function getSlashStageChoices(stage: SlashArgStage): SlashCommandArgChoice[] {
  const filter = stage.input.trim().toLowerCase();
  if (!filter) {
    return stage.choices;
  }
  return stage.choices.filter(
    (choice) =>
      choice.value.toLowerCase().includes(filter) || choice.label.toLowerCase().includes(filter),
  );
}

/** Options the message textarea drives while a command tail is being collected. */
export function getSlashArgDraftChoices(state: ChatComposerState): SlashCommandArgChoice[] {
  const stage = state.slashMenuStage;
  if (!stage) {
    return [];
  }
  return getSlashStageChoices(stage);
}

/**
 * Records a refused submit when the pending argument is required and still
 * empty. Returns true when the key was consumed, so the caller stops before the
 * send path turns a missing value into a bare command.
 */
export function refuseEmptyRequiredSlashArg(
  props: ChatComposerProps,
  requestUpdate: () => void,
): boolean {
  const state = getChatComposerState(props.paneId);
  const stage = state.slashMenuStage;
  if (!stage || stage.arg.required !== true || stage.input.trim().length > 0) {
    return false;
  }
  stage.needsValue = true;
  requestUpdate();
  return true;
}

/**
 * ARIA the message textarea must carry while it collects a command argument.
 * With one input, the textarea is the combobox, so the argument's label and its
 * refusal state have to be announced there or they are announced nowhere.
 */
export function getSlashArgTextareaAria(
  state: ChatComposerState,
): { label: string; required: boolean; invalid: boolean } | null {
  const stage = state.slashMenuStage;
  if (!state.slashMenuOpen || !stage) {
    return null;
  }
  return {
    label: t("chat.commands.argValueLabel", { arg: stage.arg.name }),
    required: stage.arg.required === true,
    invalid: stage.needsValue,
  };
}

export function isSlashMenuVisible(state: ChatComposerState): boolean {
  if (!state.slashMenuOpen) {
    return false;
  }
  // A stage is visible even with no options: its header carries the argument
  // prompt and the refusal text, and hiding it is what made a refused submit
  // look like a dead key.
  if (state.slashMenuStage) {
    return true;
  }
  return state.slashMenuItems.length > 0;
}

export function getActiveSlashMenuOptionId(
  state: ChatComposerState,
  paneId: string,
): string | null {
  if (!isSlashMenuVisible(state)) {
    return null;
  }
  const stage = state.slashMenuStage;
  if (stage) {
    const choice = getSlashStageChoices(stage)[state.slashMenuIndex];
    return choice ? getSlashArgOptionId(paneId, stage.command.name, choice.value) : null;
  }
  const cmd = state.slashMenuItems[state.slashMenuIndex];
  return cmd ? getSlashCommandOptionId(paneId, cmd) : null;
}

export function getActiveSlashMenuOptionLabel(state: ChatComposerState): string {
  const stage = state.slashMenuStage;
  if (stage) {
    const choice = isSlashMenuVisible(state)
      ? getSlashStageChoices(stage)[state.slashMenuIndex]
      : undefined;
    const step = `${getSlashStagePrefix(stage)} [${stage.arg.name}]`;
    return choice ? `${step} ${choice.label}` : step;
  }
  if (!isSlashMenuVisible(state)) {
    return "";
  }
  const cmd = state.slashMenuItems[state.slashMenuIndex];
  if (!cmd) {
    return "";
  }
  const command = `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`;
  return `${command} ${getSlashCommandDescription(cmd)}`;
}

export function scrollActiveSlashMenuOptionIntoView(
  state: ChatComposerState,
  paneId: string,
): void {
  const activeId = getActiveSlashMenuOptionId(state, paneId);
  if (!activeId) {
    return;
  }
  requestAnimationFrame(() => {
    const activeOption = document.getElementById(activeId);
    const scrollRegion = activeOption?.closest<HTMLElement>(".slash-menu__scroll");
    if (!activeOption || !scrollRegion) {
      return;
    }
    const menuBounds = scrollRegion.getBoundingClientRect();
    const optionBounds = activeOption.getBoundingClientRect();
    // scrollIntoView also moves the short-landscape composer and page. Keep
    // keyboard navigation owned by the menu so textarea focus stays stable.
    if (optionBounds.top < menuBounds.top) {
      scrollRegion.scrollTop -= menuBounds.top - optionBounds.top;
    } else if (optionBounds.bottom > menuBounds.bottom) {
      scrollRegion.scrollTop += optionBounds.bottom - menuBounds.bottom;
    }
  });
}

function renderSlashIcon(name: string) {
  return icons[name as IconName] ?? icons.terminal;
}

/**
 * Option count for the menu badge. A provider-dependent set is a resolver
 * function, not an array, so it has no count to advertise before the stage opens.
 */
function countStaticChoices(cmd: SlashCommandDef): number {
  const choices = getSlashCommandArgs(cmd)[0]?.choices;
  return Array.isArray(choices) ? choices.length : 0;
}

export function exportMarkdown(props: Pick<ChatComposerProps, "messages" | "assistantName">): void {
  exportChatMarkdown(props.messages, props.assistantName);
}

/**
 * The one line that tells the operator what this stage wants, or why the last
 * key did nothing. A refused submit that renders no text is the silent-failure
 * case this surface exists to prevent.
 */
function getSlashArgHint(stage: SlashArgStage): string {
  if (stage.needsValue) {
    return t("chat.commands.argNeedsValue");
  }
  // The declared description is what tells the operator what to type
  // ("Duration (24h, 90m) or off"); the bare argument name is the fallback for
  // arguments that declare none.
  return stage.arg.description || stage.arg.name;
}

function renderSlashArgOptions(
  stage: SlashArgStage,
  state: ChatComposerState,
  props: ChatComposerProps,
  requestUpdate: () => void,
  listboxId: string,
): TemplateResult | typeof nothing {
  const choices = getSlashStageChoices(stage);
  const refused = stage.needsValue;
  return html`
    <div
      id=${listboxId}
      class="slash-menu"
      role="listbox"
      aria-label=${t("chat.commands.arguments")}
    >
      <div class="slash-menu__scroll">
        <div class="slash-menu-group">
          <div class="slash-menu-group__label slash-menu-group__label--stage">
            <span class="slash-menu-group__prefix">${getSlashStagePrefix(stage)}</span>
            <span
              class="slash-menu-group__hint ${refused ? "slash-menu-group__hint--needed" : ""}"
              aria-live="polite"
              >${getSlashArgHint(stage)}</span
            >
          </div>
          ${choices.map(
            (choice, i) => html`
              <div
                id=${getSlashArgOptionId(props.paneId, stage.command.name, choice.value)}
                class="slash-menu-item ${i === state.slashMenuIndex
                  ? "slash-menu-item--active"
                  : ""}"
                role="option"
                aria-selected=${i === state.slashMenuIndex}
                @click=${() => commitSlashArgValue(choice.value, props, requestUpdate)}
                @mouseenter=${() => {
                  state.slashMenuIndex = i;
                  requestUpdate();
                }}
              >
                <span class="slash-menu-leading">
                  <span class="slash-menu-icon"
                    >${stage.command.icon ? renderSlashIcon(stage.command.icon) : nothing}</span
                  >
                  <span class="slash-menu-name">${choice.label}</span>
                </span>
                <span class="slash-menu-trailing">
                  <span class="slash-menu-desc">
                    ${getSlashStagePrefix(stage)} ${choice.value}
                  </span>
                </span>
              </div>
            `,
          )}
        </div>
      </div>
    </div>
  `;
}

export function renderSlashMenu(
  requestUpdate: () => void,
  props: ChatComposerProps,
  draft: string,
): TemplateResult | typeof nothing {
  const state = getChatComposerState(props.paneId);
  const listboxId = paneDomId(props.paneId, "slash-menu-listbox");
  if (!state.slashMenuOpen) {
    return nothing;
  }

  const stage = state.slashMenuStage;
  if (stage) {
    return renderSlashArgOptions(stage, state, props, requestUpdate, listboxId);
  }

  if (state.slashMenuItems.length === 0) {
    return nothing;
  }

  const groups: Array<[SlashCommandCategory, Array<{ cmd: SlashCommandDef; globalIdx: number }>]> =
    [];
  for (const [globalIdx, cmd] of state.slashMenuItems.entries()) {
    const category = cmd.category ?? "session";
    const group =
      draft === "/" ? groups.find(([groupCategory]) => groupCategory === category) : groups.at(-1);
    if (group?.[0] === category) {
      group[1].push({ cmd, globalIdx });
    } else {
      groups.push([category, [{ cmd, globalIdx }]]);
    }
  }

  const sections = groups.map(
    ([category, entries]) => html`
      <div class="slash-menu-group">
        <div class="slash-menu-group__label">${getSlashCommandCategoryLabel(category)}</div>
        ${entries.map(
          ({ cmd, globalIdx }) => html`
            <div
              id=${getSlashCommandOptionId(props.paneId, cmd)}
              class="slash-menu-item ${globalIdx === state.slashMenuIndex
                ? "slash-menu-item--active"
                : ""}"
              role="option"
              aria-selected=${globalIdx === state.slashMenuIndex}
              @click=${() => selectSlashCommand(cmd, props, requestUpdate)}
              @mouseenter=${() => {
                state.slashMenuIndex = globalIdx;
                requestUpdate();
              }}
            >
              <span class="slash-menu-leading">
                <span class="slash-menu-icon"
                  >${cmd.icon ? renderSlashIcon(cmd.icon) : nothing}</span
                >
                <span class="slash-menu-name">/${cmd.name}</span>
                ${cmd.args ? html`<span class="slash-menu-args">${cmd.args}</span>` : nothing}
              </span>
              <span class="slash-menu-trailing">
                <span class="slash-menu-desc">${getSlashCommandDescription(cmd)}</span>
                ${countStaticChoices(cmd)
                  ? html`<span class="slash-menu-badge"
                      >${t("chat.commands.optionCount", {
                        count: String(countStaticChoices(cmd)),
                      })}</span
                    >`
                  : nothing}
              </span>
            </div>
          `,
        )}
      </div>
    `,
  );

  return html`
    <div id=${listboxId} class="slash-menu" role="listbox" aria-label=${t("chat.commands.menu")}>
      <div class="slash-menu__scroll">${sections}</div>
    </div>
  `;
}
