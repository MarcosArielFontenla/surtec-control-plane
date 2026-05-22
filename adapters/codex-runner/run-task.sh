#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <task-json-file>" >&2
}

if [ "$#" -ne 1 ]; then
  usage
  exit 2
fi

task_file="$1"

if [ ! -f "$task_file" ]; then
  echo "Task file not found: $task_file" >&2
  exit 1
fi

if command -v node >/dev/null 2>&1; then
  parser="node"
elif command -v python3 >/dev/null 2>&1; then
  parser="python3"
elif command -v python >/dev/null 2>&1; then
  parser="python"
else
  echo "Node or Python is required to parse the task JSON." >&2
  exit 1
fi

if [ "$parser" = "node" ]; then
  task_values="$(node -e '
const fs = require("fs");
const path = process.argv[1];
const task = JSON.parse(fs.readFileSync(path, "utf8"));
const required = ["id", "agent", "title", "instructions", "repo_path", "branch", "sandbox"];
for (const field of required) {
  if (!task[field]) {
    console.error(`Missing required task field: ${field}`);
    process.exit(1);
  }
}
const encoded = [
  task.id,
  task.agent,
  task.title,
  task.instructions,
  task.repo_path,
  task.branch,
  task.sandbox
].map((value) => Buffer.from(String(value), "utf8").toString("base64"));
console.log(encoded.join("\t"));
' "$task_file")"
else
  task_values="$("$parser" - "$task_file" <<'PY'
import base64
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    task = json.load(handle)

required = ["id", "agent", "title", "instructions", "repo_path", "branch", "sandbox"]
for field in required:
    if not task.get(field):
        print(f"Missing required task field: {field}", file=sys.stderr)
        sys.exit(1)

values = [
    task["id"],
    task["agent"],
    task["title"],
    task["instructions"],
    task["repo_path"],
    task["branch"],
    task["sandbox"],
]
print("\t".join(base64.b64encode(str(value).encode("utf-8")).decode("ascii") for value in values))
PY
)"
fi

decode_b64() {
  if command -v base64 >/dev/null 2>&1; then
    printf '%s' "$1" | base64 --decode
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import base64,sys; print(base64.b64decode(sys.argv[1]).decode(), end="")' "$1"
  else
    python -c 'import base64,sys; print(base64.b64decode(sys.argv[1]).decode(), end="")' "$1"
  fi
}

IFS=$'\t' read -r id_b64 agent_b64 title_b64 instructions_b64 repo_path_b64 branch_b64 sandbox_b64 <<< "$task_values"

task_id="$(decode_b64 "$id_b64")"
agent="$(decode_b64 "$agent_b64")"
title="$(decode_b64 "$title_b64")"
instructions="$(decode_b64 "$instructions_b64")"
repo_path="$(decode_b64 "$repo_path_b64")"
branch="$(decode_b64 "$branch_b64")"
sandbox="$(decode_b64 "$sandbox_b64")"

case "$repo_path" in
  "~/"*) repo_path="${HOME}/${repo_path#~/}" ;;
esac

if [ ! -d "$repo_path" ]; then
  echo "Repository path does not exist: $repo_path" >&2
  exit 1
fi

mkdir -p reports
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
log_path="reports/${task_id}-${agent}-${timestamp}.jsonl"
prompt="Task ${task_id}: ${title}

Agent: ${agent}
Branch: ${branch}

Instructions:
${instructions}

Return summary, files changed, commands run, tests run, risks, blockers, and next steps.
Do not merge. Do not deploy. Do not touch secrets."

codex_command=(codex exec --sandbox "$sandbox" --json "$prompt")

echo "Task: $task_id"
echo "Agent: $agent"
echo "Repository: $repo_path"
echo "Sandbox: $sandbox"
echo "Log: $log_path"
echo "Command dry-run:"
printf '  cd %q && ' "$repo_path"
printf '%q ' "${codex_command[@]}"
echo

if [ "${SURTEC_EXECUTE:-0}" = "1" ]; then
  echo "SURTEC_EXECUTE=1 detected. Running Codex CLI."
  (
    cd "$repo_path"
    "${codex_command[@]}"
  ) | tee "$log_path"
else
  echo "Dry-run only. Set SURTEC_EXECUTE=1 to run."
  printf '{"task_id":"%s","agent":"%s","mode":"dry-run","repo_path":"%s","sandbox":"%s"}\n' "$task_id" "$agent" "$repo_path" "$sandbox" > "$log_path"
fi

