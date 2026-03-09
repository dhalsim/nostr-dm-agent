// ---------------------------------------------------------------------------
// commands/todo-ai.ts — !todo-ai <natural language prompt>
//
// Universal NL entry point for todos. Works with any backend (cursor, opencode,
// opencode-sdk) since it is pure prompt engineering — no native tool calling.
//
// Flow:
//   1. Fetch active todos (pending only) and inject as context
//   2. Inject JSON Schema of TodoToolCallSchema so the model knows the output shape
//   3. Parse + Zod-validate the model's JSON response
//   4. list   → execute immediately, return tree
//   5. create → store draft, return preview + accept/revise/decline instructions
//   6. update → store draft, return preview + accept/revise/decline instructions
//   7. delete → store draft, return preview + accept/revise/decline instructions
// ---------------------------------------------------------------------------
import { z } from 'zod';

import type { AgentBackend } from '../backends/types';
import type { SeenDb } from '../db';
import { getTodo, listTodos } from '../todos/db';
import { draftStore, getNextDraftId } from '../todos/drafts';
import { formatTodoTree } from '../todos/format';
import { CreateTodoInputSchema, UpdateTodoInputSchema } from '../todos/types';

// ---------------------------------------------------------------------------
// TodoToolCall discriminated union + schema
// ---------------------------------------------------------------------------

const TodoListCallSchema = z.object({
  type: z.literal('list'),
});

const TodoCreateCallSchema = z.object({
  type: z.literal('create'),
  input: CreateTodoInputSchema,
});

const TodoUpdateCallSchema = z.object({
  type: z.literal('update'),
  input: UpdateTodoInputSchema,
});

const TodoDeleteCallSchema = z.object({
  type: z.literal('delete'),
  input: z.object({
    id: z.number().int().positive().describe('ID of the todo to delete'),
  }),
});

const TodoToolCallSchema = z.discriminatedUnion('type', [
  TodoListCallSchema,
  TodoCreateCallSchema,
  TodoUpdateCallSchema,
  TodoDeleteCallSchema,
]);

