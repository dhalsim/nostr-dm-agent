import { appendFileSync } from 'fs';
import { SimplePool } from 'nostr-tools/pool';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import readline from 'readline';

const ENV_PATH = '.env';

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
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                  NOSTR BOT SETUP                     ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const secretKey = generateSecretKey();
  const botPubkey = getPublicKey(secretKey);
  const botNpub = nip19.npubEncode(botPubkey);
  const botKeyHex = Buffer.from(secretKey).toString('hex');

  appendFileSync(ENV_PATH, `\n# Bot private key (hex)\nBOT_KEY=${botKeyHex}\n`);

  console.log(`  Bot pubkey: ${botPubkey}`);
  console.log(`  Bot npub: ${botNpub}`);
  console.log('  (Bot key is saved to .env and can be regenerated if lost)\n');

  let masterPubkey = '';
  while (!masterPubkey) {
    masterPubkey = await question('Your master (bot is going to reply to) pubkey (hex|npub): ');
    
    if (masterPubkey.startsWith('npub1')) {
      const decoded = nip19.decode(masterPubkey);

      if (decoded.type !== 'npub') {
        console.error('  Invalid npub format. Please provide a valid npub.');

        process.exit(1);
      }

      masterPubkey = decoded.data;
    }
  }

  let relays = await question('DM/Inbox Relays (comma-separated).\nCheck https://marcodpt.github.io/nostracker/relays/index.html for NIP17 and NIP42 supported relays.\nEnter your relays (leave empty for default wss://auth.nostr1.com,wss://relay.netstr.io): ');
  relays = relays.trim() || 'wss://auth.nostr1.com,wss://relay.netstr.io';

  const relayList = relays.split(',').map((r) => r.trim()).filter(Boolean);

  appendFileSync(ENV_PATH, `# Your master pubkey\nBOT_MASTER_PUBKEY=${masterPubkey}\n`);
  appendFileSync(ENV_PATH, `# Relays\nBOT_RELAYS=${relays}\n`);

  console.log('\n✓ Written to .env');

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

  const pool = new SimplePool();

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
    if (result.status === 'fulfilled') {
      console.log(`  ✓ Published to ${relayList[idx]}`);
    } else {
      console.error(`  ✗ Publish error on ${relayList[idx]}: ${result.reason}`);
    }
  }

  console.log('\n✓ Setup complete!');
  console.log('  Next: npm run wallet:setup (optional, for paid AI)');
  console.log('  Then: npm run start');

  process.exit(0);
}

main().catch(console.error);
