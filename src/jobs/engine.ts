// ---------------------------------------------------------------------------
// jobs/engine.ts — Scheduler: every 60s check due jobs and run them
// ---------------------------------------------------------------------------
import type { CoreDb } from '../db';
import { log } from '../logger';

import { getNextRunAt, getJobRunCount, listDueJobs, updateJobRunTimes } from './db';
import type { Job } from './types';

const TICK_MS = 60_000;

export type JobEngineContext = {
  runJob: (job: Job, db: CoreDb) => Promise<void>;
};

export function createJobEngine(
  db: CoreDb,
  context: JobEngineContext,
): {
  start: () => void;
  stop: () => void;
} {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<void> {
    const due = listDueJobs(db);

    for (const job of due) {
      const startedAt = Date.now();

      try {
        await context.runJob(job, db);
      } catch (err) {
        log.error(`Job ${job.id} (${job.name}) run failed: ${String(err)}`);
      }

      const runCount = getJobRunCount(db, job.id);
      const nextRunAt = getNextRunAt(job, startedAt, runCount);
      updateJobRunTimes(db, job.id, startedAt, nextRunAt ?? null);
    }
  }

  function start(): void {
    if (intervalId != null) {
      return;
    }

    log.info('Job engine started (tick every 60s).');

    intervalId = setInterval(
      () => tick().catch((e) => log.error(`Job engine tick error: ${String(e)}`)),
      TICK_MS,
    );
  }

  function stop(): void {
    if (intervalId != null) {
      clearInterval(intervalId);
      intervalId = null;
      log.info('Job engine stopped.');
    }
  }

  return { start, stop };
}
