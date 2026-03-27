// ---------------------------------------------------------------------------
// src/nostr/nip65.ts — NIP-65 relay lists (kind 10050) for profile discovery
// ---------------------------------------------------------------------------

import type { SimplePool } from 'nostr-tools/pool';

import { ensureWss } from '../env';

/** Kind 10050 — relay list metadata (NIP-65). */
export const NIP65_RELAY_LIST_KIND = 10050;

/** Relays used to *find* a pubkey's kind 10050 (same idea as scripts/nostr-setup.ts). */
export const PROFILE_RELAYS_FOR_QUERY: readonly string[] = [
  'wss://purplepag.es',
  'wss://relay.nos.social',
  'wss://user.kindpag.es',
  'wss://relay.damus.io',
  'wss://relay.primal.net',
];

export function parseNip65RelayTags(tags: string[][]): {
  readRelays: string[];
  writeRelays: string[];
} {
  const relayTags = tags.filter((tag) => tag[0] === 'r' && tag[1]);

  const readRelays = relayTags
    .filter((tag) => tag[2] === 'read' || !tag[2])
    .map((tag) => ensureWss(tag[1]));

  const writeRelays = relayTags
    .filter((tag) => tag[2] === 'write' || !tag[2])
    .map((tag) => ensureWss(tag[1]));

  return { readRelays, writeRelays };
}

type FetchNip65WriteRelaysProps = {
  pool: SimplePool;
  authorPubkey: string;
};

/**
 * Write-capable relays from `authorPubkey`'s kind 10050. Use with `pool.get` when
 * fetching other events (e.g. kind 10063 for `userPubkey`). Falls back to
 * {@link PROFILE_RELAYS_FOR_QUERY} if no event or no `r` tags.
 */
export async function fetchNip65WriteRelays({
  pool,
  authorPubkey,
}: FetchNip65WriteRelaysProps): Promise<string[]> {
  const nip65Event = await pool.get([...PROFILE_RELAYS_FOR_QUERY], {
    kinds: [NIP65_RELAY_LIST_KIND],
    authors: [authorPubkey],
    limit: 1,
  });

  if (!nip65Event) {
    return [...new Set(PROFILE_RELAYS_FOR_QUERY.map(ensureWss))];
  }

  const { writeRelays } = parseNip65RelayTags(nip65Event.tags);

  if (writeRelays.length === 0) {
    return [...new Set(PROFILE_RELAYS_FOR_QUERY.map(ensureWss))];
  }

  return [...new Set(writeRelays)];
}
