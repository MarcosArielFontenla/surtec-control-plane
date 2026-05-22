#!/usr/bin/env bash
set -euo pipefail

if command -v python3 >/dev/null 2>&1; then
  python_bin="python3"
elif command -v python >/dev/null 2>&1; then
  python_bin="python"
else
  python_bin=""
fi

if [ -n "$python_bin" ]; then
  "$python_bin" - <<'PY'
import json
from pathlib import Path

schema_paths = [
    Path("schemas/task-envelope.schema.json"),
    Path("schemas/agent-result.schema.json"),
]

for path in schema_paths:
    with path.open("r", encoding="utf-8") as handle:
        json.load(handle)

print("Schema validation passed.")
PY
elif command -v node >/dev/null 2>&1; then
  node - <<'JS'
const fs = require("fs");

const schemaPaths = [
  "schemas/task-envelope.schema.json",
  "schemas/agent-result.schema.json",
];

for (const path of schemaPaths) {
  JSON.parse(fs.readFileSync(path, "utf8"));
}

console.log("Schema validation passed.");
JS
else
  echo "Python or Node is required to validate JSON schemas." >&2
  exit 1
fi
