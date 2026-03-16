# Plugin System

The bot supports plugins that extend its functionality with new commands and AI tools. Plugins are self-contained packages hosted on Nostr (via ngit) or GitHub, installed and managed via built-in scripts.

---

## For Plugin Users

### Installing a plugin

```bash
bun run plugin:install
```

This opens an interactive discovery flow:

1. Queries well-known Nostr relays for available plugins
2. Lists them with compatibility status against your bot version
3. You pick one and choose a short **alias** (e.g. `todo`, `jobs`)
4. The plugin is cloned into `plugins/<alias>/`
5. `plugins.json` is updated
6. OpenCode tool definitions and bot registration are generated automatically

The alias you choose becomes the command prefix (`!todo list`) and the folder name (`plugins/todo/`). Keep it short and memorable.

### Updating a plugin

```bash
bun run plugin:install todo
```

Pass the alias of an already-installed plugin. The script fetches the latest compatible version from the plugin's Nostr event, runs `git fetch --tags && git checkout <new-tag>` in the plugin folder, and re-runs the generators. Your plugin's database (`plugins/todo/db.sqlite`) is never touched.

### Listing installed plugins

Check `plugins.json` in the bot root:

```json
{
  "plugins": [
    {
      "alias": "todo",
      "repo": "nostr://npub1.../dm-bot-todo-plugin",
      "version": "v1.0.1"
    }
  ]
}
```

### Using a plugin

Once installed, plugins register their commands under the alias you chose. Run:

```
!todo help
```

to see available commands for that plugin. All plugin commands follow the same `!<alias> <subcommand>` pattern.

Plugin AI features work with the OpenCode backend — the plugin's tools appear in OpenCode as `<alias>_list`, `<alias>_create`, etc. You can ask the agent to manage plugin data in natural language and it will use these tools automatically.

### Version compatibility

Each plugin declares which bot core major version it supports. If your bot is on core `5` and the plugin only has a ref for core `4`, the installer will warn you and offer to install the older compatible version, or suggest upgrading the bot.

### Uninstalling a plugin

Currently manual:

1. Delete the `plugins/<alias>/` folder
2. Remove the entry from `plugins.json`
3. Run `bun run plugin:generate` to regenerate bot registration and OpenCode tools

---

## For Plugin Authors

### Plugin structure

A plugin is a git repository with this structure:

```
my-plugin/
  package.json          ← metadata + coreApiVersion
  init.ts               ← exports the BotPlugin object
  opencode.ts           ← exports createToolDefinitions() and agentInstructions()
  db.ts                 ← SQLite schema and CRUD
  format.ts             ← display helpers
  types.ts              ← Zod schemas and TypeScript types
  drafts.ts             ← draft persistence (if using draft/confirm flow)
```

### `package.json`

```json
{
  "name": "dm-bot-todo-plugin",
  "version": "1.0.1",
  "description": "Todo management plugin for dm-bot",
  "dmBot": {
    "coreApiVersion": "5"
  }
}
```

The `dmBot.coreApiVersion` field declares the bot core major version this release supports. This is used by the installer for compatibility checking.

### `init.ts` — the plugin object

Every plugin exports a `BotPlugin` object:

```typescript
export const TodoPlugin: BotPlugin = {
  identity: {
    name: 'dm-bot-todo-plugin',
    alias: 'todo',           // default alias (user can override at install time)
    version: '1.0.1',
  },
  onInit(db: Database): void {
    // Run migrations, set up tables
    createTodoTable(db);
    createTodoDraftsTable(db);
  },
  async handler(args: string[], ctx: PluginContext): Promise<string> {
    // Dispatch subcommands: args[0] is the subcommand
    return handleTodo({ args, db: ctx.pluginDb, runAgent: ctx.runAgent, identity: this.identity });
  },
  helpText(alias: string): string {
    return `${alias}:\n!${alias} list — list todos\n!${alias} ai <prompt> — natural language`;
  },
};
```

The plugin receives a dedicated SQLite database (`ctx.pluginDb`) scoped to its alias, and a `runAgent` function for making AI calls.

### `opencode.ts` — AI tool definitions

This file bridges your plugin to OpenCode's tool system. It exports two things:

**`createToolDefinitions(alias)`** — returns the tool definitions array. Each entry is passed directly to OpenCode's `tool()` function:

