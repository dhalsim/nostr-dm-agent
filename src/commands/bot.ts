import { createBackend } from '../backends/factory';
import type { AgentBackend } from '../backends/types';
import type { SeenDb } from '../db';
import {
  AgentBackendNameSchema,
  AgentModeSchema,
  ProviderNameSchema,
  WorkspaceTargetSchema,
  getAgentBackend,
  getDefaultMode,
  getModelOverride,
  getReplyTransport,
  getWorkspaceTarget,
  setAgentBackend,
  setDefaultMode,
  setModelOverride,
  setReplyTransport,
  setWorkspaceTarget,
  getState,
  STATE_CURRENT_SESSION,
} from '../db';
import { C, assertUnreachable } from '../logger';
import { createNewSession } from '../session';

export type StatusProps = {
  relayUrls: string[];
  db: SeenDb;
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
}: StatusProps): string {
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

  return lines.join('\n');
}

export function handleLocal({ db }: { db: SeenDb }): string {
  setReplyTransport(db, 'local');

  return 'Reply transport switched to local.';
}

export function handleRemote({ db }: { db: SeenDb }): string {
  setReplyTransport(db, 'remote');

  return 'Reply transport switched to remote.';
}

export type HandleWorkspaceProps = {
  db: SeenDb;
  backend: AgentBackend;
  workspaceRoot: string;
  dmBotRoot: string;
  agentEnv: Record<string, string | undefined>;
  selected?: string;
};

export function handleWorkspace({
  db,
  backend,
  workspaceRoot,
  dmBotRoot,
  agentEnv,
  selected,
}: HandleWorkspaceProps): string {
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

export type HandleBackendProps = {
  db: SeenDb;
  dmBotRoot: string;
  attachUrl: string | null;
  agentEnv: Record<string, string | undefined>;
  workspaceRoot: string;
  selected?: string;
};

export function handleBackend({
  db,
  dmBotRoot,
  attachUrl,
  agentEnv,
  workspaceRoot,
  selected,
}: HandleBackendProps): string {
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

export function handleMode({ db, modeArg }: { db: SeenDb; modeArg: string }): string {
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

export function handleModel({ db, selected }: { db: SeenDb; selected?: string }): string {
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

export type HandleModelsProps = {
  db: SeenDb;
  dmBotRoot: string;
  attachUrl: string | null;
};

export async function handleModels({
  db,
  dmBotRoot,
  attachUrl,
}: HandleModelsProps): Promise<string> {
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
}

export function handleVersion({ version }: { version: string }): string {
  return `Version: ${version}`;
}

export function getHelpText(): string {
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
!provider set [${ProviderNameSchema.options.join('|')}] — set payment provider
!provider budget <sats> — set per-run budget
!provider status — show provider status
!provider sync-models — sync models from Routstr
!exit — stop the bot process`;
}
