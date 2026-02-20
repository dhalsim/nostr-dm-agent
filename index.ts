#!/usr/bin/env bun
/**
 * NIP-17 DM Bot - Listens for private messages from master and replies.
 *
 * Environment variables:
 *   BOT_KEY           - Bot's private key (hex)
 *   BOT_PUBKEY        - Bot's public key (hex) - optional, derived from BOT_KEY if omitted
 *   BOT_MASTER_PUBKEY - Master's pubkey to listen to and reply to (hex)
 *   BOT_RELAYS        - Comma-separated relay URLs (e.g. wss://relay.damus.io,wss://relay.nos.social)
 *   DEBUG             - Set to 1 for extra logging (subscription, received events, send targets)
 *
 * Restart: when using watch:restart, touch restart.requested in this directory to restart the bot.
 */

import { spawn, spawnSync } from "bun";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";
import { hexToBytes } from "nostr-tools/utils";
import { getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { wrapEvent, unwrapEvent } from "nostr-tools/nip17";
import { SimplePool } from "nostr-tools/pool";
import type { NostrEvent, EventTemplate, VerifiedEvent } from "nostr-tools/core";
import { VERSION } from "./version.generated.ts";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return val;
}

function ensureWss(url: string): string {
  if (url.startsWith("wss://") || url.startsWith("ws://")) return url;
  return `wss://${url}`;
}

function parseRelayUrls(envValue: string): string[] {
  const urls = envValue
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(ensureWss);
  return [...new Set(urls)];
}

const DEBUG = process.env.DEBUG === "1";

function debug(msg: string, ...args: unknown[]) {
  if (DEBUG) console.log("[debug]", msg, ...args);
}

/** Persist seen event ids so we don't reprocess on restart (Bun built-in SQLite) */
const SEEN_DB_PATH = join(import.meta.dir ?? process.cwd(), "dm-bot.sqlite");

/** When this file is touched, the watcher (run-with-restart.ts) restarts the bot. Deleted on startup. */
export const RESTART_REQUESTED_PATH = join(import.meta.dir ?? process.cwd(), "restart.requested");

