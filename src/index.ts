#!/usr/bin/env bun
/**
 * NIP-17 DM Bot - Listens for private messages from master and replies.
 *
 * Environment variables:
 *   BOT_KEY                 - Bot's private key (hex)
 *   BOT_PUBKEY              - Bot's public key (hex) - optional, derived from BOT_KEY if omitted
 *   BOT_MASTER_PUBKEY       - Master's pubkey to listen to and reply to (hex)
 *   BOT_RELAYS              - Comma-separated relay URLs (e.g. wss://relay.damus.io,wss://relay.nos.social)
 *   DEBUG                   - Set to 1 for extra logging (subscription, received events, send targets)
 *   LOG                     - Set to 0 to suppress all log()/logError() output. Default 1.
 *   BOT_OPENCODE_SERVE_URL  - Attach to a running opencode server (e.g. http://localhost:4096)
 *   CASHU_DEFAULT_MINT_URL  - Default Cashu mint URL to use for auto-flow
 *
 * Restart: when using watch, touch restart.requested in this directory to restart the bot.
 */

import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import readline from 'readline';

import { spawnSync } from 'bun';
import type { NostrEvent, EventTemplate, VerifiedEvent } from 'nostr-tools/core';
import { unwrapEvent } from 'nostr-tools/nip17';
import { SimplePool } from 'nostr-tools/pool';
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';

import { createBackend } from './backends/factory';
import type { AgentRunResult } from './backends/types';
import { parseBudgetAnnotation } from './budget-annotation';
import { handleBangCommand, EXIT_COMMAND_SENTINEL } from './commands';
import { getStatusLines } from './commands/bot';
import {
  openSeenDb,
  initSkKeyEncryption,
  alreadyHaveEvent,
  markSeen,
  getDefaultMode,
  getAgentBackend,
  getReplyTransport,
  getWorkspaceTarget,
  getModelOverride,
  getProviderName,
  getRoutstrBudget,
  getWalletDefaultMintUrl,
  getLinting,
  getRoutstrModel,
  getRoutstrSkKey,
} from './db';
import type { AgentMode, SeenDb } from './db';
import { loadBotConfig } from './env';
import type { BotConfig } from './env';
import { runPostAgentLint, formatLintSummary } from './lint';
import { C, debug, log } from './logger';
import {
  sleep,
  chunkMessage,
  modePrefix,
  tokenFooter,
  sendDm,
  CHUNK_DELAY_BASE_MS,
  CHUNK_DELAY_MAX_MS,
} from './messaging';
import { dmBotRoot, RESTART_REQUESTED_PATH } from './paths';
import { asProviderDb } from './providers/db';
import type { ProviderDb } from './providers/db';
import { createProvider } from './providers/factory';
import {
  depositOrTopup,
  refundRoutstr,
  NoRoutstrSessionError,
  ZeroRoutstrBalanceError,
} from './providers/routstr';
import type { AnyProvider, ProviderName } from './providers/types';
import { getOrCreateCurrentSession, insertSessionMessage } from './session';
import { msatsRaw } from './types';
import { openWalletDb } from './wallets/db';
import type { WalletDb } from './wallets/db';
import { InsufficientFundsError } from './wallets/types';

const POST_AGENT_LINT_PROMPT_PREFIX = '[Post-edit lint feedback]';

type MessageSource = 'nostr' | 'local';

async function prepareAutoFlowDeposit(opts: {
  seenDb: SeenDb;
  config: BotConfig;
  walletDb: WalletDb | null;
  providerDb: ProviderDb | null;
  amountSats: number;
}): Promise<string | null> {
  if (!opts.walletDb) {
    return 'Wallet not available. Run `npm run wallet:setup` to configure your wallet.';
  }

  const mintUrl = getWalletDefaultMintUrl(opts.seenDb, opts.config.cashuDefaultMintUrl);

  if (!mintUrl) {
    return 'No mint configured. Use !wallet mint <url> first.';
  }

  const mnemonic = opts.config.cashuMnemonic;

  if (!mnemonic) {
    return 'No mnemonic configured. Set one with: !wallet setup';
  }

  try {
    const { wasNew } = await depositOrTopup({
      mnemonic,
      seenDb: opts.seenDb,
      walletDb: opts.walletDb,
      providerDb: opts.providerDb!,
      mintUrl,
      amountSats: opts.amountSats,
      forceNew: false,
    });

    log.warn(`Auto-flow: ${wasNew ? 'created session' : 'topped up'} with ${opts.amountSats} sats`);

    return null;
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      return `Insufficient local balance: ${err.available} sats available, ${err.required} needed.\nTop up with: !wallet receive <token>`;
    }

    return `Deposit failed: ${String(err)}`;
  }
}

