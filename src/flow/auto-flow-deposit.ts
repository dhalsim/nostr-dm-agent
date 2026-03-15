// ---------------------------------------------------------------------------
// src/flow/auto-flow-deposit.ts — Prepare auto-flow deposit for Routstr
// ---------------------------------------------------------------------------

import { getWalletDefaultMintUrl } from '../db';
import type { CoreDb } from '../db';
import { log } from '../logger';
import type { ProviderDb } from '../providers/db';
import { depositOrTopup } from '../providers/routstr';
import type { WalletDb } from '../wallets/db';
import { InsufficientFundsError } from '../wallets/types';

export type PrepareAutoFlowDepositProps = {
  seenDb: CoreDb;
  cashuDefaultMintUrl: string | null;
  cashuMnemonic: string | null;
  walletDb: WalletDb | null;
  providerDb: ProviderDb | null;
  amountSats: number;
};

export async function prepareAutoFlowDeposit({
  seenDb,
  cashuDefaultMintUrl,
  cashuMnemonic,
  walletDb,
  providerDb,
  amountSats,
}: PrepareAutoFlowDepositProps): Promise<string | null> {
  if (!walletDb) {
    return 'Wallet not available. Run `bun run wallet:setup` to configure your wallet.';
  }

  const mintUrl = getWalletDefaultMintUrl(seenDb, cashuDefaultMintUrl);

  if (!mintUrl) {
    return 'No mint configured. Use !wallet mint <url> first.';
  }

  if (!cashuMnemonic) {
    return 'No mnemonic configured. Set one with: !wallet setup';
  }

  if (!providerDb) {
    return 'Provider DB not available.';
  }

  try {
    const { wasNew } = await depositOrTopup({
      mnemonic: cashuMnemonic,
      seenDb,
      walletDb,
      providerDb,
      mintUrl,
      amountSats,
      forceNew: false,
    });

    log.warn(`Auto-flow: ${wasNew ? 'created session' : 'topped up'} with ${amountSats} sats`);

    return null;
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      return `Insufficient local balance: ${err.available} sats available, ${err.required} needed.\nTop up with: !wallet receive <token>`;
    }

    return `Deposit failed: ${String(err)}`;
  }
}
