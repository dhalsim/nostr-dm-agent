// ---------------------------------------------------------------------------
// plugins/{{ALIAS}}/db.ts — Schema and CRUD for the {{ALIAS}} plugin
//
// Replace the minimal table and stubs with your real schema and logic:
// - create{{PASCAL_ALIAS}}Table: define your tables and indexes
// - get{{PASCAL_ALIAS}}, list{{PASCAL_ALIAS}}s, create{{PASCAL_ALIAS}}, update{{PASCAL_ALIAS}}, delete{{PASCAL_ALIAS}}
// - If you need a draft tree (e.g. hierarchical create): add create{{PASCAL_ALIAS}}sFromDraftTree
//   and wire it in commands.ts (accept subcommand).
// ---------------------------------------------------------------------------
import type { Database } from 'bun:sqlite';

import type { {{PASCAL_ALIAS}}, Create{{PASCAL_ALIAS}}Input, Update{{PASCAL_ALIAS}}Input } from './types';

function rowTo{{PASCAL_ALIAS}}(row: Record<string, unknown>): {{PASCAL_ALIAS}} {
  return {
    id: Number(row.id),
    data: String(row.data),
    created_at: Number(row.created_at),
  };
}

export function create{{PASCAL_ALIAS}}Table(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS {{ALIAS}}s (
      id         INTEGER PRIMARY KEY,
      data       TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}

export function create{{PASCAL_ALIAS}}(
  db: Database,
  input: Create{{PASCAL_ALIAS}}Input,
  _source?: string,
): {{PASCAL_ALIAS}} {
  const now = Date.now();
  const info = db.run(
    `INSERT INTO {{ALIAS}}s (data, created_at) VALUES (?, ?)`,
    [input.data, now],
  );
  const id = Number(info.lastInsertRowid);
  return get{{PASCAL_ALIAS}}(db, id)!;
}

export function get{{PASCAL_ALIAS}}(db: Database, id: number): {{PASCAL_ALIAS}} | null {
  const row = db.prepare('SELECT * FROM {{ALIAS}}s WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowTo{{PASCAL_ALIAS}}(row) : null;
}

export function list{{PASCAL_ALIAS}}s(db: Database): {{PASCAL_ALIAS}}[] {
  const rows = db.prepare('SELECT * FROM {{ALIAS}}s ORDER BY id').all() as Record<
    string,
    unknown
  >[];
  return rows.map(rowTo{{PASCAL_ALIAS}});
}

export function update{{PASCAL_ALIAS}}(db: Database, input: Update{{PASCAL_ALIAS}}Input): {{PASCAL_ALIAS}} | null {
  const existing = get{{PASCAL_ALIAS}}(db, input.id);
  if (!existing) return null;
  if (input.data !== undefined) {
    db.run('UPDATE {{ALIAS}}s SET data = ? WHERE id = ?', [input.data, input.id]);
  }
  return get{{PASCAL_ALIAS}}(db, input.id);
}

export function delete{{PASCAL_ALIAS}}(db: Database, id: number): boolean {
  const info = db.prepare('DELETE FROM {{ALIAS}}s WHERE id = ?').run(id);
  return info.changes > 0;
}
