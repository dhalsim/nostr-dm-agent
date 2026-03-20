# dm-bot plugin tools

This repo uses a CLI-based tool system for AI agents.

## How to call tools

Each plugin exposes tools via bash:

\`\`\`bash
bun src/cli.ts <alias> <toolName> '<json>'
bun src/cli.ts <alias>              # print full JSON schema for plugin
bun src/cli.ts                      # list all plugins and tools
\`\`\`

## Draft system

All mutating operations (create, update, delete) return a **draft** for user review.
The user accepts/revises/declines via bot DM commands shown in the tool output.
Never retry a mutating tool if it returned a Draft ID.

## Available plugins

Plugins are discovered from \`plugins.json\`. Load the relevant skill for each plugin:
- \`.claude/skills/dm-bot-<alias>/SKILL.md\`
