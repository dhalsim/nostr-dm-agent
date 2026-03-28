import { z } from 'zod';

import type { CoreDb } from './shared';

const HexPubkeySchema = z.string().regex(/^[0-9a-f]{64}$/);

const NullableTextSchema = z.preprocess(
  (value) => (value == null ? null : String(value)),
  z.string().nullable(),
);

const SqliteIntSchema = z.coerce.number().int().nonnegative();

export const WotNodeRowSchema = z.object({
  root_pubkey: HexPubkeySchema,
  pubkey: HexPubkeySchema,
  depth: SqliteIntSchema,
  contact_list_created_at: SqliteIntSchema,
  follow_list_fetched_at: SqliteIntSchema,
  source_event_id: NullableTextSchema,
});

export type WotNodeRow = z.infer<typeof WotNodeRowSchema>;

export const WotEdgeRowSchema = z.object({
  root_pubkey: HexPubkeySchema,
  follower_pubkey: HexPubkeySchema,
  followed_pubkey: HexPubkeySchema,
  relay_hint: NullableTextSchema,
  nickname: NullableTextSchema,
  contact_list_created_at: SqliteIntSchema,
});

export type WotEdgeRow = z.infer<typeof WotEdgeRowSchema>;

export const WotRootStatsSchema = z.object({
  root_pubkey: HexPubkeySchema,
  node_count: SqliteIntSchema,
  edge_count: SqliteIntSchema,
  max_depth: SqliteIntSchema,
  last_fetched_at: SqliteIntSchema,
});

export type WotRootStats = z.infer<typeof WotRootStatsSchema>;

export const WotScoreSchema = z.object({
  pubkey: HexPubkeySchema,
  root_pubkey: HexPubkeySchema,
  depth: SqliteIntSchema,
  score: z.number().nonnegative().nullable(),
});

export type WotScore = z.infer<typeof WotScoreSchema>;

export const WotScoreDetailsSchema = z.object({
  pubkey: HexPubkeySchema,
  root_pubkey: HexPubkeySchema,
  depth: SqliteIntSchema,
  score: z.number().nonnegative().nullable(),
  score_percent: z.number().nonnegative().nullable(),
  base_score: z.number().nonnegative().nullable(),
  following_count: SqliteIntSchema,
  follower_count: SqliteIntSchema,
  weighted_support: z.number().nonnegative(),
  normalized_support: z.number().min(0).max(1),
});

export type WotScoreDetails = z.infer<typeof WotScoreDetailsSchema>;

/**
 * WoT stores one root-relative graph snapshot per crawl.
 *
 * - `wot_nodes` keeps node-level facts for one `(root_pubkey, pubkey)` pair.
 * - `wot_edges` keeps directed follow edges discovered from fetched contact lists.
 * - Full replacement is per root: clear the old snapshot, then write the new one.
 * - `follow_list_fetched_at` means when we fetched this pubkey's own kind:3 list.
 * - `relay_hint` and `nickname` are last-seen contact-list tag metadata, not profile truth.
 */
