// ---------------------------------------------------------------------------
// commands.ts — ! command handler
// ---------------------------------------------------------------------------
import { join } from 'path';

import type { Database } from 'bun:sqlite';

import { createBackend } from './backends/factory';
import type { AgentBackend } from './backends/types';
import {
  AgentModeSchema,
  AgentBackendNameSchema,
  WorkspaceTargetSchema,
  ProviderNameSchema,
  getDefaultMode,
  setDefaultMode,
  getAgentBackend,
  setAgentBackend,
  getReplyTransport,
  setReplyTransport,
  getWorkspaceTarget,
  setWorkspaceTarget,
  getModelOverride,
  setModelOverride,
  getProviderName,
  setProviderName,
  getRoutstrBudget,
  setRoutstrBudget,
  getState,
  STATE_CURRENT_SESSION,
} from './db';
import { C, assertUnreachable } from './logger';
import {
  fetchRoutstrModels,
  patchOpencodeConfig,
  buildRoutstrProviderConfig,
} from './providers/routstr-models';
import type { AnyProvider } from './providers/types';
import { createNewSession, getLatestSession, setCurrentSession } from './session';
import { getRecentSpendHistory } from './wallet-db';
import type { AnyWallet } from './wallets/types';

export const EXIT_COMMAND_SENTINEL = '__DM_BOT_EXIT__';

export type StatusProps = {
  relayUrls: string[];
  db: Database;
  version: string;
  dmBotRoot: string;
  attachUrl: string | null;
};

export function getStatusLines({
  relayUrls,
  db,
  version,
  dmBotRoot,
  attachUrl,
}: StatusProps): string[] {
  const cur = getState(db, STATE_CURRENT_SESSION);
  const mode = getDefaultMode(db);
  const backendName = getAgentBackend(db);
  const replyTransport = getReplyTransport(db);
  const workspace = getWorkspaceTarget(db);
  const serveUrl = process.env.BOT_OPENCODE_SERVE_URL;
  const modelOverride = getModelOverride(db);

  const backend = createBackend({ name: backendName, dmBotRoot, mode, attachUrl, modelOverride });

  const col = 14;
  const lbl = (name: string) => `${C.bold}${(name + ':').padEnd(col)}${C.reset}`;

  const modelDisplay = modelOverride
    ? `${modelOverride} ${C.gray}(override)${C.reset}`
    : backend.modelName;

  const lines = [
    `${lbl('Backend')} ${C.magenta}${backendName}${C.reset}`,
    `${lbl('Version')} ${version}`,
    `${lbl('Mode')} ${mode}`,
    `${lbl('Model')} ${modelDisplay}`,
    `${lbl('Workspace')} ${workspace}`,
    `${lbl('Transport')} ${replyTransport}`,
    `${lbl('Relays')} ${relayUrls.join(', ')}`,
    `${lbl('Session')} ${cur ?? `${C.gray}(none)${C.reset}`}`,
  ];

  if (backendName === 'opencode' && serveUrl) {
    lines.push(`${lbl('Serve')} ${serveUrl} (attached)`);
  }

  return lines;
}

export type HandleBangCommandProps = {
  input: string;
  relayUrls: string[];
  db: Database;
  version: string;
  workspaceRoot: string;
  dmBotRoot: string;
  agentEnv: Record<string, string | undefined>;
  attachUrl: string | null;
  backend: AgentBackend;
  wallet?: AnyWallet;
  walletDb?: Database;
  provider?: AnyProvider;
  routstrBaseUrl?: string;
};

