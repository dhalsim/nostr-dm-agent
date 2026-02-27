// ---------------------------------------------------------------------------
// backends/types.ts
// ---------------------------------------------------------------------------
import type { AgentMode, AgentBackendName } from '../db';

export type AgentRunResult = {
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
};

export type CreateSessionProps = {
  cwd: string;
  env: Record<string, string | undefined>;
};

export type AgentBackend = {
  name: AgentBackendName;
  modelName: string;
  createSession(props: CreateSessionProps): string;
  runMessage(props: RunMessageProps): Promise<AgentRunResult>;
};
