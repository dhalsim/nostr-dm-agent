import type { SeenDb } from '../db';
import { getWalletDefaultMintUrl, setWalletDefaultMintUrl } from '../db';
import { log } from '../logger';
import { CashuWallet } from '../wallets/cashu';
import type { WalletDb } from '../wallets/db';
import {
  bumpCounters,
  getBalanceByMint,
  getCashuMints,
  getWalletHistory,
  logWalletOperation,
} from '../wallets/db';

export type HandleWalletMintProps = {
  seenDb: SeenDb;
  defaultMintUrl: string | null;
  url: string | null;
};

export function handleWalletMint({ seenDb, defaultMintUrl, url }: HandleWalletMintProps): string {
  if (!url) {
    const current = getWalletDefaultMintUrl(seenDb, defaultMintUrl);

    return current ? `Current mint: ${current}` : 'No mint configured. Use: !wallet mint <url>';
  }

  setWalletDefaultMintUrl(seenDb, url);

  return `Mint set to: ${url}`;
}

export function handleWalletMints({ walletDb }: { walletDb: WalletDb }): string {
  const result = getCashuMints(walletDb);
  const mints = result.map((r) => `${r.mint}: ${r.total_amount} sats`);

  return `Available mints:\n${mints.join('\n')}`;
}

export type HandleWalletBalanceProps = {
  walletDb: WalletDb;
  mintUrl: string;
};

export async function handleWalletBalance({
  walletDb,
  mintUrl,
}: HandleWalletBalanceProps): Promise<string> {
  const { balanceSats } = await getBalanceByMint(walletDb, mintUrl);

  return `Wallet balance on mint ${mintUrl}: ${balanceSats} sats`;
}

export type HandleWalletReceiveProps = {
  mnemonic: string;
  walletDb: WalletDb;
  mintUrl: string;
  token: string;
};

export async function handleWalletReceive({
  mnemonic,
  walletDb,
  mintUrl,
  token,
}: HandleWalletReceiveProps): Promise<string> {
  const wallet = new CashuWallet({ mnemonic, mintUrl });
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const { actuallyReceived, fee } = await wallet.receiveToken(token);
      log.ok(`Received ${actuallyReceived} sats to mint ${mintUrl}.`);

      await getBalanceByMint(walletDb, mintUrl);

      logWalletOperation(walletDb, {
        ts: null,
        mint_url: mintUrl,
        operation: 'in',
        amount: actuallyReceived,
        fee,
        token,
      });

      return 'Token received successfully.';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      const isSignedError =
        msg.includes('outputs have already been signed') || msg.includes('already signed');

      if (isSignedError && attempt < maxRetries - 1) {
        bumpCounters(walletDb);
        continue;
      }

      return `Failed to receive: ${msg}`;
    }
  }

  return `Failed to receive after ${maxRetries} retries.`;
}

export type HandleWalletSendProps = {
  mnemonic: string;
  walletDb: WalletDb;
  amount: number;
  mintUrl: string;
};

export async function handleWalletSend({
  mnemonic,
  walletDb,
  amount,
  mintUrl,
}: HandleWalletSendProps): Promise<string> {
  const wallet = new CashuWallet({ mnemonic, mintUrl });
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const { token, fee } = await wallet.sendToken(amount);

      log.info(`Sent ${amount} sats in mint ${mintUrl}.`);

      logWalletOperation(walletDb, {
        ts: null,
        mint_url: mintUrl,
        operation: 'out',
        amount,
        fee,
        token,
      });

      return token;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      const isSignedError =
        msg.includes('outputs have already been signed') || msg.includes('already signed');

      if (isSignedError && attempt < maxRetries - 1) {
        bumpCounters(walletDb);
        continue;
      }

      return `Failed to send: ${msg}`;
    }
  }

  return `Failed to send after ${maxRetries} retries.`;
}

export type HandleWalletHistoryProps = {
  walletDb: WalletDb;
  showToken: boolean;
};

export function handleWalletHistory({ walletDb, showToken }: HandleWalletHistoryProps): string {
  const history = getWalletHistory(walletDb, 10);

  if (history.length === 0) {
    return 'No wallet history yet.';
  }

  return history
    .map((h) => {
      const date = new Date(h.ts).toISOString().slice(0, 16).replace('T', ' ');
      const shortMint = h.mint_url.replace(/^https?:\/\//, '').replace(/\/$/, '');

      let message = `${date} | ${h.operation} | ${shortMint} | ${h.amount} sats | ${h.fee} sats fee`;

      if (showToken) {
        message += `\n${h.token}`;
      }

      return message;
    })
    .join('\n');
}
