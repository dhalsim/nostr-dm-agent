// ---------------------------------------------------------------------------
// session.ts — Session CRUD and management
// ---------------------------------------------------------------------------
import type { Database } from 'bun:sqlite';

import { createBackend } from './backends/factory';
import { setState, STATE_CURRENT_SESSION, type AgentBackendName, type AgentMode } from './db';

export type CreateNewSessionProps = {
  db: Database;
  backendName: AgentBackendName;
  cwd: string;
  dmBotRoot: string;
  env: Record<string, string | undefined>;
  mode: AgentMode;
  attachUrl: string | null;
};

export function createNewSession({
  db,
  backendName,
  cwd,
  dmBotRoot,
  env,
  mode,
  attachUrl,
}: CreateNewSessionProps): string {
  const backend = createBackend({ name: backendName, dmBotRoot, mode, attachUrl });
  const id = backend.createSession({ cwd, env });
  const now = Math.floor(Date.now() / 1000);

  db.run('INSERT OR IGNORE INTO sessions (id, created_at, backend) VALUES (?, ?, ?)', [
    id,
    now,
    backendName,
  ]);

  setState(db, STATE_CURRENT_SESSION, id);

  return id;
}

export function getLatestSession(db: Database, backendName: AgentBackendName): string | null {
  const row = db
    .prepare('SELECT id FROM sessions WHERE backend = ? ORDER BY created_at DESC LIMIT 1')
    .get(backendName) as { id: string } | undefined;

  return row?.id ?? null;
}

export type GetOrCreateSessionProps = {
  db: Database;
  backendName: AgentBackendName;
  cwd: string;
  dmBotRoot: string;
  env: Record<string, string | undefined>;
  mode: AgentMode;
  attachUrl: string | null;
};

export function getOrCreateCurrentSession({
  db,
  backendName,
  cwd,
  dmBotRoot,
  env,
  mode,
  attachUrl,
}: GetOrCreateSessionProps): string {
  const cur = db.prepare('SELECT value FROM state WHERE key = ?').get(STATE_CURRENT_SESSION) as
    | { value: string }
    | undefined;

  if (cur?.value) {
    const exists = db
      .prepare('SELECT 1 FROM sessions WHERE id = ? AND backend = ?')
      .get(cur.value, backendName);

    if (exists) {
      return cur.value;
    }
  }

  return createNewSession({ db, backendName, cwd, dmBotRoot, env, mode, attachUrl });
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
