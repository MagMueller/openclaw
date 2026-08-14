/** Command-registry facade for native specs, text aliases, argument parsing, and menus. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  buildConfiguredModelCatalog,
  resolveConfiguredModelRef,
} from "../agents/model-selection.js";
import { getChannelPlugin, getLoadedChannelPlugin } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.js";
import type { SkillCommandSpec } from "../skills/types.js";
import type { CommandArgChoiceScope, ResolvedCommandArgChoice } from "./commands-invocation.js";
import {
  resolveCommandArgChoicesInScope,
  resolveCommandArgMenuInScope,
} from "./commands-invocation.js";
import { listChatCommands, listChatCommandsForConfig } from "./commands-registry-list.js";
import { normalizeCommandBody } from "./commands-registry-normalize.js";
import { getChatCommands } from "./commands-registry.data.js";
import type {
  ChatCommandDefinition,
  CommandArgDefinition,
  CommandArgs,
  NativeCommandSpec,
} from "./commands-registry.types.js";
import type { ThinkingCatalogEntry } from "./thinking.shared.js";

export {
  buildCommandText,
  buildCommandTextFromArgs,
  formatCommandArgMenuTitle,
  parseCommandArgs,
  serializeCommandArgs,
} from "./commands-invocation.js";

export type { ResolvedCommandArgChoice } from "./commands-invocation.js";

export {
  isCommandEnabled,
  listChatCommands,
  listChatCommandsForConfig,
} from "./commands-registry-list.js";

export {
  getCommandDetection,
  maybeResolveTextAlias,
  normalizeCommandBody,
  resolveTextCommand,
} from "./commands-registry-normalize.js";

export { isNativeCommandSurface, shouldHandleTextCommands } from "./commands-text-routing.js";

export type {
  ChatCommandDefinition,
  CommandArgChoiceContext,
  CommandArgDefinition,
  CommandArgMenuSpec,
  CommandArgValues,
  CommandArgs,
  CommandDetection,
  CommandNormalizeOptions,
  CommandScope,
  NativeCommandSpec,
  ShouldHandleTextCommandsParams,
} from "./commands-registry.types.js";

type NativeCommandProviderLookupOptions = {
  includeBundledChannelFallback?: boolean;
};

/** Resolves provider-specific native command names while preserving registry defaults. */
function resolveNativeName(
  command: ChatCommandDefinition,
  provider?: string,
  options?: NativeCommandProviderLookupOptions,
): string | undefined {
  if (!command.nativeName) {
    return undefined;
  }
  if (!provider) {
    return command.nativeName;
  }
  const channelPlugin =
    options?.includeBundledChannelFallback === false
      ? getLoadedChannelPlugin(provider)
      : getChannelPlugin(provider);
  return (
    channelPlugin?.commands?.resolveNativeCommandName?.({
      commandKey: command.key,
      defaultName: command.nativeName,
    }) ?? command.nativeName
  );
}

function toNativeCommandSpec(
  command: ChatCommandDefinition,
  provider?: string,
  options?: NativeCommandProviderLookupOptions,
): NativeCommandSpec {
  const spec: NativeCommandSpec = {
    name: resolveNativeName(command, provider, options) ?? command.key,
    description: command.description,
    acceptsArgs: Boolean(command.acceptsArgs),
    args: command.args,
  };
  if (command.descriptionLocalizations) {
    spec.descriptionLocalizations = command.descriptionLocalizations;
  }
  return spec;
}

function resolveNativeNames(
  command: ChatCommandDefinition,
  provider?: string,
  options?: NativeCommandProviderLookupOptions,
): string[] {
  const primary = resolveNativeName(command, provider, options);
  return [primary, ...(command.nativeAliases ?? [])].filter((name): name is string =>
    Boolean(name),
  );
}

function supportsNativeProvider(command: ChatCommandDefinition, provider?: string): boolean {
  if (!command.nativeProviders?.length) {
    return true;
  }
  const normalizedProvider = normalizeOptionalLowercaseString(provider);
  if (!normalizedProvider) {
    return false;
  }
  return command.nativeProviders.some(
    (candidate) => normalizeOptionalLowercaseString(candidate) === normalizedProvider,
  );
}

function listNativeSpecsFromCommands(
  commands: ChatCommandDefinition[],
  provider?: string,
  options?: NativeCommandProviderLookupOptions,
): NativeCommandSpec[] {
  return commands
    .filter(
      (command) =>
        command.scope !== "text" && command.nativeName && supportsNativeProvider(command, provider),
    )
    .flatMap((command) => {
      const spec = toNativeCommandSpec(command, provider, options);
      return resolveNativeNames(command, provider, options).map((name, index) => {
        const nativeSpec: NativeCommandSpec = {
          name,
          description: spec.description,
          acceptsArgs: spec.acceptsArgs,
        };
        // Native aliases carry the same payload shape but are marked for channel registration.
        if (index > 0) {
          nativeSpec.isAlias = true;
        }
        if (spec.args) {
          nativeSpec.args = spec.args;
        }
        if (spec.descriptionLocalizations) {
          nativeSpec.descriptionLocalizations = spec.descriptionLocalizations;
        }
        return nativeSpec;
      });
    });
}

