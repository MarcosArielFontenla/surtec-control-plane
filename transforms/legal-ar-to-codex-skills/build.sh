#!/usr/bin/env bash
set -euo pipefail

if [ "${SURTEC_EXECUTE:-0}" != "1" ]; then
  echo "Dry-run only. Set SURTEC_EXECUTE=1 after human legal review approves selected sources."
  exit 0
fi

echo "No automatic legal skill build is implemented yet."
echo "Human legal review is required before generating or updating legal skills."

