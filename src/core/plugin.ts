// ---------------------------------------------------------------------------
// src/core/plugin.ts — Plugin system types

import { readFileSync } from 'fs';
import { basename, join } from 'path';

import type { EventTemplate, NostrEvent, SimplePool } from 'nostr-tools';
import { z } from 'zod';

import type { AgentRunResult } from '@src/backends/types';
import type {
  AgentBackendName,
  AgentMode,
  ProviderName,
  WorkspaceTarget,
} from '@src/db';
import { log } from '@src/logger';

// ---------------------------------------------------------------------------
export type SendReplyFn = (message: string) => Promise<void>;
export type RunAgentFn = (prompt: string) => Promise<AgentRunResult>;

export type PluginDefaults = {
  backend: AgentBackendName;
  provider: ProviderName;
  model: string | null;
  mode: AgentMode;
  workspace_target: WorkspaceTarget;
};

/**
 * Shared context for plugins. Mutating handlers run after `onInit(ctx)` has been called.
 *
 * - **getRoutstrSkKey** — Routstr API key from DB when applicable.
 * - **defaults** — UI defaults when a user message is handled; for authoritative DB state prefer
 *   `openCoreDb()` inside the plugin (see job plugin CLI tools).
 */
export type PluginContext = {
  pool: SimplePool;
  masterPubkey: string;
  runAgent: RunAgentFn | null;
  sendReply: SendReplyFn;
  promptFn: (message: string) => Promise<string>;
  getWotScore: (pubkey: string, rootPubkey?: string) => number | null;
  signWithBunker: (
    eventTemplate: EventTemplate,
    bunkerName?: string,
  ) => Promise<NostrEvent>;
  getRoutstrSkKey: () => string | null;
  defaults: PluginDefaults;
};

const PluginPackageJsonSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  dmBot: z.object({
    coreApiVersion: z.string().min(1),
    description: z.string().min(1),
  }),
});

/** Parsed plugin package.json: flattened shape returned by parsePluginPackageJson. */
export type PluginPackageJson = {
  name: string;
  version: string;
  coreApiVersion: string;
  description: string;
};

type ParsePluginPackageJsonProps = {
  /** Plugin directory (e.g. import.meta.dir); package.json is read from here. */
  pluginDir: string;
};

/**
 * Reads and validates a plugin's package.json. All of name, version, coreApiVersion, and description are required.
 * On parse failure logs errors and returns null.
 */
export function parsePluginPackageJson({
  pluginDir,
}: ParsePluginPackageJsonProps): PluginPackageJson | null {
  const alias = basename(pluginDir);
  const path = join(pluginDir, 'package.json');

  let raw: string;

  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    log.error(
      `Plugin ${alias}: failed to read package.json at ${path}: ${String(err)}`,
    );

    return null;
  }

  let data: unknown;

  try {
    data = JSON.parse(raw);
  } catch (err) {
    log.error(`Plugin ${alias}: invalid JSON in package.json: ${String(err)}`);

    return null;
  }

  const result = PluginPackageJsonSchema.safeParse(data);

  if (!result.success) {
    log.error(
      `Plugin ${alias}: invalid package.json: ${result.error.toString()}`,
    );

    return null;
  }

  const { name, version, dmBot } = result.data;

  return {
    name,
    version,
    coreApiVersion: dmBot.coreApiVersion,
    description: dmBot.description,
  };
}

export type PluginIdentity = {
  name: string;
  alias: string;
  version: string;
  /** Short description for help and publish; optional. */
  description?: string;
};

export type BotPlugin = {
  identity: PluginIdentity;
  onInit: (ctx: PluginContext) => void;
  handler: (args: string[]) => Promise<string>;
  helpText: (alias: string) => string[];
};
