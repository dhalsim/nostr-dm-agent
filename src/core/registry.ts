// ---------------------------------------------------------------------------
// src/core/registry.ts — Plugin registry
// ---------------------------------------------------------------------------

import { join } from 'path';

import { Database as BunDatabase, type Database } from 'bun:sqlite';

import { log } from '../logger';

import type { BotPlugin, PluginContext } from './plugin';

type RegisteredPlugin = {
  plugin: BotPlugin;
  pluginDb: Database;
};

const byAlias = new Map<string, RegisteredPlugin>();

export function registerPlugin(plugin: BotPlugin, dataDir: string) {
  if (byAlias.has(plugin.identity.alias)) {
    throw new Error(`Plugin alias collision: "${plugin.identity.alias}" already registered`);
  }

  const databasePath = join(dataDir, 'plugins', plugin.identity.alias, 'db.sqlite');

  log.info(`Registering plugin: ${plugin.identity.alias} creating database at ${databasePath}`);

  const pluginDb = new BunDatabase(databasePath);
  plugin.onInit(pluginDb);

  byAlias.set(plugin.identity.alias, { plugin, pluginDb });
}

export async function dispatchPluginCommand(
  cmd: string,
  args: string[],
  runAgent: (prompt: string) => Promise<string>,
): Promise<string | null> {
  const entry = byAlias.get(cmd);

  if (!entry) {
    return null;
  }

  const ctx: PluginContext = { pluginDb: entry.pluginDb, runAgent };

  return entry.plugin.handler(args, ctx);
}

export function getPluginHelpTexts(): string | null {
  if (byAlias.size === 0) {
    return null;
  }

  const sections = [...byAlias.entries()]
    .map(([alias, { plugin }]) => plugin.helpText(alias).join('\n'))
    .filter(Boolean)
    .join('\n\n');

  if (!sections) {
    return 'No plugins registered to help text';
  }

  return `\n---------------\nPlugin Commands\n---------------\n\n${sections}`;
}
