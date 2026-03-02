import type { SeenDb } from '../db';
import {
  ProviderNameSchema,
  getProviderName,
  setProviderName,
  getRoutstrBudget,
  setRoutstrBudget,
  getRoutstrModel,
  getRoutstrSkKey,
  setCachedRoutstrModels,
  getCachedRoutstrModels,
} from '../db';
import type { ProviderDb } from '../providers/db';
import { depositOrTopup, refundRoutstr, getRoutstrBalance } from '../providers/routstr';
import { fetchRoutstrModels } from '../providers/routstr-models';
import type { WalletDb } from '../wallets/db';

export type HandleProviderSetProps = {
  seenDb: SeenDb;
  name: string | null;
};

export function handleProviderSet({ seenDb, name }: HandleProviderSetProps): string {
  if (!name) {
    return `Usage: !provider set [${ProviderNameSchema.options.join('|')}]`;
  }

  const parsed = ProviderNameSchema.safeParse(name);

  if (!parsed.success) {
    return `Invalid provider: ${name}. Use: ${ProviderNameSchema.options.join('|')}`;
  }

  setProviderName(seenDb, parsed.data);

  if (parsed.data === 'routstr') {
    // TODO: need to check the backend is OpenCode (cursor won't work with routstr)
    const skKey = getRoutstrSkKey(seenDb);
    const lines = ['Provider set to: routstr'];

    lines.push(
      skKey
        ? `Session key: ${skKey.slice(0, 16)}...`
        : 'No session yet. Use !provider deposit <sats> or append !!<sats> to your prompt.',
    );

    return lines.join('\n');
  }

  return 'Provider set to: local';
}

export type HandleProviderDepositProps = {
  seenDb: SeenDb;
  walletDb: WalletDb;
  mnemonic: string;
  mintUrl: string;
  providerDb: ProviderDb;
  amountSats: number;
};

export async function handleProviderDeposit({
  seenDb,
  walletDb,
  mnemonic,
  mintUrl,
  providerDb,
  amountSats,
}: HandleProviderDepositProps): Promise<string> {
  const { skKey, wasNew } = await depositOrTopup({
    seenDb,
    walletDb,
    mnemonic,
    providerDb,
    mintUrl,
    amountSats,
  });

  if (!skKey) {
    return 'could not get sk-key from routstr while depositing';
  }

  setProviderName(seenDb, 'routstr');
  const action = wasNew ? 'Created new session' : 'Topped up existing session';

  return `${action} with ${amountSats} sats.\nSession: ${skKey.slice(0, 16)}...\nProvider set to routstr.`;
}

type HandleProviderRefundProps = {
  seenDb: SeenDb;
  mnemonic: string;
  mintUrl: string;
  providerDb: ProviderDb;
};

export async function handleProviderRefund({
  seenDb,
  mnemonic,
  mintUrl,
  providerDb,
}: HandleProviderRefundProps): Promise<string> {
  const skKey = getRoutstrSkKey(seenDb);

  if (!skKey) {
    return 'sk-key is not set';
  }

  const sats = await refundRoutstr({
    mnemonic,
    providerDb,
    mintUrl,
    skKey,
  });

  return sats === 0
    ? 'Nothing to refund (session balance was 0).'
    : `Refunded ${sats} sats to local wallet. Session key kept for future use.`;
}

export async function handleProviderBalance(seenDb: SeenDb): Promise<string> {
  const sats = await getRoutstrBalance(seenDb);

  return `Routstr session balance: ${sats} sats`;
}

export function handleProviderBudget(seenDb: SeenDb, budgetMsats: number): string {
  setRoutstrBudget(seenDb, budgetMsats);

  return `Budget set to: ${budgetMsats} msats`;
}

export type HandleProviderStatusProps = {
  seenDb: SeenDb;
  mintUrl: string;
};

export function handleProviderStatus({ seenDb, mintUrl }: HandleProviderStatusProps): string {
  const name = getProviderName(seenDb);

  if (name !== 'routstr') {
    return 'Provider: local | no payment';
  }

  const skKey = getRoutstrSkKey(seenDb);
  const model = getRoutstrModel(seenDb);
  const budgetMsats = getRoutstrBudget(seenDb);

  return [
    `Provider:       routstr`,
    `Session key:    ${skKey ? skKey.slice(0, 6) + '...' : 'none'}`,
    `Mint:           ${mintUrl}`,
    `Default budget: ${budgetMsats} msats`,
    `Model:          ${model ? `routstr/${model}` : '(not set)'}`,
  ].join('\n');
}

export async function handleProviderSyncModels(db: SeenDb): Promise<string> {
  const result = getCachedRoutstrModels(db);

  if (!result) {
    const models = await fetchRoutstrModels();
    setCachedRoutstrModels(db, models);

    return 'Fetched new models and cached them.';
  }

  const { models, ts } = result;

  return `Found ${models.length} cached Routstr models. Last updated: ${new Date(ts).toLocaleString()}`;
}
