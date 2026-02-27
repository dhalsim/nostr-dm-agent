import { existsSync, readFileSync, writeFileSync } from 'fs';

export type RoutstrModel = {
  id: string;
  name?: string;
  context_length?: number;
};

export async function fetchRoutstrModels(baseUrl: string): Promise<RoutstrModel[]> {
  const res = await fetch(`${baseUrl}/models`);

  if (!res.ok) {
    throw new Error(`/v1/models returned ${res.status}`);
  }

  const data = await res.json();

  return data.data ?? data.models ?? [];
}

export function buildRoutstrProviderConfig(models: RoutstrModel[]): object {
  const modelEntries = Object.fromEntries(
    models.map((m) => [
      m.id,
      {
        name: `${m.id} (Routstr)`,
        ...(m.context_length ? { limit: { context: m.context_length, output: 16384 } } : {}),
      },
    ]),
  );

  return {
    routstr: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Routstr (Cashu)',
      options: {
        baseURL: 'https://api.routstr.com/v1',
        apiKey: '{env:ROUTSTR_API_KEY}',
      },
      models: modelEntries,
    },
  };
}

export function patchOpencodeConfig(configPath: string, routstrBlock: object): void {
  let config: object;

  if (existsSync(configPath)) {
    const content = readFileSync(configPath, 'utf-8');
    try {
      config = JSON.parse(content);
    } catch {
      config = {};
    }
  } else {
    config = {
      $schema: 'https://opencode.ai/config.json',
    };
  }

  const merged = {
    ...config,
    provider: {
      ...(((config as Record<string, unknown>)?.provider as Record<string, unknown>) ?? {}),
      ...routstrBlock,
    },
  };

  writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n');
}
