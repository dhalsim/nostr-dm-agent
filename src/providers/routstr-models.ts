export type RoutstrModel = {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  top_provider?: {
    max_completion_tokens?: number;
  };
};

export type OpenCodeModelEntry = {
  name: string;
  limit?: { context: number; output: number };
  modalities?: { input?: string[]; output?: string[] };
};

export function buildOpenCodeModelEntry(model: RoutstrModel): OpenCodeModelEntry {
  const entry: OpenCodeModelEntry = {
    name: model.name ?? model.id,
  };

  const hasContext = model.context_length != null;
  const hasOutput = model.top_provider?.max_completion_tokens != null;

  if (hasContext || hasOutput) {
    entry.limit = {
      context: model.context_length ?? 131072,
      output: model.top_provider?.max_completion_tokens ?? 16384,
    };
  }

  const inputMods = model.architecture?.input_modalities;
  const outputMods = model.architecture?.output_modalities;

  if (inputMods?.length || outputMods?.length) {
    entry.modalities = {
      ...(inputMods?.length ? { input: inputMods } : {}),
      ...(outputMods?.length ? { output: outputMods } : {}),
    };
  }

  return entry;
}

const ROUTSTR_BASE_URL = 'https://api.routstr.com/v1';

export async function fetchRoutstrModels(): Promise<RoutstrModel[]> {
  const res = await fetch(`${ROUTSTR_BASE_URL}/models`);

  if (!res.ok) {
    throw new Error(`/v1/models returned ${res.status}`);
  }

  const data = await res.json();

  return data.data ?? data.models ?? [];
}
