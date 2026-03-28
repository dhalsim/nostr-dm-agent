import { Database } from 'bun:sqlite';

import { createConnectionsTable } from '../nostr/connections';
import { CORE_DB_PATH, RESTART_REQUESTED_PATH } from '../paths';

import type { CoreDb } from './shared';
import { createWotTables } from './wot';

export { CORE_DB_PATH as SEEN_DB_PATH, RESTART_REQUESTED_PATH };

export function openCoreDb(): CoreDb {
  const db = new Database(CORE_DB_PATH);
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA busy_timeout=5000');
  db.run('CREATE TABLE IF NOT EXISTS seen_events (id TEXT PRIMARY KEY)');

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      backend TEXT NOT NULL DEFAULT 'cursor'
    )
  `);

  try {
    db.run(
      "ALTER TABLE sessions ADD COLUMN backend TEXT NOT NULL DEFAULT 'cursor'",
    );
  } catch {
    /* Column already exists */
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS session_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  db.run('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT)');

  db.run(`
    CREATE TABLE IF NOT EXISTS spend_log (
      id             INTEGER PRIMARY KEY,
      ts             INTEGER NOT NULL,
      provider       TEXT NOT NULL,
      mint_url       TEXT NOT NULL,
      budget_msats   INTEGER NOT NULL,
      refund_msats   INTEGER NOT NULL DEFAULT 0,
      spent_msats    INTEGER NOT NULL,
      fee_msats      INTEGER NOT NULL DEFAULT 0,
      model          TEXT,
      session_id     TEXT,
      prompt_prefix  TEXT,
      type           TEXT NOT NULL DEFAULT 'run'
    )
  `);

  createConnectionsTable(db as CoreDb);
  createWotTables(db as CoreDb);

  return db as CoreDb;
}

export function alreadyHaveEvent(db: CoreDb): (id: string) => boolean {
  const stmt = db.prepare('SELECT 1 FROM seen_events WHERE id = ?');

  return (id: string) => stmt.get(id) !== null;
}

export function markSeen(db: CoreDb, id: string): void {
  db.run('INSERT OR IGNORE INTO seen_events (id) VALUES (?)', [id]);
}