export async function handleBangCommand({
  input,
  relayUrls,
  db,
  version,
  workspaceRoot,
  dmBotRoot,
  agentEnv,
  attachUrl,
  backend,
  wallet,
  walletDb,
  provider,
  routstrBaseUrl,
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
      try {
        const workspace = getWorkspaceTarget(db);
        const cwd = workspace === 'bot' ? dmBotRoot : workspaceRoot;
        const mode = getDefaultMode(db);

        const id = createNewSession({
          db,
          backend,
          cwd,
          env: agentEnv,
        });

        return `New session: ${id}\nBackend: ${backend.name}\nMode: ${mode}\nWorkspace: ${workspace}.`;
      } catch (err) {
        return `Failed to create session: ${String(err)}`;
      }
    }

    case 'resume-last-session': {
      const id = getLatestSession(db, backend);

      if (!id) {
        return `No sessions yet for backend '${backend.name}'. Send a message or use !new-session.`;
      }

      setCurrentSession(db, id);

      return `Resumed session ${id}.`;
    }

    case 'resume-session': {
      const id = args[0];

      if (!id) {
        return 'Usage: !resume-session <SESSION-ID>';
      }

      if (!setCurrentSession(db, id)) {
        return 'Session not found.';
      }

      return `Resumed session ${id}.`;
    }

    case 'list-sessions': {
      const rows = db
        .prepare('SELECT id, created_at, backend FROM sessions ORDER BY created_at DESC')
        .all() as { id: string; created_at: number; backend: string }[];

      if (rows.length === 0) {
        return 'No sessions yet.';
      }

      const cur = getState(db, STATE_CURRENT_SESSION);

      return rows
        .map((r) => {
          const date = new Date(r.created_at * 1000).toISOString();
          const mark = r.id === cur ? ' (current)' : '';

          return `[${r.backend ?? 'cursor'}] ${r.id} ${date}${mark}`;
        })
        .join('\n');
    }

    case 'show-last-messages': {
      const sessionId = args[0];
      const n = Math.min(50, Math.max(1, parseInt(args[1] ?? '5', 10) || 5));

      if (!sessionId) {
        return 'Usage: !show-last-messages <SESSION-ID> [N]';
      }

      const rows = db
        .prepare(
          'SELECT role, content FROM session_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
        )
        .all(sessionId, n) as { role: string; content: string }[];

      if (rows.length === 0) {
        return 'No messages for that session.';
      }

      return rows
        .reverse()
        .map((r) => `${r.role}: ${r.content.slice(0, 500)}${r.content.length > 500 ? '…' : ''}`)
        .join('\n\n');
    }

    case 'status': {
      return getStatusLines({ relayUrls, db, version, dmBotRoot, attachUrl }).join('\n');
    }

    case 'version':
      return `Version: ${version}`;

    case 'help':
      return `Commands (prefix with !):
!new-session — create a new agent session
!resume-last-session — resume the latest session for the current backend
!resume-session <id> — resume a specific session (any backend)
!list-sessions — list all sessions (all backends)
!show-last-messages <id> [N] — last N messages (default 5)
!status — bot status and current session/mode/backend
!version — show git hash (dm-bot project)
!help — this message
!local — reply only in local terminal
!remote — resume sending replies over Nostr DMs
!workspace [parent|bot] — show/set workspace target
!backend [cursor|opencode] — show/set agent backend (resets model override)
!models — list available models for current backend
!model [name|reset] — show/set model override (cleared on !backend)
!mode ask | !mode plan | !mode agent | !ask | !plan | !agent — set mode
!wallet balance — show Cashu wallet balance
!wallet receive <token> — receive a Cashu token
!wallet history — show recent spend history
!provider set [local|routstr] — set payment provider
!provider budget <sats> — set per-run budget
!provider status — show provider status
!provider sync-models — sync models from Routstr
!exit — stop the bot process`;

    case 'local': {
      setReplyTransport(db, 'local');

      return 'Reply transport switched to local.';
    }

    case 'remote': {
      setReplyTransport(db, 'remote');

      return 'Reply transport switched to remote.';
    }

    case 'workspace': {
      const selected = (args[0] ?? '').toLowerCase();

      if (!selected) {
        return `Workspace: ${getWorkspaceTarget(db)}.`;
      }

      const parsed = WorkspaceTargetSchema.safeParse(selected);

      if (!parsed.success) {
        return `Usage: !workspace [${WorkspaceTargetSchema.options.join('|')}]`;
      }

      const nextTarget = parsed.data;
      const prevTarget = getWorkspaceTarget(db);

      if (nextTarget === prevTarget) {
        return `Workspace unchanged: ${nextTarget}.`;
      }

      setWorkspaceTarget(db, nextTarget);
      const cwd = nextTarget === 'bot' ? dmBotRoot : workspaceRoot;
      try {
        const sessionId = createNewSession({
          db,
          backend,
          cwd,
          env: agentEnv,
        });

        return `Workspace switched: ${prevTarget} -> ${nextTarget}\nNew session: ${sessionId}`;
      } catch (err) {
        return `Workspace switched to ${nextTarget}, but failed to auto-create session: ${String(err)}`;
      }
    }

    case 'backend': {
      const selected = (args[0] ?? '').toLowerCase();

      if (!selected) {
        return `Backend: ${getAgentBackend(db)}.`;
      }

      const parsed = AgentBackendNameSchema.safeParse(selected);

      if (!parsed.success) {
        return `Usage: !backend [${AgentBackendNameSchema.options.join('|')}]`;
      }

      const nextBackendName = parsed.data;
      const prevBackendName = getAgentBackend(db);

      if (nextBackendName === prevBackendName) {
        return `Backend unchanged: ${nextBackendName}.`;
      }

      setAgentBackend(db, nextBackendName);
      setModelOverride(db, null);
      const workspace = getWorkspaceTarget(db);
      const cwd = workspace === 'bot' ? dmBotRoot : workspaceRoot;
      const mode = getDefaultMode(db);
      const modelOverride = getModelOverride(db);

      const newBackend = createBackend({
        name: nextBackendName,
        dmBotRoot,
        mode,
        attachUrl,
        modelOverride,
      });

      try {
        const sessionId = createNewSession({
          db,
          backend: newBackend,
          cwd,
          env: agentEnv,
        });

        return `Backend switched: ${prevBackendName} -> ${nextBackendName}\nNew session: ${sessionId}`;
      } catch (err) {
        return `Backend switched to ${nextBackendName}, but failed to auto-create session: ${String(err)}`;
      }
    }

    case 'mode':
    case 'ask':
    case 'plan':
    case 'agent': {
      const modeArg = cmd === 'mode' ? (args[0] ?? '').toLowerCase() : cmd;
      const parsed = AgentModeSchema.safeParse(modeArg);

      if (!parsed.success) {
        return `Unknown mode: ${modeArg}. Possible values: ${AgentModeSchema.options.join(', ')}`;
      }

      const mode = parsed.data;
      switch (mode) {
        case 'free':
        case 'ask':
        case 'plan':
        case 'agent':
          setDefaultMode(db, mode);

          return `Mode set to: ${mode}`;
        default:
          return assertUnreachable(mode);
      }
    }

    case 'model': {
      const selected = args[0];

      if (!selected) {
        const current = getModelOverride(db);

        return `Model: ${current ?? 'auto (from backend config)'}.`;
      }

      if (selected.toLowerCase() === 'reset') {
        setModelOverride(db, null);

        return 'Model override cleared. Using backend config.';
      }

      setModelOverride(db, selected);

      return `Model override set to: ${selected}.`;
    }

    case 'models': {
      try {
        const backendName = getAgentBackend(db);
        const mode = getDefaultMode(db);
        const backend = createBackend({ name: backendName, dmBotRoot, mode, attachUrl });
        const models = await backend.availableModels();

        if (models.length === 0) {
          return `No models found for backend '${backendName}'.`;
        }

        const current = getModelOverride(db) ?? backend.modelName;

        const lines = models.map((m) => {
          const marker = m === current ? ` ${C.green}*[current]${C.reset}` : '';

          return `  ${m}${marker}`;
        });

        return `Available models for ${backendName}:\n${lines.join('\n')}`;
      } catch (err) {
        return `Failed to get models: ${String(err)}`;
      }
    }

    case 'wallet': {
      const subcmd = args[0]?.toLowerCase();

      if (!wallet || !walletDb) {
        return 'Wallet not configured. Set CASHU_MNEMONIC environment variable.';
      }

      switch (subcmd) {
        case 'balance': {
          const info = await wallet.getInfo();

          return `Wallet balance: ${info.balanceSats} sats`;
        }

        case 'receive': {
          const token = args[1];

          if (!token) {
            return 'Usage: !wallet receive <cashu-token>';
          }

          try {
            const { receivedSats } = await wallet.receiveToken(token);

            return `Received ${receivedSats} sats.`;
          } catch (err) {
            return `Failed to receive token: ${String(err)}`;
          }
        }

        case 'history': {
          const history = getRecentSpendHistory(walletDb, 10);

          if (history.length === 0) {
            return 'No spend history yet.';
          }

          return history
            .map((h) => {
              const date = new Date(h.ts).toISOString().slice(0, 10);

              return `${date} | ${h.provider} | spent: ${h.spent_sats} | budget: ${h.budget_sats} | refund: ${h.refund_sats}`;
            })
            .join('\n');
        }

        default:
          return 'Usage: !wallet balance | !wallet receive <token> | !wallet history';
      }
    }

    case 'provider': {
      const subcmd = args[0]?.toLowerCase();

      switch (subcmd) {
        case 'set': {
          const name = args[1]?.toLowerCase();

          if (!name) {
            return `Usage: !provider set [${ProviderNameSchema.options.join('|')}]`;
          }

          const parsed = ProviderNameSchema.safeParse(name);

          if (!parsed.success) {
            return `Invalid provider: ${name}. Use: ${ProviderNameSchema.options.join(', ')}`;
          }

          setProviderName(db, parsed.data);

          return `Provider set to: ${parsed.data}`;
        }

        case 'budget': {
          const budget = parseInt(args[1], 10);

          if (isNaN(budget) || budget <= 0) {
            return `Current budget: ${getRoutstrBudget(db)} sats.\nUsage: !provider budget <sats>`;
          }

          setRoutstrBudget(db, budget);

          return `Budget set to: ${budget} sats`;
        }

        case 'status': {
          if (provider) {
            const status = await provider.getStatus();

            return status;
          }

          return `Provider: ${getProviderName(db)} (local)`;
        }

        case 'sync-models': {
          if (!routstrBaseUrl) {
            return 'Routstr not configured. Set ROUTSTR_BASE_URL environment variable.';
          }

          try {
            const models = await fetchRoutstrModels(routstrBaseUrl);
            const config = buildRoutstrProviderConfig(models);
            const opencodePath = join(dmBotRoot, 'opencode.json');
            patchOpencodeConfig(opencodePath, config);

            return `Synced ${models.length} models to opencode.json`;
          } catch (err) {
            return `Failed to sync models: ${String(err)}`;
          }
        }

        default:
          return `Usage: !provider set [local|routstr] | !provider budget <sats> | !provider status | !provider sync-models`;
      }
    }

    case 'exit':
      return EXIT_COMMAND_SENTINEL;

    default:
      return `Unknown command: !${cmd}. Use !help for commands.`;
  }
}
