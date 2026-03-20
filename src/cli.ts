#!/usr/bin/env bun
// src/cli.ts — local CLI runner for plugin tool calls

import { z } from 'zod';

import { cliRegistry } from '../generated/cli-registry';

type CliArgs = {
  alias: string | null;
  toolName: string | null;
  rawArgsJson: string | null;
};

function parseArgs(argv: string[]): CliArgs {
  const alias = argv[0] ?? null;
  const toolName = argv[1] ?? null;
  const rawArgsJson = argv[2] ?? null;

  return { alias, toolName, rawArgsJson };
}

function printHelp(): void {
  console.log('Usage: bun src/cli.ts <alias> <toolName> <rawArgsJson>');
  console.log('');
  console.log('Aliases:');

  for (const entry of cliRegistry) {
    console.log(`- ${entry.alias}: ${entry.toolNames.join(', ')}`);
  }

  console.log('');
  console.log('Examples:');
  console.log(`- bun src/cli.ts todo list '{}'`);

  console.log(
    `- bun src/cli.ts todo create '{"input":{"todo":"Test","parent_id":null,"priority":null,"description":null,"tags":null},"original_prompt":"add a todo"}'`,
  );

  console.log('');

  console.log(
    'Note: rawArgsJson should omit `type`. The CLI injects `type` from <toolName>.',
  );
}

function printPluginSchema(alias: string): void {
  const entry = cliRegistry.find((e) => e.alias === alias);

  if (!entry) {
    console.error(`Unknown alias: ${alias}`);
    process.exit(1);
  }

  console.log(
    JSON.stringify(z.toJSONSchema(entry.toolCallSchema as z.ZodType), null, 2),
  );
}

function safeJsonParse(
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    const rawPreview = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;

    return {
      ok: false,
      error:
        (err instanceof Error ? err.message : String(err)) +
        ` (raw: ${rawPreview})`,
    };
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { alias, toolName, rawArgsJson } = parseArgs(argv);

  if (!alias) {
    printHelp();

    return;
  }

  const entry = cliRegistry.find((e) => e.alias === alias);

  if (!entry) {
    console.error(`Unknown alias: ${alias}`);
    process.exit(1);
  }

  if (!toolName) {
    printPluginSchema(alias);

    return;
  }

  const rawArgs = rawArgsJson
    ? safeJsonParse(rawArgsJson)
    : { ok: true as const, value: {} as unknown };

  if (!rawArgs.ok) {
    console.error(`Failed to parse JSON args: ${rawArgs.error}`);
    process.exit(1);
  }

  const valueObj =
    typeof rawArgs.value === 'object' && rawArgs.value !== null
      ? (rawArgs.value as Record<string, unknown>)
      : {};

  // The CLI always injects `type` from <toolName>. If the user includes
  // a `type` field in raw JSON, it is ignored.
  const { type: _ignoredUserType, ...rest } = valueObj;
  const candidate = { ...rest, type: toolName };

  const parsed = entry.toolCallSchema.safeParse(candidate);

  if (!parsed.success) {
    console.error('Validation error:');

    for (const issue of parsed.error.issues) {
      const path = issue.path.length ? issue.path.join('.') : '(root)';
      console.error(`- ${path}: ${issue.message}`);
    }

    process.exit(1);
  }

  const module = await import(`../plugins/${alias}/ai`);

  const { openDb, executeTool } = module as {
    openDb: () => import('bun:sqlite').Database;
    executeTool: (props: {
      alias: string;
      call: unknown;
      db: import('bun:sqlite').Database;
    }) => Promise<string>;
  };

  const db = openDb();
  const result = await executeTool({ alias, call: parsed.data, db });
  console.log(result);
}

void main();
