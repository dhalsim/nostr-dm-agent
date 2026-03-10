// ---------------------------------------------------------------------------
// todos/drafts.ts — SQLite-persisted draft store for the todo NL flow
//
// Drafts are written by .opencode/tools/bot_todos.ts (a separate process)
// and read by src/commands/todos.ts (the bot process). In-memory Maps cannot
// be shared across processes, so all draft state lives in the SQLite DB.
// ---------------------------------------------------------------------------
import type { SeenDb } from '../db';

import type { CreateTodoInput, UpdateTodoInput } from './types';

// ---------------------------------------------------------------------------
// Draft kind union — one discriminated variant per mutating operation
// ---------------------------------------------------------------------------

export type CreateDraftEntry = {
  kind: 'create';
  input: CreateTodoInput;
  originalPrompt: string;
};

export type UpdateDraftEntry = {
  kind: 'update';
  input: UpdateTodoInput;
  originalPrompt: string;
};

export type DeleteDraftEntry = {
  kind: 'delete';
  input: { id: number };
  originalPrompt: string;
};

export type TodoDraftEntry = CreateDraftEntry | UpdateDraftEntry | DeleteDraftEntry;

export type TodoDraftRow = TodoDraftEntry & { id: number };

// ---------------------------------------------------------------------------
// Schema migration — call from openSeenDb() in src/db.ts
// ---------------------------------------------------------------------------

export function createTodoDraftsTable(db: SeenDb): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS todo_drafts (
      id              INTEGER PRIMARY KEY,
      kind            TEXT NOT NULL,
      input           TEXT NOT NULL,
      original_prompt TEXT NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL
    )
  `);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function storeDraft(seenDb: SeenDb, entry: TodoDraftEntry): number {
  const now = Date.now();

  const info = seenDb.run(
    `INSERT INTO todo_drafts (kind, input, original_prompt, created_at)
     VALUES (?, ?, ?, ?)`,
    [entry.kind, JSON.stringify(entry.input), entry.originalPrompt, now],
  );

  return Number(info.lastInsertRowid);
}

export function getDraft(db: SeenDb, id: number): TodoDraftRow | null {
  const row = db.prepare('SELECT * FROM todo_drafts WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;

  if (!row) {
    return null;
  }

  return rowToDraft(row);
}

export function listDrafts(db: SeenDb): TodoDraftRow[] {
  const rows = db.prepare('SELECT * FROM todo_drafts ORDER BY id ASC').all() as Record<
    string,
    unknown
  >[];

  return rows.map(rowToDraft);
}

export function deleteDraft(db: SeenDb, id: number): boolean {
  return db.prepare('DELETE FROM todo_drafts WHERE id = ?').run(id).changes > 0;
}

export function updateDraftInput(db: SeenDb, id: number, input: TodoDraftEntry['input']): boolean {
  const info = db
    .prepare('UPDATE todo_drafts SET input = ? WHERE id = ?')
    .run(JSON.stringify(input), id);

  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function rowToDraft(row: Record<string, unknown>): TodoDraftRow {
  const kind = String(row.kind) as TodoDraftEntry['kind'];
  const input = JSON.parse(String(row.input));
  const originalPrompt = String(row.original_prompt);
  const id = Number(row.id);

  switch (kind) {
    case 'create':
      return { id, kind, input: input as CreateTodoInput, originalPrompt };
    case 'update':
      return { id, kind, input: input as UpdateTodoInput, originalPrompt };
    case 'delete':
      return { id, kind, input: input as { id: number }, originalPrompt };
    default:
      throw new Error(`Unknown draft kind: ${kind}`);
  }
}
