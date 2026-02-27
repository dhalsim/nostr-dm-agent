// ---------------------------------------------------------------------------
// commands.ts — ! command handler
// ---------------------------------------------------------------------------
import type { Database } from 'bun:sqlite';

import { createBackend } from './backends/factory';
import {
  AgentModeSchema,
  AgentBackendNameSchema,
  WorkspaceTargetSchema,
  getDefaultMode,
  setDefaultMode,
  getAgentBackend,
  setAgentBackend,
  getReplyTransport,
  setReplyTransport,
  getWorkspaceTarget,
  setWorkspaceTarget,
  getState,
  STATE_CURRENT_SESSION,
} from './db';
import { C, assertUnreachable } from './logger';
import { createNewSession, getLatestSession, setCurrentSession } from './session';

export const EXIT_COMMAND_SENTINEL = '__DM_BOT_EXIT__';

export type HandleBangCommandProps = {
  input: string;
  relayUrls: string[];
  db: Database;
  version: string;
  workspaceRoot: string;
  dmBotRoot: string;
  agentEnv: Record<string, string | undefined>;
  attachUrl: string | null;
};

export function handleBangCommand({
  input,
  relayUrls,
  db,
  version,
  workspaceRoot,
  dmBotRoot,
  agentEnv,
  attachUrl,
}: HandleBangCommandProps): string | null {
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
        const backendName = getAgentBackend(db);
        const workspace = getWorkspaceTarget(db);
        const cwd = workspace === 'bot' ? dmBotRoot : workspaceRoot;
        const mode = getDefaultMode(db);

        const id = createNewSession({
          db,
          backendName,
          cwd,
          dmBotRoot,
          env: agentEnv,
          mode,
          attachUrl,
        });

        return `New session: ${id}\nBackend: ${backendName}\nMode: ${mode}\nWorkspace: ${workspace}.`;
      } catch (err) {
        return `Failed to create session: ${String(err)}`;
      }
    }

    case 'resume-last-session': {
      const backendName = getAgentBackend(db);
      const id = getLatestSession(db, backendName);

      if (!id) {
        return `No sessions yet for backend '${backendName}'. Send a message or use !new-session.`;
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
      const cur = getState(db, STATE_CURRENT_SESSION);
      const mode = getDefaultMode(db);
      const backendName = getAgentBackend(db);
      const replyTransport = getReplyTransport(db);
      const workspace = getWorkspaceTarget(db);
      const serveUrl = process.env.BOT_OPENCODE_SERVE_URL;
      const backend = createBackend({ name: backendName, dmBotRoot, mode, attachUrl });
      const col = 14;
      const lbl = (name: string) => `${C.bold}${(name + ':').padEnd(col)}${C.reset}`;

      const lines = [
        `${lbl('Backend')} ${C.magenta}${backendName}${C.reset}`,
        `${lbl('Model')} ${backend.modelName}`,
        `${lbl('Version')} ${version}`,
        `${lbl('Relays')} ${relayUrls.join(', ')}`,
        `${lbl('Mode')} ${mode}`,
        `${lbl('Workspace')} ${workspace}`,
        `${lbl('Transport')} ${replyTransport}`,
        `${lbl('Session')} ${cur ?? `${C.gray}(none)${C.reset}`}`,
      ];

      if (backendName === 'opencode' && serveUrl) {
        lines.push(`${lbl('Serve')} ${serveUrl} (attached)`);
      }

      return lines.join('\n');
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
!backend [cursor|opencode] — show/set agent backend
!mode ask | !mode plan | !mode agent | !ask | !plan | !agent — set mode
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
          backendName: getAgentBackend(db),
          cwd,
          dmBotRoot,
          env: agentEnv,
          mode: getDefaultMode(db),
          attachUrl,
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

      const nextBackend = parsed.data;
      const prevBackend = getAgentBackend(db);

      if (nextBackend === prevBackend) {
        return `Backend unchanged: ${nextBackend}.`;
      }

      setAgentBackend(db, nextBackend);
      const workspace = getWorkspaceTarget(db);
      const cwd = workspace === 'bot' ? dmBotRoot : workspaceRoot;
      try {
        const sessionId = createNewSession({
          db,
          backendName: nextBackend,
          cwd,
          dmBotRoot,
          env: agentEnv,
          mode: getDefaultMode(db),
          attachUrl,
        });

        return `Backend switched: ${prevBackend} -> ${nextBackend}\nNew session: ${sessionId}`;
      } catch (err) {
        return `Backend switched to ${nextBackend}, but failed to auto-create session: ${String(err)}`;
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

    case 'exit':
      return EXIT_COMMAND_SENTINEL;

    default:
      return `Unknown command: !${cmd}. Use !help for commands.`;
  }
}
