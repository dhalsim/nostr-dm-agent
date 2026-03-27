#!/usr/bin/env bun
// scripts/publish/blossom-upload.ts — upload media to Blossom servers (BUD)
//
// Usage: bun scripts/publish/blossom-upload.ts <json>
// Output: { url: string, hash: string, servers: string[] }
//
// NIP-65 write relays come from kind 10050 for the bunker's remoteSignerPubkey; kind
// 10063 is queried for userPubkey. Bunker `relays` are only used for NIP-46 signing.

import { resolve } from 'path';

import { SimplePool } from 'nostr-tools/pool';
import { z } from 'zod';

import { openCoreDb } from '@src/db';
import {
  createBlossomAuthBase64,
  decryptKind15EncryptedBlob,
  downloadUrlToBuffer,
  extractSha256FromUrl,
  fetchBlossomServerUrls,
  mirrorBlobToServer,
  sha256Hex,
  uploadBufferToServer,
} from '@src/nostr/blossom';
import { bunkerSignEvent, type BunkerSignerData } from '@src/nostr/bunker';
import { createConnectionsTable, getConnection } from '@src/nostr/connections';
import { fetchNip65WriteRelays } from '@src/nostr/nip65';

export const schema = z.object({
  bunker: z.string().min(1),
  source: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('file'),
      path: z.string().min(1),
    }),
    z.object({
      type: z.literal('url'),
      url: z.url(),
    }),
    z.object({
      type: z.literal('mirror'),
      url: z.url(),
    }),
    z.object({
      type: z.literal('kind15'),
      url: z.url(),
      decryptionKey: z.string().length(64),
      decryptionNonce: z.string(),
    }),
  ]),
});

export type BlossomUploadInput = z.infer<typeof schema>;

type UploadBytesToAllServersProps = {
  pool: SimplePool;
  bunkerData: BunkerSignerData;
  servers: string[];
  data: Uint8Array;
  contentType: string;
};

async function uploadBytesToAllServers({
  pool,
  bunkerData,
  servers,
  data,
  contentType,
}: UploadBytesToAllServersProps): Promise<{
  hash: string;
  url: string;
  serversOk: string[];
}> {
  const hashHex = await sha256Hex(Uint8Array.from(data));

  const results = await Promise.allSettled(
    servers.map(async (server) => {
      const auth = await createBlossomAuthBase64({
        action: 'upload',
        xTags: [hashHex],
        expirationSeconds: null,
        signEvent: (t) => bunkerSignEvent(pool, bunkerData, t),
      });

      const desc = await uploadBufferToServer(server, data, contentType, auth);

      return { server, desc };
    }),
  );

  const serversOk: string[] = [];
  let url = '';

  for (const r of results) {
    if (r.status === 'fulfilled') {
      serversOk.push(r.value.server);

      if (url === '') {
        url = r.value.desc.url;
      }
    }
  }

  if (serversOk.length === 0) {
    const messages = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) =>
        r.reason instanceof Error ? r.reason.message : String(r.reason),
      );

    throw new Error(
      `All uploads failed: ${messages.length > 0 ? messages.join('; ') : 'unknown'}`,
    );
  }

  return { hash: hashHex, url, serversOk };
}

function guessContentTypeFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();

  if (lower.endsWith('.png')) {
    return 'image/png';
  }

  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg';
  }

  if (lower.endsWith('.gif')) {
    return 'image/gif';
  }

  if (lower.endsWith('.webp')) {
    return 'image/webp';
  }

  if (lower.endsWith('.svg')) {
    return 'image/svg+xml';
  }

  if (lower.endsWith('.avif')) {
    return 'image/avif';
  }

  if (lower.endsWith('.mp4')) {
    return 'video/mp4';
  }

  if (lower.endsWith('.webm')) {
    return 'video/webm';
  }

  return 'application/octet-stream';
}

type MirrorToAllServersProps = {
  pool: SimplePool;
  bunkerData: BunkerSignerData;
  servers: string[];
  sourceUrl: string;
  sha256: string;
};

