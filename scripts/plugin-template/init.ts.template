// ---------------------------------------------------------------------------
// plugins/{{ALIAS}}/init.ts — {{PASCAL_ALIAS}}Plugin definition
//
// This file wires the plugin into the bot. Replace helpText with your real
// command list once you implement commands in commands.ts.
// ---------------------------------------------------------------------------

import { basename, join } from 'path';

import { Database } from 'bun:sqlite';

import {
  parsePluginPackageJson,
  type BotPlugin,
  type PluginContext,
} from '@src/core/plugin';

import { handle{{PASCAL_ALIAS}} } from './commands';
import { create{{PASCAL_ALIAS}}Table } from './db';
import { create{{PASCAL_ALIAS}}DraftsTable } from './drafts';

const pluginDir = import.meta.dir;
const alias = basename(pluginDir);

const {{ALIAS}}Pkg = parsePluginPackageJson({ pluginDir });

if (!{{ALIAS}}Pkg) {
  throw new Error(
    `{{PASCAL_ALIAS}} plugin: invalid or missing package.json. Required: name, version, dmBot.coreApiVersion, dmBot.description`,
  );
}

export let {{PASCAL_ALIAS}}PluginContext: PluginContext | null = null;
export let {{PASCAL_ALIAS}}PluginDb: Database | null = null;

export const {{PASCAL_ALIAS}}Plugin: BotPlugin = {
  identity: {
    name: {{ALIAS}}Pkg.name,
    alias,
    version: {{ALIAS}}Pkg.version,
    description: {{ALIAS}}Pkg.description,
  },
  handler: (args: string[]) => {
    if (!{{PASCAL_ALIAS}}PluginContext) {
      throw new Error('{{PASCAL_ALIAS}}Plugin not initialized');
    }

    if (!{{PASCAL_ALIAS}}PluginDb) {
      throw new Error('{{PASCAL_ALIAS}}PluginDb not initialized');
    }

    return handle{{PASCAL_ALIAS}}({
      args,
      db: {{PASCAL_ALIAS}}PluginDb,
      identity: {{PASCAL_ALIAS}}Plugin.identity,
      runAgent: {{PASCAL_ALIAS}}PluginContext.runAgent,
      helpText: {{PASCAL_ALIAS}}Plugin.helpText,
    });
  },
  onInit: (ctx: PluginContext) => {
    {{PASCAL_ALIAS}}PluginContext = ctx;

    {{PASCAL_ALIAS}}PluginDb = new Database(join(pluginDir, 'db.sqlite'), { strict: true });

    create{{PASCAL_ALIAS}}Table({{PASCAL_ALIAS}}PluginDb);
    create{{PASCAL_ALIAS}}DraftsTable({{PASCAL_ALIAS}}PluginDb);
  },
  // Replace with your real command help lines when you implement commands.
  helpText: (alias: string) => [
    `!${alias} help — this message`,
    `!${alias} ai <prompt> — natural language (implement in ai.ts + tool.ts)`,
  ],
};
