# Todo Duel — Technical Implementation Plan

## Overview

Replace the `high/medium/low` priority field with a **pairwise comparison graph**.
Scores are never stored — they are derived at query time from win-rate across sibling comparisons.
The duel system runs as an **internal async loop** using `promptFn` from `PluginContext`, requiring
no session persistence and no in-memory state. Pairs already ordered transitively are auto-resolved
silently. Dueling continues until all directly uncompared pairs are exhausted, then stops.

---

## 1. Database changes

### 1.1 Migrate existing priority field

```sql
-- Drop old text priority column
ALTER TABLE todos DROP COLUMN priority;
```

### 1.2 New comparisons table

```sql
CREATE TABLE todo_comparisons (
  winner_id   INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  loser_id    INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  compared_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (winner_id, loser_id)
);

CREATE INDEX idx_comparisons_winner ON todo_comparisons(winner_id);
CREATE INDEX idx_comparisons_loser  ON todo_comparisons(loser_id);
```

---

## 2. Core utilities

### 2.1 Parse parent ID from args

```typescript
// null = root level (parent_id IS NULL in SQLite)
// Works consistently for all commands — no special casing needed
function getParentId(args: string[]): number | null {
  const id = args[0] ? parseInt(args[0]) : undefined;
  return id ?? null;
}
```

### 2.2 Win-rate query

```typescript
// Returns siblings sorted by win-rate descending, unscored (no comparisons) last
function getRankedSiblings(db: Database, parentId: number | null): Todo[] {
  return db.query(`
    SELECT
      t.*,
      COUNT(w.winner_id) AS wins,
      COUNT(l.loser_id)  AS losses,
      CASE
        WHEN COUNT(w.winner_id) + COUNT(l.loser_id) = 0 THEN NULL
        ELSE CAST(COUNT(w.winner_id) AS REAL)
             / (COUNT(w.winner_id) + COUNT(l.loser_id))
      END AS win_rate
    FROM todos t
    LEFT JOIN todo_comparisons w ON w.winner_id = t.id
    LEFT JOIN todo_comparisons l ON l.loser_id  = t.id
    WHERE t.parent_id IS ?
      AND t.status != 'done'
    GROUP BY t.id
    ORDER BY win_rate DESC NULLS LAST
  `, [parentId]).all() as Todo[];
}
```

### 2.3 Get next uncompared pair

Dynamically finds the next pair where at least one sibling has never been compared.
Unscored items (zero comparisons ever) are prioritized first. Returns `null` when all pairs
are covered — this is the only termination signal the loop needs.

```typescript
function getNextPair(
  db: Database,
  parentId: number | null
): { aId: number; aTitle: string; bId: number; bTitle: string } | null {
  return db.query(`
    WITH siblings AS (
      SELECT id, title FROM todos
      WHERE parent_id IS ? AND status != 'done'
    ),
    scored AS (
      SELECT winner_id AS id FROM todo_comparisons
        WHERE winner_id IN (SELECT id FROM siblings)
      UNION
      SELECT loser_id FROM todo_comparisons
        WHERE loser_id IN (SELECT id FROM siblings)
    )
    SELECT
      s1.id    AS aId,   s1.title AS aTitle,
      s2.id    AS bId,   s2.title AS bTitle
    FROM siblings s1
    JOIN siblings s2 ON s2.id > s1.id
    LEFT JOIN todo_comparisons c
      ON (c.winner_id = s1.id AND c.loser_id = s2.id)
      OR (c.winner_id = s2.id AND c.loser_id = s1.id)
    WHERE c.winner_id IS NULL   -- not yet compared
    ORDER BY
      (s1.id NOT IN (SELECT id FROM scored)) DESC,  -- unscored items first
      (s2.id NOT IN (SELECT id FROM scored)) DESC,
      RANDOM()
    LIMIT 1
  `, [parentId]).get() as any ?? null;
}
```

### 2.4 Record a comparison

