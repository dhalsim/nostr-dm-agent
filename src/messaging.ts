// ---------------------------------------------------------------------------
// messaging.ts — Message chunking, formatting, and reply sending
// ---------------------------------------------------------------------------

import type { AgentRunResult } from './backends/types';
import type { AgentMode } from './db';
import { C, log } from './logger';

export const CHUNK_MAX = 4200;
export const CHUNK_DELAY_BASE_MS = 1500;
export const CHUNK_DELAY_MAX_MS = 12000;

export type MessageSource = 'nostr' | 'local' | 'plugin';

export type SendChunkedReplyProps = {
  source: MessageSource;
  reply: string;
  sendReplyForSource: (source: MessageSource, message: string) => Promise<void>;
};

export async function sendChunkedReply({
  source,
  reply,
  sendReplyForSource,
}: SendChunkedReplyProps): Promise<void> {
  const chunks = chunkMessage(reply);
  const total = chunks.length;
  let delayMs = CHUNK_DELAY_BASE_MS;

  for (let i = 0; i < chunks.length; i++) {
    const hasNextChunk = i < chunks.length - 1;

    const maybeNextPrompt = hasNextChunk && source === 'nostr' ? '\n<CHECK NEXT MESSAGE>' : '';

    const chunkBody = `${chunks[i]}${maybeNextPrompt}`;
    const chunk = total > 1 ? `(${i + 1}/${total}) ${chunkBody}` : chunkBody;

    try {
      await sendReplyForSource(source, chunk);
    } catch (e) {
      const targetLabel = source === 'local' ? 'local output' : 'DM chunk';
      log.error(`Failed to send ${targetLabel}: ${String(e)}`);
    }

    if (hasNextChunk) {
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, CHUNK_DELAY_MAX_MS);
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunkMessage(text: string): string[] {
  if (text.length <= CHUNK_MAX) {
    return [text];
  }

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= CHUNK_MAX) {
      chunks.push(rest);
      break;
    }

    const slice = rest.slice(0, CHUNK_MAX);
    const lastNewline = slice.lastIndexOf('\n');
    const splitAt = lastNewline >= 0 ? lastNewline + 1 : CHUNK_MAX;
    chunks.push(rest.slice(0, splitAt));
    rest = rest.slice(splitAt);
  }

  return chunks;
}

export function modePrefix(mode: AgentMode, local: boolean): string {
  if (!local) {
    return `<${mode}> `;
  }

  const colors: Record<AgentMode, string> = {
    free: C.cyan,
    ask: C.cyan,
    plan: C.yellow,
    agent: C.green,
  };

  return `${colors[mode]}<${mode}>${C.reset} `;
}

export function tokenFooter(result: AgentRunResult, local: boolean, spentMsats = 0): string {
  if (result.type !== 'success' || !result.tokens) {
    return '';
  }

  const { input, output } = result.tokens;
  const costStr = spentMsats > 0 ? ` | spent: ${spentMsats} msats` : '';
  const modelStr = result.model ? ` | model: ${result.model}` : '';
  const raw = `[tokens: ${input} in / ${output} out${costStr}${modelStr}]`;

  return local ? `\n${C.gray}${raw}${C.reset}` : `\n${raw}`;
}
