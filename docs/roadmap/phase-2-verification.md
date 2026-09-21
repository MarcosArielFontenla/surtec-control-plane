# Phase 2 verification

- Date: 2026-09-21
- Branch: `codex/phase-2-durable-orchestration`
- Scope: local commits only; no push, merge, deployment, external message, or paid model call
- Runtime: Node.js 24.16.0 and pnpm 10.24.0; repository minimum remains Node.js 20

## Summary

- Dashboard dispatch now persists and notifies a durable `TaskOrchestrator`; no agent execution happens in the HTTP request handler.
- The worker enforces a global concurrency ceiling and one workspace-write attempt per project across cooperating local processes.
- Claims use immutable run ids and expiring leases. Heartbeats renew ownership, and stale attempts cannot overwrite current task state.
- Cancellation intent is durable before the active abort signal reaches Codex App Server. Queued cancellation is terminal without execution.
- Transient execution failures retry with bounded exponential backoff while persisted attempt and cumulative-token budgets remain.
- Expired leases requeue without consuming another attempt. Exhausted or cancelled leases become explicit terminal outcomes.
- Persisted Codex thread ids are supplied to stable `thread/resume`; interruption continues to use stable `turn/interrupt`.
- Write retries safely reuse the exact managed task worktree and branch. Conflicting identity fails closed.
- Task JSON is the authoritative schema-validated snapshot. Redacted, schema-validated lifecycle history appends under `state/events/`.
- The API exposes protected cancel/retry controls and event reads. The dashboard shows attempt counts and eligible actions.
- ADR-0002 records why file-first persistence remains sufficient and the concrete thresholds for a future SQLite migration.

## Files modified

Forty-two repository files changed across these groups:

- Contracts and persistence: `schemas/task-record.schema.json`, `schemas/task-event.schema.json`, `schemas/agent-result.schema.json`, and `lib/state/{types,paths,validation,orchestration,store,events,derive}.ts` plus tests.
- Runtime and scheduling: `runner/{run-task,task-orchestrator,worktree,result,reconcile}.ts` plus tests and the agent-report type boundary.
- API and bootstrap: `dashboard/src/server/{dispatch,index,serve}.ts` plus route tests.
- Dashboard controls: `dashboard/src/ui/api.ts`, `InProgressColumn`, derived task views, and UI tests.
- Operations and architecture: `.env.example`, `README.md`, architecture, security, runbooks, ADR-0002, the phase plan, roadmap, and this verification record.

## Commands and exact results

- `pnpm ci:check`: passed with exit code 0.
  - Eight JSON Schemas compiled successfully.
  - Secret scan passed across 833 tracked and non-ignored repository files.
  - 57 test files and 429 tests passed under Vitest 4.1.11.
  - TypeScript type checking passed.
  - Production build passed with 1,908 modules; JavaScript bundle 194.30 kB, 59.66 kB gzip.
- `pnpm audit --audit-level moderate`: no known vulnerabilities.
- `pnpm smoke:api`: HTTP 200 for overview and dispatch options; 20 repositories discovered and 12 registry entries returned.
- `pnpm smoke:codex` without opt-in: passed by skipping without an external request.
- Production HTTP smoke on `127.0.0.1:4318`: overview returned 200 and a missing task-event stream returned 404.
- `git diff --check`: passed.
- `pnpm install --frozen-lockfile` initially stopped before changing dependencies because pnpm would recreate `node_modules` and the non-interactive host had no TTY. No dependency changed in this phase; `pnpm install --frozen-lockfile --lockfile-only` then validated the lockfile successfully.

## Test coverage added

- Locked mutations increment revisions and reject concurrent writers; task events validate, preserve order, and redact credentials.
- Runner tests cover durable thread/turn/usage persistence, thread resume, external cancellation, runtime/token budgets, stale completion fencing, and redacted logs.
- Worktree creation is idempotent for the same task identity.
- Scheduler tests cover global capacity, per-project write exclusion, read/write coexistence, queued and active cancellation, bounded retry, expired-lease recovery, exhausted budgets, manual retry, and a full worker-to-runner flow with a fake executor.
- API and UI tests cover event reads, cancel/retry routing, unavailable-worker failure, attempt display, and action buttons.
- Existing fake App Server tests continue to cover `turn/interrupt` and stable protocol behavior without a paid request.

## Manual local validation

- The default port 4317 was already occupied by an existing process, which was left untouched. A production-style server was started on `http://127.0.0.1:4318` and shut down after validation.
- The browser rendered 20 project cards, 9 configured projects, the task form, zero active tasks, zero attention items, and the live status.
- No real task was dispatched during the smoke, so no model quota, external repository mutation, or networked agent action occurred.
- Startup continued serving while reporting the same sandbox-specific Git `dubious ownership` warnings for sibling repositories seen in Phase 1. It did not change global Git configuration or mutate those repositories.

## Security impact

- A run id fences persisted progress and terminal state from stale attempts.
- Cancellation, retries, leases, and resource budgets are schema-validated durable state rather than in-memory intent.
- Short per-task and scheduler locks coordinate cooperating local processes; identifiers remain allowlisted before becoming paths.
- Events are append-only, size-bounded by event shape, and pass through centralized credential redaction. Prompts, message deltas, and raw reasoning are excluded from the event stream.
- Runtime and token exhaustion fail explicitly and do not trigger unlimited retries.
- API mutations remain protected by loopback/origin/fetch-site checks and the same-origin session token.

## Known risks and deferred work

- Worker execution shares the API process. Recovery starts after restart and lease expiry rather than continuing in a separate service.
- Snapshot replacement and event append are separate durable writes. Revisions expose a missing event, but they do not form one filesystem transaction.
- Git effects are outside the snapshot transaction. A crash during a non-interruptible Git operation may leave a managed artifact requiring inspection.
- Cancelled write tasks intentionally preserve their known worktree for a safe retry or explicit cleanup; Phase 3 should make cleanup state and actions visible in task detail.
- File locks coordinate one host and cooperating control-plane processes only; arbitrary same-user filesystem mutation and distributed workers remain out of scope.
- In-memory project-command processes are still not recovered after restart.
- The sandbox account cannot inspect Git state/worktrees in several user-owned sibling repositories because Git rejects their ownership. This is an environment limitation, not a bypass.

## Local commits

- `9f5cc78` — `docs: define phase 2 orchestration plan`
- `a7fd934` — `feat: add durable task state and events`
- `de733f7` — `feat: make task attempts resumable and budgeted`
- `1644788` — `feat: add durable task orchestrator`
- `938b252` — `feat: expose durable task controls`
- `0492ae9` — `docs: define durable worker operations`
- `7c87248` — `docs: complete phase 2 verification`
- `ea7e60f` — `docs: normalize phase 2 markdown endings`
- Final verification metadata correction — this commit.

## Recommended next phase

Proceed to Phase 3 after local review. Build the evidence-backed Today view and complete task detail around the Phase 2 snapshot and event contracts, including policy decisions, attempts, usage, verification, diffs, approvals, and explicit worktree cleanup state.
