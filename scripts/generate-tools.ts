// ---------------------------------------------------------------------------
// scripts/generate-tools.ts — Generate .claude/skills/dm-bot-*/SKILL.md,
//                             generated/cli-registry.ts,
//                             generated/plugins.ts
//
// Usage: bun run plugin:generate  (see package.json)
// Idempotent: all outputs are recreated each run.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { z } from 'zod';

const ROOT = join(import.meta.dir, '..');
const PLUGINS_JSON = join(ROOT, 'plugins.json');
const CLAUDE_SKILLS_DIR = join(ROOT, '.claude', 'skills');
const GENERATED_DIR = join(ROOT, 'generated');
const CLI_REGISTRY_TS = join(GENERATED_DIR, 'cli-registry.ts');
const PLUGINS_TS = join(GENERATED_DIR, 'plugins.ts');

// ---------------------------------------------------------------------------
// Read plugins.json
// ---------------------------------------------------------------------------

type PluginEntry = {
  alias: string;
  name: string;
  repo: string;
  version: string;
};

type PluginsJson = {
  plugins: PluginEntry[];
};

const pluginsJson = JSON.parse(
  readFileSync(PLUGINS_JSON, 'utf8'),
) as PluginsJson;

if (!existsSync(GENERATED_DIR)) {
  mkdirSync(GENERATED_DIR, { recursive: true });
}

if (!existsSync(CLAUDE_SKILLS_DIR)) {
  mkdirSync(CLAUDE_SKILLS_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Collected per-plugin data
// ---------------------------------------------------------------------------

type ToolCallBranch = z.ZodObject<z.ZodRawShape>;
type ToolCallSchema = z.ZodDiscriminatedUnion<ToolCallBranch[]>;

type PluginGenData = {
  alias: string;
  instructions: string;
  skillDescription: string;
  skillNotes: string;
  toolCallSchema: ToolCallSchema;
};

const pluginGenData: PluginGenData[] = [];

// ---------------------------------------------------------------------------
// Skill markdown generator
// ---------------------------------------------------------------------------

function buildExampleArgs(branch: ToolCallBranch): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, rawSchema] of Object.entries(branch.shape)) {
    if (key === 'type') {
      continue;
    }

    const raw = rawSchema as z.ZodType;

    const schema =
      raw instanceof z.ZodOptional
        ? (raw.def as unknown as { innerType: z.ZodType }).innerType
        : raw;

    if (schema instanceof z.ZodString) {
      result[key] =
        key === 'original_prompt' ? 'user request verbatim' : `<${key}>`;
    } else if (schema instanceof z.ZodNumber) {
      result[key] = 1;
    } else if (schema instanceof z.ZodBoolean) {
      result[key] = true;
    } else if (schema instanceof z.ZodEnum) {
      result[key] = schema.options[0];
    } else if (schema instanceof z.ZodNullable) {
      result[key] = null;
    } else if (schema instanceof z.ZodArray) {
      result[key] = [];
    } else if (schema instanceof z.ZodObject) {
      result[key] = '<see schema>';
    } else {
      result[key] = `<${key}>`;
    }
  }

  return result;
}

function buildBashExamples(alias: string, schema: ToolCallSchema): string {
  return schema.options
    .map((branch) => {
      const typeSchema = branch.shape.type;

      if (!(typeSchema instanceof z.ZodLiteral)) {
        throw new Error(
          `[generate-tools] ${alias}: ToolCallSchema branch is missing literal "type"`,
        );
      }

      const toolName = String(typeSchema.value);
      const exampleArgs = buildExampleArgs(branch);

      return `bun src/cli.ts ${alias} ${toolName} '${JSON.stringify(exampleArgs)}'`;
    })
    .join('\n');
}

function generateSkillMarkdown(params: {
  alias: string;
  instructions: string;
  skillDescription: string;
  skillNotes: string;
  bashExamples: string;
  jsonSchema: string;
}): string {
  const {
    alias,
    instructions,
    skillDescription,
    skillNotes,
    bashExamples,
    jsonSchema,
  } = params;

  return `\
---
name: dm-bot-${alias}
description: ${skillDescription}
allowed-tools: Bash
---

${instructions.trim()}
${skillNotes ? `\n${skillNotes.trim()}\n` : ''}
## CLI Interface

Call tools via bash with a single-quoted JSON argument:

\`\`\`bash
${bashExamples}
\`\`\`

To get the full JSON schema for a plugin:

\`\`\`bash
bun src/cli.ts ${alias}
\`\`\`

## Rules

- Always wrap the JSON argument in single quotes: \`'{"key":"value"}'\`
- Never use backslash-escaped quotes or double quotes around the JSON argument
- Always call \`${alias} list\` first before update/delete to resolve IDs
- Every mutating tool returns a Draft ID — show the full output to the user
- \`original_prompt\` is required on create/update/delete — pass the user request verbatim at the top level of the JSON (same level as \`type\`)
- Never retry a mutating tool if it returned a Draft ID

## Full JSON Schema

\`\`\`json
${jsonSchema}
\`\`\`
`;
}

// ---------------------------------------------------------------------------
// Process each plugin
// ---------------------------------------------------------------------------

