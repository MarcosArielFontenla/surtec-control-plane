#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <repo-path> <task-id> <agent-id>" >&2
}

if [ "$#" -ne 3 ]; then
  usage
  exit 2
fi

repo_path="$1"
task_id="$2"
agent_id="$3"

case "$repo_path" in
  "~/"*) repo_path="${HOME}/${repo_path#~/}" ;;
esac

if [ ! -d "$repo_path/.git" ]; then
  echo "Not a git repository: $repo_path" >&2
  exit 1
fi

repo_name="$(basename "$repo_path")"
safe_task_id="$(printf '%s' "$task_id" | tr -cs '[:alnum:]_.-' '-' | sed 's/^-//; s/-$//')"
safe_agent_id="$(printf '%s' "$agent_id" | tr -cs '[:alnum:]_.-' '-' | sed 's/^-//; s/-$//')"
branch="agent/${safe_task_id}-${safe_agent_id}"
worktree_root="$(cd "$repo_path/.." && pwd)/surtec-worktrees"
worktree_path="${worktree_root}/${repo_name}-${safe_task_id}-${safe_agent_id}"

mkdir -p "$worktree_root"
git -C "$repo_path" worktree add -b "$branch" "$worktree_path"

echo "Created worktree $worktree_path on branch $branch"

