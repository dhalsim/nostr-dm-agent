// ---------------------------------------------------------------------------
// todos/drafts.ts — Shared in-memory draft store for the todo NL flow
// ---------------------------------------------------------------------------
import type { CreateTodoInput, UpdateTodoInput } from './types';

// ---------------------------------------------------------------------------
// Draft kind union — one discriminated variant per mutating operation
// ---------------------------------------------------------------------------

export type CreateDraftEntry = {
  kind: 'create';
  input: CreateTodoInput;
  originalPrompt: string;
  history: string[];
};

export type UpdateDraftEntry = {
  kind: 'update';
  input: UpdateTodoInput;
  originalPrompt: string;
  history: string[];
};

export type DeleteDraftEntry = {
  kind: 'delete';
  input: { id: number };
  originalPrompt: string;
  history: string[];
};

export type TodoDraftEntry = CreateDraftEntry | UpdateDraftEntry | DeleteDraftEntry;

export const draftStore = new Map<number, TodoDraftEntry>();

let nextDraftId = 1;

/** Sequential draft ID (auto-increment, like todo ids). */
export function getNextDraftId(): number {
  return nextDraftId++;
}
