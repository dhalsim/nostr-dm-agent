// ---------------------------------------------------------------------------
// db.ts — SQLite persistence: seen events, state, sessions schema
// ---------------------------------------------------------------------------
import { Database } from 'bun:sqlite';
import { z } from 'zod';

import { assertUnreachable } from './logger';
import { SEEN_DB_PATH, RESTART_REQUESTED_PATH } from './paths';

export { SEEN_DB_PATH, RESTART_REQUESTED_PATH };

export const AgentModeSchema = z.enum(['free', 'ask', 'plan', 'agent']);
export type AgentMode = z.infer<typeof AgentModeSchema>;

export const AgentBackendNameSchema = z.enum(['cursor', 'opencode']);
export type AgentBackendName = z.infer<typeof AgentBackendNameSchema>;

export const ProviderNameSchema = z.enum(['local', 'routstr']);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

export const ReplyTransportSchema = z.enum(['remote', 'local']);
export type ReplyTransport = z.infer<typeof ReplyTransportSchema>;

export const WorkspaceTargetSchema = z.enum(['parent', 'bot']);
export type WorkspaceTarget = z.infer<typeof WorkspaceTargetSchema>;

export const STATE_CURRENT_SESSION = 'current_session_id';
export const STATE_DEFAULT_MODE = 'default_mode';
export const STATE_AGENT_BACKEND = 'agent_backend';
export const STATE_REPLY_TRANSPORT = 'reply_transport';
export const STATE_WORKSPACE_TARGET = 'workspace_target';
export const STATE_MODEL_OVERRIDE = 'model_override';
export const STATE_PROVIDER_NAME = 'provider_name';
export const STATE_ROUTSTR_BUDGET_SATS = 'routstr_budget_sats';
export const STATE_ROUTSTR_SK_KEY = 'routstr_sk_key';
export const STATE_ROUTSTR_MODEL = 'routstr_model';
export const STATE_ROUTSTR_MODELS_CACHE = 'routstr_models_cache';
export const STATE_ROUTSTR_MODELS_CACHE_TS = 'routstr_models_cache_ts';
export const STATE_CASHU_DEFAULT_MINT_URL = 'cashu_default_mint_url';

export const DEFAULT_MODE: AgentMode = 'ask';
export const DEFAULT_BACKEND: AgentBackendName = 'cursor';
export const DEFAULT_REPLY_TRANSPORT: ReplyTransport = 'remote';
export const DEFAULT_WORKSPACE_TARGET: WorkspaceTarget = 'parent';
export const DEFAULT_PROVIDER: ProviderName = 'local';
export const DEFAULT_ROUTSTR_BUDGET_SATS = 2000;

type Brand<T, B> = T & { readonly __brand: B };

export type SeenDb = Brand<Database, 'SeenDb'>;

export function openSeenDb(): SeenDb {
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

  db.run(`
    CREATE TABLE IF NOT EXISTS spend_log (
      id            INTEGER PRIMARY KEY,
      ts            INTEGER NOT NULL, -- unix milliseconds
      provider      TEXT NOT NULL,
      mint_url      TEXT NOT NULL,
      budget_sats   INTEGER NOT NULL,
      refund_sats   INTEGER NOT NULL DEFAULT 0,
      spent_sats    INTEGER NOT NULL,
      fee_sats      INTEGER NOT NULL DEFAULT 0,
      model         TEXT,
      session_id    TEXT,
      prompt_prefix TEXT -- first 80 chars
    )
  `);

  return db as SeenDb;
}

export function alreadyHaveEvent(db: SeenDb): (id: string) => boolean {
  const stmt = db.prepare('SELECT 1 FROM seen_events WHERE id = ?');

  return (id: string) => stmt.get(id) !== null;
}

export function markSeen(db: SeenDb, id: string): void {
  db.run('INSERT OR IGNORE INTO seen_events (id) VALUES (?)', [id]);
}

export function getState(db: SeenDb, key: string): string | null {
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;

  return row?.value ?? null;
}

export function setState(db: SeenDb, key: string, value: string): void {
  db.run('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)', [key, value]);
}

