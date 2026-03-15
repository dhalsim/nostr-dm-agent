import * as z from 'zod';

import type { CoreDb } from '../db';
import { getRoutstrBudget, getRoutstrSkKey, setRoutstrBudget, setRoutstrSkKey } from '../db';
import type { BotConfig } from '../env';
import { debug, debugAsync, log } from '../logger';
import { formatMsats, msats, msatsRaw } from '../types';
import type { Msats } from '../types';
import { CashuWallet } from '../wallets/cashu';
import type { WalletDb } from '../wallets/db';
import { getBalanceByMint, logWalletOperation } from '../wallets/db';

import type { ProviderDb } from './db';
import { logSpend } from './db';
import type {
  AnyProvider,
  PrepareRunOptions,
  FinalizeRunOptions,
  FinalizeRunResult,
} from './types';

const ROUTSTR_BASE_URL = 'https://api.routstr.com/v1';

export type CreateRoutstrProviderProps = {
  baseUrl: string;
  providerDb: ProviderDb;
  seenDb: CoreDb;
  config: BotConfig;
};

export class NoRoutstrSessionError extends Error {
  constructor() {
    super(
      'No Routstr session key. Use !provider deposit <sats> or append !!<sats> to your prompt.',
    );
  }
}

export class ZeroRoutstrBalanceError extends Error {
  constructor() {
    super('Routstr session balance is 0. Use !provider deposit <sats> first.');
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

      if (msatsRaw(getRoutstrBudget(props.seenDb)) <= 0) {
        throw new ZeroRoutstrBalanceError();
      }
    },

    async finalizeRun(opts: FinalizeRunOptions): Promise<FinalizeRunResult> {
      const oldBudget = getRoutstrBudget(props.seenDb);
      const oldRaw = msatsRaw(oldBudget);

      let spentMsats: number;
      let newBalance: Msats;

      if (opts.cost != null && opts.cost > 0) {
        spentMsats = Math.round(opts.cost * 1000);
        newBalance = msats(Math.max(0, oldRaw - spentMsats));
        setRoutstrBudget(props.seenDb, newBalance);
      } else {
        try {
          newBalance = await getRoutstrBalance(props.seenDb);
        } catch (e) {
          debug(`finalizeRun: could not fetch balance (${e instanceof Error ? e.message : e})`);

          newBalance = oldBudget;
        }

        const newRaw = msatsRaw(newBalance);

        spentMsats = Math.max(0, oldRaw - newRaw);
        setRoutstrBudget(props.seenDb, newBalance);
      }

      logSpend(props.providerDb, {
        ts: null,
        provider: 'routstr',
        mint_url: opts.mintUrl,
        budget_msats: msatsRaw(newBalance),
        refund_msats: 0,
        spent_msats: spentMsats,
        fee_msats: 0,
        model: opts.model,
        session_id: opts.sessionId,
        prompt_prefix: opts.promptPrefix,
        type: 'run',
      });

      return { spentMsats };
    },

    async getStatus(): Promise<string> {
      const skKey = getRoutstrSkKey(props.seenDb);

      return `routstr | session: ${skKey ? skKey.slice(0, 16) + '...' : 'none (use !provider deposit <sats>)'}`;
    },
  };
}

const TopupResponseSchema = z.object({
  msats: z.number(),
});

type DepositOrTopupProps = {
  mnemonic: string;
  seenDb: CoreDb;
  walletDb: WalletDb;
  providerDb: ProviderDb;
  mintUrl: string;
  amountSats: number;
  forceNew: boolean;
};

export async function depositOrTopup(
  props: DepositOrTopupProps,
): Promise<{ skKey: string | null; wasNew: boolean }> {
  const { mnemonic, seenDb, walletDb, providerDb, mintUrl, amountSats, forceNew } = props;

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

  const existingKey = forceNew ? null : getRoutstrSkKey(seenDb);

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
        balance: z.number(), // msats
      });

      const parsed = balanceCreateResponseSchema.safeParse(json);

      if (!parsed.success) {
        debug(`Unexpected create response: ${JSON.stringify(json)}`);

        throw new Error(`Unexpected create response: ${parsed.error}`);
      }

      skKey = parsed.data.api_key;
      const balanceMSats = msats(parsed.data.balance);

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
        debugAsync(async () => {
          const json = await res.json();

          return `Unexpected topup response: ${JSON.stringify(json)}`;
        });

        throw new Error(`Top-up failed: HTTP ${res.status}`);
      }

      const json = await res.json();

      debug(`Routstr topup response: ${JSON.stringify(json)}`);

      const parsed = TopupResponseSchema.safeParse(json);

      if (!parsed.success) {
        throw new Error(`routstr topup response was not expected: ${parsed.error}`);
      }

      const balanceMSats = msats(parsed.data.msats);

      log.info(`Routstr topup successful. Balance: ${formatMsats(balanceMSats)}`);
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

      await getBalanceByMint(walletDb, mintUrl);

      log.info(`refunded ${actuallyReceived} sats from routstr`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : typeof err === 'string' ? err : '';

      log.error(`failure in deposit or top up routstr and couln't refund: ${errorMessage}`);
    }

    throw err;
  }

  const wasNew = !existingKey;

  // TODO: make sure we provide correct arguments
  logSpend(providerDb, {
    ts: null,
    provider: 'routstr',
    mint_url: mintUrl,
    budget_msats: amountSats * 1000,
    refund_msats: 0,
    spent_msats: amountSats * 1000,
    fee_msats: 0,
    model: null,
    session_id: null,
    prompt_prefix: null,
    type: 'topup',
  });

  return { skKey, wasNew };
}

export type RefundRoutstrProps = {
  mnemonic: string;
  seenDb: CoreDb;
  providerDb: ProviderDb;
  mintUrl: string;
  skKey: string;
};

export async function refundRoutstr(props: RefundRoutstrProps): Promise<number> {
  const { mnemonic, seenDb, mintUrl, skKey, providerDb } = props;

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
      budget_msats: 0,
      refund_msats: 0,
      spent_msats: 0,
      fee_msats: 0,
      model: null,
      session_id: null,
      prompt_prefix: null,
      type: 'refund',
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
    budget_msats: 0,
    refund_msats: actuallyReceived * 1000,
    spent_msats: 0,
    fee_msats: receivedFee * 1000,
    model: null,
    session_id: null,
    prompt_prefix: null,
    type: 'refund',
  });

  setRoutstrBudget(seenDb, msats(0));

  return actuallyReceived;
}

const BalanceInfoResponseSchema = z
  .object({
    balance: z.number(),
  })
  .loose();

export async function getRoutstrBalance(seenDb: CoreDb): Promise<Msats> {
  const skKey = getRoutstrSkKey(seenDb);

  if (!skKey) {
    throw new Error('No Routstr session key. Use !provider deposit <sats> first.');
  }

  const res = await fetch(`${ROUTSTR_BASE_URL}/balance/info`, {
    headers: { Authorization: `Bearer ${skKey}` },
  });

  if (!res.ok) {
    debugAsync(async () => {
      const json = await res.json();

      return `Unexpected balance response: ${JSON.stringify(json)}`;
    });

    throw new Error(`Balance check failed: HTTP ${res.status}`);
  }

  const json = await res.json();

  debug(`Routstr balance response: ${JSON.stringify(json)}`);

  const data = BalanceInfoResponseSchema.safeParse(json);

  if (!data.success) {
    throw new Error(`Unexpected balance response: ${data.error}`);
  }

  return msats(data.data.balance);
}
