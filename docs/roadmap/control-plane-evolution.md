# Control plane evolution roadmap

## Phase 0 — Codex runtime and baseline repair

Replace the execution runtime, restore dispatch, add structured result validation, normalize events and usage, establish current documentation, and remove obsolete runtime references.

Status: complete on 2026-09-21. See [Phase 0 verification](phase-0-verification.md) for command evidence and the one environment-limited optional smoke.

## Phase 1 — Security, policy, and reliable review

Create one typed policy service, validate every trust boundary, isolate subprocess environments, add path containment and identifier checks, bind to loopback, protect mutations, make review effects retryable, reconcile orphan worktrees, add secret scanning, and add CI.

## Phase 2 — Durable orchestration

Move execution behind a worker boundary, add bounded concurrency and per-project write exclusion, cancellation, retry, crash recovery, idempotency, append-only task events, resource budgets, and transactional persistence when justified.

## Phase 3 — Daily operations and observability

Add an evidence-backed Today view and a complete task detail view with lifecycle events, diffs, commands, verification, policy decisions, approvals, usage, retries, and cleanup state. Add optional tracing without making it a runtime dependency.

## Phase 4 — Evaluations and quality gates

Build versioned fixture-based evaluations by role and task type. Prefer deterministic checks; make security and policy violations hard failures regardless of aggregate scores.

## Phase 5 — Integrations and extensibility

Narrowly evolve source-control, CI, deployment, and observability integrations when multiple real implementations justify an interface.

## Phase 6 — Optional collaborative workspace

Only with explicit authorization, add structured role artifacts, comments, traceability, authentication, and multi-user isolation.
