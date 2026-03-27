// ---------------------------------------------------------------------------
// src/nostr/bunker.ts — NIP-46 Bunker (remote signer) client
//
// Adapted from recall-trainer/src/lib/nostr/BunkerProvider.ts
// + RemoteSignerHelpers.ts. Standalone — no React or app dependencies.
// ---------------------------------------------------------------------------

import type {
  EventTemplate,
  NostrEvent,
  SimplePool,
  VerifiedEvent,
} from 'nostr-tools';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip04,
  nip44,
  verifyEvent,
} from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

import { debug } from '@src/logger';

import { isRelaySuccess, publishSignedEventToRelays } from './relay-publish';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NIP46_KIND = 24133;
const DEFAULT_PERMS = 'sign_event,get_public_key';
const REQUEST_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BunkerSignerData = {
  relays: string[];
  ephemeralSecret: string; // hex
  ephemeralPubkey: string;
  remoteSignerPubkey: string;
  userPubkey: string;
};

type Nip46ResponsePayload = {
  id: string;
  result?: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateRandomHexString(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);

  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
}

function encryptRequest(
  method: string,
  params: string[],
  clientSecret: Uint8Array,
  remoteSignerPubkey: string,
): { encrypted: string; id: string } {
  const id = generateRandomHexString(16);

  const conversationKey = nip44.v2.utils.getConversationKey(
    clientSecret,
    remoteSignerPubkey,
  );

  const encrypted = nip44.encrypt(
    JSON.stringify({ id, method, params }),
    conversationKey,
  );

  return { encrypted, id };
}

function decryptContent(
  content: string,
  senderPubkey: string,
  ephemeralSecret: Uint8Array,
): string | null {
  try {
    if (content.includes('?iv=')) {
      return nip04.decrypt(ephemeralSecret, senderPubkey, content);
    }

    const conversationKey = nip44.v2.utils.getConversationKey(
      ephemeralSecret,
      senderPubkey,
    );

    return nip44.decrypt(content, conversationKey);
  } catch {
    return null;
  }
}

