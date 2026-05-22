#!/usr/bin/env bash
set -euo pipefail

echo "Argentine legal reference update preview"
echo "Human legal review is required before applying generated skill updates."
./transforms/legal-ar-to-codex-skills/preview.sh
./transforms/legal-ar-to-codex-skills/build.sh

