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
 *   BOT_LOCAL_CLI           - Set to 0 to disable local terminal input (default: 1)
 *   BOT_AGENT_PATH          - Override PATH for locating agent binaries
 *   BOT_OPENCODE_SERVE_URL  - Attach to a running opencode server (e.g. http://localhost:4096)
 *
 * Restart: when using watch, touch restart.requested in this directory to restart the bot.
 */

import { existsSync, readFileSync, unlinkSync } from 'fs';
import { delimiter, join } from 'path';
import readline from 'readline';

import { spawn, spawnSync } from 'bun';
import { Database } from 'bun:sqlite';
import type { NostrEvent, EventTemplate, VerifiedEvent } from 'nostr-tools/core';
import { wrapEvent, unwrapEvent } from 'nostr-tools/nip17';
import { SimplePool } from 'nostr-tools/pool';
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function assertUnreachable(value: never): never {
  throw new Error(`Unreachable: ${String(value)}`);
}

function requireEnv(name: string): string {
  const val = process.env[name];

  if (!val) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }

  return val;
}

function ensureWss(url: string): string {
  if (url.startsWith('wss://') || url.startsWith('ws://')) {
    return url;
  }

  return `wss://${url}`;
}

function parseRelayUrls(envValue: string): string[] {
  const urls = envValue
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(ensureWss);

  return [...new Set(urls)];
}

function normalizePath(pathValue: string): string {
  const parts = pathValue
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean);

  return [...new Set(parts)].join(delimiter);
}

const DEBUG = process.env.DEBUG === '1';

function debug(msg: string, ...args: unknown[]) {
  if (DEBUG) {
    console.log('[debug]', msg, ...args);
  }
}

// ---------------------------------------------------------------------------
// ANSI colors (local terminal only — stripped before sending over Nostr)
// ---------------------------------------------------------------------------

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  white: '\x1b[97m',  // bright white — visible on black backgrounds
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

/** Remove ANSI escape sequences — used before sending messages over Nostr */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// SQLite persistence
// ---------------------------------------------------------------------------

/** Persist seen event ids so we don't reprocess on restart (Bun built-in SQLite) */
const SEEN_DB_PATH = join(import.meta.dir ?? process.cwd(), 'dm-bot.sqlite');

/** When this file is touched, the watcher (run-with-restart.ts) restarts the bot. Deleted on startup. */
export const RESTART_REQUESTED_PATH = join(import.meta.dir ?? process.cwd(), 'restart.requested');

function openSeenDb(): Database {
  const db = new Database(SEEN_DB_PATH);
  db.run('CREATE TABLE IF NOT EXISTS seen_events (id TEXT PRIMARY KEY)');

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      backend TEXT NOT NULL DEFAULT 'cursor'
    )
  `);

  // Migration: add backend column to existing sessions tables that predate this column
  try {
    db.run("ALTER TABLE sessions ADD COLUMN backend TEXT NOT NULL DEFAULT 'cursor'");
  } catch {
    // Column already exists — ignore
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS session_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT)
  `);

  return db;
}

function alreadyHaveEvent(db: Database): (id: string) => boolean {
  const stmt = db.prepare('SELECT 1 FROM seen_events WHERE id = ?');

  return (id: string) => stmt.get(id) !== null;
}

function markSeen(db: Database, id: string): void {
  db.run('INSERT OR IGNORE INTO seen_events (id) VALUES (?)', [id]);
}

// ---------------------------------------------------------------------------
// Types and state constants
// ---------------------------------------------------------------------------

type AgentMode = 'free' | 'ask' | 'plan' | 'agent';

type AgentBackendName = 'cursor' | 'opencode';
type MessageSource = 'nostr' | 'local';
type ReplyTransport = 'remote' | 'local';
type WorkspaceTarget = 'parent' | 'bot';

let redrawPrompt: (() => void) | null = null;

const DEFAULT_MODE: AgentMode = 'ask';
const DEFAULT_BACKEND: AgentBackendName = 'cursor';
const DEFAULT_REPLY_TRANSPORT: ReplyTransport = 'remote';
const DEFAULT_WORKSPACE_TARGET: WorkspaceTarget = 'parent';
const STATE_CURRENT_SESSION = 'current_session_id';
const STATE_DEFAULT_MODE = 'default_mode';
const STATE_AGENT_BACKEND = 'agent_backend';
const STATE_REPLY_TRANSPORT = 'reply_transport';
const STATE_WORKSPACE_TARGET = 'workspace_target';

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function getState(db: Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;

  return row?.value ?? null;
}

function setState(db: Database, key: string, value: string): void {
  db.run('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)', [key, value]);
}

