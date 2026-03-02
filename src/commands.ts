// ---------------------------------------------------------------------------
// commands.ts — ! command handler
// ---------------------------------------------------------------------------

import type { AgentBackend } from './backends/types';
import {
  getStatusLines,
  handleBackend,
  getHelpText,
  handleLocal,
  handleRemote,
  handleWorkspace,
  handleMode,
  handleModel,
  handleModels,
} from './commands/bot';
import {
  handleProviderBalance,
  handleProviderBudget,
  handleProviderDeposit,
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
import type { SeenDb } from './db';
import { ProviderNameSchema, getRoutstrBudget, getWalletDefaultMintUrl } from './db';
import type { BotConfig } from './env';
import type { ProviderDb } from './providers/db';
import { decodeToken } from './wallets/cashu';
import { getBalanceByMint, type WalletDb } from './wallets/db';

export const EXIT_COMMAND_SENTINEL = '__DM_BOT_EXIT__';

async function handleError(fn: () => Promise<string>, errorPrefix: string): Promise<string> {
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
  workspaceRoot: string;
  dmBotRoot: string;
  agentEnv: Record<string, string | undefined>;
  attachUrl: string | null;
  backend: AgentBackend;
  seenDb: SeenDb;
  walletDb: WalletDb | null;
  providerDb: ProviderDb | null;
  config: BotConfig;
};

export async function handleBangCommand({
  input,
  relayUrls,
  seenDb,
  providerDb,
  version,
  workspaceRoot,
  dmBotRoot,
  agentEnv,
  attachUrl,
  backend,
  walletDb,
  config,
}: HandleBangCommandProps): Promise<string | null> {
  const raw = input.trim();

  if (!raw.startsWith('!')) {
    return null;
  }

  const rest = raw.slice(1).trim();
  const parts = rest.split(/\s+/);
  const cmd = (parts[0] ?? '').toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case 'new-session': {
      return handleError(
        async () => handleNewSession({ db: seenDb, backend, workspaceRoot, dmBotRoot, agentEnv }),
        'Failed to create new session',
      );
    }

    case 'resume-last-session': {
      return handleError(
        async () => handleResumeLastSession({ db: seenDb, backend }),
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
      return handleError(async () => handleListSessions({ db: seenDb }), 'Failed to list sessions');
    }

    case 'show-last-messages': {
      const n = Math.min(50, Math.max(1, parseInt(args[1] ?? '5', 10) || 5));

      return handleError(
        async () => handleShowLastMessages({ db: seenDb, sessionId: args[0], n }),
        'Failed to show last messages',
      );
    }

    case 'status': {
      return handleError(
        async () => getStatusLines({ relayUrls, db: seenDb, version, dmBotRoot, attachUrl }),
        'Failed to get status',
      );
    }

    case 'version':
      return `Version: ${version}`;

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
      return handleError(
        async () =>
          handleWorkspace({
            db: seenDb,
            backend,
            workspaceRoot,
            dmBotRoot,
            agentEnv,
            selected: args[0],
          }),
        'Failed to switch workspace',
      );
    }

    case 'backend': {
      return handleError(
        async () =>
          handleBackend({
            db: seenDb,
            workspaceRoot,
            dmBotRoot,
            agentEnv,
            attachUrl,
            selected: args[0],
          }),
        'Failed to switch backend',
      );
    }

    case 'mode':
    case 'ask':
    case 'plan':
    case 'agent': {
      const modeArg = cmd === 'mode' ? (args[0] ?? '').toLowerCase() : cmd;

      return handleError(async () => handleMode({ db: seenDb, modeArg }), 'Failed to set mode');
    }

    case 'model': {
      return handleError(
        async () => handleModel({ db: seenDb, selected: args[0] }),
        'Failed to set model',
      );
    }

    case 'models': {
      return handleError(
        async () => handleModels({ db: seenDb, dmBotRoot, attachUrl }),
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

        return handleError(async () => handleWalletMints({ walletDb }), 'Failed to list mints');
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

          return handleError(async () => decodeToken(token), 'Failed to decode token');
        }

        case 'receive': {
          if (!walletDb) {
            return 'Wallet DB not available.';
          }

          if (!mnemonic) {
            return 'No mnemonic configured. Set one with: npm run wallet:setup';
          }

          if (!mint) {
            return 'No mint configured. Set one with: !wallet mint <url>';
          }

          const token = args[1];

          if (!token) {
            return 'Usage: !wallet receive <cashu-token>';
          }

          return handleError(
            async () => handleWalletReceive({ mnemonic, walletDb, mintUrl: mint, token }),
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
            return 'No mnemonic configured. Set one with: npm run wallet:setup';
          }

          if (!mint) {
            return 'No mint configured. Set one with: !wallet mint <url>';
          }

          return handleError(
            async () => handleWalletSend({ mnemonic, walletDb, amount, mintUrl: mint }),
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

      switch (subcmd) {
        case 'set': {
          const name = args[1]?.toLowerCase();

          return handleProviderSet({ seenDb, name });
        }

        case 'deposit': {
          const sats = parseInt(args[1], 10);

          if (isNaN(sats) || sats <= 0) {
            return 'Usage: !provider deposit <sats>';
          }

          const mintUrl = getWalletDefaultMintUrl(seenDb, config.cashuDefaultMintUrl);

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
              }),
            'Failed to deposit',
          );
        }

        case 'refund': {
          const mintUrl = getWalletDefaultMintUrl(seenDb, config.cashuDefaultMintUrl);

          if (!mintUrl) {
            return 'No mint configured.';
          }

          const mnemonic = config.cashuMnemonic;

          if (!mnemonic) {
            return 'No mnemonic configured. Set one with: npm run wallet:setup';
          }

          if (!providerDb) {
            return 'Provider DB not available.';
          }

          return handleError(
            async () => handleProviderRefund({ seenDb, mnemonic, mintUrl, providerDb }),
            'Failed to refund',
          );
        }

        case 'balance': {
          return handleError(async () => handleProviderBalance(seenDb), 'Failed to get balance');
        }

        case 'budget': {
          const budget = parseInt(args[1], 10);

          if (isNaN(budget) || budget <= 0) {
            return `Current budget: ${getRoutstrBudget(seenDb)} sats.\nUsage: !provider budget <sats>`;
          }

          return handleError(
            async () => handleProviderBudget(seenDb, budget),
            'Failed to set budget',
          );
        }

        case 'status': {
          const mintUrl = getWalletDefaultMintUrl(seenDb, config.cashuDefaultMintUrl);

          if (!mintUrl) {
            return 'No mint configured. Use !wallet mint <url> first.';
          }

          return handleError(
            async () => handleProviderStatus({ seenDb, mintUrl }),
            'Failed to get status',
          );
        }

        case 'sync-models': {
          return handleError(async () => handleProviderSyncModels(seenDb), 'Failed to sync models');
        }

        default:
          return `Usage: !provider set [${ProviderNameSchema.options.join('|')}] | !provider deposit <sats> | !provider refund | !provider balance | !provider budget <sats> | !provider status | !provider sync-models`;
      }
    }

    case 'exit':
      return EXIT_COMMAND_SENTINEL;

    default:
      return `Unknown command: !${cmd}. Use !help for commands.`;
  }
}
