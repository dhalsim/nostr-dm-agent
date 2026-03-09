// ---------------------------------------------------------------------------
// file-sync.ts — !file upload / !file download implementation
// ---------------------------------------------------------------------------

import { readFile, writeFile, access } from 'fs/promises';
import { basename, resolve } from 'path';

import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent, getPublicKey, nip19, nip44, SimplePool } from 'nostr-tools';

import type { BotConfig } from './env';

const BLOSSOM_URL = 'https://blossom-01.uid.ovh/';
const FILE_KIND = 34343;

// ---------------------------------------------------------------------------
// Blossom helpers
// ---------------------------------------------------------------------------

function buildBlossomAuth(
  privkey: Uint8Array,
  verb: 'upload' | 'get' | 'delete',
  blobSha256?: string,
): string {
  const tags: string[][] = [
    ['t', verb],
    ['expiration', String(Math.floor(Date.now() / 1000) + 300)],
  ];

  if (blobSha256) {
    tags.push(['x', blobSha256]);
  }

  const event = finalizeEvent(
    {
      kind: 24242,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: verb,
    },
    privkey,
  );

  return 'Nostr ' + btoa(JSON.stringify(event));
}

async function blossomUpload(
  privkey: Uint8Array,
  blob: Uint8Array,
): Promise<{ url: string; sha256: string }> {
  const hash = bytesToHex(sha256(blob));
  const auth = buildBlossomAuth(privkey, 'upload', hash);

  const res = await fetch(`${BLOSSOM_URL}/upload`, {
    method: 'PUT',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/octet-stream',
      'X-SHA-256': hash,
    },
    body: blob as unknown as BodyInit,
  });

  if (!res.ok) {
    const reason = res.headers.get('X-Reason') ?? res.statusText;

    throw new Error(`Blossom upload failed ${res.status}: ${reason}`);
  }

  const descriptor = (await res.json()) as { url: string; sha256: string };

  return { url: descriptor.url, sha256: descriptor.sha256 };
}

