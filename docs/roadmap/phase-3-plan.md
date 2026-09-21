# Phase 3 — Daily operations and observability plan

## Outcome

Phase 3 turns task state into an evidence-backed operating view. The dashboard gains a deterministic Today view and a complete task detail view. Operators can understand what happened without reconstructing state from free-form logs.

The implementation remains local-first and file-backed. Observability enriches the existing task record and append-only event stream; it does not introduce a database, a remote telemetry service, or a runtime tracing dependency.

## Baseline

Phase 3 starts from the completed Phase 2 branch state:

- 57 test files and 429 tests pass.
- TypeScript typechecking passes.
- All 8 JSON Schemas validate.
- Tasks already persist lifecycle, result, orchestration budgets, leases, retry state, review decisions, and append-only lifecycle events.
- The runner already produces bounded verification output and redacted JSONL logs.

## Evidence contract

### Today

Today is derived from task records plus append-only task events. The date boundary is calculated in an explicit IANA time zone, configured by `SURTEC_TIME_ZONE` and defaulting to `America/Buenos_Aires`.

The view includes:

- currently active tasks, regardless of creation date;
- unresolved review or approval decisions, regardless of creation date;
- tasks completed, failed, or cancelled on the selected local date;
- retry, cancellation, and recovery events on the selected local date;
- totals derived from the same returned collections.

No state is inferred from UI timing or browser-local caches.

### Task detail

Task detail is a read-only projection containing:

- task identity, lifecycle, timestamps, attempts, budgets, and current lease state;
- the ordered lifecycle event stream;
- agent result, commands, tests, artifacts, risks, blockers, and next steps;
- execution mode, thread, turn, branch, worktree, and commit metadata;
- a bounded durable diff artifact when a write task committed changes;
- verification checks and their bounded output tails;
- dispatch and execution policy decisions;
- runtime approval decisions without prompt or chain-of-thought content;
- review decision, retry history, usage history, and cleanup state;
- trace identifiers when a tracing adapter is enabled.

Missing optional evidence is reported as unavailable; it is never fabricated.

## Security and privacy invariants

- Task identifiers and all artifact paths are validated before filesystem access.
- Diff artifacts are stored under the control-plane `reports/` directory, ignored by Git, size-bounded, and read only after containment checks.
- Event payloads pass through the existing redaction boundary.
- Prompts, message deltas, environment values, credentials, and raw reasoning are not copied into task events or task detail.
- Read-only observability endpoints do not weaken mutation-session protection.
- Tracing is dependency-injected and defaults to a no-op implementation.

## Vertical slices

1. **Evidence persistence** — extend the event vocabulary, persist policy, approval, worktree, diff, verification, review, and cleanup evidence, and add optional tracing interfaces.
2. **Read models and API** — build deterministic Today and task-detail projections with bounded, contained artifact reads.
3. **Today UI** — add navigation, daily summaries, active work, attention, outcomes, retries, and task opening.
4. **Task detail UI** — add lifecycle, evidence, diff, verification, policy, approvals, usage, retry, and cleanup sections.
5. **Verification and documentation** — run schemas, secret scanning, tests, typecheck, build, API smoke, and browser validation; record exact evidence.

## Non-goals

- Remote telemetry export or a hosted tracing backend.
- Full-text log search or arbitrary report-file browsing.
- Cross-user audit identity, authentication, or multi-tenant access control.
- Repository mutations from the Today or detail views.
- Retention policy changes for task records, events, logs, worktrees, or diffs.

## Completion criteria

- Every required detail section is backed by a persisted record, event, or bounded artifact.
- Today classification is covered across time-zone day boundaries.
- Corrupt or missing optional artifacts degrade safely.
- Existing orchestration, review, and HTTP security behavior remains covered.
- The dashboard is manually verified in a browser after automated gates pass.