type TodoToolCall = z.infer<typeof TodoToolCallSchema>;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(userPrompt: string, activeTree: string): string {
  const schema = z.toJSONSchema(TodoToolCallSchema);

  return `You are managing a todo list for the user.

Active todos (pending only):
${activeTree}

User request: "${userPrompt}"

Instructions:
- If the user wants to see todos, output type "list".
- If the user wants to create a todo, output type "create". Use the active todos above to resolve any parent todo name to its numeric id.
- If the user wants to update a todo (change text, priority, status, etc.), output type "update".
- If the user wants to delete a todo, output type "delete".
- For parent resolution: match by name (case-insensitive, partial match is fine). If ambiguous, pick the closest match and note it in the todo text.

Output ONLY a single JSON object matching this JSON Schema. No markdown, no code fence, no explanation:
${JSON.stringify(schema, null, 2)}`;
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

function parseToolCall(raw: string): TodoToolCall {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let jsonStr = stripped;
  const firstBrace = stripped.indexOf('{');
  const lastBrace = stripped.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = stripped.slice(firstBrace, lastBrace + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(
      `Model response was not valid JSON. Raw output (first 200 chars): ${raw.slice(0, 200)}`,
    );
  }

  return TodoToolCallSchema.parse(parsed);
}

// ---------------------------------------------------------------------------
// Draft preview formatters
// ---------------------------------------------------------------------------

function formatCreatePreview(draftId: number, call: z.infer<typeof TodoCreateCallSchema>): string {
  const { input } = call;

  return [
    `I'm going to create the following todo:`,
    ``,
    `  todo        : ${input.todo}`,
    `  parent      : ${input.parent_id ?? '(top-level)'}`,
    `  priority    : ${input.priority ?? '—'}`,
    `  description : ${input.description ?? '—'}`,
    `  tags        : ${input.tags?.join(', ') ?? '—'}`,
    ``,
    `Draft ID: ${draftId}`,
    `Reply: !todo accept ${draftId} | !todo revise ${draftId} <corrections> | !todo decline ${draftId}`,
  ].join('\n');
}

function formatUpdatePreview(draftId: number, call: z.infer<typeof TodoUpdateCallSchema>): string {
  const { input } = call;

  const fields = Object.entries(input)
    .filter(([k]) => k !== 'id')
    .map(([k, v]) => `  ${k.padEnd(12)}: ${v ?? '—'}`)
    .join('\n');

  return [
    `I'm going to update todo #${input.id}:`,
    ``,
    fields,
    ``,
    `Draft ID: ${draftId}`,
    `Reply: !todo accept ${draftId} | !todo revise ${draftId} <corrections> | !todo decline ${draftId}`,
  ].join('\n');
}

function formatDeletePreview(
  draftId: number,
  call: z.infer<typeof TodoDeleteCallSchema>,
  db: SeenDb,
): string {
  const todo = getTodo(db, call.input.id);
  const name = todo ? `"${todo.todo}"` : `#${call.input.id}`;

  return [
    `I'm going to delete todo ${name} (id: ${call.input.id}) and all its descendants.`,
    ``,
    `Draft ID: ${draftId}`,
    `Reply: !todo accept ${draftId} | !todo decline ${draftId}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export type HandleTodoAiProps = {
  args: string[];
  db: SeenDb;
  backend: AgentBackend;
  workspaceRoot: string;
  agentEnv: Record<string, string | undefined>;
};

export async function handleTodoAi({
  args,
  db,
  backend,
  workspaceRoot,
  agentEnv,
}: HandleTodoAiProps): Promise<string> {
  const userPrompt = args.join(' ').trim();

  if (!userPrompt) {
    return 'Usage: !todo-ai <natural language request>\nExample: !todo-ai add a high priority todo to take medicine tonight at 9PM';
  }

  // Fetch active todos (pending only) for context injection
  const allTodos = listTodos(db);
  const activeTodos = allTodos.filter((t) => t.status === 'pending');
  const activeTree = activeTodos.length > 0 ? formatTodoTree(activeTodos) : '(no active todos yet)';

  const systemPrompt = buildSystemPrompt(userPrompt, activeTree);

  // createSession returns Promise<string>
  const sessionId = await backend.createSession({ cwd: workspaceRoot, env: agentEnv });

  const result = await backend.runMessage({
    sessionId,
    content: systemPrompt,
    mode: 'ask',
    cwd: workspaceRoot,
    env: agentEnv,
    modelOverride: null,
  });

  const raw = result.output.trim();

  if (!raw || raw === '(no output)') {
    return 'Model returned no output. Try again or rephrase your request.';
  }

  let call: TodoToolCall;
  try {
    call = parseToolCall(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    return `Failed to parse model response: ${msg}`;
  }

  // --- list: execute immediately ---
  if (call.type === 'list') {
    const todos = listTodos(db);
    const pending = todos.filter((t) => t.status === 'pending');

    if (pending.length === 0) {
      return 'No active todos.';
    }

    return formatTodoTree(pending);
  }

  // --- create: draft + preview ---
  if (call.type === 'create') {
    const draftId = getNextDraftId();

    draftStore.set(draftId, {
      kind: 'create',
      input: call.input,
      originalPrompt: userPrompt,
      history: [],
    });

    return formatCreatePreview(draftId, call);
  }

  // --- update: draft + preview ---
  if (call.type === 'update') {
    const draftId = getNextDraftId();

    draftStore.set(draftId, {
      kind: 'update',
      input: call.input,
      originalPrompt: userPrompt,
      history: [],
    });

    return formatUpdatePreview(draftId, call);
  }

  // --- delete: draft + preview ---
  if (call.type === 'delete') {
    const draftId = getNextDraftId();

    draftStore.set(draftId, {
      kind: 'delete',
      input: call.input,
      originalPrompt: userPrompt,
      history: [],
    });

    return formatDeletePreview(draftId, call, db);
  }

  return 'Unknown operation type returned by model.';
}
