#!/usr/bin/env bun
// scripts/publish/note-publish.ts — publish kind:1 or promote kind:30024 → 30023
//
// Usage: bun scripts/publish/note-publish.ts '<json>'
// Output: naddr string (kind:30023) or nevent string (kind:1)

import { nip19 } from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';
import { z } from 'zod';

import { openCoreDb } from '@src/db';
import { bunkerSignEvent } from '@src/nostr/bunker';
import { createConnectionsTable, getConnection } from '@src/nostr/connections';
import {
  NIP23_DRAFT_KIND,
  NIP23_PUBLISHED_KIND,
  publishedTemplateFromDraft,
} from '@src/nostr/nip23';
import { fetchNip65WriteRelays } from '@src/nostr/nip65';
import {
  publishSignedEventToRelays,
  summarizeRelayOutcomes,
} from '@src/nostr/relay-publish';

function normalizeNaddrInput(raw: string): string {
  const t = raw.trim();

  if (t.startsWith('nostr:')) {
    return t.slice('nostr:'.length);
  }

  return t;
}

export const schema = z.object({
  bunker: z.string().min(1),
  source: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('naddr'),
      naddr: z.string().min(1),
    }),
    z.object({
      type: z.literal('text'),
      content: z.string().min(1),
    }),
  ]),
});

export type NotePublishInput = z.infer<typeof schema>;

async function runPublish(input: NotePublishInput): Promise<string> {
  const db = openCoreDb();
  createConnectionsTable(db);

  const row = getConnection(db, input.bunker);

  if (!row) {
    throw new Error(`Unknown bunker connection: ${input.bunker}`);
  }

  if (row.method !== 'bunker') {
    throw new Error(`Connection "${input.bunker}" is not a bunker connection`);
  }

  const bunkerData = row.data;
  const pool = new SimplePool({ enablePing: true, enableReconnect: true });
  let publishRelays: string[] = [];

  try {
    publishRelays = await fetchNip65WriteRelays({
      pool,
      authorPubkey: bunkerData.userPubkey,
    });

    console.log('Publishing to: ', publishRelays);

    if (input.source.type === 'naddr') {
      const decoded = nip19.decode(normalizeNaddrInput(input.source.naddr));

      if (decoded.type !== 'naddr') {
        throw new Error('naddr publish: expected naddr');
      }

      const { kind, pubkey, identifier } = decoded.data;

      if (kind !== NIP23_DRAFT_KIND) {
        throw new Error(
          `naddr publish: expected kind ${NIP23_DRAFT_KIND} draft naddr`,
        );
      }

      if (pubkey !== bunkerData.userPubkey) {
        throw new Error('naddr pubkey does not match this bunker identity');
      }

      const draft = await pool.get(publishRelays, {
        kinds: [NIP23_DRAFT_KIND],
        authors: [pubkey],
        '#d': [identifier],
      });

      if (!draft) {
        throw new Error(
          'Draft not found on write relays; publish the draft first or wait for sync',
        );
      }

      const promoteTemplate = publishedTemplateFromDraft(draft);

      const signedArticle = await bunkerSignEvent(
        pool,
        bunkerData,
        promoteTemplate,
      );

      const promoteOutcomes = await publishSignedEventToRelays(
        publishRelays,
        signedArticle,
      );

      const promoteSummary = summarizeRelayOutcomes(promoteOutcomes);

      if (promoteSummary.accepted.length === 0) {
        const errs = promoteSummary.rejected.map(
          (r) => `${r.relay}: ${r.error}`,
        );

        throw new Error(
          `Publish failed on all relays${errs.length > 0 ? `: ${errs.join('; ')}` : ''}`,
        );
      }

      console.log(
        'Accepted relay URLs: ',
        promoteSummary.accepted.map((r) => r.relay),
      );

      console.log(
        'Rejected relay URLs: ',
        promoteSummary.rejected.map((r) => `${r.relay}: ${r.error}`),
      );

      const relayHints = promoteSummary.accepted
        .map((r) => r.relay)
        .slice(0, 4);

      return nip19.naddrEncode({
        kind: NIP23_PUBLISHED_KIND,
        pubkey: bunkerData.userPubkey,
        identifier,
        relays: relayHints.length > 0 ? relayHints : undefined,
      });
    }

    const template = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      content: input.source.content,
      tags: [] as string[][],
    };

    const signed = await bunkerSignEvent(pool, bunkerData, template);

    const outcomes = await publishSignedEventToRelays(publishRelays, signed);
    const { accepted, rejected } = summarizeRelayOutcomes(outcomes);

    if (accepted.length === 0) {
      const errs = rejected.map((r) => `${r.relay}: ${r.error}`);

      throw new Error(
        `Publish failed on all relays${errs.length > 0 ? `: ${errs.join('; ')}` : ''}`,
      );
    }

    console.log(
      'Accepted relay URLs: ',
      accepted.map((r) => r.relay),
    );

    console.log(
      'Rejected relay URLs: ',
      rejected.map((r) => `${r.relay}: ${r.error}`),
    );

    const relayHints = accepted.map((r) => r.relay).slice(0, 4);

    return nip19.neventEncode({
      id: signed.id,
      relays: relayHints.length > 0 ? relayHints : undefined,
    });
  } finally {
    pool.close([...new Set([...bunkerData.relays, ...publishRelays])]);
  }
}

async function main(): Promise<void> {
  const json = process.argv[2];

  if (json === undefined || json === '') {
    console.error("Usage: bun scripts/publish/note-publish.ts '<json>'");
    process.exit(1);
  }

  let data: unknown;

  try {
    data = JSON.parse(json);
  } catch {
    console.error('Invalid JSON');
    process.exit(1);
  }

  const parsed = schema.safeParse(data);

  if (!parsed.success) {
    console.error(parsed.error.flatten());
    process.exit(1);
  }

  try {
    const result = await runPublish(parsed.data);

    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  process.exit(0);
}

if (import.meta.main) {
  void main();
}
