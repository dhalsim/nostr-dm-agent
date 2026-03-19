// ---------------------------------------------------------------------------
// plugins/{{ALIAS}}/types.ts — Types and Zod schemas for the {{ALIAS}} plugin
//
// Replace with your entity shape and validation. Define at least:
// - Main entity type (e.g. {{PASCAL_ALIAS}}) and Zod schema
// - Create/Update input schemas for OpenCode tools and commands
// - If using draft/confirm: Create{{PASCAL_ALIAS}}Draft and Update{{PASCAL_ALIAS}}Input
//   so drafts.ts and opencode.ts type-check.
// ---------------------------------------------------------------------------
import { z } from 'zod';

// Minimal stub so the plugin loads. Replace with your real entity and schemas.
export const {{PASCAL_ALIAS}}Schema = z.object({
  id: z.number(),
  data: z.string(),
  created_at: z.number(),
});

export type {{PASCAL_ALIAS}} = z.infer<typeof {{PASCAL_ALIAS}}Schema>;

export const Create{{PASCAL_ALIAS}}InputSchema = z.object({
  data: z.string().min(1).describe('Content or payload for the new {{ALIAS}} item'),
});

export type Create{{PASCAL_ALIAS}}Input = z.infer<typeof Create{{PASCAL_ALIAS}}InputSchema>;

export const Update{{PASCAL_ALIAS}}InputSchema = z.object({
  id: z.number(),
  data: z.string().min(1).optional(),
});

export type Update{{PASCAL_ALIAS}}Input = z.infer<typeof Update{{PASCAL_ALIAS}}InputSchema>;

// Stub for draft flow. Replace with your draft shape (e.g. tree, nested fields).
export interface Create{{PASCAL_ALIAS}}Draft {
  data: string;
}

export const Create{{PASCAL_ALIAS}}DraftSchema: z.ZodType<Create{{PASCAL_ALIAS}}Draft> =
  z.object({
    data: z.string().min(1),
  });
