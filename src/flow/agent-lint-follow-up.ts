// ---------------------------------------------------------------------------
// src/flow/agent-lint-follow-up.ts — Run agent round(s) with optional lint follow-up
// ---------------------------------------------------------------------------

import { createBackend } from '../backends/factory';
import type { AgentRunResult } from '../backends/types';
import { getAgentBackend, getLinting, getModelOverride, getRoutstrModel } from '../db';
import type { AgentMode, SeenDb } from '../db';
import { runPostAgentLint, formatLintSummary } from '../lint';
import { C, log } from '../logger';
import type { ProviderName } from '../providers/types';
import { insertSessionMessage } from '../session';

const POST_AGENT_LINT_PROMPT_PREFIX = '[Post-edit lint feedback]';

export type RunAgentWithLintFollowUpProps = {
  dmBotRoot: string;
  attachUrl: string | null;
  mode: AgentMode;
  configuredProviderName: ProviderName | null;
  sessionId: string;
  cwd: string;
  getAgentEnv: () => Record<string, string | undefined>;
  seenDb: SeenDb;
  effectiveContent: string;
  currentWorkspace: string;
  backendName: string;
};

export async function runAgentWithLintFollowUp({
  dmBotRoot,
  attachUrl,
  mode,
  configuredProviderName,
  sessionId,
  cwd,
  getAgentEnv,
  seenDb,
  effectiveContent,
  currentWorkspace,
  backendName,
}: RunAgentWithLintFollowUpProps): Promise<{ output: string; result: AgentRunResult }> {
  const runAgentRound = async (roundContent: string, startLog: string): Promise<AgentRunResult> => {
    log.info(startLog);

    const modelOverride = getModelOverride(seenDb);
    const backendNameFromDb = getAgentBackend(seenDb);
    const routstrModel = getRoutstrModel(seenDb);

    const finalModelOverride =
      configuredProviderName === 'routstr' && routstrModel
        ? `routstr/${routstrModel}`
        : (modelOverride ?? null);

    log.info(`finalModelOverride: ${finalModelOverride}`);

    const roundBackend = createBackend({
      backendName: backendNameFromDb,
      dmBotRoot,
      mode,
      attachUrl,
      modelOverride: finalModelOverride,
      providerName: configuredProviderName,
    });

    return roundBackend.runMessage({
      sessionId,
      content: roundContent,
      mode,
      cwd,
      env: getAgentEnv(),
      modelOverride: finalModelOverride,
    });
  };

  const initialResult = await runAgentRound(
    effectiveContent,
    `${C.dim}Starting ${backendName} agent (${mode})…${C.reset}\n`,
  );

  let finalOutput = initialResult.output;
  let finalResult = initialResult;

  if (initialResult.type === 'error') {
    return { output: finalOutput, result: finalResult };
  }

  const linting = getLinting(seenDb);

  if (mode !== 'agent' || linting === 'off') {
    return { output: finalOutput, result: finalResult };
  }

  const lintLabel = currentWorkspace === 'bot' ? 'dm-bot' : 'workspace';
  const lintResult = runPostAgentLint({ cwd, label: lintLabel });

  if (!lintResult.available) {
    log.error(
      `Skipping post-agent lint: bun run lint is unavailable in this runtime for ${lintLabel}.`,
    );

    return { output: finalOutput, result: finalResult };
  }

  const lintSummary = formatLintSummary(lintResult);
  finalOutput = `${initialResult.output}\n\n${lintSummary}`;
  const lintFailed = lintResult.exitCode !== 0;

  if (!lintFailed) {
    return { output: finalOutput, result: finalResult };
  }

  const lintPrompt = `${POST_AGENT_LINT_PROMPT_PREFIX}\n${lintSummary}\n\nFix any lint issues and provide your final summary.`;
  insertSessionMessage(seenDb, sessionId, 'user', lintPrompt);

  try {
    const fixResult = await runAgentRound(
      lintPrompt,
      `${C.dim}Starting ${backendName} agent (lint feedback)…${C.reset}\n`,
    );

    finalOutput = `${finalOutput}\n\n${fixResult.output}`;
    finalResult = fixResult;
  } catch (lintFollowupErr) {
    log.error(`Lint follow-up agent process error: ${String(lintFollowupErr)}`);
    finalOutput = `${finalOutput}\n\nAutomatic lint-fix round failed: ${String(lintFollowupErr)}`;
  }

  return { output: finalOutput, result: finalResult };
}