/** Lists native command specs registered for a provider, including skill commands. */
export function listNativeCommandSpecs(
  params?: {
    skillCommands?: SkillCommandSpec[];
    provider?: string;
  } & NativeCommandProviderLookupOptions,
): NativeCommandSpec[] {
  return listNativeSpecsFromCommands(
    listChatCommands({ skillCommands: params?.skillCommands }),
    params?.provider,
    params,
  );
}

/** Lists native command specs that are enabled for the provided config. */
export function listNativeCommandSpecsForConfig(
  cfg: OpenClawConfig,
  params?: {
    skillCommands?: SkillCommandSpec[];
    provider?: string;
  } & NativeCommandProviderLookupOptions,
): NativeCommandSpec[] {
  return listNativeSpecsFromCommands(
    listChatCommandsForConfig(cfg, params),
    params?.provider,
    params,
  );
}

export function mergeNativeCommandSpecs(params: {
  primary: readonly NativeCommandSpec[];
  secondary: readonly NativeCommandSpec[];
  onCollision?: (normalizedName: string) => void;
}): NativeCommandSpec[] {
  const merged: NativeCommandSpec[] = [];
  const names = new Set<string>();
  const append = (spec: NativeCommandSpec, reportCollision: boolean) => {
    const normalizedName = normalizeOptionalLowercaseString(spec.name);
    if (!normalizedName) {
      return;
    }
    if (names.has(normalizedName)) {
      if (reportCollision) {
        params.onCollision?.(normalizedName);
      }
      return;
    }
    names.add(normalizedName);
    merged.push(spec);
  };
  for (const spec of params.primary) {
    append(spec, false);
  }
  for (const spec of params.secondary) {
    append(spec, true);
  }
  return merged;
}

/** Finds a command definition by provider-native command name or native alias. */
export function findCommandByNativeName(
  name: string,
  provider?: string,
  options?: NativeCommandProviderLookupOptions,
): ChatCommandDefinition | undefined {
  const normalized = normalizeOptionalLowercaseString(name);
  if (!normalized) {
    return undefined;
  }
  return getChatCommands().find(
    (command) =>
      command.scope !== "text" &&
      supportsNativeProvider(command, provider) &&
      [resolveNativeName(command, provider, options), ...(command.nativeAliases ?? [])].some(
        (nameLocal) => normalizeOptionalLowercaseString(nameLocal) === normalized,
      ),
  );
}

function resolveDefaultCommandContext(cfg?: OpenClawConfig): {
  provider: string;
  model: string;
} {
  const resolved = resolveConfiguredModelRef({
    cfg: cfg ?? ({} as OpenClawConfig),
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  return {
    provider: resolved.provider ?? DEFAULT_PROVIDER,
    model: resolved.model ?? DEFAULT_MODEL,
  };
}

/** Fills provider/model/catalog defaults from config for choice resolution. */
function resolveCommandArgScope(params: {
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  agentRuntime?: string;
  catalog?: ThinkingCatalogEntry[];
}): CommandArgChoiceScope {
  const { cfg } = params;
  const defaults = resolveDefaultCommandContext(cfg);
  return {
    cfg,
    provider: params.provider ?? defaults.provider,
    model: params.model ?? defaults.model,
    agentRuntime: params.agentRuntime,
    catalog: params.catalog ?? (cfg ? buildConfiguredModelCatalog({ cfg }) : undefined),
  };
}

/** Resolves static or context-aware choices for one command argument. */
export function resolveCommandArgChoices(params: {
  command: ChatCommandDefinition;
  arg: CommandArgDefinition;
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  agentRuntime?: string;
  catalog?: ThinkingCatalogEntry[];
}): ResolvedCommandArgChoice[] {
  return resolveCommandArgChoicesInScope({
    command: params.command,
    arg: params.arg,
    scope: resolveCommandArgScope(params),
  });
}

/** Resolves the next argument menu to show for commands with selectable choices. */
export function resolveCommandArgMenu(params: {
  command: ChatCommandDefinition;
  args?: CommandArgs;
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  agentRuntime?: string;
  catalog?: ThinkingCatalogEntry[];
}): { arg: CommandArgDefinition; choices: ResolvedCommandArgChoice[]; title?: string } | null {
  return resolveCommandArgMenuInScope({
    command: params.command,
    args: params.args,
    scope: resolveCommandArgScope(params),
  });
}

/** Returns true for normalized slash-command text. */
export function isCommandMessage(raw: string): boolean {
  const trimmed = normalizeCommandBody(raw);
  return trimmed.startsWith("/");
}
