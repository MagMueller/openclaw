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
  const session = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const model = session?.model;
  const thinkingLevels = session?.thinkingLevels?.map(({ id, label }) => ({ id, label }));
  const fastAutoOnSeconds = session?.fastAutoOnSeconds;
  if (!model && !thinkingLevels?.length && fastAutoOnSeconds == null) {
    return undefined;
  }
  const scope = {
    ...(thinkingLevels?.length ? { thinkingLevels } : {}),
    ...(fastAutoOnSeconds != null ? { fastAutoOnSeconds } : {}),
  };
  if (!model) {
    return scope;
  }
  const separator = model.indexOf("/");
  if (separator === -1) {
    return { ...scope, model };
  }
  return {
    ...scope,
    provider: model.slice(0, separator),
    model: model.slice(separator + 1),
  };
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
      invalidChoice: false,
    };
  }
  return null;
}

type SlashMenuResolution = {
  open: boolean;
  items: SlashCommandDef[];
  stage: SlashArgStage | null;
};

function closedSlashMenuResolution(): SlashMenuResolution {
  return { open: false, items: [], stage: null };
}

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

/**
 * Finds a declared choice that was already committed by the positional parser.
 * The parser remains authoritative for token ownership; this only checks the
 * value against the same resolved choices the menu renders.
 */
function findInvalidCommittedSlashArg(
  command: SlashCommandDef,
  committed: string,
  input: string,
  values: CommandArgValues,
  props: ChatComposerProps,
): { arg: SlashArgStage["arg"]; values: CommandArgValues; input: string } | null {
  const committedTokens = committed.trim() ? committed.trim().split(/\s+/u) : [];
  const validValues: CommandArgValues = {};
  let tokenIndex = 0;
  for (const arg of getSlashCommandArgs(command)) {
    const value = values[arg.name];
    if (value == null) {
      break;
    }
    const choices = resolveSlashCommandArgChoices(command, arg, getSlashArgScope(props));
    if (choices.length > 0 && !choices.some((choice) => choice.value === String(value))) {
      return {
        arg,
        values: validValues,
        input: [...committedTokens.slice(tokenIndex), ...(input ? [input] : [])].join(" "),
      };
    }
    validValues[arg.name] = value;
    tokenIndex = arg.captureRemaining ? committedTokens.length : tokenIndex + 1;
  }
  return null;
}

/** Pure, authoritative draft -> menu/stage resolution. */
function resolveSlashMenuState(value: string, props: ChatComposerProps): SlashMenuResolution {
  if (props.queuedEdit?.editingId) {
    return closedSlashMenuResolution();
  }
  const commandMatch = value.match(/^\/(\S*)$/u);
  if (commandMatch) {
    const items = getSlashCommandCompletions(commandMatch[1] ?? "", { showAll: true });
    return { open: items.length > 0, items, stage: null };
  }

  const argMatch = value.match(/^\/(\S+)\s([\s\S]*)$/u);
  const command = argMatch ? findSlashCommandByName(argMatch[1] ?? "") : undefined;
  if (!argMatch || !command) {
    return closedSlashMenuResolution();
  }
  const { committed, input } = splitCommandArgDraft(command.definition, argMatch[2] ?? "");
  const parsed = parseCommandArgs(command.definition, committed);
  const values = parsed?.values ?? {};
  const invalid = findInvalidCommittedSlashArg(command, committed, input, values, props);
  const stage = buildSlashArgStage(command, invalid?.values ?? values, props);
  if (!stage) {
    return closedSlashMenuResolution();
  }
  stage.input = invalid?.input ?? input;
  stage.invalidChoice =
    invalid !== null || (stage.choices.length > 0 && getSlashStageChoices(stage).length === 0);
  return { open: true, items: [], stage };
}

function applySlashMenuResolution(
  state: ChatComposerState,
  draft: string,
  resolution: SlashMenuResolution,
): void {
  state.slashMenuDraft = draft;
  state.slashMenuDismissedDraft = null;
  state.slashMenuOpen = resolution.open;
  state.slashMenuItems = resolution.items;
  state.slashMenuStage = resolution.stage;
  state.slashMenuIndex = 0;
}

/** Revalidates a programmatic draft change without causing a render loop. */
export function syncSlashMenuDraft(value: string, props: ChatComposerProps): void {
  const state = getChatComposerState(props.paneId);
  if (state.slashMenuDraft === value) {
    return;
  }
  applySlashMenuResolution(state, value, resolveSlashMenuState(value, props));
}

function rememberSlashMenuDraft(state: ChatComposerState, draft: string): void {
  state.slashMenuDraft = draft;
  state.slashMenuDismissedDraft = null;
}

function abortSlashMenuForQueuedEdit(props: ChatComposerProps, requestUpdate: () => void): boolean {
  if (!props.queuedEdit?.editingId) {
    return false;
  }
  const state = getChatComposerState(props.paneId);
  if (!hasVisibleSlashMenuState(state)) {
    return true;
  }
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  requestUpdate();
  return true;
}

