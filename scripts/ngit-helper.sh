#!/bin/bash
# ngit-helper.sh — a workflow helper for ngit + git
# Usage: ./ngit-helper.sh

set -e

MAIN_BRANCH="main"

# ─── Colors ───────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ─── Helpers ──────────────────────────────────────────────
info()    { echo -e "${CYAN}==>${NC} $1"; }
success() { echo -e "${GREEN}✅ $1${NC}"; }
warn()    { echo -e "${YELLOW}⚠️  $1${NC}"; }
error()   { echo -e "${RED}❌ $1${NC}"; exit 1; }
prompt()  { echo -e "${BOLD}$1${NC}"; }

current_branch() {
  git rev-parse --abbrev-ref HEAD
}

require_clean_or_confirm() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    warn "You have uncommitted changes."
    read -rp "Continue anyway? (y/N): " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || error "Aborted."
  fi
}

handle_rebase_conflict() {
  echo ""
  warn "Rebase conflict detected!"
  echo ""
  echo "  To resolve:"
  echo "  1. Fix conflicts in VSCode or your editor"
  echo "  2. Run: git add ."
  echo "  3. Run: git rebase --continue"
  echo ""
  echo "  To abort and go back to where you started:"
  echo "  Run: git rebase --abort"
  echo ""
  exit 1
}

sync_main() {
  local stashed=false

  if ! git diff --quiet || ! git diff --cached --quiet; then
    info "Stashing uncommitted changes..."
    git stash push -m "ngit-helper auto-stash"
    stashed=true
  fi

  info "Fetching origin..."
  git fetch origin

  info "Pulling latest $MAIN_BRANCH..."
  git checkout "$MAIN_BRANCH"
  git pull origin "$MAIN_BRANCH"

  if [[ "$stashed" == true ]]; then
    info "Restoring stashed changes..."
    git stash pop
    success "Stash restored"
  fi
}

rebase_onto_main() {
  local branch="$1"
  info "Rebasing $branch onto $MAIN_BRANCH..."
  git checkout "$branch"
  git rebase "$MAIN_BRANCH" || handle_rebase_conflict
  success "$branch is up to date with $MAIN_BRANCH"
}

# ─── Commands ─────────────────────────────────────────────

cmd_status() {
  echo ""
  echo -e "${BOLD}📊 Repository Status${NC}"
  echo "─────────────────────────────────"
  echo -e "Current branch: ${CYAN}$(current_branch)${NC}"
  echo ""

  info "Local branches vs origin/main:"
  git for-each-ref --format='%(refname:short)' refs/heads/ | while read -r branch; do
    ahead=$(git rev-list --count "origin/$MAIN_BRANCH...$branch" 2>/dev/null || echo "?")
    behind=$(git rev-list --count "$branch...origin/$MAIN_BRANCH" 2>/dev/null || echo "?")
    if [[ "$branch" == "$MAIN_BRANCH" ]]; then
      echo -e "  ${GREEN}$branch${NC} (main)"
    else
      echo -e "  ${CYAN}$branch${NC} — ${ahead} ahead, ${behind} behind origin/main"
    fi
  done

  echo ""
  info "Open PRs:"
  ngit list 2>/dev/null || warn "Could not fetch ngit PR list"
  echo ""
}

cmd_init() {
  echo ""
  echo -e "${BOLD}🚀 Init: Sync main and set up dev branches${NC}"
  echo "─────────────────────────────────────────"

  sync_main
  success "main is up to date"

  echo ""
  info "Current branches:"
  git --no-pager branch

  echo ""
  echo "What do you want to do?"
  echo "  1) Create a new branch off main (e.g. feature/my-feature)"
  echo "  2) Switch to an existing branch and rebase it onto main"
  echo "  3) Nothing, I'm done"
  echo ""
  read -rp "Choose (1/2/3): " branch_choice

  if [[ "$branch_choice" == "1" ]]; then
    read -rp "New branch name (e.g. feature/my-feature): " new_branch
    info "Creating $new_branch from $MAIN_BRANCH..."
    git checkout -b "$new_branch"
    success "Created and switched to $new_branch"

  elif [[ "$branch_choice" == "2" ]]; then
    read -rp "Branch name to rebase: " new_branch
    if git show-ref --verify --quiet "refs/heads/$new_branch"; then
      rebase_onto_main "$new_branch"
    else
      error "Branch $new_branch does not exist."
    fi
  fi
}