async function prepareProviderRun(
  provider: AnyProvider,
  budgetSats: number,
): Promise<string | null> {
  try {
    await provider.prepareRun({ budgetSats });

    return null;
  } catch (e) {
    if (e instanceof NoRoutstrSessionError || e instanceof ZeroRoutstrBalanceError) {
      return e.message;
    }

    if (e instanceof InsufficientFundsError) {
      return `Wallet balance too low. Have ${e.available} sats, need ${e.required} sats. Top up with: !wallet receive <cashuXXX>`;
    }

    throw e;
  }
}

async function runAgentWithLintFollowUp(opts: {
  runAgentRound: (content: string, startLog: string) => Promise<AgentRunResult>;
  effectiveContent: string;
  mode: AgentMode;
  currentWorkspace: string;
  backendName: string;
  seenDb: SeenDb;
  sessionId: string;
  cwd: string;
}): Promise<{ output: string; result: AgentRunResult }> {
  const initialResult = await opts.runAgentRound(
    opts.effectiveContent,
    `${C.dim}Starting ${opts.backendName} agent (${opts.mode})…${C.reset}\n`,
  );

  let finalOutput = initialResult.output;
  let finalResult = initialResult;

  if (initialResult.type === 'error') {
    return { output: finalOutput, result: finalResult };
  }

  const linting = getLinting(opts.seenDb);

  if (opts.mode !== 'agent' || linting === 'off') {
    return { output: finalOutput, result: finalResult };
  }

  const lintLabel = opts.currentWorkspace === 'bot' ? 'dm-bot' : 'workspace';
  const lintResult = runPostAgentLint({ cwd: opts.cwd, label: lintLabel });

  if (!lintResult.available) {
    log.error(
      `Skipping post-agent lint: npm run lint is unavailable in this runtime for ${lintLabel}.`,
    );

    return { output: finalOutput, result: finalResult };
  }

  const lintSummary = formatLintSummary(lintResult);
  finalOutput = `${initialResult.output}\n\n${lintSummary}`;
  const lintFailed = lintResult.exitCode !== 0;

  if (!lintFailed) {
    return { output: finalOutput, result: finalResult };
  }

  const lintPrompt = `${POST_AGENT_LINT_PROMPT_PREFIX}\n${lintSummary}\n\nFix any lint issues and provide your final summary.`;
  insertSessionMessage(opts.seenDb, opts.sessionId, 'user', lintPrompt);

  try {
    const fixResult = await opts.runAgentRound(
      lintPrompt,
      `${C.dim}Starting ${opts.backendName} agent (lint feedback)…${C.reset}\n`,
    );

    finalOutput = `${finalOutput}\n\n${fixResult.output}`;
    finalResult = fixResult;
  } catch (lintFollowupErr) {
    log.error(`Lint follow-up agent process error: ${String(lintFollowupErr)}`);
    finalOutput = `${finalOutput}\n\nAutomatic lint-fix round failed: ${String(lintFollowupErr)}`;
  }

  return { output: finalOutput, result: finalResult };
}

async function sendChunkedReply(opts: {
  source: MessageSource;
  reply: string;
  sendReplyForSource: (source: MessageSource, message: string) => Promise<void>;
}): Promise<void> {
  const chunks = chunkMessage(opts.reply);
  const total = chunks.length;
  let delayMs = CHUNK_DELAY_BASE_MS;

  for (let i = 0; i < chunks.length; i++) {
    const hasNextChunk = i < chunks.length - 1;

    const maybeNextPrompt = hasNextChunk && opts.source === 'nostr' ? '\n<CHECK NEXT MESSAGE>' : '';

    const chunkBody = `${chunks[i]}${maybeNextPrompt}`;
    const chunk = total > 1 ? `(${i + 1}/${total}) ${chunkBody}` : chunkBody;

    try {
      await opts.sendReplyForSource(opts.source, chunk);
    } catch (e) {
      const targetLabel = opts.source === 'local' ? 'local output' : 'DM chunk';
      log.error(`Failed to send ${targetLabel}: ${String(e)}`);
    }

    if (hasNextChunk) {
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, CHUNK_DELAY_MAX_MS);
    }
  }
}

