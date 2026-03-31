// ---------------------------------------------------------------------------
// env.ts — Environment variable parsing and bot configuration
// ---------------------------------------------------------------------------
import { delimiter } from 'path';

import { log } from './logger';

export type BotConfig = {
  botKeyHex: string;
  botPubkey: string | null;
  masterPubkey: string;
  botRelayUrls: string[];
  opencodeServeUrl: string | null;
  cashuMnemonic: string | null;
  cashuDefaultMintUrl: string | null;
  routstrBaseUrl: string;
};

/** BOT_KEY + BOT_RELAYS only — for Nostr file share without loading full bot config. */
export type FileShareNostrConfig = {
  botKeyHex: string;
  botRelayUrls: string[];
};

export function requireEnv(name: string): string {
  const val = process.env[name];

  if (!val) {
    log.error(`Missing required env: ${name}`);
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

export function loadFileShareNostrConfig(): FileShareNostrConfig {
  const botKeyHex = requireEnv('BOT_KEY');
  const relayUrls = parseRelayUrls(requireEnv('BOT_RELAYS'));

  if (relayUrls.length === 0) {
    log.error(
      'BOT_RELAYS must contain at least one relay URL (comma-separated)',
    );

    process.exit(1);
  }

  return { botKeyHex, botRelayUrls: relayUrls };
}

export function loadBotConfig(): BotConfig {
  const { botKeyHex, botRelayUrls: relayUrls } = loadFileShareNostrConfig();
  const masterPubkey = requireEnv('BOT_MASTER_PUBKEY');

  return {
    botKeyHex,
    botPubkey: process.env.BOT_PUBKEY ?? null,
    masterPubkey,
    botRelayUrls: relayUrls,
    opencodeServeUrl: process.env.BOT_OPENCODE_SERVE_URL ?? null,
    cashuMnemonic: process.env.CASHU_MNEMONIC ?? null,
    cashuDefaultMintUrl: process.env.CASHU_DEFAULT_MINT_URL ?? null,
    routstrBaseUrl:
      process.env.ROUTSTR_BASE_URL ?? 'https://api.routstr.com/v1',
  };
}
