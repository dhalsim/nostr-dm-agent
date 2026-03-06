// ---------------------------------------------------------------------------
// tasks/engine.ts — Scheduler: every 60s check due tasks and run them
// ---------------------------------------------------------------------------
import type { SeenDb } from '../db';
import { log } from '../logger';

import { getNextRunAt, getTaskRunCount, listDueTasks, updateTaskRunTimes } from './db';
import type { Task } from './types';

const TICK_MS = 60_000;

export type TaskEngineContext = {
  runTask: (task: Task, db: SeenDb) => Promise<void>;
};

export function createTaskEngine(
  db: SeenDb,
  context: TaskEngineContext,
): {
  start: () => void;
  stop: () => void;
} {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<void> {
    const due = listDueTasks(db);

    for (const task of due) {
      const startedAt = Date.now();

      try {
        await context.runTask(task, db);
      } catch (err) {
        log.error(`Task ${task.id} (${task.name}) run failed: ${String(err)}`);
      }

      const runCount = getTaskRunCount(db, task.id);
      const nextRunAt = getNextRunAt(task, startedAt, runCount);
      updateTaskRunTimes(db, task.id, startedAt, nextRunAt ?? null);
    }
  }

  function start(): void {
    if (intervalId != null) {
      return;
    }

    log.info('Task engine started (tick every 60s).');

    intervalId = setInterval(
      () => tick().catch((e) => log.error(`Task engine tick error: ${String(e)}`)),
      TICK_MS,
    );
  }

  function stop(): void {
    if (intervalId != null) {
      clearInterval(intervalId);
      intervalId = null;
      log.info('Task engine stopped.');
    }
  }

  return { start, stop };
}
