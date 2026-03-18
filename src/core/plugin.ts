// ---------------------------------------------------------------------------
// src/core/plugin.ts — Plugin system types

import type { AgentRunResult } from '@src/backends/types';
import type { AgentBackendName, AgentMode, ProviderName, WorkspaceTarget } from '@src/db';

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

export type PluginContext = {
  runAgent: RunAgentFn | null;
  sendReply: SendReplyFn;
  env: Record<string, string | undefined>;
  defaults: PluginDefaults;
};

export type PluginIdentity = {
  name: string;
  alias: string;
  version: string;
};

export type BotPlugin = {
  identity: PluginIdentity;
  onInit: (ctx: PluginContext) => void;
  handler: (args: string[]) => Promise<string>;
  helpText: (alias: string) => string[];
};
