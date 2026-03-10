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
import { storeDraft } from '../todos/drafts';
import { formatTodoTree } from '../todos/format';
import { CreateTodoInputSchema, UpdateTodoInputSchema } from '../todos/types';

import type { ParseSettledResult } from './utils';
import { parseToolCalls } from './utils';

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

export function buildSystemPrompt(userPrompt: string, activeTree: string): string {
  const schema = z.toJSONSchema(TodoToolCallSchema);

  return `You are managing a todo list for the user.

Active todos (pending and in progress):
${activeTree}

User request: "${userPrompt}"

Instructions:
- If the user wants to see todos, output type "list".
- If the user wants to create a new todo (e.g. "add ...", "create ..."), output type "create". Use the active todos above to resolve any parent todo name to its numeric id.
- If the user wants to update an existing todo (e.g. "update ...", "change ...", "set ... to ...", "mark ... as ...", or changing status/priority/text of something that already exists), output type "update". Resolve the todo by name from the active list to its numeric id and only include the fields being changed (id plus status, todo, priority, etc. as needed).
- If the user wants to delete a todo, output type "delete".
- Important: "update [todo name] status to X" or "change [todo name] to pending" means update the existing todo with that name — use "update" with that todo's id and the new status, not "create".
- For name resolution: match by name (case-insensitive, partial match is fine). If ambiguous, pick the closest match and note it in the todo text.

Output one or more JSON objects matching this JSON Schema. Use a single object for one operation, or one JSON object per line (JSONL) for multiple operations (e.g. creating several todos). No markdown, no code fence, no explanation:

${JSON.stringify(schema, null, 2)}`;
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

export function parseTodoToolCalls(raw: string): ParseSettledResult<TodoToolCall>[] {
  return parseToolCalls({ raw, schema: TodoToolCallSchema });
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
    `  status      : pending`,
    `  priority    : ${input.priority ?? '—'}`,
    `  description : ${input.description ?? '—'}`,
    `  tags        : ${input.tags?.join(', ') ?? '—'}`,
    ``,
    `Draft ID: ${draftId}`,
    `Reply: !todo accept ${draftId} | !todo revise ${draftId} <corrections> | !todo decline ${draftId}`,
  ].join('\n');
}

const UPDATE_PREVIEW_FIELDS: Array<{
  key: keyof z.infer<typeof UpdateTodoInputSchema>;
  label: string;
}> = [
  { key: 'todo', label: 'todo' },
  { key: 'status', label: 'status' },
  { key: 'priority', label: 'priority' },
  { key: 'description', label: 'description' },
  { key: 'tags', label: 'tags' },
];

function formatUpdatePreview(
  draftId: number,
  call: z.infer<typeof TodoUpdateCallSchema>,
  db: SeenDb,
): string {
  const { input } = call;

  const existing = getTodo(db, input.id);

  const titleLine = existing ? `Todo #${input.id}: "${existing.todo}"` : `Todo #${input.id}`;

  const formatVal = (v: string | string[] | null | undefined): string => {
    if (v === undefined || v === null) {
      return '—';
    }

    return Array.isArray(v) ? v.join(', ') : String(v);
  };

  const lines = UPDATE_PREVIEW_FIELDS.map(({ key, label }) => {
    const current = existing ? (existing as Record<string, unknown>)[key] : undefined;
    const next = (input as Record<string, unknown>)[key];
    const hasChange = key in input && next !== undefined;
    const currentStr = formatVal(current as string | string[] | null | undefined);
    const nextStr = formatVal(next as string | string[] | null | undefined);

    const value = hasChange ? `${currentStr} → ${nextStr}` : currentStr;

    return `  ${label.padEnd(12)}: ${value}`;
  });

  return [
    `I'm going to update ${titleLine}`,
    ``,
    ...lines,
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
  const activeTodos = allTodos.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
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

  const results = parseTodoToolCalls(raw);

  const fulfilled = results.filter(
    (r): r is { status: 'fulfilled'; value: TodoToolCall } => r.status === 'fulfilled',
  );

  if (fulfilled.length === 0) {
    const firstRejected = results.find((r) => r.status === 'rejected');

    const msg =
      firstRejected?.status === 'rejected' ? firstRejected.reason.message : 'No valid JSON';

    return `Failed to parse model response: ${msg}`;
  }

  const calls = fulfilled.map((r) => r.value);

  // --- list: execute immediately (only one list, ignore rest) ---
  const listCall = calls.find((c) => c.type === 'list');

  if (listCall) {
    const todos = listTodos(db);
    const pending = todos.filter((t) => t.status === 'pending');

    if (pending.length === 0) {
      return 'No active todos.';
    }

    return formatTodoTree(pending);
  }

  // --- process create/update/delete (can be multiple) ---
  const previews: string[] = [];

  for (const call of calls) {
    if (call.type === 'create') {
      const draftId = storeDraft(db, {
        kind: 'create',
        input: call.input,
        originalPrompt: userPrompt,
      });

      previews.push(formatCreatePreview(draftId, call));
    } else if (call.type === 'update') {
      const draftId = storeDraft(db, {
        kind: 'update',
        input: call.input,
        originalPrompt: userPrompt,
      });

      previews.push(formatUpdatePreview(draftId, call, db));
    } else if (call.type === 'delete') {
      const draftId = storeDraft(db, {
        kind: 'delete',
        input: call.input,
        originalPrompt: userPrompt,
      });

      previews.push(formatDeletePreview(draftId, call, db));
    }
  }

  return previews.length > 0 ? previews.join('\n\n') : 'Unknown operation type returned by model.';
}
