import type { AgentBackend } from '../backends/types';
import type { SeenDb } from '../db';
import { getDefaultMode, getState, getWorkspaceTarget, STATE_CURRENT_SESSION } from '../db';
import { createNewSession, getLatestSession, setCurrentSession } from '../session';

export async function handleNewSession({
  db,
  backend,
  workspaceRoot,
  dmBotRoot,
  agentEnv,
}: {
  db: SeenDb;
  backend: AgentBackend;
  workspaceRoot: string;
  dmBotRoot: string;
  agentEnv: Record<string, string | undefined>;
}): Promise<string> {
  const workspace = getWorkspaceTarget(db);
  const cwd = workspace === 'bot' ? dmBotRoot : workspaceRoot;
  const mode = getDefaultMode(db);

  const id = await createNewSession({
    db,
    backend,
    cwd,
    env: agentEnv,
  });

  return `New session: ${id}\nBackend: ${backend.name}\nMode: ${mode}\nWorkspace: ${workspace}.`;
}

export function handleResumeLastSession({
  db,
  backend,
}: {
  db: SeenDb;
  backend: AgentBackend;
}): string {
  const id = getLatestSession(db, backend);

  if (!id) {
    return `No sessions yet for backend '${backend.name}'. Send a message or use !new-session.`;
  }

  setCurrentSession(db, id);

  return `Resumed session ${id}.`;
}

export function handleResumeSession({ db, sessionId }: { db: SeenDb; sessionId: string }): string {
  if (!sessionId) {
    return 'Usage: !resume-session <SESSION-ID>';
  }

  if (!setCurrentSession(db, sessionId)) {
    return 'Session not found.';
  }

  return `Resumed session ${sessionId}.`;
}

export function handleListSessions({ db }: { db: SeenDb }): string {
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
  db: SeenDb;
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
