#!/usr/bin/env bun
// scripts/publish/note-fetch-event.ts — fetch latest kind 30024 draft by naddr (NIP-23)
//
// Usage: bun scripts/publish/note-fetch-event.ts <naddr>
// Output: JSON { content, title, summary, tags[], slug, image }
//
// @see https://nips.nostr.com/23

import { nip19 } from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';

import { ensureWss } from '@src/env';
import {
  NIP23_DRAFT_KIND,
  parseNip23LongFormFromEvent,
} from '@src/nostr/nip23';
import { PROFILE_RELAYS_FOR_QUERY } from '@src/nostr/nip65';

function normalizeNaddrInput(raw: string): string {
  const t = raw.trim();

  if (t.startsWith('nostr:')) {
    return t.slice('nostr:'.length);
  }

  return t;
}

function relayUrlsForFetch(naddrRelays: string[] | undefined): string[] {
  const hinted = (naddrRelays ?? []).map(ensureWss).filter(Boolean);
  const fallback = PROFILE_RELAYS_FOR_QUERY.map(ensureWss);

  return [...new Set([...hinted, ...fallback])];
}

async function main(): Promise<void> {
  const argv = process.argv[2]?.trim() ?? '';

  if (argv === '') {
    console.error('Usage: bun scripts/publish/note-fetch-event.ts <naddr>');
    process.exit(1);
  }

  try {
    const decoded = nip19.decode(normalizeNaddrInput(argv));

    if (decoded.type !== 'naddr') {
      throw new Error('Expected an naddr (draft address)');
    }

    const { kind, pubkey, identifier, relays } = decoded.data;

    if (kind !== NIP23_DRAFT_KIND) {
      throw new Error(
        `Expected kind ${NIP23_DRAFT_KIND} draft naddr, got ${kind}`,
      );
    }

    const relayUrls = relayUrlsForFetch(relays);

    console.error('Fetching draft from relays:', relayUrls);

    const pool = new SimplePool({ enablePing: true, enableReconnect: true });

    try {
      const events = await pool.querySync(relayUrls, {
        authors: [pubkey],
        kinds: [NIP23_DRAFT_KIND],
        '#d': [identifier],
      });

      if (events.length === 0) {
        throw new Error(
          'No matching draft found on these relays (try another client or republish the draft)',
        );
      }

      events.sort((a, b) => b.created_at - a.created_at);

      const latest = events[0];
      const parsed = parseNip23LongFormFromEvent(latest);

      console.log(JSON.stringify(parsed));
    } finally {
      pool.close(relayUrls);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (import.meta.main) {
  void main();
}
