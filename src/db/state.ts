import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44';
import { hexToBytes } from 'nostr-tools/utils';
import { z } from 'zod';

import { log } from '../logger';
import { msats, msatsRaw } from '../types';
import { assertUnreachable } from '../utils';

import {
  AgentBackendNameSchema,
  AgentModeSchema,
  DEFAULT_BACKEND,
  DEFAULT_LINTING,
  DEFAULT_MODE,
  DEFAULT_PROVIDER,
  DEFAULT_REPLY_TRANSPORT,
  DEFAULT_WORKSPACE_TARGET,
  LintingSchema,
  ProviderNameSchema,
  ReplyTransportSchema,
  STATE_AGENT_BACKEND,
  STATE_CASHU_DEFAULT_MINT_URL,
  STATE_DEFAULT_MODE,
  STATE_LINTING,
  STATE_MODEL_OVERRIDE,
  STATE_PROVIDER_NAME,
  STATE_REPLY_TRANSPORT,
  STATE_ROUTSTR_BUDGET_MSATS,
  STATE_ROUTSTR_MODEL,
  STATE_ROUTSTR_MODELS_CACHE,
  STATE_ROUTSTR_MODELS_CACHE_TS,
  STATE_ROUTSTR_SK_KEY,
  STATE_WORKSPACE_TARGET,
  type AgentBackendName,
  type AgentMode,
  type CoreDb,
  type Linting,
  type Msats,
  type ProviderName,
  type ReplyTransport,
  type RoutstrModelCache,
  type WorkspaceTarget,
  WorkspaceTargetSchema,
} from './shared';

let skKeyConversationKey: Uint8Array | null = null;

export function initSkKeyEncryption(
  botKeyHex: string,
  botPubkey: string,
): void {
  skKeyConversationKey = getConversationKey(hexToBytes(botKeyHex), botPubkey);
}

export function getState(db: CoreDb, key: string): string | null {
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;

  return row?.value ?? null;
}

export function setState(db: CoreDb, key: string, value: string): void {
  db.run('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)', [
    key,
    value,
  ]);
}

export function getCurrentOrDefaultMode(db: CoreDb): AgentMode {
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

export function setDefaultMode(db: CoreDb, mode: AgentMode): void {
  setState(db, STATE_DEFAULT_MODE, mode);
}

export function getAgentBackend(db: CoreDb): AgentBackendName {
  const v = getState(db, STATE_AGENT_BACKEND);

  return AgentBackendNameSchema.safeParse(v).data ?? DEFAULT_BACKEND;
}

export function setAgentBackend(db: CoreDb, backend: AgentBackendName): void {
  setState(db, STATE_AGENT_BACKEND, backend);
}

export function getReplyTransport(db: CoreDb): ReplyTransport {
  const v = getState(db, STATE_REPLY_TRANSPORT);

  return ReplyTransportSchema.safeParse(v).data ?? DEFAULT_REPLY_TRANSPORT;
}

export function setReplyTransport(db: CoreDb, transport: ReplyTransport): void {
  setState(db, STATE_REPLY_TRANSPORT, transport);
}

export function getWorkspaceTarget(db: CoreDb): WorkspaceTarget {
  const v = getState(db, STATE_WORKSPACE_TARGET);

  return WorkspaceTargetSchema.safeParse(v).data ?? DEFAULT_WORKSPACE_TARGET;
}

export function setWorkspaceTarget(db: CoreDb, target: WorkspaceTarget): void {
  setState(db, STATE_WORKSPACE_TARGET, target);
}

export function getModelOverride(
  db: CoreDb,
  backendName: AgentBackendName,
): string | null {
  const key = `${STATE_MODEL_OVERRIDE}:${backendName}`;

  return getState(db, key);
}

export function setModelOverride(
  db: CoreDb,
  backendName: AgentBackendName,
  model: string | null,
): void {
  const key = `${STATE_MODEL_OVERRIDE}:${backendName}`;

  if (model === null) {
    db.run('DELETE FROM state WHERE key = ?', [key]);
  } else {
    setState(db, key, model);
  }
}

export function getProviderName(db: CoreDb): ProviderName {
  const v = getState(db, STATE_PROVIDER_NAME);

  return ProviderNameSchema.safeParse(v).data ?? DEFAULT_PROVIDER;
}

export function setProviderName(db: CoreDb, name: ProviderName): void {
  setState(db, STATE_PROVIDER_NAME, name);
}

export function getRoutstrBudget(seenDb: CoreDb): Msats {
  const v = getState(seenDb, STATE_ROUTSTR_BUDGET_MSATS);

  if (v === null) {
    return msats(0);
  }

  const parsed = z.coerce.number().safeParse(v);

  if (!parsed.success) {
    throw new Error(`Corrupt routstr budget in DB: "${v}"`);
  }

  return msats(parsed.data);
}

export function setRoutstrBudget(db: CoreDb, budgetMSats: Msats): void {
  setState(db, STATE_ROUTSTR_BUDGET_MSATS, String(msatsRaw(budgetMSats)));
}

export function getRoutstrSkKey(db: CoreDb): string | null {
  const stored = getState(db, STATE_ROUTSTR_SK_KEY);

  if (!stored) {
    return null;
  }

  if (!skKeyConversationKey) {
    log.warn('SK key encryption not initialized — returning raw value');

    return stored;
  }

  try {
    return decrypt(stored, skKeyConversationKey);
  } catch {
    return stored;
  }
}

export function setRoutstrSkKey(db: CoreDb, key: string): void {
  if (!skKeyConversationKey) {
    log.warn('SK key encryption not initialized — storing raw value');
    setState(db, STATE_ROUTSTR_SK_KEY, key);

    return;
  }

  setState(db, STATE_ROUTSTR_SK_KEY, encrypt(key, skKeyConversationKey));
}

export function getWalletDefaultMintUrl(
  db: CoreDb,
  defaultMintUrl: string | null,
): string | null {
  return getState(db, STATE_CASHU_DEFAULT_MINT_URL) ?? defaultMintUrl;
}

export function setWalletDefaultMintUrl(db: CoreDb, url: string): void {
  setState(db, STATE_CASHU_DEFAULT_MINT_URL, url);
}

export function getRoutstrModel(db: CoreDb): string | null {
  return getState(db, STATE_ROUTSTR_MODEL);
}

export function setRoutstrModel(db: CoreDb, model: string | null): void {
  if (model === null) {
    db.run('DELETE FROM state WHERE key = ?', [STATE_ROUTSTR_MODEL]);
  } else {
    setState(db, STATE_ROUTSTR_MODEL, model);
  }
}

export function getCachedRoutstrModels(db: CoreDb): {
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

export function setCachedRoutstrModels(
  db: CoreDb,
  models: RoutstrModelCache,
): void {
  setState(db, STATE_ROUTSTR_MODELS_CACHE, JSON.stringify(models));
  setState(db, STATE_ROUTSTR_MODELS_CACHE_TS, String(Date.now()));
}

export function getLinting(db: CoreDb): Linting {
  const v = getState(db, STATE_LINTING);

  return LintingSchema.safeParse(v).data ?? DEFAULT_LINTING;
}

export function setLinting(db: CoreDb, value: Linting): void {
  setState(db, STATE_LINTING, value);
}