async function mirrorToAllServers({
  pool,
  bunkerData,
  servers,
  sourceUrl,
  sha256,
}: MirrorToAllServersProps): Promise<{
  hash: string;
  url: string;
  serversOk: string[];
}> {
  const results = await Promise.allSettled(
    servers.map(async (server) => {
      const auth = await createBlossomAuthBase64({
        action: 'upload',
        xTags: [sha256],
        expirationSeconds: null,
        signEvent: (t) => bunkerSignEvent(pool, bunkerData, t),
      });

      const desc = await mirrorBlobToServer(server, sourceUrl, auth);

      return { server, desc };
    }),
  );

  const serversOk: string[] = [];
  let url = '';

  for (const r of results) {
    if (r.status === 'fulfilled') {
      serversOk.push(r.value.server);

      if (url === '') {
        url = r.value.desc.url;
      }
    }
  }

  if (serversOk.length === 0) {
    const messages = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) =>
        r.reason instanceof Error ? r.reason.message : String(r.reason),
      );

    throw new Error(
      `All mirror operations failed: ${messages.length > 0 ? messages.join('; ') : 'unknown'}`,
    );
  }

  return { hash: sha256, url, serversOk };
}

async function runUpload(input: BlossomUploadInput): Promise<void> {
  const db = openCoreDb();
  createConnectionsTable(db);

  const row = getConnection(db, input.bunker);

  if (!row) {
    throw new Error(`Unknown bunker connection: ${input.bunker}`);
  }

  if (row.method !== 'bunker') {
    throw new Error(`Connection "${input.bunker}" is not a bunker connection`);
  }

  const bunkerData = row.data;
  const pool = new SimplePool({ enablePing: true, enableReconnect: true });
  let blossomQueryRelays: string[] = [];

  try {
    blossomQueryRelays = await fetchNip65WriteRelays({
      pool,
      authorPubkey: bunkerData.remoteSignerPubkey,
    });

    const servers = await fetchBlossomServerUrls({
      pool,
      relayUrls: blossomQueryRelays,
      authorPubkey: bunkerData.userPubkey,
    });

    if (servers.length === 0) {
      throw new Error(
        'No Blossom servers found (kind 10063) for this identity. Publish a Blossom server list first.',
      );
    }

    const source = input.source;
    let result: { hash: string; url: string; serversOk: string[] };

    if (source.type === 'file') {
      const path = resolve(source.path);
      const f = Bun.file(path);

      if (!(await f.exists())) {
        throw new Error(`File not found: ${path}`);
      }

      const buf = new Uint8Array(await f.arrayBuffer());

      const contentType =
        f.type && f.type.length > 0 ? f.type : guessContentTypeFromPath(path);

      result = await uploadBytesToAllServers({
        pool,
        bunkerData,
        servers,
        data: buf,
        contentType,
      });
    } else if (source.type === 'url') {
      const { data, contentType } = await downloadUrlToBuffer(source.url);

      result = await uploadBytesToAllServers({
        pool,
        bunkerData,
        servers,
        data,
        contentType,
      });
    } else if (source.type === 'mirror') {
      const sha256 = extractSha256FromUrl(source.url);

      if (!sha256) {
        throw new Error(
          'mirror: could not extract sha256 from URL (expected 64 hex chars in path)',
        );
      }

      result = await mirrorToAllServers({
        pool,
        bunkerData,
        servers,
        sourceUrl: source.url,
        sha256,
      });
    } else {
      const { data: cipher } = await downloadUrlToBuffer(source.url);

      const plain = decryptKind15EncryptedBlob(
        cipher,
        source.decryptionKey,
        source.decryptionNonce,
      );

      result = await uploadBytesToAllServers({
        pool,
        bunkerData,
        servers,
        data: plain,
        contentType: 'application/octet-stream',
      });
    }

    console.log(
      JSON.stringify({
        url: result.url,
        hash: result.hash,
        servers: result.serversOk,
      }),
    );
  } finally {
    pool.close([...new Set([...bunkerData.relays, ...blossomQueryRelays])]);
  }
}

async function main(): Promise<void> {
  const json = process.argv[2];

  if (json === undefined || json === '') {
    console.error('Usage: bun scripts/publish/blossom-upload.ts <json>');
    process.exit(1);
  }

  let data: unknown;

  try {
    data = JSON.parse(json);
  } catch {
    console.error('Invalid JSON');
    process.exit(1);
  }

  const parsed = schema.safeParse(data);

  if (!parsed.success) {
    console.error(parsed.error.flatten());
    process.exit(1);
  }

  try {
    await runUpload(parsed.data);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (import.meta.main) {
  void main();
}
