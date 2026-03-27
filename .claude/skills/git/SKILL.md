---
name: git
description: Show git status, diff, and log for the current workspace.
---

## Usage

```bash
# Status
git status --short

# Diff (unstaged)
git --no-pager diff

# Diff (staged)
git --no-pager diff --staged

# Diff summary only
git --no-pager diff --stat

# Last N commits
git --no-pager log --oneline -10

# Diff since last commit
git --no-pager diff HEAD~1
```

## Current status
!`git status --short`

## Unstaged changes
!`git --no-pager diff --stat`

## Recent commits
!`git --no-pager log --oneline -10`
