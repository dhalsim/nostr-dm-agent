// ---------------------------------------------------------------------------
// commands/tasks.ts — !task sub-command handlers
// ---------------------------------------------------------------------------
import { randomBytes } from 'crypto';

import type { AgentBackend } from '../backends/types';
import { getAgentBackend, getModelOverride, getProviderName, getRoutstrModel } from '../db';
import type { SeenDb } from '../db';
import { debug } from '../logger';
import {
  createTask,
  deleteTask,
  disableTask,
  enableTask,
  getTask,
  listTaskRuns,
  listTasks,
} from '../tasks/db';
import type { TaskEngineContext } from '../tasks/engine';
import type { CreateTaskInput, Task } from '../tasks/types';
import { CreateTaskInputSchema } from '../tasks/types';

/**
 * Parse args. Special handling:
 *  --schedule  : takes next 1-5 tokens until next --flag (cron fields)
 *  --run-at    : takes next token (ISO date or relative time for CLI)
 *  --prompt    : takes all tokens until next --flag
 *  everything else: takes one token
 */
export function parseCreateArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  let i = 0;

  while (i < args.length) {
    const a = args[i];

    if (!a?.startsWith('--')) {
      i++;
      continue;
    }

    const key = a.slice(2).toLowerCase();
    i++;

    if (key === 'schedule') {
      const parts = args.slice(i, i + 5).filter((t) => t && !t.startsWith('--'));
      parsed[key] = parts.join(' ').trim();
      i += parts.length;
      continue;
    }

    if (key === 'run-at' || key === 'run_at') {
      const parts: string[] = [];

      while (i < args.length && !args[i]?.startsWith('--')) {
        parts.push(args[i]!);
        i++;
      }

      parsed['run-at'] = parts.join(' ').trim();
      continue;
    }

    if (key === 'prompt' || key === 'instruct' || key === 'instructions') {
      const parts: string[] = [];

      while (i < args.length && !args[i]?.startsWith('--')) {
        parts.push(args[i]!);
        i++;
      }

      parsed[key] = parts.join(' ').trim();
      continue;
    }

    const next = args[i];

    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      i++;
    } else {
      parsed[key] = '';
    }
  }

  return parsed;
}

function formatContextLine(task: Task): string {
  const modelPart = task.model ? task.model : '—';

  return [task.backend, task.provider, modelPart, task.mode].join(' / ');
}