export function getDefaultMode(db: SeenDb): AgentMode {
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

export function setDefaultMode(db: SeenDb, mode: AgentMode): void {
  setState(db, STATE_DEFAULT_MODE, mode);
}

export function getAgentBackend(db: SeenDb): AgentBackendName {
  const v = getState(db, STATE_AGENT_BACKEND);

  return AgentBackendNameSchema.safeParse(v).data ?? DEFAULT_BACKEND;
}

export function setAgentBackend(db: SeenDb, backend: AgentBackendName): void {
  setState(db, STATE_AGENT_BACKEND, backend);
}

export function getReplyTransport(db: SeenDb): ReplyTransport {
  const v = getState(db, STATE_REPLY_TRANSPORT);

  return ReplyTransportSchema.safeParse(v).data ?? DEFAULT_REPLY_TRANSPORT;
}

export function setReplyTransport(db: SeenDb, transport: ReplyTransport): void {
  setState(db, STATE_REPLY_TRANSPORT, transport);
}

export function getWorkspaceTarget(db: SeenDb): WorkspaceTarget {
  const v = getState(db, STATE_WORKSPACE_TARGET);

  return WorkspaceTargetSchema.safeParse(v).data ?? DEFAULT_WORKSPACE_TARGET;
}

export function setWorkspaceTarget(db: SeenDb, target: WorkspaceTarget): void {
  setState(db, STATE_WORKSPACE_TARGET, target);
}

export function getModelOverride(db: SeenDb): string | null {
  return getState(db, STATE_MODEL_OVERRIDE);
}

export function setModelOverride(db: SeenDb, model: string | null): void {
  if (model === null) {
    db.run('DELETE FROM state WHERE key = ?', [STATE_MODEL_OVERRIDE]);
  } else {
    setState(db, STATE_MODEL_OVERRIDE, model);
  }
}

export function getProviderName(db: SeenDb): ProviderName {
  const v = getState(db, STATE_PROVIDER_NAME);

  return ProviderNameSchema.safeParse(v).data ?? DEFAULT_PROVIDER;
}

export function setProviderName(db: SeenDb, name: ProviderName): void {
  setState(db, STATE_PROVIDER_NAME, name);
}

export function getRoutstrBudget(db: SeenDb): number {
  const v = getState(db, STATE_ROUTSTR_BUDGET_SATS);
  const parsed = z.coerce.number().safeParse(v);

  if (!parsed.success) {
    return DEFAULT_ROUTSTR_BUDGET_SATS;
  }

  return parsed.data;
}

export function setRoutstrBudget(db: SeenDb, budgetSats: number): void {
  setState(db, STATE_ROUTSTR_BUDGET_SATS, String(budgetSats));
}

export function getRoutstrSkKey(db: SeenDb): string | null {
  return getState(db, STATE_ROUTSTR_SK_KEY);
}

export function setRoutstrSkKey(db: SeenDb, key: string): void {
  setState(db, STATE_ROUTSTR_SK_KEY, key);
}

export function getWalletDefaultMintUrl(db: SeenDb, defaultMintUrl: string | null): string | null {
  return getState(db, STATE_CASHU_DEFAULT_MINT_URL) ?? defaultMintUrl;
}

export function setWalletDefaultMintUrl(db: SeenDb, url: string): void {
  setState(db, STATE_CASHU_DEFAULT_MINT_URL, url);
}

export function getRoutstrModel(db: SeenDb): string | null {
  return getState(db, STATE_ROUTSTR_MODEL);
}

export function setRoutstrModel(db: SeenDb, model: string | null): void {
  if (model === null) {
    db.run('DELETE FROM state WHERE key = ?', [STATE_ROUTSTR_MODEL]);
  } else {
    setState(db, STATE_ROUTSTR_MODEL, model);
  }
}

export type RoutstrModelCache = {
  id: string;
  name?: string;
  context_length?: number;
}[];

export function getCachedRoutstrModels(db: SeenDb): {
  models: RoutstrModelCache;
  ts: number;
} | null {
  const ts = Number(getState(db, STATE_ROUTSTR_MODELS_CACHE_TS) ?? '0');

  if (Date.now() - ts > 86_400_000) {
    return null;
  }

  const raw = getState(db, STATE_ROUTSTR_MODELS_CACHE);
  const models = raw ? (JSON.parse(raw) as RoutstrModelCache) : null;

  return models ? { models, ts } : null;
}

export function setCachedRoutstrModels(db: SeenDb, models: RoutstrModelCache): void {
  setState(db, STATE_ROUTSTR_MODELS_CACHE, JSON.stringify(models));
  setState(db, STATE_ROUTSTR_MODELS_CACHE_TS, String(Date.now()));
}
