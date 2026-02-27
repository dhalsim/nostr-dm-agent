// ---------------------------------------------------------------------------
// backends/opencode.ts
// ---------------------------------------------------------------------------
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { spawn, spawnSync } from 'bun';

import type { AgentMode } from '../db';
import { debug, stripAnsi } from '../logger';

import type { AgentBackend, AgentRunResult, CreateSessionProps, RunMessageProps } from './types';

export function parseOpenCodeJsonl(raw: string): AgentRunResult {
  const lines = raw.trim().split('\n').filter(Boolean);
  let sessionId = '';
  const textParts: string[] = [];
  let tokens: AgentRunResult['tokens'];
  let cost: number | undefined;

  for (const line of lines) {
    try {
      const evt = JSON.parse(line) as {
        type: string;
        sessionID?: string;
        part?: {
          text?: string;
          tokens?: { input: number; output: number; total: number };
          cost?: number;
        };
      };

      if (!sessionId && evt.sessionID) {
        sessionId = evt.sessionID;
      }

      if (evt.type === 'text' && evt.part?.text) {
        textParts.push(stripAnsi(evt.part.text));
      }

      if (evt.type === 'step_finish' && evt.part) {
        const t = evt.part.tokens;

        if (t) {
          if (!tokens) {
            tokens = { input: 0, output: 0, total: 0 };
          }

          tokens.input += t.input ?? 0;
          tokens.output += t.output ?? 0;
          tokens.total += t.total ?? 0;
        }

        if (evt.part.cost != null) {
          cost = (cost ?? 0) + evt.part.cost;
        }
      }
    } catch {
      /* Skip malformed lines */
    }
  }

  return { output: textParts.join('') || '(no output)', sessionId, tokens, cost };
}

type ParseModelProps = {
  dmBotRoot: string;
  mode: AgentMode;
  modelOverride?: string | null;
};

function parseModel({ dmBotRoot, mode, modelOverride }: ParseModelProps): string {
  if (modelOverride) {
    debug(`Using model override: ${modelOverride}`);

    return modelOverride;
  }

  let modelName = 'opencode/big-pickle';

  try {
    const cfgPath = join(dmBotRoot, 'opencode.json');

    if (existsSync(cfgPath)) {
      debug(`opencode.json found in ${cfgPath}`);

      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
        agent?: Record<string, { model?: string }>;
      };

      const configured = cfg.agent?.[mode]?.model;

      if (configured) {
        modelName = configured;
        debug(`Using model from opencode.json for mode '${mode}': ${modelName}`);
      } else {
        debug(`No model configured in opencode.json for mode '${mode}', using '${modelName}'`);
      }
    } else {
      debug(`opencode.json not found in ${cfgPath}`);
    }
  } catch {
    debug(`Failed to read opencode.json in ${dmBotRoot}`);
  }

  return modelName;
}

type CreateOpenCodeBackendProps = {
  dmBotRoot: string;
  mode: AgentMode;
  attachUrl: string | null;
  modelOverride?: string | null;
};

export function createOpenCodeBackend({
  dmBotRoot,
  mode,
  attachUrl,
  modelOverride,
}: CreateOpenCodeBackendProps): AgentBackend {
  const modelName = parseModel({ dmBotRoot, mode, modelOverride });

  return {
    name: 'opencode',
    modelName,

    createSession({ cwd, env }: CreateSessionProps): string {
      const args = [
        'opencode',
        'run',
        'Session initialized. Waiting for instructions.',
        '--format',
        'json',
      ];

      if (attachUrl) {
        args.push('--attach', attachUrl);
      }

      const proc = spawnSync(args, { cwd, stdout: 'pipe', stderr: 'pipe', env });
      const out = proc.stdout?.toString().trim() ?? '';
      const parsed = parseOpenCodeJsonl(out);

      if (!parsed.sessionId) {
        throw new Error(
          `opencode session creation failed: ${out || proc.stderr?.toString() || 'no output'}`,
        );
      }

      return parsed.sessionId;
    },

    async runMessage({
      sessionId,
      content,
      mode: runMode,
      cwd,
      env,
    }: RunMessageProps): Promise<AgentRunResult> {
      const args = [
        'opencode',
        'run',
        content,
        '--format',
        'json',
        '--session',
        sessionId,
        '--agent',
        runMode,
      ];

      if (attachUrl) {
        args.push('--attach', attachUrl);
      }

      debug('opencode args: ', args.join(' '));

      const proc = spawn({ cmd: args, cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env });
      await proc.exited;
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();

      const result = parseOpenCodeJsonl(out);

      if (result.output === '(no output)' && err.trim()) {
        result.output = stripAnsi(err.trim());
      }

      if (!result.sessionId) {
        result.sessionId = sessionId;
      }

      result.model = modelName;

      return result;
    },

    async availableModels(): Promise<string[]> {
      const proc = spawn(['opencode', 'models'], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      });

      await proc.exited;
      const out = await new Response(proc.stdout).text();

      const lines = out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      return lines;
    },
  };
}
