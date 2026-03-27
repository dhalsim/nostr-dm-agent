---
name: bot-release
description: >-
  Summarize working-tree changes (staged and unstaged) with a one-line commit
  message for version commits. Use when preparing a release commit or reviewing
  uncommitted work.
---

## Working tree: summary and suggested commit line

1. Collect **both** unstaged and staged changes:
   - `git --no-pager diff` — unstaged vs index
   - `git --no-pager diff --staged` — staged vs `HEAD`
2. Summarize what changed in plain language (scope, files touched, behavior).
3. Propose **one short sentence** for the commit subject. Match project style from [CONTRIBUTING.md](../../../CONTRIBUTING.md) (e.g. conventional type and `--patch` / `--minor` / `--major`).

## Changelog and tags

Releases use the hooks in CONTRIBUTING: version bump, `vX.Y.Z` tag, and `CHANGELOG.md` are updated automatically on those commits. To refresh the changelog from tags only: `bun run release:changelog`.
