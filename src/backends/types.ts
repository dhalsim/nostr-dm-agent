// ---------------------------------------------------------------------------
// backends/types.ts
// ---------------------------------------------------------------------------
import type { AgentMode, AgentBackendName } from '../db';

export type OutputSegment =
  | { type: 'text'; value: string }
  | { type: 'reasoning'; value: string };

export type AgentRunResult = AgentErrorResult | AgentSuccessResult;

export type AgentErrorResult = {
  type: 'error';
  output: string;
  sessionId: string;
  statusCode?: number;
};

export type AgentSuccessResult = {
  type: 'success';
  outputs: OutputSegment[];
  sessionId: string;
  model?: string;
  tokens?: { input: number; output: number; total: number };
  cost?: number;
};

export function getMessageOutput(outputs: OutputSegment[]): string {
  return outputs
    .filter((o): o is { type: 'text'; value: string } => o.type === 'text')
    .map((o) => o.value)
    .join('');
}

export function getOutputString(result: AgentRunResult): string {
  return result.type === 'success'
    ? getMessageOutput(result.outputs)
    : result.output;
}

export type RunMessageProps = {
  sessionId: string;
  content: string;
  mode: AgentMode;
  cwd: string;
  getRoutstrSkKey: () => string | null;
  modelOverride: string | null;
};

export type AgentBackend = {
  name: AgentBackendName;
  modelName: string;
  createSession(cwd: string): Promise<string>;
  runMessage(props: RunMessageProps): Promise<AgentRunResult>;
  availableModels(): Promise<string[]>;
};
