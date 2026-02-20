# Agent instructions (recall-trainer project)

Rules and context for AI agents working in this project.

## Workspace boundary

- You may only create, edit, or delete files under the **project root** (this repo). If the project contains `dm-bot/`, the root is one level up from `dm-bot/` (e.g. `~/Projects/nostr/recall-trainer/`). Never modify files outside that tree.

## dm-bot (NIP-17 DM Bot)

The `dm-bot/` directory contains a Bun script that listens for private DMs from a master pubkey and forwards messages to the Cursor agent, then sends replies back over Nostr. It uses nostr-tools with NIP-17 (Private DMs), NIP-42 (relay auth), and kind 10050 for DM relay discovery. The bot process runs continuously; any code changes are applied when the process restarts.

When you edit dm-bot code: create or touch `dm-bot/restart.requested`. That triggers a restart of the bot process. If the restart succeeds, the bot can resume the session and continue responding.

### Agent integration

- On startup the bot sends one DM to the master: `Agent is ready. PWD: ...` then listens for messages.
- **Cursor Agent CLI** must be installed and authenticated (`agent` on PATH). The bot uses `agent create-chat` and `agent -p --resume <id> ...` for requests.
- Plain messages (no `!`) are sent to the agent in the current session; replies are prefixed with `<ask>`, `<plan>`, or `<agent>` by mode.
- All commands are prefixed with `!` and only the master pubkey is obeyed:
  - **(plain message)** – Sent to agent (default: latest session, ask mode).
  - `!new-session` – New agent session, set as current.
  - `!resume-last-session` – Current session = latest by creation time.
  - `!resume-session <id>` – Current session = given id.
  - `!list-sessions` – List sessions (current marked).
  - `!show-last-messages <id> [N]` – Last N messages (default 5).
  - `!status` – Bot status, relay, current session, mode.
  - `!help` – List commands.
  - `!mode ask` | `!mode plan` | `!mode agent` (shortcuts: `!plan`, `!agent`) – Execution mode: **ask** = read-only (default), **plan** = read-only planning, **agent** = full access (edits, shell).

## Other project rules

- Follow any rules in `.cursor/rules/` (e.g. CLI permission, workspace boundary). Do not run destructive or sensitive commands without explicit user approval.
