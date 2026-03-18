// ---------------------------------------------------------------------------
// src/nostr/connections.ts — Persisted Nostr signer connections
//
// Stores named bunker connections in the core DB so scripts don't need to
// re-paste the bunker URL on every run.
//
// Security note: ephemeralSecret is stored as hex in the DB. Ensure the
// DB file has restricted permissions (600). The ephemeral key is a session
// key, not your actual Nostr key — compromise allows signing requests to be
// made to your bunker but your real key stays in the signer app.
// ---------------------------------------------------------------------------

import { z } from 'zod';

import type { CoreDb } from '@src/db';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const BunkerSignerDataSchema = z.object({
  relays: z.array(z.string()),
  ephemeralSecret: z.string().length(64), // hex
  ephemeralPubkey: z.string().length(64),
  remoteSignerPubkey: z.string().length(64),
  userPubkey: z.string().length(64),
});

export type BunkerSignerData = z.infer<typeof BunkerSignerDataSchema>;

export type ConnectionMethod = 'bunker';

export type ConnectionRow = {
  name: string;
  method: ConnectionMethod;
  data: BunkerSignerData;
  created_at: number;
};

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export function createConnectionsTable(db: CoreDb): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS connections (
      name       TEXT PRIMARY KEY,
      method     TEXT NOT NULL,
      data       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function saveConnection(
  db: CoreDb,
  name: string,
  method: ConnectionMethod,
  data: BunkerSignerData,
): void {
  db.run(
    `INSERT OR REPLACE INTO connections (name, method, data, created_at)
     VALUES (?, ?, ?, ?)`,
    [name, method, JSON.stringify(data), Date.now()],
  );
}

export function getConnection(db: CoreDb, name: string): ConnectionRow | null {
  const row = db
    .prepare('SELECT * FROM connections WHERE name = ?')
    .get(name) as Record<string, unknown> | undefined;

  if (!row) {
    return null;
  }

  return rowToConnection(row);
}

export function listConnections(db: CoreDb): ConnectionRow[] {
  const rows = db
    .prepare('SELECT * FROM connections ORDER BY created_at DESC')
    .all() as Record<string, unknown>[];

  return rows.map(rowToConnection);
}

export function deleteConnection(db: CoreDb, name: string): boolean {
  return (
    db.prepare('DELETE FROM connections WHERE name = ?').run(name).changes > 0
  );
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function rowToConnection(row: Record<string, unknown>): ConnectionRow {
  const parsed = BunkerSignerDataSchema.parse(JSON.parse(String(row.data)));

  return {
    name: String(row.name),
    method: String(row.method) as ConnectionMethod,
    data: parsed,
    created_at: Number(row.created_at),
  };
}
