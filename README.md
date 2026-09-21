# Surtec Control Plane

Surtec Control Plane is a local dashboard for discovering, observing, and safely operating a portfolio of sibling Git repositories. Product code stays in its own repositories; this repository contains only the control plane.

## Stack

- React 18 and Vite in `dashboard/src/ui`
- Hono and `@hono/node-server` in `dashboard/src/server`
- Codex App Server over local JSONL/JSON-RPC in `runner`
- File-first task state under the ignored `state/` directory
- Vitest and Testing Library
- pnpm

## Local development

```text
pnpm install --frozen-lockfile
pnpm state seed
pnpm dev
```

The UI runs at `http://localhost:5173`; Vite proxies `/api` to the API at `http://localhost:4317`.

Quality gates:

```text
pnpm schemas:check
pnpm secrets:check
pnpm test
pnpm typecheck
pnpm build
pnpm audit:check
```

See `docs/runbooks/local-development.md` for environment variables and troubleshooting.

## Capabilities

- Discovers depth-one Git repositories under `SURTEC_PROJECTS_ROOT` or this repository's parent directory.
- Overlays trusted project and agent configuration from `registry/`.
- Validates registry and persisted state through one typed policy boundary.
- Shows Git status, GitHub activity, dependency status, deployment health, notes, and local process output.
- Dispatches analysis work in a read-only sandbox.
- Dispatches implementation work in an isolated Git worktree and task branch.
- Runs queued tasks behind a durable worker with bounded concurrency and one active write per project.
- Supports durable cancellation, bounded retry, lease-based crash recovery, App Server thread resume, and per-task runtime/token budgets.
- Records schema-validated append-only lifecycle events, thread and turn identifiers, token usage, structured results, diffs, and verification evidence.
- Routes invalid structured reports to `needs-review`.
- Keeps branch publication behind explicit human review; merge and deploy remain manual.
- Resumes interrupted approval/rejection effects without duplicating pushes or pull requests.

## Codex runtime

The runner spawns the installed `codex app-server --stdio` process without a shell and uses the authentication already configured for that CLI. It does not require a repository credential file.

Optional settings are documented in `.env.example`:

- `SURTEC_CODEX_BIN`
- `SURTEC_CODEX_MODEL`
- `SURTEC_CODEX_REASONING_EFFORT`
- `SURTEC_WORKER_*` scheduler, lease, and retry limits
- `SURTEC_TASK_*` attempt, runtime, and cumulative-token budgets

Protocol bindings are generated from the installed CLI:

```text
pnpm codex:generate-protocol
```

The real read-only runtime smoke is opt-in:

```text
$env:SURTEC_CODEX_SMOKE='1'
pnpm smoke:codex
```

## Dispatch safety

- Read-only tasks use the App Server read-only sandbox.
- Write tasks are restricted to the task worktree and run with network access disabled for agent tools.
- App Server receives a reduced environment; unrelated inherited credentials are excluded.
- Verification commands come only from trusted registry configuration and are re-run by the control plane after a commit.
- Dispatch, execution, and review revalidate current policy and canonical repository containment.
- The API binds to loopback; same-origin checks and an in-memory session token protect mutations.
- Non-agent subprocesses receive allowlisted environments, and surfaced output uses centralized redaction.
- JSONL logs redact credential-shaped values.
- The runner never merges or deploys.

See `docs/runbooks/codex-runtime.md` and `docs/security/threat-model.md` for the full operational model and current limitations.

## Architecture and workflow

- Repository instructions: `AGENTS.md`
- Current architecture: `docs/architecture/current-architecture.md`
- Runtime decision: `docs/decisions/ADR-0001-codex-app-server-runtime.md`
- Evolution roadmap: `docs/roadmap/control-plane-evolution.md`
- Historical implementation records: `docs/superpowers/`

Work is delivered in reviewable slices with tests, type checking, a production build, and no push, merge, or deployment without explicit authorization.