for (const entry of pluginsJson.plugins) {
  const { alias } = entry;
  const aiPath = join(ROOT, 'plugins', alias, 'ai.ts');

  if (!existsSync(aiPath)) {
    console.warn(
      `[generate-tools] Skipping ${alias}: no ai.ts found at ${aiPath}`,
    );

    continue;
  }

  const mod = (await import(aiPath)) as {
    ToolCallSchema?: unknown;
    agentInstructions?: (alias: string) => string;
    skillDescription?: string;
    skillNotes?: string;
  };

  const instructions = mod.agentInstructions
    ? mod.agentInstructions(alias)
    : `## ${alias} tools\n\nUse bash and \`bun src/cli.ts ${alias} <toolName> '<json>'\`.`;

  if (!mod.ToolCallSchema) {
    console.warn(
      `[generate-tools] Skipping skill/CLI generation for ${alias}: ToolCallSchema is missing`,
    );

    continue;
  }

  if (!mod.skillDescription) {
    console.warn(
      `[generate-tools] Skipping skill/CLI generation for ${alias}: no skillDescription export in ai.ts`,
    );

    continue;
  }

  if (!(mod.ToolCallSchema instanceof z.ZodDiscriminatedUnion)) {
    console.warn(
      `[generate-tools] Skipping skill/CLI generation for ${alias}: ToolCallSchema is not a ZodDiscriminatedUnion`,
    );

    continue;
  }

  const toolCallSchema = mod.ToolCallSchema as ToolCallSchema;
  const bashExamples = buildBashExamples(alias, toolCallSchema);
  const jsonSchema = JSON.stringify(z.toJSONSchema(toolCallSchema), null, 2);

  const skillDir = join(CLAUDE_SKILLS_DIR, `dm-bot-${alias}`);
  mkdirSync(skillDir, { recursive: true });

  const skillMd = generateSkillMarkdown({
    alias,
    instructions,
    skillDescription: mod.skillDescription,
    skillNotes: mod.skillNotes ?? '',
    bashExamples,
    jsonSchema,
  });

  writeFileSync(join(skillDir, 'SKILL.md'), skillMd, 'utf8');

  console.log(
    `[generate-tools] Generated .claude/skills/dm-bot-${alias}/SKILL.md`,
  );

  pluginGenData.push({
    alias,
    instructions,
    skillDescription: mod.skillDescription,
    skillNotes: mod.skillNotes ?? '',
    toolCallSchema,
  });
}

// ---------------------------------------------------------------------------
// Generate generated/cli-registry.ts
// ---------------------------------------------------------------------------

function aliasToSchemaImport(alias: string): string {
  return (
    alias
      .split('-')
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('') + 'ToolCallSchema'
  );
}

function toolNamesFrom(schema: ToolCallSchema): string {
  return schema.options
    .map((b) => {
      const typeSchema = b.shape.type;

      if (!(typeSchema instanceof z.ZodLiteral)) {
        return "'unknown'";
      }

      return `'${String(typeSchema.value)}'`;
    })
    .join(', ');
}

const cliImports = pluginGenData
  .map(
    (e) =>
      `import { ToolCallSchema as ${aliasToSchemaImport(e.alias)} } from '../plugins/${e.alias}/ai';`,
  )
  .join('\n');

const cliEntries = pluginGenData
  .map(
    (e) =>
      `  { alias: '${e.alias}', toolNames: [${toolNamesFrom(e.toolCallSchema)}], toolCallSchema: ${aliasToSchemaImport(e.alias)} },`,
  )
  .join('\n');

const cliRegistryTs = `\
// generated/cli-registry.ts — AUTO-GENERATED, do not edit
// Generated by: bun run plugin:generate

import type { ZodType } from 'zod';
${cliImports}

type AnyToolCallSchema = ZodType;

export type CliPluginEntry = {
  alias: string;
  toolNames: string[];
  toolCallSchema: AnyToolCallSchema;
};

export const cliRegistry: CliPluginEntry[] = [
${cliEntries}
];
`;

writeFileSync(CLI_REGISTRY_TS, cliRegistryTs, 'utf8');
console.log('[generate-tools] Generated generated/cli-registry.ts');

// ---------------------------------------------------------------------------
// Generate generated/plugins.ts (unchanged behavior)
// ---------------------------------------------------------------------------

function toPluginExportName(alias: string): string {
  return (
    alias
      .split('-')
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join('') + 'Plugin'
  );
}

const pluginsImports = pluginsJson.plugins
  .map(
    (e) =>
      `import { ${toPluginExportName(e.alias)} } from '../plugins/${e.alias}/init';`,
  )
  .join('\n');

const pluginsRegistrations = pluginsJson.plugins
  .map(
    (e) => `  registerPlugin({ plugin: ${toPluginExportName(e.alias)}, ctx });`,
  )
  .join('\n');

const pluginsTs = `\
// generated/plugins.ts — AUTO-GENERATED, do not edit
// Generated by: bun run plugin:generate

import type { PluginContext } from '../src/core/plugin';
import { registerPlugin } from '../src/core/registry';
${pluginsImports}

export function registerPlugins(ctx: PluginContext): void {
${pluginsRegistrations}
}
`;

writeFileSync(PLUGINS_TS, pluginsTs, 'utf8');
console.log('[generate-tools] Generated generated/plugins.ts');
console.log('[generate-tools] Done.');
