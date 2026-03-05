import type { Database } from 'bun:sqlite';

import type { SeenDb } from '../db';
import type { Brand } from '../types';

export type ProviderDb = Brand<Database, 'ProviderDb'>;

export function asProviderDb(db: SeenDb): ProviderDb {
  return db as unknown as ProviderDb;
}

export type SpendLogType = 'run' | 'topup' | 'refund';

export type SpendHistoryRow = {
  ts: number | null;
  provider: string;
  mint_url: string;
  budget_msats: number;
  refund_msats: number;
  spent_msats: number;
  fee_msats: number;
  model: string | null;
  session_id: string | null;
  prompt_prefix: string | null;
  type: SpendLogType;
};

export function logSpend(db: ProviderDb, props: SpendHistoryRow): void {
  const {
    ts,
    provider,
    mint_url,
    budget_msats,
    refund_msats,
    spent_msats,
    fee_msats,
    model,
    session_id,
    prompt_prefix,
    type,
  } = props;

  db.run(
    `INSERT INTO spend_log (ts, provider, mint_url, budget_msats, refund_msats, spent_msats, fee_msats, model, session_id, prompt_prefix, type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ts ?? Date.now(),
      provider,
      mint_url,
      budget_msats,
      refund_msats,
      spent_msats,
      fee_msats,
      model,
      session_id,
      prompt_prefix?.slice(0, 80) ?? null,
      type,
    ],
  );
}

export function getRecentSpendHistory(db: ProviderDb, limit = 10): SpendHistoryRow[] {
  return db
    .prepare(
      `SELECT ts, provider, mint_url, budget_msats, refund_msats, spent_msats, fee_msats,
              model, session_id, prompt_prefix, type
       FROM spend_log ORDER BY ts DESC LIMIT ?`,
    )
    .all(limit) as SpendHistoryRow[];
}