export function createWotTables(db: CoreDb): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS wot_nodes (
      root_pubkey TEXT NOT NULL,
      pubkey TEXT NOT NULL,
      depth INTEGER NOT NULL,
      contact_list_created_at INTEGER NOT NULL,
      follow_list_fetched_at INTEGER NOT NULL,
      source_event_id TEXT,
      PRIMARY KEY (root_pubkey, pubkey)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS wot_edges (
      root_pubkey TEXT NOT NULL,
      follower_pubkey TEXT NOT NULL,
      followed_pubkey TEXT NOT NULL,
      relay_hint TEXT,
      nickname TEXT,
      contact_list_created_at INTEGER NOT NULL,
      PRIMARY KEY (root_pubkey, follower_pubkey, followed_pubkey)
    )
  `);

  db.run(
    'CREATE INDEX IF NOT EXISTS idx_wot_nodes_root_depth ON wot_nodes (root_pubkey, depth)',
  );

  db.run(
    'CREATE INDEX IF NOT EXISTS idx_wot_edges_root_followed ON wot_edges (root_pubkey, followed_pubkey)',
  );

  db.run(
    'CREATE INDEX IF NOT EXISTS idx_wot_edges_root_follower ON wot_edges (root_pubkey, follower_pubkey)',
  );
}

export function clearWotForRoot(db: CoreDb, rootPubkey: string): void {
  const normalizedRootPubkey = rootPubkey.toLowerCase();

  db.run('DELETE FROM wot_edges WHERE root_pubkey = ?', [normalizedRootPubkey]);
  db.run('DELETE FROM wot_nodes WHERE root_pubkey = ?', [normalizedRootPubkey]);
}

export function upsertWotNodes(db: CoreDb, rows: WotNodeRow[]): void {
  const parsedRows = z.array(WotNodeRowSchema).parse(rows);

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO wot_nodes (
      root_pubkey,
      pubkey,
      depth,
      contact_list_created_at,
      follow_list_fetched_at,
      source_event_id
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const row of parsedRows) {
    stmt.run(
      row.root_pubkey,
      row.pubkey,
      row.depth,
      row.contact_list_created_at,
      row.follow_list_fetched_at,
      row.source_event_id,
    );
  }
}

export function replaceWotEdgesForAuthor(
  db: CoreDb,
  rootPubkey: string,
  followerPubkey: string,
  rows: WotEdgeRow[],
): void {
  const parsedRows = z.array(WotEdgeRowSchema).parse(rows);

  db.run(
    'DELETE FROM wot_edges WHERE root_pubkey = ? AND follower_pubkey = ?',
    [rootPubkey, followerPubkey],
  );

  if (parsedRows.length === 0) {
    return;
  }

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO wot_edges (
      root_pubkey,
      follower_pubkey,
      followed_pubkey,
      relay_hint,
      nickname,
      contact_list_created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const row of parsedRows) {
    stmt.run(
      row.root_pubkey,
      row.follower_pubkey,
      row.followed_pubkey,
      row.relay_hint,
      row.nickname,
      row.contact_list_created_at,
    );
  }
}

export function getWotDepth(
  db: CoreDb,
  pubkey: string,
  rootPubkey: string,
): number | null {
  const normalizedPubkey = pubkey.toLowerCase();
  const normalizedRootPubkey = rootPubkey.toLowerCase();

  const row = db
    .prepare(
      'SELECT root_pubkey, pubkey, depth, contact_list_created_at, follow_list_fetched_at, source_event_id FROM wot_nodes WHERE root_pubkey = ? AND pubkey = ?',
    )
    .get(normalizedRootPubkey, normalizedPubkey) as
    | Record<string, unknown>
    | undefined;

  if (!row) {
    return null;
  }

  return WotNodeRowSchema.parse(row).depth;
}

export function getWotFollowerCount(
  db: CoreDb,
  pubkey: string,
  rootPubkey: string,
): number {
  const normalizedPubkey = pubkey.toLowerCase();
  const normalizedRootPubkey = rootPubkey.toLowerCase();

  const row = db
    .prepare(
      'SELECT COUNT(*) AS follower_count FROM wot_edges WHERE root_pubkey = ? AND followed_pubkey = ?',
    )
    .get(normalizedRootPubkey, normalizedPubkey) as
    | { follower_count: number }
    | undefined;

  return SqliteIntSchema.parse(row?.follower_count ?? 0);
}

export function getWotWeightedSupport(
  db: CoreDb,
  pubkey: string,
  rootPubkey: string,
): number {
  const depth = getWotDepth(db, pubkey, rootPubkey);

  if (depth === null || depth === 0) {
    return 0;
  }

  const normalizedPubkey = pubkey.toLowerCase();
  const normalizedRootPubkey = rootPubkey.toLowerCase();

  const rows = db
    .prepare(
      `
        SELECT n.depth AS follower_depth
        FROM wot_edges e
        JOIN wot_nodes n
          ON n.root_pubkey = e.root_pubkey
         AND n.pubkey = e.follower_pubkey
        WHERE e.root_pubkey = ?
          AND e.followed_pubkey = ?
          AND n.depth > 0
      `,
    )
    .all(normalizedRootPubkey, normalizedPubkey) as Array<{
    follower_depth: number;
  }>;

  let weight = 0;

  for (const row of rows) {
    const followerDepth = SqliteIntSchema.parse(row.follower_depth);

    weight += 1 / 2 ** (followerDepth - 1);
  }

  return weight;
}

function getBaseScore(depth: number | null): number | null {
  if (depth === null || depth === 0) {
    return null;
  }

  return 100 / 2 ** (depth - 1);
}

function getSupportBonusFactor(weightedSupport: number): number {
  return Math.max(0, Math.min(1, weightedSupport));
}

export function getWotDepthCount(
  db: CoreDb,
  depth: number,
  rootPubkey: string,
): number {
  const normalizedRootPubkey = rootPubkey.toLowerCase();
  const normalizedDepth = SqliteIntSchema.parse(depth);

  const row = db
    .prepare(
      'SELECT COUNT(*) AS node_count FROM wot_nodes WHERE root_pubkey = ? AND depth = ?',
    )
    .get(normalizedRootPubkey, normalizedDepth) as
    | { node_count: number }
    | undefined;

  return SqliteIntSchema.parse(row?.node_count ?? 0);
}

export function getWotScore(
  db: CoreDb,
  pubkey: string,
  rootPubkey: string,
): number | null {
  return getWotScoreDetails(db, pubkey, rootPubkey)?.score ?? null;
}

export function getWotFollowingCount(
  db: CoreDb,
  pubkey: string,
  rootPubkey: string,
): number {
  const normalizedPubkey = pubkey.toLowerCase();
  const normalizedRootPubkey = rootPubkey.toLowerCase();

  const row = db
    .prepare(
      'SELECT COUNT(*) AS following_count FROM wot_edges WHERE root_pubkey = ? AND follower_pubkey = ?',
    )
    .get(normalizedRootPubkey, normalizedPubkey) as
    | { following_count: number }
    | undefined;

  return SqliteIntSchema.parse(row?.following_count ?? 0);
}

export function getWotScoreDetails(
  db: CoreDb,
  pubkey: string,
  rootPubkey: string,
): WotScoreDetails | null {
  const depth = getWotDepth(db, pubkey, rootPubkey);

  if (depth === null) {
    return null;
  }

  const normalizedPubkey = pubkey.toLowerCase();
  const normalizedRootPubkey = rootPubkey.toLowerCase();
  const baseScore = getBaseScore(depth);

  const weightedSupport = getWotWeightedSupport(
    db,
    normalizedPubkey,
    normalizedRootPubkey,
  );

  const directFollowCount = getWotDepthCount(db, 1, normalizedRootPubkey);

  const normalizedSupport =
    directFollowCount === 0
      ? 0
      : Math.min(1, weightedSupport / directFollowCount);

  const score =
    baseScore === null
      ? null
      : Math.min(
          100,
          baseScore +
            (100 - baseScore) * getSupportBonusFactor(normalizedSupport),
        );

  return WotScoreDetailsSchema.parse({
    pubkey: normalizedPubkey,
    root_pubkey: normalizedRootPubkey,
    depth,
    score,
    score_percent: score,
    base_score: baseScore,
    following_count: getWotFollowingCount(
      db,
      normalizedPubkey,
      normalizedRootPubkey,
    ),
    follower_count: getWotFollowerCount(
      db,
      normalizedPubkey,
      normalizedRootPubkey,
    ),
    weighted_support: weightedSupport,
    normalized_support: normalizedSupport,
  });
}

export function getWotRootStats(
  db: CoreDb,
  rootPubkey: string,
): WotRootStats | null {
  const normalizedRootPubkey = rootPubkey.toLowerCase();

  const row = db
    .prepare(
      `
      SELECT
        ? AS root_pubkey,
        COUNT(*) AS node_count,
        COALESCE((SELECT COUNT(*) FROM wot_edges WHERE root_pubkey = ?), 0) AS edge_count,
        COALESCE(MAX(depth), 0) AS max_depth,
        COALESCE(MAX(follow_list_fetched_at), 0) AS last_fetched_at
      FROM wot_nodes
      WHERE root_pubkey = ?
    `,
    )
    .get(normalizedRootPubkey, normalizedRootPubkey, normalizedRootPubkey) as
    | Record<string, unknown>
    | undefined;

  if (!row || Number(row.node_count ?? 0) === 0) {
    return null;
  }

  return WotRootStatsSchema.parse(row);
}
