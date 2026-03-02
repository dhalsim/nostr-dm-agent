export type PrepareRunOptions = {
  budgetSats?: number;
};

export type FinalizeRunOptions = {
  success: boolean;
  mintUrl: string;
  sessionId: string | null;
  promptPrefix: string | null;
  model: string | null;
};

export type ProviderName = 'local' | 'routstr';

export type AnyProvider = {
  name: string;
  prepareRun(opts: PrepareRunOptions): Promise<void>;
  finalizeRun(opts: FinalizeRunOptions): Promise<void>;
  getStatus(): Promise<string>;
};
