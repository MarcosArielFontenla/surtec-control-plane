#!/usr/bin/env bash
set -euo pipefail

upstream_dir="upstreams/claude-for-legal-argentina"

echo "Previewing Argentine legal reference files."

if [ ! -d "$upstream_dir/.git" ]; then
  echo "No git checkout found at $upstream_dir."
  echo "Bootstrap does not clone upstreams. Add a reviewed snapshot or checkout before running a real transform."
  exit 0
fi

find "$upstream_dir" -maxdepth 4 -type f \( -name "*.md" -o -name "*.txt" -o -name "*.yaml" -o -name "*.yml" \) | sort

