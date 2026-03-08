// ---------------------------------------------------------------------------
// todos/format.ts — Display helpers for todos
// ---------------------------------------------------------------------------
import type { Todo } from './types';

const STATUS_ICON: Record<string, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  done: '[x]',
  cancelled: '[-]',
};

function buildChildMap(todos: Todo[]): Map<number | null, Todo[]> {
  const map = new Map<number | null, Todo[]>();
  for (const t of todos) {
    const key = t.parent_id ?? null;

    if (!map.has(key)) {
      map.set(key, []);
    }

    map.get(key)!.push(t);
  }

  return map;
}

export function formatTodoTree(todos: Todo[]): string {
  if (todos.length === 0) {
    return 'No todos.';
  }

  const childMap = buildChildMap(todos);
  const lines: string[] = [];

  function render(parentId: number | null, prefix: string, indexPath: string) {
    const children = childMap.get(parentId) ?? [];

    children.forEach((t, i) => {
      const label = indexPath ? `${indexPath}.${i + 1}` : `${i + 1}`;
      const icon = STATUS_ICON[t.status] ?? '[ ]';
      const pri = t.priority ? ` [${t.priority}]` : '';
      lines.push(`${prefix}${label}. ${icon} ${t.todo}${pri}  (id: ${t.id})`);
      render(t.id, prefix + '  ', label);
    });
  }

  render(null, '', '');

  return lines.join('\n');
}

export function formatTodoDetail(t: Todo): string {
  const lines = [
    `ID:          ${t.id}`,
    `Todo:        ${t.todo}`,
    `Status:      ${t.status}`,
    `Priority:    ${t.priority ?? '—'}`,
    `Parent:      ${t.parent_id ?? '(top-level)'}`,
    `Tags:        ${t.tags?.join(', ') ?? '—'}`,
    `Description: ${t.description ?? '—'}`,
    `Created:     ${new Date(t.created_at).toLocaleString()}`,
    `Updated:     ${t.updated_at ? new Date(t.updated_at).toLocaleString() : '—'}`,
    `Completed:   ${t.completed_at ? new Date(t.completed_at).toLocaleString() : '—'}`,
  ];

  return lines.join('\n');
}
