// ---------------------------------------------------------------------------
// plugins/{{ALIAS}}/tool.ts — AI tool-call schema and parser for !{{ALIAS}} ai
//
// When the user runs !{{ALIAS}} ai <prompt>, the agent returns structured
// tool calls (e.g. list, create, update, delete). Define:
// - A Zod discriminated union (e.g. {{PASCAL_ALIAS}}ToolCallSchema) matching
//   the operations your plugin supports
// - buildSystemPrompt(userPrompt, context): system prompt that instructs the
//   model to output JSON/JSONL matching that schema
// - parse{{PASCAL_ALIAS}}ToolCalls(raw): parse model output and return
//   ParseSettledResult<YourToolCall>[]
//
// Wire these in ai.ts so handle{{PASCAL_ALIAS}}Ai can execute or draft the
// parsed calls.
// ---------------------------------------------------------------------------
import { z } from 'zod';

import type { ParseSettledResult } from '@src/tools/utils';
import { parseToolCalls } from '@src/tools/utils';

import { Create{{PASCAL_ALIAS}}InputSchema, Update{{PASCAL_ALIAS}}InputSchema } from './types';

const {{PASCAL_ALIAS}}ListCallSchema = z.object({ type: z.literal('list') });

const {{PASCAL_ALIAS}}CreateCallSchema = z.object({
  type: z.literal('create'),
  input: Create{{PASCAL_ALIAS}}InputSchema,
});

const {{PASCAL_ALIAS}}UpdateCallSchema = z.object({
  type: z.literal('update'),
  input: Update{{PASCAL_ALIAS}}InputSchema,
});

const {{PASCAL_ALIAS}}DeleteCallSchema = z.object({
  type: z.literal('delete'),
  input: z.object({ id: z.number().int().positive() }),
});

const {{PASCAL_ALIAS}}ToolCallSchema = z.discriminatedUnion('type', [
  {{PASCAL_ALIAS}}ListCallSchema,
  {{PASCAL_ALIAS}}CreateCallSchema,
  {{PASCAL_ALIAS}}UpdateCallSchema,
  {{PASCAL_ALIAS}}DeleteCallSchema,
]);

export type {{PASCAL_ALIAS}}ToolCall = z.infer<typeof {{PASCAL_ALIAS}}ToolCallSchema>;

export function buildSystemPrompt(userPrompt: string, context: string): string {
  const schema = z.toJSONSchema({{PASCAL_ALIAS}}ToolCallSchema);

  return `You are helping the user manage {{ALIAS}}s. Current state:\n${context}\n\nUser request: "${userPrompt}"\n\nOutput one or more JSON objects matching this schema (one per line for multiple). No markdown.\n\n${JSON.stringify(schema, null, 2)}`;
}

export function parse{{PASCAL_ALIAS}}ToolCalls(
  raw: string,
): ParseSettledResult<{{PASCAL_ALIAS}}ToolCall>[] {
  return parseToolCalls({ raw, schema: {{PASCAL_ALIAS}}ToolCallSchema });
}
