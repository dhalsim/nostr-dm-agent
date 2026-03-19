// ---------------------------------------------------------------------------
// plugins/{{ALIAS}}/commands.ts — !{{ALIAS}} sub-command handler
//
// Implement each subcommand (add, list, show, delete, drafts, accept, revise,
// decline, ai) for your plugin. The stub below supports minimal add/list/show/
// delete and a single-item draft accept flow so the plugin runs; extend or
// replace for your use case (e.g. hierarchical items, status, priority).
// ---------------------------------------------------------------------------

import type { Database } from 'bun:sqlite';

import type { AgentRunResult } from '@src/backends/types';
import type { PluginIdentity } from '@src/core/plugin';

import { handle{{PASCAL_ALIAS}}Ai } from './ai';
import {
  create{{PASCAL_ALIAS}},
  delete{{PASCAL_ALIAS}},
  get{{PASCAL_ALIAS}},
  list{{PASCAL_ALIAS}}s,
  update{{PASCAL_ALIAS}},
} from './db';
import { deleteDraft, getDraft, listDrafts, storeDraft } from './drafts';
import { formatCreateDraftTree, formatDraftReply } from './format';
import { format{{PASCAL_ALIAS}}Detail, format{{PASCAL_ALIAS}}Tree } from './format';
import type { Create{{PASCAL_ALIAS}}Draft, Update{{PASCAL_ALIAS}}Input } from './types';
import { Create{{PASCAL_ALIAS}}InputSchema } from './types';

export type Handle{{PASCAL_ALIAS}}Props = {
  args: string[];
  db: Database;
  identity: PluginIdentity;
  runAgent: ((prompt: string) => Promise<AgentRunResult>) | null;
  helpText: (alias: string) => string[];
};

