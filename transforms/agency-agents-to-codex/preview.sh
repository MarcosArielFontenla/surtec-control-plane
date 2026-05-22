#!/usr/bin/env bash
set -euo pipefail

upstream_dir="upstreams/agency-agents"

echo "Previewing agency-agents candidates."

if [ ! -d "$upstream_dir/.git" ]; then
  echo "No git checkout found at $upstream_dir."
  echo "Bootstrap does not clone upstreams. Add a reviewed snapshot or checkout before running a real transform."
  exit 0
fi

find "$upstream_dir" -maxdepth 3 -type f \( -name "*.md" -o -name "*.toml" -o -name "*.yaml" -o -name "*.yml" \) | sort

