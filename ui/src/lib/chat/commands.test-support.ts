// Test-support factory for slash commands.

import { defineChatCommand } from "../../../../src/auto-reply/commands-registry.shared.js";
import type { SlashCommandDef } from "./commands.ts";

/**
 * Builds a slash command whose canonical definition matches its surface fields.
 * Tests that only care about listing or ranking still get a real definition, so
 * they exercise the same argument plan the composer reads at runtime.
 */
export function makeSlashCommand(
  name: string,
  options: Partial<Omit<SlashCommandDef, "key" | "name">> = {},
): SlashCommandDef {
  const description = options.description ?? `${name} command.`;
  return {
    key: name,
    name,
    description,
    definition: options.definition ?? defineChatCommand({ key: name, description }),
    ...options,
  };
}
