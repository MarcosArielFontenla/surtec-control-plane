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

if [ -n "$(git -C "$repo_path" status --porcelain)" ]; then
  echo "Repository has uncommitted changes. Refusing to create agent branch." >&2
  exit 1
fi

safe_task_id="$(printf '%s' "$task_id" | tr -cs '[:alnum:]_.-' '-' | sed 's/^-//; s/-$//')"
safe_agent_id="$(printf '%s' "$agent_id" | tr -cs '[:alnum:]_.-' '-' | sed 's/^-//; s/-$//')"
branch="agent/${safe_task_id}-${safe_agent_id}"

git -C "$repo_path" switch -c "$branch"
echo "Created branch $branch in $repo_path"
echo "No push was performed."

