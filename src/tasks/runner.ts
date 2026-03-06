// ---------------------------------------------------------------------------
// tasks/runner.ts — Execute a single task: backend run + DM result
// ---------------------------------------------------------------------------
import { createBackend } from '../backends/factory';
import type { AgentRunResult } from '../backends/types';
import type { SeenDb } from '../db';
import { getRoutstrBudget, getRoutstrSkKey, getWalletDefaultMintUrl } from '../db';
import type { BotConfig } from '../env';
import { log } from '../logger';
import { asProviderDb } from '../providers/db';
import type { ProviderDb } from '../providers/db';
import { createProvider } from '../providers/factory';
import {
  depositOrTopup,
  NoRoutstrSessionError,
  refundRoutstr,
  ZeroRoutstrBalanceError,
} from '../providers/routstr';
import { msatsRaw } from '../types';
import type { WalletDb } from '../wallets/db';
import { InsufficientFundsError } from '../wallets/types';

import { insertTaskRun, updateTaskRun } from './db';
import type { Task } from './types';

export type TaskRunnerContext = {
  workspaceRoot: string;
  dmBotRoot: string;
  attachUrl: string | null;
  getAgentEnv: () => Record<string, string | undefined>;
  walletDb: WalletDb | null;
  providerDb: ProviderDb | null;
  config: BotConfig;
  routstrBaseUrl: string;
  sendDm: (message: string) => Promise<void>;
};

export async function runTask(task: Task, db: SeenDb, context: TaskRunnerContext): Promise<void> {
  const backendName = task.backend;
  const providerName = task.provider;
  const mode = task.mode;
  const modelRaw = task.model || null;

  const finalModelOverride =
    providerName === 'routstr' && modelRaw ? `routstr/${modelRaw}` : modelRaw;

  const backend = createBackend({
    backendName,
    dmBotRoot: context.dmBotRoot,
    mode,
    attachUrl: context.attachUrl,
    modelOverride: finalModelOverride,
    providerName,
  });

  const cwd = context.workspaceRoot;
  const env = context.getAgentEnv();

  const sessionId = await backend.createSession({ cwd, env });

  const provider = createProvider({
    name: providerName,
    walletDb: context.walletDb,
    seenDb: db,
    providerDb: context.providerDb,
    config: context.config,
    routstrBaseUrl: context.routstrBaseUrl,
  });

  const isAutoFlow = providerName === 'routstr' && task.budget_sats != null;

  if (isAutoFlow) {
    const { budget_sats } = task;

    if (!context.walletDb) {
      await context.sendDm(
        `[Task: ${task.name}]\nSkipped: Wallet not available. Run \`npm run wallet:setup\`.`,
      );

      return;
    }

    const mintUrl = getWalletDefaultMintUrl(db, context.config.cashuDefaultMintUrl);

    if (!mintUrl) {
      await context.sendDm(
        `[Task: ${task.name}]\nSkipped: No mint configured. Use !wallet mint <url>.`,
      );

      return;
    }

    const mnemonic = context.config.cashuMnemonic;

    if (!mnemonic) {
      await context.sendDm(
        `[Task: ${task.name}]\nSkipped: No wallet mnemonic. Run \`npm run wallet:setup\`.`,
      );

      return;
    }

    try {
      const { wasNew } = await depositOrTopup({
        mnemonic,
        seenDb: db,
        walletDb: context.walletDb,
        providerDb: context.providerDb ?? asProviderDb(db),
        mintUrl,
        amountSats: budget_sats!,
        forceNew: false,
      });

      log.info(
        `Task ${task.id}: auto-flow ${wasNew ? 'created session' : 'topped up'} with ${budget_sats} sats`,
      );
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        await context.sendDm(
          `[Task: ${task.name}]\nSkipped: Insufficient wallet balance. Have ${err.available} sats, need ${budget_sats} sats.`,
        );

        return;
      }

      await context.sendDm(`[Task: ${task.name}]\nSkipped: Deposit failed: ${String(err)}`);

      return;
    }
  } else {
    const budgetMsats = msatsRaw(getRoutstrBudget(db));
    const budgetSats = Math.ceil(budgetMsats / 1000);

    try {
      await provider.prepareRun({ budgetSats });
    } catch (e) {
      if (e instanceof NoRoutstrSessionError || e instanceof ZeroRoutstrBalanceError) {
        await context.sendDm(`[Task: ${task.name}]\nSkipped: ${e.message}`);

        return;
      }

      if (e instanceof InsufficientFundsError) {
        await context.sendDm(
          `[Task: ${task.name}]\nSkipped: Wallet balance too low. Have ${e.available} sats, need ${e.required} sats.`,
        );

        return;
      }

      throw e;
    }
  }

  const runId = insertTaskRun(db, task.id);

  const effectiveContent =
    task.instructions != null && task.instructions.trim().length > 0
      ? `Instructions:\n${task.instructions}\n\nTask:\n${task.prompt}`
      : task.prompt;

  let result: AgentRunResult;

  try {
    result = await backend.runMessage({
      sessionId,
      content: effectiveContent,
      mode,
      cwd,
      env,
      modelOverride: finalModelOverride,
    });
  } catch (err) {
    const errMsg = String(err);
    updateTaskRun(db, runId, 'error', null, errMsg, null);
    await context.sendDm(`[Task: ${task.name}]\nError: ${errMsg}`);

    return;
  }

  const output = result.output;
  const success = result.type === 'success';
  const mintUrl = getWalletDefaultMintUrl(db, context.config.cashuDefaultMintUrl);

  let budgetUsedMsats: number | null = null;

  if (mintUrl) {
    const cost = result.type === 'success' ? result.cost : undefined;
    const tokens = result.type === 'success' ? result.tokens : undefined;

    const finalizeResult = await provider.finalizeRun({
      success,
      sessionId,
      promptPrefix: effectiveContent,
      model: backend.modelName,
      mintUrl,
      cost,
      tokens,
    });

    budgetUsedMsats = finalizeResult.spentMsats;
  }

  updateTaskRun(
    db,
    runId,
    success ? 'success' : 'error',
    output,
    success ? null : output,
    budgetUsedMsats,
  );

  if (isAutoFlow) {
    const mintUrl = getWalletDefaultMintUrl(db, context.config.cashuDefaultMintUrl);
    const skKey = getRoutstrSkKey(db);
    const mnemonic = context.config.cashuMnemonic;
    const providerDb = context.providerDb ?? asProviderDb(db);

    if (mintUrl && skKey && mnemonic) {
      try {
        const recovered = await refundRoutstr({ mnemonic, providerDb, seenDb: db, mintUrl, skKey });

        if (recovered > 0) {
          log.info(`Task ${task.id}: auto-flow recovered ${recovered} sats`);
        }
      } catch (err) {
        log.error(`Task ${task.id}: auto-flow refund failed: ${String(err)}`);
      }
    }
  }

  const header = `[Task: ${task.name}]\n`;
  await context.sendDm(header + (output || '(no output)'));
}
