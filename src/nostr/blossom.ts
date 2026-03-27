// ---------------------------------------------------------------------------
// src/nostr/blossom.ts — Blossom (BUD) helpers: kind 10063 server list, auth
// (kind 24242), upload / mirror / delete HTTP.
// ---------------------------------------------------------------------------

import { chacha20poly1305, xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import type { Event, EventTemplate, VerifiedEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools';
import type { SimplePool } from 'nostr-tools/pool';
import { hexToBytes } from 'nostr-tools/utils';

/** Nostr event listing Blossom blob server endpoints for an author (BUD). */
export const BLOSSOM_SERVERS_KIND = 10063;

// ---------------------------------------------------------------------------
// Kind 10063 — server list
// ---------------------------------------------------------------------------

export function parseBlossomServerUrlsFromEvent(event: Event): string[] {
  return event.tags
    .filter(
      (t): t is [string, string] =>
        t[0] === 'server' && typeof t[1] === 'string',
    )
    .map((t) => t[1]);
}

type FetchBlossomServersEventProps = {
  pool: SimplePool;
  relayUrls: string[];
  authorPubkey: string;
};

/** Latest kind:10063 from `authorPubkey`. */
export async function fetchBlossomServersEvent({
  pool,
  relayUrls,
  authorPubkey,
}: FetchBlossomServersEventProps): Promise<Event | null> {
  return pool.get(relayUrls, {
    authors: [authorPubkey],
    kinds: [BLOSSOM_SERVERS_KIND],
  });
}

type FetchBlossomServerUrlsProps = {
  pool: SimplePool;
  relayUrls: string[];
  authorPubkey: string;
};

export async function fetchBlossomServerUrls({
  pool,
  relayUrls,
  authorPubkey,
}: FetchBlossomServerUrlsProps): Promise<string[]> {
  const ev = await fetchBlossomServersEvent({ pool, relayUrls, authorPubkey });

  if (!ev) {
    return [];
  }

  return parseBlossomServerUrlsFromEvent(ev);
}

// ---------------------------------------------------------------------------
// Hash + URL helpers
// ---------------------------------------------------------------------------

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', copy);
  const hashArray = Array.from(new Uint8Array(hashBuffer));

  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Extract sha256 from URL (last 64-char hex segment per BUD-03). */
export function extractSha256FromUrl(url: string): string | null {
  const matches = url.match(/[a-f0-9]{64}/gi);

  return matches ? matches[matches.length - 1] : null;
}

export function normalizeBlossomServerUrl(server: string): string {
  return server.endsWith('/') ? server.slice(0, -1) : server;
}

// ---------------------------------------------------------------------------
// Kind 24242 — Blossom HTTP auth (Authorization: Nostr <base64>)
// ---------------------------------------------------------------------------

/** Sign an `EventTemplate` (e.g. bunker `sign_event`, or `finalizeEvent` with a local key). */
export type BlossomSignEventFn = (
  template: EventTemplate,
) => Promise<VerifiedEvent>;

type BuildBlossomAuthEventTemplateProps = {
  action: 'get' | 'upload' | 'list' | 'delete';
  xTags: string[] | null;
  expirationSeconds: number | null;
};

/** Unsigned kind 24242 template; sign via `BlossomSignEventFn` or `signEventWithSecretKeyHex`. */
export function buildBlossomAuthEventTemplate({
  action,
  xTags,
  expirationSeconds,
}: BuildBlossomAuthEventTemplateProps): EventTemplate {
  const nowSeconds = Math.floor(Date.now() / 1000);

  const exp = expirationSeconds === null ? 60 * 60 * 24 : expirationSeconds;

  const tags: string[][] = [
    ['t', action],
    ['expiration', String(nowSeconds + exp)],
  ];

  if (xTags !== null && xTags.length > 0) {
    for (const x of xTags) {
      tags.push(['x', x]);
    }
  }

  return {
    kind: 24242,
    created_at: nowSeconds,
    content: `${action} Blob`,
    tags,
  };
}

type CreateBlossomAuthBase64Props = {
  action: 'get' | 'upload' | 'list' | 'delete';
  xTags: string[] | null;
  expirationSeconds: number | null;
  signEvent: BlossomSignEventFn;
};

/** Build kind 24242, sign with `signEvent`, return `Authorization: Nostr …` payload (base64 JSON). */
export async function createBlossomAuthBase64({
  action,
  xTags,
  expirationSeconds,
  signEvent,
}: CreateBlossomAuthBase64Props): Promise<string> {
  const template = buildBlossomAuthEventTemplate({
    action,
    xTags,
    expirationSeconds,
  });

  const signedEvent = await signEvent(template);

  return Buffer.from(JSON.stringify(signedEvent)).toString('base64');
}

/** Adapter when the secret key is available locally (no bunker). */
export function signEventWithSecretKeyHex(
  secretKeyHex: string,
): BlossomSignEventFn {
  const sk = hexToBytes(secretKeyHex);

  return (template) => Promise.resolve(finalizeEvent(template, sk));
}

// ---------------------------------------------------------------------------
// Blob descriptor (BUD upload/mirror response)
// ---------------------------------------------------------------------------

export type BlossomBlobDescriptor = {
  url: string;
  sha256: string;
  size: number;
  type?: string;
  uploaded?: number;
};

// ---------------------------------------------------------------------------
// HTTP: upload / mirror / download / delete
// ---------------------------------------------------------------------------

export async function uploadBufferToServer(
  server: string,
  data: Uint8Array,
  contentType: string,
  authBase64: string,
): Promise<BlossomBlobDescriptor> {
  const serverUrl = normalizeBlossomServerUrl(server);

  const body = Uint8Array.from(data);

  const response = await fetch(`${serverUrl}/upload`, {
    method: 'PUT',
    headers: {
      Authorization: `Nostr ${authBase64}`,
      'Content-Type': contentType,
      'Content-Length': String(body.length),
    },
    body,
  });

  if (!response.ok) {
    const reason = response.headers.get('X-Reason') || response.statusText;

    throw new Error(`Upload failed on ${server}: ${response.status} ${reason}`);
  }

  return (await response.json()) as BlossomBlobDescriptor;
}

export async function mirrorBlobToServer(
  server: string,
  sourceUrl: string,
  authBase64: string,
): Promise<BlossomBlobDescriptor> {
  const serverUrl = normalizeBlossomServerUrl(server);

  const response = await fetch(`${serverUrl}/mirror`, {
    method: 'PUT',
    headers: {
      Authorization: `Nostr ${authBase64}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: sourceUrl }),
  });

  if (!response.ok) {
    const reason = response.headers.get('X-Reason') || response.statusText;

    throw new Error(`Mirror failed on ${server}: ${response.status} ${reason}`);
  }

  return (await response.json()) as BlossomBlobDescriptor;
}

type DownloadUrlToBufferResult = {
  data: Uint8Array;
  contentType: string;
};

export async function downloadUrlToBuffer(
  url: string,
): Promise<DownloadUrlToBufferResult> {
  const res = await fetch(url, { headers: { 'Accept-Encoding': 'identity' } });

  if (!res.ok) {
    const reason = res.statusText || 'Download failed';

    throw new Error(`${res.status} ${reason}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const data = new Uint8Array(arrayBuffer);

  const contentType =
    res.headers.get('content-type') || 'application/octet-stream';

  return { data, contentType };
}

/**
 * Decrypt a ciphertext blob from a kind 15 / encrypted-file style payload.
 * Nonce must be hex: 12 bytes (ChaCha20-Poly1305) or 24 bytes (XChaCha20-Poly1305).
 */
export function decryptKind15EncryptedBlob(
  ciphertext: Uint8Array,
  keyHex64: string,
  nonceHex: string,
): Uint8Array {
  const key = hexToBytes(keyHex64);

  if (key.length !== 32) {
    throw new Error('decryptionKey must be 64 hex chars (32 bytes)');
  }

  const nonceNorm = nonceHex.trim();

  if (!/^[0-9a-fA-F]+$/.test(nonceNorm) || nonceNorm.length % 2 !== 0) {
    throw new Error('decryptionNonce must be hex-encoded bytes');
  }

  const nonce = hexToBytes(nonceNorm);

  if (nonce.length === 24) {
    return xchacha20poly1305(key, nonce).decrypt(ciphertext);
  }

  if (nonce.length === 12) {
    return chacha20poly1305(key, nonce).decrypt(ciphertext);
  }

  throw new Error(
    `Unsupported nonce length ${nonce.length} bytes (expected 12 or 24)`,
  );
}

export type DeleteBlobFromServerResult = {
  success: boolean;
  status: number;
  message: string;
};

export async function deleteBlobFromServer(
  server: string,
  sha256: string,
  authBase64: string,
): Promise<DeleteBlobFromServerResult> {
  const serverUrl = normalizeBlossomServerUrl(server);

  const response = await fetch(`${serverUrl}/${sha256}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Nostr ${authBase64}`,
    },
  });

  const reason = response.headers.get('X-Reason') || response.statusText;

  return {
    success: response.ok,
    status: response.status,
    message: response.ok
      ? 'Deleted successfully'
      : `${response.status} ${reason}`,
  };
}
