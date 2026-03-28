// ---------------------------------------------------------------------------
// src/commands.ts — ! command handler
// ---------------------------------------------------------------------------

import { writeFileSync } from 'fs';
import { join } from 'path';

import { nip19 } from 'nostr-tools';
import type { SimplePool } from 'nostr-tools/pool';

import type { AgentBackend } from './backends/types';
import {
  getStatusLines,
  handleBackend,
  getHelpText,
  handleLocal,
  handleLint,
  handleRemote,
  handleWorkspace,
  handleMode,
  handleModel,
  handleModels,
} from './commands/bot';
import {
  handleProviderAddModel,
  handleProviderBalance,
  handleProviderBudget,
  handleProviderDeposit,
  handleProviderModels,
  handleProviderRefund,
  handleProviderSet,
  handleProviderStatus,
  handleProviderSyncModels,
} from './commands/provider';
import {
  handleListSessions,
  handleNewSession,
  handleResumeLastSession,
  handleResumeSession,
  handleShowLastMessages,
} from './commands/session';
import {
  handleWalletBalance,
  handleWalletHistory,
  handleWalletMint,
  handleWalletMints,
  handleWalletReceive,
  handleWalletSend,
} from './commands/wallet';
import { handleWot } from './commands/wot';
import { dispatchPluginCommand } from './core/registry';
import type { CoreDb } from './db';
import {
  getProviderName,
  getRoutstrBudget,
  getWalletDefaultMintUrl,
  getWorkspaceTarget,
  ProviderNameSchema,
} from './db';
import type { BotConfig } from './env';
import { getEnvFromFile, setEnvInFile } from './env-file';
import { getInfoLogsEnabled, log, setInfoLogsEnabled } from './logger';
import { RESTART_REQUESTED_PATH } from './paths';
import type { ProviderDb } from './providers/db';
import { formatMsats, msats } from './types';
import { decodeToken } from './wallets/cashu';
import { getBalanceByMint, type WalletDb } from './wallets/db';

export const EXIT_COMMAND_SENTINEL = '__DM_BOT_EXIT__';

export async function handleError(
  fn: () => Promise<string>,
  errorPrefix: string,
): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    return `${errorPrefix}: ${String(err)}`;
  }
}

export type HandleBangCommandProps = {
  input: string;
  relayUrls: string[];
  version: string;
  parentOfBotRoot: string;
  dmBotRoot: string;
  agentEnv: Record<string, string | undefined>;
  attachUrl: string | null;
  backend: AgentBackend;
  botPubkey: string | null;
  seenDb: CoreDb;
  pool: SimplePool;
  walletDb: WalletDb | null;
  providerDb: ProviderDb | null;
  config: BotConfig;
};

