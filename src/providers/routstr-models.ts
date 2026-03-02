export type RoutstrModel = {
  id: string;
  name?: string;
  context_length?: number;
};

const ROUTSTR_BASE_URL = 'https://api.routstr.com/v1';

export async function fetchRoutstrModels(): Promise<RoutstrModel[]> {
  const res = await fetch(`${ROUTSTR_BASE_URL}/models`);

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
