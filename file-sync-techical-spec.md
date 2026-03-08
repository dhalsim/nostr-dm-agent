# File Sync Feature — Technical Specification
## `!file upload` / `!file download` for nostr-dm-agent

This document is addressed to an AI agent that already has full knowledge of the
`nostr-dm-agent` codebase. It describes every decision, data structure, and
integration point needed to implement the file sync feature from scratch.

---

## 1. Overview

The feature adds two new bang commands to the bot:

```
!file upload <file_full_path> <npub_bot_b>
!file download <naddr>
```

**Upload** (Bot A): encrypts a local file and publishes a pointer to it on Nostr.  
**Download** (Bot B): resolves the pointer, downloads the ciphertext, and decrypts it.

The design uses **hybrid encryption** — AES-256-GCM for the file body (no size limit)
and **NIP-44** for the tiny AES key (encrypts it to the recipient bot's public key).
File metadata lives in a custom Nostr **addressable event** (kind `34343`), which gives
natural update-in-place semantics: re-uploading the same filename replaces the pointer
without changing the Nostr address. The Blossom server `https://24242.io` is used
hardcoded for blob storage.

---

## 2. New dependencies

Add to `package.json`:

```json
"@noble/ciphers": "^1.x"
```

`@noble/ciphers` provides AES-256-GCM. Everything else (`nostr-tools`, `@noble/hashes`,
`@noble/curves`) is already present in the repo.

No new environment variables are required beyond what already exists.

---

## 3. Environment variables (existing, read by this feature)

| Variable | Used for |
|---|---|
| `BOT_KEY` | Signs Nostr events; provides the sender's private key for NIP-44 ECDH |
| `BOT_RELAYS` | Comma-separated relay URLs for publishing and fetching events |

The recipient's public key is **not** stored in `.env` — it is passed at the command
line each time (`<npub_bot_b>` on upload, embedded in `<naddr>` on download).

---

## 4. Nostr event — kind `34343`

### Why this kind

`34343` is a custom, unclaimed kind in the parameterized replaceable range
(30000–39999). Being in this range means the event is **addressable** by the triple
`(pubkey, kind, d-tag)`, so publishing a new event with the same `d` tag silently
replaces the old one on relays. There is no published NIP for `34343`; it is
intentionally app-specific.

### Event structure

```jsonc
{
  "kind": 34343,
  "pubkey": "<bot_a_pubkey_hex>",
  "created_at": 1700000000,
  "tags": [
    ["d",    "<filename>"],                  // e.g. "project-b.md" — the addressable key
    ["url",  "https://24242.io/<sha256>"],   // Blossom URL of the ciphertext blob
    ["x",    "<sha256_of_ciphertext_hex>"],  // SHA-256 of the encrypted bytes on Blossom
    ["hash", "<sha256_of_plaintext_hex>"],   // SHA-256 of the raw file bytes (for conflict detection)
    ["prev", "<sha256_of_plaintext_hex>"],   // hash of the version this was based on (omitted on first upload)
    ["p",    "<bot_b_pubkey_hex>"]           // intended recipient
  ],
  // content = NIP-44 ciphertext of the AES-256-GCM key (hex-encoded, 64 chars plaintext)
  "content": "<nip44_ciphertext>",
  "id": "...",
  "sig": "..."
}
```

### Tag semantics

- **`d`** — the filename (basename only, no path). This is the stable identifier across
  all versions of the file.
- **`url`** — full URL to the encrypted blob on `24242.io`. Changes on every upload
  because Blossom addresses blobs by their SHA-256 hash and the ciphertext changes each
  time (due to the random AES nonce).
- **`x`** — SHA-256 hex of the **ciphertext** bytes stored on Blossom. Used to verify
  the download is intact.
- **`hash`** — SHA-256 hex of the **plaintext** file bytes. Stable for a given file
  version; used for conflict detection (see section 8).
- **`prev`** — SHA-256 hex of the plaintext of the version this upload was based on.
  Omitted on the very first upload of a file. Used by the downloader to detect whether
  its local copy diverged (conflict).
- **`p`** — hex public key of the intended recipient bot. Included so that the recipient
  can efficiently subscribe with a `#p` filter in a future watch/notify feature.

### `content` field

The `content` field holds the NIP-44 ciphertext of a 64-character hex string — the
AES-256-GCM key. Plaintext before encryption:

```
"<32 random bytes as lowercase hex>"   // 64 chars
```

NIP-44 encryption uses `ECDH(BOT_KEY_A, bot_b_pubkey)` as the conversation key.

---

## 5. Encryption scheme — step by step

### 5.1 AES-256-GCM (file body)

Using `@noble/ciphers`:

```typescript
import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/ciphers/webcrypto';

// Encrypt
const aesKey = randomBytes(32);          // 32 random bytes
const nonce  = randomBytes(12);          // 12-byte nonce for GCM
const cipher = gcm(aesKey, nonce);
const ciphertext = cipher.encrypt(plainFileBytes);
// Wire format written to disk / uploaded to Blossom:
// nonce[12] || ciphertext+mac[N+16]
// (@noble/ciphers appends the 16-byte GCM tag to ciphertext automatically)
const blob = new Uint8Array(12 + ciphertext.length);
blob.set(nonce, 0);
blob.set(ciphertext, 12);

// Decrypt
const nonce2      = blob.slice(0, 12);
const ciphertext2 = blob.slice(12);           // includes the 16-byte GCM tag
const plain = gcm(aesKey, nonce2).decrypt(ciphertext2);
```

This wire format is identical to Manent's `FileCrypto` class (`nonce[12] || ciphertext || mac[16]`).

### 5.2 NIP-44 (AES key)

Using `nostr-tools` (already imported throughout the codebase):

```typescript
import { nip44, getPublicKey } from 'nostr-tools';

// Sender side (Bot A)
const conversationKey = nip44.v2.utils.getConversationKey(
  botKeyHex,          // BOT_KEY as hex string
  recipientPubkeyHex  // bot_b pubkey as hex
);
const encryptedKey = nip44.v2.encrypt(aesKeyHex, conversationKey);

// Recipient side (Bot B)
// senderPubkey comes from the Nostr event's `pubkey` field
const conversationKey = nip44.v2.utils.getConversationKey(
  botKeyHex,       // BOT_KEY of Bot B as hex
  senderPubkeyHex  // event.pubkey
);
const aesKeyHex = nip44.v2.decrypt(event.content, conversationKey);
```

NIP-44 ECDH is symmetric: `conv(privA, pubB) === conv(privB, pubA)`, so no secret
is shared. Each bot only needs the other's **public** key.

---

## 6. Blossom integration (`https://24242.io`)

### 6.1 Authorization — kind `24242`

Every Blossom request that mutates state requires an authorization event. This is a
regular signed Nostr event passed in the `Authorization` HTTP header as
`Nostr <base64(JSON.stringify(event))>`.

```typescript
import { finalizeEvent } from 'nostr-tools';

function buildBlossomAuth(
  privkey: Uint8Array,
  verb: 'upload' | 'get' | 'delete',
  blobSha256?: string   // required for upload and delete
): string {
  const tags: string[][] = [
    ['t', verb],
    ['expiration', String(Math.floor(Date.now() / 1000) + 300)], // 5 min
  ];
  if (blobSha256) tags.push(['x', blobSha256]);

  const event = finalizeEvent({
    kind: 24242,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: verb,
  }, privkey);

  return 'Nostr ' + btoa(JSON.stringify(event));
}
```

### 6.2 Upload (`PUT /upload`)

```typescript
async function blossomUpload(
  privkey: Uint8Array,
  blob: Uint8Array
): Promise<{ url: string; sha256: string }> {
  // Compute SHA-256 of the blob before uploading
  const { sha256 } from '@noble/hashes/sha256';
  const { bytesToHex } from '@noble/hashes/utils';
  const hash = bytesToHex(sha256(blob));

  const auth = buildBlossomAuth(privkey, 'upload', hash);

  const res = await fetch('https://24242.io/upload', {
    method: 'PUT',
    headers: {
      'Authorization': auth,
      'Content-Type': 'application/octet-stream',
      'X-SHA-256': hash,
    },
    body: blob,
  });

  if (!res.ok) {
    const reason = res.headers.get('X-Reason') ?? res.statusText;
    throw new Error(`Blossom upload failed ${res.status}: ${reason}`);
  }

  const descriptor = await res.json();
  // descriptor: { url, sha256, size, type, ... }
  return { url: descriptor.url, sha256: descriptor.sha256 };
}
```

### 6.3 Download (`GET /<sha256>`)

```typescript
async function blossomDownload(
  privkey: Uint8Array,
  url: string
): Promise<Uint8Array> {
  const sha256 = url.split('/').pop()!.split('.')[0];
  const auth = buildBlossomAuth(privkey, 'get', sha256);

  const res = await fetch(url, {
    headers: { 'Authorization': auth },
  });

  if (!res.ok) throw new Error(`Blossom download failed ${res.status}: ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}
