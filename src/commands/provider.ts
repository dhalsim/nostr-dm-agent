import { readFile, writeFile } from 'node:fs/promises';

import type { CoreDb } from '../db';
import {
  ProviderNameSchema,
  getModelOverride,
  getProviderName,
  setProviderName,
  getRoutstrBudget,
  setRoutstrBudget,
  getRoutstrModel,
  getRoutstrSkKey,
  setCachedRoutstrModels,
  getCachedRoutstrModels,
} from '../db';
import { log } from '../logger';
import type { ProviderDb } from '../providers/db';
import { depositOrTopup, refundRoutstr, getRoutstrBalance } from '../providers/routstr';
import { buildOpenCodeModelEntry, fetchRoutstrModels } from '../providers/routstr-models';
import type { Msats } from '../types';
import { formatMsats, msatsRaw } from '../types';
import type { WalletDb } from '../wallets/db';

export type HandleProviderSetProps = {
  seenDb: CoreDb;
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
    const skKey = getRoutstrSkKey(seenDb);
    const lines = ['Provider set to: routstr'];

    lines.push(
      skKey
        ? `Session key: ${skKey.slice(0, 16)}...`
        : 'No session yet. Use !provider deposit <sats> or append !!<sats> to your prompt.',
    );

    const modelOverride = getModelOverride(seenDb);
    const routstrModel = getRoutstrModel(seenDb);

    if (modelOverride && !modelOverride.startsWith('routstr/')) {
      log.warn(
        `Current model override "${modelOverride}" is not a routstr model — it will likely fail.
        \nRun "!provider models" to list available models for the provider and then
        \nRun "!model set routstr/<id>" to set the model.`,
      );
    } else if (!routstrModel && !modelOverride?.startsWith('routstr/')) {
      log.warn(
        `No routstr model configured. Run "!provider models" to list available models for the provider 
        and then
        \nRun "!model set routstr/<id>" to set the model.`,
      );
    }

    return lines.join('\n');
  }

  return 'Provider set to: local';
}

export type HandleProviderDepositProps = {
  seenDb: CoreDb;
  walletDb: WalletDb;
  mnemonic: string;
  mintUrl: string;
  providerDb: ProviderDb;
  amountSats: number;
  forceNew: boolean;
};

export async function handleProviderDeposit({
  seenDb,
  walletDb,
  mnemonic,
  mintUrl,
  providerDb,
  amountSats,
  forceNew,
}: HandleProviderDepositProps): Promise<string> {
  const { skKey, wasNew } = await depositOrTopup({
    seenDb,
    walletDb,
    mnemonic,
    providerDb,
    mintUrl,
    amountSats,
    forceNew,
  });

  if (!skKey) {
    return 'could not get sk-key from routstr while depositing';
  }

  setProviderName(seenDb, 'routstr');
  const action = wasNew ? 'Created new session' : 'Topped up existing session';

  return `${action} with ${amountSats} sats.\nSession: ${skKey.slice(0, 8)}...\nProvider set to routstr.`;
}

type HandleProviderRefundProps = {
  seenDb: CoreDb;
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
    seenDb,
    mintUrl,
    skKey,
  });

  return sats === 0
    ? 'Nothing to refund (session balance was 0).'
    : `Refunded ${sats} sats to local wallet. Session key kept for future use.`;
}

export async function handleProviderBalance(seenDb: CoreDb): Promise<string> {
  const balance = await getRoutstrBalance(seenDb);
  const currentBudget = getRoutstrBudget(seenDb);

  const changed = msatsRaw(currentBudget) !== msatsRaw(balance);

  if (changed) {
    setRoutstrBudget(seenDb, balance);
  }

  const suffix = changed ? ' (budget updated)' : '';

  return `Routstr session balance: ${formatMsats(balance)}${suffix}`;
}

export function handleProviderBudget(seenDb: CoreDb, budgetMsats: Msats): string {
  setRoutstrBudget(seenDb, budgetMsats);

  return `Budget set to: ${formatMsats(budgetMsats)}`;
}

export type HandleProviderStatusProps = {
  seenDb: CoreDb;
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
    `Default budget: ${formatMsats(budgetMsats)}`,
    `Model:          ${model ? `routstr/${model}` : '(not set)'}`,
  ].join('\n');
}

export async function handleProviderSyncModels(db: CoreDb): Promise<string> {
  const result = getCachedRoutstrModels(db);

  if (!result) {
    const models = await fetchRoutstrModels();
    setCachedRoutstrModels(db, models);

    return 'Fetched new models and cached them.';
  }

  const { models, ts } = result;

  return `Found ${models.length} cached Routstr models. Last updated: ${new Date(ts).toLocaleString()}`;
}

export type HandleProviderModelsProps = {
  seenDb: CoreDb;
  filter?: string;
};

export async function handleProviderModels({
  seenDb,
  filter,
}: HandleProviderModelsProps): Promise<string> {
  let result = getCachedRoutstrModels(seenDb);

  if (!result) {
    const models = await fetchRoutstrModels();
    setCachedRoutstrModels(seenDb, models);
    result = { models, ts: Date.now() };
  }

  const { models, ts } = result;

  const needle = filter?.trim().toLowerCase() ?? '';

  const filtered =
    needle === ''
      ? models
      : models.filter(
          (m) =>
            m.id.toLowerCase().includes(needle) ||
            (m.name?.toLowerCase().includes(needle) ?? false),
        );

  if (filtered.length === 0) {
    return needle
      ? `No Routstr models matching "${filter}". Run !provider sync-models then !provider models.`
      : 'No Routstr models cached. Run !provider sync-models first.';
  }

  const lines = filtered.map((m) => {
    const ctx = m.context_length != null ? ` (${m.context_length} ctx)` : '';

    return `  routstr/${m.id}${m.name ? ` — ${m.name}` : ''}${ctx}`;
  });

  return `Routstr models${needle ? ` matching "${filter}"` : ''} (${filtered.length}, cached ${new Date(ts).toLocaleString()}):\n${lines.join('\n')}`;
}

export type HandleProviderAddModelProps = {
  seenDb: CoreDb;
  modelId: string;
  openCodeJsonPath: string;
};

export async function handleProviderAddModel({
  seenDb,
  modelId,
  openCodeJsonPath,
}: HandleProviderAddModelProps): Promise<string> {
  let result = getCachedRoutstrModels(seenDb);

  if (!result) {
    const models = await fetchRoutstrModels();
    setCachedRoutstrModels(seenDb, models);
    result = { models, ts: Date.now() };
  }

  const model = result.models.find((m) => m.id === modelId);

  if (!model) {
    return `Model "${modelId}" not found in cached Routstr models. Try !provider sync-models first.`;
  }

  const raw = await readFile(openCodeJsonPath, 'utf-8');
  const config = JSON.parse(raw) as Record<string, unknown>;

  if (typeof config.provider !== 'object' || config.provider === null) {
    config.provider = {};
  }

  const provider = config.provider as Record<string, unknown>;

  if (typeof provider.routstr !== 'object' || provider.routstr === null) {
    provider.routstr = {};
  }

  const routstr = provider.routstr as Record<string, unknown>;

  if (typeof routstr.models !== 'object' || routstr.models === null) {
    routstr.models = {};
  }

  const models = routstr.models as Record<string, unknown>;
  const entry = buildOpenCodeModelEntry(model);
  const isUpdate = modelId in models;

  models[modelId] = entry;

  await writeFile(openCodeJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  const action = isUpdate ? 'Updated' : 'Added';

  return `${action} model "${modelId}" in opencode.json:\n${JSON.stringify(entry, null, 2)}`;
}
