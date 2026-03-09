// ---------------------------------------------------------------------------
// commands/todos.ts — !todo sub-command handler
// ---------------------------------------------------------------------------
import type { SeenDb } from '../db';
import { createTodo, deleteTodo, doneTodo, getTodo, listTodos, updateTodo } from '../todos/db';
import { draftStore } from '../todos/drafts';
import { formatTodoDetail, formatTodoTree } from '../todos/format';
import { CreateTodoInputSchema, TodoStatusSchema } from '../todos/types';
import type { CreateTodoInput } from '../todos/types';

// ---------------------------------------------------------------------------
// Preview formatting
// ---------------------------------------------------------------------------

function formatDraftPreview(id: number, input: CreateTodoInput): string {
  const lines = [
    `todo       : ${input.todo}`,
    `parent_id  : ${input.parent_id ?? '(top-level)'}`,
    `priority   : ${input.priority ?? '—'}`,
    `description: ${input.description ?? '—'}`,
    `tags       : ${input.tags?.join(', ') ?? '—'}`,
    ``,
    `Draft ID: ${id}`,
    `Reply: !todo accept ${id} | !todo revise ${id} <corrections> | !todo decline ${id}`,
  ];

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export type HandleTodoProps = {
  args: string[];
  db: SeenDb;
};

export async function handleTodo({ args, db }: HandleTodoProps): Promise<string> {
  const sub = args[0]?.toLowerCase();
  const rest = args.slice(1);

  if (!sub || sub === 'help') {
    return [
      '!todo add <text>                   — add a top-level todo',
      '!todo add <text> under <parent_id> — add a sub-todo',
      '!todo list [pending|done|all]      — list todos as tree (default: pending)',
      '!todo list --flat                  — flat list',
      '!todo show <id>                    — show todo detail',
      '!todo done <id>                    — mark done (cascades to children)',
      '!todo priority <id> <low|medium|high>',
      '!todo update <id> <field> <value>  — update a field (todo, status, priority, description)',
      '!todo delete <id>                  — delete todo and all descendants',
      '!todo accept <draft_id>            — confirm a draft and execute it',
      '!todo revise <draft_id> <text>     — revise a pending create draft',
      '!todo decline <draft_id>           — discard a draft',
      '!todo drafts                       — list pending drafts',
      '!todo help                         — this message',
    ].join('\n');
  }

  // --- add ---
  if (sub === 'add') {
    const underIdx = rest.findIndex((a) => a.toLowerCase() === 'under');
    let text: string;
    let parentId: number | null = null;

    if (underIdx !== -1) {
      text = rest.slice(0, underIdx).join(' ').trim();
      const raw = rest[underIdx + 1]?.trim();
      parentId = raw ? parseInt(raw, 10) : null;

      if (raw && Number.isNaN(parentId!)) {
        return 'Invalid parent_id. Use a number (e.g. under 2).';
      }
    } else {
      text = rest.join(' ').trim();
    }

    if (!text) {
      return 'Usage: !todo add <text> [under <parent_id>]';
    }

    if (parentId != null && !getTodo(db, parentId)) {
      return `Parent todo not found: ${parentId}`;
    }

    const todo = createTodo(
      db,
      {
        todo: text,
        parent_id: parentId,
        priority: null,
        description: null,
        tags: null,
      },
      'dm',
    );

    return `Todo created: ${todo.id}\n${formatTodoDetail(todo)}`;
  }

  // --- list ---
  if (sub === 'list') {
    const flat = rest.includes('--flat');
    const filterArg = rest.find((a) => !a.startsWith('-'))?.toLowerCase();

    let todos = listTodos(db);

    if (!filterArg || filterArg === 'pending') {
      todos = todos.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
    } else if (filterArg !== 'all') {
      todos = todos.filter((t) => t.status === filterArg);
    }

    if (todos.length === 0) {
      return 'No todos matching filter.';
    }

    if (flat) {
      return todos
        .map(
          (t) =>
            `${t.id} ${STATUS_ICON[t.status] ?? '[ ]'} ${t.todo}${t.priority ? ` [${t.priority}]` : ''}`,
        )
        .join('\n');
    }

    return formatTodoTree(todos);
  }

  // --- show ---
  if (sub === 'show') {
    const idRaw = rest[0]?.trim();

    if (!idRaw) {
      return 'Usage: !todo show <id>';
    }

    const id = parseInt(idRaw, 10);

    if (Number.isNaN(id)) {
      return 'Usage: !todo show <id> (id must be a number)';
    }

    const todo = getTodo(db, id);

    if (!todo) {
      return `Todo not found: ${id}`;
    }

    return formatTodoDetail(todo);
  }

  // --- done ---
  if (sub === 'done') {
    const idRaw = rest[0]?.trim();

    if (!idRaw) {
      return 'Usage: !todo done <id>';
    }

    const id = parseInt(idRaw, 10);

    if (Number.isNaN(id)) {
      return 'Usage: !todo done <id> (id must be a number)';
    }

    if (!doneTodo(db, id)) {
      return `Todo not found: ${id}`;
    }

    return `Todo ${id} marked done (and all descendants).`;
  }

  // --- priority ---
  if (sub === 'priority') {
    const idRaw = rest[0]?.trim();
    const pri = rest[1]?.trim();

    if (!idRaw || !pri) {
      return 'Usage: !todo priority <id> <low|medium|high>';
    }

    const id = parseInt(idRaw, 10);

    if (Number.isNaN(id)) {
      return 'Usage: !todo priority <id> <low|medium|high> (id must be a number)';
    }

    const parsed = CreateTodoInputSchema.shape.priority.safeParse(pri);

    if (!parsed.success) {
      return 'Priority must be: low, medium, or high';
    }

    const updated = updateTodo(db, { id, priority: parsed.data });

    if (!updated) {
      return `Todo not found: ${id}`;
    }

    return `Priority updated.\n${formatTodoDetail(updated)}`;
  }

  // --- update ---
  if (sub === 'update') {
    const idRaw = rest[0]?.trim();

    if (!idRaw) {
      return 'Usage: !todo update <id> <field> <value>';
    }

    const id = parseInt(idRaw, 10);

    if (Number.isNaN(id)) {
      return 'Usage: !todo update <id> <field> <value> (id must be a number)';
    }

    const field = rest[1]?.toLowerCase();
    const value = rest.slice(2).join(' ').trim();

    if (!field || !value) {
      return 'Usage: !todo update <id> <field> <value>';
    }

    const existing = getTodo(db, id);

    if (!existing) {
      return `Todo not found: ${id}`;
    }

    switch (field) {
      case 'todo':
      case 'title': {
        const updated = updateTodo(db, { id, todo: value });

        return `Todo updated.\n${formatTodoDetail(updated!)}`;
      }

      case 'status': {
        const statusParsed = TodoStatusSchema.safeParse(value);

        if (!statusParsed.success) {
          return 'Status must be: pending, in_progress, done, or cancelled';
        }

        const updated = updateTodo(db, { id, status: statusParsed.data });

        return `Status updated.\n${formatTodoDetail(updated!)}`;
      }

      case 'priority': {
        const priParsed = CreateTodoInputSchema.shape.priority.safeParse(value);

        if (!priParsed.success) {
          return 'Priority must be: low, medium, or high';
        }

        const updated = updateTodo(db, { id, priority: priParsed.data });

        return `Priority updated.\n${formatTodoDetail(updated!)}`;
      }

      case 'description': {
        const updated = updateTodo(db, { id, description: value });

        return `Description updated.\n${formatTodoDetail(updated!)}`;
      }

      default:
        return `Unknown field: ${field}. Supported fields: todo, status, priority, description`;
    }
  }

  // --- delete ---
  if (sub === 'delete') {
    const idRaw = rest[0]?.trim();

    if (!idRaw) {
      return 'Usage: !todo delete <id>';
    }

    const id = parseInt(idRaw, 10);

    if (Number.isNaN(id)) {
      return 'Usage: !todo delete <id> (id must be a number)';
    }

    if (!deleteTodo(db, id)) {
      return `Todo not found: ${id}`;
    }

    return `Todo ${id} deleted (and all descendants).`;
  }

  // --- drafts ---
  if (sub === 'drafts') {
    if (draftStore.size === 0) {
      return 'No pending drafts.';
    }

    const lines = [...draftStore.entries()].map(([id, e]) => {
      switch (e.kind) {
        case 'create':
          return `${id} | create | ${e.input.todo} | parent: ${e.input.parent_id ?? 'top-level'}`;
        case 'update':
          return `${id} | update | todo #${e.input.id}${e.input.todo ? ` → "${e.input.todo}"` : ''}`;
        case 'delete':
          return `${id} | delete | todo #${e.input.id}`;
      }
    });

    return `Pending drafts:\n${lines.join('\n')}`;
  }

  const draftIdRaw = rest[0]?.trim();

  const draftId =
    draftIdRaw !== undefined && draftIdRaw !== '' ? parseInt(draftIdRaw, 10) : undefined;

  const draftIdInvalid =
    draftIdRaw !== undefined &&
    draftIdRaw !== '' &&
    (draftId === undefined || Number.isNaN(draftId));

  // --- accept ---
  if (sub === 'accept') {
    if (!draftIdRaw || draftIdInvalid) {
      return 'Usage: !todo accept <draft_id> (draft_id must be a number)';
    }

    const entry = draftStore.get(draftId!);

    if (!entry) {
      return `Draft not found: ${draftId}`;
    }

    draftStore.delete(draftId!);

    switch (entry.kind) {
      case 'create': {
        const todo = createTodo(db, entry.input, 'dm');

        return `Todo created: ${todo.id}\n${formatTodoDetail(todo)}`;
      }

      case 'update': {
        const updated = updateTodo(db, entry.input);

        if (!updated) {
          return `Todo not found: ${entry.input.id}`;
        }

        return `Todo updated.\n${formatTodoDetail(updated)}`;
      }

      case 'delete': {
        const todo = getTodo(db, entry.input.id);
        const label = todo ? `"${todo.todo}"` : `#${entry.input.id}`;

        if (!deleteTodo(db, entry.input.id)) {
          return `Todo not found: ${entry.input.id}`;
        }

        return `Todo ${label} (id: ${entry.input.id}) deleted (and all descendants).`;
      }
    }
  }

  // --- revise ---
  if (sub === 'revise') {
    if (!draftIdRaw || draftIdInvalid) {
      return 'Usage: !todo revise <draft_id> <corrections> (draft_id must be a number)';
    }

    const corrections = rest.slice(1).join(' ').trim();

    if (!corrections) {
      return 'Usage: !todo revise <draft_id> <corrections>';
    }

    const entry = draftStore.get(draftId!);

    if (!entry) {
      return `Draft not found: ${draftId}`;
    }

    if (entry.kind !== 'create') {
      return `Draft ${draftId} is a ${entry.kind} draft. Use !todo decline ${draftId} and re-run your request with the correction applied.`;
    }

    return [
      `Revision noted: "${corrections}"`,
      `Original prompt: "${entry.originalPrompt}"`,
      `Please re-run your natural language request with the revision applied,`,
      `or use !todo add directly.`,
    ].join('\n');
  }

  // --- decline ---
  if (sub === 'decline') {
    if (!draftIdRaw || draftIdInvalid) {
      return 'Usage: !todo decline <draft_id> (draft_id must be a number)';
    }

    if (!draftStore.has(draftId!)) {
      return `Draft not found: ${draftId}`;
    }

    draftStore.delete(draftId!);

    return `Draft ${draftId} discarded.`;
  }

  return `Unknown subcommand: ${sub}. Use !todo help.`;
}

// ---------------------------------------------------------------------------
// Internal constants (duplicated from format.ts to avoid import in flat list)
// ---------------------------------------------------------------------------

const STATUS_ICON: Record<string, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  done: '[x]',
  cancelled: '[-]',
};

// Re-export formatDraftPreview for use in opencode tools
export { formatDraftPreview };
