---
name: dm-bot-workspace
description: Load the workspace file tree for navigation and context
allowed-tools: Bash
---

## Workspace overview (depth 2)
!`bun run scripts/workspace-tree.ts 2`

## Key directories (depth 3)
!`bun run scripts/workspace-tree.ts 3 src`
!`bun run scripts/workspace-tree.ts 3 plugins`
!`bun run scripts/workspace-tree.ts 3 scripts`
!`bun run scripts/workspace-tree.ts 3 generated`