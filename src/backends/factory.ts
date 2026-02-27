// ---------------------------------------------------------------------------
// backends/factory.ts
// ---------------------------------------------------------------------------
import type { AgentBackendName, AgentMode } from '../db';
import { assertUnreachable } from '../logger';

import { createCursorBackend } from './cursor';
import { createOpenCodeBackend } from './opencode';
import type { AgentBackend } from './types';

type CreateBackendProps = {
  name: AgentBackendName;
  dmBotRoot: string;
  mode: AgentMode;
  attachUrl: string | null;
  modelOverride?: string | null;
};

export function createBackend({
  name,
  dmBotRoot,
  mode,
  attachUrl,
  modelOverride,
}: CreateBackendProps): AgentBackend {
  switch (name) {
    case 'cursor':
      return createCursorBackend(modelOverride);
    case 'opencode':
      return createOpenCodeBackend({ dmBotRoot, mode, attachUrl, modelOverride });
    default:
      return assertUnreachable(name);
  }
}
