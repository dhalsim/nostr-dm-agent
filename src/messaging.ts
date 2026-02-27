// ---------------------------------------------------------------------------
// messaging.ts — Message chunking, formatting, and NIP-17 DM sending
// ---------------------------------------------------------------------------
import type { EventTemplate, VerifiedEvent } from 'nostr-tools/core';
import { wrapEvent } from 'nostr-tools/nip17';
import type { SimplePool } from 'nostr-tools/pool';

import type { AgentRunResult } from './backends/types';
import type { AgentMode } from './db';
import { ensureWss } from './env';
import { C, debug, log, logError } from './logger';

export const CHUNK_MAX = 4200;
export const CHUNK_DELAY_BASE_MS = 1500;
export const CHUNK_DELAY_MAX_MS = 12000;

export const PROFILE_RELAYS = new Set([
  'wss://purplepag.es',
  'wss://relay.nos.social',
  'wss://user.kindpag.es',
  'wss://relay.nostr.band',
]);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunkMessage(text: string): string[] {
  if (text.length <= CHUNK_MAX) {
    return [text];
  }

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= CHUNK_MAX) {
      chunks.push(rest);
      break;
    }

    const slice = rest.slice(0, CHUNK_MAX);
    const lastNewline = slice.lastIndexOf('\n');
    const splitAt = lastNewline >= 0 ? lastNewline + 1 : CHUNK_MAX;
    chunks.push(rest.slice(0, splitAt));
    rest = rest.slice(splitAt);
  }

  return chunks;
}

export function modePrefix(mode: AgentMode, local: boolean): string {
  if (!local) {
    return `<${mode}> `;
  }

  const colors: Record<AgentMode, string> = {
    free: C.cyan,
    ask: C.cyan,
    plan: C.yellow,
    agent: C.green,
  };

  return `${colors[mode]}<${mode}>${C.reset} `;
}

export function tokenFooter(result: AgentRunResult, local: boolean): string {
  if (!result.tokens) {
    return '';
  }

  const { input, output } = result.tokens;
  const costStr = result.cost != null ? ` | cost: $${result.cost.toFixed(4)}` : '';
  const modelStr = result.model ? ` | model: ${result.model}` : '';
  const raw = `[tokens: ${input} in / ${output} out${costStr}${modelStr}]`;

  return local ? `\n${C.gray}${raw}${C.reset}` : `\n${raw}`;
}

export async function getMasterDmRelays(
  pool: SimplePool,
  botRelayUrl: string,
  masterPubkey: string,
): Promise<string[]> {
  try {
    const events = await pool.querySync(Array.from(PROFILE_RELAYS).concat(botRelayUrl), {
      kinds: [10050],
      authors: [masterPubkey],
      limit: 1,
    });

    if (events?.length > 0) {
      const urls = events[0].tags
        .filter((t) => t[0] === 'relay' && t[1])
        .map((t) => ensureWss(t[1]));

      if (urls.length > 0) {
        debug('Master kind:10050 relays:', urls);

        return urls;
      }
    }
  } catch (err) {
    debug('Failed to fetch master kind:10050:', err);
  }

  debug('No kind:10050 for master, using bot relay');

  return [botRelayUrl];
}

export type SendDmProps = {
  pool: SimplePool;
  botRelayUrl: string;
  senderSecretKey: Uint8Array;
  recipientPubkey: string;
  message: string;
  signAuthEvent: (template: EventTemplate) => Promise<VerifiedEvent>;
  redrawPrompt: (() => void) | null;
};

export async function sendDm({
  pool,
  botRelayUrl,
  senderSecretKey,
  recipientPubkey,
  message,
  signAuthEvent,
  redrawPrompt,
}: SendDmProps): Promise<void> {
  const targetRelays = await getMasterDmRelays(pool, botRelayUrl, recipientPubkey);
  const recipientRelayHint = targetRelays[0] ?? botRelayUrl;

  const giftWrap = wrapEvent(
    senderSecretKey,
    { publicKey: recipientPubkey, relayUrl: recipientRelayHint },
    message,
  );

  debug('Publishing to relays:', targetRelays, 'event id:', giftWrap.id);

  const publishResults = await Promise.allSettled(
    pool.publish(targetRelays, giftWrap, { onauth: signAuthEvent }),
  );

  const successCount = publishResults.filter((r) => r.status === 'fulfilled').length;

  const failed = publishResults
    .map((r, idx) => ({ r, relay: targetRelays[idx] ?? 'unknown-relay' }))
    .filter((x) => x.r.status === 'rejected');

  for (const x of failed) {
    const reason =
      x.r.status === 'rejected'
        ? x.r.reason instanceof Error
          ? x.r.reason.message
          : String(x.r.reason)
        : 'unknown';

    logError(`Publish failed on relay ${x.relay}: ${reason}`);
  }

  if (successCount === 0) {
    const reasons = failed
      .map((x) =>
        x.r.status === 'rejected'
          ? x.r.reason instanceof Error
            ? x.r.reason.message
            : String(x.r.reason)
          : 'unknown',
      )
      .join(' | ');

    throw new Error(`DM publish failed on all relays: ${reasons || 'unknown error'}`);
  }

  const sentLine = `${C.gray}[sent]${C.reset} ${message}`;

  if (redrawPrompt) {
    process.stdout.write(`\n${sentLine}\n`);
    redrawPrompt();
  } else {
    log(sentLine);
  }
}
