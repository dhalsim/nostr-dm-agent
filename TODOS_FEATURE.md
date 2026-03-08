# Todos feature (per-bot)

Detailed spec for the per-bot todos table and commands. Use this as the single source of truth for implementation.

---

## Overview

- Each bot instance has its own **todos** table.
- Todos can be **hierarchical**: any todo can have children via `parent_id`. Nesting is **unlimited** (parent → child → grandchild → …).
- Commands are invoked via chat (e.g. `!todo add`, `!todo list`). Format and exact prefix depend on the bot’s command parser.

---

## Schema

### Table: `todos`

| Column         | Type        | Nullable | Description |
|----------------|-------------|----------|-------------|
| `id`           | primary key | no       | Unique id (e.g. UUID or auto-increment). Used in commands and as target for `parent_id`. |
| `parent_id`    | same as id  | **yes**  | Self-reference to another row. `NULL` = top-level todo. Non-null = this todo is a sub-todo of the referenced row. Enables arbitrary depth. |
| `todo`         | text        | no       | Short title / one-line description. |
| `status`       | text/enum   | no       | e.g. `pending`, `in_progress`, `done`, `cancelled`. Exact values TBD per stack. |
| `priority`     | text/int    | optional | e.g. `low`, `medium`, `high` or 1–5. Optional. |
| `created_at`   | timestamp   | no       | When the todo was created. |
| `updated_at`   | timestamp   | optional | Last modification time. |
| `completed_at` | timestamp   | optional | When `status` was set to `done` (if applicable). |
| `description`  | text        | optional | Longer body / notes. |
| `tags`         | text/array  | optional | e.g. `work`, `personal` (stored as JSON array or comma-separated per DB). |
| `source`       | text        | optional | Origin: e.g. `dm`, `local`, `task`. |
| `sort_order`   | int         | optional | Manual order among **siblings** (same `parent_id`). Lower = higher in list. |

### Constraints and indexes

- **Foreign key:** `parent_id` → `todos(id)`. On delete behavior: **decide** (see [Behavior](#behavior)).
- **Index:** `(parent_id)` for fast “children of X” and “top-level” (`parent_id IS NULL`) queries.
- **Index:** Consider composite `(parent_id, sort_order)` for listing siblings in order.
- **Check (optional):** Prevent circular refs: `parent_id != id` and optionally enforce no cycles in application code or via trigger.

---

## Behavior

### Hierarchy

- **Depth:** Unlimited. A todo’s parent can itself have a parent (grandparent, etc.).
- **Queries:** Use recursive SQL (e.g. CTE / `WITH RECURSIVE`). Top-level list: `WHERE parent_id IS NULL`; children of node X: `WHERE parent_id = X`.
- **Display:** In `!todo list`, render with indentation or bullets by depth (e.g. 2 spaces or `-` per level). Try to be compact. Example:
  ```
  1. Ship feature
    1.1. Write tests
    1.2. Update docs
    1.3. Deploy
  2. Call mom
  ```

### Delete

- **Option A — Cascade delete:** When a todo is deleted, delete all descendants (all sub-todos at any depth). Simple and consistent.
- **Option B — Promote:** When a todo is deleted, set `parent_id` of its direct children to the deleted node’s `parent_id` (so children become siblings of the deleted node or move to grandparent). Grandchildren and below need to be reattached (e.g. to the first child). More complex; only needed if you want to “unwrap” a level without losing subtasks.
- **Recommendation:** Option A (cascade) for v1 unless product explicitly needs “promote on delete”.

### Completion

- **Completing a parent:** Decide one of:
  - **No auto-complete:** Marking parent `done` does not change children. List view can show “Parent (done)” with children still pending.
  - **Auto-complete children:** When parent is marked `done`, set all descendants to `done` and set `completed_at`. Simpler mental model: “task is done = everything under it is done.”
  - **Summary-only:** Parent is “done” only when all descendants are done (computed or stored). Marking parent done could then auto-complete all children.
- **Recommendation:** Document the chosen rule in this file when decided; implement consistently in `!todo done <id>`.

### Ordering

- `sort_order` applies only among **siblings** (same `parent_id`). Within each level, sort by `sort_order` (and optionally `created_at` as tiebreaker). Tree traversal: depth-first by `sort_order` at each level.

---

## Commands

Implement at least the following. Exact syntax (e.g. `!todo` vs `!t`) is bot-dependent.

| Command | Description |
|---------|-------------|
| `!todo add <text>` | Create a top-level todo with `todo = <text>`, `status = pending`, `parent_id = NULL`. Return new `id`. |
| `!todo add <text> under <parent_id>` | Create a sub-todo with `parent_id = <parent_id>`. |
| `!todo list` | List all todos in tree form (top-level first, then children indented). Filter by status optional: e.g. `!todo list pending`. |
| `!todo list --flat` | List all todos in a flat list (optional; useful for small trees or search). |
| `!todo done <id>` | Set todo (and optionally descendants) to `status = done`, set `completed_at = now`. |
| `!todo priority <id> <priority>` | Set `priority` for todo `<id>`. |
| `!todo update <id> <field> <value>` | Update one field (e.g. `todo`, `due_at`, `status`). Optional; can start with add/list/done/priority only. |
| `!todo delete <id>` | Delete todo and (if cascade) all descendants. |
| `!todo show <id>` | Show one todo with full details (todo, status, priority, dates, description, children count or preview). |

Add sub-todos in list output (indented by depth). When showing “done” state, either show only pending by default or show all with a visual (e.g. strikethrough or `[x]`) for done.

---

## Optional / later

- **Tags filter:** `!todo list tag:work`.

---

## Summary for implementation

1. Create `todos` table with all columns above; `parent_id` nullable, FK to `todos(id)`; indexes on `parent_id` and optionally `(parent_id, sort_order)`.
2. Implement add (top-level and “under &lt;id&gt;”), list (tree + optional flat), done, priority, delete, show. Use recursive query or app recursion for tree listing.
3. Choose and implement delete rule (cascade vs promote) and completion rule (no auto-complete vs auto-complete children).
4. Expose commands via the bot’s command parser; document exact command names and examples in the bot’s help or spec.
