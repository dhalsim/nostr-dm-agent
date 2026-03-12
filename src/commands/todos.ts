// ---------------------------------------------------------------------------
// src/commands/todos.ts — !todo sub-command handler
// ---------------------------------------------------------------------------
import type { AgentBackend } from '../backends/types';
import type { SeenDb } from '../db';
import { createTodo, deleteTodo, doneTodo, getTodo, listTodos, updateTodo } from '../todos/db';
import { deleteDraft, getDraft, listDrafts, storeDraft } from '../todos/drafts';
import { formatTodoDetail, formatTodoTree } from '../todos/format';
import { CreateTodoInputSchema, TodoStatusSchema } from '../todos/types';
import type { CreateTodoInput } from '../todos/types';
import { buildSystemPrompt, parseTodoToolCalls } from '../tools/todo-ai';

// ---------------------------------------------------------------------------
// Preview formatting
// ---------------------------------------------------------------------------

function formatDraftPreview(id: number, input: CreateTodoInput): string {
  return [
    `todo       : ${input.todo}`,
    `parent_id  : ${input.parent_id ?? '(top-level)'}`,
    `priority   : ${input.priority ?? '—'}`,
    `description: ${input.description ?? '—'}`,
    `tags       : ${input.tags?.join(', ') ?? '—'}`,
    ``,
    `Draft ID: ${id}`,
    `Reply: !todo accept ${id} | !todo revise ${id} <corrections> | !todo decline ${id}`,
  ].join('\n');
}

