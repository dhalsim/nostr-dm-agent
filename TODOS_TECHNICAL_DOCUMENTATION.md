# Todos Feature — Technical Implementation Document

## Overview

This document covers the full implementation of the per-bot todos feature:
the SQLite schema, the `src/todos/` module (types, db, commands), and the
opencode custom tools that let the LLM drive todo operations natively with
a draft/confirm flow before any write reaches the database.

---

## 1. Database Schema

Add to `openSeenDb()` in `src/db.ts` alongside the existing table creation
calls.

```sql
CREATE TABLE IF NOT EXISTS todos (
  id          TEXT    PRIMARY KEY,
  parent_id   TEXT    REFERENCES todos(id) ON DELETE CASCADE,
  todo        TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending',  -- pending | in_progress | done | cancelled
  priority    TEXT,                                -- low | medium | high | NULL
  sort_order  INTEGER,
  description TEXT,
  tags        TEXT,                                -- JSON array e.g. '["work","personal"]'
  source      TEXT,                                -- dm | local | task
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_todos_parent_id ON todos(parent_id);
CREATE INDEX IF NOT EXISTS idx_todos_parent_sort ON todos(parent_id, sort_order);
```

Add these two `CREATE INDEX` calls after the table. SQLite enforces the
`REFERENCES todos(id) ON DELETE CASCADE` only when `PRAGMA foreign_keys = ON`
is set per connection — add that to `openSeenDb()`:

```typescript
db.run('PRAGMA foreign_keys = ON');
```

---

## 2. Types — `src/todos/types.ts`

Mirror the pattern from `src/tasks/types.ts`: plain TypeScript types for
runtime use, Zod schemas for validation and prompt injection.

```typescript
// src/todos/types.ts
import { z } from 'zod';

export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';
export type TodoPriority = 'low' | 'medium' | 'high';

export type Todo = {
  id: string;
  parent_id: string | null;
  todo: string;
  status: TodoStatus;
  priority: TodoPriority | null;
  sort_order: number | null;
  description: string | null;
  tags: string[] | null;
  source: string | null;
  created_at: number;
  updated_at: number | null;
  completed_at: number | null;
};

// Zod schemas — these are passed to opencode tools (tool.schema = Zod)
// and also used to validate AI-generated JSON in non-opencode backends.

export const TodoStatusSchema = z.enum(['pending', 'in_progress', 'done', 'cancelled']);
export const TodoPrioritySchema = z.enum(['low', 'medium', 'high']);

export const CreateTodoInputSchema = z.object({
  todo: z.string().min(1).describe('Short title or one-line description of the todo'),
  parent_id: z.string().nullable().describe(
    'ID of the parent todo. NULL for top-level. Call list_todos first to resolve a name to an ID.'
  ),
  priority: TodoPrioritySchema.nullable().describe('Optional priority: low, medium, or high'),
  description: z.string().nullable().describe('Optional longer notes'),
  tags: z.array(z.string()).nullable().describe('Optional tags e.g. ["work", "personal"]'),
});

export type CreateTodoInput = z.infer<typeof CreateTodoInputSchema>;

export const UpdateTodoInputSchema = z.object({
  id: z.string().describe('ID of the todo to update'),
  todo: z.string().min(1).optional().describe('New title'),
  status: TodoStatusSchema.optional().describe('New status'),
  priority: TodoPrioritySchema.nullable().optional().describe('New priority'),
  description: z.string().nullable().optional().describe('New description'),
  tags: z.array(z.string()).nullable().optional().describe('New tags'),
});

export type UpdateTodoInput = z.infer<typeof UpdateTodoInputSchema>;
```

---

## 3. Database Layer — `src/todos/db.ts`

Mirrors `src/tasks/db.ts` in structure: `rowToTodo`, CRUD functions, and a
recursive tree-listing query.

