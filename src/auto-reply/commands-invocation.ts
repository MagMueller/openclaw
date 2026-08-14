/**
 * Canonical command invocation plan: how a command's raw argument tail is
 * parsed into values, serialized back into slash-command text, and which
 * argument (if any) may be prompted for with a choice menu.
 *
 * This module is browser-safe on purpose. The Control UI composer must apply the
 * same parsing, serialization, and menu rules as the server instead of
 * rebuilding command semantics from the lossy catalog projection; keeping the
 * rules here is what makes one implementation serve both.
 */
import type {
  ChatCommandDefinition,
  CommandArgChoiceContext,
  CommandArgDefinition,
  CommandArgValues,
  CommandArgs,
} from "./commands-registry.types.js";

/** Choice-resolution context without the per-argument fields. */
export type CommandArgChoiceScope = Omit<CommandArgChoiceContext, "command" | "arg">;

/** One resolved, display-ready choice for a command argument. */
export type ResolvedCommandArgChoice = { value: string; label: string };

/** Formats a command and optional raw argument string as slash-command text. */
export function buildCommandText(commandName: string, args?: string): string {
  const trimmedArgs = args?.trim();
  return trimmedArgs ? `/${commandName} ${trimmedArgs}` : `/${commandName}`;
}

function parsePositionalArgs(definitions: CommandArgDefinition[], raw: string): CommandArgValues {
  const values: CommandArgValues = {};
  const trimmed = raw.trim();
  if (!trimmed) {
    return values;
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  let index = 0;
  for (const definition of definitions) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    if (definition.captureRemaining) {
      // CaptureRemaining keeps freeform prompts intact after the fixed leading args.
      values[definition.name] = tokens.slice(index).join(" ");
      break;
    }
    values[definition.name] = token;
    index += 1;
  }
  return values;
}

function formatPositionalArgs(
  definitions: CommandArgDefinition[],
  values: CommandArgValues,
): string | undefined {
  const parts: string[] = [];
  for (const definition of definitions) {
    const value = values[definition.name];
    if (value == null) {
      continue;
    }
    const rendered = typeof value === "string" ? value.trim() : String(value);
    if (!rendered) {
      continue;
    }
    parts.push(rendered);
    if (definition.captureRemaining) {
      break;
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * Splits a raw argument tail into the part already committed to preceding
 * arguments and the segment still being typed, for editors that must know which
 * argument the caret sits in. Mirrors {@link parsePositionalArgs}: a
 * `captureRemaining` argument owns everything left in the tail, so its value is
 * never chopped at a space the way a choice filter is.
 */
export function splitCommandArgDraft(
  command: ChatCommandDefinition,
  tail: string,
): { committed: string; input: string } {
  const tokens = tail.split(/\s+/u).filter(Boolean);
  const typingLastToken = !/\s$/u.test(tail);
  let index = 0;
  for (const definition of command.args ?? []) {
    if (definition.captureRemaining || index >= tokens.length) {
      break;
    }
    if (typingLastToken && index === tokens.length - 1) {
      break;
    }
    index += 1;
  }
  return { committed: tokens.slice(0, index).join(" "), input: tokens.slice(index).join(" ") };
}

/** Parses raw command arguments according to the command definition. */
export function parseCommandArgs(
  command: ChatCommandDefinition,
  raw?: string,
): CommandArgs | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!command.args || command.argsParsing === "none") {
    return { raw: trimmed };
  }
  return {
    raw: trimmed,
    values: parsePositionalArgs(command.args, trimmed),
  };
}

/** Serializes parsed command arguments back into a raw argument string. */
export function serializeCommandArgs(
  command: ChatCommandDefinition,
  args?: CommandArgs,
): string | undefined {
  if (!args) {
    return undefined;
  }
  const raw = args.raw?.trim();
  if (raw) {
    return raw;
  }
  if (!args.values || !command.args) {
    return undefined;
  }
  if (command.formatArgs) {
    return command.formatArgs(args.values);
  }
  return formatPositionalArgs(command.args, args.values);
}

/** Builds slash-command text from a command definition and parsed args. */
export function buildCommandTextFromArgs(
  command: ChatCommandDefinition,
  args?: CommandArgs,
): string {
  const commandName = command.nativeName ?? command.key;
  return buildCommandText(commandName, serializeCommandArgs(command, args));
}

/**
 * Resolves static or provider-dependent choices for one argument against an
 * explicit context. Callers that can derive provider/model from config supply
 * them; the Control UI passes its active session context instead.
 */
export function resolveCommandArgChoicesInScope(params: {
  command: ChatCommandDefinition;
  arg: CommandArgDefinition;
  scope?: CommandArgChoiceScope;
}): ResolvedCommandArgChoice[] {
  const { command, arg } = params;
  if (!arg.choices) {
    return [];
  }
  const provided = arg.choices;
  const raw = Array.isArray(provided) ? provided : provided({ ...params.scope, command, arg });
  return raw.map((choice) =>
    typeof choice === "string" ? { value: choice, label: choice } : choice,
  );
}

/**
 * Resolves the argument a choice menu should prompt for, or null when the
 * command takes no menu. A command that parses its own raw tail
 * (`argsParsing: "none"`) never gets one: its declared arguments describe the
 * native registration surface, and the positional parser that a stepped menu
 * would imply never runs on the text path.
 */
export function resolveCommandArgMenuInScope(params: {
  command: ChatCommandDefinition;
  args?: CommandArgs;
  scope?: CommandArgChoiceScope;
}): { arg: CommandArgDefinition; choices: ResolvedCommandArgChoice[]; title?: string } | null {
  const { command, args, scope } = params;
  if (!command.args || !command.argsMenu) {
    return null;
  }
  if (command.argsParsing === "none") {
    return null;
  }
  const argSpec = command.argsMenu;
  const argName =
    argSpec === "auto"
      ? command.args.find(
          (arg) => resolveCommandArgChoicesInScope({ command, arg, scope }).length > 0,
        )?.name
      : argSpec.arg;
  if (!argName) {
    return null;
  }
  if (args?.values && args.values[argName] != null) {
    return null;
  }
  if (args?.raw && !args.values) {
    return null;
  }
  const arg = command.args.find((entry) => entry.name === argName);
  if (!arg) {
    return null;
  }
  const choices = resolveCommandArgChoicesInScope({ command, arg, scope });
  if (choices.length === 0) {
    return null;
  }
  const title = argSpec !== "auto" ? argSpec.title : undefined;
  return { arg, choices, title };
}

/** Formats the prompt title shown before an argument-choice menu. */
export function formatCommandArgMenuTitle(params: {
  command: ChatCommandDefinition;
  menu: NonNullable<ReturnType<typeof resolveCommandArgMenuInScope>>;
}): string {
  const { command, menu } = params;
  if (menu.title) {
    return menu.title;
  }
  const commandLabel = command.nativeName ?? command.key;
  if (typeof menu.arg.choices === "function") {
    const options = menu.choices
      .map((choice) => choice.label.trim())
      .filter(Boolean)
      .join(", ");
    if (options.length > 0 && options.length <= 160) {
      return `Choose ${menu.arg.name} for /${commandLabel}.\nOptions: ${options}.`;
    }
    return `Choose ${menu.arg.name} for /${commandLabel}.`;
  }
  return `Choose ${menu.arg.description || menu.arg.name} for /${commandLabel}.`;
}
