// ---------------------------------------------------------------------------
// scripts/new-plugin.ts — Generate a new plugin from the template
//
// Usage: bun run plugin:new
//
// Prompts for alias (required), description (optional), core API version
// (optional). Creates plugins/<alias>/ with template files and placeholders
// replaced. Optionally runs eslint --fix only for plugins/<alias>.
// Does not modify plugins.json or run plugin:generate.
// ---------------------------------------------------------------------------

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import * as readline from 'readline';

const ROOT = join(import.meta.dir, '..');
const TEMPLATE_DIR = join(import.meta.dir, 'plugin-template');
const PLUGINS_DIR = join(ROOT, 'plugins');
const PKG_JSON = join(ROOT, 'package.json');

const ALIAS_REGEX = /^[a-z][a-z0-9_-]*$/;

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function aliasToPascal(alias: string): string {
  const normalized = alias.toLowerCase().replace(/[^a-z0-9]+/g, ' ');

  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function getDefaultCoreApiVersion(): string {
  const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf8')) as { version: string };
  const major = pkg.version.split('.')[0] ?? '0';

  return `^${major}.0.0`;
}

function expandTemplate(content: string, vars: Record<string, string>): string {
  return content.replace(
    /\{\{(\w+)\}\}/g,
    (_, key) => vars[key] ?? `{{${key}}}`,
  );
}

function templateOutputName(name: string): string {
  if (name.endsWith('.template')) {
    return name.slice(0, -'.template'.length);
  }

  return name;
}

type CopyTemplateRecursiveProps = {
  outDir: string;
  vars: Record<string, string>;
  relDir: string;
};

function copyTemplateRecursive({
  outDir,
  vars,
  relDir,
}: CopyTemplateRecursiveProps): void {
  const absDir = join(TEMPLATE_DIR, relDir);

  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const relPath = relDir ? join(relDir, entry.name) : entry.name;

    if (entry.isDirectory()) {
      const destDir = join(outDir, relPath);
      mkdirSync(destDir, { recursive: true });
      copyTemplateRecursive({ outDir, vars, relDir: relPath });

      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (entry.name.endsWith('.sqlite')) {
      continue;
    }

    const srcPath = join(TEMPLATE_DIR, relPath);
    const raw = readFileSync(srcPath, 'utf8');
    const expanded = expandTemplate(raw, vars);
    const destName = templateOutputName(entry.name);
    const destDir = join(outDir, relDir);
    const destPath = join(destDir, destName);

    mkdirSync(destDir, { recursive: true });
    writeFileSync(destPath, expanded, 'utf8');
  }
}

type RunLintForPluginProps = {
  alias: string;
};

function runLintForPlugin({ alias }: RunLintForPluginProps): void {
  const relPluginDir = `plugins/${alias}`;
  console.log(`\nRunning eslint --fix for ${relPluginDir} ...\n`);

  const result = Bun.spawnSync({
    cmd: ['bun', 'run', 'eslint', relPluginDir, '--fix'],
    cwd: ROOT,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  if (result.exitCode !== 0) {
    console.warn(
      `\nLint finished with issues (exit ${result.exitCode}). You can fix them manually in ${relPluginDir}.`,
    );

    return;
  }

  console.log(`\nLint complete for ${relPluginDir}.`);
}

async function main(): Promise<void> {
  console.log('Create a new plugin from the template.\n');

  const alias = await ask('Plugin alias (e.g. todo, reminder): ');

  if (!alias) {
    console.error('Alias is required.');
    process.exit(1);
  }

  if (!ALIAS_REGEX.test(alias)) {
    console.error(
      'Alias must be lowercase, start with a letter, and contain only letters, numbers, hyphens, and underscores.',
    );

    process.exit(1);
  }

  const pascalAlias = aliasToPascal(alias);
  const defaultDescription = `${pascalAlias} plugin for dm-bot`;

  const descriptionAnswer = await ask(
    `Short description [${defaultDescription}]: `,
  );

  const description = descriptionAnswer || defaultDescription;

  const defaultCore = getDefaultCoreApiVersion();

  const coreAnswer = await ask(
    `Core API version (e.g. ^6.0.0) [${defaultCore}]: `,
  );

  const coreApiVersion = coreAnswer || defaultCore;

  const packageName = `dm-bot-${alias}-plugin`;
  const outDir = join(PLUGINS_DIR, alias);

  if (existsSync(outDir)) {
    console.error(
      `Directory already exists: plugins/${alias}. Choose a different alias or remove it.`,
    );

    process.exit(1);
  }

  const vars: Record<string, string> = {
    ALIAS: alias,
    PASCAL_ALIAS: pascalAlias,
    PACKAGE_NAME: packageName,
    DESCRIPTION: description,
    CORE_API_VERSION: coreApiVersion,
  };

  mkdirSync(outDir, { recursive: true });
  copyTemplateRecursive({ outDir, vars, relDir: '' });

  console.log(`\nPlugin created at plugins/${alias}/`);

  const lintAnswer = await ask(
    `Run eslint --fix only for plugins/${alias} now? [Y/n]: `,
  );

  const shouldRunLint = lintAnswer === '' || /^y(es)?$/i.test(lintAnswer);

  if (shouldRunLint) {
    runLintForPlugin({ alias });
  } else {
    console.log(
      `Skipped lint. To run later: bun run eslint plugins/${alias} --fix`,
    );
  }

  console.log(
    'Add it to plugins.json and run `bun run plugin:generate` when you want to refresh plugin registration and CLI/skill outputs.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
