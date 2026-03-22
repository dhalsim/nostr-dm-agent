// ---------------------------------------------------------------------------
// scripts/install-plugin.ts — Discover, install, or update a bot plugin
//
// Usage:
//   bun run scripts/install-plugin.ts           — discover and install
//   bun run scripts/install-plugin.ts <alias>   — update if installed, install if not
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as readline from 'readline';

import type { NostrEvent } from 'nostr-tools';
import { nip19, SimplePool } from 'nostr-tools';
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

type PluginEntry = z.infer<typeof PluginEntrySchema>;
type PluginsJson = z.infer<typeof PluginsJsonSchema>;

type RefEntry = {
  tag: string;
  coreMajor: string;
  changelog: string;
};

/** Stored in plugins.json when the user installs the remote default branch (nightly). */
const PLUGIN_VERSION_HEAD = 'HEAD';

type SelectedPluginVersion =
  | { kind: 'catalog'; ref: RefEntry }
  | { kind: 'head' };

type PluginEvent = {
  id: string;
  created_at: number;
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

function parsePluginEvent(event: NostrEvent): PluginEvent | null {
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
    created_at: event.created_at,
    pubkey: event.pubkey,
    name,
    description: event.content,
    version: tagValue(event.tags, 'version'),
    coreApiVersion: tagValue(event.tags, 'coreApiVersion'),
    repo,
    refs,
  };
}

function findCompatibleRef(
  refs: RefEntry[],
  coreMajor: string,
): RefEntry | null {
  return refs.filter((r) => r.coreMajor === coreMajor).at(-1) ?? null;
}

function latestRef(refs: RefEntry[]): RefEntry | null {
  return refs.at(-1) ?? null;
}

/** Compare tags like `1.0.0` and `v1.0.0`. */
function normalizeRefTag(tag: string): string {
  const t = tag.trim().toLowerCase();

  return t.startsWith('v') ? t.slice(1) : t;
}

function findRefForInstalledVersion(
  refs: RefEntry[],
  installedVersion: string,
): RefEntry | null {
  if (installedVersion === PLUGIN_VERSION_HEAD) {
    return null;
  }

  const n = normalizeRefTag(installedVersion);

  return refs.find((r) => normalizeRefTag(r.tag) === n) ?? null;
}

// ---------------------------------------------------------------------------
// Remote: compare default branch (HEAD) to a release tag
// ---------------------------------------------------------------------------

const GIT_LS_REMOTE_TIMEOUT_MS = 12_000;
const NIP05_FETCH_TIMEOUT_MS = 8_000;

type ParseLsRemoteForHeadAndTagProps = {
  lsRemoteStdout: string;
  tag: string;
};

function parseLsRemoteForHeadAndTag({
  lsRemoteStdout,
  tag,
}: ParseLsRemoteForHeadAndTagProps): {
  headSha: string | null;
  tagSha: string | null;
} {
  let headSha: string | null = null;
  let tagDirect: string | null = null;
  let tagPeeled: string | null = null;
  const tagRef = `refs/tags/${tag}`;
  const tagPeeledRef = `${tagRef}^{}`;

  for (const line of lsRemoteStdout.split('\n')) {
    const t = line.trim();

    if (!t) {
      continue;
    }

    const tab = t.indexOf('\t');

    if (tab === -1) {
      continue;
    }

    const sha = t.slice(0, tab).trim();
    const ref = t.slice(tab + 1).trim();

    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      continue;
    }

    if (ref === 'HEAD') {
      headSha = sha;
    }

    if (ref === tagPeeledRef) {
      tagPeeled = sha;
    }

    if (ref === tagRef) {
      tagDirect = sha;
    }
  }

  const tagSha = tagPeeled ?? tagDirect;

  return { headSha, tagSha };
}

type GitLsRemoteFullProps = {
  repoUrl: string;
  timeoutMs: number;
};

/** One `git ls-remote` per repo (not per ref) so discovery stays responsive. */
async function gitLsRemoteFull({
  repoUrl,
  timeoutMs,
}: GitLsRemoteFullProps): Promise<string | null> {
  const proc = Bun.spawn(['git', 'ls-remote', '--', repoUrl], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const killTimer = setTimeout(() => {
    proc.kill();
  }, timeoutMs);

  try {
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return null;
    }

    return await new Response(proc.stdout).text();
  } catch {
    return null;
  } finally {
    clearTimeout(killTimer);
  }
}

