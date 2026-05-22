#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <project-id> <agent-id> <task-id> <task-text>" >&2
}

if [ "$#" -ne 4 ]; then
  usage
  exit 2
fi

project_id="$1"
agent_id="$2"
task_id="$3"
task_text="$4"

if [ ! -f registry/projects.yml ]; then
  echo "registry/projects.yml not found. Run this from the control plane root." >&2
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  python_bin="python3"
elif command -v python >/dev/null 2>&1; then
  python_bin="python"
else
  echo "Python is required to resolve project paths." >&2
  exit 1
fi

repo_path="$("$python_bin" - "$project_id" <<'PY'
import re
import sys

project_id = sys.argv[1]
path = None
in_project = False

with open("registry/projects.yml", "r", encoding="utf-8") as handle:
    for raw_line in handle:
        line = raw_line.rstrip("\n")
        if re.match(rf"^  {re.escape(project_id)}:\s*$", line):
            in_project = True
            continue
        if in_project and re.match(r"^  [A-Za-z0-9_-]+:\s*$", line):
            break
        if in_project:
            match = re.match(r"^    local_path:\s*(.+?)\s*$", line)
            if match:
                path = match.group(1)
                break

if not path:
    print(f"Project not found or missing local_path: {project_id}", file=sys.stderr)
    sys.exit(1)

print(path)
PY
)"

case "$repo_path" in
  "~/"*) repo_path="${HOME}/${repo_path#~/}" ;;
esac

mkdir -p reports tmp
task_file="tmp/${task_id}-${agent_id}.json"
branch="agent/${task_id}-${agent_id}"

"$python_bin" - "$task_file" "$project_id" "$agent_id" "$task_id" "$task_text" "$repo_path" "$branch" <<'PY'
import json
import sys

task_file, project_id, agent_id, task_id, task_text, repo_path, branch = sys.argv[1:]
task = {
    "id": task_id,
    "source": "surtec-cli",
    "project": project_id,
    "task_type": "manual",
    "agent": agent_id,
    "title": task_text[:80],
    "instructions": task_text,
    "repo_path": repo_path,
    "branch": branch,
    "sandbox": "workspace-write",
    "expected_outputs": [
        "summary",
        "files_changed",
        "commands_run",
        "tests_run",
        "risks",
        "next_steps",
    ],
    "requires_human_approval": True,
    "metadata": {
        "created_by": "scripts/projects/run-codex-task.sh",
    },
}

with open(task_file, "w", encoding="utf-8") as handle:
    json.dump(task, handle, indent=2)
    handle.write("\n")
PY

echo "Generated task envelope: $task_file"
./adapters/codex-runner/run-task.sh "$task_file"

