# Phase 2 durable orchestration plan

- Date: 2026-09-21
- Branch: `codex/phase-2-durable-orchestration`
- Scope: local commits only; no push, merge, deployment, external message, or paid model call

## Outcome

Dispatch writes a durable queued task and returns immediately. A bounded worker owns execution, leases, retries, cancellation, recovery, project write exclusion, event recording, and resource budgets. The control plane remains a local modular monolith and keeps file-first state.

## Invariants

1. A task attempt has one immutable `run_id`; only the current lease owner may publish its progress or terminal result.
2. At most the configured number of attempts execute concurrently, and at most one workspace-write attempt executes for a project.
3. Dispatch, claim, cancel, retry, heartbeat, recovery, and completion update a task through the same locked mutation boundary.
4. Task JSON remains the current snapshot. Operational history is an append-only, schema-validated JSONL event stream.
5. A restart requeues only an expired running lease with retry budget remaining. It never marks every running task failed merely because the API restarted.
6. A retry preserves the task identity, isolated worktree metadata, and Codex thread id when available. Repeated worker notifications or recovery passes are idempotent.
7. Cancellation is durable before it is delivered in memory. A queued task becomes terminal without starting; a running task receives `turn/interrupt` through its abort signal.
8. Attempt count, wall-clock time, and total token use are bounded. Exhausting a budget ends the task explicitly rather than silently retrying forever.
9. Policy authorization is re-evaluated at every attempt. Policy failures, invalid output, explicit cancellation, and exhausted budgets are not automatically retried.
10. No execution, verification, publication, or cleanup happens in an HTTP request handler.

## Persistence model

Each task gains a `revision` and an `orchestration` snapshot containing attempt and budget counters, retry timing, cancellation intent, the active lease, cumulative usage, and the last failure classification. Existing Phase 0/1 task files remain readable through an in-memory default; new and subsequently mutated records use the Phase 2 shape.

Short state transitions use a per-task cross-process lock and atomic replacement. The lock covers one task only, so there is no false claim of a transaction across unrelated files. Event append happens after the snapshot mutation and includes the resulting revision, making a missing event detectable without treating the event log as the source of truth.

The event stream lives under `state/events/<task-id>.jsonl`. It contains concise operational data and identifiers, never prompts, message deltas, raw chain-of-thought, credentials, or unrestricted subprocess output.

## Worker boundary

`TaskOrchestrator` is an application service started by the server bootstrap and injected into the HTTP app through a narrow control interface. It polls durable state, atomically claims eligible work, owns active abort controllers and lease heartbeats, and delegates a claimed attempt to `runTask`. This is a process-internal worker boundary for Phase 2; a separate service or distributed queue is intentionally out of scope.

Default limits are conservative and environment-configurable:

- global concurrent attempts: 2;
- maximum attempts per task: 3;
- attempt runtime: 5 minutes;
- cumulative tokens: 200,000;
- lease: 30 seconds with a 5-second heartbeat;
- retry delay: bounded exponential backoff.

## Recovery and idempotency

- An unexpired lease is left alone, including when observed by another process.
- An expired lease increments no counter during recovery. It is requeued when attempts remain, otherwise finalized as failed.
- A stale attempt cannot finish a task after its lease was replaced because completion checks `run_id` under the task lock.
- Write retries reuse the recorded managed worktree only when its path, project repository, and branch still match policy. Otherwise the attempt fails safely for human review.
- A persisted Codex thread id is passed to `thread/resume`; otherwise a new thread starts. Stable App Server methods only are used.

## Delivery slices

1. Add orchestration and event schemas, locked task mutation, compatibility defaults, and persistence tests.
2. Make `runTask` attempt-aware, externally cancellable, budget-aware, resumable, and stale-completion safe.
3. Add `TaskOrchestrator` scheduling, leases, heartbeat, recovery, retry classification, and project write exclusion with deterministic fake-executor tests.
4. Route dispatch through the worker; expose cancel, retry, and event-read endpoints; add dashboard controls and task state.
5. Update architecture, threat model, and runbooks; run schema, secret, unit/integration, typecheck, build, API smoke, and browser validation gates.

## Explicit non-goals

- No database, Redis, message broker, separate worker service, multi-host scheduling, or leader election.
- No parallel workspace-write attempts for the same project.
- No automatic push, pull request, merge, deployment, or destructive orphan cleanup.
- No paid Codex request in automated verification.
- No complete task-detail observability UI; Phase 3 owns the richer lifecycle view.

