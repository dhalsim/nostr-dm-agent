// ---------------------------------------------------------------------------
// src/core/registry.ts — Plugin registry
// ---------------------------------------------------------------------------

import { join } from 'path';

import { log } from '@src/logger';
import { dmBotRoot } from '@src/paths';

import type { BotPlugin, PluginContext } from './plugin';

const byAlias = new Map<string, BotPlugin>();

type RegisterPluginProps = {
  plugin: BotPlugin;
  ctx: PluginContext;
};

export function registerPlugin({ plugin, ctx }: RegisterPluginProps) {
  if (byAlias.has(plugin.identity.alias)) {
    throw new Error(`Plugin alias collision: "${plugin.identity.alias}" already registered`);
  }

  const databasePath = join(dmBotRoot, 'plugins', plugin.identity.alias, 'db.sqlite');

  log.info(`Registering plugin: ${plugin.identity.alias} creating database at ${databasePath}`);

  plugin.onInit(ctx);

  byAlias.set(plugin.identity.alias, plugin);
}

export async function dispatchPluginCommand(cmd: string, args: string[]): Promise<string | null> {
  const plugin = byAlias.get(cmd);

  if (!plugin) {
    return null;
  }

  return plugin.handler(args);
}

export function getPluginHelpTexts(): string | null {
  if (byAlias.size === 0) {
    return null;
  }

  const sections = [...byAlias.entries()]
    .map(([alias, plugin]) => `\n${alias}:\n${plugin.helpText(alias).join('\n')}\n`)
    .filter(Boolean)
    .join('\n\n');

  if (!sections) {
    return 'No plugins registered to help text';
  }

  return `\n---------------\nPlugin Commands\n---------------\n\n${sections}`;
}
