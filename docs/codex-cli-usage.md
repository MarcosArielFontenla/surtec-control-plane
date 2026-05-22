# Codex CLI Usage

Codex CLI is the execution engine for agent tasks.

## Analysis

Use `read-only` mode for inspection:

```bash
codex exec --sandbox read-only "Analyze this repository and report risks."
```

## Controlled Implementation

Use `workspace-write` mode for controlled edits:

```bash
codex exec --sandbox workspace-write "Implement the requested change and run validation."
```

## Task Envelope Runner

Run a task JSON:

```bash
./adapters/codex-runner/run-task.sh task.json
```

Dry-run is the default. Real execution requires:

```bash
SURTEC_EXECUTE=1 ./adapters/codex-runner/run-task.sh task.json
```

## Logs

Runner logs are written under `reports/`. JSONL and log files are ignored by git.

## VS Code Review

Use Codex in VS Code for reviewing generated changes, comparing diffs, and deciding whether to accept work.

