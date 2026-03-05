// ---------------------------------------------------------------------------
// backends/types.ts
// ---------------------------------------------------------------------------
import type { AgentMode, AgentBackendName } from '../db';

export type AgentRunResult = AgentErrorResult | AgentSuccessResult;

export type AgentErrorResult = {
  type: 'error';
  output: string;
  sessionId: string;
  statusCode?: number;
};

export type AgentSuccessResult = {
  type: 'success';
  output: string;
  sessionId: string;
  model?: string;
  tokens?: { input: number; output: number; total: number };
  cost?: number;
};

export type RunMessageProps = {
  sessionId: string;
  content: string;
  mode: AgentMode;
  cwd: string;
  env: Record<string, string | undefined>;
  modelOverride: string | null;
};

export type CreateSessionProps = {
  cwd: string;
  env: Record<string, string | undefined>;
};

export type AgentBackend = {
  name: AgentBackendName;
  modelName: string;
  createSession(props: CreateSessionProps): Promise<string>;
  runMessage(props: RunMessageProps): Promise<AgentRunResult>;
  availableModels(): Promise<string[]>;
};