/** `true` if default branch points to a different commit than the tag; `null` if unknown. */
async function remoteHeadDiffersFromTag(
  repoUrl: string,
  tag: string,
): Promise<boolean | null> {
  const stdout = await gitLsRemoteFull({
    repoUrl,
    timeoutMs: GIT_LS_REMOTE_TIMEOUT_MS,
  });

  if (!stdout) {
    return null;
  }

  const { headSha, tagSha } = parseLsRemoteForHeadAndTag({
    lsRemoteStdout: stdout,
    tag,
  });

  if (!headSha || !tagSha) {
    return null;
  }

  return headSha !== tagSha;
}

type BuildPluginDiscoveryVersionLinesProps = {
  plugin: PluginEvent;
  installed: PluginEntry | null;
  coreMajor: string;
  headAheadOfRelease: boolean | null;
};

function buildPluginDiscoveryVersionLines({
  plugin,
  installed,
  coreMajor,
  headAheadOfRelease,
}: BuildPluginDiscoveryVersionLinesProps): string[] {
  const compatible = findCompatibleRef(plugin.refs, coreMajor);
  const lines: string[] = [];

  if (installed) {
    if (installed.version === PLUGIN_VERSION_HEAD) {
      lines.push(
        `version: HEAD (experimental) ✓ installed — default branch, not a catalog tag`,
      );
    } else {
      const installedRef = findRefForInstalledVersion(
        plugin.refs,
        installed.version,
      );

      if (installedRef) {
        lines.push(
          `version: ${installedRef.tag} for core ${installedRef.coreMajor} ✓ installed`,
        );
      } else {
        lines.push(
          `version: ${installed.version} ✓ installed (no matching ref tag on catalog)`,
        );
      }
    }

    if (compatible) {
      if (
        normalizeRefTag(compatible.tag) !== normalizeRefTag(installed.version)
      ) {
        lines.push(
          `version: ${compatible.tag} for core ${compatible.coreMajor} (upgrade available)`,
        );
      }

      if (
        headAheadOfRelease === true &&
        installed.version !== PLUGIN_VERSION_HEAD
      ) {
        lines.push(
          `version: HEAD (experimental — newer than ${compatible.tag})`,
        );
      }
    } else {
      const latest = latestRef(plugin.refs);

      lines.push(
        `version: no ref for bot core ${coreMajor} (latest catalog ref: ${latest?.tag ?? '?'} for core ${latest?.coreMajor ?? '?'})`,
      );
    }
  } else if (compatible) {
    lines.push(
      `version: ${compatible.tag} for core ${compatible.coreMajor} ✓ compatible`,
    );

    if (headAheadOfRelease === true) {
      lines.push(`version: HEAD (experimental — newer than ${compatible.tag})`);
    }
  } else {
    const latest = latestRef(plugin.refs);

    lines.push(
      `version: latest ${latest?.tag ?? '?'} for core ${latest?.coreMajor ?? '?'} — not compatible with bot core ${coreMajor}`,
    );
  }

  return lines;
}

async function findInstalledEntryForEvent(
  event: PluginEvent,
  plugins: PluginEntry[],
): Promise<PluginEntry | null> {
  for (const entry of plugins) {
    if (await samePlugin(entry.repo, event)) {
      return entry;
    }
  }

  return null;
}

/** Resolve a nostr:// repo URL to { pubkeyHex, repoName }.
 *  Supports both npub and NIP-05 (_@domain) identity formats. */
async function resolveRepoIdentity(
  url: string,
): Promise<{ pubkeyHex: string; repoName: string } | null> {
  try {
    const withoutProtocol = url.replace('nostr://', '');
    const parts = withoutProtocol.split('/');
    const identity = parts[0];
    const repoName = parts.at(-1) ?? '';

    let pubkeyHex: string;

    if (identity.startsWith('npub1')) {
      const decoded = nip19.decode(identity);

      if (decoded.type !== 'npub') {
        return null;
      }

      pubkeyHex = decoded.data as string;
    } else if (identity.includes('@')) {
      const [name, domain] = identity.split('@');

      const res = await fetch(
        `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`,
        { signal: AbortSignal.timeout(NIP05_FETCH_TIMEOUT_MS) },
      );

      if (!res.ok) {
        return null;
      }

      const json = (await res.json()) as { names: Record<string, string> };
      pubkeyHex = json.names[name] ?? '';

      if (!pubkeyHex) {
        return null;
      }
    } else {
      return null;
    }

    return { pubkeyHex, repoName };
  } catch {
    return null;
  }
}

