# Plugin & bot review checklist

Review points from the plugins/jobs and core bot refactor, with status and follow-ups.

---

## Scope and assumptions

- **Plugin jobs only.** Only the plugin jobs (e.g. `plugins/jobs`) are in scope; core jobs will be removed.
- **No legacy rows.** There are no existing job rows, so no old rows with `session_id` NULL.
- **CronJobSchema and session_id.** `CronJobSchema` has `session_id: z.string().nullable()`; NULL until first run, then set by runner.

---

## 1. runAgent set before plugin dispatch

**Issue:** `!jobs ai` could run with `runAgent === null` if `pluginContext.runAgent` was only set in the non-command path.

**Status:** Fixed. In `src/index.ts`, `pluginContext.runAgent` is now set at the start of `handleUserMessage` (after backend/session are created), before the `if (input.startsWith('!'))` branch. So when `handleBangCommand` → `dispatchPluginCommand` runs, `runAgent` is already set and `!jobs ai` works.

**Double-check:** Confirm that every code path that can lead to `dispatchPluginCommand` runs after `pluginContext.runAgent = async (...) => ...` has been executed (e.g. no early returns before that assignment).

---

## 2. session_id for cron jobs

**Issue:** `session_id` had to be nullable for new cron jobs; using `String(row.session_id)` turned DB null into the string `"null"`.

**Status:** Done. Cron INSERT uses `session_id = NULL`. `CronJobSchema` has `session_id: z.string().nullable()`. Runner creates a session when `job.session_id == null`, runs, then calls `updateJobSessionId()`; subsequent runs reuse `job.session_id`. One-time jobs always get a new session.

---

## 3. Runner env, cwd, modelOverride & AI defaults

**Issue:** Runner used empty `env`, ignored `workspace_target` for cwd, and `job.model` might need routstr handling. AI job-creation defaults were hardcoded.

**Status:** Done. Core passes `defaults: { backend, provider, model, mode, workspace_target }` in `PluginContext`. The job runner uses `ctx.getAgentEnv()` (fresh agent env each run) and cwd from `job.workspace_target`. `plugins/jobs/ai.ts` uses a prompt-only schema (no backend/provider/model/mode/workspace_target); after parsing model output, defaults are injected from `ctx.defaults` and the result is validated as `JobDraftInput`. Same for revise flow.

---

## 4. Todo plugin and core API

**Issue:** Todo plugin expects `handler(args, ctx)` and `ctx.pluginDb`, but the core only calls `handler(args)` and doesn’t pass a context.

**Status:** Planned. You plan to bump core major version and todo plugin version and tag the new core. Todo should be updated to match the jobs pattern: open DB in `onInit`, store in a module-level ref, and use `handler(args: string[])` only.

---

## 5. Plugin owns its DB

**Issue:** Registry and plugin both opened the same DB file.

**Status:** Fixed. The plugin now handles its DB itself (e.g. opens it in `onInit` and stores it); registry no longer needs to create/pass it for the jobs plugin.

---

## 6. sendReply → sendReplyToTarget; target only local | nostr

**Issue:** Naming and semantics of plugin reply: `sendReply` used with a synthetic `'plugin'` source.

**Status:** To do. Renaming to something like `sendReplyToTarget` and restricting target to `'local' | 'nostr'` makes sense. “plugin” is not a real delivery target; the reply should go to the same place the current message came from.

**Suggested approach:** Keep the plugin API as a single function, e.g. `sendReply(message)`. When the core builds `pluginContext` before dispatching, bind the current message **source** (e.g. from `handleUserMessage(content, source)`):  
`sendReply: (message) => sendReplyForSource(source, message)`  
with `source` being `'nostr'` or `'local'`. Then remove `'plugin'` from `MessageSource` and optionally rename the context property to `sendReplyToTarget` if you want the name to reflect that it’s targeting the current channel. The plugin still just calls `sendReply(msg)`; the core decides the target.

---

## 7. ESLint in plugins

**Issue:** ESLint doesn’t seem to run properly inside the plugins folder.

**Status:** OK. `eslint.config.js` includes `plugins/**/*.{ts,tsx}` in `files`; `bun run lint` runs from repo root and applies to `plugins/`. No separate config needed.

---

## 8. JobsPluginDb null guard in ticker

**Issue:** The ticker checked `if (!pluginDb)` even though `pluginDb` was the function argument, so it looked redundant.

**Status:** Clarified. `JobsPluginDb` (and thus the DB the ticker uses) can be null if `onInit` fails or never runs, so a null check in the ticker is valid. TypeScript may not narrow mutable module-level variables, so the guard is a reasonable runtime safeguard.

---

## 9. Cron INSERT and session_id (clarification)

**Original point:** New cron jobs don’t have a session yet, so the INSERT can omit `session_id` (or set it to NULL). The runner should create a session on first run and persist it.

**Status:** Done. Cron INSERT uses NULL for `session_id`. Runner: if `job.session_id == null`, creates session, runs, then `updateJobSessionId(pluginDb, job.id, sessionId)`; otherwise reuses `job.session_id`.

---

## 10. Ticker and context timing

**Issue:** Whether the ticker could run before context (e.g. `JobsPluginContext`) was set.

**Status:** OK. By the time the ticker is started (in `onInit`), the plugin has already run `onInit(ctx)`, so `JobsPluginContext` is set. The ticker uses that context (and the runner builds backend from the job row, not from `runAgent`). So no ordering issue.

---

## Summary table

| # | Topic                     | Status      | Action |
|---|---------------------------|------------|--------|
| 1 | runAgent before dispatch  | Done       | — |
| 2 | session_id cron           | Done       | — |
| 3 | Env, cwd, AI defaults     | Done       | — |
| 4 | Todo plugin               | Planned    | Bump versions, align with new API |
| 5 | Plugin owns DB            | Done       | — |
| 6 | sendReply / target        | To do      | Bind to current source; drop `'plugin'` |
| 7 | ESLint in plugins         | OK         | `plugins/**` in eslint.config.js; lint runs |
| 8 | JobsPluginDb null        | Clarified  | Guard is valid |
| 9 | Cron INSERT session_id   | Done       | — |
|10 | Ticker timing             | OK         | — |
