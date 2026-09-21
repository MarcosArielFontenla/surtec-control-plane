# Codex runtime runbook

## Authentication

The control plane uses the authentication already configured for the installed Codex CLI. Sign in through the documented Codex workflow before dispatching a real task. Do not copy auth files or credentials into this repository.

## Configuration

- `SURTEC_CODEX_BIN`: optional executable path; defaults to `codex`.
- `SURTEC_CODEX_MODEL`: optional model override; omitted uses the user's configured default.
- `SURTEC_CODEX_REASONING_EFFORT`: optional reasoning-effort override.
- `SURTEC_CODEX_SMOKE=1`: explicit opt-in for the real read-only smoke test.

Worker and task limits:

- `SURTEC_WORKER_CONCURRENCY` (default `2`): maximum current leased attempts across cooperating local workers.
- `SURTEC_WORKER_POLL_MS` (default `250`): durable-queue polling interval.
- `SURTEC_WORKER_LEASE_MS` (default `30000`) and `SURTEC_WORKER_HEARTBEAT_MS` (default `5000`): crash-detection window and renewal interval.
- `SURTEC_WORKER_RETRY_BASE_MS` (default `1000`): base for bounded exponential retry delay.
- `SURTEC_TASK_MAX_ATTEMPTS` (default `3`), `SURTEC_TASK_MAX_RUNTIME_MS` (default `300000`), and `SURTEC_TASK_MAX_TOTAL_TOKENS` (default `200000`): defaults copied into each new task.

Changing defaults affects only newly dispatched tasks. Existing tasks retain their persisted budgets.

## Protocol generation

```text
pnpm codex:generate-protocol
```

Run this after upgrading the Codex CLI. Review generated changes and update the version marker in the same commit. Do not hand-edit generated bindings.

## Automated verification

Tests use a fake App Server process. They verify handshake ordering, request correlation, thread and turn lifecycle, event normalization, approvals, structured results, malformed JSONL, interruption, and unexpected process exit without making a paid request.

Approval requests fail closed unless they match the active App Server thread and turn and the exact command or file path permitted for that task. Sandbox capability and approval policy are independent: an approval cannot expand the configured sandbox or current registry policy.

## Real read-only smoke

```text
$env:SURTEC_CODEX_SMOKE='1'
pnpm smoke:codex
```

The smoke runs against `fixtures/codex-smoke`, snapshots its files before and after, and fails if anything changes. It reports the thread, turn, final status, and usage when available. It does not print credentials.

## Troubleshooting

- `codex` not found: set `SURTEC_CODEX_BIN` to the installed executable.
- Authentication error: sign in using the Codex CLI or configure a documented non-interactive authentication method outside the repository.
- Protocol error after a CLI upgrade: regenerate bindings and compare the relevant request and notification types.
- Interrupted turn: inspect the task JSONL report for normalized events; the client requests interruption and then terminates the child if necessary.
- Task remains `running` after a crash: wait for the persisted lease to expire and restart the API. Startup requeues it without incrementing the attempt counter; a known Codex thread is resumed.
- Task remains `queued`: inspect `orchestration.retry_at`, attempt/token budgets, and `state/events/<task-id>.jsonl`. A future retry time is intentional backoff.
- Cancellation remains requested: another local worker may own the current lease. Its next heartbeat observes the durable request and interrupts the turn.
- `state lock is busy`: another cooperating process is mutating the same task. The scheduler retries on a later poll; repeated errors indicate a process or filesystem problem.
