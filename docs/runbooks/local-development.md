# Local development

## Requirements

- Node.js 20 or newer.
- pnpm.
- Git.
- Codex CLI for real dispatch.
- Optional `gh` and Railway credentials for their integrations.

## Setup

```text
pnpm install --frozen-lockfile
pnpm codex:generate-protocol
pnpm schemas:check
pnpm secrets:check
pnpm evals:check
pnpm test
pnpm typecheck
pnpm build
pnpm audit:check
```

Set `SURTEC_PROJECTS_ROOT` when sibling repositories are not under the control plane's parent directory. Keep machine-specific values outside Git.

The durable worker defaults to two concurrent tasks and one workspace-write task per project. `.env.example` lists scheduler, lease, retry, attempt, runtime, and token controls. Keep the heartbeat comfortably below the lease duration.

## Run

```text
pnpm dev
```

- UI: `http://localhost:5173`
- API: `http://localhost:4317`

For a production-style local run:

```text
pnpm build
pnpm start
```

## Validation

`pnpm ci:check` runs every offline quality gate, including the versioned role/task-type evaluation suite under `evals/v1/`. `pnpm evals:check` can run that suite independently; it validates fixture schemas, registry coverage, deterministic quality thresholds, and non-compensable security/policy failures. `pnpm audit:check` additionally queries the npm registry and fails on moderate or higher advisories.

Use `pnpm smoke:api` for the local API smoke. The production-style API listens on `127.0.0.1`; browser mutations obtain an in-memory session token automatically. A server restart intentionally invalidates the previous token.

At startup, inspect warnings about orphaned worktrees before taking cleanup action. The report is written under `state/reconciliation/orphan-worktrees.json`; reconciliation never deletes an unknown path.

Current task snapshots are under `state/tasks/`; append-only lifecycle events are under `state/events/`. On restart, unexpired leases remain owned, while expired leases are requeued only when their persisted budgets permit it. Cancellation and manual retry are available from the dashboard and protected API.

Real agent execution is never part of the normal test suite; see the Codex runtime runbook for the explicit smoke command.
