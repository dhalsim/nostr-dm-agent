// ---------------------------------------------------------------------------
// backends/opencode.ts
// ---------------------------------------------------------------------------
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { spawn, spawnSync } from 'bun';
import { z } from 'zod';

import type { AgentMode } from '../db';
import { debug, debugAsync, log, stripAnsi } from '../logger';
import type { ProviderName } from '../providers/types';

import type {
  AgentBackend,
  AgentErrorResult,
  AgentRunResult,
  AgentSuccessResult,
  CreateSessionProps,
  RunMessageProps,
} from './types';

const baseEventSchema = z
  .object({
    type: z.string(),
    timestamp: z.number().optional(),
    sessionID: z.string().optional(),
  })
  .passthrough();

const errorEventSchema = baseEventSchema.extend({
  type: z.literal('error'),
  error: z
    .object({
      name: z.string(),
      data: z
        .object({
          message: z.string(),
          statusCode: z.number().optional(),
          responseBody: z.string().optional(),
        })
        .passthrough(),
    })
    .passthrough(),
});

const textEventSchema = baseEventSchema.extend({
  type: z.literal('text'),
  part: z
    .object({
      text: z.string(),
    })
    .passthrough(),
});

const stepFinishEventSchema = baseEventSchema.extend({
  type: z.literal('step_finish'),
  part: z
    .object({
      tokens: z
        .object({
          input: z.number(),
          output: z.number(),
          total: z.number(),
        })
        .optional(),
      cost: z.number().optional(),
    })
    .passthrough(),
});

const stepStartEventSchema = baseEventSchema.extend({
  type: z.literal('step_start'),
  part: z.object({}).passthrough().optional(),
});

