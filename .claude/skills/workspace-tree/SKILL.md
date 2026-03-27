---
name: workspace-tree
description: Load the workspace file tree for navigation and context via the file plugin CLI.
---

## Usage

Tree is provided by the **file** plugin (`!file tree` in DMs, or CLI below). Roots follow the current workspace target (!workspace).

```bash
# JSON args: max_depth (required), target_dir (null = root), extensions (null = all)
bun src/cli.ts file tree '{"max_depth":0,"target_dir":null,"extensions":null}'

bun src/cli.ts file tree '{"max_depth":2,"target_dir":null,"extensions":null}'

bun src/cli.ts file tree '{"max_depth":3,"target_dir":"src","extensions":null}'

bun src/cli.ts file tree '{"max_depth":2,"target_dir":".","extensions":["ts","tsx"]}'

bun src/cli.ts file tree '{"max_depth":2,"target_dir":"plugins","extensions":["ts","md"]}'
```

## DM (same semantics as the old script)

```
!file tree 0
!file tree 1
!file tree 2
!file tree 3 src
!file tree 3 plugins
!file tree 3 scripts
!file tree 3 generated
!file tree 2 . --ext ts,tsx
```

See also: skill **dm-bot-file** (from `bun run plugin:generate`) for full tool schema.
