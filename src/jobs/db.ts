// ---------------------------------------------------------------------------
// jobs/db.ts — Job CRUD and run history
// ---------------------------------------------------------------------------
import { Cron } from 'croner';

import type { CoreDb } from '../db';
import type { ProviderName } from '../db';
import {
  AgentBackendNameSchema,
  AgentModeSchema,
  DEFAULT_BACKEND,
  DEFAULT_PROVIDER,
  DEFAULT_WORKSPACE_TARGET,
  WorkspaceTargetSchema,
} from '../db';
import { log } from '../logger';

import type { CreateJobInput, Job, JobRun, JobRunStatus } from './types';

export type GetNextRunAtJob = {
  execution_type: 'cron' | 'one-time';
  schedule: string;
  run_at: number | null;
  max_runs: number | null;
};

/**
 * Returns next run timestamp (ms) for a job, optionally after a given time.
 * Uses Croner with paused: true (no callback). For one-time, returns null after that time.
 * For cron, returns null when runCount >= max_runs.
 */
export function getNextRunAt(
  job: GetNextRunAtJob,
  afterTimeMs?: number,
  runCount?: number,
): number | null {
  if (job.execution_type === 'one-time' && job.run_at != null) {
    try {
      const cron = new Cron(new Date(job.run_at), { paused: true });
      const from = afterTimeMs != null ? new Date(afterTimeMs) : undefined;
      const next = cron.nextRun(from);

      return next ? next.getTime() : null;
    } catch {
      return null;
    }
  }

  if (job.execution_type === 'cron' && job.schedule) {
    if (job.max_runs != null && (runCount ?? 0) >= job.max_runs) {
      return null;
    }

    try {
      const cron = new Cron(job.schedule, { paused: true });
      const from = afterTimeMs != null ? new Date(afterTimeMs) : undefined;
      const next = cron.nextRun(from);

      return next ? next.getTime() : null;
    } catch {
      return null;
    }
  }

  return null;
}

export function validateSchedule(
  schedule: string,
): { ok: true; cron: string } | { ok: false; error: string } {
  try {
    const cron = new Cron(schedule, { paused: true });
    const next = cron.nextRun();

    if (next == null) {
      return { ok: false, error: `Invalid cron expression: ${schedule}` };
    }

    return { ok: true, cron: schedule };
  } catch {
    return { ok: false, error: `Invalid cron expression: ${schedule}` };
  }
}

function rowToJob(row: Record<string, unknown>): Job {
  const backendRaw = row.backend != null && row.backend !== '';
  const providerRaw = row.provider != null && row.provider !== '';
  const modelRaw = row.model != null && row.model !== '';
  const modeRaw = row.mode != null && row.mode !== '';

  const executionType = row.execution_type === 'one-time' ? 'one-time' : ('cron' as const);

  return {
    id: Number(row.id),
    name: String(row.name),
    schedule: String(row.schedule),
    schedule_description: String(row.schedule_description ?? ''),
    prompt: String(row.prompt),
    enabled: Number(row.enabled),
    created_at: Number(row.created_at),
    last_run_at: row.last_run_at != null ? Number(row.last_run_at) : null,
    next_run_at: row.next_run_at != null ? Number(row.next_run_at) : null,
    backend: backendRaw ? AgentBackendNameSchema.parse(row.backend) : DEFAULT_BACKEND,
    provider: providerRaw ? (row.provider as ProviderName) : DEFAULT_PROVIDER,
    workspace_target: row.workspace_target
      ? WorkspaceTargetSchema.parse(row.workspace_target)
      : DEFAULT_WORKSPACE_TARGET,
    model: modelRaw ? String(row.model) : '',
    mode: modeRaw ? AgentModeSchema.parse(row.mode) : 'agent',
    budget_sats: row.budget_sats != null ? Number(row.budget_sats) : null,
    instructions: row.instructions != null ? String(row.instructions) : null,
    execution_type: executionType,
    run_at: row.run_at != null ? Number(row.run_at) : null,
    max_runs: row.max_runs != null ? Number(row.max_runs) : null,
  };
}

function rowToJobRun(row: Record<string, unknown>): JobRun {
  return {
    id: Number(row.id),
    job_id: Number(row.job_id),
    started_at: Number(row.started_at),
    finished_at: row.finished_at != null ? Number(row.finished_at) : null,
    status: row.status as JobRunStatus,
    output: row.output != null ? String(row.output) : null,
    error: row.error != null ? String(row.error) : null,
    budget_used_msats: row.budget_used_msats != null ? Number(row.budget_used_msats) : null,
  };
}

export function getJobRunCount(db: CoreDb, jobId: number): number {
  const row = db.prepare('SELECT COUNT(*) as c FROM job_runs WHERE job_id = ?').get(jobId) as {
    c: number;
  };

  return Number(row?.c ?? 0);
}

