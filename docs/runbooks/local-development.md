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
pnpm repository:check
pnpm schemas:check
pnpm secrets:check
pnpm evals:check
pnpm test
pnpm typecheck
pnpm build
pnpm audit:check
```

Set `SURTEC_PROJECTS_ROOT` when sibling repositories are not under the control plane's parent directory. Keep machine-specific values outside Git.

## Subprocess credentials and managed Git

Child processes receive purpose-specific environments. Local Git inspection receives core OS variables only; GitHub CLI receives its GitHub auth variables; fetch, pull, and push receive core OS variables plus an SSH agent socket when configured and rely on Git's configured credential helper rather than raw service tokens. Project commands and verification keep the explicit `SURTEC_RUN_ENV_ALLOWLIST`; Codex receives only its documented runtime/auth variables; editor and OS-open actions receive a minimal OS environment.

Control-plane-managed Git commands set `core.hooksPath` to the empty, ignored `state/security/managed-git-hooks-empty` directory. The Control Plane creates and verifies that directory before each operation and fails closed if it is redirected or no longer empty. Repository-provided hooks therefore do not run during managed worktree, branch, commit, status, or network operations.

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

Use `pnpm smoke:api` for the local API smoke. It reports only endpoint status and record counts for the private client directory; it never prints client fields. The production-style API listens on `127.0.0.1`; browser mutations obtain an in-memory session token automatically. A server restart intentionally invalidates the previous token.

For the client-delivery UI, `pnpm smoke:client-commitments:playwright` runs the real dashboard against in-memory synthetic fixtures. It validates client and commitment editing, temporary name masking, Today presentation, generic client-signal task prefill, and explicit-only context sharing without contacting Codex or real project providers.

Inspect the consolidated, read-only integration snapshot with:

```text
GET http://127.0.0.1:4317/api/projects/<project-id>/integrations
```

The response uses `schema_version: 1` and combines local Git, registry-backed GitHub and CI, plus the explicitly registered HTTP-health and Railway deployment providers. Missing tools, credentials, or provider configuration degrade to `unknown` or `unconfigured`; they do not authorize mutations. `RAILWAY_TOKEN` remains optional and environment-only.

When extending integrations:

- add a deployment provider only with a concrete implementation, contract tests, safe configuration resolution, and explicit registration;
- keep provider credentials outside registry and state;
- do not introduce a shared source-control, CI, or tracing provider interface until a second real implementation demonstrates compatible semantics;
- never turn the read snapshot into a deploy, merge, push, or rollback surface.

At startup, inspect warnings about orphaned worktrees before taking cleanup action. The report is written under `state/reconciliation/orphan-worktrees.json`; reconciliation never deletes an unknown path.

Current task snapshots are under `state/tasks/`; append-only lifecycle events are under `state/events/`. On restart, unexpired leases remain owned, while expired leases are requeued only when their persisted budgets permit it. Cancellation and manual retry are available from the dashboard and protected API.

Real agent execution is never part of the normal test suite; see the Codex runtime runbook for the explicit smoke command.
