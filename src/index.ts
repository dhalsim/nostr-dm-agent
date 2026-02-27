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
 *
 * Restart: when using watch, touch restart.requested in this directory to restart the bot.
 */

import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import readline from 'readline';

import { spawnSync } from 'bun';
import type { NostrEvent, EventTemplate, VerifiedEvent } from 'nostr-tools/core';
import { unwrapEvent } from 'nostr-tools/nip17';
import { SimplePool } from 'nostr-tools/pool';
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';

import { createBackend } from './backends/factory';
import { handleBangCommand, EXIT_COMMAND_SENTINEL } from './commands';
import {
  openSeenDb,
  alreadyHaveEvent,
  markSeen,
  getDefaultMode,
  getAgentBackend,
  getReplyTransport,
  getWorkspaceTarget,
  getState,
  STATE_CURRENT_SESSION,
} from './db';
import { loadBotConfig } from './env';
import { runPostAgentLint, formatLintSummary } from './lint';
import { C, debug, log, logError } from './logger';
import {
  sleep,
  chunkMessage,
  modePrefix,
  tokenFooter,
  sendDm,
  CHUNK_DELAY_BASE_MS,
  CHUNK_DELAY_MAX_MS,
} from './messaging';
import { getOrCreateCurrentSession, insertSessionMessage } from './session';

