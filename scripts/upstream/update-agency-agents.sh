#!/usr/bin/env bash
set -euo pipefail

echo "agency-agents update preview"
echo "No catalog-wide import will be performed."
./transforms/agency-agents-to-codex/preview.sh
./transforms/agency-agents-to-codex/build.sh

