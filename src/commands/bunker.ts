import { nip19 } from 'nostr-tools';
import type { SimplePool } from 'nostr-tools/pool';

import type { CoreDb } from '../db';
import { connectBunker } from '../nostr/bunker';
import {
  getConnection,
  listConnections,
  saveConnection,
} from '../nostr/connections';

function formatPubkey(hex: string): string {
  try {
    return nip19.npubEncode(hex);
  } catch {
    return hex;
  }
}

function formatCreatedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function getBunkerUsage(): string {
  return 'Usage: !bunker list | !bunker add <name> <bunker://...>';
}

export type HandleBunkerProps = {
  db: CoreDb;
  pool: SimplePool;
  args: string[];
};

export async function handleBunker({
  db,
  pool,
  args,
}: HandleBunkerProps): Promise<string> {
  const subcmd = args[0]?.toLowerCase();

  if (!subcmd || subcmd === 'help') {
    return getBunkerUsage();
  }

  if (subcmd === 'list') {
    const connections = listConnections(db);

    if (connections.length === 0) {
      return `No bunker connections found. Add one with \`!bunker add <name> <address>\`.`;
    }

    return connections
      .map((connection, index) => {
        const firstRelay = connection.data.relays[0] ?? '(none)';

        return `${index + 1}. ${connection.name}
User: ${formatPubkey(connection.data.userPubkey)}
Remote signer: ${formatPubkey(connection.data.remoteSignerPubkey)}
Relays: ${connection.data.relays.length} (${firstRelay})
Created: ${formatCreatedAt(connection.created_at)}`;
      })
      .join('\n\n');
  }

  if (subcmd !== 'add') {
    return getBunkerUsage();
  }

  const name = args[1]?.trim();
  const bunkerUrl = args[2]?.trim();

  if (!name || !bunkerUrl) {
    return getBunkerUsage();
  }

  if (getConnection(db, name)) {
    return `A bunker connection named "${name}" already exists.`;
  }

  const data = await connectBunker(pool, bunkerUrl);

  saveConnection(db, name, 'bunker', {
    relays: data.relays,
    ephemeralSecret: data.ephemeralSecret,
    ephemeralPubkey: data.ephemeralPubkey,
    remoteSignerPubkey: data.remoteSignerPubkey,
    userPubkey: data.userPubkey,
  });

  return `Saved bunker connection "${name}".
User: ${formatPubkey(data.userPubkey)}
Remote signer: ${formatPubkey(data.remoteSignerPubkey)}
Relays: ${data.relays.join(', ')}`;
}