```

---

## 7. Nostr relay interaction

### 7.1 Publishing (upload)

```typescript
import { SimplePool, finalizeEvent } from 'nostr-tools';

const pool = new SimplePool();
const event = finalizeEvent({
  kind: 34343,
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ['d',    filename],
    ['url',  blossomUrl],
    ['x',    ciphertextSha256],
    ['hash', plaintextSha256],
    ...(prevHash ? [['prev', prevHash]] : []),
    ['p',    recipientPubkeyHex],
  ],
  content: encryptedAesKey,   // NIP-44 ciphertext
}, privkey);

await Promise.allSettled(pool.publish(relays, event));
pool.close(relays);
```

### 7.2 Fetching the latest event for conflict check (before upload)

```typescript
async function fetchLatestFileEvent(
  pool: SimplePool,
  relays: string[],
  authorPubkey: string,
  filename: string
): Promise<Event | null> {
  return new Promise(resolve => {
    let latest: Event | null = null;
    const sub = pool.subscribeMany(relays, [{
      kinds: [34343],
      authors: [authorPubkey],
      '#d': [filename],
      limit: 1,
    }], {
      onevent(e) {
        if (!latest || e.created_at > latest.created_at) latest = e;
      },
      oneose() { sub.close(); resolve(latest); },
    });
    setTimeout(() => { sub.close(); resolve(latest); }, 8000);
  });
}
```

### 7.3 Fetching by naddr (download)

```typescript
import { nip19 } from 'nostr-tools';

