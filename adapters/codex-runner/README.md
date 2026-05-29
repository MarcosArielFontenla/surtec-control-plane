> **DEPRECATED (2026-05-28):** Surtec standardizes execution on Claude tooling
> (Claude Agent SDK / Claude Code). This Codex runner is kept for reference only and
> receives no further investment. The Claude runner will be introduced in the
> "dispatch" slice. See `docs/superpowers/specs/2026-05-28-live-status-dashboard-design.md`.

# Codex Runner Adapter

This adapter executes a Surtec `TaskEnvelope` through Codex CLI.

The runner defaults to dry-run mode. It prints the command that would run and writes a log file under `reports/`. Real execution requires:

```bash
SURTEC_EXECUTE=1 ./adapters/codex-runner/run-task.sh path/to/task.json
```

## Safety Rules

- Never merge.
- Never deploy.
- Never read or write real secrets.
- Use the task sandbox value.
- Store logs in `reports/`.
- Treat all output as review material for humans.

## Task Input

The input file must match `schemas/task-envelope.schema.json`.