export async function handleBangCommand({
  input,
  relayUrls,
  pool,
  seenDb,
  providerDb,
  version,
  parentOfBotRoot,
  dmBotRoot,
  agentEnv,
  attachUrl,
  backend,
  botPubkey,
  walletDb,
  config,
}: HandleBangCommandProps): Promise<string | null> {
  if (!input.startsWith('!')) {
    log.warn(`Input does not start with !: ${input}`);

    return null;
  }

  const rest = input.slice(1).trim();
  const parts = rest.split(/\s+/);
  const cmd = (parts[0] ?? '').toLowerCase();
  const args = parts.slice(1);

  const cwd =
    getWorkspaceTarget(seenDb) === 'bot' ? dmBotRoot : parentOfBotRoot;

  switch (cmd) {
    case 'new-session': {
      return handleError(async () => {
        const out = await handleNewSession({
          seenDb,
          backend,
          cwd,
          agentEnv,
        });

        const status = getStatusLines({
          relayUrls,
          seenDb,
          version,
          dmBotRoot,
          attachUrl,
        });

        return `${out}\n\n${status}`;
      }, 'Failed to create new session');
    }

    case 'resume-last-session': {
      return handleError(
        async () =>
          handleResumeLastSession({ db: seenDb, backendName: backend.name }),
        'Failed to resume last session',
      );
    }

    case 'resume-session': {
      return handleError(
        async () => handleResumeSession({ db: seenDb, sessionId: args[0] }),
        'Failed to resume session',
      );
    }

    case 'list-sessions': {
      return handleError(
        async () => handleListSessions({ db: seenDb }),
        'Failed to list sessions',
      );
    }

    case 'show-last-messages': {
      const n = Math.min(50, Math.max(1, parseInt(args[1] ?? '5', 10) || 5));

      return handleError(
        async () =>
          handleShowLastMessages({ db: seenDb, sessionId: args[0], n }),
        'Failed to show last messages',
      );
    }

    case 'status': {
      return handleError(
        async () =>
          getStatusLines({
            relayUrls,
            seenDb: seenDb,
            version,
            dmBotRoot,
            attachUrl,
          }),
        'Failed to get status',
      );
    }

    case 'version':
      return `Version: ${version}`;

    case 'ping':
      return 'pong';

    case 'bot': {
      const sub = args[0]?.toLowerCase();

      if (sub === 'npub') {
        if (!botPubkey) {
          return 'Bot pubkey not available.';
        }

        return handleError(
          async () => nip19.npubEncode(botPubkey),
          'Failed to encode bot pubkey',
        );
      }

      if (sub === 'restart') {
        return handleError(async () => {
          writeFileSync(RESTART_REQUESTED_PATH, '', 'utf-8');

          return 'Restart requested. If running under watch, the bot will restart shortly.';
        }, 'Failed to request restart');
      }

      return 'Usage: !bot npub|restart';
    }

    case 'help':
      return getHelpText();

    case 'local': {
      return handleError(
        async () => handleLocal({ db: seenDb }),
        'Failed to switch to local reply transport',
      );
    }

    case 'remote': {
      return handleError(
        async () => handleRemote({ db: seenDb }),
        'Failed to switch to remote reply transport',
      );
    }

    case 'workspace': {
      return handleError(async () => {
        const out = await handleWorkspace({
          db: seenDb,
          backend,
          dmBotRoot,
          parentOfBotRoot,
          agentEnv,
          selected: args[0],
        });

        const status = getStatusLines({
          relayUrls,
          seenDb,
          version,
          dmBotRoot,
          attachUrl,
        });

        return `${out}\n\n${status}`;
      }, 'Failed to switch workspace');
    }

    case 'backend': {
      return handleError(async () => {
        const out = await handleBackend({
          db: seenDb,
          dmBotRoot,
          parentOfBotRoot,
          agentEnv,
          attachUrl,
          selected: args[0],
        });

        const status = getStatusLines({
          relayUrls,
          seenDb,
          version,
          dmBotRoot,
          attachUrl,
        });

        return `${out}\n\n${status}`;
      }, 'Failed to switch backend');
    }

    case 'mode':
    case 'ask':
    case 'plan':
    case 'agent': {
      const modeArg = cmd === 'mode' ? (args[0] ?? '').toLowerCase() : cmd;

      return handleError(async () => {
        const out = handleMode({ db: seenDb, modeArg });

        const status = getStatusLines({
          relayUrls,
          seenDb,
          version,
          dmBotRoot,
          attachUrl,
        });

        return `${out}\n\n${status}`;
      }, 'Failed to set mode');
    }

    case 'lint': {
      return handleError(
        async () =>
          handleLint({
            db: seenDb,
            args,
            cwd,
          }),
        'Lint command failed',
      );
    }

    case 'model': {
      return handleError(async () => {
        const out = handleModel({ db: seenDb, selected: args[0] });

        const status = getStatusLines({
          relayUrls,
          seenDb,
          version,
          dmBotRoot,
          attachUrl,
        });

        return `${out}\n\n${status}`;
      }, 'Failed to set model');
    }

    case 'models': {
      return handleError(
        async () => handleModels({ seenDb, dmBotRoot, attachUrl }),
        'Failed to list models',
      );
    }

    case 'wallet': {
      const mnemonic = config.cashuMnemonic;
      const defaultMintUrl = config.cashuDefaultMintUrl;

      const subcmd = args[0]?.toLowerCase();

      if (subcmd === 'mint') {
        const url = args[1];

        return handleError(
          async () =>
            handleWalletMint({
              seenDb: seenDb,
              defaultMintUrl,
              url,
            }),
          'Failed to set mint',
        );
      }

      if (subcmd === 'mints') {
        if (!walletDb) {
          return 'Wallet DB not available.';
        }

        return handleError(
          async () => handleWalletMints({ walletDb }),
          'Failed to list mints',
        );
      }

      const mint = getWalletDefaultMintUrl(seenDb, defaultMintUrl);

      switch (subcmd) {
        case 'balance': {
          if (!mint) {
            return 'No mint configured. Set one with: !wallet mint <url>';
          }

          if (!walletDb) {
            return 'Wallet DB not available.';
          }

          return handleError(
            async () => handleWalletBalance({ walletDb, mintUrl: mint }),
            'Failed to get balance',
          );
        }

        case 'decode': {
          const token = args[1];

          if (!token) {
            return 'Usage: !wallet decode <cashu-token>';
          }

          return handleError(
            async () => decodeToken(token),
            'Failed to decode token',
          );
        }

        case 'receive': {
          if (!walletDb) {
            return 'Wallet DB not available.';
          }

          if (!mnemonic) {
            return 'No mnemonic configured. Set one with: bun run wallet:setup';
          }

          if (!mint) {
            return 'No mint configured. Set one with: !wallet mint <url>';
          }

          const token = args[1];

          if (!token) {
            return 'Usage: !wallet receive <cashu-token>';
          }

          return handleError(
            async () =>
              handleWalletReceive({ mnemonic, walletDb, mintUrl: mint, token }),
            'Failed to receive token',
          );
        }

        case 'send': {
          if (!walletDb) {
            return 'Wallet DB not available.';
          }

          const amount = parseInt(args[1], 10);

          if (isNaN(amount) || amount <= 0) {
            return 'Usage: !wallet send <sats>';
          }

          if (!mnemonic) {
            return 'No mnemonic configured. Set one with: bun run wallet:setup';
          }

          if (!mint) {
            return 'No mint configured. Set one with: !wallet mint <url>';
          }

          return handleError(
            async () =>
              handleWalletSend({ mnemonic, walletDb, amount, mintUrl: mint }),
            'Failed to send token',
          );
        }

        case 'history': {
          if (!walletDb) {
            return 'Wallet DB not available.';
          }

          const showToken = args[1] === '--token';

          return handleError(
            async () => handleWalletHistory({ walletDb, showToken }),
            'Failed to get history',
          );
        }

        default:
          return 'Usage: !wallet mint [url] | balance | receive <token> | send <amount> | history [--token]';
      }
    }

    case 'provider': {
      const subcmd = args[0]?.toLowerCase();

      if (!subcmd) {
        const name = getProviderName(seenDb);

        const providerLine =
          name === 'routstr'
            ? `Provider: routstr (budget: ${formatMsats(getRoutstrBudget(seenDb))})`
            : 'Provider: local';

        const usage = `Usage: !provider set [${ProviderNameSchema.options.join('|')}] | !provider deposit <sats> [--new] | !provider refund | !provider balance | !provider budget <sats> | !provider status | !provider models [filter] | !provider sync-models | !provider add-model <id>`;

        return `${providerLine}\n\n${usage}`;
      }

      switch (subcmd) {
        case 'set': {
          const name = args[1]?.toLowerCase();
          const out = handleProviderSet({ seenDb, name });

          const status = getStatusLines({
            relayUrls,
            seenDb,
            version,
            dmBotRoot,
            attachUrl,
          });

          return `${out}\n\n${status}`;
        }

        case 'deposit': {
          const depositArgs = args.slice(1);
          const forceNew = depositArgs.includes('--new');
          const satsArg = depositArgs.find((a) => a !== '--new');
          const sats = parseInt(satsArg ?? '', 10);

          if (isNaN(sats) || sats <= 0) {
            return 'Usage: !provider deposit <sats> [--new]';
          }

          const mintUrl = getWalletDefaultMintUrl(
            seenDb,
            config.cashuDefaultMintUrl,
          );

          if (!mintUrl) {
            return 'No mint configured. Use !wallet mint <url> first.';
          }

          const mnemonic = config.cashuMnemonic;

          if (!mnemonic) {
            return 'CASHU_MNEMONIC not set.';
          }

          if (!providerDb) {
            return 'Provider DB not available.';
          }

          if (!walletDb) {
            return 'Wallet DB not available.';
          }

          const { balanceSats } = await getBalanceByMint(walletDb, mintUrl);

          if (balanceSats < sats) {
            return `Insufficient balance: ${balanceSats} sats available in mint ${mintUrl}.\nTop up with !wallet receive <token> or check !wallet balance`;
          }

          return handleError(
            async () =>
              handleProviderDeposit({
                seenDb,
                walletDb,
                mnemonic,
                providerDb,
                mintUrl,
                amountSats: sats,
                forceNew,
              }),
            'Failed to deposit',
          );
        }

        case 'refund': {
          const mintUrl = getWalletDefaultMintUrl(
            seenDb,
            config.cashuDefaultMintUrl,
          );

          if (!mintUrl) {
            return 'No mint configured.';
          }

          const mnemonic = config.cashuMnemonic;

          if (!mnemonic) {
            return 'No mnemonic configured. Set one with: bun run wallet:setup';
          }

          if (!providerDb) {
            return 'Provider DB not available.';
          }

          return handleError(
            async () =>
              handleProviderRefund({ seenDb, mnemonic, mintUrl, providerDb }),
            'Failed to refund',
          );
        }

        case 'balance': {
          return handleError(
            async () => handleProviderBalance(seenDb),
            'Failed to get balance',
          );
        }

        case 'budget': {
          const budgetMsats = parseInt(args[1], 10);

          if (isNaN(budgetMsats) || budgetMsats <= 0) {
            return `Current budget: ${formatMsats(getRoutstrBudget(seenDb))}.\nUsage: !provider budget <msats>`;
          }

          return handleError(
            async () => handleProviderBudget(seenDb, msats(budgetMsats)),
            'Failed to set budget',
          );
        }

        case 'status': {
          const mintUrl = getWalletDefaultMintUrl(
            seenDb,
            config.cashuDefaultMintUrl,
          );

          if (!mintUrl) {
            return 'No mint configured. Use !wallet mint <url> first.';
          }

          return handleError(
            async () => handleProviderStatus({ seenDb, mintUrl }),
            'Failed to get status',
          );
        }

        case 'models': {
          return handleError(
            async () => handleProviderModels({ seenDb, filter: args[1] }),
            'Failed to list models',
          );
        }

        case 'sync-models': {
          return handleError(
            async () => handleProviderSyncModels(seenDb),
            'Failed to sync models',
          );
        }

        case 'add-model': {
          const modelId = args[1];

          if (!modelId) {
            return 'Usage: !provider add-model <model-id>';
          }

          const openCodeJsonPath = join(dmBotRoot, 'opencode.json');

          return handleError(
            async () =>
              handleProviderAddModel({ seenDb, modelId, openCodeJsonPath }),
            'Failed to add model',
          );
        }

        default:
          return `Usage: !provider set [${ProviderNameSchema.options.join('|')}] | !provider deposit <sats> [--new] | !provider refund | !provider balance | !provider budget <sats> | !provider status | !provider models [filter] | !provider sync-models | !provider add-model <id>`;
      }
    }

    case 'wot': {
      return handleError(
        async () => handleWot({ db: seenDb, pool, config, args }),
        'WoT command failed',
      );
    }

    case 'log': {
      const logSub = args[0]?.toLowerCase();

      if (logSub !== 'info') {
        const current = getInfoLogsEnabled() ? 'on' : 'off';

        return `Usage: !log info [on|off]. Info logs: ${current}.`;
      }

      const logArg = (args[1] ?? '').toLowerCase();

      if (logArg !== 'on' && logArg !== 'off') {
        const current = getInfoLogsEnabled() ? 'on' : 'off';

        return `Info logs: ${current}. Usage: !log info [on|off]`;
      }

      const envPath = join(dmBotRoot, '.env');

      setEnvInFile(envPath, 'INFO_ENABLED', logArg === 'on' ? '1' : '0');
      setInfoLogsEnabled(logArg === 'on');

      return `Info logs: ${logArg}. Written to .env.`;
    }

    case 'ready': {
      const readyArg = (args[0] ?? '').toLowerCase();
      const envPathForReady = join(dmBotRoot, '.env');

      const readyCurrent =
        (getEnvFromFile(envPathForReady, 'READY_ENABLED') ??
          process.env.READY_ENABLED ??
          '1') !== '0'
          ? 'on'
          : 'off';

      if (readyArg !== 'on' && readyArg !== 'off') {
        return `Ready DM on startup: ${readyCurrent}. Usage: !ready [on|off]`;
      }

      setEnvInFile(
        envPathForReady,
        'READY_ENABLED',
        readyArg === 'on' ? '1' : '0',
      );

      return `Ready DM on startup: ${readyArg}. Written to .env. Takes effect on next restart.`;
    }

    case 'exit':
      return EXIT_COMMAND_SENTINEL;

    default: {
      const pluginResult = await dispatchPluginCommand(cmd, args);

      if (pluginResult !== null) {
        return pluginResult;
      }

      return `Unknown command: !${cmd}. Use !help for commands.`;
    }
  }
}
