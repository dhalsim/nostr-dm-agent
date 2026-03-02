import * as z from 'zod';

import type { SeenDb } from '../db';
import { getRoutstrSkKey, setRoutstrBudget, setRoutstrSkKey } from '../db';
import type { BotConfig } from '../env';
import { debug, log } from '../logger';
import { CashuWallet } from '../wallets/cashu';
import type { WalletDb } from '../wallets/db';
import { logWalletOperation } from '../wallets/db';

import type { ProviderDb } from './db';
import { logSpend } from './db';
import type { AnyProvider, PrepareRunOptions, FinalizeRunOptions } from './types';

const ROUTSTR_BASE_URL = 'https://api.routstr.com/v1';

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

const TopupResponseSchema = z.object({
  old_balance: z.number(),
  added_amount: z.number(),
  new_balance: z.number(),
  transaction_id: z.string(),
});

type DepositOrTopupProps = {
  mnemonic: string;
  seenDb: SeenDb;
  walletDb: WalletDb;
  providerDb: ProviderDb;
  mintUrl: string;
  amountSats: number;
};

export async function depositOrTopup(
  props: DepositOrTopupProps,
): Promise<{ skKey: string | null; wasNew: boolean }> {
  const { mnemonic, seenDb, walletDb, providerDb, mintUrl, amountSats } = props;

  const wallet = new CashuWallet({ mnemonic, mintUrl });

  const { token, fee } = await wallet.sendToken(amountSats);

  logWalletOperation(walletDb, {
    ts: null,
    mint_url: mintUrl,
    operation: 'out',
    amount: amountSats,
    fee,
    token,
  });

  const existingKey = getRoutstrSkKey(seenDb);

  let skKey = existingKey;

  try {
    if (!existingKey) {
      const res = await fetch(
        `${ROUTSTR_BASE_URL}/balance/create?initial_balance_token=${encodeURIComponent(token)}`,
      );

      if (!res.ok) {
        throw new Error(`Create session failed: HTTP ${res.status}`);
      }

      const json = await res.json();

      const balanceCreateResponseSchema = z.object({
        api_key: z.string(),
        balance_sats: z.number(), // msats
      });

      const parsed = balanceCreateResponseSchema.safeParse(json);

      if (!parsed.success) {
        debug(`Unexpected create response: ${JSON.stringify(json)}`);

        throw new Error(`Unexpected create response: ${parsed.error}`);
      }

      skKey = parsed.data.api_key;
      const balanceMSats = parsed.data.balance_sats;

      setRoutstrSkKey(seenDb, skKey);
      setRoutstrBudget(seenDb, balanceMSats);
    } else {
      const res = await fetch(`${ROUTSTR_BASE_URL}/balance/topup`, {
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

      const json = await res.json();

      const parsed = TopupResponseSchema.safeParse(json);

      if (!parsed.success) {
        throw new Error(`routstr topup response was not expected: ${parsed.error}`);
      }

      log.info(
        `${parsed.data.added_amount} sats added to routstr balance. New balance is ${parsed.data.new_balance}`,
      );

      const balanceMSats = parsed.data.new_balance;
      setRoutstrBudget(seenDb, balanceMSats);
    }
  } catch (err) {
    try {
      const errorMessage = err instanceof Error ? err.message : typeof err === 'string' ? err : '';

      log.error(`deposit or top up routstr failed: ${errorMessage}`);

      const { actuallyReceived, fee: receivedFee } = await wallet.receiveToken(token);

      logWalletOperation(walletDb, {
        ts: null,
        mint_url: mintUrl,
        operation: 'in',
        amount: actuallyReceived,
        fee: receivedFee,
        token,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : typeof err === 'string' ? err : '';

      log.error(`failure in deposit or top up routstr and couln't refund: ${errorMessage}`);
    }

    throw err;
  }

  const wasNew = !!existingKey;

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

export type RefundRoutstrProps = {
  mnemonic: string;
  providerDb: ProviderDb;
  mintUrl: string;
  skKey: string;
};

export async function refundRoutstr(props: RefundRoutstrProps): Promise<number> {
  const { mnemonic, mintUrl, skKey, providerDb } = props;

  const res = await fetch(`${ROUTSTR_BASE_URL}/balance/refund`, {
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

  const wallet = new CashuWallet({ mnemonic, mintUrl });

  const { actuallyReceived, fee: receivedFee } = await wallet.receiveToken(data.token);

  // TODO: make sure we provider correct arguments
  logSpend(providerDb, {
    ts: null,
    provider: 'routstr',
    mint_url: mintUrl,
    budget_sats: 0,
    refund_sats: actuallyReceived,
    spent_sats: 0,
    fee_sats: receivedFee,
    model: null,
    session_id: 'refund',
    prompt_prefix: null,
  });

  return actuallyReceived;
}

export async function getRoutstrBalance(seenDb: SeenDb): Promise<number> {
  const skKey = getRoutstrSkKey(seenDb);

  if (!skKey) {
    throw new Error('No Routstr session key. Use !provider deposit <sats> first.');
  }

  const res = await fetch(`${ROUTSTR_BASE_URL}/balance`, {
    headers: { Authorization: `Bearer ${skKey}` },
  });

  if (!res.ok) {
    throw new Error(`Balance check failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as { balance?: number; msats?: number };
  const msats = data.msats ?? data.balance ?? 0;

  return Math.floor(Number(msats) / 1000);
}