export function createJob(db: CoreDb, input: CreateJobInput): Job {
  const now = Date.now();

  if (input.execution_type === 'cron') {
    const validated = validateSchedule(input.schedule);

    if (!validated.ok) {
      throw new Error(validated.error);
    }

    const next_run_at = getNextRunAt(
      {
        execution_type: 'cron',
        schedule: validated.cron,
        run_at: null,
        max_runs: input.maxRuns,
      },
      undefined,
      0,
    );

    if (next_run_at == null) {
      throw new Error('Could not compute next run time');
    }

    const info = db.run(
      `INSERT INTO jobs (id, name, schedule, schedule_description, prompt, enabled, created_at, last_run_at, next_run_at, backend, provider, model, mode, budget_sats, instructions, execution_type, run_at, max_runs)
       VALUES (?, ?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'cron', NULL, ?)`,
      [
        input.name,
        validated.cron,
        input.schedule_description,
        input.prompt,
        now,
        next_run_at,
        input.backend,
        input.provider,
        input.model,
        input.mode,
        input.budget_sats,
        input.instructions,
        input.maxRuns,
      ],
    );

    return getJob(db, Number(info.lastInsertRowid))!;
  } else {
    log.info(`Creating one-time job: ${input.run_at}`);
    log.info(`Now: ${new Date(now).toISOString()}`);
    log.info(`Timezone of the machine: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

    const runAtMs = new Date(input.run_at).getTime();

    if (runAtMs <= now) {
      throw new Error('run_at must be in the future');
    }

    const info = db.run(
      `INSERT INTO jobs (id, name, schedule, schedule_description, prompt, enabled, created_at, last_run_at, next_run_at, backend, provider, model, mode, budget_sats, instructions, execution_type, run_at, max_runs)
       VALUES (?, ?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'one-time', ?, NULL)`,
      [
        input.name,
        'once',
        input.schedule_description,
        input.prompt,
        now,
        runAtMs,
        input.backend,
        input.provider,
        input.model,
        input.mode,
        input.budget_sats,
        input.instructions,
        runAtMs,
      ],
    );

    return getJob(db, Number(info.lastInsertRowid))!;
  }
}

export function listJobs(db: CoreDb): Job[] {
  const rows = db.prepare('SELECT * FROM jobs ORDER BY next_run_at ASC NULLS LAST').all() as Record<
    string,
    unknown
  >[];

  return rows.map(rowToJob);
}

export function getJob(db: CoreDb, id: number): Job | null {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;

  return row ? rowToJob(row) : null;
}

export function deleteJob(db: CoreDb, id: number): boolean {
  const info = db.prepare('DELETE FROM jobs WHERE id = ?').run(id);

  return info.changes > 0;
}

export function enableJob(db: CoreDb, id: number): boolean {
  const job = getJob(db, id);

  if (!job || job.enabled) {
    return false;
  }

  const runCount = getJobRunCount(db, id);
  const next_run_at = getNextRunAt(job, undefined, runCount);

  if (next_run_at == null) {
    return false;
  }

  db.prepare('UPDATE jobs SET enabled = 1, next_run_at = ? WHERE id = ?').run(next_run_at, id);

  return true;
}

export function disableJob(db: CoreDb, id: number): boolean {
  const info = db.prepare('UPDATE jobs SET enabled = 0, next_run_at = NULL WHERE id = ?').run(id);

  return info.changes > 0;
}

/**
 * List job IDs that are enabled and due (next_run_at <= now).
 */
export function listDueJobs(db: CoreDb): Job[] {
  const now = Date.now();

  const rows = db
    .prepare(
      'SELECT * FROM jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?',
    )
    .all(now) as Record<string, unknown>[];

  return rows.map(rowToJob);
}

export function updateJobRunTimes(
  db: CoreDb,
  jobId: number,
  lastRunAt: number,
  nextRunAt: number | null,
): void {
  db.prepare('UPDATE jobs SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(
    lastRunAt,
    nextRunAt,
    jobId,
  );
}

export function insertJobRun(db: CoreDb, jobId: number): number {
  const now = Date.now();

  const info = db
    .prepare(
      'INSERT INTO job_runs (job_id, started_at, finished_at, status, output, error) VALUES (?, ?, NULL, ?, NULL, NULL)',
    )
    .run(jobId, now, 'running');

  return info.lastInsertRowid as number;
}

export function updateJobRun(
  db: CoreDb,
  runId: number,
  status: JobRunStatus,
  output: string | null,
  error: string | null,
  budgetUsedMsats: number | null,
): void {
  const now = Date.now();

  db.prepare(
    'UPDATE job_runs SET finished_at = ?, status = ?, output = ?, error = ?, budget_used_msats = ? WHERE id = ?',
  ).run(now, status, output ?? null, error ?? null, budgetUsedMsats, runId);
}

export function listJobRuns(db: CoreDb, jobId: number, limit: number): JobRun[] {
  const rows = db
    .prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?')
    .all(jobId, limit) as Record<string, unknown>[];

  return rows.map(rowToJobRun);
}
