// ---------------------------------------------------------------------------
// todos/drafts.ts — Shared in-memory draft store for the todo NL flow
// ---------------------------------------------------------------------------
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