function formatNextRun(nextRunAt: number | null): string {
  if (nextRunAt == null) {
    return '—';
  }

  return new Date(nextRunAt).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// -------------------------------------------------------------------------
// In-memory draft stores (both flows; cleared on bot restart)
// -------------------------------------------------------------------------
type CreateWithEntry = {
  input: CreateTaskInput;
  originalPrompt: string;
  history: string[];
};

const createWithStore = new Map<string, CreateWithEntry>();

function generateDraftId(): string {
  return randomBytes(2).toString('hex');
}

function getCurrentTimeContext(): { nowUtc: string; timeZone: string; nowLocal: string } {
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const nowLocal = now.toLocaleString(undefined, { timeZone });

  return {
    nowUtc: now.toISOString(),
    timeZone,
    nowLocal: `${nowLocal} (${timeZone})`,
  };
}

const CREATE_WITH_SYSTEM_PROMPT = (
  userPrompt: string,
  defaults: { backend: string; provider: string; model: string; mode: string },
) => {
  const tc = getCurrentTimeContext();

  return `You are creating a scheduled AI agent task from a natural-language request.

User request: "${userPrompt}"

Current date and time (UTC): ${tc.nowUtc}
Current date and time (user's timezone): ${tc.nowLocal}
User's timezone: ${tc.timeZone}
Use the current date/time above as the reference for relative times ("in 10 minutes", "tomorrow at 9am"). For one-time tasks, output run_at in UTC (ISO 8601). Interpret wall-clock times (e.g. "9am") in the user's timezone.

Current bot defaults (use these if the user does not specify): backend=${defaults.backend}, provider=${defaults.provider}, model=${defaults.model || '(empty = default)'}, mode=${defaults.mode}.

Output ONLY a single JSON object (no markdown, no code fence). You must choose exactly one of:

A) Recurring (cron): include execution_type: "cron", schedule (cron expression), and optionally maxRuns (number | null).
   schedule: valid 5-field cron, e.g. "0 7 * * *" (daily 07:00), "0 8 * * 1" (Mondays 08:00), "*/30 * * * *" (every 30 min).
   maxRuns: limit how many times it runs; infer from context (e.g. "every hour for the rest of the day", "three times a day for a week"). Use null if no limit.

B) One-time: include execution_type: "one-time" and run_at (ISO 8601 date string in UTC, must be in the future).
   run_at: compute from current date/time above; e.g. "in 10 minutes" = now + 10 min in UTC, "tomorrow at 9am" = 9am in user's timezone converted to UTC.

Common keys for both: name (string), prompt (string), backend (cursor|opencode|opencode-sdk), provider (local|routstr), model (string), mode (ask|plan|agent|free), budget_sats (number|null), instructions (string|null).`;
};

const CREATE_WITH_REVISE_PROMPT = (entry: CreateWithEntry, corrections: string) => {
  const tc = getCurrentTimeContext();

  return `You are revising a scheduled task configuration.

Original user request: "${entry.originalPrompt}"
${entry.history.length > 0 ? `Previous corrections:\n${entry.history.map((h) => `- ${h}`).join('\n')}` : ''}
New correction: ${corrections}

Current date and time (UTC): ${tc.nowUtc}
User's timezone: ${tc.timeZone}
Use this when the correction involves time (e.g. "30 minutes later", "tomorrow at 5pm").

Current parameters (JSON): ${JSON.stringify(entry.input)}

Output ONLY a single JSON object with the same structure (execution_type, and either schedule+maxRuns for cron or run_at for one-time, plus name, prompt, backend, provider, model, mode, budget_sats, instructions). Apply the user's correction. No markdown, no code fence.`;
};

function formatCreateWithPreview(id: string, input: CreateTaskInput): string {
  const common = [
    `name        : ${input.name}`,
    `prompt      : ${input.prompt}`,
    `backend     : ${input.backend}`,
    `provider    : ${input.provider}`,
    `model       : ${input.model}`,
    `mode        : ${input.mode}`,
    `budget_sats : ${input.budget_sats ?? '—'}`,
    `instructions: ${input.instructions ?? '—'}`,
  ];

  const execution =
    input.execution_type === 'cron'
      ? [
          `execution_type: cron`,
          `schedule    : ${input.schedule}`,
          `maxRuns     : ${input.maxRuns ?? '—'}`,
        ]
      : [`execution_type: one-time`, `run_at      : ${input.run_at.toISOString()}`];

  const lines = [...execution, ...common];

  return `${lines.join('\n')}

Draft ID: ${id}
Reply: !task confirm ${id} | !task revise ${id} <corrections> | !task discard ${id}`;
}

async function generateCreateWithParams(
  backend: AgentBackend,
  systemPrompt: string,
  cwd: string,
  agentEnv: Record<string, string | undefined>,
): Promise<CreateTaskInput> {
  const sessionId = await backend.createSession({ cwd, env: agentEnv });

  const result = await backend.runMessage({
    sessionId,
    content: systemPrompt,
    mode: 'ask',
    cwd,
    env: agentEnv,
    modelOverride: null,
  });

  const raw = result.output.trim();

  if (!raw || raw === '(no output)') {
    throw new Error('Model returned no text. Try again or use a different backend (e.g. cursor).');
  }

  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let jsonStr = stripped;
  const firstBrace = stripped.indexOf('{');
  const lastBrace = stripped.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = stripped.slice(firstBrace, lastBrace + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(
      `Model response was not valid JSON. Raw output (first 200 chars): ${raw.slice(0, 200)}`,
    );
  }

  return CreateTaskInputSchema.parse(parsed);
}

export type HandleTaskProps = {
  args: string[];
  db: SeenDb;
  taskEngine: TaskEngineContext | null;
  backend: AgentBackend;
  workspaceRoot: string;
  agentEnv: Record<string, string | undefined>;
};

export async function handleTask({
  args,
  db,
  taskEngine,
  backend,
  workspaceRoot,
  agentEnv,
}: HandleTaskProps): Promise<string> {
  const sub = args[0]?.toLowerCase();
  const rest = args.slice(1);

  if (!sub || sub === 'help') {
    return `!task create-with <prompt> — create a task from natural language (AI suggests params; confirm/revise/discard)
!task drafts — list pending drafts
!task confirm <draft_id> — create task from a create-with draft
!task revise <draft_id> <corrections> — ask AI to revise create-with params
!task discard <draft_id> — discard a draft
!task list — list all tasks
!task show <id> — show task details
!task enable <id> — enable a task
!task disable <id> — disable a task
!task delete <id> — delete a task
!task history <id> [N] — show run history (default N=10)
!task run <id> — run task once now
!task help — this message`;
  }

  // -------------------------------------------------------------------------
  // create-with (NL → AI-generated params, in-memory draft)
  // -------------------------------------------------------------------------
  if (sub === 'create-with') {
    const userPrompt = rest.join(' ').trim();

    if (!userPrompt) {
      return 'Usage: !task create-with <natural language request>\nExample: !task create-with send me a DM when weather is rainy in the morning';
    }

    const defaultBackend = getAgentBackend(db);
    const defaultProvider = getProviderName(db);

    const defaultModel = getRoutstrModel(db) ?? getModelOverride(db) ?? backend.modelName ?? '';

    const defaultMode = 'agent';

    const defaults = {
      backend: defaultBackend,
      provider: defaultProvider,
      model: defaultModel,
      mode: defaultMode,
    };

    const createWithPrompt = CREATE_WITH_SYSTEM_PROMPT(userPrompt, defaults);

    debug('create-with: prompt sent to AI', {
      userPrompt,
      defaults,
      promptLength: createWithPrompt.length,
      prompt: createWithPrompt,
    });

    let input: CreateTaskInput;

    try {
      input = await generateCreateWithParams(backend, createWithPrompt, workspaceRoot, agentEnv);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      return `Failed to generate or validate task parameters: ${msg}`;
    }

    const draftId = generateDraftId();

    createWithStore.set(draftId, {
      input,
      originalPrompt: userPrompt,
      history: [],
    });

    return formatCreateWithPreview(draftId, input);
  }

  // -------------------------------------------------------------------------
  // drafts (create-with in-memory only)
  // -------------------------------------------------------------------------
  if (sub === 'drafts') {
    const lines = [...createWithStore.entries()].map(([id, e]) => {
      const s = e.input.execution_type === 'cron' ? e.input.schedule : e.input.run_at.toISOString();

      return `${id} | ${e.input.name} | ${s}`;
    });

    if (lines.length === 0) {
      return 'No pending drafts.';
    }

    return `Pending drafts:\n${lines.join('\n')}\n\n!task confirm <id> | !task revise <id> <corrections> | !task discard <id>`;
  }

  const draftOrTaskId = rest[0]?.trim();

  // -------------------------------------------------------------------------
  // confirm (create-with in-memory draft → create task)
  // -------------------------------------------------------------------------
  if (sub === 'confirm') {
    if (!draftOrTaskId) {
      return 'Usage: !task confirm <draft_id>';
    }

    const entry = createWithStore.get(draftOrTaskId);

    if (!entry) {
      return `Draft not found: ${draftOrTaskId}. It may have expired (bot restart clears create-with drafts).`;
    }

    try {
      const task = createTask(db, entry.input);
      createWithStore.delete(draftOrTaskId);

      const budgetLine =
        task.budget_sats != null ? `\nBudget: ${task.budget_sats} sats (auto-flow)` : '';

      return `Task created: ${task.id}\nName: ${task.name}\nSchedule: ${task.schedule}\nNext run: ${formatNextRun(task.next_run_at)}${budgetLine}`;
    } catch (err) {
      return `Failed to create task: ${String(err)}`;
    }
  }

  // -------------------------------------------------------------------------
  // revise (create-with in-memory draft only)
  // -------------------------------------------------------------------------
  if (sub === 'revise') {
    if (!draftOrTaskId) {
      return 'Usage: !task revise <draft_id> <corrections>';
    }

    const corrections = rest.slice(1).join(' ').trim();

    if (!corrections) {
      return 'Usage: !task revise <draft_id> <corrections>';
    }

    const createWithEntry = createWithStore.get(draftOrTaskId);

    if (createWithEntry) {
      let input: CreateTaskInput;

      try {
        input = await generateCreateWithParams(
          backend,
          CREATE_WITH_REVISE_PROMPT(createWithEntry, corrections),
          workspaceRoot,
          agentEnv,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        return `Failed to revise parameters: ${msg}`;
      }

      createWithEntry.history.push(corrections);
      createWithEntry.input = input;
      createWithStore.set(draftOrTaskId, createWithEntry);

      return formatCreateWithPreview(draftOrTaskId, input);
    }

    return `Draft not found: ${draftOrTaskId}. It may have expired (bot restart clears drafts).`;
  }

  // -------------------------------------------------------------------------
  // discard (create-with in-memory first, else DB draft)
  // -------------------------------------------------------------------------
  if (sub === 'discard') {
    if (!draftOrTaskId) {
      return 'Usage: !task discard <draft_id>';
    }

    if (createWithStore.has(draftOrTaskId)) {
      createWithStore.delete(draftOrTaskId);

      return `Draft ${draftOrTaskId} discarded.`;
    }

    return `Draft not found: ${draftOrTaskId}. It may have expired (bot restart clears drafts).`;
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------
  if (sub === 'list') {
    const tasks = listTasks(db);

    if (tasks.length === 0) {
      return 'No tasks. Use `!task create-with <prompt>` to add one.';
    }

    const scheduleCol = (t: Task): string => {
      if (t.execution_type === 'one-time') {
        return 'once';
      }

      const s = t.schedule;

      return t.max_runs != null ? `${s} (max ${t.max_runs})` : s;
    };

    const escapeCell = (s: string): string => s.replace(/\|/g, '\\|');
    const header = '| ID | En | Name | Schedule | Next Run | Context |';
    const sep = '| --- | --- | --- | --- | --- | --- |';

    const rows = tasks.map(
      (t) =>
        `| ${escapeCell(t.id)} | ${t.enabled ? '✓' : '—'} | ${escapeCell(t.name)} | ${escapeCell(scheduleCol(t))} | ${escapeCell(formatNextRun(t.next_run_at))} | ${escapeCell(formatContextLine(t))} |`,
    );

    return `## Tasks\n\n${[header, sep, ...rows].join('\n')}`;
  }

  const id = rest[0]?.trim();

  // -------------------------------------------------------------------------
  // show
  // -------------------------------------------------------------------------
  if (sub === 'show') {
    if (!id) {
      return 'Usage: !task show <id>';
    }

    const task = getTask(db, id);

    if (!task) {
      return `Task not found: ${id}`;
    }

    const scheduleLine =
      task.execution_type === 'cron'
        ? `Schedule: ${task.schedule}${task.max_runs != null ? ` (max ${task.max_runs} runs)` : ''}`
        : `Run at: ${task.run_at != null ? formatNextRun(task.run_at) : '—'} (once)`;

    const lines = [
      `ID: ${task.id}`,
      `Name: ${task.name}`,
      `Type: ${task.execution_type}`,
      scheduleLine,
      `Prompt: ${task.prompt.slice(0, 80)}${task.prompt.length > 80 ? '…' : ''}`,
      `Enabled: ${task.enabled ? 'yes' : 'no'}`,
      `Next run: ${formatNextRun(task.next_run_at)}`,
      `Backend: ${task.backend}`,
      `Provider: ${task.provider}`,
      `Model: ${task.model || '(default)'}`,
      `Mode: ${task.mode}`,
      `Budget: ${task.budget_sats != null ? `${task.budget_sats} sats (auto-flow)` : '—'}`,
      `Instructions: ${task.instructions != null ? task.instructions.slice(0, 120) + (task.instructions.length > 120 ? '…' : '') : '—'}`,
    ];

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // enable / disable / delete / history / run
  // -------------------------------------------------------------------------
  if (sub === 'enable') {
    if (!id) {
      return 'Usage: !task enable <id>';
    }

    if (!getTask(db, id)) {
      return `Task not found: ${id}`;
    }

    if (enableTask(db, id)) {
      const task = getTask(db, id);

      return `Task ${id} enabled. Next run: ${formatNextRun(task?.next_run_at ?? null)}`;
    }

    return `Task ${id} is already enabled or schedule invalid.`;
  }

  if (sub === 'disable') {
    if (!id) {
      return 'Usage: !task disable <id>';
    }

    if (disableTask(db, id)) {
      return `Task ${id} disabled.`;
    }

    return `Task not found or already disabled: ${id}`;
  }

  if (sub === 'delete') {
    if (!id) {
      return 'Usage: !task delete <id>';
    }

    if (deleteTask(db, id)) {
      return `Task ${id} deleted.`;
    }

    return `Task not found: ${id}`;
  }

  if (sub === 'history') {
    if (!id) {
      return 'Usage: !task history <id> [N]';
    }

    const task = getTask(db, id);

    if (!task) {
      return `Task not found: ${id}`;
    }

    const n = Math.min(50, Math.max(1, parseInt(rest[1] ?? '10', 10) || 10));
    const runs = listTaskRuns(db, id, n);

    if (runs.length === 0) {
      return `No runs yet for "${task.name}".`;
    }

    const lines = runs.map((r) => {
      const start = new Date(r.started_at).toLocaleString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });

      const duration =
        r.finished_at != null ? `${Math.round((r.finished_at - r.started_at) / 1000)}s` : '—';

      const err = r.error ? `: ${r.error.slice(0, 40)}…` : '';

      return `#${r.id} ${start} — ${r.status} (${duration})${err}`;
    });

    return `History for "${task.name}" (last ${n}):\n${lines.join('\n')}`;
  }

  if (sub === 'run') {
    if (!id) {
      return 'Usage: !task run <id>';
    }

    const task = getTask(db, id);

    if (!task) {
      return `Task not found: ${id}`;
    }

    if (!taskEngine?.runTask) {
      return 'Task engine not available (scheduled run only).';
    }

    try {
      await taskEngine.runTask(task, db);

      return `Task ${id} (${task.name}) run triggered. Result will be sent by DM.`;
    } catch (err) {
      return `Run failed: ${String(err)}`;
    }
  }

  return `Unknown subcommand: ${sub}. Use !task help.`;
}
