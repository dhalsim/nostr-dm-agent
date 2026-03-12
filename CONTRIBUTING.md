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

## For Users: Understanding Bot Updates

When updating the bot, check the version bump to understand the impact:

- **PATCH bump** (e.g., 1.0.0 → 1.0.1): Bug fixes, no breaking changes. Safe to update.
- **MINOR bump** (e.g., 1.0.0 → 1.1.0): New features, backward-compatible. Safe to update.
- **MAJOR bump** (e.g., 1.0.0 → 2.0.0): Breaking changes. Review release notes before updating.

Check the current version in `package.json`.

## For Developers: Using ngit-helper.sh

This project uses [ngit](https://gitworkshop.dev/danconwaydev.com/ngit) for Git workflow. The `ngit-helper.sh` script provides a workflow helper for ngit.

```bash
./ngit-helper.sh
```

This script provides a workflow helper for ngit.