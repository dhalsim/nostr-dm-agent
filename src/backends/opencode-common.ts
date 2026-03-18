// ---------------------------------------------------------------------------
// backends/opencode-common.ts — Shared helpers for opencode and opencode-sdk
// ---------------------------------------------------------------------------
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import type { AgentMode } from '../db';
import type { ProviderName } from '../providers/types';

const DEFAULT_MODEL = 'opencode/big-pickle';

/**
 * Read model from opencode.json for the given mode, or return the default.
 */
export function readModelFromOpencodeConfig(
  dmBotRoot: string,
  mode: AgentMode,
): string {
  try {
    const cfgPath = join(dmBotRoot, 'opencode.json');

    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
        agent?: Record<string, { model?: string }>;
      };

      const configured = cfg.agent?.[mode]?.model;

      if (configured) {
        return configured;
      }
    }
  } catch {
    // use default
  }

  return DEFAULT_MODEL;
}

/**
 * When provider is routstr and model does not already start with "routstr/", add the prefix.
 * Otherwise return the model unchanged.
 */
export function normalizeModelForProvider(
  model: string | null | undefined,
  providerName: ProviderName | null,
): string | null | undefined {
  if (model == null) {
    return model;
  }

  if (providerName === 'routstr' && !model.startsWith('routstr/')) {
    return `routstr/${model}`;
  }

  return model;
}

export type ParseModelProps = {
  dmBotRoot: string;
  mode: AgentMode;
  modelOverride: string | null | undefined;
  providerName: ProviderName | null;
};
