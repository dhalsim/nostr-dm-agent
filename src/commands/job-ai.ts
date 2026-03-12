// ---------------------------------------------------------------------------
// commands/job-ai.ts — !job-ai <natural language prompt>
//
// Universal NL entry point for jobs (like !todo-ai for todos). AI suggests
// job params (cron or one-time); we store a draft in the DB and return a
// preview. User confirms/revises/discards via !job confirm/revise/discard.
// ---------------------------------------------------------------------------
import type { AgentBackend } from '../backends/types';
import { getAgentBackend, getModelOverride, getProviderName, getRoutstrModel } from '../db';
import type { SeenDb } from '../db';
import { storeDraft } from '../jobs/drafts';

import {
  buildJobCreateSystemPrompt,
  formatCreateWithPreview,
  generateCreateWithParams,
} from './jobs';

export type HandleJobAiProps = {
  args: string[];
  db: SeenDb;
  backend: AgentBackend;
  sessionId: string;
  cwd: string;
  agentEnv: Record<string, string | undefined>;
};

export async function handleJobAi({
  args,
  db,
  backend,
  sessionId,
  cwd,
  agentEnv,
}: HandleJobAiProps): Promise<string> {
  const userPrompt = args.join(' ').trim();

  if (!userPrompt) {
    return 'Usage: !job-ai <natural language request>\nExample: !job-ai send me a morning brief every day at 8am';
  }

  const defaults = {
    backend: getAgentBackend(db),
    provider: getProviderName(db),
    model: getRoutstrModel(db) ?? getModelOverride(db) ?? backend.modelName ?? '',
    mode: 'agent',
  };

  const systemPrompt = buildJobCreateSystemPrompt(userPrompt, defaults);

  let input;

  try {
    input = await generateCreateWithParams({
      backend,
      sessionId,
      systemPrompt,
      cwd,
      agentEnv,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    return `Failed to generate or validate job parameters: ${msg}`;
  }

  const draftId = storeDraft(db, {
    kind: 'create',
    input,
    originalPrompt: userPrompt,
  });

  return formatCreateWithPreview(String(draftId), input);
}
