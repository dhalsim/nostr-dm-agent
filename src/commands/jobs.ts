// ---------------------------------------------------------------------------
// commands/jobs.ts — !job sub-command handlers
// ---------------------------------------------------------------------------
import { toJSONSchema } from 'zod';

import type { AgentBackend } from '../backends/types';
import type { SeenDb } from '../db';
import {
  createJob,
  deleteJob,
  disableJob,
  enableJob,
  getJob,
  listJobRuns,
  listJobs,
} from '../jobs/db';
import { deleteDraft, getDraft, listDrafts, storeDraft } from '../jobs/drafts';
import type { JobEngineContext } from '../jobs/engine';
import type { CreateJobInput, Job } from '../jobs/types';
import { CreateJobInputSchema } from '../jobs/types';

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

function formatContextLine(job: Job): string {
  const modelPart = job.model ? job.model : '—';

  return [job.backend, job.provider, modelPart, job.mode].join(' / ');
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
// Draft entry shape for revise prompt (matches JobDraftRow minus id/kind)
// -------------------------------------------------------------------------
type ReviseEntry = {
  input: CreateJobInput;
  originalPrompt: string;
};

export function getCurrentTimeContext(): { nowUtc: string; timeZone: string; nowLocal: string } {
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const nowLocal = now.toLocaleString(undefined, { timeZone });

  return {
    nowUtc: now.toISOString(),
    timeZone,
    nowLocal: `${nowLocal} (${timeZone})`,
  };
}

/** JSON Schema for CreateJobInput (discriminated union cron | one-time). Used in create/revise prompts. */
const CREATE_JOB_JSON_SCHEMA = JSON.stringify(toJSONSchema(CreateJobInputSchema), null, 2);

/** Exported for !job-ai: build system prompt for creating a job from natural language. */
export function buildJobCreateSystemPrompt(
  userPrompt: string,
  defaults: { backend: string; provider: string; model: string; mode: string },
): string {
  const tc = getCurrentTimeContext();

  return `You are creating a scheduled AI agent job from a natural-language request.

User request: "${userPrompt}"

Current date and time (UTC): ${tc.nowUtc}
Current date and time (user's timezone): ${tc.nowLocal}
User's timezone: ${tc.timeZone}
Use the current date/time above as the reference for relative times ("in 10 minutes", "tomorrow at 9am"). For one-time jobs, output run_at as an ISO 8601 date-time string in UTC (the instant in UTC, as a string; must be in the future). Interpret wall-clock times (e.g. "9am") in the user's timezone.

Current bot defaults (use these if the user does not specify): backend=${defaults.backend}, provider=${defaults.provider}, model=${defaults.model || '(empty = default)'}, mode=${defaults.mode}.

Output ONLY a single JSON object (no markdown, no code fence). You must choose exactly one of:

A) Recurring (cron): include execution_type: "cron", schedule (cron expression), schedule_description, and optionally maxRuns (number | null).
   schedule: valid 5-field cron, e.g. "0 7 * * *" (daily 07:00), "0 8 * * 1" (Mondays 08:00), "*/30 * * * *" (every 30 min).
   schedule_description: a short human-readable description of when it runs (e.g. "every Monday morning at 9am", "daily at 7am", "every 30 minutes"). Always include this.
   maxRuns: limit how many times it runs; infer from context (e.g. "every hour for the rest of the day", "three times a day for a week"). Use null if no limit.

B) One-time: include execution_type: "one-time", run_at (ISO 8601 date-time string in UTC), and schedule_description (human-readable description of run_at).
   run_at: the instant in UTC as an ISO 8601 string (must be in the future). Compute from current date/time above; e.g. "in 10 minutes" = now + 10 min in UTC, "tomorrow at 9am" = 9am in user's timezone converted to UTC.
   schedule_description: human-readable description of when it runs / of run_at (e.g. "tomorrow at 9am", "in 10 minutes"). Always include this.

Expected JSON structure (must match this schema):
\`\`\`json
${CREATE_JOB_JSON_SCHEMA}
\`\`\``;
}

const CREATE_WITH_REVISE_PROMPT = (entry: ReviseEntry, corrections: string) => {
  const tc = getCurrentTimeContext();

  return `You are revising a scheduled job configuration.

Original user request: "${entry.originalPrompt}"
New correction: ${corrections}

Current date and time (UTC): ${tc.nowUtc}
User's timezone: ${tc.timeZone}
Use this when the correction involves time (e.g. "30 minutes later", "tomorrow at 5pm").

Current parameters (JSON): ${JSON.stringify(entry.input)}

Output ONLY a single JSON object matching this schema. Apply the user's correction. No markdown, no code fence.

Schema:
\`\`\`json
${CREATE_JOB_JSON_SCHEMA}
\`\`\``;
};

export function formatCreateWithPreview(id: string, input: CreateJobInput): string {
  const w = 19;

  const common = [
    `${'name'.padEnd(w)} : ${input.name}`,
    `${'prompt'.padEnd(w)} : ${input.prompt}`,
    `${'schedule_description'.padEnd(w)} : ${input.schedule_description}`,
    `${'backend'.padEnd(w)} : ${input.backend}`,
    `${'provider'.padEnd(w)} : ${input.provider}`,
    `${'model'.padEnd(w)} : ${input.model}`,
    `${'mode'.padEnd(w)} : ${input.mode}`,
    `${'budget_sats'.padEnd(w)} : ${input.budget_sats ?? '—'}`,
    `${'instructions'.padEnd(w)} : ${input.instructions ?? '—'}`,
  ];

  const execution =
    input.execution_type === 'cron'
      ? [
          `execution_type: cron`,
          `schedule    : ${input.schedule}`,
          `maxRuns     : ${input.maxRuns ?? '—'}`,
        ]
      : [`execution_type: one-time`, `run_at      : ${input.run_at}`];

  const lines = [...execution, ...common];

  return `${lines.join('\n')}

Draft ID: ${id}
Reply: !job confirm ${id} | !job revise ${id} <corrections> | !job discard ${id}`;
}

export type GenerateCreateWithParamsProps = {
  backend: AgentBackend;
  sessionId: string;
  systemPrompt: string;
  cwd: string;
  agentEnv: Record<string, string | undefined>;
};

export async function generateCreateWithParams({
  backend,
  sessionId,
  systemPrompt,
  cwd,
  agentEnv,
}: GenerateCreateWithParamsProps): Promise<CreateJobInput> {
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

  return CreateJobInputSchema.parse(parsed);
}

export type HandleJobProps = {
  args: string[];
  db: SeenDb;
  jobEngine: JobEngineContext | null;
  backend: AgentBackend;
  sessionId: string;
  cwd: string;
  agentEnv: Record<string, string | undefined>;
};

export async function handleJob({
  args,
  db,
  jobEngine,
  backend,
  sessionId,
  cwd,
  agentEnv,
}: HandleJobProps): Promise<string> {
  const sub = args[0]?.toLowerCase();
  const rest = args.slice(1);

  if (!sub || sub === 'help') {
    return `!job drafts — list pending drafts
!job confirm <draft_id> — create job from a draft
!job revise <draft_id> <corrections> — ask AI to revise draft params
!job discard <draft_id> — discard a draft
!job list — list all jobs
!job show <id> — show job details
!job enable <id> — enable a job
!job disable <id> — disable a job
!job delete <id> — delete a job
!job history <id> [N] — show run history (default N=10)
!job run <id> — run job once now
!job help — this message`;
  }

  // -------------------------------------------------------------------------
  // drafts (DB)
  // -------------------------------------------------------------------------
  if (sub === 'drafts') {
    const drafts = listDrafts(db);

    if (drafts.length === 0) {
      return 'No pending drafts. Use !job-ai <prompt> to create one.';
    }

    const lines = drafts.map((d) => {
      const s = d.input.execution_type === 'cron' ? d.input.schedule : d.input.run_at;

      return `${d.id} | ${d.input.name} | ${s} | ${d.input.schedule_description}`;
    });

    return `Pending drafts:\n${lines.join('\n')}\n\n!job confirm <id> | !job revise <id> <corrections> | !job discard <id>`;
  }

  const draftOrJobId = rest[0]?.trim();

  // -------------------------------------------------------------------------
  // confirm (DB draft → create job)
  // -------------------------------------------------------------------------
  if (sub === 'confirm') {
    if (!draftOrJobId) {
      return 'Usage: !job confirm <draft_id>';
    }

    const draftId = parseInt(draftOrJobId, 10);

    if (Number.isNaN(draftId)) {
      return `Draft not found: ${draftOrJobId}. Use a numeric draft id (e.g. !job confirm 1).`;
    }

    const entry = getDraft(db, draftId);

    if (!entry) {
      return `Draft not found: ${draftId}.`;
    }

    try {
      const job = createJob(db, entry.input);
      deleteDraft(db, draftId);

      const budgetLine =
        job.budget_sats != null ? `\nBudget: ${job.budget_sats} sats (auto-flow)` : '';

      const scheduleDisplay = job.schedule_description;

      return `Job created: ${job.id}\nName: ${job.name}\nWhen: ${scheduleDisplay}\nNext run: ${formatNextRun(job.next_run_at)}${budgetLine}`;
    } catch (err) {
      return `Failed to create job: ${String(err)}`;
    }
  }

  // -------------------------------------------------------------------------
  // revise (DB draft)
  // -------------------------------------------------------------------------
  if (sub === 'revise') {
    if (!draftOrJobId) {
      return 'Usage: !job revise <draft_id> <corrections>';
    }

    const corrections = rest.slice(1).join(' ').trim();

    if (!corrections) {
      return 'Usage: !job revise <draft_id> <corrections>';
    }

    const draftId = parseInt(draftOrJobId, 10);

    if (Number.isNaN(draftId)) {
      return `Draft not found: ${draftOrJobId}. Use a numeric draft id.`;
    }

    const entry = getDraft(db, draftId);

    if (!entry) {
      return `Draft not found: ${draftId}.`;
    }

    let input: CreateJobInput;

    try {
      input = await generateCreateWithParams({
        backend,
        sessionId,
        systemPrompt: CREATE_WITH_REVISE_PROMPT(entry, corrections),
        cwd,
        agentEnv,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      return `Failed to revise parameters: ${msg}`;
    }

    const newDraftId = storeDraft(db, {
      kind: 'create',
      input,
      originalPrompt: `${entry.originalPrompt} (revised: ${corrections})`,
    });

    deleteDraft(db, draftId);

    return [
      `Draft #${draftId} revised. Created new draft #${newDraftId}:`,
      '',
      formatCreateWithPreview(String(newDraftId), input),
      '',
      `To accept the revised draft: !job confirm ${newDraftId}`,
      `To decline the revised draft: !job discard ${newDraftId}`,
    ].join('\n');
  }

  // -------------------------------------------------------------------------
  // discard (DB draft)
  // -------------------------------------------------------------------------
  if (sub === 'discard') {
    if (!draftOrJobId) {
      return 'Usage: !job discard <draft_id>';
    }

    const draftId = parseInt(draftOrJobId, 10);

    if (Number.isNaN(draftId)) {
      return `Draft not found: ${draftOrJobId}. Use a numeric draft id.`;
    }

    if (deleteDraft(db, draftId)) {
      return `Draft ${draftId} discarded.`;
    }

    return `Draft not found: ${draftId}.`;
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------
  if (sub === 'list') {
    const jobs = listJobs(db);

    if (jobs.length === 0) {
      return 'No jobs. Use `!job create-with <prompt>` to add one.';
    }

    const scheduleCol = (j: Job): string => {
      const desc = j.schedule_description;

      return j.max_runs != null ? `${desc} (max ${j.max_runs})` : desc;
    };

    const escapeCell = (s: string): string => s.replace(/\|/g, '\\|');
    const header = '| ID | En | Name | Schedule | Next Run | Context |';
    const sep = '| --- | --- | --- | --- | --- | --- |';

    const rows = jobs.map(
      (j) =>
        `| ${escapeCell(String(j.id))} | ${j.enabled ? '✓' : '—'} | ${escapeCell(j.name)} | ${escapeCell(scheduleCol(j))} | ${escapeCell(formatNextRun(j.next_run_at))} | ${escapeCell(formatContextLine(j))} |`,
    );

    return `## Jobs\n\n${[header, sep, ...rows].join('\n')}`;
  }

  const idRaw = rest[0]?.trim();
  const id = idRaw ? parseInt(idRaw, 10) : NaN;
  const idValid = !Number.isNaN(id);

  // -------------------------------------------------------------------------
  // show
  // -------------------------------------------------------------------------
  if (sub === 'show') {
    if (!idRaw) {
      return 'Usage: !job show <id>';
    }

    if (!idValid) {
      return 'Usage: !job show <id> (id must be a number)';
    }

    const job = getJob(db, id);

    if (!job) {
      return `Job not found: ${id}`;
    }

    const scheduleLine =
      job.execution_type === 'cron'
        ? `Schedule: ${job.schedule}${job.max_runs != null ? ` (max ${job.max_runs} runs)` : ''}`
        : `Run at: ${job.run_at != null ? formatNextRun(job.run_at) : '—'} (once)`;

    const scheduleDescLine = `When: ${job.schedule_description}`;

    const lines = [
      `ID: ${job.id}`,
      `Name: ${job.name}`,
      `Type: ${job.execution_type}`,
      scheduleLine,
      scheduleDescLine,
      `Prompt: ${job.prompt.slice(0, 80)}${job.prompt.length > 80 ? '…' : ''}`,
      `Enabled: ${job.enabled ? 'yes' : 'no'}`,
      `Next run: ${formatNextRun(job.next_run_at)}`,
      `Backend: ${job.backend}`,
      `Provider: ${job.provider}`,
      `Model: ${job.model || '(default)'}`,
      `Mode: ${job.mode}`,
      `Budget: ${job.budget_sats != null ? `${job.budget_sats} sats (auto-flow)` : '—'}`,
      `Instructions: ${job.instructions != null ? job.instructions.slice(0, 120) + (job.instructions.length > 120 ? '…' : '') : '—'}`,
    ];

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // enable / disable / delete / history / run
  // -------------------------------------------------------------------------
  if (sub === 'enable') {
    if (!idValid) {
      return 'Usage: !job enable <id>';
    }

    if (!getJob(db, id)) {
      return `Job not found: ${id}`;
    }

    if (enableJob(db, id)) {
      const job = getJob(db, id);

      return `Job ${id} enabled. Next run: ${formatNextRun(job?.next_run_at ?? null)}`;
    }

    return `Job ${id} is already enabled or schedule invalid.`;
  }

  if (sub === 'disable') {
    if (!idValid) {
      return 'Usage: !job disable <id>';
    }

    if (disableJob(db, id)) {
      return `Job ${id} disabled.`;
    }

    return `Job not found or already disabled: ${id}`;
  }

  if (sub === 'delete') {
    if (!idValid) {
      return 'Usage: !job delete <id>';
    }

    if (deleteJob(db, id)) {
      return `Job ${id} deleted.`;
    }

    return `Job not found: ${id}`;
  }

  if (sub === 'history') {
    if (!idValid) {
      return 'Usage: !job history <id> [N]';
    }

    const job = getJob(db, id);

    if (!job) {
      return `Job not found: ${id}`;
    }

    const n = Math.min(50, Math.max(1, parseInt(rest[1] ?? '10', 10) || 10));
    const runs = listJobRuns(db, id, n);

    if (runs.length === 0) {
      return `No runs yet for "${job.name}".`;
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

    return `History for "${job.name}" (last ${n}):\n${lines.join('\n')}`;
  }

  if (sub === 'run') {
    if (!idValid) {
      return 'Usage: !job run <id>';
    }

    const job = getJob(db, id);

    if (!job) {
      return `Job not found: ${id}`;
    }

    if (!jobEngine?.runJob) {
      return 'Job engine not available (scheduled run only).';
    }

    try {
      await jobEngine.runJob(job, db);

      return `Job ${id} (${job.name}) run triggered. Result will be sent by DM.`;
    } catch (err) {
      return `Run failed: ${String(err)}`;
    }
  }

  return `Unknown subcommand: ${sub}. Use !job help.`;
}
