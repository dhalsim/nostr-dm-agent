import { createBackend } from '../backends/factory';
import type { AgentBackend } from '../backends/types';
import {
  type AgentBackendName,
  type AgentMode,
  type Linting,
  type ProviderName,
  type ReplyTransport,
  type SeenDb,
  type WorkspaceTarget,
  AgentBackendNameSchema,
  AgentModeSchema,
  LintingSchema,
  ProviderNameSchema,
  WorkspaceTargetSchema,
  getAgentBackend,
  getDefaultMode,
  getLinting,
  getModelOverride,
  getProviderName,
  getReplyTransport,
  getRoutstrBudget,
  getWorkspaceTarget,
  setAgentBackend,
  setDefaultMode,
  setLinting,
  setModelOverride,
  setReplyTransport,
  setWorkspaceTarget,
  getState,
  STATE_CURRENT_SESSION,
} from '../db';
import { formatLintSummary, runPostAgentLint } from '../lint';
import { C, assertUnreachable, debug } from '../logger';
import { createNewSession } from '../session';
import { formatMsats } from '../types';

/** Display-only emoji + value for status lines (not stored in DB). */
const STATUS_EMOJI = {
  backend: (v: AgentBackendName) =>
    v === 'cursor' ? '🖱️' : v === 'opencode-sdk' ? '📦 (SDK)' : '📦',
  provider: (v: ProviderName) => (v === 'local' ? '💻' : '🌐'),
  mode: (v: AgentMode) => ({ free: '🆓', ask: '💬', plan: '📋', agent: '🤖' })[v],
  linting: (v: Linting) => (v === 'on' ? '✅' : '❌'),
  workspace: (v: WorkspaceTarget) => (v === 'bot' ? '🤖' : '📁'),
  transport: (v: ReplyTransport) => (v === 'remote' ? '📡' : '💻'),
} as const;

export type StatusProps = {
  relayUrls: string[];
  seenDb: SeenDb;
  version: string;
  dmBotRoot: string;
  attachUrl: string | null;
};