cmd_sync() {
  echo ""
  echo -e "${BOLD}🔄 Sync: Rebase current branch onto main${NC}"
  echo "─────────────────────────────────────────"

  require_clean_or_confirm

  local branch
  branch=$(current_branch)

  if [[ "$branch" == "$MAIN_BRANCH" ]]; then
    info "Already on main, just pulling..."
    git pull origin "$MAIN_BRANCH"
  else
    sync_main
    rebase_onto_main "$branch"
  fi
}

cmd_pr_create() {
  echo ""
  echo -e "${BOLD}📬 PR Create: Push feature branch and open PR${NC}"
  echo "──────────────────────────────────────────────"

  require_clean_or_confirm

  local branch
  branch=$(current_branch)

  if [[ "$branch" == "$MAIN_BRANCH" ]]; then
    error "You're on main. Switch to a feature branch first."
  fi

  info "Syncing with main first..."
  sync_main
  rebase_onto_main "$branch"

  echo ""
  read -rp "PR title: " pr_title

  echo ""
  echo "PR description:"
  echo "  1) Enter a markdown file path (e.g. PR_DESCRIPTION.md)"
  echo "  2) Skip description"
  echo ""
  read -rp "Choose (1/2): " desc_choice

  info "Sending PR via ngit..."
  if [[ "$desc_choice" == "1" ]]; then
    read -rp "Markdown file path: " desc_file
    if [[ ! -f "$desc_file" ]]; then
      error "File not found: $desc_file"
    fi
    ngit send --title "$pr_title" --description "$(cat "$desc_file")"
  else
    ngit send --title "$pr_title"
  fi

  success "PR created for branch: $branch"
}

cmd_pr_update() {
  echo ""
  echo -e "${BOLD}✏️  PR Update: Add new commits to existing PR${NC}"
  echo "──────────────────────────────────────────────"

  require_clean_or_confirm

  local branch
  branch=$(current_branch)

  if [[ "$branch" == "$MAIN_BRANCH" ]]; then
    error "You're on main. Switch to your feature branch first."
  fi

  info "Detecting open PRs for branch: $branch..."
  local pr_list
  pr_list=$(ngit list 2>/dev/null)

  echo ""
  echo "$pr_list"
  echo ""

  # Try to auto-detect PR id by matching branch name
  local pr_id
  pr_id=$(ngit list 2>/dev/null | grep -i "$branch" | awk '{print $1}' | head -n1)

  if [[ -n "$pr_id" ]]; then
    info "Auto-detected PR id: $pr_id"
    read -rp "Use this PR id? (Y/n): " confirm
    if [[ "$confirm" =~ ^[Nn]$ ]]; then
      read -rp "Enter PR id manually: " pr_id
    fi
  else
    warn "Could not auto-detect PR id for branch $branch"
    read -rp "Enter PR id manually: " pr_id
  fi

  info "Syncing with main first..."
  sync_main
  rebase_onto_main "$branch"

  info "Sending PR update..."
  ngit send --in-reply-to "$pr_id"

  success "PR updated: $pr_id"
}