```typescript
function recordComparison(db: Database, winnerId: number, loserId: number) {
  // Remove reverse row if it exists (user changed their mind on rematch)
  db.run(
    `DELETE FROM todo_comparisons WHERE winner_id = ? AND loser_id = ?`,
    [loserId, winnerId]
  );
  // Upsert — replace on rematch, latest opinion wins
  db.run(`
    INSERT INTO todo_comparisons (winner_id, loser_id, compared_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(winner_id, loser_id) DO UPDATE SET compared_at = unixepoch()
  `, [winnerId, loserId]);
}
```

### 2.5 Reset comparisons

```typescript
function resetComparisons(db: Database, parentId: number | null) {
  const siblings = db.query(
    `SELECT id FROM todos WHERE parent_id IS ? AND status != 'done'`,
    [parentId]
  ).all().map((r: any) => r.id as number);

  if (siblings.length === 0) return;

  const placeholders = siblings.map(() => '?').join(',');
  db.run(`
    DELETE FROM todo_comparisons
    WHERE winner_id IN (${placeholders})
       OR loser_id  IN (${placeholders})
  `, [...siblings, ...siblings]);
}
```

### 2.6 Transitive reachability

Used for two purposes: auto-resolving pairs already ordered transitively, and detecting
contradictions before recording a user answer. Both use the same BFS over `todo_comparisons`.

```typescript
// Can we reach toId from fromId by following winner→loser edges?
function canReach(db: Database, fromId: number, toId: number): boolean {
  const visited = new Set<number>();
  const queue = [fromId];
  while (queue.length) {
    const node = queue.shift()!;
    if (node === toId) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    const next = db.query(
      `SELECT loser_id FROM todo_comparisons WHERE winner_id = ?`, [node]
    ).all().map((r: any) => r.loser_id as number);
    queue.push(...next);
  }
  return false;
}

// Is the order between a and b already known transitively?
function alreadyResolved(db: Database, aId: number, bId: number): boolean {
  return canReach(db, aId, bId) || canReach(db, bId, aId);
}
```

---

## 3. Interactive loop

The duel is entirely SQL-driven — no in-memory session state. `getNextPair` finds directly
uncompared pairs; the loop auto-resolves transitively ordered pairs silently and only prompts
the user when the order is genuinely unknown.

```typescript
async function startDuelSession(
  db: Database,
  parentId: number | null,
  sendReply: SendReplyFn,
  promptFn: PromptFn
) {
  const siblings = db.query(
    `SELECT id FROM todos WHERE parent_id IS ? AND status != 'done'`,
    [parentId]
  ).all();

  if (siblings.length < 2) {
    return sendReply(`Need at least 2 items to duel.`);
  }

  while (true) {
    const pair = getNextPair(db, parentId);

    if (!pair) {
      const ranked = getRankedSiblings(db, parentId);
      const answer = await promptFn(
        `✓ All items scored!\n\n` +
        ranked.map((t, i) => `${i + 1}. ${t.title} (${formatWinRate(t)})`).join('\n') +
        `\n\nContinue with a re-duel? (yes/no)`
      );
      if (answer.toLowerCase().startsWith('y')) {
        return startDuelSession(db, parentId, sendReply, promptFn);
      }
      return;
    }

    // Transitively resolved — record silently and move on, no user prompt needed
    if (alreadyResolved(db, pair.aId, pair.bId)) {
      const [winnerId, loserId] = canReach(db, pair.aId, pair.bId)
        ? [pair.aId, pair.bId]
        : [pair.bId, pair.aId];
      recordComparison(db, winnerId, loserId);
      continue;
    }

    const answer = (await promptFn(
      `Which is more important?\n` +
      `A) ${pair.aTitle}\n` +
      `B) ${pair.bTitle}\n` +
      `(S to skip, Q to quit)`
    )).toUpperCase();

    if (answer === 'Q') {
      await sendReply(`Duel stopped.`);
      return;
    }

    if (answer === 'S') {
      continue; // pair stays uncompared, may re-surface next duel
    }

    if (answer !== 'A' && answer !== 'B') {
      // Invalid input — pair still uncompared, getNextPair returns it again
      continue;
    }

    const [winnerId, loserId] = answer === 'A'
      ? [pair.aId, pair.bId]
      : [pair.bId, pair.aId];

    // Contradiction — loserId can already reach winnerId transitively
    if (canReach(db, loserId, winnerId)) {
      await sendReply(
        `⚠ Contradiction — "${pair.bTitle}" already ranks above "${pair.aTitle}" ` +
        `transitively. Skipping.`
      );
      continue;
    }

    recordComparison(db, winnerId, loserId);
  }
}
```

