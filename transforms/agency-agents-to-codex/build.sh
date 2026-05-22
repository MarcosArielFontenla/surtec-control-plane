#!/usr/bin/env bash
set -euo pipefail

if [ "${SURTEC_EXECUTE:-0}" != "1" ]; then
  echo "Dry-run only. Set SURTEC_EXECUTE=1 after selecting reviewed agent candidates."
  exit 0
fi

echo "No automatic build is implemented yet."
echo "Select candidates manually, review governance fit, and generate Codex TOML profiles explicitly."

