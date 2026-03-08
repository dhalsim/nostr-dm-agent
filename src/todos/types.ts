// ---------------------------------------------------------------------------
// todos/types.ts — Types and Zod schemas for the todos feature
// ---------------------------------------------------------------------------
import { z } from 'zod';

export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';
export type TodoPriority = 'low' | 'medium' | 'high';

export type Todo = {
  id: number;
  parent_id: number | null;
  todo: string;
  status: TodoStatus;
  priority: TodoPriority | null;
  sort_order: number | null;
  description: string | null;
  tags: string[] | null;
  source: string | null;
  created_at: number;
  updated_at: number | null;
  completed_at: number | null;
};

export const TodoStatusSchema = z.enum(['pending', 'in_progress', 'done', 'cancelled']);
export const TodoPrioritySchema = z.enum(['low', 'medium', 'high']);

export const CreateTodoInputSchema = z.object({
  todo: z.string().min(1).describe('Short title or one-line description of the todo'),
  parent_id: z
    .number()
    .nullable()
    .describe(
      'ID of the parent todo. NULL for top-level. Call list_todos first to resolve a name to an ID.',
    ),
  priority: TodoPrioritySchema.nullable().describe('Optional priority: low, medium, or high'),
  description: z.string().nullable().describe('Optional longer notes'),
  tags: z.array(z.string()).nullable().describe('Optional tags e.g. ["work", "personal"]'),
});

export type CreateTodoInput = z.infer<typeof CreateTodoInputSchema>;

export const UpdateTodoInputSchema = z.object({
  id: z.number().describe('ID of the todo to update'),
  todo: z.string().min(1).optional().describe('New title'),
  status: TodoStatusSchema.optional().describe('New status'),
  priority: TodoPrioritySchema.nullable().optional().describe('New priority'),
  description: z.string().nullable().optional().describe('New description'),
  tags: z.array(z.string()).nullable().optional().describe('New tags'),
});

export type UpdateTodoInput = z.infer<typeof UpdateTodoInputSchema>;
