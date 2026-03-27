#!/usr/bin/env bun
// scripts/manage-bunker-connections.ts — save NIP-46 bunker sessions in core DB
//
// Usage:
//   bun scripts/manage-bunker-connections.ts           — interactive menu
//   bun scripts/manage-bunker-connections.ts --list  — one connection name per line, then exit

import * as readline from 'readline';

import { nip19 } from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';

import { openCoreDb } from '../src/db';
import { connectBunker } from '../src/nostr/bunker';
import type { ConnectionRow } from '../src/nostr/connections';
import { createConnectionsTable } from '../src/nostr/connections';
import {
  listConnections,
  saveConnection,
  deleteConnection,
} from '../src/nostr/connections';

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

function askWithDefault<T extends string>(
  question: string,
  current: T,
  options: T[],
): Promise<T> {
  const optionStr = options
    .map((o) => (o === current ? `[${o}]` : o))
    .join(' | ');

  return ask(`${question} (${optionStr}): `).then((ans) => {
    if (!ans) {
      return current;
    }

    if (options.includes(ans as T)) {
      return ans as T;
    }

    console.log(`  Invalid option. Keeping: ${current}`);

    return current;
  });
}

function formatNpub(hex: string): string {
  try {
    return nip19.npubEncode(hex);
  } catch {
    return hex;
  }
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function showConnection(conn: ConnectionRow, index: number): void {
  console.log(`  ${index + 1}. ${conn.name}`);
  console.log(`     User:   ${formatNpub(conn.data.userPubkey)}`);

  console.log(
    `     Relays: ${conn.data.relays.length} (${conn.data.relays[0]})`,
  );

  console.log(`     Created: ${formatDate(conn.created_at)}`);
}

/** One name per line, stdout only — for scripts and agents. */
function listConnectionNamesOnly(db: ReturnType<typeof openCoreDb>): void {
  const connections = listConnections(db);

  for (const conn of connections) {
    console.log(conn.name);
  }
}

async function listConnectionsMenu(
  db: ReturnType<typeof openCoreDb>,
): Promise<void> {
  const connections = listConnections(db);

  console.log('\n── Bunker Connections ──\n');

  if (connections.length === 0) {
    console.log('  No connections found.\n');

    return;
  }

  for (const [i, conn] of connections.entries()) {
    showConnection(conn, i);
  }

  console.log();
}

async function createConnection(
  db: ReturnType<typeof openCoreDb>,
): Promise<void> {
  console.log('\n── Create Connection ──\n');

  let name = '';
  while (!name) {
    name = await ask('Connection name: ');

    if (!name) {
      console.log('  Name is required.\n');
    }
  }

  const existing = listConnections(db);

  if (existing.some((c) => c.name === name)) {
    console.log(`  Error: A connection named "${name}" already exists.\n`);

    return;
  }

  let bunkerUrl = '';
  while (!bunkerUrl) {
    bunkerUrl = await ask('Bunker URL (bunker://<pubkey>?relay=...): ');

    if (!bunkerUrl) {
      console.log('  URL is required.\n');
    }
  }

  console.log('\n  Connecting to bunker...\n');

  const pool = new SimplePool();

  try {
    const data = await connectBunker(pool, bunkerUrl);

    saveConnection(db, name, 'bunker', {
      relays: data.relays,
      ephemeralSecret: data.ephemeralSecret,
      ephemeralPubkey: data.ephemeralPubkey,
      remoteSignerPubkey: data.remoteSignerPubkey,
      userPubkey: data.userPubkey,
    });

    console.log(`\n  ✓ Connected and saved as "${name}"`);
    console.log(`    User pubkey: ${formatNpub(data.userPubkey)}\n`);
  } catch (err) {
    console.error(`\n  ✗ Connection failed: ${err}\n`);
  } finally {
    pool.close([]);
  }
}

async function deleteConnectionMenu(
  db: ReturnType<typeof openCoreDb>,
): Promise<void> {
  const connections = listConnections(db);

  if (connections.length === 0) {
    console.log('\n  No connections to delete.\n');

    return;
  }

  console.log('\n── Delete Connection ──\n');

  for (const [i, conn] of connections.entries()) {
    showConnection(conn, i);
  }

  console.log();

  const selection = await ask('Enter number to delete: ');

  if (!selection) {
    return;
  }

  const index = parseInt(selection, 10) - 1;

  if (index < 0 || index >= connections.length) {
    console.log('  Invalid selection.\n');

    return;
  }

  const target = connections[index];

  const confirm = await askWithDefault(`Delete "${target.name}"?`, 'no', [
    'yes',
    'no',
  ]);

  if (confirm !== 'yes') {
    console.log('  Cancelled.\n');

    return;
  }

  const deleted = deleteConnection(db, target.name);

  if (deleted) {
    console.log(`  ✓ Deleted "${target.name}"\n`);
  } else {
    console.log('  Failed to delete.\n');
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--list')) {
    const db = openCoreDb();

    createConnectionsTable(db);
    listConnectionNamesOnly(db);

    db.close();

    process.exit(0);
  }

  console.log('\n── Manage Bunker Connections ──\n');

  const db = openCoreDb();
  createConnectionsTable(db);

  await listConnectionsMenu(db);

  let running = true;

  while (running) {
    const raw = await ask('[l]ist, [c]reate, [d]elete, [q]uit: ');
    const action = raw.toLowerCase().trim() || 'l';

    switch (action) {
      case 'l':
        await listConnectionsMenu(db);
        break;
      case 'c':
        await createConnection(db);
        break;
      case 'd':
        await deleteConnectionMenu(db);
        break;
      case 'q':
        running = false;
        break;
    }
  }

  console.log('\nGoodbye.\n');
  db.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
