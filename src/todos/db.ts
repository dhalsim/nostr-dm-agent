// ---------------------------------------------------------------------------
// todos/db.ts — CRUD operations for the todos table
// ---------------------------------------------------------------------------
import type { SeenDb } from '../db';

import type { Todo, CreateTodoInput, UpdateTodoInput, TodoStatus } from './types';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function rowToTodo(row: Record<string, unknown>): Todo {
  return {
    id: Number(row.id),
    parent_id: row.parent_id != null ? Number(row.parent_id) : null,
    todo: String(row.todo),
    status: String(row.status) as TodoStatus,
    priority: row.priority != null ? (String(row.priority) as Todo['priority']) : null,
    sort_order: row.sort_order != null ? Number(row.sort_order) : null,
    description: row.description != null ? String(row.description) : null,
    tags: row.tags != null ? (JSON.parse(String(row.tags)) as string[]) : null,
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
  const now = Date.now();

  const info = db.run(
    `INSERT INTO todos (parent_id, todo, status, priority, description, tags, source, created_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [
      input.parent_id ?? null,
      input.todo,
      input.priority ?? null,
      input.description ?? null,
      input.tags ? JSON.stringify(input.tags) : null,
      source ?? null,
      now,
    ],
  );

  const id = Number(info.lastInsertRowid); // bigint in bun:sqlite

  return getTodo(db, id)!;
}

export function getTodo(db: SeenDb, id: number): Todo | null {
  const row = db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;

  return row ? rowToTodo(row) : null;
}

export function listTodos(db: SeenDb): Todo[] {
  // Return all rows in depth-first order by sort_order at each level.
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
    .prepare(`SELECT * FROM todos WHERE parent_id IS NULL ORDER BY sort_order, created_at`)
    .all() as Record<string, unknown>[];

  return rows.map(rowToTodo);
}

export function listChildTodos(db: SeenDb, parentId: number): Todo[] {
  const rows = db
    .prepare(`SELECT * FROM todos WHERE parent_id = ? ORDER BY sort_order, created_at`)
    .all(parentId) as Record<string, unknown>[];

  return rows.map(rowToTodo);
}

export function updateTodo(db: SeenDb, input: UpdateTodoInput): Todo | null {
  const existing = getTodo(db, input.id);

  if (!existing) {
    return null;
  }

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
        ? input.tags
          ? JSON.stringify(input.tags)
          : null
        : existing.tags
          ? JSON.stringify(existing.tags)
          : null,
      now,
      completedAt,
      input.id,
    ],
  );

  return getTodo(db, input.id);
}

export function doneTodo(db: SeenDb, id: number, cascade = true): boolean {
  const todo = getTodo(db, id);

  if (!todo) {
    return false;
  }

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
      [id, now, now],
    );
  } else {
    db.run(`UPDATE todos SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?`, [
      now,
      now,
      id,
    ]);
  }

  return true;
}

export function deleteTodo(db: SeenDb, id: number): boolean {
  // CASCADE on the FK handles descendants automatically (requires PRAGMA foreign_keys = ON)
  const info = db.prepare('DELETE FROM todos WHERE id = ?').run(id);

  return info.changes > 0;
}
