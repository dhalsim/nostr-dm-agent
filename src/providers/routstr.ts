import type { SeenDb } from '../db';
import { getRoutstrSkKey, getWalletDefaultMintUrl } from '../db';
import type { BotConfig } from '../env';
import type { CashuWallet } from '../wallets/cashu';

import type { ProviderDb } from './db';
import { logSpend } from './db';
import type { AnyProvider, PrepareRunOptions, FinalizeRunOptions } from './types';

export type CreateRoutstrProviderProps = {
  baseUrl: string;
  providerDb: ProviderDb;
  seenDb: SeenDb;
  config: BotConfig;
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

    async prepareRun(_opts: PrepareRunOptions): Promise<void> {
      const skKey = getRoutstrSkKey(props.seenDb);

      if (!skKey) {
        throw new NoRoutstrSessionError();
      }

      // TODO: check this once we have a proper environment
      // return {
      //   OPENAI_API_KEY: skKey,
      //   OPENAI_BASE_URL: props.baseUrl,
      // };
    },

    async finalizeRun(opts: FinalizeRunOptions): Promise<void> {
      logSpend(props.providerDb, {
        ts: null,
        provider: 'routstr',
        mint_url: opts.mintUrl,
        budget_sats: 0,
        refund_sats: 0,
        spent_sats: 0,
        fee_sats: 0,
        model: opts.model,
        session_id: opts.sessionId,
        prompt_prefix: opts.promptPrefix,
      });
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
  providerDb: ProviderDb;
  config: BotConfig;
  baseUrl: string;
  amountSats: number;
}): Promise<{ skKey: string; wasNew: boolean }> {
  const { wallet, seenDb, providerDb, baseUrl, amountSats } = props;

  // TODO: make sure we use fee later
  const { token } = await wallet.sendToken(amountSats);

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
      // TODO: make sure we log this both using log.error and use the
      await wallet.receiveToken(token);
    } catch {
      /* best effort */
    }

    throw err;
  }

  const mintUrl = getWalletDefaultMintUrl(seenDb, props.config);

  if (!mintUrl) {
    throw new Error('No mint URL configured. Use !wallet mint <url> first.');
  }

  // TODO: make sure we provide correct arguments
  logSpend(providerDb, {
    ts: null,
    provider: 'routstr',
    mint_url: mintUrl,
    budget_sats: amountSats,
    refund_sats: 0,
    spent_sats: amountSats,
    fee_sats: 0,
    model: null,
    session_id: wasNew ? 'create-session' : 'topup',
    prompt_prefix: null,
  });

  return { skKey, wasNew };
}

export async function refundRoutstr(props: {
  wallet: CashuWallet;
  seenDb: SeenDb;
  providerDb: ProviderDb;
  baseUrl: string;
  config: BotConfig;
}): Promise<number> {
  const { wallet, seenDb, providerDb, baseUrl } = props;
  const skKey = getRoutstrSkKey(seenDb);
  const mintUrl = getWalletDefaultMintUrl(seenDb, props.config);

  if (!mintUrl) {
    throw new Error('No mint URL configured. Use !wallet mint <url> first.');
  }

  if (!skKey) {
    throw new Error('No Routstr session to refund.');
  }

  const res = await fetch(`${baseUrl}/balance/refund`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${skKey}` },
  });

  if (res.status === 402) {
    // TODO: make sure we provider correct arguments
    logSpend(providerDb, {
      ts: null,
      provider: 'routstr',
      mint_url: mintUrl,
      budget_sats: 0,
      refund_sats: 0,
      spent_sats: 0,
      fee_sats: 0,
      model: null,
      session_id: 'refund-empty',
      prompt_prefix: null,
    });

    return 0;
  }

  if (!res.ok) {
    throw new Error(`Refund failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as { token?: string };

  if (!data.token) {
    throw new Error(`Unexpected refund response: ${JSON.stringify(data)}`);
  }

  const { actuallyReceived, fee } = await wallet.receiveToken(data.token);

  // TODO: make sure we provider correct arguments
  logSpend(providerDb, {
    ts: null,
    provider: 'routstr',
    mint_url: mintUrl,
    budget_sats: 0,
    refund_sats: actuallyReceived,
    spent_sats: 0,
    fee_sats: fee,
    model: null,
    session_id: 'refund',
    prompt_prefix: null,
  });

  return actuallyReceived;
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
