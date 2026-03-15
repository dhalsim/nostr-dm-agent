// ---------------------------------------------------------------------------
// src/nostr/nip17.ts — NIP-17 DM subscribe, send, and auth (kind 1059, rumor wrap/unwrap)
// ---------------------------------------------------------------------------

import type { NostrEvent, EventTemplate, VerifiedEvent } from 'nostr-tools/core';
import { unwrapEvent, wrapEvent } from 'nostr-tools/nip17';
import type { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent } from 'nostr-tools/pure';

import { alreadyHaveEvent, getReplyTransport, markSeen } from '../db';
import type { CoreDb } from '../db';
import { ensureWss } from '../env';
import { C, debug, log, stripAnsi } from '../logger';
import type { MessageSource } from '../messaging';

export const PROFILE_RELAYS = new Set([
  'wss://purplepag.es',
  'wss://relay.nos.social',
  'wss://user.kindpag.es',
  'wss://relay.nostr.band',
]);

export type CreateSignAuthEventProps = {
  botSecretKey: Uint8Array;
};

export function createSignAuthEvent({
  botSecretKey,
}: CreateSignAuthEventProps): (authTemplate: EventTemplate) => Promise<VerifiedEvent> {
  return async (authTemplate: EventTemplate): Promise<VerifiedEvent> => {
    debug('Signing AUTH challenge event:', authTemplate);

    return finalizeEvent(authTemplate, botSecretKey);
  };
}

export async function getMasterDmRelays(
  pool: SimplePool,
  botRelayUrl: string,
  masterPubkey: string,
): Promise<string[]> {
  try {
    const relays = Array.from(PROFILE_RELAYS).concat(botRelayUrl);

    const event = await pool.get(relays, {
      kinds: [10050],
      authors: [masterPubkey],
      limit: 1,
    });

    if (event) {
      const urls = event.tags.filter((t) => t[0] === 'relay' && t[1]).map((t) => ensureWss(t[1]));

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
  const plain = stripAnsi(message);
  const targetRelays = await getMasterDmRelays(pool, botRelayUrl, recipientPubkey);
  const recipientRelayHint = targetRelays[0] ?? botRelayUrl;

  const giftWrap = wrapEvent(
    senderSecretKey,
    { publicKey: recipientPubkey, relayUrl: recipientRelayHint },
    plain,
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

    log.error(`Publish failed on relay ${x.relay}: ${String(reason)}`);
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

  const lines = plain.split('\n');
  const lastLine = lines[lines.length - 1] ?? '';
  const lastIsTokens = lines.length > 0 && /^\[tokens:/.test(lastLine.trimStart());
  const body = lastIsTokens ? lines.slice(0, -1).join('\n') : plain;
  const tokensLine = lastIsTokens ? lastLine : null;
  const bodyStyled = `${C.greenBright}${body}${C.reset}`;
  const tokensStyled = tokensLine ? `\n${C.dim}${tokensLine}${C.reset}` : '';
  const sentLine = `${C.green}[sent]${C.reset} ${bodyStyled}${tokensStyled}`;

  if (redrawPrompt) {
    process.stdout.write(`\n${sentLine}\n`);
    redrawPrompt();
  } else {
    process.stdout.write(`\n${sentLine}\n`);
  }
}

export type CreateSendReplyForSourceProps = {
  seenDb: CoreDb;
  pool: SimplePool;
  botRelayUrl: string;
  senderSecretKey: Uint8Array;
  recipientPubkey: string;
  signAuthEvent: (template: EventTemplate) => Promise<VerifiedEvent>;
};

export function createSendReplyForSource({
  seenDb,
  pool,
  botRelayUrl,
  senderSecretKey,
  recipientPubkey,
  signAuthEvent,
}: CreateSendReplyForSourceProps): (source: MessageSource, message: string) => Promise<void> {
  return async (source: MessageSource, message: string): Promise<void> => {
    const replyTransport = getReplyTransport(seenDb);
    const sourceIsLocal = source === 'local';
    const replyTransportIsLocal = replyTransport === 'local';
    const shouldBypassNostr = sourceIsLocal || replyTransportIsLocal;

    if (shouldBypassNostr) {
      log.info(
        `${C.dim}[bypassing to send as a DM because ${sourceIsLocal ? 'source is local' : 'reply transport is local'}]${C.reset}\n`,
      );

      console.log(message ?? '(no message)');

      return;
    }

    await sendDm({
      pool,
      botRelayUrl,
      senderSecretKey,
      recipientPubkey,
      message,
      signAuthEvent,
      redrawPrompt: null,
    });
  };
}

export type DmFilter = {
  kinds: number[];
  '#p': string[];
  since: number;
};

export type CreateDmSubscriptionProps = {
  pool: SimplePool;
  relayUrls: string[];
  dmFilter: DmFilter;
  signAuthEvent: (authTemplate: EventTemplate) => Promise<VerifiedEvent>;
  seenDb: CoreDb;
  botSecretKey: Uint8Array;
  masterPubkey: string;
  onMessage: (content: string) => Promise<void>;
  redrawPromptRef: { get: () => (() => void) | null };
  reconnectBaseMs: number;
  reconnectMaxMs: number;
};

export function createDmSubscription({
  pool,
  relayUrls,
  dmFilter,
  signAuthEvent,
  seenDb,
  botSecretKey,
  masterPubkey,
  onMessage,
  redrawPromptRef,
  reconnectBaseMs,
  reconnectMaxMs,
}: CreateDmSubscriptionProps): () => void {
  let reconnectAttempt = 0;

  function start(): void {
    debug('Subscribing to DM relays:', relayUrls.join(', '));

    pool.subscribe(relayUrls, dmFilter, {
      onauth: signAuthEvent,
      alreadyHaveEvent: alreadyHaveEvent(seenDb),
      onevent: async (wrap: NostrEvent) => {
        debug('Received event kind:', wrap.kind, 'id:', wrap.id);

        reconnectAttempt = 0;

        try {
          const rumor = unwrapEvent(wrap, botSecretKey);

          if (rumor.pubkey !== masterPubkey) {
            debug('Ignoring rumor from non-master:', rumor.pubkey);

            return;
          }

          const content = rumor.content?.trim() ?? '';
          const kind = rumor.kind ?? 0;

          if (kind !== 14) {
            debug('Ignoring non–kind-14 rumor:', kind);

            return;
          }

          if (getReplyTransport(seenDb) === 'local') {
            markSeen(seenDb, wrap.id);
            debug('Reply transport is local; ignoring incoming Nostr message.');

            redrawPromptRef.get()?.();

            return;
          }

          markSeen(seenDb, wrap.id);
          await onMessage(content);
        } catch (err) {
          debug('Unwrap failed (not for us or wrong format):', err);
        }
      },
      onclose(reasons) {
        debug('Subscription closed:', reasons);

        reconnectAttempt += 1;

        const backoffMs = Math.min(
          reconnectBaseMs * Math.pow(2, reconnectAttempt - 1),
          reconnectMaxMs,
        );

        debug(`Reconnecting DM subscription in ${backoffMs}ms (attempt ${reconnectAttempt})…`);

        setTimeout(() => {
          debug('Reconnecting DM subscription now.');
          start();
        }, backoffMs);
      },
    });
  }

  return start;
}
