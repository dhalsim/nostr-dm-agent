# Contributing

## Setup

After cloning, run this once to enable the version bump hook:

```bash
bun run contrib:setup
```

This makes Git load the repo’s `.gitconfig` (which sets `core.hooksPath = scripts`), so the `commit-msg` and `post-commit` hooks run.

## Versioning

This project uses [Semantic Versioning](https://semver.org/).

| Increment | Use when |
|-----------|----------|
| **PATCH** (x.y.Z) | Bug fixes, small improvements |
| **MINOR** (x.Y.0) | New features, backward-compatible changes |
| **MAJOR** (X.0.0) | Breaking changes |

### Making a Release Commit

When merging a PR or releasing, include a version bump flag in your commit message:

```bash
git commit -m "fix: bug fix --patch"   # bumps patch (e.g., 1.0.0 → 1.0.1)
git commit -m "feat: new feature --minor"   # bumps minor (e.g., 1.0.0 → 1.1.0)
git commit -m "chore: breaking change --major" # bumps major (e.g., 1.0.0 → 2.0.0)
```

After the hook amends the commit with the new version, it **creates an annotated git tag** `vX.Y.Z` (skipped if that tag already exists), **regenerates `CHANGELOG.md`** from tags, and **amends the commit again** so the changelog is included. If a new tag was created, it is **moved** to the final amended commit so it still points at the release. Patch, minor, and major bumps follow the same flow.

To rewrite `CHANGELOG.md` from tags only (e.g. after fixing tags by hand), you can run:

```bash
bun run release:changelog
```

## For Users: Understanding Bot Updates

When updating the bot, check the version bump to understand the impact:

- **PATCH bump** (e.g., 1.0.0 → 1.0.1): Bug fixes, no breaking changes. Safe to update.
- **MINOR bump** (e.g., 1.0.0 → 1.1.0): New features, backward-compatible. Safe to update.
- **MAJOR bump** (e.g., 1.0.0 → 2.0.0): Breaking changes. Review release notes before updating.

Check the current version in `package.json`.

## Plugins (separate Git repo under `plugins/<alias>/`)

If you use a **nested** Git repo for a plugin (for example `git init` in `plugins/todo` so you can tag releases separately), you can reuse the **same** hook scripts as the core repo—no need to copy `commit-msg` / `post-commit` into the plugin folder.

From the plugin directory (repository root of that plugin), run once to point Git at the parent dm-bot `scripts` directory (same hooks as the core repo):

```bash
bun run contrib:setup
```

Use the same commit messages as above (`--patch` / `--minor` / `--major`). The hooks bump **`package.json` in that plugin’s work tree**, not the dm-bot root.

If the plugin is cloned **standalone** (not inside a dm-bot checkout), copy the `scripts/` hook files from this repo or set `core.hooksPath` to an absolute path to your dm-bot `scripts` directory on that machine.

## For Developers: Using ngit-helper.sh

This project uses [ngit](https://gitworkshop.dev/danconwaydev.com/ngit) for Git workflow. The `ngit-helper.sh` script provides a workflow helper for ngit.

```bash
./ngit-helper.sh
```

This script provides a workflow helper for ngit.