export const RESTART_REQUESTED_PATH = join(import.meta.dir ?? process.cwd(), 'restart.requested');
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
  } = config;

  const primaryRelay = relayUrls[0];

  const botSecretKey = hexToBytes(botKeyHex);
  const botPubkey = botPubkeyFromEnv ?? getPublicKey(botSecretKey);

  if (botPubkeyFromEnv && botPubkey !== botPubkeyFromEnv) {
    logError('Bot pubkey mismatch. Expected:', botPubkeyFromEnv, 'Got:', botPubkey);
    process.exit(1);
  }

  const pool = new SimplePool({ enablePing: true, enableReconnect: true });

  const seenDb = openSeenDb();

  const dmBotRoot = import.meta.dir ?? process.cwd();
  const workspaceRoot = join(dmBotRoot, '..');

  const agentEnv: Record<string, string | undefined> = {
    ...process.env,
    PATH: agentPath,
  };

  const versionProc = spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: workspaceRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const VERSION = versionProc.stdout?.toString().trim() ?? 'unknown';

  const signAuthEvent = async (authTemplate: EventTemplate): Promise<VerifiedEvent> => {
    debug('Signing AUTH challenge event:', authTemplate);

    return finalizeEvent(authTemplate, botSecretKey);
  };

  const defaultMode = getDefaultMode(seenDb);
  const defaultBackend = getAgentBackend(seenDb);
  const defaultReplyTransport = getReplyTransport(seenDb);
  const defaultWorkspace = getWorkspaceTarget(seenDb);

  const backend = createBackend({
    name: defaultBackend,
    dmBotRoot,
    mode: defaultMode,
    attachUrl: opencodeServeUrl,
  });

  const col = 14;
  const label = (name: string): string => `${C.bold}${(name + ':').padEnd(col)}${C.reset}`;
  log(`${label('Bot pubkey')} ${botPubkey}`);
  log(`${label('Master')} ${masterPubkey}`);
  log(`${label('Relays')} ${relayUrls.join(', ')}`);
  log(`${label('Backend')} ${C.magenta}${defaultBackend}${C.reset}`);
  log(`${label('Version')} ${VERSION}`);

  if (defaultBackend === 'opencode' && opencodeServeUrl) {
    log(`${label('Serve')} ${opencodeServeUrl} (attached)`);
  }

  log(`${label('Mode')} ${defaultMode}`);
  log(`${label('Model')} ${backend.modelName}`);
  log(`${label('Workspace')} ${defaultWorkspace}`);
  log(`${label('Transport')} ${defaultReplyTransport}`);
  const startupSessionId = getState(seenDb, STATE_CURRENT_SESSION);

  log(
    `${label('Session')} ${startupSessionId ? `${C.dim}${startupSessionId}${C.reset}` : `${C.gray}(none — first message will create one)${C.reset}`}`,
  );

  log('');

  const pwdOutput =
    spawnSync(['pwd'], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim() ?? '(failed)';

  debug('PWD:', pwdOutput);

  const readyMessage =
    `Agent is ready.\n` +
    `PWD:        ${pwdOutput}\n` +
    `Backend:    ${defaultBackend}\n` +
    `Mode:       ${defaultMode}\n` +
    `Workspace:  ${defaultWorkspace}\n` +
    `Transport:  ${defaultReplyTransport}`;

  const readyDmPromise = sendDm({
    pool,
    botRelayUrl: primaryRelay,
    senderSecretKey: botSecretKey,
    recipientPubkey: masterPubkey,
    message: readyMessage,
    signAuthEvent,
    redrawPrompt,
  }).catch((err) => logError('Failed to send ready DM:', err));

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
      log(`${C.white}[bot]${C.reset} ${message}`);

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
    const sourceLabel =
      source === 'local' ? `${C.white}local${C.reset}` : `${C.magenta}master${C.reset}`;

    const isLocal = source === 'local' || getReplyTransport(seenDb) === 'local';
    log('\n-------------------\n');
    log(`[${sourceLabel}] ${content}`);
    log('');

    if (content.trim().startsWith('!')) {
      const reply = handleBangCommand({
        input: content,
        relayUrls,
        db: seenDb,
        version: VERSION,
        workspaceRoot,
        dmBotRoot,
        agentEnv,
        attachUrl: opencodeServeUrl,
      });

      if (reply === EXIT_COMMAND_SENTINEL) {
        const ack = 'Shutting down dm-bot.';
        await sendReplyForSource(source, ack);
        log('Exit command received. Shutting down dm-bot.');
        process.exit(0);
      } else if (reply) {
        await sendReplyForSource(source, reply);
      } else if (source === 'local') {
        log(`${C.white}[bot]${C.reset} ${C.dim}Command applied.${C.reset}`);
      }

      return;
    }

    const mode = getDefaultMode(seenDb);
    const currentWorkspace = getWorkspaceTarget(seenDb);
    const cwd = currentWorkspace === 'bot' ? dmBotRoot : workspaceRoot;
    const backendName = getAgentBackend(seenDb);

    const sessionId = getOrCreateCurrentSession({
      db: seenDb,
      backendName,
      cwd,
      dmBotRoot,
      env: agentEnv,
      mode,
      attachUrl: opencodeServeUrl,
    });

    insertSessionMessage(seenDb, sessionId, 'user', content);

    const runAgentRound = async (
      roundContent: string,
      startLog: string,
    ): Promise<ReturnType<typeof backend.runMessage>> => {
      log(startLog);

      const roundBackend = createBackend({
        name: backendName,
        dmBotRoot,
        mode,
        attachUrl: opencodeServeUrl,
      });

      return roundBackend.runMessage({
        sessionId,
        content: roundContent,
        mode,
        cwd,
        env: agentEnv,
      });
    };

    try {
      const initialResult = await runAgentRound(
        content,
        `${C.dim}Starting ${backendName} agent (${mode})…${C.reset}\n`,
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
                `${C.dim}Starting ${backendName} agent (lint feedback)…${C.reset}\n`,
              );

              finalOutput = `${finalOutput}\n\n${fixResult.output}`;
              finalResult = fixResult;
            } catch (lintFollowupErr) {
              logError('Lint follow-up agent process error:', lintFollowupErr);
              finalOutput = `${finalOutput}\n\nAutomatic lint-fix round failed: ${String(lintFollowupErr)}`;
            }
          }
        } else {
          logError(
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
        logError(`${C.red}[bot] Error response — not stored in session history.${C.reset}`);
        logError(finalOutput);
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
          logError(`Failed to send ${targetLabel}:`, e);
        }

        if (hasNextChunk) {
          await sleep(delayMs);
          delayMs = Math.min(delayMs * 2, CHUNK_DELAY_MAX_MS);
        }
      }
    } catch (err) {
      logError(`${C.red}Agent process error:${C.reset}`, err);

      sendReplyForSource(source, `<${mode}> Error: ${String(err)}`).catch((e) =>
        logError('Failed to send error reply:', e),
      );
    }
  }

  if (localCliEnabled && process.stdin.isTTY) {
    const startLocalCli = () => {
      log(
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
          .catch((err) => logError('Local CLI message processing failed:', err))
          .finally(() => localCli.prompt());
      });

      localCli.on('close', () => {
        redrawPrompt = null;
        log('Local terminal chat closed. Nostr DM listener continues running.');
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
