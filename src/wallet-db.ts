import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { Database } from 'bun:sqlite';

export type Proof = {
  id: string;
  amount: number;
  secret: string;
  C: string;
  mint: string;
  updatedAt: number;
};

const CASHU_WALLET_DIR = join(homedir(), '.cashu-wallet');

function ensureWalletDir(): void {
  if (!existsSync(CASHU_WALLET_DIR)) {
    mkdirSync(CASHU_WALLET_DIR, { recursive: true });
  }
}

export function getWalletDbPath(mnemonic: string): string {
  const fingerprint = mnemonic.split(' ').slice(0, 4).join('-');

  return join(CASHU_WALLET_DIR, `${fingerprint}.db`);
}

export function openWalletDb(mnemonic: string): Database {
  ensureWalletDir();
  const dbPath = getWalletDbPath(mnemonic);
  const db = new Database(dbPath);

  db.run(`
    CREATE TABLE IF NOT EXISTS proofs (
      id TEXT PRIMARY KEY,
      amount INTEGER NOT NULL,
      secret TEXT NOT NULL,
      C TEXT NOT NULL,
      mint TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS counters (
      id TEXT PRIMARY KEY,
      counter INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS spend_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      provider TEXT NOT NULL,
      budget_sats INTEGER NOT NULL,
      refund_sats INTEGER NOT NULL DEFAULT 0,
      spent_sats INTEGER NOT NULL,
      model TEXT,
      session_id TEXT,
      prompt_prefix TEXT
    )
  `);

  return db;
}

export function loadProofs(db: Database): Proof[] {
  const rows = db.prepare('SELECT id, amount, secret, C, mint, updatedAt FROM proofs').all() as {
    id: string;
    amount: number;
    secret: string;
    C: string;
    mint: string;
    updatedAt: number;
  }[];

  return rows.map((row) => ({
    id: row.id,
    amount: row.amount,
    secret: row.secret,
    C: row.C,
    mint: row.mint,
    updatedAt: row.updatedAt,
  }));
}

export function saveProofs(db: Database, proofs: Proof[]): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO proofs (id, amount, secret, C, mint, updatedAt)
    VALUES ($id, $amount, $secret, $C, $mint, $updatedAt)
  `);

  const now = Date.now();
  for (const proof of proofs) {
    stmt.run({
      $id: proof.id,
      $amount: proof.amount,
      $secret: proof.secret,
      $C: proof.C,
      $mint: proof.mint,
      $updatedAt: now,
    });
  }
}

export function deleteProofs(db: Database, proofs: Proof[]): void {
  if (proofs.length === 0) {
    return;
  }

  const stmt = db.prepare('DELETE FROM proofs WHERE id = ?');
  for (const proof of proofs) {
    stmt.run(proof.id);
  }
}

export function totalBalance(proofs: Proof[]): number {
  return proofs.reduce((sum, p) => sum + p.amount, 0);
}

export function getCounter(db: Database, id: string): number {
  const row = db.prepare('SELECT counter FROM counters WHERE id = ?').get(id) as
    | { counter: number }
    | undefined;

  return row?.counter ?? 0;
}

export function setCounter(db: Database, id: string, counter: number): void {
  db.run('INSERT OR REPLACE INTO counters (id, counter) VALUES (?, ?)', [id, counter]);
}

export function logSpend(
  db: Database,
  provider: string,
  budgetSats: number,
  refundSats: number,
  spentSats: number,
  model?: string,
  sessionId?: string,
  promptPrefix?: string,
): void {
  db.run(
    `INSERT INTO spend_log (ts, provider, budget_sats, refund_sats, spent_sats, model, session_id, prompt_prefix)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Date.now(),
      provider,
      budgetSats,
      refundSats,
      spentSats,
      model ?? null,
      sessionId ?? null,
      promptPrefix?.slice(0, 80) ?? null,
    ],
  );
}

export function getRecentSpendHistory(
  db: Database,
  limit = 10,
): {
  ts: number;
  provider: string;
  budget_sats: number;
  refund_sats: number;
  spent_sats: number;
  model: string | null;
  session_id: string | null;
}[] {
  return db
    .prepare(
      `SELECT ts, provider, budget_sats, refund_sats, spent_sats, model, session_id
       FROM spend_log
       ORDER BY ts DESC
       LIMIT $limit`,
    )
    .all({ $limit: limit }) as {
    ts: number;
    provider: string;
    budget_sats: number;
    refund_sats: number;
    spent_sats: number;
    model: string | null;
    session_id: string | null;
  }[];
}
