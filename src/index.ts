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
 *   BOT_LOCAL_CLI           - Set to 0 to disable local terminal input (default: 1)
 *   BOT_AGENT_PATH          - Override PATH for locating agent binaries
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
import { parseBudgetAnnotation } from './budget-annotation';
import { handleBangCommand, EXIT_COMMAND_SENTINEL } from './commands';
import { getStatusLines } from './commands/bot';
import {
  openSeenDb,
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
  getRoutstrModel,
  getRoutstrSkKey,
} from './db';
import { loadBotConfig } from './env';
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
import { createProvider } from './providers/factory';
import { depositOrTopup, refundRoutstr, NoRoutstrSessionError } from './providers/routstr';
import { getOrCreateCurrentSession, insertSessionMessage } from './session';
import { openWalletDb } from './wallets/db';
import { InsufficientFundsError } from './wallets/types';

const POST_AGENT_LINT_PROMPT_PREFIX = '[Post-edit lint feedback]';

type MessageSource = 'nostr' | 'local';

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
    localCliEnabled,
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

  const seenDb = openSeenDb();
  const providerDb = asProviderDb(seenDb);
  const walletDb = cashuMnemonic ? openWalletDb(cashuMnemonic) : null;

  function getActiveProvider() {
    return createProvider({
      name: getProviderName(seenDb),
      walletDb,
      seenDb,
      routstrBaseUrl,
    });
  }

  const providerName = getProviderName(seenDb);

  if (providerName === 'routstr') {
    log.info(`Provider: routstr (budget: ${getRoutstrBudget(seenDb)} sats)`);
  } else {
    log.info('Provider: local (no payment)');
  }

  const workspaceRoot = join(dmBotRoot, '..');

  const agentEnv: Record<string, string | undefined> = {
    ...process.env,
    PATH: agentPath,
  };

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
    db: seenDb,
    version: VERSION,
    dmBotRoot,
    attachUrl: opencodeServeUrl,
  });

  for (const line of statusLines) {
    log.info(line);
  }

  log.sep();

  const pwdOutput =
    spawnSync(['pwd'], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim() ?? '(failed)';

  debug('PWD:', pwdOutput);

  const readyDmPromise = sendDm({
    pool,
    botRelayUrl: primaryRelay,
    senderSecretKey: botSecretKey,
    recipientPubkey: masterPubkey,
    message: `Agent is ready.`,
    signAuthEvent,
    redrawPrompt,
  }).catch((err) => log.error(`Failed to send ready DM: ${String(err)}`));

  const dmFilter = {
    kinds: [1059] as number[],
    '#p': [botPubkey],
    since: Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60,
  };

  debug('Subscription filter:', JSON.stringify(dmFilter));

  async function sendReplyForSource(source: MessageSource, message: string): Promise<void> {
    const replyTransport = getReplyTransport(seenDb);
    const shouldBypassNostr = source === 'local' || replyTransport === 'local';

    if (shouldBypassNostr) {
      log.info(`${C.white}[bot]${C.reset}\n${message}`);

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

  const defaultModelOverride = getModelOverride(seenDb);
  const defaultBackend = getAgentBackend(seenDb);
  const mode = getDefaultMode(seenDb);

  const backend = createBackend({
    name: defaultBackend,
    dmBotRoot,
    mode,
    attachUrl: opencodeServeUrl,
    modelOverride: defaultModelOverride,
  });

  async function handleUserMessage(content: string, source: MessageSource): Promise<void> {
    const sourceLabel =
      source === 'local' ? `${C.white}local${C.reset}` : `${C.magenta}master${C.reset}`;

    const isLocal = source === 'local' || getReplyTransport(seenDb) === 'local';
    log.sep();
    log.info(`[${sourceLabel}] ${content}`);
    log.sep();

    if (content.trim().startsWith('!')) {
      const reply = await handleBangCommand({
        input: content,
        relayUrls,
        seenDb,
        version: VERSION,
        workspaceRoot,
        dmBotRoot,
        agentEnv,
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
        log.info(`${C.white}[bot]${C.reset}\n${C.dim}Command applied.${C.reset}`);
      }

      return;
    }

    const mode = getDefaultMode(seenDb);
    const currentWorkspace = getWorkspaceTarget(seenDb);
    const cwd = currentWorkspace === 'bot' ? dmBotRoot : workspaceRoot;

    const sessionId = getOrCreateCurrentSession({
      db: seenDb,
      backend,
      cwd,
      env: agentEnv,
    });

    insertSessionMessage(seenDb, sessionId, 'user', content);

    const { prompt: effectiveContent, budgetSats: inlineBudget } = parseBudgetAnnotation(content);
    const isAutoFlow = inlineBudget !== null && getProviderName(seenDb) === 'routstr';

    const provider = getActiveProvider();

    if (isAutoFlow) {
      if (!walletDb) {
        await sendReplyForSource(
          source,
          'Wallet not available. Run `npm run wallet:setup` to configure your wallet.',
        );

        return;
      }

      try {
        const mintUrl = getWalletDefaultMintUrl(seenDb, config.cashuDefaultMintUrl);

        if (!mintUrl) {
          await sendReplyForSource(source, 'No mint configured. Use !wallet mint <url> first.');

          return;
        }

        const mnemonic = config.cashuMnemonic;

        if (!mnemonic) {
          await sendReplyForSource(source, 'No mnemonic configured. Set one with: !wallet setup');

          return;
        }

        const { wasNew } = await depositOrTopup({
          mnemonic,
          seenDb,
          walletDb,
          providerDb,
          mintUrl,
          amountSats: inlineBudget,
        });

        log.warn(
          `Auto-flow: ${wasNew ? 'created session' : 'topped up'} with ${inlineBudget} sats`,
        );
      } catch (err) {
        if (err instanceof InsufficientFundsError) {
          await sendReplyForSource(
            source,
            `Insufficient local balance: ${err.available} sats available, ${err.required} needed.\nTop up with: !wallet receive <token>`,
          );
        } else {
          await sendReplyForSource(source, `Deposit failed: ${String(err)}`);
        }

        return;
      }
    }

    try {
      await provider.prepareRun({
        budgetSats: inlineBudget ?? getRoutstrBudget(seenDb),
      });
    } catch (e) {
      if (e instanceof NoRoutstrSessionError) {
        await sendReplyForSource(source, e.message);

        return;
      }

      if (e instanceof InsufficientFundsError) {
        await sendReplyForSource(
          source,
          `Wallet balance too low. Have ${e.available} sats, need ${e.required} sats. Top up with: !wallet receive <cashuXXX>`,
        );

        return;
      }

      throw e;
    }

    const runAgentRound = async (roundContent: string, startLog: string) => {
      log.info(startLog);

      const modelOverride = getModelOverride(seenDb);
      const backendName = getAgentBackend(seenDb);
      const routstrModel = getRoutstrModel(seenDb);
      const activeProviderName = getProviderName(seenDb);

      const finalModelOverride =
        activeProviderName === 'routstr' && routstrModel
          ? `routstr/${routstrModel}`
          : (modelOverride ?? undefined);

      const roundBackend = createBackend({
        name: backendName,
        dmBotRoot,
        mode,
        attachUrl: opencodeServeUrl,
        modelOverride: finalModelOverride,
      });

      return roundBackend.runMessage({
        sessionId,
        content: roundContent,
        mode,
        cwd,
        env: agentEnv,
        modelOverride: finalModelOverride,
      });
    };

    try {
      const initialResult = await runAgentRound(
        effectiveContent,
        `${C.dim}Starting ${backend.name} agent (${mode})…${C.reset}\n`,
      );

      let finalOutput = initialResult.output;
      let finalResult = initialResult;

      if (mode === 'agent') {
        const lintLabel = currentWorkspace === 'bot' ? 'dm-bot' : 'workspace';
        const lintResult = runPostAgentLint({ cwd, label: lintLabel });

        if (lintResult.available) {
          const lintSummary = formatLintSummary(lintResult);
          finalOutput = `${initialResult.output}\n\n${lintSummary}`;
          const lintFailed = lintResult.exitCode !== 0;

          if (lintFailed) {
            const lintPrompt = `${POST_AGENT_LINT_PROMPT_PREFIX}\n${lintSummary}\n\nFix any lint issues and provide your final summary.`;
            insertSessionMessage(seenDb, sessionId, 'user', lintPrompt);

            try {
              const fixResult = await runAgentRound(
                lintPrompt,
                `${C.dim}Starting ${backend.name} agent (lint feedback)…${C.reset}\n`,
              );

              finalOutput = `${finalOutput}\n\n${fixResult.output}`;
              finalResult = fixResult;
            } catch (lintFollowupErr) {
              log.error(`Lint follow-up agent process error: ${String(lintFollowupErr)}`);
              finalOutput = `${finalOutput}\n\nAutomatic lint-fix round failed: ${String(lintFollowupErr)}`;
            }
          }
        } else {
          log.error(
            `Skipping post-agent lint: npm run lint is unavailable in this runtime for ${lintLabel}.`,
          );
        }
      }

      const isErrorResponse =
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

      const prefix = modePrefix(mode, isLocal);
      const footer = tokenFooter(finalResult, isLocal);
      const fullReply = prefix + finalOutput + footer;
      const chunks = chunkMessage(fullReply);
      const total = chunks.length;
      let delayMs = CHUNK_DELAY_BASE_MS;

      for (let i = 0; i < chunks.length; i++) {
        const hasNextChunk = i < chunks.length - 1;
        const maybeNextPrompt = hasNextChunk && source === 'nostr' ? '\n<CHECK NEXT MESSAGE>' : '';
        const chunkBody = `${chunks[i]}${maybeNextPrompt}`;
        const chunk = total > 1 ? `(${i + 1}/${total}) ${chunkBody}` : chunkBody;

        try {
          await sendReplyForSource(source, chunk);
        } catch (e) {
          const targetLabel = source === 'local' ? 'local output' : 'DM chunk';
          log.error(`Failed to send ${targetLabel}: ${String(e)}`);
        }

        if (hasNextChunk) {
          await sleep(delayMs);
          delayMs = Math.min(delayMs * 2, CHUNK_DELAY_MAX_MS);
        }
      }
    } catch (err) {
      log.error(`${C.red}Agent process error:${C.reset} ${String(err)}`);

      sendReplyForSource(source, `<${mode}> Error: ${String(err)}`).catch((e) =>
        log.error(`Failed to send error reply: ${String(e)}`),
      );
    } finally {
      if (isAutoFlow) {
        if (walletDb) {
          const skKey = getRoutstrSkKey(seenDb);
          const mnemonic = config.cashuMnemonic;
          const mintUrl = getWalletDefaultMintUrl(seenDb, config.cashuDefaultMintUrl);

          if (!skKey || !mnemonic || !mintUrl) {
            await sendReplyForSource(
              source,
              'No Routstr session key. Use !provider deposit <sats> first.',
            );
          } else {
            const recovered = await refundRoutstr({
              mnemonic,
              providerDb,
              mintUrl,
              skKey,
            });

            if (recovered > 0) {
              log.warn(`Auto-flow: recovered ${recovered} sats`);
            }
          }
        } else {
          await sendReplyForSource(
            source,
            "Wallet not available. Auto-flow won't run. `npm run wallet:setup` to configure your wallet.",
          );
        }
      }

      const mintUrl = getWalletDefaultMintUrl(seenDb, config.cashuDefaultMintUrl);

      if (!mintUrl) {
        log.error('No mint URL configured. Use !wallet mint <url> first.');
      } else {
        await provider.finalizeRun({
          success: true,
          sessionId,
          promptPrefix: effectiveContent,
          model: backend.modelName,
          mintUrl,
        });
      }
    }
  }

  if (localCliEnabled && process.stdin.isTTY) {
    const startLocalCli = () => {
      log.info(
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
  } else {
    debug('Local terminal chat disabled (BOT_LOCAL_CLI=0 or non-TTY stdin).');
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