function openSeenDb(): Database {
  const db = new Database(SEEN_DB_PATH);
  db.run("CREATE TABLE IF NOT EXISTS seen_events (id TEXT PRIMARY KEY)");
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS session_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT)
  `);
  return db;
}

function alreadyHaveEvent(db: Database): (id: string) => boolean {
  const stmt = db.prepare("SELECT 1 FROM seen_events WHERE id = ?");
  return (id: string) => stmt.get(id) !== null;
}

function markSeen(db: Database, id: string): void {
  db.run("INSERT OR IGNORE INTO seen_events (id) VALUES (?)", [id]);
}

type AgentMode = "ask" | "plan" | "agent";

const DEFAULT_MODE: AgentMode = "ask";
const STATE_CURRENT_SESSION = "current_session_id";
const STATE_DEFAULT_MODE = "default_mode";

function getState(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setState(db: Database, key: string, value: string): void {
  db.run("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)", [key, value]);
}

function getDefaultMode(db: Database): AgentMode {
  const v = getState(db, STATE_DEFAULT_MODE);
  if (v === "ask" || v === "plan" || v === "agent") return v;
  return DEFAULT_MODE;
}

function setDefaultMode(db: Database, mode: AgentMode): void {
  setState(db, STATE_DEFAULT_MODE, mode);
}

function getLatestSession(db: Database): string | null {
  const row = db.prepare("SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1").get() as { id: string } | undefined;
  return row?.id ?? null;
}

function getOrCreateCurrentSession(db: Database): string {
  const cur = getState(db, STATE_CURRENT_SESSION);
  if (cur) {
    const exists = db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(cur);
    if (exists) return cur;
  }
  const proc = spawnSync(["agent", "create-chat"], { stdout: "pipe", stderr: "pipe" });
  const raw = proc.stdout?.toString().trim() ?? "";
  const id = raw.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0];
  if (!id) {
    throw new Error(`agent create-chat failed or invalid output: ${raw || proc.stderr?.toString() || "no output"}`);
  }
  const now = Math.floor(Date.now() / 1000);
  db.run("INSERT OR IGNORE INTO sessions (id, created_at) VALUES (?, ?)", [id, now]);
  setState(db, STATE_CURRENT_SESSION, id);
  return id;
}

function setCurrentSession(db: Database, sessionId: string): boolean {
  const exists = db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId);
  if (!exists) return false;
  setState(db, STATE_CURRENT_SESSION, sessionId);
  return true;
}

function insertSessionMessage(db: Database, sessionId: string, role: "user" | "assistant", content: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.run("INSERT INTO session_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)", [
    sessionId,
    role,
    content,
    now,
  ]);
}

const CHUNK_MAX = 3500;

function chunkMessage(text: string): string[] {
  if (text.length <= CHUNK_MAX) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= CHUNK_MAX) {
      chunks.push(rest);
      break;
    }
    const slice = rest.slice(0, CHUNK_MAX);
    const lastNewline = slice.lastIndexOf("\n");
    const splitAt = lastNewline >= 0 ? lastNewline + 1 : CHUNK_MAX;
    chunks.push(rest.slice(0, splitAt));
    rest = rest.slice(splitAt);
  }
  return chunks;
}

function handleBangCommand(input: string, relayUrls: string[], db: Database, version: string): string | null {
  const raw = input.trim();
  if (!raw.startsWith("!")) return null;
  const rest = raw.slice(1).trim();
  const parts = rest.split(/\s+/);
  const cmd = (parts[0] ?? "").toLowerCase();
  const args = parts.slice(1);

  if (cmd === "new-session") {
    const proc = spawnSync(["agent", "create-chat"], { stdout: "pipe", stderr: "pipe" });
    const out = proc.stdout?.toString().trim() ?? "";
    const id = out.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0];
    if (!id) return `Failed to create session: ${out || proc.stderr?.toString() || "no output"}`;
    const now = Math.floor(Date.now() / 1000);
    db.run("INSERT OR IGNORE INTO sessions (id, created_at) VALUES (?, ?)", [id, now]);
    setState(db, STATE_CURRENT_SESSION, id);
    const mode = getDefaultMode(db);
    return `New session: ${id}\nMode: ${mode}.`;
  }

  if (cmd === "resume-last-session") {
    const id = getLatestSession(db);
    if (!id) return "No sessions yet. Send a message or use !new-session.";
    setCurrentSession(db, id);
    return `Resumed session ${id}.`;
  }

  if (cmd === "resume-session") {
    const id = args[0];
    if (!id) return "Usage: !resume-session <SESSION-ID>";
    if (!setCurrentSession(db, id)) return "Session not found.";
    return `Resumed session ${id}.`;
  }

  if (cmd === "list-sessions") {
    const rows = db.prepare("SELECT id, created_at FROM sessions ORDER BY created_at DESC").all() as {
      id: string;
      created_at: number;
    }[];
    if (rows.length === 0) return "No sessions yet.";
    const cur = getState(db, STATE_CURRENT_SESSION);
    const lines = rows.map((r) => {
      const date = new Date(r.created_at * 1000).toISOString();
      const mark = r.id === cur ? " (current)" : "";
      return `${r.id} ${date}${mark}`;
    });
    return lines.join("\n");
  }

  if (cmd === "show-last-messages") {
    const sessionId = args[0];
    const n = Math.min(50, Math.max(1, parseInt(args[1] ?? "5", 10) || 5));
    if (!sessionId) return "Usage: !show-last-messages <SESSION-ID> [N]";
    const rows = db
      .prepare(
        "SELECT role, content FROM session_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?"
      )
      .all(sessionId, n) as { role: string; content: string }[];
    if (rows.length === 0) return "No messages for that session.";
    const chronological = rows.reverse();
    const lines = chronological.map((r) => `${r.role}: ${r.content.slice(0, 500)}${r.content.length > 500 ? "…" : ""}`);
    return lines.join("\n\n");
  }

  if (cmd === "status") {
    const cur = getState(db, STATE_CURRENT_SESSION);
    const mode = getDefaultMode(db);
    return `Bot running. Version: ${version}\nRelays: ${relayUrls.join(", ")}\nCurrent session: ${cur ?? "(none)"}\nMode: ${mode}.`;
  }

  if (cmd === "version") {
    return `Version: ${version}`;
  }

  if (cmd === "help") {
    return `Commands (prefix with !):
