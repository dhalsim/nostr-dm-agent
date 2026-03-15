// ---------------------------------------------------------------------------
// scripts/publish-plugin.ts — Publish a plugin manifest as a Nostr event
//
// Usage: bun run scripts/publish-plugin.ts [plugin-alias]
//
// Reads the plugin's package.json for metadata, fetches the existing kind
// 32107 event to get accumulated ref history, appends the new release ref,
// and republishes via NIP-46 bunker.
//
// Event shape:
//   kind: 32107
//   tags:
//     ["d", "<plugin-name>"]
//     ["description", "<description>"]
//     ["version", "<latest-version>"]
//     ["coreApiVersion", "<latest-core-major>"]
//     ["t", "dm-bot-plugin"]
//     ["ref", "<git-tag>", "<core-major>", "<changelog>"]  (one per release)
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as readline from 'readline';

import { SimplePool } from 'nostr-tools';
import { z } from 'zod';

import { connectBunker, bunkerSignEvent } from '../src/nostr/bunker';

const PLUGIN_KIND = 32107;
const ROOT = join(import.meta.dir, '..');
const PLUGINS_JSON = join(ROOT, 'plugins.json');

const PROFILE_RELAYS = [
  'wss://purplepag.es',
  'wss://relay.nos.social',
  'wss://user.kindpag.es',
  'wss://relay.nostr.band',
];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const PackageJsonSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  dmBot: z.object({
    coreApiVersion: z.string().min(1),
  }),
});

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

type PackageJson = z.infer<typeof PackageJsonSchema>;
type PluginsJson = z.infer<typeof PluginsJsonSchema>;

