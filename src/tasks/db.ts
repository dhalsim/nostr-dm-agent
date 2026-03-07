// ---------------------------------------------------------------------------
// tasks/db.ts — Task CRUD and run history
// ---------------------------------------------------------------------------
import { randomBytes } from 'crypto';

import { Cron } from 'croner';

import { AgentBackendNameSchema, AgentModeSchema, DEFAULT_BACKEND, DEFAULT_PROVIDER } from '../db';
import type { SeenDb } from '../db';
import type { ProviderName } from '../db';
import { log } from '../logger';

import type { CreateTaskInput, Task, TaskRun, TaskRunStatus } from './types';

export type GetNextRunAtTask = {
  execution_type: 'cron' | 'one-time';
  schedule: string;
  run_at: number | null;
  max_runs: number | null;
};

/**
 * Returns next run timestamp (ms) for a task, optionally after a given time.
 * Uses Croner with paused: true (no callback). For one-time, returns null after that time.
 * For cron, returns null when runCount >= max_runs.
 */
export function getNextRunAt(
  task: GetNextRunAtTask,
  afterTimeMs?: number,
  runCount?: number,
): number | null {
  if (task.execution_type === 'one-time' && task.run_at != null) {
    try {
      const job = new Cron(new Date(task.run_at), { paused: true });
      const from = afterTimeMs != null ? new Date(afterTimeMs) : undefined;
      const next = job.nextRun(from);

      return next ? next.getTime() : null;
    } catch {
      return null;
    }
  }

  if (task.execution_type === 'cron' && task.schedule) {
    if (task.max_runs != null && (runCount ?? 0) >= task.max_runs) {
      return null;
    }

    try {
      const job = new Cron(task.schedule, { paused: true });
      const from = afterTimeMs != null ? new Date(afterTimeMs) : undefined;
      const next = job.nextRun(from);

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
    const job = new Cron(schedule, { paused: true });
    const next = job.nextRun();

    if (next == null) {
      return { ok: false, error: `Invalid cron expression: ${schedule}` };
    }

    return { ok: true, cron: schedule };
  } catch {
    return { ok: false, error: `Invalid cron expression: ${schedule}` };
  }
}

function generateTaskId(): string {
  return randomBytes(4).toString('hex');
}

function rowToTask(row: Record<string, unknown>): Task {
  const backendRaw = row.backend != null && row.backend !== '';
  const providerRaw = row.provider != null && row.provider !== '';
  const modelRaw = row.model != null && row.model !== '';
  const modeRaw = row.mode != null && row.mode !== '';

  const executionType = row.execution_type === 'one-time' ? 'one-time' : ('cron' as const);

  return {
    id: String(row.id),
    name: String(row.name),
    schedule: String(row.schedule),
    prompt: String(row.prompt),
    enabled: Number(row.enabled),
    created_at: Number(row.created_at),
    last_run_at: row.last_run_at != null ? Number(row.last_run_at) : null,
    next_run_at: row.next_run_at != null ? Number(row.next_run_at) : null,
    backend: backendRaw ? AgentBackendNameSchema.parse(row.backend) : DEFAULT_BACKEND,
    provider: providerRaw ? (row.provider as ProviderName) : DEFAULT_PROVIDER,
    model: modelRaw ? String(row.model) : '',
    mode: modeRaw ? AgentModeSchema.parse(row.mode) : 'agent',
    budget_sats: row.budget_sats != null ? Number(row.budget_sats) : null,
    instructions: row.instructions != null ? String(row.instructions) : null,
    execution_type: executionType,
    run_at: row.run_at != null ? Number(row.run_at) : null,
    max_runs: row.max_runs != null ? Number(row.max_runs) : null,
  };
}

function rowToTaskRun(row: Record<string, unknown>): TaskRun {
  return {
    id: Number(row.id),
    task_id: String(row.task_id),
    started_at: Number(row.started_at),
    finished_at: row.finished_at != null ? Number(row.finished_at) : null,
    status: row.status as TaskRunStatus,
    output: row.output != null ? String(row.output) : null,
    error: row.error != null ? String(row.error) : null,
    budget_used_msats: row.budget_used_msats != null ? Number(row.budget_used_msats) : null,
  };
}

export function getTaskRunCount(db: SeenDb, taskId: string): number {
  const row = db.prepare('SELECT COUNT(*) as c FROM task_runs WHERE task_id = ?').get(taskId) as {
    c: number;
  };

  return Number(row?.c ?? 0);
}

export function createTask(db: SeenDb, input: CreateTaskInput): Task {
  let id = generateTaskId();

  while (db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id)) {
    id = generateTaskId();
  }

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

    db.run(
      `INSERT INTO tasks (id, name, schedule, prompt, enabled, created_at, last_run_at, next_run_at, backend, provider, model, mode, budget_sats, instructions, execution_type, run_at, max_runs)
       VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'cron', NULL, ?)`,
      [
        id,
        input.name,
        validated.cron,
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
  } else {
    log.info(`Creating one-time task: ${input.run_at.toISOString()}`);
    log.info(`Now: ${new Date(now).toISOString()}`);
    log.info(`Timezone of the machine: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

    const runAtMs = new Date(input.run_at).getTime();

    if (runAtMs <= now) {
      throw new Error('run_at must be in the future');
    }

    db.run(
      `INSERT INTO tasks (id, name, schedule, prompt, enabled, created_at, last_run_at, next_run_at, backend, provider, model, mode, budget_sats, instructions, execution_type, run_at, max_runs)
       VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'one-time', ?, NULL)`,
      [
        id,
        input.name,
        'once',
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
  }

  return getTask(db, id)!;
}

export function listTasks(db: SeenDb): Task[] {
  const rows = db
    .prepare('SELECT * FROM tasks ORDER BY next_run_at ASC NULLS LAST')
    .all() as Record<string, unknown>[];

  return rows.map(rowToTask);
}

export function getTask(db: SeenDb, id: string): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;

  return row ? rowToTask(row) : null;
}

export function deleteTask(db: SeenDb, id: string): boolean {
  const info = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);

  return info.changes > 0;
}

export function enableTask(db: SeenDb, id: string): boolean {
  const task = getTask(db, id);

  if (!task || task.enabled) {
    return false;
  }

  const runCount = getTaskRunCount(db, id);
  const next_run_at = getNextRunAt(task, undefined, runCount);

  if (next_run_at == null) {
    return false;
  }

  db.prepare('UPDATE tasks SET enabled = 1, next_run_at = ? WHERE id = ?').run(next_run_at, id);

  return true;
}

export function disableTask(db: SeenDb, id: string): boolean {
  const info = db.prepare('UPDATE tasks SET enabled = 0, next_run_at = NULL WHERE id = ?').run(id);

  return info.changes > 0;
}

/**
 * List task IDs that are enabled and due (next_run_at <= now).
 */
export function listDueTasks(db: SeenDb): Task[] {
  const now = Date.now();

  const rows = db
    .prepare(
      'SELECT * FROM tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?',
    )
    .all(now) as Record<string, unknown>[];

  return rows.map(rowToTask);
}

export function updateTaskRunTimes(
  db: SeenDb,
  taskId: string,
  lastRunAt: number,
  nextRunAt: number | null,
): void {
  db.prepare('UPDATE tasks SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(
    lastRunAt,
    nextRunAt,
    taskId,
  );
}

export function insertTaskRun(db: SeenDb, taskId: string): number {
  const now = Date.now();

  const info = db
    .prepare(
      'INSERT INTO task_runs (task_id, started_at, finished_at, status, output, error) VALUES (?, ?, NULL, ?, NULL, NULL)',
    )
    .run(taskId, now, 'running');

  return info.lastInsertRowid as number;
}

export function updateTaskRun(
  db: SeenDb,
  runId: number,
  status: TaskRunStatus,
  output: string | null,
  error: string | null,
  budgetUsedMsats: number | null,
): void {
  const now = Date.now();

  db.prepare(
    'UPDATE task_runs SET finished_at = ?, status = ?, output = ?, error = ?, budget_used_msats = ? WHERE id = ?',
  ).run(now, status, output ?? null, error ?? null, budgetUsedMsats, runId);
}

export function listTaskRuns(db: SeenDb, taskId: string, limit: number): TaskRun[] {
  const rows = db
    .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT ?')
    .all(taskId, limit) as Record<string, unknown>[];

  return rows.map(rowToTaskRun);
}