!new-session — create a new agent session
!resume-last-session — resume the latest session (default for normal messages)
!resume-session <id> — resume a specific session
!list-sessions — list all sessions
!show-last-messages <id> [N] — last N messages (default 5)
!status — bot status and current session/mode
!version — show git hash (dm-bot project)
!help — this message
!mode ask | !mode plan | !mode agent — set mode (default: ask). !plan and !agent are shortcuts.

Plain messages (no !) go to the agent in the current session (ask mode by default).`;
  }

  if (cmd === "mode") {
    const m = (args[0] ?? "").toLowerCase();
    if (m === "ask") {
      setDefaultMode(db, "ask");
      return "Mode set to ask (read-only Q&A).";
    }
    if (m === "plan") {
      setDefaultMode(db, "plan");
      return "Mode set to plan (read-only planning).";
    }
    if (m === "agent") {
      setDefaultMode(db, "agent");
      return "Mode set to agent (full access: edits, shell).";
    }
    return "Usage: !mode ask | !mode plan | !mode agent";
  }

  if (cmd === "plan") {
    setDefaultMode(db, "plan");
    return "Mode set to plan.";
  }
  if (cmd === "agent") {
    setDefaultMode(db, "agent");
    return "Mode set to agent (full access).";
  }

  return `Unknown command: !${cmd}. Use !help for commands.`;
}

function main() {
  if (existsSync(RESTART_REQUESTED_PATH)) {
    try {
      unlinkSync(RESTART_REQUESTED_PATH);
    } catch (_) {}
  }

  const botKeyHex = requireEnv("BOT_KEY");
  const masterPubkey = requireEnv("BOT_MASTER_PUBKEY");
  const relayUrls = parseRelayUrls(requireEnv("BOT_RELAYS"));
  if (relayUrls.length === 0) {
    console.error("BOT_RELAYS must contain at least one relay URL (comma-separated)");
    process.exit(1);
  }
  const primaryRelay = relayUrls[0];

  const botSecretKey = hexToBytes(botKeyHex);
  const botPubkey = process.env.BOT_PUBKEY ?? getPublicKey(botSecretKey);
  if (process.env.BOT_PUBKEY && botPubkey !== process.env.BOT_PUBKEY) {
    console.error("Bot pubkey mismatch. Expected:", process.env.BOT_PUBKEY, "Got:", botPubkey);
    process.exit(1);
  }

  const pool = new SimplePool({ enablePing: true, enableReconnect: true });

  const seenDb = openSeenDb();

  /** NIP-42: sign AUTH challenge so the relay can restrict kind:1059 to authenticated users */
  const signAuthEvent = async (authTemplate: EventTemplate): Promise<VerifiedEvent> => {
    debug("Signing AUTH challenge event:", authTemplate);
    
    return finalizeEvent(authTemplate, botSecretKey);
  };

  console.log(`Bot pubkey: ${botPubkey}`);
  console.log(`Master: ${masterPubkey}`);
  console.log(`Relays: ${relayUrls.join(", ")}`);
  console.log(`Version: ${VERSION}`);
  console.log("Listening for DMs...\n");

  const dmFilter = {
    kinds: [1059] as number[],
    "#p": [botPubkey],
    since: Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60, // NIP-17: created_at can be randomized up to 2 days in the past
  };

  debug("Subscription filter:", JSON.stringify(dmFilter));

  const pwdOutput = spawnSync(["pwd"], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim() ?? "(failed)";

  debug("PWD:", pwdOutput);

  sendDm(pool, primaryRelay, botSecretKey, masterPubkey, `Agent is ready. PWD: ${pwdOutput}`, signAuthEvent).catch(
    (err) => console.error("Failed to send ready DM:", err)
  );

  pool.subscribe(
    relayUrls,
    dmFilter,
    {
      onauth: signAuthEvent,
      alreadyHaveEvent: alreadyHaveEvent(seenDb),
      onevent: async (wrap: NostrEvent) => {
        debug("Received event kind:", wrap.kind, "id:", wrap.id);
        try {
          const rumor = unwrapEvent(wrap, botSecretKey);

          if (rumor.pubkey !== masterPubkey) {
            debug("Ignoring rumor from non-master:", rumor.pubkey);
            return;
          }

          const content = rumor.content?.trim() ?? "";
          const kind = rumor.kind ?? 0;

          if (kind !== 14) {
            debug("Ignoring non–kind-14 rumor:", kind);
            return;
          }

          markSeen(seenDb, wrap.id);

          console.log(`[master] ${content}`);

          if (content.trim().startsWith("!")) {
            const reply = handleBangCommand(content, relayUrls, seenDb, VERSION);
            if (reply) {
              await sendDm(pool, primaryRelay, botSecretKey, masterPubkey, reply, signAuthEvent);
            }
            return;
          }

          const sessionId = getOrCreateCurrentSession(seenDb);
          const mode = getDefaultMode(seenDb);
          const workspaceRoot = join(import.meta.dir ?? process.cwd(), "..");
          const baseArgs = ["agent", "-p", "--model", "auto", "--workspace", workspaceRoot, "--trust"];
          if (mode === "ask") baseArgs.push("--mode=ask");
          else if (mode === "plan") baseArgs.push("--mode=plan");
          else baseArgs.push("-f");
          baseArgs.push("--resume", sessionId, content);

          insertSessionMessage(seenDb, sessionId, "user", content);

          const proc = spawn({
            cmd: baseArgs,
            stdout: "pipe",
            stderr: "pipe",
            stdin: "ignore",
          });

          proc.exited.then(async (exitCode) => {
            const out = await new Response(proc.stdout).text();
            const err = await new Response(proc.stderr).text();
            const combined = (out + (err ? "\n" + err : "")).trim() || "(no output)";
            insertSessionMessage(seenDb, sessionId, "assistant", combined);
            const prefix = `<${mode}> `;
            const fullReply = prefix + combined;
            const chunks = chunkMessage(fullReply);
            const total = chunks.length;
            for (let i = 0; i < chunks.length; i++) {
              const chunk = total > 1 ? `(${i + 1}/${total}) ${chunks[i]}` : chunks[i];
              try {
                await sendDm(pool, primaryRelay, botSecretKey, masterPubkey, chunk, signAuthEvent);
              } catch (e) {
                console.error("Failed to send DM chunk:", e);
              }
            }
          }).catch((err) => {
            console.error("Agent process error:", err);
            sendDm(pool, primaryRelay, botSecretKey, masterPubkey, `<${mode}> Error: ${String(err)}`, signAuthEvent).catch(
              (e) => console.error("Failed to send error DM:", e)
            );
          });
        } catch (err) {
          debug("Unwrap failed (not for us or wrong format):", err);
        }
      },
      onclose(reasons) {
        debug("Subscription closed:", reasons);
      },
    }
  );
}

export const PROFILE_RELAYS = new Set([
  'wss://purplepag.es',
  'wss://relay.nos.social',
  'wss://user.kindpag.es',
  'wss://relay.nostr.band',
]);

/** NIP-17: discover recipient's preferred DM relays from kind:10050 */
async function getMasterDmRelays(
  pool: SimplePool,
  botRelayUrl: string,
  masterPubkey: string
): Promise<string[]> {
  try {
    const events = await pool.querySync(
      Array.from(PROFILE_RELAYS.add(botRelayUrl)),
      { kinds: [10050], authors: [masterPubkey], limit: 1 }
    );
    
    if (events && events.length > 0) {
      const relayTags = events[0].tags.filter((t) => t[0] === "relay" && t[1]);
      const urls = relayTags.map((t) => ensureWss(t[1]));
      if (urls.length > 0) {
        debug("Master kind:10050 relays:", urls);
        return urls;
      }
    }
  } catch (err) {
    debug("Failed to fetch master kind:10050:", err);
  }
  debug("No kind:10050 for master, using bot relay");
  return [botRelayUrl];
}

async function sendDm(
  pool: SimplePool,
  botRelayUrl: string,
  senderSecretKey: Uint8Array,
  recipientPubkey: string,
  message: string,
  signAuthEvent: (template: EventTemplate) => Promise<VerifiedEvent>
) {
  const targetRelays = await getMasterDmRelays(pool, botRelayUrl, recipientPubkey);
  const recipientRelayHint = targetRelays[0] ?? botRelayUrl;

  const giftWrap = wrapEvent(
    senderSecretKey,
    { publicKey: recipientPubkey, relayUrl: recipientRelayHint },
    message
  );

  debug("Publishing to relays:", targetRelays, "event id:", giftWrap.id);
  await Promise.all(pool.publish(targetRelays, giftWrap, { onauth: signAuthEvent }));

  console.log(`[sent] ${message}`);
}

main();
