// ---------------------------------------------------------------------------
// db.ts — SQLite persistence: seen events, state, sessions schema
// ---------------------------------------------------------------------------
import { join } from 'path';

import { Database } from 'bun:sqlite';
import { z } from 'zod';

import { assertUnreachable } from './logger';

export const SEEN_DB_PATH = join(import.meta.dir ?? process.cwd(), 'dm-bot.sqlite');
export const RESTART_REQUESTED_PATH = join(import.meta.dir ?? process.cwd(), 'restart.requested');

export const AgentModeSchema = z.enum(['free', 'ask', 'plan', 'agent']);
export type AgentMode = z.infer<typeof AgentModeSchema>;

export const AgentBackendNameSchema = z.enum(['cursor', 'opencode']);
export type AgentBackendName = z.infer<typeof AgentBackendNameSchema>;

export const ReplyTransportSchema = z.enum(['remote', 'local']);
export type ReplyTransport = z.infer<typeof ReplyTransportSchema>;

export const WorkspaceTargetSchema = z.enum(['parent', 'bot']);
export type WorkspaceTarget = z.infer<typeof WorkspaceTargetSchema>;

export const STATE_CURRENT_SESSION = 'current_session_id';
export const STATE_DEFAULT_MODE = 'default_mode';
export const STATE_AGENT_BACKEND = 'agent_backend';
export const STATE_REPLY_TRANSPORT = 'reply_transport';
export const STATE_WORKSPACE_TARGET = 'workspace_target';

export const DEFAULT_MODE: AgentMode = 'ask';
export const DEFAULT_BACKEND: AgentBackendName = 'cursor';
export const DEFAULT_REPLY_TRANSPORT: ReplyTransport = 'remote';
export const DEFAULT_WORKSPACE_TARGET: WorkspaceTarget = 'parent';

export function openSeenDb(): Database {
  const db = new Database(SEEN_DB_PATH);
  db.run('CREATE TABLE IF NOT EXISTS seen_events (id TEXT PRIMARY KEY)');

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      backend TEXT NOT NULL DEFAULT 'cursor'
    )
  `);

  try {
    db.run("ALTER TABLE sessions ADD COLUMN backend TEXT NOT NULL DEFAULT 'cursor'");
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

  return db;
}

export function alreadyHaveEvent(db: Database): (id: string) => boolean {
  const stmt = db.prepare('SELECT 1 FROM seen_events WHERE id = ?');

  return (id: string) => stmt.get(id) !== null;
}

export function markSeen(db: Database, id: string): void {
  db.run('INSERT OR IGNORE INTO seen_events (id) VALUES (?)', [id]);
}

export function getState(db: Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;

  return row?.value ?? null;
}

export function setState(db: Database, key: string, value: string): void {
  db.run('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)', [key, value]);
}

export function getDefaultMode(db: Database): AgentMode {
  const v = getState(db, STATE_DEFAULT_MODE);
  const parsed = AgentModeSchema.safeParse(v);

  if (!parsed.success) {
    return DEFAULT_MODE;
  }

  const mode = parsed.data;
  switch (mode) {
    case 'free':
      return mode;
    case 'ask':
      return mode;
    case 'plan':
      return mode;
    case 'agent':
      return mode;
    default:
      return assertUnreachable(mode);
  }
}

export function setDefaultMode(db: Database, mode: AgentMode): void {
  setState(db, STATE_DEFAULT_MODE, mode);
}

export function getAgentBackend(db: Database): AgentBackendName {
  const v = getState(db, STATE_AGENT_BACKEND);

  return AgentBackendNameSchema.safeParse(v).data ?? DEFAULT_BACKEND;
}

export function setAgentBackend(db: Database, backend: AgentBackendName): void {
  setState(db, STATE_AGENT_BACKEND, backend);
}

export function getReplyTransport(db: Database): ReplyTransport {
  const v = getState(db, STATE_REPLY_TRANSPORT);

  return ReplyTransportSchema.safeParse(v).data ?? DEFAULT_REPLY_TRANSPORT;
}

export function setReplyTransport(db: Database, transport: ReplyTransport): void {
  setState(db, STATE_REPLY_TRANSPORT, transport);
}

export function getWorkspaceTarget(db: Database): WorkspaceTarget {
  const v = getState(db, STATE_WORKSPACE_TARGET);

  return WorkspaceTargetSchema.safeParse(v).data ?? DEFAULT_WORKSPACE_TARGET;
}

export function setWorkspaceTarget(db: Database, target: WorkspaceTarget): void {
  setState(db, STATE_WORKSPACE_TARGET, target);
}
