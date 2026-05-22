#!/usr/bin/env bash
set -euo pipefail

echo "Superpowers update preview"
echo "No changes will be applied."
./scripts/upstream/generate-diff-report.sh
echo "Review methodology changes before adopting them in Surtec workflows."

