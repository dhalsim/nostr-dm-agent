Main repo: https://gitworkshop.dev/dhalsim@dhalsim.github.io/nostr-dm-agent

# Nostr DM Bot

Control AI agents remotely via Nostr DMs. A bridge between encrypted messaging and local AI coding assistants.

## What it does

- DM your bot from any Nostr client → it spawns Cursor or OpenCode to work on your codebase
- Work on projects from your phone, anywhere in the world
- Pay for AI compute with Bitcoin over Cashu using Routstr
- Three safety modes: ask (read-only), plan (strategy), agent (full edits)

## Key features

- **NIP-17 encrypted DMs** — Private messages over any Nostr relay
- **Remote agent control** — Cursor Agent or OpenCode integration
- **Session persistence** — Resume previous conversations, switch contexts
- **Bitcoin payments** — Pay-per-use AI with sats via Cashu using Routstr
- **Dual interface** — Nostr DMs + local terminal chat
- **Granular permissions** — Control what the agent can do

Built with Bun, nostr-tools, and TypeScript.

**Links:** [Nostr](https://nostr.com/) · [NIP-17 (encrypted DMs)](https://github.com/nostr-protocol/nips/blob/master/17.md) · [Cursor](https://cursor.com) · [OpenCode](https://opencode.ai) · [Cashu](https://cashu.space) · [Routstr](https://routstr.com)

## How to use the bot (practical workflow)

You have an existing project — we call it the **parent** in workspace terms.

1. **Put the bot in your project**  
   Fork and clone this repo into your project, naming the directory `dm-bot`:

   ```bash
   git clone https://github.com/YOUR_USERNAME/nostr-dm-bot.git dm-bot
   ```

   Add `dm-bot/` to your project’s `.gitignore` so the bot can have its own git repo.

2. **Quick start (from the bot directory)**

```bash
cd dm-bot
bun install

# Setup Nostr identity, relays, and publish kind 10050
npm run nostr:setup

# Optional: setup Cashu wallet for paid AI (Routstr)
npm run wallet:setup

# Start the bot
bun run start
```

3. **Workspace**  
   The default workspace is **parent**. When you send a question or a coding task, the agent works on your parent project (the repo that contains the bot).

4. **Choose a backend**  
   Pick an AI agent backend that runs on your machine: OpenCode (CLI or SDK) or Cursor. See [Backends](#backends) for how to install them. Switch with `!backend <name>`.

5. **Choose a provider**  
   **Local** (no payment) — works with any backend and is ideal if you already have a subscription (e.g. Cursor, or [OpenCode providers](https://opencode.ai/docs/providers/) such as OpenAI, Anthropic, OpenCode Zen). If you don’t have a subscription, use **Routstr** and pay as you go with sats via Cashu. See [Choosing a provider](#choosing-a-provider). Switch with `!provider set local|routstr`.

6. **Chat and iterate**  
   Send messages via Nostr DM or the local terminal. Set a mode with `!ask`, `!plan`, or `!agent`. Use **agent** mode when you want the bot to apply changes, commit, and push.

**Summary:** Clone into your project (add to `.gitignore`) → choose backend → choose provider → Nostr setup → chat → choose mode → iterate.

## Backends

The bot needs an AI agent backend on your machine. Install one and ensure it’s on your PATH.

### Cursor Agent CLI

- Install and sign in via [Cursor](https://cursor.com). The `agent` CLI must be on your PATH.
- The bot runs `agent create-chat` and `agent -p --resume <id> ...` for each request.
- Switch to this backend with `!backend cursor`. Supports both **local** (Cursor’s own auth) and **Routstr** (pay with sats) when Cursor is configured to use Routstr — see [Cursor + Routstr](#cursor--routstr).

### Cursor + Routstr

You can use the Cursor backend with the Routstr provider by pointing Cursor at Routstr in its settings:

1. In Cursor: **Cursor Settings → Models → API Keys**
2. **Open API Key:** your Routstr session key (starts with `sk-...`). Create and fund a session via the bot: `!provider set routstr`, then `!provider deposit <sats>`; the key is stored in the bot (see [Cashu / Routstr Integration](#cashu--routstr-integration-optional)).
3. **Override OpenAI Base URL:** `https://api.routstr.com/v1`

After that, set the bot’s provider to Routstr (`!provider set routstr`) and use `!backend cursor` as usual. Cursor will send requests to Routstr and you pay with sats.

### OpenCode

- Install [OpenCode](https://opencode.ai) so the `opencode` CLI is on your PATH.
- **opencode** (CLI): the bot shells out to `opencode run ...`. Use `!backend opencode`.
- **opencode-sdk**: the bot starts an in-process OpenCode server. Use `!backend opencode-sdk`. Requires `opencode` to be installed; the SDK runs the server for you.
- OpenCode supports both **local** (your API keys / opencode.json) and **Routstr** (pay with sats).

## Choosing a provider

- **Local** — No payment layer. The backend uses your own config: Cursor’s auth, or for OpenCode your [providers](https://opencode.ai/docs/providers/) (e.g. OpenAI, Anthropic, OpenCode Zen) and API keys in `opencode.json`. Ideal if you already have a subscription.
- **Routstr** — Pay per request with Bitcoin (sats) via Cashu. Use this if you don’t have a subscription. Requires a Cashu wallet and a mint that Routstr works with.

### Using Routstr

1. **Setup a Cashu wallet**  
   Run `npm run wallet:setup` and store the mnemonic in `.env` as `CASHU_MNEMONIC`.

2. **Add a mint**  
   Use a mint that Routstr accepts. Official options:
   - https://mint.minibits.cash/Bitcoin
   - https://mint.cubabitcoin.org
   - https://ecashmint.otrta.me
   - https://mint.coinos.io  

   Add one with: `!wallet mint <mintURL>`.

3. **Receive sats into your local wallet**  
   Use `!wallet receive <token>`. You can get a token from another Cashu wallet (e.g. [cashu.me](https://cashu.me)): create an invoice, pay with Lightning, then paste the received token into `!wallet receive <token>`.

4. **Switch to Routstr and deposit**  
   `!provider set routstr`, then `!provider deposit <sats>` (or use auto-flow by appending `!!<sats>` to a prompt).

5. **Set a Routstr model**  
   `!provider models` then `!model set routstr/<model-id>`.

6. **Apply changes**  
   Use **agent** mode (`!agent` or `!mode agent`) when you want the bot to apply edits, commit, and push.

For wallet commands, auto-flow, and troubleshooting, see [Cashu / Routstr Integration](#cashu--routstr-integration-optional).

## Configuration

### Environment variables (`.env`)

The setup scripts will create `.env` automatically. You can also edit manually:

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_KEY` | Yes | Bot's private key in hex. Generated by `nostr:setup`. |
| `BOT_PUBKEY` | No | Bot's public key (hex). Omitted = derived from `BOT_KEY`. |
| `BOT_MASTER_PUBKEY` | Yes | Your (master) public key in hex format. Only messages from this pubkey are processed. |
| `BOT_RELAYS` | Yes | Comma-separated relay URLs. Set by `nostr:setup`. |
| `DEBUG` | No | Set to `1` for extra logging. |
| `LOG` | No | Set to `0` to suppress log() output. Default `1`. |
| `BOT_OPENCODE_SERVE_URL` | No | Attach to a running opencode server. |
| `CASHU_DEFAULT_MINT_URL` | No | Default mint that is going to be used by the local cashu wallet. Generated by `wallet:setup`. |
| `CASHU_MNEMONIC` | No | 12-word Cashu wallet mnemonic. Generated by `wallet:setup`. |

Example `.env`:

```bash
BOT_KEY=abc123...your_64_hex_private_key
BOT_MASTER_PUBKEY=6e64b83c1f674fb00a5f19816c297b6414bf67f015894e04dd4c657e94102ee8
BOT_RELAYS=wss://auth.nostr1.com/,wss://relay.netstr.io
# DEBUG=1

# Optional: Cashu/Routstr for paid AI
# CASHU_MNEMONIC="word1 word2 ... word12"
# ROUTSTR_BASE_URL=https://api.routstr.com/v1
```

## Run

```bash
bun run start
```

### Watch mode (development)

- **`bun run watch`** – Runs the bot under a small watcher that restarts **only** when the file **`restart.requested`** is created or touched. Use this when the agent may edit the bot’s code: the agent (with your approval) runs `touch restart.requested` when it’s done changing code; the watcher restarts the app. The bot deletes `restart.requested` on startup. No restart on every save.

### Local terminal chat (CLI input)

You can chat with the bot directly from the same terminal process, without sending messages from your phone app.

- Type or paste a message after the `>` prompt and press Enter to send.
- Replies are printed back in terminal.
- `!` commands work locally too (`!help`, `!mode ask`, `!new-session`, etc.).
- Nostr DM handling continues in parallel, so you can use phone and terminal at the same time.

Local terminal chat is enabled when stdin is a TTY.

The agent is scoped to the **project root** (one level up from the dm-bot directory). For example, if dm-bot lives at `~/Projects/XYZ/dm-bot`, the agent may only edit files under `~/Projects/XYZ/`.

On startup the bot sends one DM to the master: `Agent is ready.` Then it listens for your messages. Plain messages (no `!`) are sent to the agent in the current session; replies are prefixed with `<ask>`, `<plan>`, `<agent>` or similar according to the current mode.

**Prerequisite:** Install a [backend](#backends) (Cursor Agent CLI or OpenCode) and ensure it’s on your PATH.

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
| `!local` | Switch to local-only mode: ignore incoming Nostr messages and print bot replies in terminal only. |
| `!remote` | Switch reply transport back to outgoing Nostr DMs. |
| `!workspace [parent\|bot]` | Show or set active workspace target. Switching target auto-creates a new session. |
| `!exit` | Stop the dm-bot process. |
| `!plan` | Shortcut for `!mode plan` (read-only planning). |
| `!agent` | Shortcut for `!mode agent` (full access: edits, shell). |
| `!ask` | Shortcut for `!mode ask` (read-only). |
| `!mode ask` \| `!mode plan` \| `!mode agent` | Set execution mode. Default is **ask** (read-only). **plan** = read-only planning. **agent** = full access (edits, shell). |

## Cashu / Routstr Integration (Optional)

The bot supports paid AI providers via Cashu tokens and [Routstr](https://routstr.com). This is optional — by default the bot uses your existing `OPENAI_API_KEY` from the environment.

### How It Works

**Two payment flows:**

1. **Auto-flow** (recommended): Append `!!<sats>` to any prompt
   - Example: `fix the auth bug !!2000sats`
   - Bot automatically deposits sats to Routstr, runs the agent, then refunds unspent sats back to your local wallet

2. **Manual flow**: Pre-fund a Routstr session, then use normally
   - `!provider deposit <sats>` to fund the session
   - `!provider refund` to recover unspent balance when done

### Cashu and the bot wallet

The bot’s wallet holds Cashu eCash tokens (sats) that you can spend on Routstr. **The bot does not support minting via Lightning** — you cannot create a Lightning invoice inside the bot and pay it to receive sats directly.

To add funds, use an external Cashu-capable wallet (e.g. [cashu.me](https://cashu.me)). There you can receive sats (e.g. by creating a Lightning invoice and paying it from any Lightning wallet). After payment you receive a **Cashu token**. Paste that token into the bot with:

```bash
!wallet receive <token>
```

The bot will redeem the token and the sats will appear in your local wallet balance. You can then use them for Routstr (`!provider deposit` or auto-flow with `!!sats`).

### One-Time Setup

```bash
# 1. Generate a new Cashu wallet
npm run wallet:setup
# This creates a 12-word mnemonic and saves it to .env
# WRITE DOWN THE MNEMONIC — it's only shown once!

# 2. Start/restart the bot
bun run start
# or if already running, the bot will pick up the new .env on next start

# 3. Set your preferred Cashu mint
!wallet mint https://mint.minibits.cash/Bitcoin
# Common mints:
#   - https://mint.minibits.cash/Bitcoin (mainnet)
#   - https://testnut.cashu.space (testnet)

# 3. Top up your local wallet
#    Send sats to your mint address, then receive the token:
!wallet receive cashuA...

# 4. Switch to Routstr provider
!provider set routstr

# 5. Deposit sats to Routstr (or use auto-flow)
!provider deposit 5000
```

### Wallet Commands

| Command | Description |
|---------|-------------|
| `!wallet mint [url]` | Show/set your Cashu mint URL |
| `!wallet balance` | Show local wallet balance |
| `!wallet receive <token>` | Receive a Cashu token into local wallet |
| `!wallet history` | Show recent spend history |

### Provider Commands

| Command | Description |
|---------|-------------|
| `!provider set local\|routstr` | Switch payment provider |
| `!provider deposit <sats>` | Move sats from local wallet to Routstr session |
| `!provider refund` | Recover unspent Routstr balance to local wallet |
| `!provider balance` | Check remaining Routstr session balance |
| `!provider budget <sats>` | Set default budget (used when no `!!sats` in prompt) |
| `!provider status` | Show provider, session, mint, model, budget |
| `!provider sync-models` | Refresh Routstr model cache |

### Model Selection

```bash
# List Routstr models (cached)
!models routstr

# Set a specific model for Routstr
!model routstr/gpt-4o-mini

# Clear model override
!model reset
```

### Using Auto-Flow

Simply append `!!<sats>` to any prompt:

```
fix the login bug !!1000sats
```

The bot will:
1. Check/create a Routstr session
2. Deposit the sats from your local wallet
3. Run the agent with those funds
4. Automatically refund unspent sats back to your local wallet

### External wallet options

Ways to get Cashu tokens that you can paste into the bot with `!wallet receive <token>`:

1. **[cashu.me](https://cashu.me)** — Receive tab → Create invoice → Pay from a Lightning wallet → Copy the token and paste into the bot
2. **Minibits** — App → Wallet → Receive → Copy Lightning invoice → Pay from any Lightning wallet → receive token, then `!wallet receive <token>` in the bot

### Troubleshooting

- **"No mint configured"**: Run `!wallet mint <url>` first
- **"Wallet not available"**: Make sure to run `npm run wallet:setup` to create a Cashu wallet and set the mnemonic in `.env`
- **"Insufficient balance"**: Top up with `!wallet receive <token>` from external wallet
- **"No Routstr session"**: Run `!provider deposit <sats>` or append `!!sats` to your prompt

### Post-agent lint behavior

When execution mode is `agent`, the bot runs `npm run lint` after each agent response for the active workspace target:

- `parent` = project root (default),
- `bot` = `dm-bot` directory.

- If lint passes, the lint summary is appended to the response.
- If lint fails, the bot runs one additional agent round with lint output as feedback, then sends the combined result.
- If lint cannot run in runtime (for example, missing npm), bot logs the issue and sends the original agent response.

## Sending a DM to the bot

Use a NIP-17–compatible client (e.g. Damus, Coracle, 0xChat, or any app that supports NIP-17 DMs). Send an encrypted DM to the **bot’s pubkey** (hex or npub). The bot only reacts to messages from `BOT_MASTER_PUBKEY`.

- If your app looks up kind 10050 (indicates the user's preferred relays to receive DMs) for the bot, it will send to the relay(s) advertised there.
- The `nostr:setup` script automatically publishes kind 10050 to your relays.

## Troubleshooting

- **Bot sends “Agent is ready” but you don’t receive it**  
  Your app may be reading DMs from relays listed in **your** kind 10050. The bot already discovers your 10050 and publishes there; ensure your app is connected to those relays.

- **You send a reply but the bot never answers**  
  1. The bot must advertise where to receive DMs — `nostr:setup` publishes kind 10050 automatically.
  2. `BOT_RELAYS` in `.env` must match the relay(s) in that 10050 (same URLs, including trailing slash if the relay uses it).
  3. Some relays (e.g. auth.nostr1.com) require NIP-42 AUTH; the bot signs AUTH when the relay challenges it. If your **phone app** fails to send, it may need to complete AUTH on that relay too.

- **More visibility**  
  Run with `DEBUG=1` to see subscription filter, incoming events, where the bot publishes, and AUTH challenges.

## For developers / AI agents

When changing dm-bot code:

- **File map**: Main entry is `src/index.ts`. Key modules:
  - `src/logger.ts` — debug(), log(), logError(), ANSI colors
  - `src/env.ts` — loadBotConfig(), env parsing
  - `src/db.ts` — SQLite schema, state getters/setters, Zod schemas
  - `src/session.ts` — Session CRUD
  - `src/backends/types.ts` — AgentBackend interface
  - `src/backends/cursor.ts` — Cursor backend factory
  - `src/backends/opencode.ts` — OpenCode backend + JSONL parser
  - `src/backends/factory.ts` — createBackend() dispatcher
  - `src/messaging.ts` — sendDm(), chunkMessage(), NIP-17 relay discovery
  - `src/commands.ts` — handleBangCommand()
  - `src/lint.ts` — runPostAgentLint(), formatLintSummary()
  - `run-with-restart.ts` watches for restart.requested
- **State**: SQLite at `dm-bot.sqlite` (tables: `seen_events`, `sessions`, `session_messages`, `state`). See `index.ts` for schema.
- **New commands**: Add a branch in `handleBangCommand` in `index.ts`.
- **After edits**: Touch `restart.requested` in the dm-bot directory so the watcher restarts the bot (when using `bun run watch`). Run the linter with auto-fix: from project root `bun run lint`, or from dm-bot `bun run lint`.

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
