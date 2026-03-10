// ---------------------------------------------------------------------------
// jobs/types.ts — Job and JobRun types
// ---------------------------------------------------------------------------
import { z } from 'zod';

import { AgentBackendNameSchema, AgentModeSchema, ProviderNameSchema } from '../db';
import type { AgentBackendName, AgentMode, ProviderName } from '../db';

export type JobRunStatus = 'running' | 'success' | 'error';

export type Job = {
  id: number;
  name: string;
  schedule: string;
  schedule_description: string;
  prompt: string;
  enabled: number;
  created_at: number;
  last_run_at: number | null;
  next_run_at: number | null;
  backend: AgentBackendName;
  provider: ProviderName;
  model: string;
  mode: AgentMode;
  budget_sats: number | null;
  instructions: string | null;
  execution_type: 'cron' | 'one-time';
  run_at: number | null;
  max_runs: number | null;
};

export type JobRun = {
  id: number;
  job_id: number;
  started_at: number;
  finished_at: number | null;
  status: JobRunStatus;
  output: string | null;
  error: string | null;
  budget_used_msats: number | null;
};

export type JobInput = {
  name: string;
  prompt: string;
  schedule_description: string;
  backend: AgentBackendName;
  provider: ProviderName;
  model: string;
  mode: AgentMode;
  budget_sats: number | null;
  instructions: string | null;
};

export type Schedule = JobInput & {
  execution_type: 'cron';
  schedule: string;
  maxRuns: number | null;
};

export type OneTime = JobInput & {
  execution_type: 'one-time';
  run_at: string;
};

export type CreateJobInput = Schedule | OneTime;

const JobInputSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  schedule_description: z.string().min(1),
  backend: AgentBackendNameSchema,
  provider: ProviderNameSchema,
  model: z.string(),
  mode: AgentModeSchema,
  budget_sats: z.number().int().positive().nullable(),
  instructions: z.string().nullable(),
});

export const ScheduleSchema = JobInputSchema.extend({
  execution_type: z.literal('cron'),
  schedule: z.string().min(1),
  maxRuns: z.number().int().positive().nullable(),
});

export const OneTimeSchema = JobInputSchema.extend({
  execution_type: z.literal('one-time'),
  run_at: z.iso.datetime().describe('ISO 8601 datetime string in UTC e.g. 2025-12-01T09:00:00Z'),
});

export const CreateJobInputSchema = z.discriminatedUnion('execution_type', [
  ScheduleSchema,
  OneTimeSchema,
]);