function getDefaultMode(db: Database): AgentMode {
  const v = getState(db, STATE_DEFAULT_MODE);

  if (!v) {
    return DEFAULT_MODE;
  }

  const s = (ms: unknown) => {
    const modes: Record<AgentMode, string> = {
      free: 'free',
      ask: 'ask',
      plan: 'plan',
      agent: 'agent',
    };

    const validModes = Object.keys(modes);

    const cases = ms as AgentMode;

    switch (cases) {
      case 'free':
      case 'ask': {
        return cases;
      }
      case 'plan': {
        return cases;
      }
      case 'agent': {
        return cases;
      }
      default:{
        if (!validModes.includes(cases as string)) {
          throw `Unknown mode: ${cases}. Possible values: ${validModes.join(', ')}`;
        }

        assertUnreachable(cases);
      }
    }
  };

  return s(v) as AgentMode;
}

function setDefaultMode(db: Database, mode: AgentMode): void {
  setState(db, STATE_DEFAULT_MODE, mode);
}

function getAgentBackend(db: Database): AgentBackendName {
  const v = getState(db, STATE_AGENT_BACKEND);

  if (v === 'cursor' || v === 'opencode') {
    return v;
  }

  return DEFAULT_BACKEND;
}

function setAgentBackend(db: Database, backend: AgentBackendName): void {
  setState(db, STATE_AGENT_BACKEND, backend);
}

function getReplyTransport(db: Database): ReplyTransport {
  const v = getState(db, STATE_REPLY_TRANSPORT);

  if (v === 'local' || v === 'remote') {
    return v;
  }

  return DEFAULT_REPLY_TRANSPORT;
}

function setReplyTransport(db: Database, transport: ReplyTransport): void {
  setState(db, STATE_REPLY_TRANSPORT, transport);
}

function getWorkspaceTarget(db: Database): WorkspaceTarget {
  const v = getState(db, STATE_WORKSPACE_TARGET);

  if (v === 'parent' || v === 'bot') {
    return v;
  }

  return DEFAULT_WORKSPACE_TARGET;
}

function setWorkspaceTarget(db: Database, target: WorkspaceTarget): void {
  setState(db, STATE_WORKSPACE_TARGET, target);
}

// ---------------------------------------------------------------------------
// Agent backend interface + implementations
// ---------------------------------------------------------------------------

interface AgentRunResult {
  output: string;
  sessionId: string;
  model?: string;
  tokens?: { input: number; output: number; total: number };
  cost?: number;
}

interface AgentBackend {
  name: AgentBackendName;
  modelName: string;
  createSession(cwd: string, env: Record<string, string | undefined>): string;
  runMessage(opts: {
    sessionId: string;
    content: string;
    mode: AgentMode;
    cwd: string;
    env: Record<string, string | undefined>;
  }): Promise<AgentRunResult>;
}

// --- Cursor backend ---------------------------------------------------------

class CursorBackend implements AgentBackend {
  modelName: string = 'auto';
  name = 'cursor' as const;

  createSession(cwd: string, env: Record<string, string | undefined>): string {
    const proc = spawnSync(['agent', 'create-chat'], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    });
    const out = proc.stdout?.toString().trim() ?? '';
    const id = out.match(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )?.[0];

    if (!id) {
      throw new Error(
        `agent create-chat failed or invalid output: ${out || proc.stderr?.toString() || 'no output'}`,
      );
    }

    return id;
  }

  async runMessage(opts: {
    sessionId: string;
    content: string;
    mode: AgentMode;
    cwd: string;
    env: Record<string, string | undefined>;
  }): Promise<AgentRunResult> {
    const baseArgs = [
      'agent',
      '-p',
      '--model',
      'auto',
      '--workspace',
      opts.cwd,
      '--trust',
      '--yolo',
    ];

    if (opts.mode === 'ask') {
      baseArgs.push('--mode=ask');
    } else if (opts.mode === 'plan') {
      baseArgs.push('--mode=plan');
    } else {
      baseArgs.push('-f');
    }

    baseArgs.push('--resume', opts.sessionId, opts.content);

    const proc = spawn({
      cmd: baseArgs,
      cwd: opts.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      env: opts.env,
    });

    await proc.exited;
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();

    return {
      output: (out + (err ? '\n' + err : '')).trim() || '(no output)',
      sessionId: opts.sessionId,
    };
  }
}

// --- OpenCode JSONL parser --------------------------------------------------