type RefEntry = {
  tag: string;
  coreMajor: string;
  changelog: string;
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

function getCoreApiVersion(pkg: PackageJson): string {
  return pkg.dmBot.coreApiVersion;
}

async function fetchExistingRefs(
  pluginName: string,
  authorPubkey: string,
  relays: string[],
): Promise<RefEntry[]> {
  const pool = new SimplePool();
  try {
    const event = await pool.get(relays, {
      kinds: [PLUGIN_KIND],
      authors: [authorPubkey],
      '#d': [pluginName],
      limit: 1,
    });

    if (!event) {
      return [];
    }

    return event.tags
      .filter((t) => t[0] === 'ref' && t[1] && t[2] && t[3])
      .map((t) => ({ tag: t[1], coreMajor: t[2], changelog: t[3] }));
  } finally {
    pool.destroy();
  }
}

async function fetchNip65WriteRelays(pubkey: string): Promise<string[]> {
  const pool = new SimplePool();
  try {
    const event = await pool.get(PROFILE_RELAYS, {
      kinds: [10002],
      authors: [pubkey],
      limit: 1,
    });

    if (!event) {
      return [];
    }

    return event.tags
      .filter((t) => t[0] === 'r' && (!t[2] || t[2] === 'write'))
      .map((t) => t[1])
      .filter(Boolean);
  } finally {
    pool.destroy();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n── Bot Plugin Publisher ──\n');

  // Step 1: resolve plugin alias
  let alias = process.argv[2]?.trim() ?? '';

  const pluginsRaw = JSON.parse(readFileSync(PLUGINS_JSON, 'utf8'));
  const pluginsParsed = PluginsJsonSchema.safeParse(pluginsRaw);

  if (!pluginsParsed.success) {
    console.error(`Invalid plugins.json:\n${pluginsParsed.error.toString()}`);
    process.exit(1);
  }

  const pluginsData: PluginsJson = pluginsParsed.data;

  if (!alias) {
    const aliases = pluginsData.plugins.map((p) => p.alias).join(', ');

    alias = await ask(
      `Choose a plugin alias to publish (available from plugins.json: ${aliases}): `,
    );
  }

  if (!alias) {
    console.error('No plugin specified.');
    process.exit(1);
  }

  const pluginEntry = pluginsData.plugins.find((p) => p.alias === alias);

  if (!pluginEntry) {
    console.error(`Plugin entry not found: ${alias}`);
    process.exit(1);
  }

  const pluginDir = join(ROOT, 'plugins', alias);

  if (!existsSync(pluginDir)) {
    console.error(`Plugin directory not found: ${pluginDir}`);
    process.exit(1);
  }

  // Step 2: read and validate package.json
  const pkgPath = join(pluginDir, 'package.json');

  if (!existsSync(pkgPath)) {
    console.error(`No package.json found at ${pkgPath}`);
    process.exit(1);
  }

  const pkgRaw = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const pkgParsed = PackageJsonSchema.safeParse(pkgRaw);

  if (!pkgParsed.success) {
    console.error(
      `Invalid package.json at ${pkgPath}:\n${pkgParsed.error.toString()}\n\n` +
        `Required fields: name, version, dmBot.coreApiVersion\n` +
        `Optional fields: description`,
    );

    process.exit(1);
  }

  const pkg = pkgParsed.data;

  const coreApiVersion = getCoreApiVersion(pkg);
  const coreMajor = coreApiVersion.replace(/[^0-9]/g, '').slice(0, 1);

  if (!coreMajor) {
    console.error(
      'No coreApiVersion found in package.json.\n' +
        'Add "coreApiVersion": "5" to the plugin\'s package.json.',
    );

    process.exit(1);
  }

  console.log(`Plugin:         ${pkg.name} v${pkg.version}`);

  if (pkg.description) {
    console.log(`Description:    ${pkg.description}`);
  }

  console.log(`Core API major: ${coreMajor}`);

  // Step 3: bunker sign-in (needed to know author pubkey for fetching existing event)
  console.log('\nNIP-46 Bunker sign-in required.');
  console.log('Your key never leaves your signer. The bunker URL is not stored.\n');

  const bunkerUrl = await ask('Bunker URL (bunker://...): ');

  if (!bunkerUrl) {
    console.error('No bunker URL provided.');
    process.exit(1);
  }

  const pool = new SimplePool();

  console.log('\nConnecting to bunker...');
  let bunkerData;
  try {
    bunkerData = await connectBunker(pool, bunkerUrl);
  } catch (err) {
    console.error(`Bunker connection failed: ${String(err)}`);
    process.exit(1);
  }

  console.log(`✓ Connected. Publisher pubkey: ${bunkerData.userPubkey}`);

  // Step 4: fetch existing ref history from relays
  console.log('\nFetching existing event from relays...');
  const existingRefs = await fetchExistingRefs(pkg.name, bunkerData.userPubkey, PROFILE_RELAYS);

  if (existingRefs.length > 0) {
    console.log(`Found ${existingRefs.length} existing ref(s).`);
  } else {
    console.log('No existing event found — this will be the first publish.');
  }

  // Step 5: check if this version already published
  const gitTag = `v${pkg.version}`;
  const alreadyPublished = existingRefs.some((r) => r.tag === gitTag);

  if (alreadyPublished) {
    console.log(`\n⚠ ${gitTag} is already in the ref history.`);
    const cont = await ask('Republish anyway? (y/N): ');

    if (cont.toLowerCase() !== 'y') {
      process.exit(0);
    }
  }

  // Step 6: ask for changelog
  let changelog: string;

  if (!alreadyPublished) {
    changelog = await ask(`\nChangelog for ${gitTag} (one line): `);

    if (!changelog) {
      changelog = `Release ${gitTag}`;
    }
  } else {
    changelog = existingRefs.find((r) => r.tag === gitTag)?.changelog ?? `Release ${gitTag}`;
  }

  // Step 7: build updated ref list
  const updatedRefs: RefEntry[] = alreadyPublished
    ? existingRefs
    : [...existingRefs, { tag: gitTag, coreMajor, changelog }];

  console.log('\nFull ref history to publish:');
  for (const ref of updatedRefs) {
    console.log(`  ["ref", "${ref.tag}", "${ref.coreMajor}", "${ref.changelog}"]`);
  }

  const confirm = await ask('\nLook correct? Proceed to sign and publish? (Y/n): ');

  if (confirm.toLowerCase() === 'n') {
    process.exit(0);
  }

  // Step 8: fetch NIP-65 write relays
  console.log('\nFetching your NIP-65 write relays...');
  let writeRelays = await fetchNip65WriteRelays(bunkerData.userPubkey);

  if (writeRelays.length === 0) {
    console.log('No NIP-65 write relays found, using defaults.');
    writeRelays = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://relay.nostr.band'];
  }

  console.log(`Publishing to: ${writeRelays.join(', ')}`);

  // Step 9: build and sign event
  const eventTemplate = {
    kind: PLUGIN_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', pkg.name],
      ...(pkg.description ? [['description', pkg.description]] : []),
      ['version', gitTag],
      ['coreApiVersion', coreMajor],
      ['t', 'dm-bot-plugin'],
      ...updatedRefs.map((r) => ['ref', r.tag, r.coreMajor, r.changelog]),
    ],
    content: '',
  };

  console.log('\nSigning event via bunker...');
  let signedEvent;
  try {
    signedEvent = await bunkerSignEvent(pool, bunkerData, eventTemplate);
  } catch (err) {
    console.error(`Failed to sign event: ${String(err)}`);
    process.exit(1);
  }

  console.log(`✓ Signed. Event ID: ${signedEvent.id}`);

  // Step 10: publish
  console.log('\nPublishing...');

  const results = await Promise.allSettled(pool.publish(writeRelays, signedEvent));

  pool.destroy();

  for (const [i, result] of results.entries()) {
    const url = writeRelays[i];

    if (result.status === 'fulfilled') {
      console.log(`  ✓ ${url}`);
    } else {
      console.error(`  ✗ ${url}: ${String(result.reason)}`);
    }
  }

  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  console.log(`\n${succeeded > 0 ? '✓' : '✗'} Published to ${succeeded}/${results.length} relays.`);

  if (succeeded > 0) {
    console.log(`  Event ID: ${signedEvent.id}`);
    console.log(`  Discoverable via: kind:${PLUGIN_KIND} #d:${pkg.name}\n`);
  }

  process.exit(succeeded > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
