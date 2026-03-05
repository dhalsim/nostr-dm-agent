export type PrepareRunOptions = {
  budgetSats?: number;
};

export type FinalizeRunOptions = {
  success: boolean;
  mintUrl: string;
  sessionId: string | null;
  promptPrefix: string | null;
  model: string | null;
  cost?: number;
  tokens?: { input: number; output: number; total: number };
};

export type ProviderName = 'local' | 'routstr';

export type FinalizeRunResult = {
  spentMsats: number;
};

export type AnyProvider = {
  name: string;
  prepareRun(opts: PrepareRunOptions): Promise<void>;
  finalizeRun(opts: FinalizeRunOptions): Promise<FinalizeRunResult>;
  getStatus(): Promise<string>;
};