export function getStatusLines({
  relayUrls,
  seenDb,
  version,
  dmBotRoot,
  attachUrl,
}: StatusProps): string {
  const cur = getState(seenDb, STATE_CURRENT_SESSION);
  const mode = getDefaultMode(seenDb);
  const linting = getLinting(seenDb);
  const backendName = getAgentBackend(seenDb);
  const replyTransport = getReplyTransport(seenDb);
  const workspace = getWorkspaceTarget(seenDb);
  const serveUrl = process.env.BOT_OPENCODE_SERVE_URL;
  const modelOverride = getModelOverride(seenDb);
  const providerName = getProviderName(seenDb);

  const backend = createBackend({
    backendName,
    dmBotRoot,
    mode,
    attachUrl,
    modelOverride,
    providerName,
  });

  const col = 14;
  const lbl = (name: string) => `${C.bold}${(name + ':').padEnd(col)}${C.reset}`;

  const modelDisplay = modelOverride
    ? `${modelOverride} ${C.gray}(override)${C.reset}`
    : backend.modelName;

  const providerDisplay =
    providerName === 'routstr'
      ? `${STATUS_EMOJI.provider('routstr')} ${C.magenta}routstr${C.reset} (budget: ${formatMsats(getRoutstrBudget(seenDb))})`
      : `${STATUS_EMOJI.provider('local')} local`;

  const lines = [
    `${lbl('Backend')} ${STATUS_EMOJI.backend(backendName)} ${C.magenta}${backendName}${C.reset}`,
    `${lbl('Provider')} ${providerDisplay}`,
    `${lbl('Version')} ${version}`,
    `${lbl('Mode')} ${STATUS_EMOJI.mode(mode)} ${mode}`,
    `${lbl('Linting')} ${STATUS_EMOJI.linting(linting)} ${linting}`,
    `${lbl('Model')} ${modelDisplay}`,
    `${lbl('Workspace')} ${STATUS_EMOJI.workspace(workspace)} ${workspace}`,
    `${lbl('Transport')} ${STATUS_EMOJI.transport(replyTransport)} ${replyTransport}`,
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
  parentOfBotRoot: string;
  dmBotRoot: string;
  agentEnv: Record<string, string | undefined>;
  selected?: string;
};

export async function handleWorkspace({
  db,
  backend,
  parentOfBotRoot,
  dmBotRoot,
  agentEnv,
  selected,
}: HandleWorkspaceProps): Promise<string> {
  const usageOpts = WorkspaceTargetSchema.options.join('|');

  const currentTarget = getWorkspaceTarget(db);
  const pwdFor = (target: WorkspaceTarget) => (target === 'bot' ? dmBotRoot : parentOfBotRoot);

  if (!selected) {
    const cwd = pwdFor(currentTarget);

    return `Workspace: ${currentTarget}. PWD: ${cwd}\nUsage: !workspace [${usageOpts}]`;
  }

  const parsed = WorkspaceTargetSchema.safeParse(selected);

  if (!parsed.success) {
    return `Usage: !workspace [${usageOpts}]`;
  }

  const nextTarget = parsed.data;
  const prevTarget = currentTarget;

  if (nextTarget === prevTarget) {
    const cwd = pwdFor(nextTarget);

    return `Workspace unchanged: ${nextTarget}. PWD: ${cwd}`;
  }

  setWorkspaceTarget(db, nextTarget);
  const cwd = nextTarget === 'bot' ? dmBotRoot : parentOfBotRoot;

  try {
    const sessionId = await createNewSession({
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
  parentOfBotRoot: string;
  attachUrl: string | null;
  agentEnv: Record<string, string | undefined>;
  selected?: string;
};

export async function handleBackend({
  db,
  dmBotRoot,
  parentOfBotRoot,
  attachUrl,
  agentEnv,
  selected,
}: HandleBackendProps): Promise<string> {
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
  const cwd = workspace === 'bot' ? dmBotRoot : parentOfBotRoot;
  const mode = getDefaultMode(db);
  const modelOverride = getModelOverride(db);
  const providerName = getProviderName(db);

  const newBackend = createBackend({
    backendName: nextBackendName,
    dmBotRoot,
    mode,
    attachUrl,
    modelOverride,
    providerName,
  });

  try {
    const sessionId = await createNewSession({
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
  seenDb: SeenDb;
  dmBotRoot: string;
  attachUrl: string | null;
};

export async function handleModels({
  seenDb,
  dmBotRoot,
  attachUrl,
}: HandleModelsProps): Promise<string> {
  const backendName = getAgentBackend(seenDb);
  const mode = getDefaultMode(seenDb);
  const modelOverride = getModelOverride(seenDb);
  const providerName = getProviderName(seenDb);

  debug(`modelOverride: ${modelOverride}`);

  const backend = createBackend({
    backendName,
    dmBotRoot,
    mode,
    attachUrl,
    modelOverride,
    providerName,
  });

  const models = await backend.availableModels();

  if (models.length === 0) {
    return `No models found for backend '${backendName}'.`;
  }

  const lines = models.map((m) => {
    const marker = m === backend.modelName ? ` ${C.green}*[current (override)]${C.reset}` : '';

    return `  ${m}${marker}`;
  });

  return `Available models for ${backendName}:\n${lines.join('\n')}`;
}

export function handleVersion({ version }: { version: string }): string {
  return `Version: ${version}`;
}

export type HandleLintProps = {
  db: SeenDb;
  args: string[];
  workspaceRoot: string;
  dmBotRoot: string;
};

export function handleLint({ db, args, workspaceRoot, dmBotRoot }: HandleLintProps): string {
  const first = args[0]?.toLowerCase();
  const second = args[1]?.toLowerCase();

  // !lint — run lint manually for current workspace
  if (args.length === 0) {
    const workspace = getWorkspaceTarget(db);
    const cwd = workspace === 'bot' ? dmBotRoot : workspaceRoot;
    const label = workspace === 'bot' ? 'dm-bot' : 'workspace';
    const result = runPostAgentLint({ cwd, label });

    if (!result.available) {
      return `Lint not available in this runtime for ${label} (bun run lint missing).`;
    }

    return formatLintSummary(result);
  }

  // !lint auto — show auto-lint status
  if (first === 'auto' && second === undefined) {
    return `Auto lint: ${getLinting(db)}.`;
  }

  // !lint auto on | !lint auto off — set auto-lint
  if (first === 'auto' && second !== undefined) {
    const parsed = LintingSchema.safeParse(second);

    if (!parsed.success) {
      return `Usage: !lint auto [${LintingSchema.options.join('|')}]`;
    }

    setLinting(db, parsed.data);

    return `Auto lint set to: ${parsed.data}.`;
  }

  return `Usage: !lint — run lint now; !lint auto — status; !lint auto [${LintingSchema.options.join('|')}] — set auto lint after agent.`;
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
!bot npub — print the bot's public key (npub) for sharing
!bot restart — request bot restart (when running under watch)
!help — this message
!local — reply only in local terminal
!remote — resume sending replies over Nostr DMs
!workspace [${WorkspaceTargetSchema.options.join('|')}] — show/set workspace target
!backend [cursor|opencode] — show/set agent backend (resets model override)
!models — list available models for current backend
!model [name|reset] — show/set model override (cleared on !backend)
!mode ask | !mode plan | !mode agent | !ask | !plan | !agent — set mode
!lint — run lint now; !lint auto — status; !lint auto [${LintingSchema.options.join('|')}] — set auto lint (agent mode)
!log info [on|off] — show/set info-level console logs
!ready [on|off] — show/set startup "Agent is ready" DM (default on)
!wallet mint [url] — show/set default Cashu mint
!wallet mints — list mints in wallet
!wallet balance — show Cashu wallet balance
!wallet decode <token> — decode a Cashu token (no spend)
!wallet receive <token> — receive a Cashu token
!wallet send <sats> — create and send a Cashu token
!wallet history [--token] — show recent spend history
!provider set [${ProviderNameSchema.options.join('|')}] — set payment provider
!provider deposit <sats> [--new] — deposit to provider (Routstr)
!provider refund — refund from provider to wallet
!provider balance — show provider balance
!provider budget <sats> — set per-run budget
!provider status — show provider status
!provider models [filter] — list Routstr models, optional filter by name
!provider sync-models — sync models from Routstr
!provider add-model <id> — add a Routstr model to opencode.json
!job-ai <prompt> — create a job draft from natural language; !job drafts|confirm|revise|discard|list|show|...
!todo — list|add|accept|revise|decline|show|done|undone|delete (todo list)
!todo-ai <prompt> — create or update a todo from natural language (draft; then !todo accept|revise|decline)
!file upload <path> <npub>   Encrypt and share a file with another bot
!file download <naddr>       Download and decrypt a file shared with this bot
!exit — stop the bot process`;
}