/** Returns true if a plugin event matches a repo URL (npub or NIP-05 format). */
async function samePlugin(
  repoUrl: string,
  event: PluginEvent,
): Promise<boolean> {
  const resolved = await resolveRepoIdentity(repoUrl);

  if (!resolved) {
    return false;
  }

  return (
    event.pubkey === resolved.pubkeyHex && event.name === resolved.repoName
  );
}

async function queryPluginEvents(pool: SimplePool): Promise<PluginEvent[]> {
  return new Promise((resolve) => {
    const found = new Map<string, PluginEvent>();

    const sub = pool.subscribe(
      PLUGIN_QUERY_RELAYS,
      { kinds: [PLUGIN_KIND], limit: 50 },
      {
        onevent: (event) => {
          const key = `${event.pubkey}:${tagValue(event.tags, 'd')}`;
          const foundEvent = found.get(key);

          if (foundEvent && foundEvent.created_at > event.created_at) {
            return;
          }

          const parsedPlugin = parsePluginEvent(event);

          if (parsedPlugin) {
            found.set(key, parsedPlugin);
          }
        },
        oneose: () => {
          sub.close();
          resolve(Array.from(found.values()));
        },
      },
    );

    setTimeout(() => {
      sub.close();
      resolve(Array.from(found.values()));
    }, 10_000);
  });
}

type FallbackSelectWhenNoCompatibleRefProps = {
  plugin: PluginEvent;
  coreMajor: string;
};

async function fallbackSelectWhenNoCompatibleRef({
  plugin,
  coreMajor,
}: FallbackSelectWhenNoCompatibleRefProps): Promise<RefEntry | null> {
  const latest = latestRef(plugin.refs);

  if (!latest) {
    console.error('No refs found in plugin event.');

    return null;
  }

  console.log(`\n⚠ No compatible ref for your bot core (${coreMajor}).`);

  console.log(
    `  Latest available: ${latest.tag} requires core ${latest.coreMajor}`,
  );

  console.log(
    `  → Upgrade your bot to core ${latest.coreMajor} to use the latest version.`,
  );

  const older = [...plugin.refs]
    .reverse()
    .find((r) => parseInt(r.coreMajor) < parseInt(coreMajor));

  if (older) {
    console.log(
      `\n  Older ref available: ${older.tag} (core ${older.coreMajor})`,
    );

    console.log(`  ${older.changelog}`);
    const useOlder = await ask('  Install this older version? (y/N): ');

    if (useOlder.toLowerCase() === 'y') {
      return older;
    }
  } else {
    console.error('  No compatible version found.');
  }

  return null;
}

type SelectPluginVersionProps = {
  plugin: PluginEvent;
  coreMajor: string;
  installedEntry: PluginEntry | null;
  headAheadFromDiscovery: boolean | null;
};

