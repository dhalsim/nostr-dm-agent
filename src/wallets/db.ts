import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type { OperationCounters, Proof } from '@cashu/cashu-ts';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { Database } from 'bun:sqlite';

type Brand<T, B> = T & { readonly __brand: B };

export type WalletDb = Brand<Database, 'WalletDb'>;

import { log } from '../logger';

const CASHU_WALLET_DIR = join(homedir(), '.cashu-wallet');

function ensureWalletDir(): void {
  if (!existsSync(CASHU_WALLET_DIR)) {
    mkdirSync(CASHU_WALLET_DIR, { recursive: true });
  }
}

export function getWalletDbPath(mnemonic: string): string {
  const entropy = bip39.mnemonicToEntropy(mnemonic, wordlist);
  const fingerprint = bytesToHex(entropy).slice(0, 8);

  return join(CASHU_WALLET_DIR, `wallet-${fingerprint}.db`);
}

export function openWalletDb(mnemonic: string): WalletDb {
  ensureWalletDir();
  const dbPath = getWalletDbPath(mnemonic);
  const db = new Database(dbPath);

  db.run(`
    CREATE TABLE IF NOT EXISTS proofs (
      secret TEXT PRIMARY KEY,
      keyset_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      C TEXT NOT NULL,
      mint TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_proofs_keyset_id ON proofs (keyset_id)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS counters (
      keyset_id TEXT PRIMARY KEY,
      next INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS spend_log (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL, -- unix timestamp
      provider TEXT NOT NULL,
      mint_url TEXT NOT NULL,
      budget_sats INTEGER NOT NULL,
      refund_sats INTEGER NOT NULL DEFAULT 0,
      spent_sats INTEGER NOT NULL,
      model TEXT,
      session_id TEXT,
      prompt_prefix TEXT -- first 80 chars of prompt
    )
  `);

  return db as WalletDb;
}

export type CashuMintResult = {
  mint: string;
  total_amount: number;
};

export function getCashuMints(db: WalletDb): CashuMintResult[] {
  return db
    .prepare('SELECT SUM(amount) as total_amount, mint FROM proofs GROUP BY mint')
    .all() as CashuMintResult[];
}

export function loadProofs(db: WalletDb, mintUrl: string): Proof[] {
  const rows = db
    .prepare('SELECT keyset_id, amount, secret, C, mint, updatedAt FROM proofs WHERE mint = ?')
    .all(mintUrl) as {
    keyset_id: string;
    amount: number;
    secret: string;
    C: string;
    mint: string;
    updatedAt: number;
  }[];

  return rows.map((row) => ({
    id: row.keyset_id,
    amount: row.amount,
    secret: row.secret,
    C: row.C,
    mint: row.mint,
    updatedAt: row.updatedAt,
  }));
}

export function saveProofs(db: WalletDb, mintUrl: string, proofs: Proof[]): void {
  const now = Date.now();

  const insert = db.prepare(`
    INSERT OR REPLACE INTO proofs (secret, keyset_id, amount, C, mint, updatedAt) 
    VALUES ($secret, $keyset_id, $amount, $C, $mint, $updatedAt)
  `);

  const insertMany = db.transaction((ps: Proof[]) => {
    for (const p of ps) {
      insert.run({
        $secret: p.secret,
        $keyset_id: p.id,
        $amount: p.amount,
        $C: p.C,
        $mint: mintUrl,
        $updatedAt: now,
      });
    }
  });

  insertMany(proofs);

  log.ok(`Saved ${proofs.length} proof(s) to DB for mint ${mintUrl}`);
}

export function deleteProofs(db: WalletDb, proofs: Proof[]): void {
  if (proofs.length === 0) {
    return;
  }

  const stmt = db.prepare('DELETE FROM proofs WHERE keyset_id = ?');
  for (const proof of proofs) {
    stmt.run(proof.id); // keyset_id
  }
}

export function totalBalance(proofs: Proof[]): number {
  return proofs.reduce((sum, p) => sum + p.amount, 0);
}

export function loadCounters(db: WalletDb): Record<string, number> {
  const rows = db.query('SELECT keyset_id, next FROM counters').all() as {
    keyset_id: string;
    next: number;
  }[];

  const counters: Record<string, number> = {};
  for (const row of rows) {
    counters[row.keyset_id] = row.next;
  }

  log.info(`Loaded counters: ${JSON.stringify(counters)}`);

  return counters;
}

export function persistCounter(db: WalletDb, op: OperationCounters): void {
  // OperationCounters = { keysetId: string, start: number, count: number, next: number }
  // `next` is the value to use for the NEXT operation — always persist this.
  log.info(
    `  countersReserved: keyset=${op.keysetId} start=${op.start} count=${op.count} next=${op.next}`,
  );

  db.run('INSERT OR REPLACE INTO counters (keyset_id, next) VALUES (?, ?)', [op.keysetId, op.next]);

  log.ok(`  Counter for ${op.keysetId} persisted → next=${op.next}`);
}

export function logSpend(
  db: WalletDb,
  provider: string,
  mintUrl: string,
  budgetSats: number,
  refundSats: number,
  spentSats: number,
  model?: string,
  sessionId?: string,
  promptPrefix?: string,
): void {
  db.run(
    `INSERT INTO spend_log (ts, provider, mint_url, budget_sats, refund_sats, spent_sats, model, session_id, prompt_prefix)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Date.now(),
      provider,
      mintUrl,
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
  db: WalletDb,
  limit = 10,
): {
  ts: number;
  provider: string;
  mint_url: string;
  budget_sats: number;
  refund_sats: number;
  spent_sats: number;
  model: string | null;
  session_id: string | null;
}[] {
  return db
    .prepare(
      `SELECT ts, provider, mint_url, budget_sats, refund_sats, spent_sats, model, session_id
       FROM spend_log
       ORDER BY ts DESC
       LIMIT $limit`,
    )
    .all({ $limit: limit }) as {
    ts: number;
    provider: string;
    mint_url: string;
    budget_sats: number;
    refund_sats: number;
    spent_sats: number;
    model: string | null;
    session_id: string | null;
  }[];
}