const toolUseEventSchema = baseEventSchema
  .extend({
    type: z.literal('tool_use'),
    name: z.string().optional(),
    tool: z.string().optional(),
    part: z
      .object({
        name: z.string().optional(),
        tool: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const MAX_DEBUG_TEXT_LEN = 30;

function truncate(s: string): string {
  return s.length > MAX_DEBUG_TEXT_LEN ? s.slice(0, MAX_DEBUG_TEXT_LEN) + '...' : s;
}

function truncateTextInParsedLine(line: string): string {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    const part = o?.part as Record<string, unknown> | undefined;

    if (typeof part?.text === 'string') {
      part.text = truncate(part.text);
    }

    if (o?.type === 'tool_use') {
      const state = part?.state as Record<string, unknown> | undefined;

      if (typeof state?.output === 'string') {
        state.output = truncate(state.output);
      }
    }

    return JSON.stringify(o, null, 2);
  } catch {
    return line;
  }
}

export function parseOpenCodeJsonl(raw: string): AgentRunResult {
  const lines = raw.trim().split('\n').filter(Boolean);

  debug(`opencode raw JSONL:\n${lines.map(truncateTextInParsedLine).join('\n')}`);

  let sessionId = '';
  const textParts: string[] = [];
  let tokens: AgentSuccessResult['tokens'];
  let cost: number | undefined;
  let errorResult: AgentErrorResult | null = null;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log.warn(
        `opencode: malformed JSONL line (skipped): ${line.slice(0, 120)}${line.length > 120 ? '…' : ''}`,
      );

      continue;
    }

    const base = baseEventSchema.safeParse(parsed);

    if (!base.success) {
      log.warn(
        `opencode: unknown event shape (skipped): ${base.error.message} — ${line.slice(0, 80)}…`,
      );

      continue;
    }

    if (!sessionId && base.data.sessionID) {
      sessionId = base.data.sessionID;
    }

    switch (base.data.type) {
      case 'error': {
        const err = errorEventSchema.safeParse(parsed);

        if (err.success) {
          errorResult = {
            type: 'error',
            output: err.data.error.data.message,
            sessionId: sessionId || '',
            statusCode: err.data.error.data.statusCode,
          };
        } else {
          log.warn(`opencode: error event with unexpected shape: ${err.error.message}`);
        }

        break;
      }

      case 'text': {
        const txt = textEventSchema.safeParse(parsed);

        if (txt.success) {
          textParts.push(stripAnsi(txt.data.part.text));
        } else {
          log.warn(`opencode: text event with unexpected shape: ${txt.error.message}`);
        }

        break;
      }

      case 'step_finish': {
        const sf = stepFinishEventSchema.safeParse(parsed);

        if (sf.success && sf.data.part) {
          const t = sf.data.part.tokens;

          if (t) {
            if (!tokens) {
              tokens = { input: 0, output: 0, total: 0 };
            }

            tokens.input += t.input;
            tokens.output += t.output;
            tokens.total += t.total;
          }

          if (sf.data.part.cost != null) {
            cost = (cost ?? 0) + sf.data.part.cost;
          }
        } else if (!sf.success) {
          log.warn(`opencode: step_finish event with unexpected shape: ${sf.error.message}`);
        }

        break;
      }

      case 'step_start':
        stepStartEventSchema.safeParse(parsed);
        break;

      case 'tool_use': {
        const tu = toolUseEventSchema.safeParse(parsed);

        if (tu.success) {
          const toolName =
            tu.data.name ?? tu.data.tool ?? tu.data.part?.name ?? tu.data.part?.tool ?? 'unknown';

          log.info(`tool used: ${toolName}`);
        }

        break;
      }

      default:
        log.warn(`opencode: unknown event type "${base.data.type}" (skipped)`);
    }
  }

  if (errorResult) {
    if (!errorResult.sessionId) {
      errorResult.sessionId = sessionId;
    }

    return errorResult;
  }

  return {
    type: 'success',
    output: textParts.join('') || '(no output)',
    sessionId,
    tokens,
    cost,
  };
}

type ParseModelProps = {
  dmBotRoot: string;
  mode: AgentMode;
  modelOverride: string | null | undefined;
  providerName: ProviderName | null;
};

function parseModel({ dmBotRoot, mode, modelOverride, providerName }: ParseModelProps): string {
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

  if (providerName === 'routstr' && !modelName.startsWith('routstr/')) {
    log.warn(
      `provider is routstr but resolved model "${modelName}" lacks routstr/ prefix — this will likely fail`,
    );
  }

  if (providerName === 'local' && modelName.startsWith('routstr/')) {
    log.warn(
      `provider is local but resolved model "${modelName}" has routstr/ prefix — this will likely fail`,
    );
  }

  return modelName;
}

type CreateOpenCodeBackendProps = {
  dmBotRoot: string;
  mode: AgentMode;
  attachUrl: string | null;
  modelOverride: string | null | undefined;
  providerName: ProviderName | null;
};

export function createOpenCodeBackend({
  dmBotRoot,
  mode,
  attachUrl,
  modelOverride,
  providerName,
}: CreateOpenCodeBackendProps): AgentBackend {
  const modelName = parseModel({ dmBotRoot, mode, modelOverride, providerName });

  return {
    name: 'opencode',
    modelName,

    async createSession({ cwd, env }: CreateSessionProps): Promise<string> {
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

      if (parsed.type === 'error') {
        throw new Error(`opencode session creation failed: ${parsed.output}`);
      }

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
      modelOverride,
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

      if (modelOverride) {
        args.push('--model', modelOverride);
      }

      const argsDisplay = args.reduce<string[]>((acc, arg, i, arr) => {
        const prev = arr[i - 1];

        const isContent =
          prev === 'run' || (i > 0 && !prev?.startsWith('--') && arr[i - 2] === 'run');

        acc.push(isContent ? `"${arg}"` : arg);

        return acc;
      }, []);

      debugAsync(async () => `opencode args: ${argsDisplay.join(' ')}`);

      const proc = spawn({ cmd: args, cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env });
      await proc.exited;
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();

      const result = parseOpenCodeJsonl(out);

      if (result.type === 'error') {
        if (!result.sessionId) {
          result.sessionId = sessionId;
        }

        return result;
      }

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