async function selectPluginVersion({
  plugin,
  coreMajor,
  installedEntry,
  headAheadFromDiscovery,
}: SelectPluginVersionProps): Promise<SelectedPluginVersion | null> {
  const compatible = findCompatibleRef(plugin.refs, coreMajor);

  if (installedEntry) {
    console.log(
      `Current installation: ${installedEntry.alias} @ ${installedEntry.version}`,
    );

    if (compatible) {
      if (
        normalizeRefTag(compatible.tag) ===
        normalizeRefTag(installedEntry.version)
      ) {
        console.log(
          `Latest compatible ref matches installed (${compatible.tag}, core ${compatible.coreMajor}).`,
        );
      } else if (installedEntry.version !== PLUGIN_VERSION_HEAD) {
        console.log(
          `Latest compatible ref: ${compatible.tag} (core ${compatible.coreMajor}) — upgrade from ${installedEntry.version}`,
        );
      } else {
        console.log(
          `Latest compatible ref: ${compatible.tag} (core ${compatible.coreMajor}) — you are on ${PLUGIN_VERSION_HEAD}`,
        );
      }
    }
  }

  if (!compatible) {
    const fallback = await fallbackSelectWhenNoCompatibleRef({
      plugin,
      coreMajor,
    });

    if (!fallback) {
      return null;
    }

    return { kind: 'catalog', ref: fallback };
  }

  let headAhead =
    headAheadFromDiscovery ??
    (await remoteHeadDiffersFromTag(plugin.repo, compatible.tag));

  if (headAhead === null) {
    headAhead = false;
  }

  if (!headAhead) {
    if (
      !installedEntry ||
      normalizeRefTag(installedEntry.version) !==
        normalizeRefTag(compatible.tag)
    ) {
      console.log(
        `✓ Compatible ref: ${compatible.tag} (core ${compatible.coreMajor})`,
      );
    }

    console.log(`  ${compatible.changelog}`);

    return { kind: 'catalog', ref: compatible };
  }

  console.log(
    `\nChoose a version (${compatible.tag} is the latest stable release for your bot; default branch may be newer):`,
  );

  console.log(
    `  1. ${compatible.tag} (recommended) — stable release for core ${compatible.coreMajor}`,
  );

  console.log(
    `  2. ${PLUGIN_VERSION_HEAD} (experimental) — default branch tip (nightly / pre-release)`,
  );

  console.log(`  ${compatible.changelog}`);

  const choice = await ask(`Enter 1 or 2 (default: 1 — recommended): `);

  const c = choice.trim();

  if (c === '2') {
    console.log(
      `\n⚠ Installing default-branch ${PLUGIN_VERSION_HEAD}: not a tagged release; expect churn and breakage.`,
    );

    return { kind: 'head' };
  }

  console.log(`✓ Using stable release ${compatible.tag}.`);

  return { kind: 'catalog', ref: compatible };
}

function runGenerator(): void {
  console.log('\nRunning code generators...');

  const result = Bun.spawnSync(['bun', 'run', 'scripts/generate-tools.ts'], {
    cwd: ROOT,
    stdio: ['inherit', 'inherit', 'inherit'],
  });

  if (result.exitCode !== 0) {
    console.error('✗ Generator failed.');
    process.exit(1);
  }
}

function selectedVersionLabel(selected: SelectedPluginVersion): string {
  if (selected.kind === 'catalog') {
    return selected.ref.tag;
  }

  return PLUGIN_VERSION_HEAD;
}