/** Command text assembled so far, shown as the staged input's prefix. */
function getSlashStagePrefix(stage: SlashArgStage): string {
  return buildSlashCommandText(stage.command, stage.values);
}

function submitSlashCommandText(commandText: string, props: ChatComposerProps): void {
  props.onSend(commandText);
  // The override is authoritative for the send owner, so it intentionally does
  // not clear host state. The staged composer owns that draft and clears it here.
  commitComposerDraft(props, "");
  rememberSlashMenuDraft(getChatComposerState(props.paneId), "");
}

function openSlashArgStage(
  stage: SlashArgStage,
  props: ChatComposerProps,
  requestUpdate: () => void,
): void {
  if (abortSlashMenuForQueuedEdit(props, requestUpdate)) {
    return;
  }
  const state = getChatComposerState(props.paneId);
  state.slashMenuStage = stage;
  state.slashMenuItems = [];
  state.slashMenuIndex = 0;
  state.slashMenuOpen = true;
  // The draft always carries the real command text. Keeping it there is what lets
  // the message box show exactly what will be sent, keeps a queued-message edit
  // from mistaking an open stage for an empty composer, and lets a typed command
  // and a menu-picked one share one state machine.
  const draft = `${getSlashStagePrefix(stage)} `;
  rememberSlashMenuDraft(state, draft);
  commitComposerDraft(props, draft);
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
  if (abortSlashMenuForQueuedEdit(props, requestUpdate)) {
    return;
  }
  const state = getChatComposerState(props.paneId);
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  const commandText = buildSlashCommandText(command, values);
  rememberSlashMenuDraft(state, commandText);
  commitComposerDraft(props, commandText);
  submitSlashCommandText(commandText, props);
  queueMicrotask(() => state.composerTextarea?.focus({ preventScroll: true }));
  requestUpdate();
}

type SlashDraftSubmission = "allow" | "blocked" | "submitted";

function refuseSlashStage(
  stage: SlashArgStage,
  props: ChatComposerProps,
  requestUpdate: () => void,
  reason: "required" | "choice",
): SlashDraftSubmission {
  const state = getChatComposerState(props.paneId);
  stage.needsValue = reason === "required";
  stage.invalidChoice = reason === "choice";
  state.slashMenuStage = stage;
  state.slashMenuItems = [];
  state.slashMenuIndex = 0;
  state.slashMenuOpen = true;
  requestUpdate();
  return "blocked";
}

function validateSlashArgValue(stage: SlashArgStage, value: string): "valid" | "required" | "choice" {
  if (!value.trim()) {
    return stage.arg.required === true ? "required" : "valid";
  }
  if (stage.choices.length > 0 && !stage.choices.some((choice) => choice.value === value)) {
    return "choice";
  }
  return "valid";
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
  if (abortSlashMenuForQueuedEdit(props, requestUpdate)) {
    return;
  }
  const state = getChatComposerState(props.paneId);
  const stage = state.slashMenuStage;
  if (!stage) {
    return;
  }
  const validation = validateSlashArgValue(stage, value);
  if (validation !== "valid") {
    refuseSlashStage(stage, props, requestUpdate, validation);
    return;
  }
  stage.needsValue = false;
  stage.invalidChoice = false;
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
  if (abortSlashMenuForQueuedEdit(props, requestUpdate)) {
    return;
  }
  const state = getChatComposerState(props.paneId);
  const stage = buildSlashArgStage(cmd, {}, props);
  if (stage) {
    openSlashArgStage(stage, props, requestUpdate);
    return;
  }
  const hasDeclaredArgumentPlan =
    getSlashCommandArgs(cmd).length > 0 || ownsRawArgumentTail(cmd);
  if (!hasDeclaredArgumentPlan) {
    const commandText = `/${cmd.name}`;
    if (submit) {
      rememberSlashMenuDraft(state, commandText);
      commitComposerDraft(props, commandText);
      submitSlashCommandText(commandText, props);
    } else {
      const draft = `${commandText} `;
      rememberSlashMenuDraft(state, draft);
      commitComposerDraft(props, draft);
    }
    state.slashMenuOpen = false;
    resetSlashMenuState(state);
    requestUpdate();
    return;
  }
  // A command that takes no arguments must run bare instead of leaving a draft
  // the operator has to send by hand; one that owns its raw tail gets the draft
  // prepared so the tail can be typed in the message box.
  if (!acceptsSlashCommandArgs(cmd)) {
    state.slashMenuOpen = false;
    resetSlashMenuState(state);
    const commandText = `/${cmd.name}`;
    rememberSlashMenuDraft(state, commandText);
    commitComposerDraft(props, commandText);
    if (submit) {
      submitSlashCommandText(commandText, props);
    }
    requestUpdate();
    return;
  }
  const draft = `/${cmd.name} `;
  rememberSlashMenuDraft(state, draft);
  commitComposerDraft(props, draft);
  state.slashMenuOpen = false;
  resetSlashMenuState(state);
  requestUpdate();
}

