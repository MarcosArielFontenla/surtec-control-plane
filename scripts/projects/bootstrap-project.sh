#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <project-name> <local-path>" >&2
}

if [ "$#" -ne 2 ]; then
  usage
  exit 2
fi

project_name="$1"
project_path="$2"

case "$project_path" in
  "~/"*) project_path="${HOME}/${project_path#~/}" ;;
esac

if [ ! -d "$project_path" ]; then
  echo "Project path does not exist: $project_path" >&2
  exit 1
fi

mkdir -p "$project_path/docs/superpowers/specs"
mkdir -p "$project_path/docs/superpowers/plans"

agents_file="$project_path/AGENTS.md"

if [ -e "$agents_file" ]; then
  echo "AGENTS.md already exists in $project_path. Leaving it unchanged."
else
  {
    echo "# ${project_name} Agent Rules"
    echo
    echo "- Follow the project owner's instructions."
    echo "- Keep implementation artifacts in English."
    echo "- Do not deploy, merge, push, or touch secrets without explicit approval."
    echo "- Use task branches or worktrees for agent work."
    echo "- Return summary, files changed, commands run, tests run, risks, and next steps."
  } > "$agents_file"
  echo "Created $agents_file"
fi

echo "Prepared Surtec Control Plane integration for $project_name at $project_path"

