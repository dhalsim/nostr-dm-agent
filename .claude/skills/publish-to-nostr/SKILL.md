---
name: publish-to-nostr
description: "Upload media to Blossom servers and publish Nostr notes (kind:1 short notes and kind:30023 long-form articles via kind:30024 drafts)."
---

## Long-form workflow

1. Discuss structure and content with user
2. Confirm title, summary, tags before creating
3. Upload any media first with blossom-upload (including optional cover); embed content URLs in markdown and pass the cover URL as **image** on create/edit
4. Create draft:
   → note-draft create → returns naddr
5. Share naddr with user — they can preview in any NIP-23 client (Habla, Highlighter)
6. User reviews, requests changes
7. Fetch latest:
   → note-fetch-event naddr
8. Apply changes to content
9. Update draft:
   → note-draft edit → returns same naddr
10. Repeat 5–9 until user is satisfied
11. Publish or schedule:
    - Now:      note-publish source.type=naddr
    - Schedule: use job skill, prompt = "publish nostr draft <naddr> using bunker <name>"

## Short note workflow

1. Confirm content with user
2. Publish or schedule:
   - Now:      note-publish source.type=text
   - Schedule: use job skill, prompt = "publish nostr kind:1 note: <content> using bunker <name>"

## Rules

- When you need a bunker name and do not already know it, run `bun scripts/manage-bunker-connections.ts --list`. If **exactly one** name is printed, use that as **`bunker`** for publish scripts unless the user asked for a different identity. If **multiple** names appear, confirm which connection to use before signing or publishing.
- Always confirm title, summary, and tags with user before creating a draft
- Always call note-fetch-event before note-draft edit
- Never publish kind:30023 directly — always go through kind:30024 draft first, then wait for user revisions and approval before publishing
- Never store bunker connection data — only pass the connection name to scripts
- naddr encodes kind + pubkey + d-tag + relay hints — pass it as-is between steps
- For scheduling, include full naddr and bunker name verbatim in the job prompt

## CLI invocation

Most scripts take **one argument**: a JSON object. JSON strings use **double quotes** (RFC 8259).

`bun scripts/publish/<script>.ts <json>`

In a shell, pass that JSON as a single argument (how you quote it for the shell is up to your environment; the payload itself is standard JSON).

**note-fetch-event** is the exception: pass the **naddr** as the only argument (not JSON):

`bun scripts/publish/note-fetch-event.ts <naddr>`

### Bunker connection names

Scripts take a **`bunker`** string: the saved connection name from the core DB (not the bunker URL).

To list names non-interactively (one per line):

`bun scripts/manage-bunker-connections.ts --list`

## Scripts

### blossom-upload

Upload media before embedding in a note. Always upload first, then use the returned URL in content.

`bun scripts/publish/blossom-upload.ts <json>`

- **`bunker`** — saved bunker connection name (signs kind 24242 auth via NIP-46; bunker `relays` are **only** for NIP-46). NIP-65 **write** relays come from kind **10050** for **`remoteSignerPubkey`**; kind **10063** is read for **`userPubkey`** (your identity).

Sources:
- `file`   — local file path on disk
- `url`    — any public URL, re-uploaded to user's blossom servers
- `mirror` — existing blossom URL, mirrored to user's servers (same hash, different origin)
- `kind15` — encrypted blob at `url`; decrypt with 64-hex `decryptionKey` and hex `decryptionNonce` (12-byte ChaCha or 24-byte XChaCha), then upload plaintext

Output: `{ url, hash, servers[] }` — `url` is a blob URL from the first successful server; `servers` lists base URLs that accepted the upload.
Embed `url` directly in markdown content.

### note-fetch-event

Fetch the current content of a kind:30024 draft before editing.
Always call this before note-draft edit so you have the latest version — user may have changed it in a client.

`bun scripts/publish/note-fetch-event.ts <naddr>`

Output (JSON object, printed to stdout):

- `content`: string — body markdown
- `title`: string
- `summary`: string
- `tags`: string[]
- `slug`: string
- `image`: string — cover image URL (often a Blossom URL); use `""` when none

### note-draft

Create or edit a kind **30024** draft ([NIP-23](https://nips.nostr.com/23) — same structure as 30023). Markdown `content`; tags `title`, `summary`, optional `image`, `t` per topic, `d` identifier.

`bun scripts/publish/note-draft.ts <json>`

- `create` — new draft, requires content, title, summary, tags, **image** (cover URL; use `""` if no cover). **slug** optional (`d` tag; slugified from title if omitted)
- `edit`   — update existing draft (kind 30024 **naddr**), full content, title, summary, tags, **image**

Publishes to NIP-65 **write** relays for **`userPubkey`**; bunker relays only for signing.

Output: JSON string — **naddr**

### note-publish

Publish a kind:1 short note or promote a kind:30024 draft to kind:30023 published article.

`bun scripts/publish/note-publish.ts <json>`

- `naddr`  — promote draft to published article (kind:30023)
- `text`   — publish kind:1 short note directly

Output: naddr string (kind:30023) or nevent string (kind:1)

## JSON schemas

### blossom-upload

```json
[
  {
    "bunker": "<connection name>",
    "source": { "type": "file", "path": "/absolute/path/to/media.png" }
  },
  {
    "bunker": "<connection name>",
    "source": { "type": "url", "url": "https://example.com/image.png" }
  },
  {
    "bunker": "<connection name>",
    "source": { "type": "mirror", "url": "https://blossom.example/..." }
  },
  {
    "bunker": "<connection name>",
    "source": {
      "type": "kind15",
      "url": "https://...",
      "decryptionKey": "<64 hex chars>",
      "decryptionNonce": "<hex, 12 or 24 bytes>"
    }
  }
]
```

### note-fetch-event

- **Input:** a single **naddr** string (not JSON).
- **Output:** JSON with `content`, `title`, `summary`, `tags` (string array), `slug`, and `image` (cover URL string; empty string if unset).

### note-draft

```json
[
  {
    "bunker": "<connection name>",
    "action": {
      "type": "create",
      "content": "# Title\\n\\nBody markdown...",
      "title": "Article title",
      "summary": "One-line summary",
      "slug": "optional-slug",
      "tags": ["nostr", "nip-23"],
      "image": "https://blossom.example/.../cover.png"
    }
  },
  {
    "bunker": "<connection name>",
    "action": {
      "type": "edit",
      "naddr": "nostr:naddr1...",
      "content": "# Title\\n\\nUpdated body...",
      "title": "Article title",
      "summary": "One-line summary",
      "tags": ["nostr", "nip-23"],
      "image": "https://blossom.example/.../cover.png"
    }
  }
]
```

### note-publish

```json
[
  {
    "bunker": "<connection name>",
    "source": { "type": "naddr", "naddr": "nostr:naddr1..." }
  },
  {
    "bunker": "<connection name>",
    "source": { "type": "text", "content": "Short note text" }
  }
]
```