async function finalizeAutoFlowRefund(opts: {
  isAutoFlow: boolean;
  walletDb: WalletDb | null;
  seenDb: SeenDb;
  config: BotConfig;
  providerDb: ProviderDb | null;
  sendReply: (message: string) => Promise<void>;
}): Promise<void> {
  if (!opts.isAutoFlow) {
    return;
  }

  if (!opts.walletDb) {
    await opts.sendReply(
      "Wallet not available. Auto-flow won't run. `npm run wallet:setup` to configure your wallet.",
    );

    return;
  }

  const skKey = getRoutstrSkKey(opts.seenDb);

  if (!skKey) {
    await opts.sendReply('No Routstr session key. Use !provider deposit <sats> first.');

    return;
  }

  const mnemonic = opts.config.cashuMnemonic;

  if (!mnemonic) {
    await opts.sendReply(
      'No mnemonic configured. Run `npm run wallet:setup` to configure your wallet.',
    );

    return;
  }

  const mintUrl = getWalletDefaultMintUrl(opts.seenDb, opts.config.cashuDefaultMintUrl);

  if (!mintUrl) {
    await opts.sendReply('No mint configured. Use !wallet mint <url> first.');

    return;
  }

  if (!opts.providerDb) {
    return;
  }

  const recovered = await refundRoutstr({
    mnemonic,
    providerDb: opts.providerDb,
    seenDb: opts.seenDb,
    mintUrl,
    skKey,
  });

  if (recovered > 0) {
    log.warn(`Auto-flow: recovered ${recovered} sats`);
  }
}

let redrawPrompt: (() => void) | null = null;