function parseOpenCodeJsonl(raw: string): AgentRunResult {
  const lines = raw.trim().split('\n').filter(Boolean);
  let sessionId = '';
  const textParts: string[] = [];
  let tokens: AgentRunResult['tokens'];
  let cost: number | undefined;

  for (const line of lines) {
    try {
      const evt = JSON.parse(line) as {
        type: string;
        sessionID?: string;
        part?: {
          text?: string;
          tokens?: { input: number; output: number; total: number };
          cost?: number;
        };
      };

      if (!sessionId && evt.sessionID) {
        sessionId = evt.sessionID;
      }

      if (evt.type === 'text' && evt.part?.text) {
        // Strip ANSI at source — output is plain text, colors are only for local terminal
        textParts.push(stripAnsi(evt.part.text));
      }

      if (evt.type === 'step_finish' && evt.part) {
        const t = evt.part.tokens;

        if (t) {
          if (!tokens) {
            tokens = { input: 0, output: 0, total: 0 };
          }

          tokens.input += t.input ?? 0;
          tokens.output += t.output ?? 0;
          tokens.total += t.total ?? 0;
        }

        if (evt.part.cost != null) {
          cost = (cost ?? 0) + evt.part.cost;
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return {
    output: textParts.join('') || '(no output)',
    sessionId,
    tokens,
    cost,
  };
}

// --- OpenCode backend -------------------------------------------------------

class OpenCodeBackend implements AgentBackend {
  name = 'opencode' as const;
  modelName: string;
  private agentModels: Record<AgentMode, string>;
  private attachUrl?: string;

  constructor(dmBotRoot: string, mode: AgentMode) {
    this.attachUrl = process.env.BOT_OPENCODE_SERVE_URL;
    
    // Read opencode.json to know which model each agent uses — for display purposes
    
    let cfgPath;
    
    try {
      cfgPath = join(dmBotRoot, 'opencode.json');
      
      if (existsSync(cfgPath)) {
        debug(`opencode.json found in ${cfgPath}`);

        const cfg = JSON.parse(
          readFileSync(cfgPath, 'utf8')) as { agent?: Record<string, { model?: string }> };

        this.modelName = cfg.agent?.[mode]?.model ?? 'auto';
      } else {
        debug(`opencode.json not found in ${cfgPath}`);
      }
    } catch {
      debug(`opencode.json not found in ${cfgPath}`);
    }
  }

  createSession(cwd: string, env: Record<string, string | undefined>): string {
    const args = [
      'opencode',
      'run',
      'Session initialized. Waiting for instructions.',
      '--format',
      'json',
    ];

    if (this.attachUrl) {
      args.push('--attach', this.attachUrl);
    }

    const proc = spawnSync(args, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    });

    const out = proc.stdout?.toString().trim() ?? '';
    const parsed = parseOpenCodeJsonl(out);

    if (!parsed.sessionId) {
      throw new Error(
        `opencode session creation failed: ${out || proc.stderr?.toString() || 'no output'}`,
      );
    }

    return parsed.sessionId;
  }

  async runMessage(opts: {
    sessionId: string;
    content: string;
    mode: AgentMode;
    cwd: string;
    env: Record<string, string | undefined>;
  }): Promise<AgentRunResult> {
    // Map dm-bot modes to OpenCode agent names:
    // ask   -> ask   (custom agent: fast model, read-only, no bash)
    // plan  -> plan  (custom agent: strong model, read-only + safe bash)
    // agent -> agent (custom agent: full access)

    const args = [
      'opencode',
      'run',
      opts.content,
      '--format',
      'json',
      '--session',
      opts.sessionId,
      '--agent',
      opts.mode,
    ];

    if (this.attachUrl) {
      args.push('--attach', this.attachUrl);
    }

    debug('opencode args: ', args.join(' '));

    const proc = spawn({
      cmd: args,
      cwd: opts.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      env: opts.env,
    });

    await proc.exited;
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();

    const result = parseOpenCodeJsonl(out);

    // Fall back to stderr if no text output was parsed — strip ANSI at source
    if (result.output === '(no output)' && err.trim()) {
      result.output = stripAnsi(err.trim());
    }

    // Ensure sessionId is populated (should come from JSONL, but just in case)
    if (!result.sessionId) {
      result.sessionId = opts.sessionId;
    }

    // Populate model from our pre-read opencode.json map
    result.model = this.agentModels[opts.mode];

    return result;
  }
}

// --- Backend factory --------------------------------------------------------

function createBackend({ name, dmBotRoot, mode }: { name: AgentBackendName; dmBotRoot: string; mode: AgentMode; }): AgentBackend {
  return name === 'opencode' ? new OpenCodeBackend(dmBotRoot, mode) : new CursorBackend();
}

function createNewSession(opts: { db: Database; backendName: AgentBackendName; cwd: string; dmBotRoot: string; env: Record<string, string | undefined>; mode: AgentMode; }): string {
  const { db, backendName, cwd, dmBotRoot, env, mode } = opts;
  const backend = createBackend({ name: backendName, dmBotRoot, mode });
  const id = backend.createSession(cwd, env);

  const now = Math.floor(Date.now() / 1000);
  db.run('INSERT OR IGNORE INTO sessions (id, created_at, backend) VALUES (?, ?, ?)', [
    id,
    now,
    backendName,
  ]);
  setState(db, STATE_CURRENT_SESSION, id);

  return id;
}

function getLatestSession(db: Database, backendName: AgentBackendName): string | null {
  const row = db
    .prepare('SELECT id FROM sessions WHERE backend = ? ORDER BY created_at DESC LIMIT 1')
    .get(backendName) as { id: string } | undefined;

  return row?.id ?? null;
}

function getOrCreateCurrentSession(
  opts: { db: Database; backendName: AgentBackendName; cwd: string; dmBotRoot: string; env: Record<string, string | undefined>; mode: AgentMode; },
): string {
  const { db, backendName, cwd, dmBotRoot, env, mode } = opts;

  const cur = getState(db, STATE_CURRENT_SESSION);

  if (cur) {
    const exists = db
      .prepare('SELECT 1 FROM sessions WHERE id = ? AND backend = ?')
      .get(cur, backendName);

    if (exists) {
      return cur;
    }
  }

  return createNewSession({ db, backendName, cwd, dmBotRoot, env, mode });
}

function setCurrentSession(db: Database, sessionId: string): boolean {
  // Allow setting to any session regardless of backend (useful for inspection)
  const exists = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId);

  if (!exists) {
    return false;
  }

  setState(db, STATE_CURRENT_SESSION, sessionId);

  return true;
}

function insertSessionMessage(
  db: Database,
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
): void {
  const now = Math.floor(Date.now() / 1000);

  db.run(
    'INSERT INTO session_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)',
    [sessionId, role, content, now],
  );
}

// ---------------------------------------------------------------------------
// Messaging utilities
// ---------------------------------------------------------------------------

const CHUNK_MAX = 4200;
const CHUNK_DELAY_BASE_MS = 1500;
const CHUNK_DELAY_MAX_MS = 12000;
const EXIT_COMMAND_SENTINEL = '__DM_BOT_EXIT__';
const POST_AGENT_LINT_PROMPT_PREFIX = '[Post-edit lint feedback]';

type LintResult = {
  label: string;
  available: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkMessage(text: string): string[] {
  if (text.length <= CHUNK_MAX) {
    return [text];
  }

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > 0) {
    if (rest.length <= CHUNK_MAX) {
      chunks.push(rest);
      break;
    }

    const slice = rest.slice(0, CHUNK_MAX);
    const lastNewline = slice.lastIndexOf('\n');
    const splitAt = lastNewline >= 0 ? lastNewline + 1 : CHUNK_MAX;
    chunks.push(rest.slice(0, splitAt));
    rest = rest.slice(splitAt);
  }

  return chunks;
}

function runPostAgentLint(cwd: string, label: string): LintResult {
  const proc = spawnSync(['npm', 'run', 'lint'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = proc.stdout?.toString().trim() ?? '';
  const stderr = proc.stderr?.toString().trim() ?? '';
  const exitCode = proc.exitCode ?? -1;
  const lintCommandMissing =
    exitCode === 127 &&
    (stderr.includes('command not found: npm') ||
      stderr.includes('No such file or directory') ||
      stderr.includes('not found: npm'));

  if (lintCommandMissing) {
    return { label, available: false, exitCode, stdout, stderr };
  }

  return { label, available: true, exitCode, stdout, stderr };
}

function formatLintSummary(result: LintResult): string {
  const stdoutPart = result.stdout || '(empty)';
  const stderrPart = result.stderr || '(empty)';

  return `[${result.label}] Post-edit lint (exit ${result.exitCode}):\n[stdout]\n${stdoutPart}\n\n[stderr]\n${stderrPart}`;
}

/** Format the mode prefix with colors for local display */
function modePrefix(mode: AgentMode, local: boolean): string {
  if (!local) return `<${mode}> `;

  const colors: Record<AgentMode, string> = {
    free: C.cyan,
    ask: C.cyan,
    plan: C.yellow,
    agent: C.green,
  };

  return `${colors[mode]}<${mode}>${C.reset} `;
}

/** Format a token/cost footer for local display */
function tokenFooter(result: AgentRunResult, local: boolean): string {
  if (!result.tokens) return '';

  const { input, output } = result.tokens;
  const costStr = result.cost != null ? ` | cost: $${result.cost.toFixed(4)}` : '';
  const modelStr = result.model ? ` | model: ${result.model}` : '';
  const raw = `[tokens: ${input} in / ${output} out${costStr}${modelStr}]`;

  return local ? `\n${C.gray}${raw}${C.reset}` : `\n${raw}`;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

function handleBangCommand(
  input: string,
  relayUrls: string[],
  db: Database,
  version: string,
  // These are needed for !backend which must create a new session
  workspaceRoot: string,
  dmBotRoot: string,
  agentEnv: Record<string, string | undefined>,
): string | null {
  const raw = input.trim();

  if (!raw.startsWith('!')) {
    return null;
  }

  const rest = raw.slice(1).trim();
  const parts = rest.split(/\s+/);
  const cmd = (parts[0] ?? '').toLowerCase();
  const args = parts.slice(1);

  if (cmd === 'new-session') {
    try {
      const backendName = getAgentBackend(db);
      const workspace = getWorkspaceTarget(db);
      const cwd = workspace === 'bot' ? dmBotRoot : workspaceRoot;
      const id = createNewSession({ db, backendName, cwd, dmBotRoot, env: agentEnv, mode: getDefaultMode(db) });
      const mode = getDefaultMode(db);

      return `New session: ${id}\nBackend: ${backendName}\nMode: ${mode}\nWorkspace: ${workspace}.`;
    } catch (err) {
      return `Failed to create session: ${String(err)}`;
    }
  }

  if (cmd === 'resume-last-session') {
    const backendName = getAgentBackend(db);
    const id = getLatestSession(db, backendName);

    if (!id) {
      return `No sessions yet for backend '${backendName}'. Send a message or use !new-session.`;
    }

    setCurrentSession(db, id);

    return `Resumed session ${id}.`;
  }

  if (cmd === 'resume-session') {
    const id = args[0];

    if (!id) {
      return 'Usage: !resume-session <SESSION-ID>';
    }

    if (!setCurrentSession(db, id)) {
      return 'Session not found.';
    }

    return `Resumed session ${id}.`;
  }

  if (cmd === 'list-sessions') {
    const rows = db
      .prepare(
        "SELECT id, created_at, backend FROM sessions ORDER BY created_at DESC",
      )
      .all() as { id: string; created_at: number; backend: string }[];

    if (rows.length === 0) {
      return 'No sessions yet.';
    }

    const cur = getState(db, STATE_CURRENT_SESSION);

    const lines = rows.map((r) => {
      const date = new Date(r.created_at * 1000).toISOString();
      const mark = r.id === cur ? ' (current)' : '';
      const backend = r.backend ?? 'cursor';

      return `[${backend}] ${r.id} ${date}${mark}`;
    });

    return lines.join('\n');
  }

  if (cmd === 'show-last-messages') {
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

    const chronological = rows.reverse();

    const lines = chronological.map(
      (r) => `${r.role}: ${r.content.slice(0, 500)}${r.content.length > 500 ? '…' : ''}`,
    );

    return lines.join('\n\n');
  }

  if (cmd === 'status') {
    const cur = getState(db, STATE_CURRENT_SESSION);
    const mode = getDefaultMode(db);
    const backendName = getAgentBackend(db);
    const replyTransport = getReplyTransport(db);
    const workspace = getWorkspaceTarget(db);
    const serveUrl = process.env.BOT_OPENCODE_SERVE_URL;

    const backend = createBackend({ name: backendName, dmBotRoot, mode });

    const col = 14;
    const label = (name: string): string => `${C.bold}${(name + ':').padEnd(col)}${C.reset}`;

    const lines = [
      `${label('Backend')} ${C.magenta}${backendName}${C.reset}`,
      `${label('Model')} ${backend.modelName}`,
      `${label('Version')} ${version}`,
      `${label('Relays')} ${relayUrls.join(', ')}`,
      `${label('Mode')} ${mode}`,
      `${label('Workspace')} ${workspace}`,
      `${label('Transport')} ${replyTransport}`,
      `${label('Session')} ${cur ? cur : `${C.gray}(none — first message will create one)${C.reset}`}`,
    ];

    if (backendName === 'opencode' && serveUrl) {
      lines.push(`${label('Serve')} ${serveUrl} (attached)`);
    }

    return lines.join('\n');
  }

  if (cmd === 'version') {
    return `Version: ${version}`;
  }

  if (cmd === 'help') {
    return `Commands (prefix with !):
!new-session — create a new agent session
!resume-last-session — resume the latest session for the current backend
!resume-session <id> — resume a specific session (any backend)
!list-sessions — list all sessions (all backends)
!show-last-messages <id> [N] — last N messages (default 5)
!status — bot status and current session/mode/backend
!version — show git hash (dm-bot project)
!help — this message
!local — keep running, but reply only in local terminal (no Nostr outgoing replies)
!remote — resume sending replies over Nostr DMs
!workspace [parent|bot] — show/set workspace target (auto-creates new session when changed)
!backend [cursor|opencode] — show/set agent backend (auto-creates new session when changed)
!mode ask | !mode plan | !mode agent — set mode (default: ask). !ask, !plan, and !agent are shortcuts.
  opencode: ask -> ask agent, plan -> plan agent, agent -> build agent
!exit — stop the bot process

Plain messages (no !) go to the agent in the current session.`;
  }

  if (cmd === 'local') {
    setReplyTransport(db, 'local');

    return 'Reply transport switched to local. Outgoing Nostr replies are bypassed and printed in terminal.';
  }

  if (cmd === 'remote') {
    setReplyTransport(db, 'remote');

    return 'Reply transport switched to remote. Outgoing replies will be sent over Nostr DMs.';
  }

  if (cmd === 'workspace') {
    const selected = (args[0] ?? '').toLowerCase();

    if (!selected) {
      return `Workspace: ${getWorkspaceTarget(db)}.`;
    }

    if (selected !== 'parent' && selected !== 'bot') {
      return 'Usage: !workspace [parent|bot]';
    }

    const nextTarget = selected as WorkspaceTarget;
    const prevTarget = getWorkspaceTarget(db);

    if (nextTarget === prevTarget) {
      return `Workspace unchanged: ${nextTarget}.`;
    }

    setWorkspaceTarget(db, nextTarget);
    const cwd = nextTarget === 'bot' ? dmBotRoot : workspaceRoot;
    const backendName = getAgentBackend(db);

    try {
      const sessionId = createNewSession({ db, backendName, cwd, dmBotRoot, env: agentEnv, mode: getDefaultMode(db) });

      return `Workspace switched: ${prevTarget} -> ${nextTarget}\nNew session: ${sessionId}`;
    } catch (err) {
      return `Workspace switched to ${nextTarget}, but failed to auto-create session: ${String(err)}`;
    }
  }

  if (cmd === 'backend') {
    const selected = (args[0] ?? '').toLowerCase();

    if (!selected) {
      return `Backend: ${getAgentBackend(db)}.`;
    }

    if (selected !== 'cursor' && selected !== 'opencode') {
      return 'Usage: !backend cursor|opencode';
    }

    const nextBackend = selected as AgentBackendName;
    const prevBackend = getAgentBackend(db);

    if (nextBackend === prevBackend) {
      return `Backend unchanged: ${nextBackend}.`;
    }

    setAgentBackend(db, nextBackend);
    const workspace = getWorkspaceTarget(db);
    const cwd = workspace === 'bot' ? dmBotRoot : workspaceRoot;

    try {
      const sessionId = createNewSession({ db, backendName: nextBackend, cwd, dmBotRoot, env: agentEnv, mode: getDefaultMode(db) });

      return `Backend switched: ${prevBackend} -> ${nextBackend}\nNew session: ${sessionId}`;
    } catch (err) {
      return `Backend switched to ${nextBackend}, but failed to auto-create session: ${String(err)}`;
    }
  }

  if (cmd === 'mode') {
    const m = (args[0] ?? '').toLowerCase() as unknown;

    const s = (ms: unknown) => {
      const modes: Record<AgentMode, string> = {
        free: 'free',
        ask: 'ask',
        plan: 'plan',
        agent: 'agent',
      };
  
      const validModes = Object.keys(modes);

      const cases = ms as AgentMode;

      switch (cases) {
        case 'free':
        case 'ask': {
          setDefaultMode(db, cases);

          return null;
        }
        case 'plan': {
          setDefaultMode(db, cases);

          return null;
        }
        case 'agent': {
          setDefaultMode(db, cases);

          return null;
        }
        default:{
          if (!validModes.includes(m as string)) {
            return `Unknown mode: ${m}. Possible values: ${validModes.join(', ')}`;
          }

          assertUnreachable(cases);
        }
      }
    }

    return s(m);
  };

  return `Unknown command: !${cmd}. Use !help for commands.`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (existsSync(RESTART_REQUESTED_PATH)) {
    try {
      unlinkSync(RESTART_REQUESTED_PATH);
    } catch {
      // Ignore if file was already removed.
    }
  }

  const botKeyHex = requireEnv('BOT_KEY');
  const masterPubkey = requireEnv('BOT_MASTER_PUBKEY');
  const relayUrls = parseRelayUrls(requireEnv('BOT_RELAYS'));

  if (relayUrls.length === 0) {
    console.error('BOT_RELAYS must contain at least one relay URL (comma-separated)');
    process.exit(1);
  }

  const primaryRelay = relayUrls[0];

  const botSecretKey = hexToBytes(botKeyHex);
  const botPubkey = process.env.BOT_PUBKEY ?? getPublicKey(botSecretKey);

  if (process.env.BOT_PUBKEY && botPubkey !== process.env.BOT_PUBKEY) {
    console.error('Bot pubkey mismatch. Expected:', process.env.BOT_PUBKEY, 'Got:', botPubkey);
    process.exit(1);
  }

  const pool = new SimplePool({ enablePing: true, enableReconnect: true });

  const seenDb = openSeenDb();

  const dmBotRoot = import.meta.dir ?? process.cwd();
  const workspaceRoot = join(dmBotRoot, '..');
  const agentPath = normalizePath(process.env.BOT_AGENT_PATH ?? process.env.PATH ?? '');
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

  /** NIP-42: sign AUTH challenge so the relay can restrict kind:1059 to authenticated users */
  const signAuthEvent = async (authTemplate: EventTemplate): Promise<VerifiedEvent> => {
    debug('Signing AUTH challenge event:', authTemplate);

    return finalizeEvent(authTemplate, botSecretKey);
  };

  const defaultMode = getDefaultMode(seenDb);
  const defaultBackend = getAgentBackend(seenDb);
  const defaultReplyTransport = getReplyTransport(seenDb);
  const defaultWorkspace = getWorkspaceTarget(seenDb);
  const backendName = getAgentBackend(seenDb);
  const backend = createBackend({ name: backendName, dmBotRoot, mode: defaultMode });
  const serveUrl = process.env.BOT_OPENCODE_SERVE_URL;

  const col = 14; // label column width (including colon)
  function label(name: string): string {
    return `${C.bold}${(name + ':').padEnd(col)}${C.reset}`;
  }
  console.log(`${label('Bot pubkey')} ${botPubkey}`);
  console.log(`${label('Master')} ${masterPubkey}`);
  console.log(`${label('Relays')} ${relayUrls.join(', ')}`);
  console.log(`${label('Backend')} ${C.magenta}${defaultBackend}${C.reset}`);
  console.log(`${label('Version')} ${VERSION}`);
  if (defaultBackend === 'opencode' && serveUrl) {
    console.log(`${label('Serve')} ${serveUrl} (attached)`);
  }
  console.log(`${label('Mode')} ${defaultMode}`);
  console.log(`${label('Model')} ${backend.modelName}`);
  console.log(`${label('Workspace')} ${defaultWorkspace}`);
  console.log(`${label('Transport')} ${defaultReplyTransport}`);
  const startupSessionId = getState(seenDb, STATE_CURRENT_SESSION);
  console.log(`${label('Session')} ${startupSessionId ? `${C.dim}${startupSessionId}${C.reset}` : `${C.gray}(none — first message will create one)${C.reset}`}`);
  console.log();

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

  const readyDmPromise = sendDm(
    pool,
    primaryRelay,
    botSecretKey,
    masterPubkey,
    readyMessage,
    signAuthEvent,
  ).catch((err) => console.error('Failed to send ready DM:', err));

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
      // Local terminal: keep ANSI colors
      console.log(`${C.white}[bot]${C.reset} ${message}`);
      return;
    }

    // Nostr: safety strip — reply content is already plain text, but guard against any leakage
    await sendDm(pool, primaryRelay, botSecretKey, masterPubkey, stripAnsi(message), signAuthEvent);
  }

  async function handleUserMessage(content: string, source: MessageSource): Promise<void> {
    const sourceLabel = source === 'local' ? `${C.white}local${C.reset}` : `${C.magenta}master${C.reset}`;
    const isLocal = source === 'local' || getReplyTransport(seenDb) === 'local';
    console.log('\n-------------------\n');
    console.log(`[${sourceLabel}] ${content}`);
    console.log('');

    if (content.trim().startsWith('!')) {
      const reply = handleBangCommand(
        content,
        relayUrls,
        seenDb,
        VERSION,
        workspaceRoot,
        dmBotRoot,
        agentEnv,
      );

      if (reply === EXIT_COMMAND_SENTINEL) {
        const ack = 'Shutting down dm-bot.';
        await sendReplyForSource(source, ack);
        console.log('Exit command received. Shutting down dm-bot.');
        process.exit(0);
      } else if (reply) {
        await sendReplyForSource(source, reply);
      } else if (source === 'local') {
        console.log(`${C.white}[bot]${C.reset} ${C.dim}Command applied.${C.reset}`);
      }

      return;
    }

    const mode = getDefaultMode(seenDb);
    const currentWorkspace = getWorkspaceTarget(seenDb);
    const cwd = currentWorkspace === 'bot' ? dmBotRoot : workspaceRoot;

    const sessionId = getOrCreateCurrentSession({ db: seenDb, backendName, cwd, dmBotRoot, env: agentEnv, mode });

    insertSessionMessage(seenDb, sessionId, 'user', content);

    const runAgentRound = async (roundContent: string, startLog: string): Promise<AgentRunResult> => {
      console.log(startLog);

      return backend.runMessage({
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

      // Post-agent linting
      if (mode === 'agent') {
        const lintLabel = currentWorkspace === 'bot' ? 'dm-bot' : 'workspace';
        const lintResult = runPostAgentLint(cwd, lintLabel);

        if (lintResult.available) {
          const lintSummary = formatLintSummary(lintResult);
          finalOutput = `${initialResult.output}\n\n${lintSummary}`;
          const lintFailed = lintResult.exitCode !== 0;

          if (lintFailed) {
            const lintPrompt = `${POST_AGENT_LINT_PROMPT_PREFIX}\n${lintSummary}\n\nFix any lint issues and provide your final summary.`;
            insertSessionMessage(seenDb, sessionId, 'user', lintPrompt);

            try {
              // Run a follow-up agent round to fix the lint issues
              const fixResult = await runAgentRound(
                lintPrompt,
                `${C.dim}Starting ${backendName} agent (lint feedback)…${C.reset}\n`,
              );

              finalOutput = `${finalOutput}\n\n${fixResult.output}`;
              // Use the fix round result for token/cost attribution
              finalResult = fixResult;
            } catch (lintFollowupErr) {
              console.error('Lint follow-up agent process error:', lintFollowupErr);
              finalOutput = `${finalOutput}\n\nAutomatic lint-fix round failed: ${String(lintFollowupErr)}`;
            }
          }
        } else {
          console.error(
            `Skipping post-agent lint: npm run lint is unavailable in this runtime for ${lintLabel}.`,
          );
        }
      }

      // Only persist successful assistant responses — skip errors so they don't
      // poison session context fed to the model on the next turn.
      const isErrorResponse =
        finalOutput.startsWith('Unexpected error') ||
        finalOutput.startsWith('Error:') ||
        finalOutput.includes('check log file at') ||
        finalOutput === '(no output)';

      if (!isErrorResponse) {
        insertSessionMessage(seenDb, sessionId, 'assistant', finalOutput);
      } else {
        console.error(`${C.red}[bot] Error response — not stored in session history.${C.reset}`);
      }

      const prefix = modePrefix(mode, isLocal);
      const footer = tokenFooter(finalResult, isLocal);
      const fullReply = prefix + finalOutput + footer;
      const chunks = chunkMessage(fullReply);
      const total = chunks.length;
      let delayMs = CHUNK_DELAY_BASE_MS;

      for (let i = 0; i < chunks.length; i++) {
        const hasNextChunk = i < chunks.length - 1;
        const maybeNextPrompt =
          hasNextChunk && source === 'nostr' ? '\n<CHECK NEXT MESSAGE>' : '';
        const chunkBody = `${chunks[i]}${maybeNextPrompt}`;
        const chunk = total > 1 ? `(${i + 1}/${total}) ${chunkBody}` : chunkBody;

        try {
          await sendReplyForSource(source, chunk);
        } catch (e) {
          const targetLabel = source === 'local' ? 'local output' : 'DM chunk';
          console.error(`Failed to send ${targetLabel}:`, e);
        }

        if (hasNextChunk) {
          await sleep(delayMs);
          delayMs = Math.min(delayMs * 2, CHUNK_DELAY_MAX_MS);
        }
      }
    } catch (err) {
      console.error(`${C.red}Agent process error:${C.reset}`, err);

      sendReplyForSource(source, `<${mode}> Error: ${String(err)}`).catch((e) =>
        console.error('Failed to send error reply:', e),
      );
    }
  }

  const localCliEnabled = (process.env.BOT_LOCAL_CLI ?? '1') !== '0' && process.stdin.isTTY;

  if (localCliEnabled) {
    const startLocalCli = () => {
      console.log(`${C.dim}Type a prompt or ${C.reset}${C.white}!help${C.reset}${C.dim} to list commands.${C.reset}\n`);

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
          .catch((err) => console.error('Local CLI message processing failed:', err))
          .finally(() => localCli.prompt());
      });

      localCli.on('close', () => {
        redrawPrompt = null;
        console.log('Local terminal chat closed. Nostr DM listener continues running.');
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

// ---------------------------------------------------------------------------
// NIP-17 DM sending
// ---------------------------------------------------------------------------

export const PROFILE_RELAYS = new Set([
  'wss://purplepag.es',
  'wss://relay.nos.social',
  'wss://user.kindpag.es',
  'wss://relay.nostr.band',
]);

/** NIP-17: discover recipient's preferred DM relays from kind:10050 */
async function getMasterDmRelays(
  pool: SimplePool,
  botRelayUrl: string,
  masterPubkey: string,
): Promise<string[]> {
  try {
    const events = await pool.querySync(Array.from(PROFILE_RELAYS.add(botRelayUrl)), {
      kinds: [10050],
      authors: [masterPubkey],
      limit: 1,
    });

    if (events && events.length > 0) {
      const relayTags = events[0].tags.filter((t) => t[0] === 'relay' && t[1]);
      const urls = relayTags.map((t) => ensureWss(t[1]));

      if (urls.length > 0) {
        debug('Master kind:10050 relays:', urls);

        return urls;
      }
    }
  } catch (err) {
    debug('Failed to fetch master kind:10050:', err);
  }

  debug('No kind:10050 for master, using bot relay');

  return [botRelayUrl];
}

async function sendDm(
  pool: SimplePool,
  botRelayUrl: string,
  senderSecretKey: Uint8Array,
  recipientPubkey: string,
  message: string,
  signAuthEvent: (template: EventTemplate) => Promise<VerifiedEvent>,
) {
  const targetRelays = await getMasterDmRelays(pool, botRelayUrl, recipientPubkey);
  const recipientRelayHint = targetRelays[0] ?? botRelayUrl;

  const giftWrap = wrapEvent(
    senderSecretKey,
    { publicKey: recipientPubkey, relayUrl: recipientRelayHint },
    message,
  );

  debug('Publishing to relays:', targetRelays, 'event id:', giftWrap.id);
  const publishResults = await Promise.allSettled(
    pool.publish(targetRelays, giftWrap, { onauth: signAuthEvent }),
  );
  const successCount = publishResults.filter((r) => r.status === 'fulfilled').length;
  const failed = publishResults
    .map((r, idx) => ({ r, relay: targetRelays[idx] ?? 'unknown-relay' }))
    .filter((x) => x.r.status === 'rejected');

  if (failed.length > 0) {
    for (const x of failed) {
      const reason =
        x.r.status === 'rejected'
          ? x.r.reason instanceof Error
            ? x.r.reason.message
            : String(x.r.reason)
          : 'unknown';
      console.error(`Publish failed on relay ${x.relay}: ${reason}`);
    }
  }

  if (successCount === 0) {
    const reasons = failed
      .map((x) =>
        x.r.status === 'rejected'
          ? x.r.reason instanceof Error
            ? x.r.reason.message
            : String(x.r.reason)
          : 'unknown',
      )
      .join(' | ');
    throw new Error(`DM publish failed on all relays: ${reasons || 'unknown error'}`);
  }

  const sentLine = `${C.gray}[sent]${C.reset} ${message}`;

  if (redrawPrompt) {
    process.stdout.write(`\n${sentLine}\n`);
    redrawPrompt();
  } else {
    console.log(sentLine);
  }
}

main();
