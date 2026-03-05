// ---------------------------------------------------------------------------
// backends/factory.ts
// ---------------------------------------------------------------------------
import type { AgentBackendName, AgentMode, SeenDb } from '../db';
import { setProviderName } from '../db';
import { assertUnreachable, log } from '../logger';
import type { ProviderName } from '../providers/types';

import { createCursorBackend } from './cursor';
import { createOpenCodeBackend } from './opencode';
import { createOpencodeSDKBackend } from './opencode-sdk';
import type { AgentBackend } from './types';

type CreateBackendProps = {
  backendName: AgentBackendName;
  dmBotRoot: string;
  mode: AgentMode;
  attachUrl: string | null;
  modelOverride: string | null;
  providerName: ProviderName | null;
  seenDb: SeenDb;
};

export function createBackend({
  backendName,
  dmBotRoot,
  mode,
  attachUrl,
  modelOverride,
  providerName,
  seenDb,
}: CreateBackendProps): AgentBackend {
  switch (backendName) {
    case 'cursor':
      if (providerName === 'routstr') {
        log.warn('cursor backend does not support routstr provider; overriding provider to local');

        setProviderName(seenDb, 'local');
      }

      return createCursorBackend(modelOverride);
    case 'opencode':
      return createOpenCodeBackend({ dmBotRoot, mode, attachUrl, modelOverride, providerName });
    case 'opencode-sdk':
      return createOpencodeSDKBackend({ dmBotRoot, mode, modelOverride, providerName });
    default:
      return assertUnreachable(backendName);
  }
}
