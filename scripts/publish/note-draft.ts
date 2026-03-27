#!/usr/bin/env bun
// scripts/publish/note-draft.ts — create or edit kind 30024 draft (NIP-23)
//
// Usage: bun scripts/publish/note-draft.ts <json>
// Output: JSON string — naddr of the draft
//
// @see https://nips.nostr.com/23

import { nip19 } from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';
import { z } from 'zod';

import { openCoreDb } from '@src/db';
import { debug } from '@src/logger';
import { bunkerSignEvent } from '@src/nostr/bunker';
import { createConnectionsTable, getConnection } from '@src/nostr/connections';
import {
  buildDraftEventTemplate,
  NIP23_DRAFT_KIND,
  slugifyForDTag,
} from '@src/nostr/nip23';
import { fetchNip65WriteRelays } from '@src/nostr/nip65';
import {
  publishSignedEventToRelays,
  summarizeRelayOutcomes,
} from '@src/nostr/relay-publish';

export const schema = z.object({
  bunker: z.string().min(1),
  action: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('create'),
      content: z.string().min(1),
      title: z.string().min(1),
      summary: z.string().min(1),
      slug: z.string().optional(),
      tags: z.array(z.string()).min(1),
      image: z.string(),
    }),
    z.object({
      type: z.literal('edit'),
      naddr: z.string().min(1),
      content: z.string().min(1),
      title: z.string().min(1),
      summary: z.string().min(1),
      tags: z.array(z.string()).min(1),
      image: z.string(),
    }),
  ]),
});

export type NoteDraftInput = z.infer<typeof schema>;

function normalizeNaddrInput(raw: string): string {
  const t = raw.trim();

  if (t.startsWith('nostr:')) {
    return t.slice('nostr:'.length);
  }

  return t;
}

function normalizeImageForTags(image: string): string | null {
  const x = image.trim();

  if (x === '') {
    return null;
  }

  return x;
}

async function runDraft(input: NoteDraftInput): Promise<string> {
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

    debug('Publishing to: ', publishRelays);

    let d: string;
    let template;

    if (input.action.type === 'create') {
      const a = input.action;

      d =
        a.slug !== undefined && a.slug.trim() !== ''
          ? slugifyForDTag(a.slug)
          : slugifyForDTag(a.title);

      template = buildDraftEventTemplate({
        content: a.content,
        d,
        title: a.title,
        summary: a.summary,
        image: normalizeImageForTags(a.image),
        topicTags: a.tags,
      });
    } else {
      const a = input.action;
      const decoded = nip19.decode(normalizeNaddrInput(a.naddr));

      if (decoded.type !== 'naddr') {
        throw new Error('edit: expected naddr');
      }

      const { kind, pubkey, identifier } = decoded.data;

      if (kind !== NIP23_DRAFT_KIND) {
        throw new Error(
          `edit: expected kind ${NIP23_DRAFT_KIND} draft, got ${kind}`,
        );
      }

      if (pubkey !== bunkerData.userPubkey) {
        throw new Error(
          'edit: naddr pubkey does not match this bunker identity',
        );
      }

      d = identifier;

      template = buildDraftEventTemplate({
        content: a.content,
        d,
        title: a.title,
        summary: a.summary,
        image: normalizeImageForTags(a.image),
        topicTags: a.tags,
      });
    }

    const signed = await bunkerSignEvent(pool, bunkerData, template);

    const outcomes = await publishSignedEventToRelays(publishRelays, signed);
    const { accepted, rejected } = summarizeRelayOutcomes(outcomes);

    if (accepted.length === 0) {
      const errs = rejected.map((r) => `${r.relay}: ${r.error}`);

      throw new Error(
        `Publish failed on all relays${errs.length > 0 ? `: ${errs.join('; ')}` : ''}`,
      );
    }

    debug(
      'Accepted relay URLs: ',
      accepted.map((r) => r.relay),
    );

    debug(
      'Rejected relay URLs: ',
      rejected.map((r) => `${r.relay}: ${r.error}`),
    );

    const relayHints = accepted.map((r) => r.relay).slice(0, 4);

    return nip19.naddrEncode({
      kind: NIP23_DRAFT_KIND,
      pubkey: bunkerData.userPubkey,
      identifier: d,
      relays: relayHints.length > 0 ? relayHints : undefined,
    });
  } finally {
    pool.close([...new Set([...bunkerData.relays, ...publishRelays])]);
  }
}

async function main(): Promise<void> {
  const json = process.argv[2];

  if (json === undefined || json === '') {
    debug('Usage: bun scripts/publish/note-draft.ts <json>');
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
    const naddr = await runDraft(parsed.data);

    process.stdout.write(naddr);

    process.exit(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (import.meta.main) {
  void main();
}
