#!/usr/bin/env bash
set -euo pipefail

mkdir -p reports
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
report="reports/upstream-check-${timestamp}.log"

{
  echo "Surtec upstream check"
  echo "Timestamp: ${timestamp}"
  echo

  for upstream in upstreams/*; do
    [ -d "$upstream" ] || continue
    name="$(basename "$upstream")"
    echo "== ${name} =="

    if [ -d "$upstream/.git" ]; then
      echo "Git checkout detected. Fetching remote metadata only."
      git -C "$upstream" fetch --all --prune
      git -C "$upstream" status --short --branch
    else
      echo "No git checkout present. Bootstrap intentionally does not clone upstreams."
    fi

    echo
  done
} | tee "$report"

echo "Report written to $report"

