// ---------------------------------------------------------------------------
// src/core/plugin.ts — Plugin system types
// ---------------------------------------------------------------------------
import type { Database } from 'bun:sqlite';

export type PluginContext = {
  pluginDb: Database;
  runAgent: (prompt: string) => Promise<string>;
};

export type PluginCommandHandler = (args: string[], ctx: PluginContext) => Promise<string>;

export type PluginIdentity = {
  name: string;
  alias: string;
  version: string;
};

export type BotPlugin = {
  identity: PluginIdentity;
  handler: PluginCommandHandler; // single handler, not a map
  onInit: (db: Database) => void;
  helpText: (alias: string) => string[];
};
