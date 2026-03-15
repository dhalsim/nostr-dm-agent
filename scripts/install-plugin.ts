// ---------------------------------------------------------------------------
// scripts/install-plugin.ts — Discover and install a bot plugin
//
// Usage: bun run scripts/install-plugin.ts
//
// Flow:
//   1. Query PLUGIN_KIND events from well-known relays
//   2. List available plugins
//   3. User picks one
//   4. Validate version compatibility with bot core
//   5. Ask for alias
//   6. Check alias collision
//   7. Clone the right ref into plugins/{alias}
//   8. Update plugins.json
//   9. Run generate-tools script
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as readline from 'readline';

import { SimplePool } from 'nostr-tools';
import { z } from 'zod';

const PLUGIN_KIND = 32107;
const ROOT = join(import.meta.dir, '..');
const PLUGINS_JSON = join(ROOT, 'plugins.json');
const PKG_JSON = join(ROOT, 'package.json');

const PLUGIN_QUERY_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://nostr.mom',
];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const PluginEntrySchema = z.object({
  alias: z.string().min(1),
  repo: z.string().min(1),
  version: z.string().min(1),
});

const PluginsJsonSchema = z.object({
  plugins: z.array(PluginEntrySchema),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PluginsJson = z.infer<typeof PluginsJsonSchema>;

type RefEntry = {
  tag: string;
  coreMajor: string;
  changelog: string;
};

type PluginEvent = {
  id: string;
  pubkey: string;
  name: string;
  description: string;
  version: string;
  coreApiVersion: string;
  repo: string;
  refs: RefEntry[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function botCoreMajor(): string {
  const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf8')) as { version: string };

  return pkg.version.split('.')[0] ?? '0';
}

function readPluginsJson(): PluginsJson {
  if (!existsSync(PLUGINS_JSON)) {
    return { plugins: [] };
  }

  const raw = JSON.parse(readFileSync(PLUGINS_JSON, 'utf8'));
  const parsed = PluginsJsonSchema.safeParse(raw);

  if (!parsed.success) {
    console.error(`Invalid plugins.json:\n${parsed.error.toString()}`);
    process.exit(1);
  }

  return parsed.data;
}

function writePluginsJson(data: PluginsJson): void {
  writeFileSync(PLUGINS_JSON, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function tagValue(tags: string[][], name: string): string {
  return tags.find((t) => t[0] === name)?.[1] ?? '';
}

function parsePluginEvent(event: {
  id: string;
  pubkey: string;
  tags: string[][];
}): PluginEvent | null {
  const name = tagValue(event.tags, 'd');
  const repo = tagValue(event.tags, 'repo');

  if (!name || !repo) {
    return null;
  }

  const refs: RefEntry[] = event.tags
    .filter((t) => t[0] === 'ref' && t[1] && t[2] && t[3])
    .map((t) => ({ tag: t[1], coreMajor: t[2], changelog: t[3] }));

  return {
    id: event.id,
    pubkey: event.pubkey,
    name,
    description: tagValue(event.tags, 'description'),
    version: tagValue(event.tags, 'version'),
    coreApiVersion: tagValue(event.tags, 'coreApiVersion'),
    repo,
    refs,
  };
}

/** Find the latest compatible ref for the given core major. */
function findCompatibleRef(refs: RefEntry[], coreMajor: string): RefEntry | null {
  const compatible = refs.filter((r) => r.coreMajor === coreMajor);

  return compatible.at(-1) ?? null;
}

/** Find the latest ref across all core majors. */
function latestRef(refs: RefEntry[]): RefEntry | null {
  return refs.at(-1) ?? null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n── Bot Plugin Installer ──\n');

  const coreMajor = botCoreMajor();
  console.log(`Bot core major: ${coreMajor}`);

  // Step 1: query available plugins
  console.log('\nQuerying plugins from relays...');
  const pool = new SimplePool();

  const events = await new Promise<PluginEvent[]>((resolve) => {
    const found: PluginEvent[] = [];
    const seen = new Set<string>();

    const sub = pool.subscribe(
      PLUGIN_QUERY_RELAYS,
      { kinds: [PLUGIN_KIND], limit: 50 },
      {
        onevent: (event) => {
          // Deduplicate by d tag + pubkey — keep first seen (relays return newest first)
          const key = `${event.pubkey}:${tagValue(event.tags, 'd')}`;

          if (seen.has(key)) {
            return;
          }

          seen.add(key);

          const plugin = parsePluginEvent(event);

          if (plugin) {
            found.push(plugin);
          }
        },
        oneose: () => {
          sub.close();
          resolve(found);
        },
      },
    );

    // Timeout after 10s in case oneose never fires
    setTimeout(() => {
      sub.close();
      resolve(found);
    }, 10_000);
  });

  pool.destroy();

  if (events.length === 0) {
    console.log('No plugins found on the queried relays.');
    process.exit(0);
  }

  // Step 2: list available plugins
  console.log(`\nFound ${events.length} plugin(s):\n`);

  events.forEach((p, i) => {
    const compatible = findCompatibleRef(p.refs, coreMajor);

    const status = compatible
      ? `✓ compatible (${compatible.tag})`
      : `✗ incompatible (needs core ${latestRef(p.refs)?.coreMajor ?? '?'})`;

    console.log(`  ${i + 1}. ${p.name}`);

    if (p.description) {
      console.log(`     ${p.description}`);
    }

    console.log(`     version: ${p.version} | ${status}`);
    console.log(`     repo: ${p.repo}`);
    console.log();
  });

  // Step 3: user picks one
  const choice = await ask(`Choose a plugin to install (1-${events.length}) or q to quit: `);

  if (choice.toLowerCase() === 'q') {
    process.exit(0);
  }

  const idx = parseInt(choice, 10) - 1;

  if (idx < 0 || idx >= events.length) {
    console.error('Invalid choice.');
    process.exit(1);
  }

  const plugin = events[idx];
  console.log(`\nSelected: ${plugin.name}`);

  // Step 4: version validation
  const compatible = findCompatibleRef(plugin.refs, coreMajor);
  let selectedRef: RefEntry;

  if (compatible) {
    console.log(`✓ Compatible ref: ${compatible.tag} (core ${compatible.coreMajor})`);
    console.log(`  ${compatible.changelog}`);
    selectedRef = compatible;
  } else {
    const latest = latestRef(plugin.refs);

    if (!latest) {
      console.error('No refs found in plugin event. Cannot install.');
      process.exit(1);
    }

    console.log(`\n⚠ No compatible ref for your bot core (${coreMajor}).`);
    console.log(`  Latest available: ${latest.tag} requires core ${latest.coreMajor}`);
    console.log(`  → Upgrade your bot to core ${latest.coreMajor} to use the latest version.`);

    // Check for an older ref that might work with a lower core major
    const older = [...plugin.refs]
      .reverse()
      .find((r) => parseInt(r.coreMajor) < parseInt(coreMajor));

    if (older) {
      console.log(`\n  Older ref available: ${older.tag} (core ${older.coreMajor})`);
      console.log(`  ${older.changelog}`);
      const useOlder = await ask('  Install this older version? (y/N): ');

      if (useOlder.toLowerCase() !== 'y') {
        process.exit(0);
      }

      selectedRef = older;
    } else {
      console.error('  No compatible version found. Exiting.');
      process.exit(1);
    }
  }

  // Step 5: ask for alias
  console.log('\nThe alias is used for:');
  console.log('  • Plugin folder:   plugins/<alias>/');
  console.log('  • Bot commands:    !<alias> list, !<alias> add, etc.');
  console.log('  • Database:        plugins/<alias>/db.sqlite');
  console.log('  • OpenCode tools:  <alias>_list, <alias>_create, etc.');
  console.log('\nChoose a short, memorable name (e.g. "todo", "jobs").');

  const suggestedAlias = plugin.name.replace(/^dm-bot-/, '').replace(/-plugin$/, '');

  let alias = await ask(`Alias (default: ${suggestedAlias}): `);

  if (!alias) {
    alias = suggestedAlias;
  }

  // Step 6: check alias collision
  const pluginsData = readPluginsJson();
  const existingAliases = new Set(pluginsData.plugins.map((p) => p.alias));

  if (existingAliases.has(alias)) {
    console.error(`\n✗ Alias "${alias}" is already in use by another plugin.`);
    const newAlias = await ask('Choose a different alias: ');

    if (!newAlias) {
      console.error('No alias provided. Exiting.');
      process.exit(1);
    }

    if (existingAliases.has(newAlias)) {
      console.error(`Alias "${newAlias}" is also in use. Exiting.`);
      process.exit(1);
    }

    alias = newAlias;
  }

  // Step 7: clone into plugins/{alias}
  const destDir = join(ROOT, 'plugins', alias);

  if (existsSync(destDir)) {
    console.error(`\n✗ Directory already exists: ${destDir}`);
    process.exit(1);
  }

  console.log(`\nCloning ${plugin.repo} at ${selectedRef.tag}...`);

  const cloneResult = Bun.spawnSync(
    ['git', 'clone', '--branch', selectedRef.tag, '--depth', '1', plugin.repo, destDir],
    { stdio: ['inherit', 'inherit', 'inherit'] },
  );

  if (cloneResult.exitCode !== 0) {
    console.error('✗ git clone failed.');
    process.exit(1);
  }

  console.log('✓ Plugin cloned.');

  // Step 8: update plugins.json
  pluginsData.plugins.push({
    alias,
    repo: plugin.repo,
    version: selectedRef.tag,
  });

  writePluginsJson(pluginsData);
  console.log('✓ plugins.json updated.');

  // Step 9: run generate-tools script
  console.log('\nRunning code generators...');

  const genResult = Bun.spawnSync(['bun', 'run', 'scripts/generate-tools.ts'], {
    cwd: ROOT,
    stdio: ['inherit', 'inherit', 'inherit'],
  });

  if (genResult.exitCode !== 0) {
    console.error('✗ Generator failed.');
    process.exit(1);
  }

  console.log(`\n✓ Plugin "${alias}" installed successfully.`);
  console.log(`  Commands: !${alias} help`);
  console.log(`  Tools:    ${alias}_list, ${alias}_create, ...\n`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
