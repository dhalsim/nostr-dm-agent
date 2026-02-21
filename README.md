# NIP-17 DM Bot

A small Bun script that listens for private DMs from a master pubkey and replies to commands. Uses [nostr-tools](https://github.com/nbd-wtf/nostr-tools) with NIP-17 (Private Direct Messages), NIP-42 (relay auth), and kind 10050 for DM relay discovery.

## Prerequisites

- [Bun](https://bun.sh/) (or Node with a Bun-compatible setup)
- Optional: [nak](https://github.com/fiatjaf/nak) CLI to publish the bot’s kind 10050 (see below)

## Quick start

```bash
cd dm-bot
bun install
cp .env.example .env
# Edit .env (see Configuration)
bun run start
```

## Configuration

### 1. Environment variables (`.env`)

Copy `.env.example` to `.env` and set:

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_KEY` | Yes | Bot’s **private key in hex** (64 hex chars). Generate e.g. with `nak key` or any NIP-19/nostr key tool. |
| `BOT_PUBKEY` | No | Bot’s public key (hex). Omitted = derived from `BOT_KEY`. Set it if you want to enforce a specific identity. |
| `BOT_MASTER_PUBKEY` | Yes | **Your** (master’s) public key in hex. Only messages from this pubkey are processed and replied to. |
| `BOT_RELAYS` | Yes | Comma-separated relay URLs where the bot **listens** for DMs and **publishes** its own. The first URL is the primary (e.g. for kind 10050). Example: `wss://auth.nostr1.com/,wss://relay.damus.io`. |
| `DEBUG` | No | Set to `1` for extra logging (subscription filter, received events, send targets, AUTH). |

Example `.env`:

```bash
BOT_KEY=abc123...your_64_hex_private_key
BOT_MASTER_PUBKEY=6e64b83c1f674fb00a5f19816c297b6414bf67f015894e04dd4c657e94102ee8
BOT_RELAYS=wss://auth.nostr1.com/,wss://relay.damus.io
# DEBUG=1
```

### 2. Publish the bot’s kind 10050 (DM inbox)

Clients (e.g. your phone app) look up **kind 10050** (Direct Message Relays) for the **recipient** to know where to send DMs. If the bot never publishes a 10050, clients may not send replies to it.

**Option A – using nak (recommended)**

Publish a replaceable kind 10050 event that advertises **one** relay (the bot’s primary inbox = first URL in `BOT_RELAYS`), and publish that event to **several** relays so it’s discoverable:

```bash
# Use the first URL from BOT_RELAYS in the tag (e.g. wss://auth.nostr1.com/)
export NOSTR_SECRET_KEY="$BOT_KEY"
# Set BOT_RELAYS_FIRST to the first URL from your BOT_RELAYS in .env:
nak event -k 10050 -t "relay=$BOT_RELAYS_FIRST" -c '' "$BOT_RELAYS_FIRST" wss://relay.0xchat.com wss://purplepag.es wss://relay.damus.io wss://relay.primal.net
```

Or with explicit `--sec`:

```bash
nak event -k 10050 -t "relay=$BOT_RELAYS_FIRST" -c '' --sec "$BOT_KEY" "$BOT_RELAYS_FIRST" wss://relay.0xchat.com wss://purplepag.es wss://relay.damus.io wss://relay.primal.net
```

- **Tag `relay=...`**: the single relay where the bot receives DMs (must match the first URL in `BOT_RELAYS`).
- **Positional relay URLs**: where this 10050 event is **published** (so your app can find it on purplepag.es, etc.).

**Option B – implement in the script**

You can add a startup step in `index.ts` that builds and publishes a kind 10050 event (same content as above) using nostr-tools so new users don’t need nak.

### 3. Relays used by the bot (optional)

- **`BOT_RELAYS`** – Comma-separated relays where the bot subscribes (kind 1059) and publishes. The first URL must match the relay you put in the bot’s 10050 tag.
- **`PROFILE_RELAYS`** (in `index.ts`) – Relays queried to find the **master’s** kind 10050 when the bot **sends** a DM. Defaults include purplepag.es, relay.nos.social, etc. You can add or change these if your master 10050 is on other relays.

## Run

```bash
bun run start
# or
bun run index.ts
```

### Watch mode (development)

- **`bun run watch`** – Bun restarts the bot on any change to its code. Simple, but the bot restarts as soon as the agent saves a file (can interrupt multi-step edits).
- **`bun run watch:restart`** – Runs the bot under a small watcher that restarts **only** when the file **`restart.requested`** is created or touched. Use this when the agent may edit the bot’s code: the agent (with your approval) runs `touch restart.requested` when it’s done changing code; the watcher restarts the app. The bot deletes `restart.requested` on startup. No restart on every save.

The agent is scoped to the **project root** (one level up from the dm-bot directory). For example, if dm-bot lives at `~/Projects/XYZ/dm-bot`, the agent may only edit files under `~/Projects/XYZ/`.

On startup the bot sends one DM to the master: `Agent is ready. PWD: ...` Then it listens for your messages. Plain messages (no `!`) are sent to the Cursor agent in the current session; replies are prefixed with `<ask>`, `<plan>`, or `<agent>` according to the current mode.

**Prerequisite:** [Cursor Agent CLI](https://cursor.com) must be installed and authenticated (`agent` on your PATH). The bot runs `agent create-chat` and `agent -p --resume <id> ...` for each request.

## Commands

All commands are prefixed with `!`. The bot responds only to the master pubkey.

| Command | Description |
|--------|-------------|
| (plain message) | Sent to the agent in the current session (default: latest session, ask mode). Reply format: `<ask\|plan\|agent> Message...` |
| `!new-session` | Create a new agent session and set it as current. |
| `!resume-last-session` | Set current session to the latest (by creation time). |
| `!resume-session <id>` | Set current session to the given session ID. |
| `!list-sessions` | List all sessions (id, date). Current session is marked. |
| `!show-last-messages <id> [N]` | Show last N messages (default 5) for a session. |
| `!status` | Bot status, relay, current session, and mode. |
| `!version` | Show bot version (git hash of project). |
| `!help` | List these commands. |
| `!plan` | Shortcut for `!mode plan` (read-only planning). |
| `!agent` | Shortcut for `!mode agent` (full access: edits, shell). |
| `!ask` | Shortcut for `!mode ask` (read-only). |
| `!mode ask` \| `!mode plan` \| `!mode agent` | Set execution mode. Default is **ask** (read-only). **plan** = read-only planning. **agent** = full access (edits, shell). |

## Sending a DM to the bot

Use a NIP-17–compatible client (e.g. Damus, Coracle, 0xChat, or any app that supports NIP-17 DMs). Send an encrypted DM to the **bot’s pubkey** (hex or npub). The bot only reacts to messages from `BOT_MASTER_PUBKEY`.

- If your app looks up kind 10050 for the bot, it will send to the relay you set in step 2 (the first in `BOT_RELAYS`).
- Make sure that relay is the same as the first URL in `BOT_RELAYS` in `.env`.

## Troubleshooting

- **Bot sends “Agent is ready” but you don’t receive it**  
  Your app may be reading DMs from relays listed in **your** kind 10050. The bot already discovers your 10050 and publishes there; ensure your app is connected to those relays.

- **You send a reply but the bot never answers**  
  1. The bot must advertise where to receive DMs: publish the bot’s **kind 10050** with tag `relay=<first BOT_RELAYS URL>` (step 2).  
  2. The first URL in `BOT_RELAYS` in `.env` must match that relay (same URL, including trailing slash if the relay uses it).  
  3. Some relays (e.g. auth.nostr1.com) require NIP-42 AUTH; the bot signs AUTH when the relay challenges it. If your **phone app** fails to send, it may need to complete AUTH on that relay too.

- **More visibility**  
  Run with `DEBUG=1` to see subscription filter, incoming events, where the bot publishes, and AUTH challenges.

## For developers / AI agents

When changing dm-bot code:

- **File map**: Main logic is in `index.ts` (Nostr subscription, `!` commands in `handleBangCommand`, agent spawn, DM send). `run-with-restart.ts` watches for `restart.requested` and restarts the bot. Version is computed at startup with `git rev-parse HEAD` from the project root.
- **State**: SQLite at `dm-bot.sqlite` (tables: `seen_events`, `sessions`, `session_messages`, `state`). See `index.ts` for schema.
- **New commands**: Add a branch in `handleBangCommand` in `index.ts`.
- **After edits**: Touch `restart.requested` in the dm-bot directory so the watcher restarts the bot (when using `bun run watch:restart`). Run the linter with auto-fix: from project root `bun run lint`, or from dm-bot `bun run lint`.

### Configure safe npm scripts for agent shell access

If your project rule requires approval for shell commands, you can still allow common project tasks by whitelisting npm scripts.
This is a practical pattern because the agent can only run commands already defined in `package.json` `scripts` (for example `build`, `lint`, `test`).

Add or update `dm-bot/.cursor/rules/agent-cli-permission.mdc` like this:

```md
## Whitelist (no permission required)

You may run these without asking. Everything else requires permission.

### Package scripts (trusted by project config)

- `npm run <script>` when `<script>` exists in the nearest `package.json` `scripts` field.
- `npm test` when backed by package scripts or default npm test behavior.
- `npm run` (list scripts only, read-only).

Before running a package script, the agent should:
1. Read `package.json`.
2. Verify the script name exists.
3. Run only that script command (no extra shell chaining like `&&`, `;`, or pipes unless user explicitly approves).

### Common read-only commands

- `node --version`, `npm --version`
- `ls`, `pwd`, `cat` for reading files
- `git status`, `git diff`, `git log`
```

With this setup, commands such as `npm run build` and `npm run lint` are available to the agent without extra per-command approvals, while still keeping execution bounded to your script definitions.

Full codebase context and extension points are in **.cursor/rules/dm-bot-context.mdc** in this directory.