async function sendNip46Request(params: {
  pool: SimplePool;
  relays: string[];
  ephemeralSecret: Uint8Array;
  ephemeralPubkey: string;
  remoteSignerPubkey: string;
  method: string;
  params: string[];
}): Promise<Nip46ResponsePayload> {
  const {
    pool,
    relays,
    ephemeralSecret,
    ephemeralPubkey,
    remoteSignerPubkey,
    method,
  } = params;

  const { encrypted, id } = encryptRequest(
    method,
    params.params,
    ephemeralSecret,
    remoteSignerPubkey,
  );

  const template: EventTemplate = {
    kind: NIP46_KIND,
    content: encrypted,
    tags: [['p', remoteSignerPubkey]],
    created_at: Math.floor(Date.now() / 1000),
  };

  const signedEvent = finalizeEvent(template, ephemeralSecret);

  await Promise.all(pool.publish(relays, signedEvent)).catch((err) => {
    console.error('Failed to publish NIP-46 request to a relay: ', err);

    throw err;
  });

  const publishOutcomes = await publishSignedEventToRelays(relays, signedEvent);

  const acceptedRelays = publishOutcomes
    .filter(isRelaySuccess)
    .map((r) => r.relay);

  if (acceptedRelays.length === 0) {
    throw new Error(`Failed to publish NIP-46 request to any relay`);
  }

  debug('NIP-46 sign request published to relays: ', acceptedRelays);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.close();
      reject(new Error(`NIP-46 request timed out (${method})`));
    }, REQUEST_TIMEOUT_MS);

    const subscriptionFilter = {
      kinds: [NIP46_KIND],
      authors: [remoteSignerPubkey],
      '#p': [ephemeralPubkey],
      limit: 1,
    };

    debug('Subscribing to: ', subscriptionFilter, 'Relays: ', relays);

    const sub = pool.subscribe(relays, subscriptionFilter, {
      onevent: (event) => {
        if (event.kind !== NIP46_KIND || event.pubkey !== remoteSignerPubkey) {
          return;
        }

        const decrypted = decryptContent(
          event.content,
          event.pubkey,
          ephemeralSecret,
        );

        if (!decrypted) {
          clearTimeout(timer);
          sub.close();
          reject(new Error('Failed to decrypt NIP-46 response'));

          return;
        }

        let parsed: Nip46ResponsePayload;
        try {
          parsed = JSON.parse(decrypted) as Nip46ResponsePayload;
        } catch (e) {
          clearTimeout(timer);
          sub.close();
          reject(e);

          return;
        }

        if (parsed.id !== id) {
          return;
        }

        clearTimeout(timer);
        sub.close();

        if (parsed.error) {
          reject(new Error(parsed.error));

          return;
        }

        resolve(parsed);
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Parse bunker URL
// ---------------------------------------------------------------------------

export type ParsedBunkerUrl = {
  remoteSignerPubkey: string;
  relays: string[];
  secret?: string;
};

export function parseBunkerUrl(bunkerUrl: string): ParsedBunkerUrl {
  const trimmed = bunkerUrl.trim();

  if (!trimmed.toLowerCase().startsWith('bunker://')) {
    throw new Error('Invalid bunker URL: must start with bunker://');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Invalid bunker URL: could not parse');
  }

  const remoteSignerPubkey = url.hostname;

  if (!/^[a-fA-F0-9]{64}$/.test(remoteSignerPubkey)) {
    throw new Error('Invalid bunker URL: host must be a 64-char hex pubkey');
  }

  const relays = url.searchParams.getAll('relay').filter((r) => r.length > 0);

  if (relays.length === 0) {
    throw new Error(
      'Invalid bunker URL: at least one relay= param is required',
    );
  }

  const secret = url.searchParams.get('secret') ?? undefined;

  return { remoteSignerPubkey, relays, secret };
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

export function connectBunker(
  pool: SimplePool,
  bunkerUrl: string,
): Promise<BunkerSignerData> {
  const { remoteSignerPubkey, relays, secret } = parseBunkerUrl(bunkerUrl);

  const clientSecret = generateSecretKey();
  const clientPubkey = getPublicKey(clientSecret);

  const { encrypted: connectContent, id: connectId } = encryptRequest(
    'connect',
    [remoteSignerPubkey, secret ?? '', DEFAULT_PERMS],
    clientSecret,
    remoteSignerPubkey,
  );

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.close();
      reject(new Error('Bunker connect timed out'));
    }, REQUEST_TIMEOUT_MS);

    const sub = pool.subscribe(
      relays,
      {
        kinds: [NIP46_KIND],
        authors: [remoteSignerPubkey],
        '#p': [clientPubkey],
        limit: 10,
      },
      {
        onevent: async (event) => {
          if (
            event.kind !== NIP46_KIND ||
            event.pubkey !== remoteSignerPubkey
          ) {
            return;
          }

          const decrypted = decryptContent(
            event.content,
            event.pubkey,
            clientSecret,
          );

          if (!decrypted) {
            return;
          }

          let parsed: { id: string; result?: string; error?: string };
          try {
            parsed = JSON.parse(decrypted);
          } catch {
            return;
          }

          if (parsed.id !== connectId) {
            return;
          }

          if (parsed.error) {
            clearTimeout(timer);
            sub.close();
            reject(new Error(parsed.error));

            return;
          }

          const result = parsed.result ?? '';

          if (result === 'ack' || (secret !== undefined && result === secret)) {
            clearTimeout(timer);
            sub.close();

            try {
              const response = await sendNip46Request({
                pool,
                relays,
                ephemeralSecret: clientSecret,
                ephemeralPubkey: clientPubkey,
                remoteSignerPubkey,
                method: 'get_public_key',
                params: [],
              });

              const userPubkey = response.result?.trim() ?? '';

              if (!/^[a-fA-F0-9]{64}$/.test(userPubkey)) {
                reject(new Error('Invalid get_public_key result'));

                return;
              }

              resolve({
                relays,
                ephemeralSecret: bytesToHex(clientSecret),
                ephemeralPubkey: clientPubkey,
                remoteSignerPubkey,
                userPubkey,
              });
            } catch (err) {
              reject(err);
            }
          }
        },
      },
    );

    const template: EventTemplate = {
      kind: NIP46_KIND,
      pubkey: clientPubkey,
      content: connectContent,
      tags: [['p', remoteSignerPubkey]],
      created_at: Math.floor(Date.now() / 1000),
    } as EventTemplate;

    const signed = finalizeEvent(template, clientSecret);

    void Promise.allSettled(pool.publish(relays, signed)).catch((err) => {
      clearTimeout(timer);
      sub.close();
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Sign event via bunker
// ---------------------------------------------------------------------------

export async function bunkerSignEvent(
  pool: SimplePool,
  data: BunkerSignerData,
  event: EventTemplate,
): Promise<VerifiedEvent> {
  const ephemeralSecret = hexToBytes(data.ephemeralSecret);

  const response = await sendNip46Request({
    pool,
    relays: data.relays,
    ephemeralSecret,
    ephemeralPubkey: data.ephemeralPubkey,
    remoteSignerPubkey: data.remoteSignerPubkey,
    method: 'sign_event',
    params: [JSON.stringify(event)],
  });

  const signed = JSON.parse(response.result ?? 'null') as NostrEvent;

  if (!signed || typeof signed.id !== 'string') {
    throw new Error('Invalid sign_event response from bunker');
  }

  const verified = verifyEvent(signed);

  if (!verified) {
    throw new Error('Failed to verify sign_event response from bunker');
  }

  return signed;
}