cmd_pr_merge() {
  echo ""
  echo -e "${BOLD}🔀 PR Merge: Merge feature branch into main${NC}"
  echo "────────────────────────────────────────────"

  require_clean_or_confirm

  local branch
  branch=$(current_branch)

  if [[ "$branch" == "$MAIN_BRANCH" ]]; then
    error "You're on main. Switch to the feature branch you want to merge first."
  fi

  info "Syncing with main first..."
  sync_main
  rebase_onto_main "$branch"

  echo ""
  echo "How do you want to merge?"
  echo "  1) Cherry-pick commit by commit (safe, avoids ngit push bugs)"
  echo "  2) Regular merge"
  echo ""
  read -rp "Choose (1/2): " merge_choice

  git checkout "$MAIN_BRANCH"

  if [[ "$merge_choice" == "1" ]]; then
    info "Cherry-picking commits from $branch onto main..."

    # Get commits in the feature branch that are not in main, oldest first
    local commits
    commits=$(git log "$MAIN_BRANCH..$branch" --oneline --reverse | awk '{print $1}')

    if [[ -z "$commits" ]]; then
      warn "No commits to cherry-pick. Branch may already be merged."
      exit 0
    fi

    echo ""
    echo "Commits to cherry-pick:"
    git log "$MAIN_BRANCH..$branch" --oneline --reverse
    echo ""

    for commit in $commits; do
      info "Cherry-picking $commit..."
      git cherry-pick "$commit" || {
        warn "Conflict on $commit!"
        echo ""
        echo "  To resolve:"
        echo "  1. Fix conflicts in your editor"
        echo "  2. Run: git add ."
        echo "  3. Run: git cherry-pick --continue"
        echo "  4. Then re-run this script to push"
        echo ""
        echo "  To abort: git cherry-pick --abort"
        exit 1
      }

      info "Pushing $commit..."
      git push origin "$MAIN_BRANCH"
    done

  elif [[ "$merge_choice" == "2" ]]; then
    info "Merging $branch into main..."
    git merge "$branch" || {
      warn "Merge conflict detected!"
      echo ""
      echo "  To resolve:"
      echo "  1. Fix conflicts in your editor"
      echo "  2. Run: git add ."
      echo "  3. Run: git merge --continue"
      echo "  4. Then push: git push origin main"
      exit 1
    }

    info "Pushing..."
    git push origin "$MAIN_BRANCH"
  else
    error "Invalid choice."
  fi

  success "Merged $branch into main!"

  echo ""
  read -rp "Delete local branch $branch? (y/N): " del_branch
  if [[ "$del_branch" =~ ^[Yy]$ ]]; then
    git branch -d "$branch"
    success "Deleted local branch $branch"
  fi
}

# ─── Menu ─────────────────────────────────────────────────

show_menu() {
  echo ""
  echo -e "${BOLD}🤖 ngit helper${NC}"
  echo "──────────────────────────────────"
  echo "  1) status     — show branches and open PRs"
  echo "  2) init       — sync main, create/rebase dev branch"
  echo "  3) sync       — rebase current branch onto main"
  echo "  4) pr create  — open a new PR"
  echo "  5) pr update  — push new commits to existing PR"
  echo "  6) pr merge   — merge feature branch into main"
  echo "  q) quit"
  echo ""
  read -rp "Choose: " choice

  case "$choice" in
    1) cmd_status ;;
    2) cmd_init ;;
    3) cmd_sync ;;
    4) cmd_pr_create ;;
    5) cmd_pr_update ;;
    6) cmd_pr_merge ;;
    q|Q) echo "Bye!"; exit 0 ;;
    *) warn "Invalid choice"; show_menu ;;
  esac
}

# ─── Entry point ──────────────────────────────────────────

# Allow direct subcommand: ./ngit-helper.sh sync
if [[ $# -gt 0 ]]; then
  case "$1" in
    status)    cmd_status ;;
    init)      cmd_init ;;
    sync)      cmd_sync ;;
    pr-create) cmd_pr_create ;;
    pr-update) cmd_pr_update ;;
    pr-merge)  cmd_pr_merge ;;
    *) error "Unknown command: $1. Valid: status, init, sync, pr-create, pr-update, pr-merge" ;;
  esac
else
  show_menu
fi