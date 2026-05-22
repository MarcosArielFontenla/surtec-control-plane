#!/usr/bin/env bash
set -euo pipefail

mkdir -p reports
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
report="reports/upstream-diff-${timestamp}.log"

{
  echo "Surtec upstream diff report"
  echo "Timestamp: ${timestamp}"
  echo

  for upstream in upstreams/*; do
    [ -d "$upstream" ] || continue
    name="$(basename "$upstream")"
    echo "== ${name} =="

    if [ -d "$upstream/.git" ]; then
      git -C "$upstream" status --short --branch
      git -C "$upstream" log --oneline --decorate -5 || true
    else
      echo "No git checkout present."
    fi

    echo
  done
} | tee "$report"

echo "Report written to $report"

