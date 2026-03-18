#!/usr/bin/env bun

// ---------------------------------------------------------------------------
// src/index.ts — Main entry point
// ---------------------------------------------------------------------------

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

import { spawnSync } from 'bun';
import { SimplePool } from 'nostr-tools/pool';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';

import { createBackend } from './backends/factory';
import { startLocalCli } from './cli/local-cli';
import { handleBangCommand, EXIT_COMMAND_SENTINEL } from './commands';
import { getStatusLines } from './commands/bot';
import type { PluginContext } from './core/plugin';
import {
  openCoreDb,
  initSkKeyEncryption,
  getCurrentOrDefaultMode,
  getAgentBackend,
  getModelOverride,
  getProviderName,
  getWorkspaceTarget,
} from './db';
import { createGetAgentEnv, loadBotConfig } from './env';
import { runAgentConversation } from './flow/agent-conversation';
import { C, debug, log } from './logger';
import type { MessageSource } from './messaging';
import {
  createDmSubscription,
  createSendReplyForSource,
  createSignAuthEvent,
  sendDm,
} from './nostr/nip17';
import { dmBotRoot, RESTART_REQUESTED_PATH } from './paths';
import { asProviderDb } from './providers/db';
import { getOrCreateCurrentSession } from './session';
import { openWalletDb } from './wallets/db';

let redrawPrompt: (() => void) | null = null;

async function main() {
  // --- Restart & config ---
  if (existsSync(RESTART_REQUESTED_PATH)) {
    try {
      unlinkSync(RESTART_REQUESTED_PATH);
    } catch {
      // Ignore if file was already removed.
    }
  }

  const config = loadBotConfig();

  // --- Identity & Nostr setup ---
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
    log.error(
      `Bot pubkey mismatch. Expected: ${botPubkeyFromEnv}, Got: ${botPubkey}`,
    );

    process.exit(1);
  }

  initSkKeyEncryption(botKeyHex, botPubkey);

  // --- Databases ---
  const pool = new SimplePool({ enablePing: true, enableReconnect: true });
  const seenDb = openCoreDb();
  const providerDb = asProviderDb(seenDb);
  const walletDb = cashuMnemonic ? openWalletDb(cashuMnemonic) : null;

  const parentOfBotRoot = join(dmBotRoot, '..');

  const agentEnv: Record<string, string | undefined> = {
    ...process.env,
    PATH: agentPath,
  };

  const getAgentEnv = createGetAgentEnv({ baseEnv: agentEnv, seenDb });

  const packageJson = readFileSync(join(dmBotRoot, 'package.json'), 'utf-8');
  const packageJsonData = JSON.parse(packageJson) as { version: string };
  const VERSION = packageJsonData.version;

  const signAuthEvent = createSignAuthEvent({ botSecretKey });

  // --- Startup logging & ready DM ---
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
    spawnSync(['pwd'], { stdout: 'pipe', stderr: 'pipe' })
      .stdout.toString()
      .trim() ?? '(failed)';

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

  // --- Reply transport & job engine ---
  const sendReplyForSource = createSendReplyForSource({
    seenDb,
    pool,
    botRelayUrl: primaryRelay,
    senderSecretKey: botSecretKey,
    recipientPubkey: masterPubkey,
    signAuthEvent,
  });

  // --- Plugins ---
  const pluginContext: PluginContext = {
    runAgent: null, // will set later in the conversation loop
    sendReply: (message: string) => sendReplyForSource('nostr', message),
    env: getAgentEnv(),
    defaults: {
      backend: getAgentBackend(seenDb),
      provider: getProviderName(seenDb),
      model: getModelOverride(seenDb),
      mode: getCurrentOrDefaultMode(seenDb),
      workspace_target: getWorkspaceTarget(seenDb),
    },
  };

  // Register plugins if generated/plugins.ts exists (created by install-plugin script)
  try {
    const { registerPlugins } = await import('../generated/plugins');
    log.info(`Registering plugins from ${join(dmBotRoot, 'plugins')}`);
    registerPlugins(pluginContext);
    log.info('Plugins registered');
  } catch (err) {
    log.error(`Failed to register plugins: ${String(err)}`);
    log.error(`Run 'bun run scripts/install-plugin.ts' to install plugins`);
  }

  // --- Message handler: commands, session, agent run, reply ---
  async function handleUserMessage(
    content: string,
    source: MessageSource,
  ): Promise<void> {
    process.stdout.write(`${C.dim}${C.magenta} > ${content}${C.reset}\n`);

    const mode = getCurrentOrDefaultMode(seenDb);
    const modelOverride = getModelOverride(seenDb);

    const backend = createBackend({
      backendName: getAgentBackend(seenDb),
      dmBotRoot,
      mode,
      attachUrl: opencodeServeUrl,
      modelOverride,
      providerName: getProviderName(seenDb),
    });

    const input = content.trim();

    const agentEnv = getAgentEnv();

    const cwd =
      getWorkspaceTarget(seenDb) === 'bot' ? dmBotRoot : parentOfBotRoot;

    const sessionId = await getOrCreateCurrentSession({
      db: seenDb,
      backend,
      cwd,
      env: agentEnv,
    });

    pluginContext.runAgent = async (prompt: string) =>
      backend.runMessage({
        sessionId,
        content: prompt,
        mode,
        cwd,
        env: agentEnv,
        modelOverride,
      });

    // Commands (!help, !backend, etc.)
    if (input.startsWith('!')) {
      const reply = await handleBangCommand({
        input,
        relayUrls,
        seenDb,
        version: VERSION,
        parentOfBotRoot,
        dmBotRoot,
        agentEnv,
        attachUrl: opencodeServeUrl,
        backend,
        botPubkey,
        walletDb,
        providerDb,
        config,
      });

      if (reply === EXIT_COMMAND_SENTINEL) {
        log.info('Exit command received. Shutting down dm-bot.');

        const ack = 'Shutting down dm-bot.';

        await sendReplyForSource(source, ack);

        log.warn('Exit command received. Shutting down dm-bot.');
        process.exit(0);
      } else if (reply) {
        await sendReplyForSource(source, reply);
      } else {
        log.warn('No command reply. Sending default reply.');

        await sendReplyForSource(
          source,
          'No response (command may need to start with !). Use !help for commands.',
        );
      }

      return;
    }

    await runAgentConversation({
      content,
      source,
      sendReplyForSource,
      backend,
      seenDb,
      dmBotRoot,
      parentOfBotRoot,
      opencodeServeUrl,
      getAgentEnv,
      config,
      walletDb,
      providerDb,
      routstrBaseUrl,
    });
  }

  // --- Start DM subscription and optional local CLI ---
  const startDmSubscription = createDmSubscription({
    pool,
    relayUrls,
    dmFilter,
    signAuthEvent,
    seenDb,
    botSecretKey,
    masterPubkey,
    onMessage: (content) => handleUserMessage(content, 'nostr'),
    redrawPromptRef: { get: () => redrawPrompt },
    reconnectBaseMs: 2_000,
    reconnectMaxMs: 60_000,
  });

  if (process.stdin.isTTY) {
    readyDmPromise.finally(() =>
      startLocalCli({
        onMessage: (input) => handleUserMessage(input, 'local'),
        setRedrawPrompt: (fn) => {
          redrawPrompt = fn;
        },
      }),
    );
  }

  startDmSubscription();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
