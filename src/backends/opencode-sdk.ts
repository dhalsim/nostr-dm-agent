// ---------------------------------------------------------------------------
// backends/opencode-sdk.ts — OpenCode via @opencode-ai/sdk (in-process server)
// ---------------------------------------------------------------------------
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { createOpencode } from '@opencode-ai/sdk';

import type { AgentMode } from '../db';
import { debug, log, stripAnsi } from '../logger';
import type { ProviderName } from '../providers/types';

import type {
  AgentBackend,
  AgentErrorResult,
  AgentRunResult,
  AgentSuccessResult,
  CreateSessionProps,
  RunMessageProps,
} from './types';

type SdkInstance = Awaited<ReturnType<typeof createOpencode>>;

let sdk: SdkInstance | null = null;

const DEFAULT_PORTS = [4096, 4097, 4098, 4099];

function getPortsToTry(): number[] {
  const envPort = process.env.OPENCODE_SDK_PORT;

  if (envPort !== undefined && envPort !== '') {
    const n = parseInt(envPort, 10);

    if (Number.isNaN(n) || n < 1 || n > 65535) {
      log.warn(`opencode-sdk: invalid OPENCODE_SDK_PORT "${envPort}", using default ports`);

      return DEFAULT_PORTS;
    }

    return [n];
  }

  return DEFAULT_PORTS;
}

function applyEnvToProcess(env: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) {
      process.env[k] = v;
    }
  }
}

async function getOrInitSdk(env?: Record<string, string | undefined>): Promise<SdkInstance> {
  if (env) {
    applyEnvToProcess(env);
  }

  if (sdk) {
    return sdk;
  }

  const ports = getPortsToTry();
  let lastError: Error | null = null;

  for (const port of ports) {
    try {
      sdk = await createOpencode({ port, hostname: '127.0.0.1' });
      debug(`opencode-sdk: server started on port ${port}`);

      return sdk;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (port === ports[ports.length - 1]) {
        break;
      }

      debug(`opencode-sdk: port ${port} failed, trying next: ${lastError.message}`);
    }
  }

  const hint =
    ports.length === 1
      ? `Port ${ports[0]} may be in use. Set OPENCODE_SDK_PORT to another port, or stop any running "opencode serve".`
      : `Ports ${ports.join(', ')} failed. Set OPENCODE_SDK_PORT to a free port, or stop any running "opencode serve".`;

  throw new Error(
    `OpenCode SDK server failed to start: ${lastError?.message ?? 'unknown'}.\n${hint}`,
  );
}

function parseModel({
  dmBotRoot,
  mode,
  modelOverride,
  providerName,
}: {
  dmBotRoot: string;
  mode: AgentMode;
  modelOverride: string | null | undefined;
  providerName: ProviderName | null;
}): string {
  if (modelOverride) {
    debug(`opencode-sdk: using model override: ${modelOverride}`);

    return modelOverride;
  }

  let modelName = 'opencode/big-pickle';

  try {
    const cfgPath = join(dmBotRoot, 'opencode.json');

    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
        agent?: Record<string, { model?: string }>;
      };

      const configured = cfg.agent?.[mode]?.model;

      if (configured) {
        modelName = configured;
      }
    }
  } catch {
    // use default
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

function modelToProviderAndId(modelStr: string): { providerID: string; modelID: string } {
  const slash = modelStr.indexOf('/');

  if (slash === -1) {
    return { providerID: 'opencode', modelID: modelStr };
  }

  return {
    providerID: modelStr.slice(0, slash),
    modelID: modelStr.slice(slash + 1),
  };
}

type CreateOpencodeSDKBackendProps = {
  dmBotRoot: string;
  mode: AgentMode;
  modelOverride: string | null | undefined;
  providerName: ProviderName | null;
};

export function createOpencodeSDKBackend({
  dmBotRoot,
  mode,
  modelOverride,
  providerName,
}: CreateOpencodeSDKBackendProps): AgentBackend {
  const modelName = parseModel({ dmBotRoot, mode, modelOverride, providerName });

  return {
    name: 'opencode-sdk',
    modelName,

    async createSession({ cwd, env }: CreateSessionProps): Promise<string> {
      const { client } = await getOrInitSdk(env);

      const result = await client.session.create({
        body: {},
        query: { directory: cwd },
      });

      if (result.error) {
        const msg =
          typeof result.error === 'object' && result.error !== null && 'data' in result.error
            ? String(
                (result.error as { data?: { message?: string } }).data?.message ?? result.error,
              )
            : String(result.error);

        throw new Error(`opencode-sdk session create failed: ${msg}`);
      }

      const session = result.data as { id: string };

      if (!session?.id) {
        throw new Error('opencode-sdk session create: no session id in response');
      }

      return session.id;
    },

    async runMessage({
      sessionId,
      content,
      mode: runMode,
      cwd,
      env,
      modelOverride: runModelOverride,
    }: RunMessageProps): Promise<AgentRunResult> {
      const { client } = await getOrInitSdk(env);

      const effectiveModel = runModelOverride ?? modelName;
      const model = modelToProviderAndId(effectiveModel);

      const agent = runMode === 'agent' ? 'build' : runMode;

      const result = await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: 'text', text: content }],
          model,
          agent,
        },
        query: { directory: cwd },
      });

      if (result.error) {
        const err = result.error as
          | { data?: { message?: string }; statusCode?: number }
          | undefined;

        debug('opencode-sdk prompt error:', {
          statusCode: err?.statusCode,
          data: err?.data,
          raw: result.error,
        });

        const output = err?.data?.message ?? String(result.error);
        const statusCode = err?.statusCode;

        return {
          type: 'error',
          output: stripAnsi(output),
          sessionId,
          statusCode,
        } satisfies AgentErrorResult;
      }

      const data = result.data as
        | {
            info: { cost?: number; tokens?: { input: number; output: number } };
            parts: Array<{ type: string; text?: string }>;
          }
        | undefined;

      if (!data) {
        debug('opencode-sdk prompt: result.data missing, raw result:', JSON.stringify(result));

        return {
          type: 'success',
          output: '(no output)',
          sessionId,
          model: effectiveModel,
        };
      }

      const textParts = (data.parts ?? [])
        .filter(
          (p): p is { type: string; text: string } =>
            p.type === 'text' && typeof p.text === 'string',
        )
        .map((p) => stripAnsi(p.text));

      const output = textParts.join('') || '(no output)';

      if (output === '(no output)') {
        debug('opencode-sdk prompt: no text in parts', {
          partsLength: data.parts?.length ?? 0,
          parts: data.parts,
          info: data.info,
        });
      }

      const info = data.info;

      const tokens = info?.tokens
        ? {
            input: info.tokens.input ?? 0,
            output: info.tokens.output ?? 0,
            total: (info.tokens.input ?? 0) + (info.tokens.output ?? 0),
          }
        : undefined;

      const cost = info?.cost;

      return {
        type: 'success',
        output,
        sessionId,
        model: effectiveModel,
        tokens,
        cost,
      } satisfies AgentSuccessResult;
    },

    async availableModels(): Promise<string[]> {
      const { client } = await getOrInitSdk();

      const result = await client.config.providers({});

      if (result.error || !result.data) {
        return [];
      }

      const data = result.data as {
        providers?: Array<{ id: string; models?: Record<string, unknown> }>;
      };

      const list: string[] = [];

      for (const provider of data.providers ?? []) {
        const providerId = provider.id ?? '';

        for (const modelId of Object.keys(provider.models ?? {})) {
          list.push(`${providerId}/${modelId}`);
        }
      }

      return list.sort();
    },
  };
}
