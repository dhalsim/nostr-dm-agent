import type { AnyProvider, ProviderEnv, PrepareRunOptions, FinalizeRunOptions } from './types';

export function createLocalProvider(): AnyProvider {
  return {
    name: 'local',

    async prepareRun(_opts: PrepareRunOptions): Promise<ProviderEnv> {
      return {};
    },

    async finalizeRun(_env: ProviderEnv, _opts: FinalizeRunOptions): Promise<void> {
      // No-op for local provider
    },

    async getStatus(): Promise<string> {
      return 'local | no payment';
    },
  };
}
