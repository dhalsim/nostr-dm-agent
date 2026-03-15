import type { AgentBackend } from '../backends/types';
import type { AgentBackendName, CoreDb } from '../db';
import { getState, STATE_CURRENT_SESSION } from '../db';
import { createNewSession, getLatestSession, setCurrentSession } from '../session';

export type HandleNewSessionProps = {
  seenDb: CoreDb;
  backend: AgentBackend;
  cwd: string;
  agentEnv: Record<string, string | undefined>;
};

export async function handleNewSession({
  seenDb,
  backend,
  cwd,
  agentEnv,
}: HandleNewSessionProps): Promise<string> {
  const id = await createNewSession({
    db: seenDb,
    backend,
    cwd,
    env: agentEnv,
  });

  return `New session: ${id}`;
}

export type HandleResumeLastSessionProps = {
  db: CoreDb;
  backendName: AgentBackendName;
};

export function handleResumeLastSession({ db, backendName }: HandleResumeLastSessionProps): string {
  const id = getLatestSession(db, backendName);

  if (!id) {
    return `No sessions yet for backend '${backendName}'. Send a message or use !new-session.`;
  }

  setCurrentSession(db, id);

  return `Resumed session ${id}.`;
}

export function handleResumeSession({ db, sessionId }: { db: CoreDb; sessionId: string }): string {
  if (!sessionId) {
    return 'Usage: !resume-session <SESSION-ID>';
  }

  if (!setCurrentSession(db, sessionId)) {
    return 'Session not found.';
  }

  return `Resumed session ${sessionId}.`;
}

export function handleListSessions({ db }: { db: CoreDb }): string {
  const rows = db
    .prepare('SELECT id, created_at, backend FROM sessions ORDER BY created_at DESC')
    .all() as { id: string; created_at: number; backend: string }[];

  if (rows.length === 0) {
    return 'No sessions yet.';
  }

  const cur = getState(db, STATE_CURRENT_SESSION);

  return rows
    .map((r) => {
      const date = new Date(r.created_at * 1000).toISOString();
      const mark = r.id === cur ? ' (current)' : '';

      return `[${r.backend ?? 'cursor'}] ${r.id} ${date}${mark}`;
    })
    .join('\n');
}

export function handleShowLastMessages({
  db,
  sessionId,
  n = 5,
}: {
  db: CoreDb;
  sessionId?: string;
  n?: number;
}): string {
  if (!sessionId) {
    return 'Usage: !show-last-messages <SESSION-ID> [N]';
  }

  const rows = db
    .prepare(
      'SELECT role, content FROM session_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?',
    )
    .all(sessionId, n) as { role: string; content: string }[];

  if (rows.length === 0) {
    return 'No messages for that session.';
  }

  return rows
    .reverse()
    .map((r) => `${r.role}: ${r.content.slice(0, 500)}${r.content.length > 500 ? '…' : ''}`)
    .join('\n\n');
}
