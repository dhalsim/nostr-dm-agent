export type ProviderEnv = Record<string, string>;

export type PrepareRunOptions = {
  budgetSats?: number;
};

export type FinalizeRunOptions = {
  success: boolean;
  sessionId?: string;
  promptPrefix?: string;
  model?: string;
};

export type ProviderName = 'local' | 'routstr';

export type AnyProvider = {
  name: string;
  prepareRun(opts: PrepareRunOptions): Promise<ProviderEnv>;
  finalizeRun(env: ProviderEnv, opts: FinalizeRunOptions): Promise<void>;
  getStatus(): Promise<string>;
};