function formatDraftRow(
  id: number,
  entry: {
    kind: string;
    input: { todo?: string; id?: number; parent_id?: number | null; priority?: string | null };
  },
): string {
  if (entry.kind === 'create' || entry.kind === 'update') {
    return `#${id} [${entry.kind}] | ${entry.input.todo ?? '—'} | parent: ${entry.input.parent_id ?? 'top-level'} | ${entry.input.priority ?? '—'}`;
  }

  return `#${id} [${entry.kind}] | todo id: ${entry.input.id}`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export type HandleTodoProps = {
  args: string[];
  db: SeenDb;
  backend: AgentBackend;
  sessionId: string;
  cwd: string;
  agentEnv: Record<string, string | undefined>;
};

export async function handleTodo({
  args,
  db,
  backend,
  sessionId,
  cwd,
  agentEnv,
}: HandleTodoProps): Promise<string> {
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
      '!todo revise <draft_id> <text>     — note a revision on a pending draft',
      '!todo decline <draft_id>           — discard a draft',
      '!todo drafts [draft_id]            — list all drafts or show one in detail',
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
      { todo: text, parent_id: parentId, priority: null, description: null, tags: null },
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

    if (!getTodo(db, id)) {
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
        return `Unknown field: ${field}. Supported: todo, status, priority, description`;
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
    const idRaw = rest[0]?.trim();

    if (idRaw) {
      const id = parseInt(idRaw, 10);

      if (Number.isNaN(id)) {
        return 'Usage: !todo drafts [draft_id] (draft_id must be a number)';
      }

      const entry = getDraft(db, id);

      if (!entry) {
        return `Draft not found: ${id}`;
      }

      if (entry.kind === 'create') {
        const c = entry.input;

        return [
          `Draft #${id} [create]:`,
          `  todo        : ${c.todo}`,
          `  parent      : ${c.parent_id ?? '(top-level)'}`,
          `  priority    : ${c.priority ?? '—'}`,
          `  description : ${c.description ?? '—'}`,
          `  tags        : ${c.tags?.join(', ') ?? '—'}`,
          `  prompt      : ${entry.originalPrompt}`,
          ``,
          `  !todo accept ${id} | !todo revise ${id} <corrections> | !todo decline ${id}`,
        ].join('\n');
      }

      if (entry.kind === 'update') {
        const u = entry.input;

        const existing = getTodo(db, u.id);

        const targetLine = existing
          ? `  target      : #${u.id} "${existing.todo}"`
          : `  target      : #${u.id}`;

        const fieldLines = Object.entries(u)
          .filter(([k, v]) => k !== 'id' && v !== undefined)
          .map(([k, v]) => {
            const val = v === null ? '—' : Array.isArray(v) ? v.join(', ') : String(v);

            const oldVal =
              existing && (k === 'status' || k === 'priority' || k === 'todo')
                ? ((existing as Record<string, unknown>)[k] ?? '—')
                : null;

            const oldStr = oldVal !== null ? `${oldVal} → ` : '';

            return `  ${k.padEnd(12)}: ${oldStr}${val}`;
          });

        return [
          `Draft #${id} [update]:`,
          targetLine,
          ...(fieldLines.length > 0 ? fieldLines : ['  (no fields set)']),
          `  prompt      : ${entry.originalPrompt}`,
          ``,
          `  !todo accept ${id} | !todo revise ${id} <corrections> | !todo decline ${id}`,
        ].join('\n');
      }

      // delete draft
      return [
        `Draft #${id} [delete]:`,
        `  target todo id: ${entry.input.id}`,
        `  prompt        : ${entry.originalPrompt}`,
        ``,
        `  !todo accept ${id} | !todo decline ${id}`,
      ].join('\n');
    }

    const drafts = listDrafts(db);

    if (drafts.length === 0) {
      return 'No pending drafts.';
    }

    const lines = drafts.map((d) => formatDraftRow(d.id, d));

    return `Pending drafts (${drafts.length}):\n${lines.join('\n')}`;
  }

  // --- parse draft id for accept/revise/decline ---
  const draftIdRaw = rest[0]?.trim();
  const draftId = draftIdRaw ? parseInt(draftIdRaw, 10) : NaN;
  const draftIdInvalid = !draftIdRaw || Number.isNaN(draftId);

  // --- accept ---
  if (sub === 'accept') {
    // accept all
    if (rest[0]?.toLowerCase() === 'all') {
      const drafts = listDrafts(db);

      if (drafts.length === 0) {
        return 'No pending drafts.';
      }

      const results: string[] = [];
      const errors: string[] = [];

      for (const draft of drafts) {
        deleteDraft(db, draft.id);

        switch (draft.kind) {
          case 'create': {
            if (draft.input.parent_id != null && !getTodo(db, draft.input.parent_id)) {
              errors.push(
                `Draft #${draft.id} "${draft.input.todo}": parent #${draft.input.parent_id} not found — skipped`,
              );

              break;
            }

            const todo = createTodo(db, draft.input, 'dm');
            results.push(`#${todo.id} ${todo.todo}`);
            break;
          }

          case 'update': {
            const updated = updateTodo(db, draft.input);

            if (!updated) {
              errors.push(`Draft #${draft.id}: todo #${draft.input.id} not found — skipped`);
            } else {
              results.push(`#${updated.id} updated`);
            }

            break;
          }

          case 'delete': {
            if (!deleteTodo(db, draft.input.id)) {
              errors.push(`Draft #${draft.id}: todo #${draft.input.id} not found — skipped`);
            } else {
              results.push(`#${draft.input.id} deleted`);
            }

            break;
          }
        }
      }

      const lines = [`Accepted ${results.length} draft(s):`];

      if (results.length > 0) {
        lines.push(...results.map((r) => `  ✓ ${r}`));
      }

      if (errors.length > 0) {
        lines.push('', `Skipped ${errors.length}:`, ...errors.map((e) => `  ✗ ${e}`));
      }

      return lines.join('\n');
    }

    // single accept
    if (draftIdInvalid) {
      return 'Usage: !todo accept <draft_id> | !todo accept all';
    }

    const entry = getDraft(db, draftId);

    if (!entry) {
      return `Draft not found: ${draftId}`;
    }

    deleteDraft(db, draftId);

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
    if (draftIdInvalid) {
      return 'Usage: !todo revise <draft_id> <corrections> (draft_id must be a number)';
    }

    const corrections = rest.slice(1).join(' ').trim();

    if (!corrections) {
      return 'Usage: !todo revise <draft_id> <corrections>';
    }

    const entry = getDraft(db, draftId);

    if (!entry) {
      return `Draft not found: ${draftId}`;
    }

    if (entry.kind !== 'create') {
      return `Draft ${draftId} is a ${entry.kind} draft. Use !todo decline ${draftId} and create a new one with the correction applied.`;
    }

    const allTodos = listTodos(db);
    const activeTodos = allTodos.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
    const activeTree = activeTodos.length > 0 ? formatTodoTree(activeTodos) : '(no active todos)';

    const revisedPrompt = `Revise the following todo: "${entry.input.todo}". Correction: "${corrections}".`;
    const systemPrompt = buildSystemPrompt(revisedPrompt, activeTree);

    const result = await backend.runMessage({
      sessionId,
      content: systemPrompt,
      mode: 'ask',
      cwd,
      env: agentEnv,
      modelOverride: null,
    });

    const raw = result.output.trim();

    if (!raw || raw === '(no output)') {
      return 'AI returned no output. Try running: !todo-ai <revised description>';
    }

    const results = parseTodoToolCalls(raw);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');

    if (fulfilled.length !== 1) {
      const firstRejected = results.find((r) => r.status === 'rejected');

      const msg =
        firstRejected?.status === 'rejected'
          ? firstRejected.reason.message
          : 'Expected exactly one tool call';

      return `Failed to parse AI response: ${msg}. Try running: !todo-ai <revised description>`;
    }

    const call = fulfilled[0].value;

    if (call.type !== 'create') {
      return `AI did not return a create command. Try running: !todo-ai <revised description>`;
    }

    const newDraftId = storeDraft(db, {
      kind: 'create',
      input: call.input,
      originalPrompt: `${entry.originalPrompt} (revised: ${corrections})`,
    });

    deleteDraft(db, draftId);

    return [
      `Draft #${draftId} revised. Created new draft #${newDraftId}:`,
      '',
      formatDraftPreview(newDraftId, call.input),
      '',
      `To accept the revised draft: !todo accept ${newDraftId}`,
      `To decline the revised draft: !todo decline ${newDraftId}`,
    ].join('\n');
  }

  // --- decline ---
  if (sub === 'decline') {
    if (draftIdInvalid) {
      return 'Usage: !todo decline <draft_id> (draft_id must be a number)';
    }

    if (!getDraft(db, draftId)) {
      return `Draft not found: ${draftId}`;
    }

    deleteDraft(db, draftId);

    return `Draft ${draftId} discarded.`;
  }

  return `Unknown subcommand: ${sub}. Use !todo help.`;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const STATUS_ICON: Record<string, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  done: '[x]',
  cancelled: '[-]',
};

export { formatDraftPreview };
