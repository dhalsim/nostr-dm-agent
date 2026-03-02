import type { SeenDb } from '../db';
import { getRoutstrSkKey, getWalletDefaultMintUrl } from '../db';
import type { CashuWallet } from '../wallets/cashu';
import type { WalletDb } from '../wallets/db';
import { logSpend } from '../wallets/db';

import type { AnyProvider, ProviderEnv, PrepareRunOptions, FinalizeRunOptions } from './types';

export type CreateRoutstrProviderProps = {
  baseUrl: string;
  walletDb: WalletDb;
  seenDb: SeenDb;
};

export class NoRoutstrSessionError extends Error {
  constructor() {
    super(
      'No Routstr session key. Use !provider deposit <sats> or append !!<sats> to your prompt.',
    );
  }
}

export function createRoutstrProvider(props: CreateRoutstrProviderProps): AnyProvider {
  return {
    name: 'routstr',

    async prepareRun(_opts: PrepareRunOptions): Promise<ProviderEnv> {
      const skKey = getRoutstrSkKey(props.seenDb);

      if (!skKey) {
        throw new NoRoutstrSessionError();
      }

      return {
        OPENAI_API_KEY: skKey,
        OPENAI_BASE_URL: props.baseUrl,
      };
    },

    async finalizeRun(_env: ProviderEnv, opts: FinalizeRunOptions): Promise<void> {
      const mintUrl = getWalletDefaultMintUrl(props.seenDb) ?? 'unknown';

      logSpend(
        props.walletDb,
        'routstr',
        mintUrl,
        0,
        0,
        0,
        opts.model,
        opts.sessionId,
        opts.promptPrefix,
      );
    },

    async getStatus(): Promise<string> {
      const skKey = getRoutstrSkKey(props.seenDb);

      return `routstr | session: ${skKey ? skKey.slice(0, 16) + '...' : 'none (use !provider deposit <sats>)'}`;
    },
  };
}

export async function depositOrTopup(props: {
  wallet: CashuWallet;
  seenDb: SeenDb;
  walletDb: WalletDb;
  baseUrl: string;
  amountSats: number;
}): Promise<{ skKey: string; wasNew: boolean }> {
  const { wallet, seenDb, walletDb, baseUrl, amountSats } = props;

  const token = await wallet.sendToken(amountSats);

  const existingKey = getRoutstrSkKey(seenDb);

  let skKey: string;
  let wasNew: boolean;

  try {
    if (!existingKey) {
      const res = await fetch(
        `${baseUrl}/balance/create?initial_balance_token=${encodeURIComponent(token)}`,
      );

      if (!res.ok) {
        throw new Error(`Create session failed: HTTP ${res.status}`);
      }

      const data = (await res.json()) as { api_key?: string; key?: string };
      skKey = data.api_key ?? data.key ?? '';

      if (!skKey) {
        throw new Error(`Unexpected create response: ${JSON.stringify(data)}`);
      }

      const { setRoutstrSkKey } = await import('../db');
      setRoutstrSkKey(seenDb, skKey);
      wasNew = true;
    } else {
      const res = await fetch(`${baseUrl}/balance/topup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${existingKey}`,
        },
        body: JSON.stringify({ cashu_token: token }),
      });

      if (!res.ok) {
        throw new Error(`Top-up failed: HTTP ${res.status}`);
      }

      skKey = existingKey;
      wasNew = false;
    }
  } catch (err) {
    try {
      await wallet.receiveToken(token);
    } catch {
      /* best effort */
    }

    throw err;
  }

  const mintUrl = getWalletDefaultMintUrl(seenDb) ?? 'unknown';

  logSpend(
    walletDb,
    'routstr',
    mintUrl,
    amountSats,
    0,
    amountSats,
    undefined,
    undefined,
    wasNew ? 'create-session' : 'topup',
  );

  return { skKey, wasNew };
}

export async function refundRoutstr(props: {
  wallet: CashuWallet;
  seenDb: SeenDb;
  walletDb: WalletDb;
  baseUrl: string;
}): Promise<number> {
  const { wallet, seenDb, walletDb, baseUrl } = props;
  const skKey = getRoutstrSkKey(seenDb);
  const mintUrl = getWalletDefaultMintUrl(seenDb) ?? 'unknown';

  if (!skKey) {
    throw new Error('No Routstr session to refund.');
  }

  const res = await fetch(`${baseUrl}/balance/refund`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${skKey}` },
  });

  if (res.status === 402) {
    logSpend(walletDb, 'routstr', mintUrl, 0, 0, 0, undefined, undefined, 'refund-empty');

    return 0;
  }

  if (!res.ok) {
    throw new Error(`Refund failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as { token?: string };

  if (!data.token) {
    throw new Error(`Unexpected refund response: ${JSON.stringify(data)}`);
  }

  const { receivedSats } = await wallet.receiveToken(data.token);
  logSpend(walletDb, 'routstr', mintUrl, 0, receivedSats, 0, undefined, undefined, 'refund');

  return receivedSats;
}

export async function getRoutstrBalance(seenDb: SeenDb, baseUrl: string): Promise<number> {
  const skKey = getRoutstrSkKey(seenDb);

  if (!skKey) {
    throw new Error('No Routstr session key. Use !provider deposit <sats> first.');
  }

  const res = await fetch(`${baseUrl}/balance`, {
    headers: { Authorization: `Bearer ${skKey}` },
  });

  if (!res.ok) {
    throw new Error(`Balance check failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as { balance?: number; msats?: number };
  const msats = data.msats ?? data.balance ?? 0;

  return Math.floor(Number(msats) / 1000);
}