---

## 4. Command handlers

### 4.1 `!todo duel [parent_id] [--reset]`

```typescript
async function handleDuel(
  args: string[],
  db: Database,
  sendReply: SendReplyFn,
  promptFn: PromptFn
) {
  const reset     = args.includes('--reset');
  const cleanArgs = args.filter(a => a !== '--reset');
  const parentId  = getParentId(cleanArgs);

  if (reset) {
    resetComparisons(db, parentId);
    return startDuelSession(db, parentId, sendReply, promptFn);
  }

  // Check if all items already scored
  if (!getNextPair(db, parentId)) {
    const answer = await promptFn(
      `All items at this level are already scored.\n` +
      `Reset and re-duel? (yes/no)`
    );
    if (!answer.toLowerCase().startsWith('y')) return;
    resetComparisons(db, parentId);
    return startDuelSession(db, parentId, sendReply, promptFn);
  }

  // If parentId given, ask scope: score within siblings, or score its children?
  if (parentId !== null) {
    const answer = await promptFn(
      `Score item #${parentId} within its siblings, or score its children?\n` +
      `A) within siblings  B) score children`
    );
    if (answer.toUpperCase() === 'A') {
      const parent = db.query(
        `SELECT parent_id FROM todos WHERE id = ?`, [parentId]
      ).get() as any;
      return startDuelSession(db, parent?.parent_id ?? null, sendReply, promptFn);
    }
  }

  return startDuelSession(db, parentId, sendReply, promptFn);
}
```

### 4.2 `!todo next [parent_id]`

```typescript
async function handleNext(
  args: string[],
  db: Database,
  sendReply: SendReplyFn,
  promptFn: PromptFn
) {
  const parentId = getParentId(args);
  const ranked   = getRankedSiblings(db, parentId);
  const unscored = ranked.filter(t => t.win_rate === null);

  if (unscored.length > 0) {
    const answer = await promptFn(
      `⚠ ${unscored.length} item(s) have no comparisons yet.\n` +
      `Score them now for better results? (yes/no)\n` +
      `(If skipped, unscored items are treated as lowest priority.)`
    );
    if (answer.toLowerCase().startsWith('y')) {
      return startDuelSession(db, parentId, sendReply, promptFn);
    }
    // Unscored items already sorted last due to NULLS LAST
  }

  const next = ranked[0];
  if (!next) return sendReply(`No pending items.`);
  await sendReply(`Next: [#${next.id}] ${next.title} (${formatWinRate(next)})`);
}
```

### 4.3 Auto-duel on `!todo add`

```typescript
async function handleAdd(
  args: string[],
  db: Database,
  sendReply: SendReplyFn,
  promptFn: PromptFn,
  currentScope: number | null
) {
  const title    = args.join(' ');
  const parentId = currentScope;

  const result = db.run(
    `INSERT INTO todos (title, parent_id, status) VALUES (?, ?, 'pending')`,
    [title, parentId]
  );
  const newId = result.lastInsertRowid as number;

  await sendReply(`Added #${newId}: ${title}`);

  const siblings = db.query(
    `SELECT id FROM todos WHERE parent_id IS ? AND status != 'done' AND id != ?`,
    [parentId, newId]
  ).all();

  if (siblings.length === 0) return;

  const answer = await promptFn(
    `Place "${title}" among ${siblings.length} sibling(s)? (yes/no)`
  );
  if (answer.toLowerCase().startsWith('y')) {
    // New item has no comparisons — getNextPair surfaces it first naturally
    return startDuelSession(db, parentId, sendReply, promptFn);
  }
  // Skipped — item stays unscored, surfaces as lowest in !todo next
}
```

---

## 5. Helper utilities

```typescript
function formatWinRate(todo: any): string {
  if (todo.win_rate === null) return 'unscored';
  const pct    = Math.round(todo.win_rate * 100);
  const wins   = todo.wins   ?? 0;
  const losses = todo.losses ?? 0;
  return `${pct}%  ${wins}W/${losses}L`;
}
```

---

## 6. `promptFn` wiring in `src/index.ts`

`promptFn` sends a message and parks a resolve callback waiting for the next incoming DM.
The callback is fulfilled at the top of `handleUserMessage` before any normal routing.

### 6.1 Add to `PluginContext` type

```typescript
export type PromptFn = (message: string) => Promise<string>;

