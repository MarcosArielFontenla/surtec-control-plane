#!/usr/bin/env bash
set -euo pipefail

required_files=(
  "registry/companies.yml"
  "registry/projects.yml"
  "registry/agents.yml"
  "registry/routines.yml"
  "registry/permissions.yml"
  "registry/upstreams.yml"
)

for file in "${required_files[@]}"; do
  if [ ! -f "$file" ]; then
    echo "Missing registry file: $file" >&2
    exit 1
  fi
done

if command -v python3 >/dev/null 2>&1; then
  python_bin="python3"
elif command -v python >/dev/null 2>&1; then
  python_bin="python"
else
  echo "Python not found. Registry existence validation passed; YAML parsing skipped."
  exit 0
fi

"$python_bin" - <<'PY'
from pathlib import Path
import sys

files = [
    Path("registry/companies.yml"),
    Path("registry/projects.yml"),
    Path("registry/agents.yml"),
    Path("registry/routines.yml"),
    Path("registry/permissions.yml"),
    Path("registry/upstreams.yml"),
]

try:
    import yaml  # type: ignore
except Exception:
    print("PyYAML not available. Registry existence validation passed; YAML parsing skipped.")
    sys.exit(0)

for path in files:
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    if data is None:
        raise SystemExit(f"Registry file is empty: {path}")

print("Registry validation passed.")
PY