async function blossomDownload(privkey: Uint8Array, url: string): Promise<Uint8Array> {
  const sha256Hash = url.split('/').pop()!.split('.')[0];
  const auth = buildBlossomAuth(privkey, 'get', sha256Hash);

  const res = await fetch(url, {
    headers: { Authorization: auth },
  });

  if (!res.ok) {
    throw new Error(`Blossom download failed ${res.status}: ${url}`);
  }

  return new Uint8Array(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

type FileUploadProps = {
  filePath: string;
  recipientNpub: string;
  config: BotConfig;
};

export type FileUploadResult = { filename: string; naddr: string; skipped: boolean };

function buildFileNaddr(pubkey: string, filename: string, relays: string[]): string {
  return nip19.naddrEncode({
    kind: FILE_KIND,
    pubkey,
    identifier: filename,
    relays: relays.slice(0, 3),
  });
}

export async function fileUpload({
  filePath,
  recipientNpub,
  config,
}: FileUploadProps): Promise<FileUploadResult> {
  // 1. Decode recipient npub
  const decoded = nip19.decode(recipientNpub);

  if (decoded.type !== 'npub') {
    throw new Error(`Expected npub, got: ${decoded.type}`);
  }

  const recipientPubkeyHex = decoded.data as string;

  // 2. Read file
  const fileBytes = new Uint8Array(await readFile(filePath));
  const filename = basename(filePath);

  // 3. Plaintext hash
  const plaintextHash = bytesToHex(sha256(fileBytes));

  // 4. Fetch existing event for conflict check
  const privkeyBytes = hexToBytes(config.botKeyHex);
  const botPubkey = getPublicKey(privkeyBytes);
  const pool = new SimplePool();
  const relays = config.relayUrls;

  let prevHash: string | undefined;

  try {
    const existing = await pool.get(relays, {
      kinds: [FILE_KIND],
      authors: [botPubkey],
      '#d': [filename],
      limit: 1,
    });

    if (existing) {
      const remoteHash = existing.tags.find((t) => t[0] === 'hash')?.[1];

      if (remoteHash === plaintextHash) {
        console.log(`[file-sync] File unchanged (hash matches remote). Nothing to upload.`);
        pool.close(relays);

        const naddr = buildFileNaddr(botPubkey, filename, relays);

        return { filename, naddr, skipped: true };
      }

      if (remoteHash) {
        console.warn(
          `[file-sync] Warning: Remote version differs from your local base.\n` +
            `  Remote hash: ${remoteHash}\n` +
            `  Uploading anyway, setting prev=${remoteHash}`,
        );

        prevHash = remoteHash;
      }
    }
  } catch (err) {
    console.warn(`[file-sync] Could not fetch existing event (proceeding): ${String(err)}`);
  }

  // 5-8. Encrypt file with AES-256-GCM
  const aesKey = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = gcm(aesKey, nonce);
  const encryptedBody = cipher.encrypt(fileBytes);

  // Wire format: nonce[12] || ciphertext+mac
  const blob = new Uint8Array(12 + encryptedBody.length);

  blob.set(nonce, 0);
  blob.set(encryptedBody, 12);

  const ciphertextHash = bytesToHex(sha256(blob));

  // 9. Upload to Blossom
  console.log(`[file-sync] Uploading to Blossom...`);
  const { url: blossomUrl } = await blossomUpload(privkeyBytes, blob);

  // 10-11. Encrypt AES key with NIP-44
  const conversationKey = nip44.v2.utils.getConversationKey(privkeyBytes, recipientPubkeyHex);
  const aesKeyHex = bytesToHex(aesKey);
  const encryptedKey = nip44.v2.encrypt(aesKeyHex, conversationKey);

  // 12. Publish kind:34343 event
  const tags: string[][] = [
    ['d', filename],
    ['url', blossomUrl],
    ['x', ciphertextHash],
    ['hash', plaintextHash],
    ...(prevHash ? [['prev', prevHash]] : []),
    ['p', recipientPubkeyHex],
  ];

  const event = finalizeEvent(
    {
      kind: FILE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: encryptedKey,
    },
    privkeyBytes,
  );

  console.log(`[file-sync] Publishing Nostr event...`);
  await Promise.allSettled(pool.publish(relays, event));
  pool.close(relays);

  const naddr = buildFileNaddr(botPubkey, filename, relays);
  console.log(`[file-sync] Upload complete: ${filename}`);
  console.log(`naddr: ${naddr}`);

  return { filename, naddr, skipped: false };
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

type FileDownloadProps = {
  naddr: string;
  config: BotConfig;
  filePath: string;
};

export type FileDownloadResult = { filename: string; path: string; skipped: boolean };

export async function fileDownload(opts: FileDownloadProps): Promise<FileDownloadResult> {
  const { naddr, config, filePath } = opts;

  // 1. Decode naddr
  const decoded = nip19.decode(naddr);

  if (decoded.type !== 'naddr') {
    throw new Error(`Expected naddr, got: ${decoded.type}`);
  }

  const { kind, pubkey: senderPubkeyHex, identifier: filename, relays: hintRelays } = decoded.data;

  if (kind !== FILE_KIND) {
    throw new Error(`Expected kind ${FILE_KIND}, got: ${kind}`);
  }

  // 2. Fetch event
  const privkeyBytes = hexToBytes(config.botKeyHex);
  const pool = new SimplePool();
  const allRelays = [...(hintRelays ?? []), ...config.relayUrls];
  const uniqueRelays = [...new Set(allRelays)];

  const event = await pool.get(uniqueRelays, {
    kinds: [FILE_KIND],
    authors: [senderPubkeyHex],
    '#d': [filename],
    limit: 1,
  });

  pool.close(uniqueRelays);

  if (!event) {
    throw new Error(`No event found for file: ${filename}`);
  }

  // 3. Extract tags
  const url = event.tags.find((t) => t[0] === 'url')?.[1];
  const ciphertextHashTag = event.tags.find((t) => t[0] === 'x')?.[1];
  const plaintextHashTag = event.tags.find((t) => t[0] === 'hash')?.[1];
  const prevTag = event.tags.find((t) => t[0] === 'prev')?.[1];

  if (!url) {
    throw new Error('Event missing url tag');
  }

  if (!ciphertextHashTag) {
    throw new Error('Event missing x tag');
  }

  if (!plaintextHashTag) {
    throw new Error('Event missing hash tag');
  }

  // 4. Conflict check against local file
  const outputPath = resolve(filePath, filename);
  const incomingPath = `${outputPath}.incoming`;

  let skipWrite = false;
  let writeToIncoming = false;

  try {
    await access(outputPath);
    // File exists — read and check
    const existingBytes = new Uint8Array(await readFile(outputPath));
    const localFileHash = bytesToHex(sha256(existingBytes));

    if (localFileHash === plaintextHashTag) {
      console.log(`[file-sync] File is already up to date: ${filename}`);
      skipWrite = true;
    } else if (!prevTag) {
      // First upload of this file — overwrite safely
      console.log(`[file-sync] First upload of ${filename}, overwriting local copy.`);
    } else if (localFileHash === prevTag) {
      // Clean fast-forward
      console.log(`[file-sync] Clean fast-forward, overwriting: ${filename}`);
    } else {
      // Conflict
      console.warn(
        `[file-sync] Conflict detected. Local file diverged from uploader's base.\n` +
          `  Remote saved as: ${filename}.incoming\n` +
          `  Resolve manually.`,
      );

      writeToIncoming = true;
    }
  } catch {
    // File does not exist — clean download
  }

  if (skipWrite) {
    return { filename, path: outputPath, skipped: true };
  }

  // 5. Download blob
  console.log(`[file-sync] Downloading blob from Blossom...`);
  const blob = await blossomDownload(privkeyBytes, url);

  // 6. Verify ciphertext hash
  const actualHash = bytesToHex(sha256(blob));

  if (actualHash !== ciphertextHashTag) {
    throw new Error(
      `Blob integrity check failed. Expected: ${ciphertextHashTag}, got: ${actualHash}`,
    );
  }

  // 7-9. Decrypt AES key with NIP-44
  const conversationKey = nip44.v2.utils.getConversationKey(privkeyBytes, senderPubkeyHex);
  const aesKeyHex = nip44.v2.decrypt(event.content, conversationKey);
  const aesKey = hexToBytes(aesKeyHex);

  // 10-12. Decrypt file
  const nonce = blob.slice(0, 12);
  const ciphertext = blob.slice(12);
  const fileBytes = gcm(aesKey, nonce).decrypt(ciphertext);

  // 13. Write file
  const targetPath = writeToIncoming ? incomingPath : outputPath;

  await writeFile(targetPath, fileBytes);

  console.log(`[file-sync] Download complete: ${targetPath}`);

  return { filename, path: targetPath, skipped: false };
}