export type PluginContext = {
  runAgent: RunAgentFn | null;
  sendReply: SendReplyFn;
  promptFn: PromptFn;
  getAgentEnv: () => Record<string, string | undefined>;
  defaults: PluginDefaults;
};
```

### 6.2 Wire in `main()`

```typescript
let pendingPrompt: ((answer: string) => void) | null = null;

const pluginContext: PluginContext = {
  runAgent: null,
  sendReply: (message: string) => sendReplyForSource('nostr', message),
  promptFn: async (message: string): Promise<string> => {
    await sendReplyForSource('nostr', message);
    return new Promise((resolve) => {
      pendingPrompt = resolve;
    });
  },
  getAgentEnv,
  defaults: { ... },
};
```

### 6.3 Intercept in `handleUserMessage`

At the very top of `handleUserMessage`, before any other logic:

```typescript
async function handleUserMessage(content: string, source: MessageSource): Promise<void> {
  if (pendingPrompt) {
    // Always allow hard exit even during an interactive session
    if (content.trim().startsWith('!exit')) {
      await sendReplyForSource(source, 'Exiting...');
      return;
    }

    const resolve = pendingPrompt;
    pendingPrompt = null;
    resolve(content);
    return;
  }

  // ... rest of existing handler unchanged
}
```

> **How it works:** the duel loop calls `promptFn("Which is more important?\nA)...\nB)...")`,
> which sends the DM and suspends. The next incoming message resolves the promise and returns
> control to the loop. All other command routing is bypassed until the duel completes or the
> user sends `!exit`.

---

## 7. Implementation order

1. **DB migration** — create `todo_comparisons`, drop `priority` column
2. **Core utilities** — `getParentId`, `getRankedSiblings`, `getNextPair`, `recordComparison`, `resetComparisons`, `canReach`, `alreadyResolved`
3. **`promptFn` wiring** — add `PromptFn` type, `pendingPrompt` slot, intercept in `handleUserMessage`
4. **`!todo list`** — update to sort by win-rate, unscored items at bottom
5. **`!todo next`** — win-rate sort, unscored warning + offer to duel
6. **`startDuelSession`** — core loop with transitive auto-resolution
7. **`!todo duel`** — command handler, scope prompt, reset flow
8. **Auto-duel on `!todo add`**

---

## 8. Open details

- **Skip behaviour** — skipped pairs re-surface on the next `!todo duel` call since `getNextPair` only excludes already-compared pairs. If permanent-skip-within-session is needed, track skipped pairs in a local `Set<string>` (e.g. `"${aId}:${bId}"`) and filter them out in `getNextPair`.
- **`parent_id IS NULL`** — always use `IS ?` not `= ?` in SQLite when binding `null`. Bun's SQLite driver handles this correctly when you pass `null` as the parameter value.
- **Invalid answer re-prompt** — on an invalid answer, `getNextPair` will return the same pair again (it's still uncompared), so the loop naturally re-presents it without any special handling needed.
- **`canReach` scope** — the BFS in `canReach` traverses all of `todo_comparisons`, not just sibling rows. This is fine since comparisons are only ever recorded between siblings, so the graph is naturally scoped. No extra filtering needed.