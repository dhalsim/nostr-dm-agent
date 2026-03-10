// ---------------------------------------------------------------------------
// .opencode/tools/bot_todos.ts — OpenCode custom tools for the bot todo NL flow
//
// Tool names (registered as <filename>_<exportname>):
//   bot_todos_list   — read-only, returns the current todo tree
//   bot_todos_create — proposes a new todo (draft/confirm flow, no immediate DB write)
//   bot_todos_update — update an existing todo (id + optional fields)
//   bot_todos_delete — delete a todo and its descendants
//
// Args use tool.schema (plugin's Zod) for compatibility. Runtime validation
// uses CreateTodoInputSchema / UpdateTodoInputSchema from src/todos/types.ts.
// ---------------------------------------------------------------------------
import { tool } from '@opencode-ai/plugin';
import { Database } from 'bun:sqlite';
import { SEEN_DB_PATH } from '../../src/paths';
import { deleteTodo, listTodos, updateTodo } from '../../src/todos/db';
import { storeDraft } from '../../src/todos/drafts';
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
      'ID of the parent todo. NULL for top-level. Call bot_todos_list first to resolve a name to an ID.',
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
// Tool: bot_todos_list
// Read-only. The LLM calls this first to resolve names → IDs.
// This is a bot-specific tool
// ---------------------------------------------------------------------------

export const bot_todos_list = tool({
  description:
    'List all current bot todos with their real IDs. ' +
    'Always call this after the user accepts parent drafts and before creating children, ' +
    'to get the correct parent_id values.',
  args: {},
  async execute() {
    const db = openDb();
    const todos = listTodos(db);

    if (todos.length === 0) return 'No todos yet.';
    return formatTodoTree(todos);
  },
});

// ---------------------------------------------------------------------------
// Tool: bot_todos_create
// Stores a draft and returns a preview. Does NOT write to the database.
// ---------------------------------------------------------------------------

export const bot_todos_create = tool({
  description:
    'Create a draft todo item for the user to review before it is saved. ' +
    'IMPORTANT — when creating todos from a document or list: ' +
    '(1) First scan the entire document and identify which items have children/sub-todos. ' +
    '(2) Create ALL top-level (parent) items first — including both items with and without sub-todos. ' +
    '(3) Stop and tell the user: which parents were created, which have sub-todos pending, and ask them to accept with !todo accept all. ' +
    '(4) Only after the user accepts and gives the go-ahead, call bot_todos_list to get the real IDs of the accepted parents. ' +
    '(5) Create the children using the correct parent_id from bot_todos_list. ' +
    '(6) If there are grandchildren, repeat: stop after creating the second level, wait for accept, then create grandchildren. ' +
    'Never create children in the same batch as their parents. ' +
    'Never guess a parent_id — always verify with bot_todos_list after the user accepts.',
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
    const seenDb = openDb();
    const draftId = storeDraft(seenDb, {
      kind: 'create',
      input,
      originalPrompt: args.original_prompt,
      history: [],
    });

    const lines = [
      `Draft bot todo #${draftId} — copy this output verbatim:`,
      `  todo       : ${input.todo}`,
      `  parent     : ${input.parent_id ?? '(top-level)'}`,
      `  priority   : ${input.priority ?? '—'}`,
      `  description: ${input.description ?? '—'}`,
      `  tags       : ${input.tags?.join(', ') ?? '—'}`,
      `  !todo accept ${draftId} | !todo revise ${draftId} <corrections> | !todo decline ${draftId}`,
    ];

    return lines.join('\n');
  },
});

// Update-tool args mirror UpdateTodoInputSchema (src/todos/types.ts)
const updateArgs = {
  id: tool.schema.number().describe('ID of the bot todo to update'),
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
// Tool: bot_todos_update
// Update an existing todo by id. Call bot_todos_list first to get ids.
// ---------------------------------------------------------------------------

export const bot_todos_update = tool({
  description:
    'Update an existing bot todo. Call bot_todos_list first to get todo IDs. ' +
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
      return `Todo not found: ${args.id}. Call bot_todos_list to see current ids.`;
    }

    return `Bot todo updated:\n${formatTodoDetail(updated)}`;
  },
});

// ---------------------------------------------------------------------------
// Tool: bot_todos_delete
// Delete a bot todo and all its descendants. Call bot_todos_list first to get ids.
// ---------------------------------------------------------------------------

export const bot_todos_delete = tool({
  description: 'Delete a bot todo and all its descendants. Call bot_todos_list first to get todo IDs.',
  args: {
    id: tool.schema.number().describe('ID of the bot todo to delete'),
  },
  async execute(args) {
    const db = openDb();
    const ok = deleteTodo(db, args.id);

    if (!ok) {
      return `Bot todo not found: ${args.id}. Call bot_todos_list to see current ids.`;
    }

    return `Bot todo ${args.id} deleted (and all descendants).`;
  },
});