function resolveDefaultBranchName(pluginDir: string): string | null {
  const r = Bun.spawnSync(['git', 'symbolic-ref', 'refs/remotes/origin/HEAD'], {
    cwd: pluginDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (r.exitCode !== 0) {
    return null;
  }

  const s = r.stdout.toString().trim();
  const m = s.match(/^refs\/remotes\/origin\/(.+)$/);

  return m?.[1] ?? null;
}

function checkoutRemoteDefaultBranch(pluginDir: string): boolean {
  const fetchResult = Bun.spawnSync(['git', 'fetch', 'origin'], {
    cwd: pluginDir,
    stdio: ['inherit', 'inherit', 'inherit'],
  });

  if (fetchResult.exitCode !== 0) {
    return false;
  }

  let branch = resolveDefaultBranchName(pluginDir);

  if (!branch) {
    branch = 'main';
  }

  let co = Bun.spawnSync(
    ['git', 'checkout', '-B', branch, `origin/${branch}`],
    { cwd: pluginDir, stdio: ['inherit', 'inherit', 'inherit'] },
  );

  if (co.exitCode !== 0) {
    co = Bun.spawnSync(['git', 'checkout', '-B', 'master', 'origin/master'], {
      cwd: pluginDir,
      stdio: ['inherit', 'inherit', 'inherit'],
    });
  }

  return co.exitCode === 0;
}

// ---------------------------------------------------------------------------
// Update flow
// ---------------------------------------------------------------------------

async function updatePlugin(
  pool: SimplePool,
  entry: PluginEntry,
  coreMajor: string,
  pluginsData: PluginsJson,
): Promise<void> {
  console.log(`\nChecking for updates to "${entry.alias}"...`);
  console.log(`  Current version: ${entry.version}`);

  const events = await queryPluginEvents(pool);

  // Match by pubkey + repo name — supports both npub and NIP-05 URL formats
  let plugin: PluginEvent | undefined;
  for (const e of events) {
    if (await samePlugin(entry.repo, e)) {
      plugin = e;
      break;
    }
  }

  if (!plugin) {
    console.error(`Could not find plugin event for repo: ${entry.repo}`);
    process.exit(1);
  }

  const selected = await selectPluginVersion({
    plugin,
    coreMajor,
    installedEntry: entry,
    headAheadFromDiscovery: null,
  });

  if (!selected) {
    process.exit(1);
  }

  const pluginDir = join(ROOT, 'plugins', entry.alias);

  if (selected.kind === 'catalog') {
    if (normalizeRefTag(selected.ref.tag) === normalizeRefTag(entry.version)) {
      console.log(`✓ Already up to date (${entry.version}).`);
      process.exit(0);
    }
  } else if (entry.version === PLUGIN_VERSION_HEAD) {
    const pullResult = Bun.spawnSync(['git', 'pull', '--ff-only'], {
      cwd: pluginDir,
      stdio: ['inherit', 'inherit', 'inherit'],
    });

    if (pullResult.exitCode !== 0) {
      console.error('✗ git pull failed.');
      process.exit(1);
    }

    runGenerator();

    console.log(
      `\n✓ Plugin "${entry.alias}" is up to date on ${PLUGIN_VERSION_HEAD}.\n`,
    );

    process.exit(0);
  }

  const label = selectedVersionLabel(selected);

  console.log(`\nUpdating ${entry.alias}: ${entry.version} → ${label}`);

  if (selected.kind === 'catalog') {
    const fetchResult = Bun.spawnSync(['git', 'fetch', '--tags'], {
      cwd: pluginDir,
      stdio: ['inherit', 'inherit', 'inherit'],
    });

    if (fetchResult.exitCode !== 0) {
      console.error('✗ git fetch failed.');
      process.exit(1);
    }

    const checkoutResult = Bun.spawnSync(
      ['git', 'checkout', selected.ref.tag],
      {
        cwd: pluginDir,
        stdio: ['inherit', 'inherit', 'inherit'],
      },
    );

    if (checkoutResult.exitCode !== 0) {
      console.error('✗ git checkout failed.');
      process.exit(1);
    }

    console.log(`✓ Checked out ${selected.ref.tag}.`);
  } else {
    const fetchResult = Bun.spawnSync(['git', 'fetch', 'origin'], {
      cwd: pluginDir,
      stdio: ['inherit', 'inherit', 'inherit'],
    });

    if (fetchResult.exitCode !== 0) {
      console.error('✗ git fetch failed.');
      process.exit(1);
    }

    if (!checkoutRemoteDefaultBranch(pluginDir)) {
      console.error('✗ Could not check out the remote default branch.');
      process.exit(1);
    }

    console.log(`✓ Checked out ${PLUGIN_VERSION_HEAD} (default branch).`);
  }

  const idx = pluginsData.plugins.findIndex((p) => p.alias === entry.alias);
  pluginsData.plugins[idx] = { ...entry, version: label };
  writePluginsJson(pluginsData);
  console.log('✓ plugins.json updated.');

  runGenerator();

  console.log(`\n✓ Plugin "${entry.alias}" updated to ${label}.\n`);
}

// ---------------------------------------------------------------------------
// Install flow
// ---------------------------------------------------------------------------

async function installPlugin(
  pool: SimplePool,
  coreMajor: string,
  pluginsData: PluginsJson,
): Promise<void> {
  console.log('\nQuerying plugins from relays...');
  const events = await queryPluginEvents(pool);

  if (events.length === 0) {
    console.log('No plugins found on the queried relays.');
    process.exit(0);
  }

  console.log(`\nFound ${events.length} plugin(s):\n`);

  console.log(
    'Matching installed plugins (NIP-05 lookups are limited to a few seconds each)…',
  );

  const installedForEvents = await Promise.all(
    events.map((e) => findInstalledEntryForEvent(e, pluginsData.plugins)),
  );

  console.log(
    'Checking remote git repositories for newer commits than release tags…',
  );

  const headAheadForEvents = await Promise.all(
    events.map(async (p) => {
      const c = findCompatibleRef(p.refs, coreMajor);

      if (!c) {
        return null;
      }

      return remoteHeadDiffersFromTag(p.repo, c.tag);
    }),
  );

  const indent = '    ';

  events.forEach((p, i) => {
    const installed = installedForEvents[i] ?? null;
    const headAhead = headAheadForEvents[i];

    console.log(`  ${i + 1}. ${p.name}`);

    if (p.description) {
      console.log(`${indent}description: ${p.description}`);
    }

    for (const line of buildPluginDiscoveryVersionLines({
      plugin: p,
      installed,
      coreMajor,
      headAheadOfRelease: headAhead,
    })) {
      console.log(`${indent}${line}`);
    }

    console.log(`${indent}repo: ${p.repo}`);
    console.log();
  });

  const choice = await ask(
    `Choose a plugin to install (1-${events.length}) or q to quit: `,
  );

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

  const installedForSelected = installedForEvents[idx] ?? null;
  const headAheadFromDiscovery = headAheadForEvents[idx];

  const selected = await selectPluginVersion({
    plugin,
    coreMajor,
    installedEntry: installedForSelected,
    headAheadFromDiscovery,
  });

  if (!selected) {
    process.exit(1);
  }

  const installLabel = selectedVersionLabel(selected);

  console.log('\nThe alias is used for:');
  console.log('  • Plugin folder:   plugins/<alias>/');
  console.log('  • Bot commands:    !<alias> list, !<alias> add, etc.');
  console.log('  • Database:        plugins/<alias>/db.sqlite');
  console.log('  • OpenCode tools:  <alias>_list, <alias>_create, etc.');
  console.log('\nChoose a short, memorable name (e.g. "todo", "jobs").');

  const suggestedAlias = plugin.name
    .replace(/^dm-bot-/, '')
    .replace(/-plugin$/, '');

  let alias = await ask(`Alias (default: ${suggestedAlias}): `);

  if (!alias) {
    alias = suggestedAlias;
  }

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

  const destDir = join(ROOT, 'plugins', alias);

  if (existsSync(destDir)) {
    console.error(`\n✗ Directory already exists: ${destDir}`);
    process.exit(1);
  }

  if (selected.kind === 'catalog') {
    console.log(`\nCloning ${plugin.repo} at ${selected.ref.tag}...`);

    const cloneResult = Bun.spawnSync(
      [
        'git',
        'clone',
        '--branch',
        selected.ref.tag,
        '--depth',
        '1',
        plugin.repo,
        destDir,
      ],
      { stdio: ['inherit', 'inherit', 'inherit'] },
    );

    if (cloneResult.exitCode !== 0) {
      console.error('✗ git clone failed.');
      process.exit(1);
    }
  } else {
    console.log(
      `\nCloning ${plugin.repo} (default branch, shallow) — recorded as "${PLUGIN_VERSION_HEAD}" in plugins.json...`,
    );

    const cloneResult = Bun.spawnSync(
      ['git', 'clone', '--depth', '1', plugin.repo, destDir],
      { stdio: ['inherit', 'inherit', 'inherit'] },
    );

    if (cloneResult.exitCode !== 0) {
      console.error('✗ git clone failed.');
      process.exit(1);
    }
  }

  console.log('✓ Plugin cloned.');

  pluginsData.plugins.push({
    alias,
    repo: plugin.repo,
    version: installLabel,
  });

  writePluginsJson(pluginsData);
  console.log('✓ plugins.json updated.');

  runGenerator();

  console.log(`\n✓ Plugin "${alias}" installed successfully.`);
  console.log(`  Run !${alias} help to see available commands.\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n── Bot Plugin Manager ──\n');

  const coreMajor = botCoreMajor();
  console.log(`Bot core major: ${coreMajor}`);

  const pluginsData = readPluginsJson();
  const pool = new SimplePool();
  const aliasArg = process.argv[2]?.trim();

  try {
    if (aliasArg) {
      const existing = pluginsData.plugins.find((p) => p.alias === aliasArg);

      if (existing) {
        await updatePlugin(pool, existing, coreMajor, pluginsData);
      } else {
        console.log(
          `Alias "${aliasArg}" not found in plugins.json — running install flow.`,
        );

        await installPlugin(pool, coreMajor, pluginsData);
      }
    } else {
      await installPlugin(pool, coreMajor, pluginsData);
    }
  } finally {
    pool.destroy();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
