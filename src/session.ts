// ---------------------------------------------------------------------------
// session.ts — Session CRUD and management
// ---------------------------------------------------------------------------
import type { Database } from 'bun:sqlite';

import type { AgentBackend } from './backends/types';
import { setState, STATE_CURRENT_SESSION } from './db';

export type CreateNewSessionProps = {
  db: Database;
  backend: AgentBackend;
  cwd: string;
  env: Record<string, string | undefined>;
};

export function createNewSession({ db, backend, cwd, env }: CreateNewSessionProps): string {
  const id = backend.createSession({ cwd, env });
  const now = Math.floor(Date.now() / 1000);

  db.run('INSERT OR IGNORE INTO sessions (id, created_at, backend) VALUES (?, ?, ?)', [
    id,
    now,
    backend.name,
  ]);

  setState(db, STATE_CURRENT_SESSION, id);

  return id;
}

export function getLatestSession(db: Database, backend: AgentBackend): string | null {
  const row = db
    .prepare('SELECT id FROM sessions WHERE backend = ? ORDER BY created_at DESC LIMIT 1')
    .get(backend.name) as { id: string } | undefined;

  return row?.id ?? null;
}

export type GetOrCreateSessionProps = {
  db: Database;
  backend: AgentBackend;
  cwd: string;
  env: Record<string, string | undefined>;
};

export function getOrCreateCurrentSession({
  db,
  backend,
  cwd,
  env,
}: GetOrCreateSessionProps): string {
  const cur = db.prepare('SELECT value FROM state WHERE key = ?').get(STATE_CURRENT_SESSION) as
    | { value: string }
    | undefined;

  if (cur?.value) {
    const exists = db
      .prepare('SELECT 1 FROM sessions WHERE id = ? AND backend = ?')
      .get(cur.value, backend.name);

    if (exists) {
      return cur.value;
    }
  }

  return createNewSession({ db, backend, cwd, env });
}

export function setCurrentSession(db: Database, sessionId: string): boolean {
  const exists = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId);

  if (!exists) {
    return false;
  }

  setState(db, STATE_CURRENT_SESSION, sessionId);

  return true;
}

export function insertSessionMessage(
  db: Database,
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
): void {
  const now = Math.floor(Date.now() / 1000);

  db.run(
    'INSERT INTO session_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)',
    [sessionId, role, content, now],
  );
}
