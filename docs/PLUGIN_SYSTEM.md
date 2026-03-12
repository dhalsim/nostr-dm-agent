# Plugin System Specification

## Overview

Extensible plugin architecture for the nostr-dm-bot. Core features (todos, jobs, tasks) are first-class plugins. Third-party plugins can be installed separately.

## Core Concepts

### Plugin

A self-contained module that provides capabilities and handles commands.

### Capability

A named feature a plugin provides (e.g., `todos`, `jobs`, `git`). Versioned.

### Command

A user-invokable action, exposed by plugins.

## Plugin Structure

```
my-plugin/
├── manifest.json      # Metadata, dependencies, capabilities
├── src/
│   ├── index.ts       # Plugin entry point
│   ├── commands/      # Command handlers
│   └── capabilities/ # Capability implementations
└── ui/                # Optional UI specs (declarative)
```

### manifest.json

```json
{
  "name": "jobs",
  "version": "1.2.0",
  "description": "Job tracking and management",
  "author": "bot-core",
  "apiVersion": "1.0.0",

  "provides": [
    { "name": "jobs", "version": "1.0.0" }
  ],

  "requires": [
    { "name": "storage", "version": ">=2.0.0" },
    { "name": "ai", "version": "^1.0.0" }
  ],

  "commands": [
    {
      "name": "job list",
      "inputMode": "direct",
      "description": "List all jobs"
    },
    {
      "name": "job create",
      "inputMode": "form",
      "ui": { "fields": [...] }
    }
  ],

  "capabilities": {
    "uiComponents": ["actionButton", "expandable", "list"]
  }
}
```

## Versioning Strategy

### API Version (semver)

Bot declares supported plugin API version. Plugins declare required version.

```
apiVersion: "1.0.0"  // Plugin requires
botSupports: "^1.0.0" // Bot declares
```

Compatibility: Plugin's required version must fall within Bot's supported range.

### Plugin Version

Each plugin versions independently. Follows semver (major.minor.patch).

### Capability Version

Each capability has version. Allows incremental capability changes.

```typescript
{
  name: 'todos',
  version: '1.2.0',  // Capability version, separate from plugin version
}
```

### Data Schema Version

Storage layer versions data structures. Migrations handled by storage plugin.

## Capability System

### Declaration

Plugins declare what they provide and what they need.

```typescript
// Plugin A
provides: [{ name: 'storage', version: '2.0.0' }];
requires: [];

// Plugin B
provides: [{ name: 'todos', version: '1.0.0' }];
requires: [{ name: 'storage', version: '>=2.0.0' }];
```

### Resolution

At startup, Bot resolves dependency graph:

1. Collect all plugins
2. Check capability compatibility
3. Warn on missing dependencies
4. Warn on version conflicts
5. Load in dependency order

### Built-in Capabilities

| Capability | Description                           |
| ---------- | ------------------------------------- |
| `storage`  | Key-value persistence with versioning |
| `ai`       | AI inference interface                |
| `nostr`    | Nostr message send/receive            |
| `commands` | Command registration                  |
| `ui`       | UI component rendering                |

## Command Interface

### Handler Signature

```typescript
interface CommandHandler {
  (ctx: CommandContext): Promise<CommandResult>;
}

interface CommandContext {
  userId: string;
  botId: string;
  args: string[];
  raw: string;
  capabilities: Map<string, any>;
}

interface CommandResult {
  type: 'text' | 'form' | 'preview' | 'error';
  content: string;
  ui?: UiSpec;
}
```

### Form UI Spec

```typescript
interface FormSpec {
  fields: FieldSpec[];
  submitLabel?: string;
}

interface FieldSpec {
  name: string;
  type: 'text' | 'textarea' | 'url' | 'number' | 'select' | 'checkbox';
  label: string;
  required?: boolean;
  placeholder?: string;
  options?: string[]; // For select
  default?: any;
}
```

### Preview UI Spec

```typescript
interface PreviewSpec {
  content: string;
  actions: ActionSpec[];
}

interface ActionSpec {
  label: string;
  command: string; // Supports {var} interpolation
}
```

## UI Components (Declarative)

Plugins return UI specs, NOT code. Client interprets and renders.

### Supported Components

- `actionButton`: Tap triggers command
- `expandable`: Collapsed/expanded sections
- `statusCard`: Summary + actions
- `list`: Tappable rows
- `codeBlock`: Syntax-highlighted code

### Example: Job Card (from jobs plugin)

```json
{
  "type": "preview",
  "content": "Senior Engineer @ Acme\n$150k/yr",
  "actions": [
    { "label": "Apply", "command": "/job apply {id}" },
    { "label": "Edit", "command": "/job edit {id}" }
  ]
}
```

Client renders as rich card on mobile, text + buttons in terminal.

## Plugin Lifecycle

```
Loading → Resolving Dependencies → Initializing → Running
     ↓
  Unloading (on disable/uninstall)
```

### Initialization

```typescript
interface Plugin {
  init(ctx: PluginContext): Promise<void>;
  shutdown(): Promise<void>;
}

interface PluginContext {
  getCapability(name: string): any;
  registerCommand(cmd: CommandSpec): void;
  storage: StorageCapability;
}
```

## Security

- **No code execution**: UI specs are declarative data
- **Capability sandboxing**: Plugins only access declared capabilities
- **Command validation**: All commands validated before execution
- **Storage isolation**: Plugins access only their own data namespace

## Migration: Existing Features

### Todos → Plugin

1. Extract to `plugins/todos/`
2. Create manifest.json
3. Define capabilities: `todos`
4. Add UI specs for forms/previews

### Tasks/Jobs → Plugin

1. Extract to `plugins/jobs/`
2. Create manifest.json
3. Define capabilities: `jobs`, `job-ai`
4. Add AI-specific command handlers

### Commands → Plugin

Each command family becomes a plugin:

- `plugins/todos` - `/todo *`
- `plugins/jobs` - `/job *`
- `plugins/git` - `/git *`

## Plugin Registry

### Local (Development)

```json
{
  "plugins": {
    "todos": { "enabled": true, "path": "./plugins/todos" },
    "jobs": { "enabled": true, "path": "./plugins/jobs" }
  }
}
```

### Remote (Future)

- Nostr-based plugin discovery
- Install from npub
- Verify signed manifests

## File Structure

```
.opencode/
├── plugins/
│   ├── todos/
│   │   ├── manifest.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── commands/
│   │       └── storage/
│   └── jobs/
│       ├── manifest.json
│       └── src/
│           ├── index.ts
│           ├── commands/
│           └── ai/
├── plugin.json        # Registry config
└── capabilities/      # Built-in capability interfaces
```

## Open Questions

1. **Plugin distribution**: Local only, or Nostr-based registry?
2. **Hot reload**: Support during development?
3. **Plugin dependencies**: How to handle circular deps?
4. **Migration**: How to handle user data when plugin updates schema?
5. **Discovery**: How do users find available plugins?
