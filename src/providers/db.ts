import type { Database } from 'bun:sqlite';

import type { SeenDb } from '../db';

type Brand<T, B> = T & { readonly __brand: B };
export type ProviderDb = Brand<Database, 'ProviderDb'>;

export function asProviderDb(db: SeenDb): ProviderDb {
  return db as unknown as ProviderDb;
}

export type SpendHistoryRow = {
  ts: number | null;
  provider: string;
  mint_url: string;
  budget_sats: number;
  refund_sats: number;
  spent_sats: number;
  fee_sats: number;
  model: string | null;
  session_id: string | null;
  prompt_prefix: string | null;
};

export function logSpend(db: ProviderDb, props: SpendHistoryRow): void {
  const {
    ts,
    provider,
    mint_url,
    budget_sats,
    refund_sats,
    spent_sats,
    fee_sats,
    model,
    session_id,
    prompt_prefix,
  } = props;

  db.run(
    `INSERT INTO spend_log (ts, provider, mint_url, budget_sats, refund_sats, spent_sats, fee_sats, model, session_id, prompt_prefix)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ts ?? Date.now(),
      provider,
      mint_url,
      budget_sats,
      refund_sats,
      spent_sats,
      fee_sats,
      model,
      session_id,
      prompt_prefix?.slice(0, 80) ?? null,
    ],
  );
}

export function getRecentSpendHistory(db: ProviderDb, limit = 10): SpendHistoryRow[] {
  return db
    .prepare(
      `SELECT ts, provider, mint_url, budget_sats, refund_sats, spent_sats, fee_sats, 
              model, session_id, prompt_prefix
       FROM spend_log ORDER BY ts DESC LIMIT ?`,
    )
    .all(limit) as SpendHistoryRow[];
}
