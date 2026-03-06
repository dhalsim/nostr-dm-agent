// ---------------------------------------------------------------------------
// scripts/create-task.ts — CLI to create a task (Zod-validated, writes to DB)
// ---------------------------------------------------------------------------
import { parseCreateArgs } from '../src/commands/tasks';
import { openSeenDb } from '../src/db';
import { createTask } from '../src/tasks/db';
import { CreateTaskInputSchema } from '../src/tasks/types';

function main(): void {
  const args = process.argv.slice(2);
  const parsed = parseCreateArgs(args);

  const name = parsed['name']?.trim() ?? '';
  const prompt = parsed['prompt']?.trim() ?? '';
  const backend = parsed['backend']?.trim() || 'cursor';
  const provider = parsed['provider']?.trim() || 'local';
  const model = parsed['model']?.trim() ?? '';
  const mode = parsed['mode']?.trim() || 'agent';
  const budgetRaw = parsed['budget']?.trim() ?? parsed['budget_sats']?.trim() ?? '';
  const budgetNum = budgetRaw === '' ? null : parseInt(budgetRaw, 10);
  if (
    budgetRaw !== '' &&
    (budgetNum === null || Number.isNaN(budgetNum) || budgetNum <= 0)
  ) {
    console.error('Invalid budget: must be a positive integer (sats).');
    process.exit(1);
  }
  const budget_sats = budgetNum;
  const instructionsRaw =
    parsed['instructions']?.trim() ?? parsed['instruct']?.trim() ?? '';
  const instructions = instructionsRaw === '' ? null : instructionsRaw;

  const runAtRaw = parsed['run-at']?.trim() ?? '';
  const scheduleRaw = parsed['schedule']?.trim() ?? '';

  let raw: Parameters<typeof CreateTaskInputSchema.safeParse>[0];

  if (runAtRaw) {
    const run_at = new Date(runAtRaw);
    if (Number.isNaN(run_at.getTime())) {
      console.error('Invalid --run-at: use an ISO 8601 date string (e.g. 2025-03-10T09:00:00Z).');
      process.exit(1);
    }
    raw = {
      execution_type: 'one-time',
      run_at,
      name,
      prompt,
      backend,
      provider,
      model,
      mode,
      budget_sats,
      instructions,
    };
  } else {
    if (!scheduleRaw) {
      console.error('Provide either --schedule <cron> or --run-at <ISO date>.');
      process.exit(1);
    }
    const maxRunsRaw = parsed['maxruns']?.trim() ?? parsed['max_runs']?.trim() ?? '';
    const maxRunsParsed =
      maxRunsRaw === '' ? null : parseInt(maxRunsRaw, 10);
    const maxRunsVal: number | null =
      maxRunsParsed != null && !Number.isNaN(maxRunsParsed) && maxRunsParsed > 0
        ? maxRunsParsed
        : maxRunsRaw === ''
          ? null
          : null;
    if (maxRunsRaw !== '' && maxRunsVal === null) {
      console.error('Invalid max_runs: must be a positive integer.');
      process.exit(1);
    }
    raw = {
      execution_type: 'cron',
      schedule: scheduleRaw,
      maxRuns: maxRunsVal,
      name,
      prompt,
      backend,
      provider,
      model,
      mode,
      budget_sats,
      instructions,
    };
  }

  const result = CreateTaskInputSchema.safeParse(raw);

  if (!result.success) {
    const msg = result.error.flatten().fieldErrors;
    const lines = Object.entries(msg)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\n');
    console.error('Validation failed:\n' + lines);
    process.exit(1);
  }

  const input = result.data;

  const db = openSeenDb();

  try {
    const task = createTask(db, input);
    if (task.execution_type === 'one-time') {
      console.log(
        `Task created: ${task.id}\nName: ${task.name}\nRun at: ${task.run_at != null ? new Date(task.run_at).toISOString() : '—'}`,
      );
    } else {
      console.log(
        `Task created: ${task.id}\nName: ${task.name}\nSchedule: ${task.schedule}`,
      );
    }
  } catch (err) {
    console.error(String(err));
    process.exit(1);
  }
}

main();
