// ---------------------------------------------------------------------------
// backends/factory.ts
// ---------------------------------------------------------------------------

import type { AgentBackendName, AgentMode } from '../db';
import type { ProviderName } from '../providers/types';
import { assertUnreachable } from '../utils';

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
};

export function createBackend({
  backendName,
  dmBotRoot,
  mode,
  attachUrl,
  modelOverride,
  providerName,
}: CreateBackendProps): AgentBackend {
  switch (backendName) {
    case 'cursor':
      return createCursorBackend(modelOverride);
    case 'opencode':
      return createOpenCodeBackend({ dmBotRoot, mode, attachUrl, modelOverride, providerName });
    case 'opencode-sdk':
      return createOpencodeSDKBackend({ dmBotRoot, mode, modelOverride, providerName });
    default:
      return assertUnreachable(backendName);
  }
}
