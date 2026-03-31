// ---------------------------------------------------------------------------
// src/flow/agent-lint-follow-up.ts — Run agent round(s) with optional lint follow-up
// ---------------------------------------------------------------------------

import { createBackend } from '../backends/factory';
import type { AgentRunResult } from '../backends/types';
import { getOutputString } from '../backends/types';
import type { AgentBackendName, AgentMode, CoreDb } from '../db';
import {
  getAgentBackend,
  getLinting,
  getModelOverride,
  getRoutstrModel,
  getRoutstrSkKey,
} from '../db';
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
  coreDb: CoreDb;
  effectiveContent: string;
  currentWorkspace: string;
  backendName: AgentBackendName;
};

export async function runAgentWithLintFollowUp({
  dmBotRoot,
  attachUrl,
  mode,
  configuredProviderName,
  sessionId,
  cwd,
  coreDb,
  effectiveContent,
  currentWorkspace,
  backendName,
}: RunAgentWithLintFollowUpProps): Promise<{
  output: string;
  result: AgentRunResult;
}> {
  const runAgentRound = async (
    roundContent: string,
    startLog: string,
  ): Promise<AgentRunResult> => {
    log.info(startLog);

    const backendNameFromDb = getAgentBackend(coreDb);
    const modelOverride = getModelOverride(coreDb, backendNameFromDb);
    const routstrModel = getRoutstrModel(coreDb);

    const effectiveModelOverride =
      configuredProviderName === 'routstr' && routstrModel
        ? routstrModel
        : (modelOverride ?? null);

    log.info(`effectiveModelOverride: ${effectiveModelOverride}`);

    const roundBackend = createBackend({
      backendName: backendNameFromDb,
      dmBotRoot,
      mode,
      attachUrl,
      modelOverride: effectiveModelOverride,
      providerName: configuredProviderName,
    });

    return roundBackend.runMessage({
      sessionId,
      content: roundContent,
      mode,
      cwd,
      getRoutstrSkKey: () => getRoutstrSkKey(coreDb),
      modelOverride: effectiveModelOverride,
    });
  };

  const initialResult = await runAgentRound(
    effectiveContent,
    `${C.dim}Starting ${backendName} agent (${mode})…${C.reset}\n`,
  );

  let finalOutput = getOutputString(initialResult);
  let finalResult = initialResult;

  if (initialResult.type === 'error') {
    return { output: finalOutput, result: finalResult };
  }

  const linting = getLinting(coreDb);

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
  finalOutput = `${getOutputString(initialResult)}\n\n${lintSummary}`;
  const lintFailed = lintResult.exitCode !== 0;

  if (!lintFailed) {
    return { output: finalOutput, result: finalResult };
  }

  const lintPrompt = `${POST_AGENT_LINT_PROMPT_PREFIX}\n${lintSummary}\n\nFix any lint issues and provide your final summary.`;
  insertSessionMessage(coreDb, sessionId, 'user', lintPrompt);

  try {
    const fixResult = await runAgentRound(
      lintPrompt,
      `${C.dim}Starting ${backendName} agent (lint feedback)…${C.reset}\n`,
    );

    finalOutput = `${finalOutput}\n\n${getOutputString(fixResult)}`;
    finalResult = fixResult;
  } catch (lintFollowupErr) {
    log.error(`Lint follow-up agent process error: ${String(lintFollowupErr)}`);
    finalOutput = `${finalOutput}\n\nAutomatic lint-fix round failed: ${String(lintFollowupErr)}`;
  }

  return { output: finalOutput, result: finalResult };
}
