// ---------------------------------------------------------------------------
// src/flow/agent-conversation.ts — Session, provider, agent run, reply, refund
// ---------------------------------------------------------------------------

import type { AgentBackend } from '../backends/types';
import { getOutputString } from '../backends/types';
import { parseBudgetAnnotation } from '../budget-annotation';
import type { CoreDb } from '../db';
import {
  getCurrentOrDefaultMode,
  getProviderName,
  getReplyTransport,
  getRoutstrBudget,
  getWalletDefaultMintUrl,
  getWorkspaceTarget,
} from '../db';
import type { BotConfig } from '../env';
import { C, log } from '../logger';
import type { MessageSource } from '../messaging';
import { modePrefix, tokenFooter, sendChunkedReply } from '../messaging';
import type { ProviderDb } from '../providers/db';
import { createProvider } from '../providers/factory';
import { getOrCreateCurrentSession, insertSessionMessage } from '../session';
import { msatsRaw } from '../types';
import type { WalletDb } from '../wallets/db';

import { runAgentWithLintFollowUp } from './agent-lint-follow-up';
import { prepareAutoFlowDeposit } from './auto-flow-deposit';
import { finalizeAutoFlowRefund } from './auto-flow-refund';
import { prepareProviderRun } from './prepare-provider-run';

export type RunAgentConversationProps = {
  content: string;
  source: MessageSource;
  sendReplyForSource: (source: MessageSource, message: string) => Promise<void>;
  backend: AgentBackend;
  seenDb: CoreDb;
  dmBotRoot: string;
  parentOfBotRoot: string;
  opencodeServeUrl: string | null;
  config: BotConfig;
  walletDb: WalletDb | null;
  providerDb: ProviderDb | null;
  routstrBaseUrl: string;
};

export async function runAgentConversation({
  content,
  source,
  sendReplyForSource,
  backend,
  seenDb,
  dmBotRoot,
  parentOfBotRoot,
  opencodeServeUrl,
  config,
  walletDb,
  providerDb,
  routstrBaseUrl,
}: RunAgentConversationProps): Promise<void> {
  const isLocal = source === 'local' || getReplyTransport(seenDb) === 'local';
  const mode = getCurrentOrDefaultMode(seenDb);
  const currentWorkspace = getWorkspaceTarget(seenDb);
  const cwd = currentWorkspace === 'bot' ? dmBotRoot : parentOfBotRoot;

  const sessionId = await getOrCreateCurrentSession({
    db: seenDb,
    backend,
    cwd,
  });

  insertSessionMessage(seenDb, sessionId, 'user', content);

  const { prompt: effectiveContent, budgetSats: inlineBudget } =
    parseBudgetAnnotation(content);

  const configuredProviderName = getProviderName(seenDb);

  const isAutoFlow =
    inlineBudget !== null && configuredProviderName === 'routstr';

  const provider = createProvider({
    name: configuredProviderName,
    walletDb,
    seenDb,
    providerDb,
    config,
    routstrBaseUrl,
  });

  if (isAutoFlow) {
    const depositErr = await prepareAutoFlowDeposit({
      seenDb,
      cashuDefaultMintUrl: config.cashuDefaultMintUrl,
      cashuMnemonic: config.cashuMnemonic,
      walletDb,
      providerDb,
      amountSats: inlineBudget,
    });

    if (depositErr) {
      await sendReplyForSource(source, depositErr);

      return;
    }
  }

  const prepareErr = await prepareProviderRun({
    provider,
    budgetSats:
      inlineBudget != null
        ? inlineBudget * 1000
        : msatsRaw(getRoutstrBudget(seenDb)),
  });

  if (prepareErr) {
    await sendReplyForSource(source, prepareErr);

    return;
  }

  try {
    const { result: finalResult } = await runAgentWithLintFollowUp({
      dmBotRoot,
      attachUrl: opencodeServeUrl,
      mode,
      configuredProviderName,
      sessionId,
      cwd,
      coreDb: seenDb,
      effectiveContent,
      currentWorkspace,
      backendName: backend.name,
    });

    const finalOutput = getOutputString(finalResult);

    const isErrorResponse =
      finalResult.type === 'error' ||
      finalOutput.startsWith('Unexpected error') ||
      finalOutput.startsWith('Error:') ||
      finalOutput.includes('check log file at') ||
      finalOutput === '(no output)';

    if (!isErrorResponse) {
      insertSessionMessage(seenDb, sessionId, 'assistant', finalOutput);
    } else {
      log.error(
        `${C.red}[bot] Error response — not stored in session history.${C.reset}`,
      );

      log.error(finalOutput);
    }

    const mintUrl = getWalletDefaultMintUrl(seenDb, config.cashuDefaultMintUrl);
    let spentMsats = 0;

    if (mintUrl) {
      const cost =
        finalResult.type === 'success' ? finalResult.cost : undefined;

      const tokens =
        finalResult.type === 'success' ? finalResult.tokens : undefined;

      const result = await provider.finalizeRun({
        success: finalResult.type === 'success',
        sessionId,
        promptPrefix: effectiveContent,
        model: backend.modelName,
        mintUrl,
        cost,
        tokens,
      });

      spentMsats = result.spentMsats;
    }

    const prefix = modePrefix(mode, isLocal);
    const footer = tokenFooter(finalResult, isLocal, spentMsats);

    let fullReply: string;

    if (
      isLocal &&
      finalResult.type === 'success' &&
      finalResult.outputs.some((o) => o.type === 'reasoning')
    ) {
      const reasoningSegs = finalResult.outputs.filter(
        (o): o is { type: 'reasoning'; value: string } =>
          o.type === 'reasoning',
      );

      const reasoningText = reasoningSegs.map((s) => s.value).join('\n');
      const thinkingBlock = `${C.dim}<thinking>\n${reasoningText}\n</thinking>${C.reset}\n\n`;
      const prefixWithNewline = prefix.trimEnd() + '\n';
      fullReply = prefixWithNewline + thinkingBlock + finalOutput + footer;
    } else {
      fullReply = prefix + finalOutput + footer;
    }

    await sendChunkedReply({
      source,
      reply: fullReply,
      sendReplyForSource,
    });
  } catch (err) {
    log.error(`${C.red}Agent process error:${C.reset} ${String(err)}`);

    sendReplyForSource(source, `<${mode}> Error: ${String(err)}`).catch((e) =>
      log.error(`Failed to send error reply: ${String(e)}`),
    );
  } finally {
    await finalizeAutoFlowRefund({
      isAutoFlow,
      walletDb,
      seenDb,
      cashuDefaultMintUrl: config.cashuDefaultMintUrl,
      cashuMnemonic: config.cashuMnemonic,
      providerDb,
      sendReply: (msg) => sendReplyForSource(source, msg),
    });
  }
}
