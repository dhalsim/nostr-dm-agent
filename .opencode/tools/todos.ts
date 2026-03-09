// ---------------------------------------------------------------------------
// .opencode/tools/todos.ts — OpenCode custom tools for the todo NL flow
//
// Tool names (registered as <filename>_<exportname>):
//   todos_list   — read-only, returns the current todo tree
//   todos_create — proposes a new todo (draft/confirm flow, no immediate DB write)
//   todos_update — update an existing todo (id + optional fields)
//   todos_delete — delete a todo and its descendants
//
// Args use tool.schema (plugin's Zod) for compatibility. Runtime validation
// uses CreateTodoInputSchema / UpdateTodoInputSchema from src/todos/types.ts.
// ---------------------------------------------------------------------------
import { tool } from '@opencode-ai/plugin';
import { Database } from 'bun:sqlite';
import { SEEN_DB_PATH } from '../../src/paths';
import { deleteTodo, listTodos, updateTodo } from '../../src/todos/db';
import { draftStore, getNextDraftId } from '../../src/todos/drafts';
import { formatTodoDetail, formatTodoTree } from '../../src/todos/format';
import { CreateTodoInputSchema, UpdateTodoInputSchema } from '../../src/todos/types';
import type { CreateTodoInput } from '../../src/todos/types';
import type { SeenDb } from '../../src/db';

// ---------------------------------------------------------------------------
// Shared DB access
// ---------------------------------------------------------------------------

function openDb(): SeenDb {
  const db = new Database(SEEN_DB_PATH);
  db.run('PRAGMA foreign_keys = ON');
  return db as SeenDb;
}

// Create-tool args mirror CreateTodoInputSchema (src/todos/types.ts) + original_prompt
const createArgs = {
  todo: tool.schema.string().min(1).describe('Short title or one-line description of the todo'),
  parent_id: tool.schema
    .number()
    .nullable()
    .describe(
      'ID of the parent todo. NULL for top-level. Call todos_list first to resolve a name to an ID.',
    ),
  priority: tool.schema
    .enum(['low', 'medium', 'high'])
    .nullable()
    .describe('Optional priority: low, medium, or high'),
  description: tool.schema.string().nullable().describe('Optional longer notes'),
  tags: tool.schema
    .array(tool.schema.string())
    .nullable()
    .describe('Optional tags e.g. ["work", "personal"]'),
  original_prompt: tool.schema
    .string()
    .describe('The original natural language request from the user, verbatim.'),
};

// ---------------------------------------------------------------------------
// Tool: todos_list
// Read-only. The LLM calls this first to resolve names → IDs.
// ---------------------------------------------------------------------------

export const list = tool({
  description:
    'List all todos in a tree. Call this first when the user refers to a todo by name ' +
    'so you can resolve it to an ID before creating, updating, or deleting.',
  args: {},
  async execute() {
    const db = openDb();
    const todos = listTodos(db);

    if (todos.length === 0) return 'No todos yet.';
    return formatTodoTree(todos);
  },
});

// ---------------------------------------------------------------------------
// Tool: todos_create
// Stores a draft and returns a preview. Does NOT write to the database.
// ---------------------------------------------------------------------------

export const create = tool({
  description:
    'Propose creating a new todo. This does NOT create it immediately — it stores a draft ' +
    'and asks the user to confirm with !todo accept, revise with !todo revise, or ' +
    'decline with !todo decline. If parent_id is needed, call todos_list first.',
  args: createArgs,
  async execute(args) {
    const parsed = CreateTodoInputSchema.safeParse({
      todo: args.todo,
      parent_id: args.parent_id,
      priority: args.priority,
      description: args.description,
      tags: args.tags,
    });

    if (!parsed.success) {
      return `Validation error: ${parsed.error.message}`;
    }

    const input: CreateTodoInput = parsed.data;
    const draftId = getNextDraftId();
    draftStore.set(draftId, {
      kind: 'create',
      input,
      originalPrompt: args.original_prompt,
      history: [],
    });

    const lines = [
      `I'm going to create the following todo:`,
      ``,
      `  todo       : ${input.todo}`,
      `  parent     : ${input.parent_id ?? '(top-level)'}`,
      `  priority   : ${input.priority ?? '—'}`,
      `  description: ${input.description ?? '—'}`,
      `  tags       : ${input.tags?.join(', ') ?? '—'}`,
      ``,
      `Draft ID: ${draftId}`,
      `Reply with:`,
      `  !todo accept ${draftId}`,
      `  !todo revise ${draftId} <your corrections>`,
      `  !todo decline ${draftId}`,
    ];

    return lines.join('\n');
  },
});

// Update-tool args mirror UpdateTodoInputSchema (src/todos/types.ts)
const updateArgs = {
  id: tool.schema.number().describe('ID of the todo to update'),
  todo: tool.schema.string().min(1).optional().describe('New title'),
  status: tool.schema
    .enum(['pending', 'in_progress', 'done', 'cancelled'])
    .optional()
    .describe('New status'),
  priority: tool.schema
    .enum(['low', 'medium', 'high'])
    .nullable()
    .optional()
    .describe('New priority'),
  description: tool.schema.string().nullable().optional().describe('New description'),
  tags: tool.schema.array(tool.schema.string()).nullable().optional().describe('New tags'),
};

// ---------------------------------------------------------------------------
// Tool: todos_update
// Update an existing todo by id. Call todos_list first to get ids.
// ---------------------------------------------------------------------------

export const update = tool({
  description:
    'Update an existing todo. Call todos_list first to get todo IDs. ' +
    'Provide the todo id and any fields to change (todo, status, priority, description, tags).',
  args: updateArgs,
  async execute(args) {
    const parsed = UpdateTodoInputSchema.safeParse({
      id: args.id,
      todo: args.todo,
      status: args.status,
      priority: args.priority,
      description: args.description,
      tags: args.tags,
    });

    if (!parsed.success) {
      return `Validation error: ${parsed.error.message}`;
    }

    const db = openDb();
    const updated = updateTodo(db, parsed.data);

    if (!updated) {
      return `Todo not found: ${args.id}. Call todos_list to see current ids.`;
    }

    return `Todo updated:\n${formatTodoDetail(updated)}`;
  },
});

// ---------------------------------------------------------------------------
// Tool: todos_delete
// Delete a todo and all its descendants. Call todos_list first to get ids.
// ---------------------------------------------------------------------------

export const del = tool({
  description: 'Delete a todo and all its descendants. Call todos_list first to get todo IDs.',
  args: {
    id: tool.schema.number().describe('ID of the todo to delete'),
  },
  async execute(args) {
    const db = openDb();
    const ok = deleteTodo(db, args.id);

    if (!ok) {
      return `Todo not found: ${args.id}. Call todos_list to see current ids.`;
    }

    return `Todo ${args.id} deleted (and all descendants).`;
  },
});
