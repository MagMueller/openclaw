import {
  parseCommandArgs,
  splitCommandArgDraft,
} from "../../../../../src/auto-reply/commands-invocation.js";
import type { CommandArgValues } from "../../../../../src/auto-reply/commands-registry.types.js";
import {
  acceptsSlashCommandArgs,
  getSlashCommandArgs,
  getSlashCommandCompletions,
  ownsRawArgumentTail,
  resolveSlashCommandArgChoices,
  SLASH_COMMANDS,
  type SlashCommandArgChoice,
  type SlashCommandArgScope,
  type SlashCommandDef,
} from "../../../lib/chat/commands.ts";
import { getChatComposerState } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState, SlashArgStage } from "./chat-composer-types.ts";

/** Active model context for provider-dependent argument choices. */
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

export function findSlashCommandByName(name: string): SlashCommandDef | undefined {
  const normalized = name.toLowerCase();
  return SLASH_COMMANDS.find(
    (command) =>
      command.name === normalized ||
      command.aliases?.some((alias) => alias.replace(/^\//u, "").toLowerCase() === normalized),
  );
}

/** Builds the next missing positional argument stage from canonical values. */
export function buildSlashArgStage(
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

export type SlashMenuResolution = {
  open: boolean;
  items: SlashCommandDef[];
  stage: SlashArgStage | null;
};

function closedSlashMenuResolution(): SlashMenuResolution {
  return { open: false, items: [], stage: null };
}

/** Choices left after the stage's filter; empty on a free-value stage. */
export function getSlashStageChoices(stage: SlashArgStage): SlashCommandArgChoice[] {
  const filter = stage.input.trim().toLowerCase();
  if (!filter) {
    return stage.choices;
  }
  return stage.choices.filter(
    (choice) =>
      choice.value.toLowerCase().includes(filter) || choice.label.toLowerCase().includes(filter),
  );
}

function findInvalidCommittedSlashArg(
  command: SlashCommandDef,
  committed: string,
  input: string,
  values: CommandArgValues,
  props: ChatComposerProps,
): { values: CommandArgValues; input: string } | null {
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
export function resolveSlashMenuState(
  value: string,
  props: ChatComposerProps,
): SlashMenuResolution {
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

export function applySlashMenuResolution(
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
  // Bare command fragments are opened by the input producer, not by a render
  // caused by an unrelated host update. Argument tails still resolve here.
  if (!/^\/\S+\s[\s\S]*$/u.test(value)) {
    applySlashMenuResolution(state, value, closedSlashMenuResolution());
    return;
  }
  applySlashMenuResolution(state, value, resolveSlashMenuState(value, props));
}

export function rememberSlashMenuDraft(state: ChatComposerState, draft: string): void {
  state.slashMenuDraft = draft;
  state.slashMenuDismissedDraft = null;
}

export type SlashArgValidation = "valid" | "required" | "choice";

export function validateSlashArgValue(stage: SlashArgStage, value: string): SlashArgValidation {
  if (!value.trim()) {
    return stage.arg.required === true ? "required" : "valid";
  }
  if (stage.choices.length > 0 && !stage.choices.some((choice) => choice.value === value)) {
    return "choice";
  }
  return "valid";
}

export function refuseSlashStage(
  stage: SlashArgStage,
  props: ChatComposerProps,
  requestUpdate: () => void,
  reason: Exclude<SlashArgValidation, "valid">,
): "blocked" {
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
