#!/usr/bin/env bun
// scripts/send-dm-to-master.ts — one-shot NIP-17 DM from bot identity to BOT_MASTER_PUBKEY
//
// Usage: bun scripts/send-dm-to-master.ts -- <message>
// Requires: BOT_KEY, BOT_MASTER_PUBKEY, BOT_RELAYS (same as the main bot)

import { SimplePool } from 'nostr-tools/pool';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';

import { loadBotConfig } from '../src/env';
import { createSignAuthEvent, sendDm } from '../src/nostr/nip17';

async function main(): Promise<void> {
  const message = process.argv.slice(2).join(' ').trim();

  if (!message) {
    console.error('Usage: bun scripts/send-dm-to-master.ts -- <message>');
    process.exit(1);
  }

  const config = loadBotConfig();
  const botSecretKey = hexToBytes(config.botKeyHex);
  const derivedPubkey = getPublicKey(botSecretKey);

  if (config.botPubkey && derivedPubkey !== config.botPubkey) {
    console.error(
      `Bot pubkey mismatch. Expected BOT_PUBKEY ${config.botPubkey}, derived ${derivedPubkey}`,
    );

    process.exit(1);
  }

  const pool = new SimplePool({ enablePing: true, enableReconnect: true });
  const signAuthEvent = createSignAuthEvent({ botSecretKey });
  const primaryRelay = config.relayUrls[0];

  try {
    await sendDm({
      pool,
      botRelayUrl: primaryRelay,
      senderSecretKey: botSecretKey,
      recipientPubkey: config.masterPubkey,
      message,
      signAuthEvent,
      redrawPrompt: null,
    });

    console.log('Sent DM to master.');

    process.exit(0);
  } finally {
    pool.close(config.relayUrls);
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
