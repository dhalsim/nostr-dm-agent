import { nip19 } from 'nostr-tools';
import type { Event } from 'nostr-tools/core';
import type { SimplePool } from 'nostr-tools/pool';
import { z } from 'zod';

import type { CoreDb } from '../db';
import {
  clearWotForRoot,
  replaceWotEdgesForAuthor,
  upsertWotNodes,
  type WotEdgeRow,
  type WotNodeRow,
} from '../db';

import { PROFILE_RELAYS } from './nip17';
import { PROFILE_RELAYS_FOR_QUERY } from './nip65';

const KIND_CONTACTS = 3;
const MAX_SUBSCRIPTION_WAIT_MS = 8_000;

const HexPubkeySchema = z.string().regex(/^[0-9a-f]{64}$/);

export const WotFollowTagSchema = z.object({
  pubkey: HexPubkeySchema,
  relayHint: z.string().nullable(),
  nickname: z.string().nullable(),
});

export type WotFollowTag = z.infer<typeof WotFollowTagSchema>;

export const CrawlWotParamsSchema = z.object({
  pool: z.custom<SimplePool>((value) => value != null),
  db: z.custom<CoreDb>((value) => value != null),
  rootPubkey: HexPubkeySchema,
  maxDepth: z.number().int().positive().default(2),
  chunkSize: z.number().int().positive().default(100),
  concurrency: z.number().int().positive().default(3),
  relays: z.array(z.string()).optional(),
  onProgress: z
    .custom<
      (message: string) => void | Promise<void>
    >((value) => value === undefined || typeof value === 'function')
    .optional(),
});

export type CrawlWotParams = z.input<typeof CrawlWotParamsSchema>;

export function normalizePubkeyInput(input: string): string {
  const trimmed = input.trim();
  const asHex = trimmed.toLowerCase();

  if (HexPubkeySchema.safeParse(asHex).success) {
    return asHex;
  }

  const decoded = nip19.decode(trimmed);

  if (decoded.type !== 'npub') {
    throw new Error('Expected a hex pubkey or npub.');
  }

  return decoded.data.toLowerCase();
}

export function parseFollowList(event: Event): WotFollowTag[] {
  const follows: WotFollowTag[] = [];

  for (const tag of event.tags) {
    if (tag[0] !== 'p' || !tag[1]) {
      continue;
    }

    const parsed = WotFollowTagSchema.safeParse({
      pubkey: tag[1].toLowerCase(),
      relayHint: tag[2] ? tag[2] : null,
      nickname: tag[3] ? tag[3] : null,
    });

    if (parsed.success) {
      follows.push(parsed.data);
    }
  }

  return follows;
}

export async function fetchLatestContactListsForAuthors(
  pool: SimplePool,
  relays: string[],
  authors: string[],
): Promise<Event[]> {
  if (authors.length === 0) {
    return [];
  }

  const filter = {
    kinds: [KIND_CONTACTS],
    authors,
    limit: Math.max(authors.length * 2, 500),
  };

  return new Promise((resolve) => {
    const bestByAuthor = new Map<string, Event>();

    pool.subscribeEose(relays, filter, {
      maxWait: MAX_SUBSCRIPTION_WAIT_MS,
      onevent(event: Event) {
        const current = bestByAuthor.get(event.pubkey);

        if (!current || event.created_at > current.created_at) {
          bestByAuthor.set(event.pubkey, event);
        }
      },
      onclose() {
        resolve(Array.from(bestByAuthor.values()));
      },
    });
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );

  return results;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

export async function crawlWot(input: CrawlWotParams): Promise<void> {
  const { pool, db, rootPubkey, maxDepth, chunkSize, concurrency, onProgress } =
    CrawlWotParamsSchema.parse(input);

  const relays = [
    ...new Set([
      ...(input.relays ?? []),
      ...PROFILE_RELAYS_FOR_QUERY,
      ...PROFILE_RELAYS,
    ]),
  ];

  await onProgress?.('Clearing previous WoT data...');
  clearWotForRoot(db, rootPubkey);

  const seen = new Set<string>([rootPubkey]);
  let currentLevel = new Set<string>([rootPubkey]);
  const storedPubkeys = new Set<string>();

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const authors = [...currentLevel].filter(
      (pubkey) => !storedPubkeys.has(pubkey),
    );

    if (authors.length === 0) {
      currentLevel = new Set<string>();
      continue;
    }

    await onProgress?.(
      depth === 0
        ? 'Fetching root follow list...'
        : `Fetching depth ${depth} (${authors.length} authors)...`,
    );

    const authorChunks = chunk(authors, chunkSize);

    const chunkResults = await mapWithConcurrency(
      authorChunks,
      concurrency,
      async (authorChunk) =>
        fetchLatestContactListsForAuthors(pool, relays, authorChunk),
    );

    const events = chunkResults.flat();

    const eventsByAuthor = new Map(
      events.map((event) => [event.pubkey, event]),
    );

    const fetchedAt = Math.floor(Date.now() / 1000);
    const nodeRows: WotNodeRow[] = [];
    const nextLevel = new Set<string>();

    for (const author of authors) {
      const event = eventsByAuthor.get(author);

      if (!event) {
        nodeRows.push({
          root_pubkey: rootPubkey,
          pubkey: author,
          depth,
          contact_list_created_at: 0,
          follow_list_fetched_at: fetchedAt,
          source_event_id: null,
        });

        replaceWotEdgesForAuthor(db, rootPubkey, author, []);
        storedPubkeys.add(author);

        continue;
      }

      const follows = parseFollowList(event);

      nodeRows.push({
        root_pubkey: rootPubkey,
        pubkey: event.pubkey,
        depth,
        contact_list_created_at: event.created_at,
        follow_list_fetched_at: fetchedAt,
        source_event_id: event.id,
      });

      const edgeRows: WotEdgeRow[] = follows.map((follow) => ({
        root_pubkey: rootPubkey,
        follower_pubkey: event.pubkey,
        followed_pubkey: follow.pubkey,
        relay_hint: follow.relayHint,
        nickname: follow.nickname,
        contact_list_created_at: event.created_at,
      }));

      replaceWotEdgesForAuthor(db, rootPubkey, event.pubkey, edgeRows);
      storedPubkeys.add(event.pubkey);

      for (const follow of follows) {
        if (depth < maxDepth - 1) {
          nextLevel.add(follow.pubkey);
        }

        if (!seen.has(follow.pubkey)) {
          seen.add(follow.pubkey);
        }
      }
    }

    upsertWotNodes(db, nodeRows);
    currentLevel = nextLevel;
  }

  if (currentLevel.size > 0) {
    const placeholderRows: WotNodeRow[] = [...currentLevel]
      .filter((pubkey) => !storedPubkeys.has(pubkey))
      .map((pubkey) => ({
        root_pubkey: rootPubkey,
        pubkey,
        depth: maxDepth,
        contact_list_created_at: 0,
        follow_list_fetched_at: 0,
        source_event_id: null,
      }));

    if (placeholderRows.length > 0) {
      upsertWotNodes(db, placeholderRows);
    }
  }
}
