# Threat model

## Assets

- Source code and Git history across all managed projects.
- Local credentials for Codex, GitHub, Railway, package registries, and cloud providers.
- Task instructions, results, diffs, logs, and usage data.
- The user's ability to approve external side effects intentionally.

## Trust boundaries

- Browser to local Hono API.
- API to filesystem and Git.
- Control plane to external project repositories.
- Control plane to App Server JSONL.
- Agent-generated commands and file changes.
- Registry, persisted state, provider responses, and process output.

## Primary threats

- A read-only task writes files or escapes its repository.
- A write task modifies the main checkout or another project.
- Project-controlled commands inherit control-plane secrets.
- Malformed persisted or protocol data is treated as trusted success.
- A forged browser request triggers a local mutation.
- Path traversal escapes state or worktree directories.
- Partial push, PR, or cleanup effects are recorded as final success.
- Logs persist credentials or unbounded sensitive output.
- A crashed server leaves orphan processes, worktrees, or ambiguous tasks.

## Phase 0 controls

- Read-only and workspace-write App Server sandboxes.
- Isolated Git worktrees for implementation.
- Network disabled for dispatched turns.
- Reduced environment inheritance for agent-run subprocesses.
- Stable local `stdio` transport only.
- Fail-closed handling of unknown approval requests and malformed structured results.
- No real agent calls in automated tests.
- Opt-in read-only smoke with a filesystem before/after assertion.

## Deferred controls

Phase 1 owns canonical policy enforcement, complete runtime schema validation, strict identifier and path containment, subprocess environment allowlists, redaction, loopback/session/origin protections, idempotent review effects, orphan reconciliation, secret scanning, and CI.