/**
 * Shared submission gate for keyboard, button, and any caller that submits the
 * visible draft. It re-resolves the draft first, so Escape, history, or a
 * programmatic edit cannot bypass required/choice validation.
 */
export function submitSlashDraft(
  draft: string,
  props: ChatComposerProps,
  requestUpdate: () => void,
): SlashDraftSubmission {
  const state = getChatComposerState(props.paneId);
  const resolution = resolveSlashMenuState(draft, props);
  applySlashMenuResolution(state, draft, resolution);
  let stage = resolution.stage;

  if (!stage) {
    const bareMatch = draft.match(/^\/(\S+)$/u);
    const command = bareMatch ? findSlashCommandByName(bareMatch[1] ?? "") : undefined;
    if (command && acceptsSlashCommandArgs(command) && !ownsRawArgumentTail(command)) {
      stage = buildSlashArgStage(command, {}, props);
    }
  }
  if (!stage) {
    return "allow";
  }

  const input = stage.input.trim();
  if (!input) {
    const validation = validateSlashArgValue(stage, "");
    if (validation !== "valid") {
      return refuseSlashStage(stage, props, requestUpdate, validation);
    }
    runStagedSlashCommand(stage.command, stage.values, props, requestUpdate);
    return "submitted";
  }

  if (stage.choices.length > 0) {
    const choice = stage.choices.find((entry) => entry.value === input);
    if (!choice) {
      return refuseSlashStage(stage, props, requestUpdate, "choice");
    }
    const validation = validateSlashArgValue(stage, choice.value);
    if (validation !== "valid") {
      return refuseSlashStage(stage, props, requestUpdate, validation);
    }
    const values = { ...stage.values, [stage.arg.name]: choice.value };
    const next = buildSlashArgStage(stage.command, values, props);
    if (next) {
      if (next.arg.required === true) {
        next.needsValue = true;
        openSlashArgStage(next, props, requestUpdate);
        return "blocked";
      }
      runStagedSlashCommand(stage.command, values, props, requestUpdate);
      return "submitted";
    }
    runStagedSlashCommand(stage.command, values, props, requestUpdate);
    return "submitted";
  }

  return "allow";
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
    if (state.slashMenuDismissedDraft === nextValue) {
      return;
    }
    if (!nextValue.startsWith("/")) {
      rememberSlashMenuDraft(state, nextValue);
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
  applySlashMenuResolution(state, value, resolveSlashMenuState(value, props));
  if (value.match(/^\/(\S*)$/u) && !opts.skipSlashIntent) {
    requestSlashCommandRefresh(value, props, requestUpdate, getCurrentValue);
  }
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

/** Options the message textarea drives while a command tail is being collected. */
export function getSlashArgDraftChoices(state: ChatComposerState): SlashCommandArgChoice[] {
  const stage = state.slashMenuStage;
  if (!stage) {
    return [];
  }
  return getSlashStageChoices(stage);
}

/**
 * Owns Enter/Tab while an argument stage is active. Optional choices submit the
 * bare command, required choices accept the highlighted item, and a filtered
 * empty list reports the invalid input instead of falling through to send.
 */
export function handleSlashArgKeyDown(
  event: KeyboardEvent,
  props: ChatComposerProps,
  requestUpdate: () => void,
): boolean {
  if (event.key !== "Enter" && event.key !== "Tab") {
    return false;
  }
  const state = getChatComposerState(props.paneId);
  const stage = state.slashMenuStage;
  if (!stage) {
    return false;
  }
  const input = stage.input.trim();
  const choices = getSlashStageChoices(stage);
  if (stage.choices.length > 0) {
    if (!input && stage.arg.required !== true && state.slashMenuIndex === 0) {
      event.preventDefault();
      commitSlashArgValue("", props, requestUpdate);
      return true;
    }
    const choice = choices[state.slashMenuIndex];
    event.preventDefault();
    if (choice) {
      commitSlashArgValue(choice.value, props, requestUpdate);
    } else {
      stage.invalidChoice = true;
      requestUpdate();
    }
    return true;
  }
  if (input) {
    return false;
  }
  event.preventDefault();
  if (stage.arg.required === true) {
    stage.needsValue = true;
    stage.invalidChoice = false;
    requestUpdate();
  } else {
    commitSlashArgValue("", props, requestUpdate);
  }
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
    invalid: stage.needsValue || stage.invalidChoice,
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
  if (stage.invalidChoice) {
    return t("chat.commands.argInvalidChoice");
  }
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
  const refused = stage.needsValue || stage.invalidChoice;
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
