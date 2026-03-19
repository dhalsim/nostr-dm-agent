// ---------------------------------------------------------------------------
// plugins/{{ALIAS}}/ai.ts — !{{ALIAS}} ai <prompt> handler
//
// Calls the agent with a system prompt and parses tool calls (list, create,
// update, delete). For list we return the formatted list; for create/update/
// delete we store drafts and return previews. Replace or extend the prompt
// and handling in tool.ts to match your plugin’s operations.
// ---------------------------------------------------------------------------

import type { Database } from 'bun:sqlite';

import type { AgentRunResult } from '@src/backends/types';
import { getOutputString } from '@src/backends/types';
import type { PluginIdentity } from '@src/core/plugin';

import { get{{PASCAL_ALIAS}}, list{{PASCAL_ALIAS}}s } from './db';
import { storeDraft } from './drafts';
import { formatDraftReply } from './format';
import { format{{PASCAL_ALIAS}}Tree } from './format';
import type { {{PASCAL_ALIAS}}ToolCall } from './tool';
import { buildSystemPrompt, parse{{PASCAL_ALIAS}}ToolCalls } from './tool';

export type Handle{{PASCAL_ALIAS}}AiProps = {
  args: string[];
  db: Database;
  identity: PluginIdentity;
  runAgent: (prompt: string) => Promise<AgentRunResult>;
};

export async function handle{{PASCAL_ALIAS}}Ai({
  args,
  db,
  identity,
  runAgent,
}: Handle{{PASCAL_ALIAS}}AiProps): Promise<string> {
  const userPrompt = args.join(' ').trim();
  const alias = identity.alias;

  if (!userPrompt) {
    return `Usage: !${alias} ai <natural language request>`;
  }

  const items = list{{PASCAL_ALIAS}}s(db);
  const context = items.length > 0 ? format{{PASCAL_ALIAS}}Tree(items) : '(no {{ALIAS}}s yet)';
  const systemPrompt = buildSystemPrompt(userPrompt, context);
  const result = await runAgent(systemPrompt);
  const raw = getOutputString(result).trim();

  if (!raw || raw === '(no output)') {
    return 'Model returned no output. Try again or rephrase.';
  }

  const results = parse{{PASCAL_ALIAS}}ToolCalls(raw);

  const fulfilled = results.filter(
    (r): r is { status: 'fulfilled'; value: {{PASCAL_ALIAS}}ToolCall } =>
      r.status === 'fulfilled',
  );

  if (fulfilled.length === 0) {
    const firstRejected = results.find((r) => r.status === 'rejected');

    const msg =
      firstRejected?.status === 'rejected'
        ? firstRejected.reason.message
        : 'No valid JSON';

    return `Failed to parse response: ${msg}`;
  }

  const cmd = `!${alias}`;
  const previews: string[] = [];

  for (const { value } of fulfilled) {
    if (value.type === 'list') {
      const list = list{{PASCAL_ALIAS}}s(db);

      return list.length === 0 ? 'No {{ALIAS}}s.' : format{{PASCAL_ALIAS}}Tree(list);
    }

    if (value.type === 'create') {
      const draftId = storeDraft(db, {
        kind: 'create',
        input: value.input,
        originalPrompt: userPrompt,
      });

      previews.push(
        [
          'Create:',
          '',
          `  - ${value.input.data}`,
          '',
          `Draft ID: ${draftId}`,
          formatDraftReply(cmd, draftId, 'create'),
        ].join('\n'),
      );
    } else if (value.type === 'update') {
      const existing = get{{PASCAL_ALIAS}}(db, value.input.id);

      if (!existing) {
        previews.push(`{{PASCAL_ALIAS}} not found: ${value.input.id}. Call list first.`);
        continue;
      }

      const draftId = storeDraft(db, {
        kind: 'update',
        input: value.input,
        originalPrompt: userPrompt,
      });

      previews.push(
        [
          `Update #${value.input.id}: "${existing.data}"`,
          '',
          `Draft ID: ${draftId}`,
          formatDraftReply(cmd, draftId, 'update'),
        ].join('\n'),
      );
    } else if (value.type === 'delete') {
      const item = get{{PASCAL_ALIAS}}(db, value.input.id);

      if (!item) {
        previews.push(`{{PASCAL_ALIAS}} not found: ${value.input.id}. Call list first.`);
        continue;
      }

      const draftId = storeDraft(db, {
        kind: 'delete',
        input: { id: value.input.id },
        originalPrompt: userPrompt,
      });

      previews.push(
        [
          `Delete #${value.input.id}: "${item.data}"`,
          '',
          `Draft ID: ${draftId}`,
          formatDraftReply(cmd, draftId, 'delete'),
        ].join('\n'),
      );
    }
  }

  if (previews.length === 0) {
    return 'No operations to show.';
  }

  return [
    `You can accept all: ${cmd} accept all`,
    '',
    previews.join('\n\n'),
  ].join('\n');
}