// Decode naddr
const decoded = nip19.decode(naddrString);
if (decoded.type !== 'naddr') throw new Error('Expected naddr');
const { kind, pubkey, identifier, relays: hintRelays } = decoded.data;

// Fetch
const event = await fetchLatestFileEvent(
  pool,
  [...(hintRelays ?? []), ...configuredRelays],
  pubkey,
  identifier   // this is the `d` tag value = filename
);
```

### 7.4 Encoding naddr (after upload)

```typescript
import { nip19 } from 'nostr-tools';

const naddr = nip19.naddrEncode({
  kind: 34343,
  pubkey: getPublicKey(botKey),
  identifier: filename,          // value of the `d` tag
  relays: relays.slice(0, 3),    // include up to 3 relay hints
});

console.log(`\nnaddr: ${naddr}`);
```

---

## 8. Conflict detection

Conflict detection is stateless — all necessary information is encoded in the Nostr
event tags.

### SHA-256 of plaintext

Both `hash` and `prev` tags store the SHA-256 of the **raw plaintext file bytes**
(before AES encryption). This value is stable across uploads of the same content,
unlike the ciphertext SHA-256 which changes every time due to the random AES nonce.

```typescript
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const plaintextHash = bytesToHex(sha256(fileBytes));
```

### Upload conflict check

Before publishing a new event, fetch the current latest event for the same filename
authored by the same bot. Then:

```
localFileHash   = sha256(fileBytes to be uploaded)
remoteHash      = event.tags.find(t => t[0] === 'hash')?.[1]

if remoteHash is undefined:
  → first upload, set no `prev` tag

if remoteHash === localFileHash:
  → no change, nothing to upload (warn user: "file unchanged")

