// ---------------------------------------------------------------------------
// env.ts — Environment variable parsing and bot configuration
// ---------------------------------------------------------------------------
import { delimiter } from 'path';

import { logError } from './logger';

export type BotConfig = {
  botKeyHex: string;
  botPubkey: string | null;
  masterPubkey: string;
  relayUrls: string[];
  agentPath: string;
  localCliEnabled: boolean;
  opencodeServeUrl: string | null;
};

export function requireEnv(name: string): string {
  const val = process.env[name];

  if (!val) {
    logError(`Missing required env: ${name}`);
    process.exit(1);
  }

  return val;
}

export function ensureWss(url: string): string {
  if (url.startsWith('wss://') || url.startsWith('ws://')) {
    return url;
  }

  return `wss://${url}`;
}

export function parseRelayUrls(envValue: string): string[] {
  const urls = envValue
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(ensureWss);

  return [...new Set(urls)];
}

export function normalizePath(pathValue: string): string {
  const parts = pathValue
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean);

  return [...new Set(parts)].join(delimiter);
}

export function loadBotConfig(): BotConfig {
  const botKeyHex = requireEnv('BOT_KEY');
  const masterPubkey = requireEnv('BOT_MASTER_PUBKEY');
  const relayUrls = parseRelayUrls(requireEnv('BOT_RELAYS'));

  if (relayUrls.length === 0) {
    logError('BOT_RELAYS must contain at least one relay URL (comma-separated)');
    process.exit(1);
  }

  return {
    botKeyHex,
    botPubkey: process.env.BOT_PUBKEY ?? null,
    masterPubkey,
    relayUrls,
    agentPath: normalizePath(process.env.BOT_AGENT_PATH ?? process.env.PATH ?? ''),
    localCliEnabled: (process.env.BOT_LOCAL_CLI ?? '1') !== '0',
    opencodeServeUrl: process.env.BOT_OPENCODE_SERVE_URL ?? null,
  };
}