```typescript
// src/todos/db.ts
import { randomBytes } from 'crypto';
import type { SeenDb } from '../db';
import type { Todo, CreateTodoInput, UpdateTodoInput, TodoStatus } from './types';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function generateTodoId(): string {
  return randomBytes(3).toString('hex'); // 6-char hex, short and readable
}

function rowToTodo(row: Record<string, unknown>): Todo {
  return {
    id: String(row.id),
    parent_id: row.parent_id != null ? String(row.parent_id) : null,
    todo: String(row.todo),
    status: String(row.status) as TodoStatus,
    priority: row.priority != null ? String(row.priority) as Todo['priority'] : null,
    sort_order: row.sort_order != null ? Number(row.sort_order) : null,
    description: row.description != null ? String(row.description) : null,
    tags: row.tags != null ? JSON.parse(String(row.tags)) : null,
    source: row.source != null ? String(row.source) : null,
    created_at: Number(row.created_at),
    updated_at: row.updated_at != null ? Number(row.updated_at) : null,
    completed_at: row.completed_at != null ? Number(row.completed_at) : null,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function createTodo(db: SeenDb, input: CreateTodoInput, source?: string): Todo {
  let id = generateTodoId();
  while (db.prepare('SELECT 1 FROM todos WHERE id = ?').get(id)) {
    id = generateTodoId();
  }

  const now = Date.now();

  db.run(
    `INSERT INTO todos (id, parent_id, todo, status, priority, description, tags, source, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [
      id,
      input.parent_id ?? null,
      input.todo,
      input.priority ?? null,
      input.description ?? null,
      input.tags ? JSON.stringify(input.tags) : null,
      source ?? null,
      now,
    ],
  );

  return getTodo(db, id)!;
}

export function getTodo(db: SeenDb, id: string): Todo | null {
  const row = db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToTodo(row) : null;
}

export function listTodos(db: SeenDb): Todo[] {
  // Return all rows ordered so tree traversal is depth-first by sort_order.
  // The caller (formatTodoTree) handles indentation.
  const rows = db
    .prepare(
      `WITH RECURSIVE tree(id, parent_id, todo, status, priority, sort_order, description,
          tags, source, created_at, updated_at, completed_at, depth) AS (
        SELECT *, 0 FROM todos WHERE parent_id IS NULL
        UNION ALL
        SELECT t.*, tree.depth + 1
        FROM todos t
        JOIN tree ON t.parent_id = tree.id
      )
      SELECT * FROM tree ORDER BY depth, sort_order, created_at`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToTodo);
}

export function listTopLevelTodos(db: SeenDb): Todo[] {
  const rows = db
    .prepare(
      `SELECT * FROM todos WHERE parent_id IS NULL ORDER BY sort_order, created_at`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToTodo);
}

export function listChildTodos(db: SeenDb, parentId: string): Todo[] {
  const rows = db
    .prepare(
      `SELECT * FROM todos WHERE parent_id = ? ORDER BY sort_order, created_at`,
    )
    .all(parentId) as Record<string, unknown>[];
  return rows.map(rowToTodo);
}

export function updateTodo(db: SeenDb, input: UpdateTodoInput): Todo | null {
  const existing = getTodo(db, input.id);
  if (!existing) return null;

  const now = Date.now();
  const completedAt =
    input.status === 'done' && existing.status !== 'done' ? now : existing.completed_at;

  db.run(
    `UPDATE todos SET
      todo         = ?,
      status       = ?,
      priority     = ?,
      description  = ?,
      tags         = ?,
      updated_at   = ?,
      completed_at = ?
     WHERE id = ?`,
    [
      input.todo ?? existing.todo,
      input.status ?? existing.status,
      input.priority !== undefined ? input.priority : existing.priority,
      input.description !== undefined ? input.description : existing.description,
      input.tags !== undefined
        ? input.tags ? JSON.stringify(input.tags) : null
        : existing.tags ? JSON.stringify(existing.tags) : null,
      now,
      completedAt,
      input.id,
    ],
  );

  return getTodo(db, input.id);
}