if remoteHash !== localFileHash:
  → check if the user's file descends from remoteHash
    localPrevHash = sha256(local file before user's edits)   // not available at CLI level
  → simplification: always treat as a potential conflict
  → warn user: "Remote version differs from your local base.
                Remote hash: <remoteHash>
                Uploading anyway, setting prev=<remoteHash>"
  → upload, set `prev = remoteHash`
```

In the simple CLI case, we always set `prev` to whatever the current `hash` tag on the
remote event is. The warning is enough to alert the user.

### Download conflict check

After fetching the event but before writing the file to disk, check whether a local
copy already exists:

```
localFileHash  = sha256(existing local file bytes)   // if file exists
eventPrev      = event.tags.find(t => t[0] === 'prev')?.[1]
eventHash      = event.tags.find(t => t[0] === 'hash')?.[1]

if local file does not exist:
  → clean download, proceed

if localFileHash === eventHash:
  → file is identical, nothing to do (inform user)

if eventPrev exists and localFileHash === eventPrev:
  → local file is the base the uploader worked from — clean fast-forward, overwrite

if eventPrev exists and localFileHash !== eventPrev:
  → CONFLICT: local file diverged from the uploader's base
  → do NOT overwrite; save download as "<filename>.incoming"
  → warn user: "Conflict detected. Remote saved as <filename>.incoming. Resolve manually."

if eventPrev is absent:
  → first upload of this file; overwrite safely
```

---

## 9. File layout

Create a single new file:

```
src/file-sync.ts
```

It exports two async functions called by the command handler:

```typescript
export async function fileUpload(
  filePath: string,
  recipientNpub: string,
  config: BotConfig               // the existing BotConfig type from src/env.ts
): Promise<void>

export async function fileDownload(
  naddr: string,
  config: BotConfig
): Promise<void>
```

---

## 10. Integration into the existing command handler

The existing command handler lives in `src/commands.ts` inside `handleBangCommand`.
Add a new branch for the `file` subcommand:

```typescript
// Inside handleBangCommand, alongside existing cases:

if (command === 'file') {
  const [subcommand, ...rest] = args;   // args = tokens after "!file"

  if (subcommand === 'upload') {
    const [filePath, recipientNpub] = rest;
    if (!filePath || !recipientNpub) {
      return '!file upload <file_full_path> <npub_bot_b>';
    }
    await fileUpload(filePath, recipientNpub, config);
    return;  // fileUpload prints its own output via sendDm / console
  }

  if (subcommand === 'download') {
    const [naddr] = rest;
    if (!naddr) {
      return '!file download <naddr>';
    }
    await fileDownload(naddr, config);
    return;
  }

  return '!file <upload|download>';
}
```

The `config` object already holds `BOT_KEY` and `BOT_RELAYS` — no new config fields
are needed.

---

## 11. Output directory for downloads

Downloaded files are written to the **parent workspace root** — one directory above the
`dm-bot` directory. This is the same convention used by the rest of the bot (the agent
also operates on the parent project). Derive it with:

```typescript
import { resolve } from 'path';

const workspaceRoot = resolve(import.meta.dir, '..', '..');
// import.meta.dir = <project>/dm-bot/src
// resolve('../..') = <project>
const outputPath = resolve(workspaceRoot, filename);
```

For conflict cases, write the incoming file as `<outputPath>.incoming` instead of
overwriting.

---

## 12. Help text

Add `!file` to the `!help` command output:

```
!file upload <path> <npub>   Encrypt and share a file with another bot
!file download <naddr>       Download and decrypt a file shared with this bot
```

---

## 13. Side note — future notify-on-update feature

The `["p", "<bot_b_pubkey_hex>"]` tag is already present in the event structure above.
When a notify feature is desired later, Bot B can open a persistent Nostr subscription:

```typescript
pool.subscribeMany(relays, [{
  kinds: [34343],
  '#p': [botBPubkeyHex],
}], {
  onevent(event) {
    // A new or updated file was shared with this bot.
    // Run conflict check before deciding whether to auto-apply or alert.
    notifyUser(event);
  }
});
```

This is intentionally **not** auto-download — the bot notifies the user that a new
version is available, then the user runs `!file download <naddr>` manually. This
preserves the conflict-detection step and keeps the user in control, since the remote
bot may have modified the file independently in the meantime.

No schema changes are needed to support this — the `p` tag and `hash`/`prev` tags
already carry everything required.

---

## 14. Complete upload flow summary

```
!file upload ./notes/project-b.md npub1abc...

1. Decode npub1abc... → recipientPubkeyHex
2. Read ./notes/project-b.md → fileBytes
3. plaintextHash = sha256(fileBytes)
4. Fetch existing kind:34343 event (same author + d=project-b.md) → check conflict
5. aesKey = randomBytes(32)
6. nonce  = randomBytes(12)
7. blob   = nonce || gcm(aesKey, nonce).encrypt(fileBytes)
8. ciphertextHash = sha256(blob)
9. PUT https://24242.io/upload blob → { url, sha256 }
10. conversationKey = nip44.getConversationKey(BOT_KEY, recipientPubkeyHex)
11. encryptedKey = nip44.encrypt(bytesToHex(aesKey), conversationKey)
12. Publish kind:34343 event (tags: d, url, x, hash, prev?, p; content: encryptedKey)
13. naddr = nip19.naddrEncode({ kind: 34343, pubkey, identifier: 'project-b.md', relays })
14. Print naddr to terminal / send as DM reply
```

## 15. Complete download flow summary

```
!file download naddr1xyz...

1. Decode naddr1xyz... → { pubkey: botAPubkey, identifier: 'project-b.md', relays }
2. Fetch kind:34343 event from relays
3. Extract tags: url, x (ciphertextHash), hash (plaintextHash), prev
4. Conflict check against local file (see section 8)
5. GET url → blob (Uint8Array)
6. Verify sha256(blob) === x tag value
7. conversationKey = nip44.getConversationKey(BOT_KEY, event.pubkey)
8. aesKeyHex = nip44.decrypt(event.content, conversationKey)
9. aesKey = hexToBytes(aesKeyHex)
10. nonce      = blob.slice(0, 12)
11. ciphertext = blob.slice(12)          // includes 16-byte GCM tag
12. fileBytes  = gcm(aesKey, nonce).decrypt(ciphertext)
13. Write fileBytes to <workspaceRoot>/<identifier>  (or .incoming on conflict)
14. Confirm to user
```