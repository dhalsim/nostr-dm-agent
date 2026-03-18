import readline from 'readline';

import { nip19 } from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';

import { getOrSetEnvVar } from '../src/env-file';

const ENV_PATH = '.env';

const PROFILE_PUBLISH_RELAYS = [
  'wss://purplepag.es',
  'wss://relay.nos.social',
  'wss://user.kindpag.es',
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://relay.0xchat.com',
];

type Nip65Relays = {
  readRelays: string[];
  writeRelays: string[];
  flatRelays: { relay: string; read: boolean; write: boolean }[];
};

function toReadWriteRelays(tags: string[][]): Nip65Relays {
  const relayTags = tags.filter((tag) => tag[0] === 'r');
  const readRelays = relayTags.filter((tag) => tag[2] === 'read' || !tag[2]).map((tag) => tag[1]);
  const writeRelays = relayTags.filter((tag) => tag[2] === 'write' || !tag[2]).map((tag) => tag[1]);

  const flatRelays = relayTags.map((tag) => ({
    relay: tag[1],
    read: tag[2] === 'read' || !tag[2],
    write: tag[2] === 'write' || !tag[2],
  }));

  return { readRelays, writeRelays, flatRelays };
}

function question(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log(`\n
╔══════════════════════════════════════════════════════════╗
║                  NOSTR BOT SETUP                         ║
╚══════════════════════════════════════════════════════════╝\n`);

  const botKeyHex = await getOrSetEnvVar(ENV_PATH, 'BOT_KEY', () => {
    const sk = generateSecretKey();

    return Buffer.from(sk).toString('hex');
  });

  const secretKey = new Uint8Array(Buffer.from(botKeyHex, 'hex'));
  const botPubkey = getPublicKey(secretKey);
  const botNpub = nip19.npubEncode(botPubkey);

  console.log(`  Bot pubkey: ${botPubkey}`);
  console.log(`  Bot npub: ${botNpub}`);
  console.log('  (Bot key is in .env; re-run is idempotent)\n');

  let name = await question('Bot display name: ');
  name = name.trim() || 'DM Bot';

  const picture = `https://robohash.org/${botPubkey}.png?set=set5`;

  const masterPubkey = await getOrSetEnvVar(ENV_PATH, 'BOT_MASTER_PUBKEY', async () => {
    let value = '';
    while (!value) {
      const raw = await question('Your master (bot is going to reply to) pubkey (hex|npub): ');

      if (raw.startsWith('npub1')) {
        const decoded = nip19.decode(raw);

        if (decoded.type !== 'npub') {
          console.error('  Invalid npub format. Please provide a valid npub.');

          continue;
        }

        value = decoded.data as string;
      } else {
        value = raw;
      }
    }

    return value;
  });

  const relays = await getOrSetEnvVar(ENV_PATH, 'BOT_RELAYS', async () => {
    const raw = await question(
      'DM/Inbox Relays (comma-separated).\nCheck https://marcodpt.github.io/nostracker/relays/index.html for NIP17 and NIP42 supported relays.\nEnter your relays (leave empty for default wss://auth.nostr1.com,wss://relay.netstr.io): ',
    );

    return raw.trim() || 'wss://auth.nostr1.com,wss://relay.netstr.io';
  });

  const relayList = relays
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);

  console.log('\n✓ .env up to date');

  const pool = new SimplePool();

  console.log('\nPublishing kind 0 (bot profile)...');

  const metadataContent = JSON.stringify({
    name,
    bot: true,
    picture,
  });

  const kind0Event = {
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: metadataContent,
  };

  const signedKind0 = finalizeEvent(kind0Event, secretKey);

  const kind0Results = await Promise.allSettled(pool.publish(PROFILE_PUBLISH_RELAYS, signedKind0));

  for (const [idx, result] of kind0Results.entries()) {
    const url = PROFILE_PUBLISH_RELAYS[idx];

    if (result.status === 'fulfilled') {
      console.log(`  ✓ Kind 0 → ${url}`);
    } else {
      console.error(`  ✗ Kind 0 ${url}: ${result.reason}`);
    }
  }

  console.log('\nPublishing kind 10050 (DM relay discovery)...');

  const event = {
    kind: 10050,
    created_at: Math.floor(Date.now() / 1000),
    tags: relayList.map((r) => ['r', r]),
    content: '',
  };

  // fetch master's nip65 relays
  const PROFILE_RELAYS = [
    'wss://purplepag.es',
    'wss://relay.nos.social',
    'wss://user.kindpag.es',
    'wss://relay.nostr.band',
  ];

  const nip65Event = await pool.get(PROFILE_RELAYS, {
    kinds: [10050],
    authors: [masterPubkey],
    limit: 1,
  });

  const masterReadRelays = nip65Event
    ? toReadWriteRelays(nip65Event.tags).readRelays
    : PROFILE_RELAYS;

  const signed = finalizeEvent(event, secretKey);

  const results = await Promise.allSettled(pool.publish(masterReadRelays, signed));

  for (const [idx, result] of results.entries()) {
    const url = masterReadRelays[idx];

    if (result.status === 'fulfilled') {
      console.log(`  ✓ Kind 10050 → ${url}`);
    } else {
      console.error(`  ✗ Kind 10050 ${url}: ${result.reason}`);
    }
  }

  // TODO: publish a kind 10050 event for the bot's own relays

  console.log('\n✓ Setup complete!');
  console.log('  Next: bun run wallet:setup (optional, for paid AI)');
  console.log('  Then: bun run start');

  process.exit(0);
}

main().catch(console.error);