export function doneTodo(db: SeenDb, id: string, cascade = true): boolean {
  const todo = getTodo(db, id);
  if (!todo) return false;

  const now = Date.now();

  if (cascade) {
    // Mark all descendants done via recursive CTE
    db.run(
      `WITH RECURSIVE descendants(id) AS (
        SELECT id FROM todos WHERE id = ?
        UNION ALL
        SELECT t.id FROM todos t JOIN descendants d ON t.parent_id = d.id
      )
      UPDATE todos SET status = 'done', completed_at = ?, updated_at = ?
      WHERE id IN (SELECT id FROM descendants)`,
      [now, now, id],
    );
  } else {
    db.run(
      `UPDATE todos SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, id],
    );
  }

  return true;
}

export function deleteTodo(db: SeenDb, id: string): boolean {
  // CASCADE on the FK handles descendants automatically (requires PRAGMA foreign_keys = ON)
  const info = db.prepare('DELETE FROM todos WHERE id = ?').run(id);
  return info.changes > 0;
}
```

---

## 4. Display Helpers — `src/todos/format.ts`

```typescript
// src/todos/format.ts
import type { Todo } from './types';

const STATUS_ICON: Record<string, string> = {
  pending:     '[ ]',
  in_progress: '[~]',
  done:        '[x]',
  cancelled:   '[-]',
};

function buildChildMap(todos: Todo[]): Map<string | null, Todo[]> {
  const map = new Map<string | null, Todo[]>();
  for (const t of todos) {
    const key = t.parent_id ?? null;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  }
  return map;
}

export function formatTodoTree(todos: Todo[]): string {
  if (todos.length === 0) return 'No todos.';

  const childMap = buildChildMap(todos);
  const lines: string[] = [];

  function render(parentId: string | null, prefix: string, indexPath: string) {
    const children = childMap.get(parentId) ?? [];
    children.forEach((t, i) => {
      const label = indexPath ? `${indexPath}.${i + 1}` : `${i + 1}`;
      const icon = STATUS_ICON[t.status] ?? '[ ]';
      const pri = t.priority ? ` [${t.priority}]` : '';
      lines.push(`${prefix}${label}. ${icon} ${t.todo}${pri}  (id: ${t.id})`);
      render(t.id, prefix + '  ', label);
    });
  }

  render(null, '', '');
  return lines.join('\n');
}

export function formatTodoDetail(t: Todo): string {
  const lines = [
    `ID:          ${t.id}`,
    `Todo:        ${t.todo}`,
    `Status:      ${t.status}`,
    `Priority:    ${t.priority ?? '—'}`,
    `Parent:      ${t.parent_id ?? '(top-level)'}`,
    `Tags:        ${t.tags?.join(', ') ?? '—'}`,
    `Description: ${t.description ?? '—'}`,
    `Created:     ${new Date(t.created_at).toLocaleString()}`,
    `Updated:     ${t.updated_at ? new Date(t.updated_at).toLocaleString() : '—'}`,
    `Completed:   ${t.completed_at ? new Date(t.completed_at).toLocaleString() : '—'}`,
  ];
  return lines.join('\n');
}
```

---

## 5. Bot Commands — `src/commands/todos.ts`

The `!todo` command handler. Follows the same shape as `src/commands/tasks.ts`:
a single exported `handleTodo` function, a draft store for the NL flow, and
subcommand dispatch.

```typescript
// src/commands/todos.ts
import { randomBytes } from 'crypto';
import type { SeenDb } from '../db';
import {
  createTodo, deleteTodo, doneTodo, getTodo, listTodos, updateTodo,
} from '../todos/db';
import { formatTodoDetail, formatTodoTree } from '../todos/format';
import { CreateTodoInputSchema } from '../todos/types';
import type { CreateTodoInput } from '../todos/types';

// ---------------------------------------------------------------------------
// Draft store (in-memory, cleared on restart — same pattern as tasks)
// ---------------------------------------------------------------------------

type TodoDraftEntry = {
  input: CreateTodoInput;
  originalPrompt: string;
  history: string[];
};

const draftStore = new Map<string, TodoDraftEntry>();

function generateDraftId(): string {
  return randomBytes(2).toString('hex');
}

// ---------------------------------------------------------------------------
// Preview formatting
// ---------------------------------------------------------------------------

function formatDraftPreview(id: string, input: CreateTodoInput): string {
  const lines = [
    `todo      : ${input.todo}`,
    `parent_id : ${input.parent_id ?? '(top-level)'}`,
    `priority  : ${input.priority ?? '—'}`,
    `description: ${input.description ?? '—'}`,
    `tags      : ${input.tags?.join(', ') ?? '—'}`,
    ``,
    `Draft ID: ${id}`,
    `Reply: !todo accept ${id} | !todo revise ${id} <corrections> | !todo decline ${id}`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export type HandleTodoProps = {
  args: string[];
  db: SeenDb;
};

export async function handleTodo({ args, db }: HandleTodoProps): Promise<string> {
  const sub = args[0]?.toLowerCase();
  const rest = args.slice(1);

  if (!sub || sub === 'help') {
    return [
      '!todo add <text>                   — add a top-level todo',
      '!todo add <text> under <parent_id> — add a sub-todo',
      '!todo list [pending|done|all]      — list todos as tree (default: pending)',
      '!todo list --flat                  — flat list',
      '!todo show <id>                    — show todo detail',
      '!todo done <id>                    — mark done (cascades to children)',
      '!todo priority <id> <low|medium|high>',
      '!todo delete <id>                  — delete todo and all descendants',
      '!todo accept <draft_id>            — confirm a draft and create it',
      '!todo revise <draft_id> <text>     — revise a pending draft',
      '!todo decline <draft_id>           — discard a draft',
      '!todo drafts                       — list pending drafts',
      '!todo help                         — this message',
    ].join('\n');
  }

  // --- add ---
  if (sub === 'add') {
    const underIdx = rest.findIndex((a) => a.toLowerCase() === 'under');
    let text: string;
    let parentId: string | null = null;

    if (underIdx !== -1) {
      text = rest.slice(0, underIdx).join(' ').trim();
      parentId = rest[underIdx + 1]?.trim() ?? null;
    } else {
      text = rest.join(' ').trim();
    }

    if (!text) return 'Usage: !todo add <text> [under <parent_id>]';

    if (parentId && !getTodo(db, parentId)) {
      return `Parent todo not found: ${parentId}`;
    }

    const todo = createTodo(db, {
      todo: text,
      parent_id: parentId,
      priority: null,
      description: null,
      tags: null,
    }, 'dm');

    return `Todo created: ${todo.id}\n${formatTodoDetail(todo)}`;
  }

  // --- list ---
  if (sub === 'list') {
    const flat = rest.includes('--flat');
    const filterArg = rest.find((a) => !a.startsWith('-'))?.toLowerCase();

    let todos = listTodos(db);

    if (!filterArg || filterArg === 'pending') {
      todos = todos.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
    } else if (filterArg !== 'all') {
      todos = todos.filter((t) => t.status === filterArg);
    }

    if (todos.length === 0) return 'No todos matching filter.';

    if (flat) {
      return todos
        .map((t) => `${t.id} ${t.status === 'done' ? '[x]' : '[ ]'} ${t.todo}`)
        .join('\n');
    }

    return formatTodoTree(todos);
  }

  // --- show ---
  if (sub === 'show') {
    const id = rest[0]?.trim();
    if (!id) return 'Usage: !todo show <id>';
    const todo = getTodo(db, id);
    if (!todo) return `Todo not found: ${id}`;
    return formatTodoDetail(todo);
  }

  // --- done ---
  if (sub === 'done') {
    const id = rest[0]?.trim();
    if (!id) return 'Usage: !todo done <id>';
    if (!doneTodo(db, id)) return `Todo not found: ${id}`;
    return `Todo ${id} marked done (and all descendants).`;
  }

  // --- priority ---
  if (sub === 'priority') {
    const id = rest[0]?.trim();
    const pri = rest[1]?.trim();
    if (!id || !pri) return 'Usage: !todo priority <id> <low|medium|high>';
    const parsed = CreateTodoInputSchema.shape.priority.safeParse(pri);
    if (!parsed.success) return 'Priority must be: low, medium, or high';
    const updated = updateTodo(db, { id, priority: parsed.data });
    if (!updated) return `Todo not found: ${id}`;
    return `Priority updated.\n${formatTodoDetail(updated)}`;
  }

  // --- delete ---
  if (sub === 'delete') {
    const id = rest[0]?.trim();
    if (!id) return 'Usage: !todo delete <id>';
    if (!deleteTodo(db, id)) return `Todo not found: ${id}`;
    return `Todo ${id} deleted (and all descendants).`;
  }

  // --- drafts ---
  if (sub === 'drafts') {
    if (draftStore.size === 0) return 'No pending drafts.';
    const lines = [...draftStore.entries()].map(
      ([id, e]) => `${id} | ${e.input.todo} | parent: ${e.input.parent_id ?? 'top-level'}`,
    );
    return `Pending drafts:\n${lines.join('\n')}`;
  }

  const draftId = rest[0]?.trim();

  // --- accept ---
  if (sub === 'accept') {
    if (!draftId) return 'Usage: !todo accept <draft_id>';
    const entry = draftStore.get(draftId);
    if (!entry) return `Draft not found: ${draftId}`;
    const todo = createTodo(db, entry.input, 'dm');
    draftStore.delete(draftId);
    return `Todo created: ${todo.id}\n${formatTodoDetail(todo)}`;
  }

  // --- revise ---
  if (sub === 'revise') {
    if (!draftId) return 'Usage: !todo revise <draft_id> <corrections>';
    const corrections = rest.slice(1).join(' ').trim();
    if (!corrections) return 'Usage: !todo revise <draft_id> <corrections>';
    const entry = draftStore.get(draftId);
    if (!entry) return `Draft not found: ${draftId}`;
    // For non-opencode backends: surface the revision as a plain message
    // so the user can re-describe and the bot re-runs the NL flow.
    return [
      `Revision noted: "${corrections}"`,
      `Original prompt: "${entry.originalPrompt}"`,
      `Please re-run your natural language request with the revision applied,`,
      `or use !todo add directly.`,
    ].join('\n');
  }

  // --- decline ---
  if (sub === 'decline') {
    if (!draftId) return 'Usage: !todo decline <draft_id>';
    if (!draftStore.has(draftId)) return `Draft not found: ${draftId}`;
    draftStore.delete(draftId);
    return `Draft ${draftId} discarded.`;
  }

  return `Unknown subcommand: ${sub}. Use !todo help.`;
}
```

Wire this up in `handleBangCommand` in `index.ts`:

```typescript
if (cmd === 'todo') return handleTodo({ args: rest, db });
```

---

## 6. Opencode Custom Tools — `.opencode/tools/todos.ts`

This is where the NL flow lives for opencode. The tools use the **same Zod
schemas** from `src/todos/types.ts` directly — no duplication.

The key design: `todos_create` does **not** write to the database. It stores
a draft and returns a preview string that the bot surfaces to the user. The
user then responds with `!todo accept <id>`, `!todo revise <id> <text>`, or
`!todo decline <id>`.

```typescript
// .opencode/tools/todos.ts
import { tool } from '@opencode-ai/plugin';
import { randomBytes } from 'crypto';
import { Database } from 'bun:sqlite';
import { SEEN_DB_PATH } from '../../src/paths';
import { listTodos } from '../../src/todos/db';
import { formatTodoTree } from '../../src/todos/format';
import { CreateTodoInputSchema } from '../../src/todos/types';
import type { CreateTodoInput } from '../../src/todos/types';

// ---------------------------------------------------------------------------
// Shared DB access
// Note: opencode runs tools in-process; this opens the same SQLite file the
// bot uses. Bun:sqlite supports concurrent readers safely for reads.
// Writes (createTodo) only happen after the user confirms via !todo accept.
// ---------------------------------------------------------------------------

function openDb() {
  const db = new Database(SEEN_DB_PATH);
  db.run('PRAGMA foreign_keys = ON');
  return db;
}

// ---------------------------------------------------------------------------
// Draft store — shared with the bot's command handler via module singleton.
// In practice, opencode tools run in the same Bun process as the bot when
// using opencode-sdk, so the Map is shared. If not, replace with a small
// SQLite-backed draft table (todos_drafts).
// ---------------------------------------------------------------------------

type DraftEntry = { input: CreateTodoInput; originalPrompt: string };
const drafts = new Map<string, DraftEntry>();

function generateDraftId(): string {
  return randomBytes(2).toString('hex');
}

// ---------------------------------------------------------------------------
// Tool: todos_list
// Read-only. The LLM calls this first to resolve names → IDs.
// ---------------------------------------------------------------------------

export const list = tool({
  description:
    'List all todos in a tree. Call this first when the user refers to a todo by name ' +
    'so you can resolve it to an ID before creating or updating.',
  args: {},
  async execute(_args, _context) {
    const db = openDb();
    const todos = listTodos(db);
    if (todos.length === 0) return 'No todos yet.';
    return formatTodoTree(todos);
  },
});

// ---------------------------------------------------------------------------
// Tool: todos_create
// Stores a draft. Returns a preview asking for !todo accept / revise / decline.
// Does NOT write to the database.
// ---------------------------------------------------------------------------

export const create = tool({
  description:
    'Propose creating a new todo. This does NOT create it immediately — it stores a draft ' +
    'and asks the user to confirm with !todo accept, revise with !todo revise, or ' +
    'decline with !todo decline. If parent_id is needed, call todos_list first.',
  args: {
    todo: CreateTodoInputSchema.shape.todo,
    parent_id: CreateTodoInputSchema.shape.parent_id,
    priority: CreateTodoInputSchema.shape.priority,
    description: CreateTodoInputSchema.shape.description,
    tags: CreateTodoInputSchema.shape.tags,
    original_prompt: tool.schema
      .string()
      .describe('The original natural language request from the user, verbatim.'),
  },
  async execute(args, _context) {
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

    const draftId = generateDraftId();
    drafts.set(draftId, {
      input: parsed.data,
      originalPrompt: args.original_prompt,
    });

    const lines = [
      `I'm going to create the following todo:`,
      ``,
      `  todo      : ${parsed.data.todo}`,
      `  parent    : ${parsed.data.parent_id ?? '(top-level)'}`,
      `  priority  : ${parsed.data.priority ?? '—'}`,
      `  description: ${parsed.data.description ?? '—'}`,
      `  tags      : ${parsed.data.tags?.join(', ') ?? '—'}`,
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
```

The filename is `todos.ts`, so the tools are registered as `todos_list` and
`todos_create` by opencode (named `<filename>_<exportname>`).

---

## 7. Connecting the Draft Store

The draft store is a `Map` in module scope. When the bot runs under
opencode-sdk (same Bun process), the tool module and `src/commands/todos.ts`
can share the same Map if you export it from a shared module:

```typescript
// src/todos/drafts.ts
import { randomBytes } from 'crypto';
import type { CreateTodoInput } from './types';

export type TodoDraftEntry = {
  input: CreateTodoInput;
  originalPrompt: string;
  history: string[];
};

export const draftStore = new Map<string, TodoDraftEntry>();

export function generateDraftId(): string {
  return randomBytes(2).toString('hex');
}
```

Import `draftStore` in both `src/commands/todos.ts` and
`.opencode/tools/todos.ts`. When the user replies `!todo accept <id>`, the
bot handler looks up the draft from the same in-memory Map the tool wrote to.

If opencode runs out-of-process in the future, replace the Map with a
`todos_drafts` SQLite table (same DB, same PRAGMA foreign_keys session).

---

## 8. End-to-End Flow

```
User: "add 'write unit tests' under the Ship feature todo"

opencode:
  1. LLM sees user message, decides to call todos_list
  2. todos_list executes → returns current tree with IDs
  3. LLM resolves "Ship feature" → id e.g. "a1b2c3"
  4. LLM calls todos_create {
       todo: "write unit tests",
       parent_id: "a1b2c3",
       priority: null,
       ...
       original_prompt: "add 'write unit tests' under the Ship feature todo"
     }
  5. todos_create stores draft "d4e5", returns preview string

Bot sends to user:
  I'm going to create the following todo:

    todo      : write unit tests
    parent    : a1b2c3
    priority  : —

  Draft ID: d4e5
  Reply with:
    !todo accept d4e5
    !todo revise d4e5 <your corrections>
    !todo decline d4e5

User: "!todo accept d4e5"

Bot:
  handleTodo({ sub: 'accept', rest: ['d4e5'] })
  → looks up draftStore.get('d4e5')
  → calls createTodo(db, entry.input, 'dm')
  → returns "Todo created: f6g7h8 ..."
```

---

## 9. File Structure Summary

```
src/
  db.ts                      ← add PRAGMA foreign_keys + todos table migration
  todos/
    types.ts                 ← Todo type, Zod schemas
    db.ts                    ← CRUD: createTodo, listTodos, getTodo, doneTodo, deleteTodo
    format.ts                ← formatTodoTree, formatTodoDetail
    drafts.ts                ← shared draftStore Map
  commands/
    todos.ts                 ← handleTodo: !todo subcommand dispatcher

.opencode/
  tools/
    todos.ts                 ← todos_list, todos_create opencode tools
```

---

## 10. Implementation Checklist

- [ ] Add `PRAGMA foreign_keys = ON` to `openSeenDb()`
- [ ] Add `todos` table DDL + indexes to `openSeenDb()`
- [ ] Create `src/todos/types.ts`
- [ ] Create `src/todos/db.ts`
- [ ] Create `src/todos/format.ts`
- [ ] Create `src/todos/drafts.ts`
- [ ] Create `src/commands/todos.ts`
- [ ] Wire `!todo` in `handleBangCommand` in `index.ts`
- [ ] Create `.opencode/tools/todos.ts`
- [ ] Verify `SEEN_DB_PATH` is importable from `.opencode/tools/` (check relative path depth)
- [ ] Test: `!todo add`, `!todo list`, `!todo done`, `!todo delete`
- [ ] Test NL flow: natural language → todos_list → todos_create → draft preview → `!todo accept`
- [ ] Test cascade delete (child todos removed with parent)
- [ ] Test cascade done (children marked done with parent)