export async function handle{{PASCAL_ALIAS}}({
  args,
  db,
  identity,
  runAgent,
  helpText,
}: Handle{{PASCAL_ALIAS}}Props): Promise<string> {
  const sub = args[0]?.toLowerCase();
  const rest = args.slice(1);
  const alias = identity.alias;

  if (!sub || sub === 'help') {
    return helpText(alias).concat([`!${alias} help — this message`]).join('\n');
  }

  if (sub === 'ai') {
    if (!runAgent) {
      return `!${alias} ai requires an agent backend. Set backend and try again.`;
    }
    return handle{{PASCAL_ALIAS}}Ai({ args: rest, db, identity, runAgent });
  }

  if (sub === 'add') {
    const text = rest.join(' ').trim();
    if (!text) return `Usage: !${alias} add <text>`;
    const parsed = Create{{PASCAL_ALIAS}}InputSchema.safeParse({ data: text });
    if (!parsed.success) return `Invalid input: ${parsed.error.message}`;
    const item = create{{PASCAL_ALIAS}}(db, parsed.data);
    return `Created #${item.id}\n${format{{PASCAL_ALIAS}}Detail(item)}`;
  }

  if (sub === 'list') {
    const items = list{{PASCAL_ALIAS}}s(db);
    return items.length === 0 ? 'No {{ALIAS}}s.' : format{{PASCAL_ALIAS}}Tree(items);
  }

  if (sub === 'show') {
    const idRaw = rest[0]?.trim();
    if (!idRaw) return `Usage: !${alias} show <id>`;
    const id = parseInt(idRaw, 10);
    if (Number.isNaN(id)) return `Usage: !${alias} show <id> (number required)`;
    const item = get{{PASCAL_ALIAS}}(db, id);
    if (!item) return `Not found: #${id}`;
    return format{{PASCAL_ALIAS}}Detail(item);
  }

  if (sub === 'delete') {
    const idRaw = rest[0]?.trim();
    if (!idRaw) return `Usage: !${alias} delete <id>`;
    const id = parseInt(idRaw, 10);
    if (Number.isNaN(id)) return `Usage: !${alias} delete <id> (number required)`;
    if (!delete{{PASCAL_ALIAS}}(db, id)) return `Not found: #${id}`;
    return `Deleted #${id}.`;
  }

  if (sub === 'drafts') {
    const idRaw = rest[0]?.trim();
    const drafts = listDrafts(db);
    if (idRaw) {
      const id = parseInt(idRaw, 10);
      if (Number.isNaN(id)) return `Usage: !${alias} drafts [draft_id]`;
      const entry = getDraft(db, id);
      if (!entry) return `Draft not found: #${id}`;
      const cmd = `!${alias}`;
      if (entry.kind === 'create') {
        return [`Draft #${id} [create]:`, '', formatCreateDraftTree(entry.input as Create{{PASCAL_ALIAS}}Draft), '', formatDraftReply(cmd, id, 'create')].join('\n');
      }
      if (entry.kind === 'update') {
        return [`Draft #${id} [update]:`, `  target id: ${(entry.input as Update{{PASCAL_ALIAS}}Input).id}`, '', formatDraftReply(cmd, id, 'update')].join('\n');
      }
      return [`Draft #${id} [delete]:`, `  target id: ${(entry.input as { id: number }).id}`, '', formatDraftReply(cmd, id, 'delete')].join('\n');
    }
    if (drafts.length === 0) return 'No pending drafts.';
    const cmd = `!${alias}`;
    const lines = drafts.map((d) => `#${d.id} [${d.kind}]`);
    return ['Pending drafts:', '', ...lines, '', `Accept all: ${cmd} accept all`].join('\n');
  }

  const draftIdRaw = rest[0]?.trim();
  const draftId = draftIdRaw ? parseInt(draftIdRaw, 10) : NaN;
  const draftIdInvalid = !draftIdRaw || Number.isNaN(draftId);

  if (sub === 'accept') {
    if (rest[0]?.toLowerCase() === 'all') {
      const drafts = listDrafts(db);
      if (drafts.length === 0) return 'No pending drafts.';
      const results: string[] = [];
      for (const draft of drafts) {
        deleteDraft(db, draft.id);
        if (draft.kind === 'create') {
          const created = create{{PASCAL_ALIAS}}(db, draft.input as Create{{PASCAL_ALIAS}}Draft);
          results.push(`#${created.id} created`);
        } else if (draft.kind === 'update') {
          const updated = update{{PASCAL_ALIAS}}(db, draft.input as Update{{PASCAL_ALIAS}}Input);
          results.push(updated ? `#${updated.id} updated` : `#${draft.input.id} not found`);
        } else if (draft.kind === 'delete') {
          const ok = delete{{PASCAL_ALIAS}}(db, draft.input.id);
          results.push(ok ? `#${draft.input.id} deleted` : `#${draft.input.id} not found`);
        }
      }
      return `Accepted ${results.length} draft(s):\n  ${results.join('\n  ')}`;
    }
    if (draftIdInvalid) return `Usage: !${alias} accept <draft_id> | !${alias} accept all`;
    const entry = getDraft(db, draftId);
    if (!entry) return `Draft not found: #${draftId}`;
    deleteDraft(db, draftId);
    if (entry.kind === 'create') {
      const created = create{{PASCAL_ALIAS}}(db, entry.input as Create{{PASCAL_ALIAS}}Draft);
      return `Created #${created.id}\n${format{{PASCAL_ALIAS}}Detail(created)}`;
    }
    if (entry.kind === 'update') {
      const updated = update{{PASCAL_ALIAS}}(db, entry.input as Update{{PASCAL_ALIAS}}Input);
      if (!updated) return `Not found: #${entry.input.id}`;
      return `Updated.\n${format{{PASCAL_ALIAS}}Detail(updated)}`;
    }
    if (entry.kind === 'delete') {
      const ok = delete{{PASCAL_ALIAS}}(db, entry.input.id);
      if (!ok) return `Not found: #${entry.input.id}`;
      return `Deleted #${entry.input.id}.`;
    }
  }

  if (sub === 'revise') {
    if (draftIdInvalid) return `Usage: !${alias} revise <draft_id> <corrections>`;
    const entry = getDraft(db, draftId);
    if (!entry) return `Draft not found: #${draftId}`;
    if (entry.kind !== 'create') return `Revise only applies to create drafts. Use !${alias} decline ${draftId} and try again.`;
    // Stub: no re-run of agent; prompt user to use ai again or accept/decline.
    return `To revise draft #${draftId}, use !${alias} decline ${draftId} then !${alias} ai <revised request>. Or implement revise in commands.ts (call runAgent and replace draft).`;
  }

  if (sub === 'decline') {
    if (draftIdInvalid) return `Usage: !${alias} decline <draft_id>`;
    if (!getDraft(db, draftId)) return `Draft not found: #${draftId}`;
    deleteDraft(db, draftId);
    return `Draft #${draftId} discarded.`;
  }

  return `Unknown subcommand: ${sub}. Use !${alias} help.`;
}
