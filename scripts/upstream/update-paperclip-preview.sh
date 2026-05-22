#!/usr/bin/env bash
set -euo pipefail

echo "Paperclip update preview"
echo "No changes will be applied."
./scripts/upstream/generate-diff-report.sh
echo "Review Paperclip release notes and adapter compatibility before any update."

