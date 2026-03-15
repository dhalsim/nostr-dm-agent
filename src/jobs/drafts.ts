// ---------------------------------------------------------------------------
// jobs/drafts.ts — SQLite-persisted draft store for the job NL flow
//
// Drafts are written by !job-ai (or a separate process e.g. OpenCode tool)
// and read by src/commands/jobs.ts. In-memory Maps cannot be shared across
// processes, so all draft state lives in the SQLite DB.
// ---------------------------------------------------------------------------
import type { CoreDb } from '../db';

import type { CreateJobInput } from './types';
import { CreateJobInputSchema } from './types';

// ---------------------------------------------------------------------------
// Draft entry — create only for now
// ---------------------------------------------------------------------------

export type JobDraftEntry = {
  kind: 'create';
  input: CreateJobInput;
  originalPrompt: string;
};

export type JobDraftRow = JobDraftEntry & { id: number };

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function storeDraft(seenDb: CoreDb, entry: JobDraftEntry): number {
  const now = Date.now();

  const info = seenDb.run(
    `INSERT INTO job_drafts (kind, input, original_prompt, created_at)
     VALUES (?, ?, ?, ?)`,
    [entry.kind, JSON.stringify(entry.input), entry.originalPrompt, now],
  );

  return Number(info.lastInsertRowid);
}

export function getDraft(db: CoreDb, id: number): JobDraftRow | null {
  const row = db.prepare('SELECT * FROM job_drafts WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;

  if (!row) {
    return null;
  }

  return rowToDraft(row);
}

export function listDrafts(db: CoreDb): JobDraftRow[] {
  const rows = db.prepare('SELECT * FROM job_drafts ORDER BY id ASC').all() as Record<
    string,
    unknown
  >[];

  return rows.map(rowToDraft);
}

export function deleteDraft(db: CoreDb, id: number): boolean {
  return db.prepare('DELETE FROM job_drafts WHERE id = ?').run(id).changes > 0;
}

export function updateDraftInput(db: CoreDb, id: number, input: CreateJobInput): boolean {
  const info = db
    .prepare('UPDATE job_drafts SET input = ? WHERE id = ?')
    .run(JSON.stringify(input), id);

  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function rowToDraft(row: Record<string, unknown>): JobDraftRow {
  const id = Number(row.id);
  const kind = String(row.kind);
  const originalPrompt = String(row.original_prompt);

  if (kind !== 'create') {
    throw new Error(`Unknown job draft kind: ${kind}`);
  }

  const inputRaw = JSON.parse(String(row.input));
  const parsed = CreateJobInputSchema.safeParse(inputRaw);

  if (!parsed.success) {
    throw new Error(`Invalid job draft input: ${parsed.error.message}`);
  }

  return {
    id,
    kind: 'create',
    input: parsed.data,
    originalPrompt,
  };
}
