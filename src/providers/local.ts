import type {
  AnyProvider,
  FinalizeRunOptions,
  FinalizeRunResult,
  PrepareRunOptions,
} from './types';

export function createLocalProvider(): AnyProvider {
  return {
    name: 'local',

    async prepareRun(_opts: PrepareRunOptions): Promise<void> {},

    async finalizeRun(_opts: FinalizeRunOptions): Promise<FinalizeRunResult> {
      return { spentMsats: 0 };
    },

    async getStatus(): Promise<string> {
      return 'local | no payment';
    },
  };
}
