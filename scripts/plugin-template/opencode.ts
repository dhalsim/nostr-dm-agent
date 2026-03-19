// ---------------------------------------------------------------------------
// plugins/{{ALIAS}}/opencode.ts — OpenCode tool definitions for the {{ALIAS}} plugin
//
// createToolDefinitions(alias) is called by the generator; it must return
// the tool array for this plugin. agentInstructions(alias) is injected into
// AGENTS.md. Use tool.schema.* for args (Zod v3); use your Zod v4 schemas
// only inside execute for validation.
//
// Add tools your agent needs, e.g. list, create, update, delete. For
// draft/confirm: in execute, call storeDraft() and return a preview with
// Draft ID and formatDraftReply(); the user then runs !{{ALIAS}} accept/revise/decline.
// ---------------------------------------------------------------------------

import { join } from 'path';

import { tool } from '@opencode-ai/plugin';
import { Database } from 'bun:sqlite';

import { dmBotRoot } from '../../src/paths';

import { create{{PASCAL_ALIAS}}Table, get{{PASCAL_ALIAS}}, list{{PASCAL_ALIAS}}s } from './db';
import { create{{PASCAL_ALIAS}}DraftsTable, storeDraft } from './drafts';
import {
  formatCreateDraftTree,
  formatDraftReply,
  format{{PASCAL_ALIAS}}Tree,
  hasDraftChildren,
} from './format';
import { Create{{PASCAL_ALIAS}}DraftSchema, Update{{PASCAL_ALIAS}}InputSchema } from './types';

export function agentInstructions(alias: string): string {
  return `## {{PASCAL_ALIAS}} (${alias} tools)\n\nWhen the user asks to manage {{ALIAS}}s, use the ${alias}__* tools. List first to resolve IDs; use draft/confirm for mutations.`;
}

export function createToolDefinitions(alias: string) {
  const dbPath = join(dmBotRoot, 'plugins', alias, 'db.sqlite');
  const cmd = `!${alias}`;

  function openDb(): Database {
    const db = new Database(dbPath);
    db.run('PRAGMA foreign_keys = ON');
    create{{PASCAL_ALIAS}}Table(db);
    create{{PASCAL_ALIAS}}DraftsTable(db);

    return db;
  }

  const listArgs = {
    filter: tool.schema.string().optional().describe('Optional filter'),
  };

  const createArgs = {
    data: tool.schema.string().min(1).describe('Content for the new {{ALIAS}} item'),
    original_prompt: tool.schema.string().describe('Original user request'),
  };

  const updateArgs = {
    id: tool.schema.number(),
    data: tool.schema.string().min(1).optional(),
    original_prompt: tool.schema.string(),
  };

  const deleteArgs = {
    id: tool.schema.number().int().positive(),
    original_prompt: tool.schema.string(),
  };

  return [
    {
      name: 'list',
      description: 'List current {{ALIAS}}s with IDs. Call before update/delete.',
      args: listArgs,
      execute: async (): Promise<string> => {
        const db = openDb();
        const items = list{{PASCAL_ALIAS}}s(db);
        return items.length === 0 ? 'No {{ALIAS}}s.' : format{{PASCAL_ALIAS}}Tree(items);
      },
    },
    {
      name: 'create',
      description: 'Propose a new {{ALIAS}} (returns draft for user to accept/revise/decline).',
      args: createArgs,
      execute: async (args: { data: string; original_prompt: string }): Promise<string> => {
        const db = openDb();
        const parsed = Create{{PASCAL_ALIAS}}DraftSchema.safeParse({ data: args.data });

        if (!parsed.success) {
          return `Validation error: ${parsed.error.message}`;
        }

        const draftId = storeDraft(db, {
          kind: 'create',
          input: parsed.data,
          originalPrompt: args.original_prompt,
        });

        const title = hasDraftChildren(parsed.data)
          ? 'Create the following:'
          : 'Create:';

        return [
          title,
          '',
          formatCreateDraftTree(parsed.data),
          '',
          `Draft ID: ${draftId}`,
          formatDraftReply(cmd, draftId, 'create'),
        ].join('\n');
      },
    },
    {
      name: 'update',
      description: 'Propose an update (returns draft).',
      args: updateArgs,
      execute: async (args: { id: number; data?: string; original_prompt: string }): Promise<string> => {
        const db = openDb();

        const parsed = Update{{PASCAL_ALIAS}}InputSchema.safeParse({
          id: args.id,
          data: args.data,
        });

        if (!parsed.success) {
          return `Validation error: ${parsed.error.message}`;
        }

        const existing = get{{PASCAL_ALIAS}}(db, args.id);

        if (!existing) {
          return `{{PASCAL_ALIAS}} not found: ${args.id}. Call list first.`;
        }

        const draftId = storeDraft(db, {
          kind: 'update',
          input: parsed.data,
          originalPrompt: args.original_prompt,
        });

        return [
          `Update #${args.id}: "${existing.data}"`,
          '',
          `Draft ID: ${draftId}`,
          formatDraftReply(cmd, draftId, 'update'),
        ].join('\n');
      },
    },
    {
      name: 'delete',
      description: 'Propose deleting a {{ALIAS}} (returns draft).',
      args: deleteArgs,
      execute: async (args: { id: number; original_prompt: string }): Promise<string> => {
        const db = openDb();
        const item = get{{PASCAL_ALIAS}}(db, args.id);

        if (!item) {
          return `{{PASCAL_ALIAS}} not found: ${args.id}. Call list first.`;
        }

        const draftId = storeDraft(db, {
          kind: 'delete',
          input: { id: args.id },
          originalPrompt: args.original_prompt,
        });

        return [
          `Delete #${args.id}: "${item.data}"`, 
          '', 
          `Draft ID: ${draftId}`, 
          formatDraftReply(cmd, draftId, 'delete'),
        ].join('\n');
      },
    },
  ] as const;
}

export type ToolDefinitions = ReturnType<typeof createToolDefinitions>;
export type ToolDefinition = ToolDefinitions[number];