function main() {
  if (existsSync(RESTART_REQUESTED_PATH)) {
    try {
      unlinkSync(RESTART_REQUESTED_PATH);
    } catch {
      // Ignore if file was already removed.
    }
  }

  const config = loadBotConfig();

  const {
    botKeyHex,
    botPubkey: botPubkeyFromEnv,
    masterPubkey,
    relayUrls,
    agentPath,
    opencodeServeUrl,
    cashuMnemonic,
    routstrBaseUrl,
  } = config;

  const primaryRelay = relayUrls[0];

  const botSecretKey = hexToBytes(botKeyHex);
  const botPubkey = botPubkeyFromEnv ?? getPublicKey(botSecretKey);

  if (botPubkeyFromEnv && botPubkey !== botPubkeyFromEnv) {
    log.error(`Bot pubkey mismatch. Expected: ${botPubkeyFromEnv}, Got: ${botPubkey}`);

    process.exit(1);
  }

  const pool = new SimplePool({ enablePing: true, enableReconnect: true });

  initSkKeyEncryption(botKeyHex, botPubkey);

  const seenDb = openSeenDb();
  const providerDb = asProviderDb(seenDb);
  const walletDb = cashuMnemonic ? openWalletDb(cashuMnemonic) : null;

  const workspaceRoot = join(dmBotRoot, '..');

  const agentEnv: Record<string, string | undefined> = {
    ...process.env,
    PATH: agentPath,
  };

  function getAgentEnv(): Record<string, string | undefined> {
    const env = { ...agentEnv };

    const backendName = getAgentBackend(seenDb);

    if (
      getProviderName(seenDb) === 'routstr' &&
      (backendName === 'opencode' || backendName === 'opencode-sdk')
    ) {
      const skKey = getRoutstrSkKey(seenDb);

      if (skKey) {
        env.ROUTSTR_API_KEY = skKey;
      }
    }

    return env;
  }

  const packageJson = readFileSync(join(dmBotRoot, 'package.json'), 'utf-8');
  const packageJsonData = JSON.parse(packageJson) as { version: string };
  const VERSION = packageJsonData.version;

  const signAuthEvent = async (authTemplate: EventTemplate): Promise<VerifiedEvent> => {
    debug('Signing AUTH challenge event:', authTemplate);

    return finalizeEvent(authTemplate, botSecretKey);
  };

  log.info(`${C.bold}Bot pubkey:${C.reset} ${botPubkey}`);
  log.info(`${C.bold}Master:${C.reset} ${masterPubkey}`);

  const statusLines = getStatusLines({
    relayUrls,
    seenDb,
    version: VERSION,
    dmBotRoot,
    attachUrl: opencodeServeUrl,
  });

  for (const line of statusLines.split('\n')) {
    log.info(line);
  }

  log.sep();

  const pwdOutput =
    spawnSync(['pwd'], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim() ?? '(failed)';

  debug('PWD:', pwdOutput);

  const readyDmEnabled = (process.env.READY_ENABLED ?? '1') !== '0';

  const readyDmPromise = readyDmEnabled
    ? sendDm({
        pool,
        botRelayUrl: primaryRelay,
        senderSecretKey: botSecretKey,
        recipientPubkey: masterPubkey,
        message: `Agent is ready.`,
        signAuthEvent,
        redrawPrompt,
      }).catch((err) => log.error(`Failed to send ready DM: ${String(err)}`))
    : Promise.resolve();

  const dmFilter = {
    kinds: [1059] as number[],
    '#p': [botPubkey],
    since: Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60,
  };

  debug('Subscription filter:', JSON.stringify(dmFilter));

  async function sendReplyForSource(source: MessageSource, message: string): Promise<void> {
    const replyTransport = getReplyTransport(seenDb);
    const sourceIsLocal = source === 'local';
    const replyTransportIsLocal = replyTransport === 'local';
    const shouldBypassNostr = sourceIsLocal || replyTransportIsLocal;

    if (shouldBypassNostr) {
      log.info(
        `${C.dim}[bypassing to send as a DM because ${sourceIsLocal ? 'source is local' : 'reply transport is local'}]${C.reset}\n`,
      );

      console.log(message ?? '(no message)');

      return;
    }

    await sendDm({
      pool,
      botRelayUrl: primaryRelay,
      senderSecretKey: botSecretKey,
      recipientPubkey: masterPubkey,
      message,
      signAuthEvent,
      redrawPrompt: null,
    });
  }

  async function handleUserMessage(content: string, source: MessageSource): Promise<void> {
    const isLocal = source === 'local' || getReplyTransport(seenDb) === 'local';
    process.stdout.write(`${C.dim}${C.magenta} > ${content}${C.reset}\n`);

    const backend = createBackend({
      backendName: getAgentBackend(seenDb),
      dmBotRoot,
      mode: getDefaultMode(seenDb),
      attachUrl: opencodeServeUrl,
      modelOverride: getModelOverride(seenDb),
      providerName: getProviderName(seenDb),
      seenDb,
    });

    if (content.trim().startsWith('!')) {
      const reply = await handleBangCommand({
        input: content,
        relayUrls,
        seenDb,
        version: VERSION,
        workspaceRoot,
        dmBotRoot,
        agentEnv: getAgentEnv(),
        attachUrl: opencodeServeUrl,
        backend,
        walletDb,
        providerDb,
        config,
      });

      if (reply === EXIT_COMMAND_SENTINEL) {
        const ack = 'Shutting down dm-bot.';

        await sendReplyForSource(source, ack);

        log.warn('Exit command received. Shutting down dm-bot.');
        process.exit(0);
      } else if (reply) {
        await sendReplyForSource(source, reply);
      } else if (source === 'local') {
        log.info(`${C.green}[bot]${C.reset}\n${C.dim}Command applied.${C.reset}`);
      }

      return;
    }

    const mode = getDefaultMode(seenDb);
    const currentWorkspace = getWorkspaceTarget(seenDb);
    const cwd = currentWorkspace === 'bot' ? dmBotRoot : workspaceRoot;

    const sessionId = await getOrCreateCurrentSession({
      db: seenDb,
      backend,
      cwd,
      env: getAgentEnv(),
    });

    insertSessionMessage(seenDb, sessionId, 'user', content);

    const { prompt: effectiveContent, budgetSats: inlineBudget } = parseBudgetAnnotation(content);

    const configuredBackendName = getAgentBackend(seenDb);
    const configuredProviderName = getProviderName(seenDb);

    // cursor backend cannot use routstr — use local for this run's provider
    const effectiveProviderName: ProviderName =
      configuredBackendName === 'cursor' && configuredProviderName === 'routstr'
        ? 'local'
        : configuredProviderName;

    const isAutoFlow = inlineBudget !== null && effectiveProviderName === 'routstr';

    const provider = createProvider({
      name: effectiveProviderName,
      walletDb,
      seenDb,
      providerDb,
      config,
      routstrBaseUrl,
    });

    if (isAutoFlow) {
      const depositErr = await prepareAutoFlowDeposit({
        seenDb,
        config,
        walletDb,
        providerDb,
        amountSats: inlineBudget,
      });

      if (depositErr) {
        await sendReplyForSource(source, depositErr);

        return;
      }
    }

    const prepareErr = await prepareProviderRun(
      provider,
      inlineBudget != null ? inlineBudget * 1000 : msatsRaw(getRoutstrBudget(seenDb)),
    );

    if (prepareErr) {
      await sendReplyForSource(source, prepareErr);

      return;
    }

    const runAgentRound = async (roundContent: string, startLog: string) => {
      log.info(startLog);

      const modelOverride = getModelOverride(seenDb);
      const backendName = getAgentBackend(seenDb);
      const routstrModel = getRoutstrModel(seenDb);

      const finalModelOverride =
        effectiveProviderName === 'routstr' && routstrModel
          ? `routstr/${routstrModel}`
          : (modelOverride ?? null);

      log.info(`finalModelOverride: ${finalModelOverride}`);

      const roundBackend = createBackend({
        backendName,
        dmBotRoot,
        mode,
        attachUrl: opencodeServeUrl,
        modelOverride: finalModelOverride,
        providerName: configuredProviderName,
        seenDb,
      });

      return roundBackend.runMessage({
        sessionId,
        content: roundContent,
        mode,
        cwd,
        env: getAgentEnv(),
        modelOverride: finalModelOverride,
      });
    };

    try {
      const { output: finalOutput, result: finalResult } = await runAgentWithLintFollowUp({
        runAgentRound,
        effectiveContent,
        mode,
        currentWorkspace,
        backendName: backend.name,
        seenDb,
        sessionId,
        cwd,
      });

      const isErrorResponse =
        finalResult.type === 'error' ||
        finalOutput.startsWith('Unexpected error') ||
        finalOutput.startsWith('Error:') ||
        finalOutput.includes('check log file at') ||
        finalOutput === '(no output)';

      if (!isErrorResponse) {
        insertSessionMessage(seenDb, sessionId, 'assistant', finalOutput);
      } else {
        log.error(`${C.red}[bot] Error response — not stored in session history.${C.reset}`);
        log.error(finalOutput);
      }

      const mintUrl = getWalletDefaultMintUrl(seenDb, config.cashuDefaultMintUrl);
      let spentMsats = 0;

      if (mintUrl) {
        const cost = finalResult.type === 'success' ? finalResult.cost : undefined;
        const tokens = finalResult.type === 'success' ? finalResult.tokens : undefined;

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
      const fullReply = prefix + finalOutput + footer;

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
        config,
        providerDb,
        sendReply: (msg) => sendReplyForSource(source, msg),
      });
    }
  }

  if (process.stdin.isTTY) {
    const startLocalCli = () => {
      console.log(
        `${C.dim}Type a prompt or ${C.reset}${C.white}!help${C.reset}${C.dim} to list commands.${C.reset}\n`,
      );

      const localCli = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `${C.bold}>${C.reset} `,
      });

      redrawPrompt = () => localCli.prompt();

      let localQueue = Promise.resolve();

      localCli.on('line', (line) => {
        const input = line.trim();

        if (!input) {
          localCli.prompt();

          return;
        }

        localQueue = localQueue
          .then(() => handleUserMessage(input, 'local'))
          .catch((err) => log.error(`Local CLI message processing failed: ${String(err)}`))
          .finally(() => localCli.prompt());
      });

      localCli.on('close', () => {
        redrawPrompt = null;
        log.ok('Local terminal chat closed. Nostr DM listener continues running.');
      });

      localCli.prompt();
    };

    readyDmPromise.finally(startLocalCli);
  }

  pool.subscribe(relayUrls, dmFilter, {
    onauth: signAuthEvent,
    alreadyHaveEvent: alreadyHaveEvent(seenDb),
    onevent: async (wrap: NostrEvent) => {
      debug('Received event kind:', wrap.kind, 'id:', wrap.id);

      try {
        const rumor = unwrapEvent(wrap, botSecretKey);

        if (rumor.pubkey !== masterPubkey) {
          debug('Ignoring rumor from non-master:', rumor.pubkey);

          return;
        }

        const content = rumor.content?.trim() ?? '';
        const kind = rumor.kind ?? 0;

        if (kind !== 14) {
          debug('Ignoring non–kind-14 rumor:', kind);

          return;
        }

        if (getReplyTransport(seenDb) === 'local') {
          markSeen(seenDb, wrap.id);
          debug('Reply transport is local; ignoring incoming Nostr message.');

          redrawPrompt?.();

          return;
        }

        markSeen(seenDb, wrap.id);
        await handleUserMessage(content, 'nostr');
      } catch (err) {
        debug('Unwrap failed (not for us or wrong format):', err);
      }
    },
    onclose(reasons) {
      debug('Subscription closed:', reasons);
    },
  });
}

main();