```typescript
export function createToolDefinitions(alias: string) {
  const dbPath = join(dmBotRoot, 'plugins', alias, 'db.sqlite');
  const cmd = `!${alias}`;

  function openDb(): Database { ... }

  return [
    {
      name: 'list',
      description: 'List all todos...',
      args: {
        filter: tool.schema.enum(['pending', 'done', 'all']).optional(),
      },
      execute: async (args, _context) => {
        const db = openDb();
        // ...
      },
    },
    // create, update, delete...
  ] as const;
}
```

**`agentInstructions(alias)`** — returns a Markdown string injected into `AGENTS.md`:

```typescript
export function agentInstructions(alias: string): string {
  return `## ${alias} tools\n\nWhen the user asks to manage todos:\n- Always use the ${alias}_* tools...`;
}
```

Note: `args` must use `tool.schema.*` (OpenCode's Zod v3 DSL), not your own Zod v4 instance. Use your own Zod only inside `execute` bodies for runtime validation.

### The draft/confirm flow

Plugins that mutate data should use a draft/confirm pattern — the AI proposes a change, the user reviews and accepts it via a bot command. This prevents unintended modifications:

1. Tool `execute` calls `storeDraft(db, { kind, input, originalPrompt })` and returns a formatted preview with a Draft ID
2. User runs `!<alias> accept <id>` to apply, `!<alias> revise <id> <corrections>` to revise, or `!<alias> decline <id>` to cancel
3. The `handler` in `init.ts` dispatches these subcommands

### Publishing a plugin

#### 1. Tag your release

Bump the version in `package.json`:
```json
{
  "version": "1.0.1"
}
```

Then tag and push:
```bash
git tag -a v1.0.1 -m "Release v1.0.1"
git push origin v1.0.1
```

#### 2. Publish the Nostr event

```bash
bun run plugin:publish
```

This reads your `package.json`, fetches the existing kind `32107` event from relays (if any), appends the new ref, and republishes. You sign with a NIP-46 bunker — your key never leaves your signer app.

The published event looks like:

```json
{
  "kind": 32107,
  "tags": [
    ["d", "dm-bot-todo-plugin"],
    ["description", "Todo management plugin for dm-bot"],
    ["version", "v1.0.1"],
    ["coreApiVersion", "5"],
    ["t", "dm-bot-plugin"],
    ["ref", "v1.0.0", "5", "Initial release"],
    ["ref", "v1.0.1", "5", "Fix parent_id coercion"]
  ]
}
```

Each `ref` tag carries the git tag, the supported core major, and a changelog line. Multiple refs coexist — older versions remain installable by users on older bot versions.

#### Supporting multiple core major versions

If you want to support both core `4` and core `5`:

```json
["ref", "v1.2.3", "4", "last release for core 4"]
["ref", "v2.0.0", "5", "core 5 support"]
```

Users on core `4` will get `v1.2.3`, users on core `5` will get `v2.0.0`. The installer picks the latest compatible ref automatically.

### Code generation

The bot uses two generated files that are updated automatically when you run `bun run plugin:install` or `bun run plugin:generate`:

**`.opencode/tools/<alias>.ts`** — thin wrapper that imports your `createToolDefinitions` and exports named tool constants for OpenCode:

```typescript
// AUTO-GENERATED
import { tool } from '@opencode-ai/plugin';
import { createToolDefinitions } from '../../plugins/todo/opencode';

const defs = createToolDefinitions('todo');

export const _list = tool(defs[0]);
export const _create = tool(defs[1]);
export const _update = tool(defs[2]);
export const _delete = tool(defs[3]);
```

**`generated/plugins.ts`** — registers all installed plugins at bot startup:

```typescript
// AUTO-GENERATED
import { registerPlugin } from '../src/core/registry';
import { TodoPlugin } from '../plugins/todo/init';

export function registerPlugins(dataDir: string): void {
  registerPlugin(TodoPlugin, dataDir);
}
```

Both files are in `.gitignore` and regenerated on every install/update.

### NIP-05 and npub repo URLs

Plugin repo URLs support both formats:

- `nostr://npub1abc.../dm-bot-todo-plugin` — direct npub
- `nostr://_@yourdomain.com/dm-bot-todo-plugin` — NIP-05 identity

The installer resolves NIP-05 identities via `.well-known/nostr.json` automatically.