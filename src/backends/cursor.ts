// ---------------------------------------------------------------------------
// backends/cursor.ts
// ---------------------------------------------------------------------------
import { spawn, spawnSync } from 'bun';

import type { AgentBackend, AgentRunResult, CreateSessionProps, RunMessageProps } from './types';

export function createCursorBackend(modelOverride?: string | null): AgentBackend {
  const effectiveModel = modelOverride ?? 'auto';

  return {
    name: 'cursor',
    modelName: effectiveModel,

    createSession({ cwd, env }: CreateSessionProps): string {
      const proc = spawnSync(['agent', 'create-chat'], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        env,
      });

      const out = proc.stdout?.toString().trim() ?? '';

      const id = out.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0];

      if (!id) {
        throw new Error(
          `agent create-chat failed or invalid output: ${out || proc.stderr?.toString() || 'no output'}`,
        );
      }

      return id;
    },

    async runMessage({
      sessionId,
      content,
      mode,
      cwd,
      env,
    }: RunMessageProps): Promise<AgentRunResult> {
      const baseArgs = [
        'agent',
        '-p',
        '--model',
        effectiveModel,
        '--workspace',
        cwd,
        '--trust',
        '--yolo',
      ];

      if (mode === 'ask') {
        baseArgs.push('--mode=ask');
      } else if (mode === 'plan') {
        baseArgs.push('--mode=plan');
      } else if (mode === 'agent' || mode === 'free') {
        baseArgs.push('-f');
      }

      baseArgs.push('--resume', sessionId, content);

      const proc = spawn({
        cmd: baseArgs,
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
        env,
      });

      await proc.exited;
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();

      return {
        output: (out + (err ? '\n' + err : '')).trim() || '(no output)',
        sessionId,
      };
    },

    async availableModels(): Promise<string[]> {
      const proc = spawn(['agent', '--list-models'], {
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
