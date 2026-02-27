import { getDecodedToken, getEncodedToken } from '@cashu/cashu-ts';
import type { Database } from 'bun:sqlite';

import {
  loadProofs,
  saveProofs,
  deleteProofs,
  totalBalance,
  openWalletDb,
  type Proof,
} from '../wallet-db';

import type { AnyWallet } from './types';
import { InsufficientFundsError, type WalletInfo } from './types';

export type CreateCashuWalletProps = {
  mnemonic: string;
  mintUrl: string;
};

async function getKeyset(mintUrl: string): Promise<string> {
  const res = await fetch(`${mintUrl}/keys`);

  if (!res.ok) {
    throw new Error(`Failed to fetch mint keys: ${res.status}`);
  }

  const data = await res.json();

  return data.keysets?.[0] ?? data.id ?? 'primary';
}

async function _requestMint(
  mintUrl: string,
  amount: number,
): Promise<{ pr: string; hash: string }> {
  const res = await fetch(`${mintUrl}/mint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount }),
  });

  if (!res.ok) {
    throw new Error(`Mint request failed: ${res.status}`);
  }

  return res.json();
}

async function _mintQuote(
  mintUrl: string,
  amount: number,
): Promise<{ request: string; quote: string }> {
  const res = await fetch(`${mintUrl}/mint/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, unit: 'sat' }),
  });

  if (!res.ok) {
    throw new Error(`Mint quote failed: ${res.status}`);
  }

  return res.json();
}

async function _meltTokens(
  mintUrl: string,
  proofs: Proof[],
): Promise<{ pr: string; signature: string | null }> {
  const res = await fetch(`${mintUrl}/melt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proofs }),
  });

  if (!res.ok) {
    throw new Error(`Melt failed: ${res.status}`);
  }

  return res.json();
}

async function splitProofs(
  mintUrl: string,
  proofs: Proof[],
  amount: number,
): Promise<{ keep: Proof[]; send: Proof[] }> {
  const res = await fetch(`${mintUrl}/split`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proofs, amount }),
  });

  if (!res.ok) {
    throw new Error(`Split failed: ${res.status}`);
  }

  const data = await res.json();

  const keep = (data.keep ?? []).map(
    (p: { id: string; amount: number; secret: string; C: string }) => ({
      id: p.id,
      amount: p.amount,
      secret: p.secret,
      C: p.C,
      mint: mintUrl,
      updatedAt: Date.now(),
    }),
  );

  const send = (data.send ?? []).map(
    (p: { id: string; amount: number; secret: string; C: string }) => ({
      id: p.id,
      amount: p.amount,
      secret: p.secret,
      C: p.C,
      mint: mintUrl,
      updatedAt: Date.now(),
    }),
  );

  return { keep, send };
}

export function createCashuWallet({ mnemonic, mintUrl }: CreateCashuWalletProps): AnyWallet {
  let db: Database | null = null;

  const getDb = (): Database => {
    if (!db) {
      db = openWalletDb(mnemonic);
    }

    return db;
  };

  return {
    name: 'cashu',

    async getInfo(): Promise<WalletInfo> {
      const proofs = loadProofs(getDb());

      return { balanceSats: totalBalance(proofs) };
    },

    async sendToken(amountSats: number): Promise<string> {
      const proofs = loadProofs(getDb());
      const balance = totalBalance(proofs);

      if (balance < amountSats) {
        throw new InsufficientFundsError(balance, amountSats);
      }

      await getKeyset(mintUrl);
      const sortedProofs = [...proofs].sort((a, b) => a.amount - b.amount);
      const selected: Proof[] = [];
      let selectedTotal = 0;

      for (const proof of sortedProofs) {
        if (selectedTotal >= amountSats) {
          break;
        }

        selected.push(proof);
        selectedTotal += proof.amount;
      }

      const overspend = selectedTotal - amountSats;
      let keep: Proof[] = [];
      let send: Proof[] = selected;

      if (overspend > 0) {
        const splitResult = await splitProofs(mintUrl, selected, amountSats);
        keep = splitResult.keep;
        send = splitResult.send;
      }

      deleteProofs(getDb(), proofs);

      if (keep.length > 0) {
        saveProofs(getDb(), keep);
      }

      const encoded = getEncodedToken({
        token: [
          {
            mint: mintUrl,
            proofs: send.map((p) => ({
              id: p.id,
              amount: p.amount,
              secret: p.secret,
              C: p.C,
            })),
          },
        ],
      } as unknown as Parameters<typeof getEncodedToken>[0]);

      return encoded;
    },

    async receiveToken(encodedToken: string): Promise<{ receivedSats: number }> {
      const decoded = getDecodedToken(encodedToken);

      const tokenData = (
        decoded as unknown as {
          token?: Array<{
            mint?: string;
            proofs?: Array<{ id: string; amount: number; secret: string; C: string }>;
          }>;
        }
      ).token;

      if (!tokenData || tokenData.length === 0) {
        throw new Error('Invalid token: no token data');
      }

      const newProofs: Proof[] = [];

      for (const token of tokenData) {
        const mint = token.mint ?? mintUrl;

        const proofsToSend =
          token.proofs?.map((p) => ({
            id: p.id,
            amount: p.amount,
            secret: p.secret,
            C: p.C,
            mint,
            updatedAt: Date.now(),
          })) ?? [];

        const res = await fetch(`${mintUrl}/check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ proofs: proofsToSend }),
        });

        if (!res.ok) {
          continue;
        }

        const data = await res.json();
        const validProofs = (data.valid ?? []).filter((p: { valid: boolean }) => p.valid);

        for (const p of validProofs) {
          newProofs.push({
            id: p.id,
            amount: p.amount,
            secret: p.secret,
            C: p.C,
            mint,
            updatedAt: Date.now(),
          });
        }
      }

      if (newProofs.length > 0) {
        const existingProofs = loadProofs(getDb());
        saveProofs(getDb(), [...existingProofs, ...newProofs]);
      }

      return { receivedSats: totalBalance(newProofs) };
    },
  };
}
