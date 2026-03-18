// ---------------------------------------------------------------------------
// jobs/types.ts — Job and JobRun types
// ---------------------------------------------------------------------------
import { z } from 'zod';

import type { AgentBackendName, AgentMode, ProviderName, WorkspaceTarget } from '../db';
import {
  AgentBackendNameSchema,
  AgentModeSchema,
  ProviderNameSchema,
  WorkspaceTargetSchema,
} from '../db';

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
  workspace_target: WorkspaceTarget;
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

// Schemas (source of truth for validation and inferred types)
const JobInputSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  schedule_description: z.string().min(1),
  backend: AgentBackendNameSchema,
  provider: ProviderNameSchema,
  model: z.string(),
  mode: AgentModeSchema,
  workspace_target: WorkspaceTargetSchema,
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

// Types inferred from schemas
export type JobInput = z.infer<typeof JobInputSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
export type OneTime = z.infer<typeof OneTimeSchema>;
export type CreateJobInput = z.infer<typeof CreateJobInputSchema>;
