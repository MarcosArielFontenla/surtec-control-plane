# ADR-0002: File-first durable orchestration

- Status: Accepted
- Date: 2026-09-21

## Context

Task execution must survive an API restart, prevent duplicate or stale completion, support cancellation and bounded retry, constrain concurrency, and retain an operational history. The product remains a single-user local modular monolith. Introducing a database, broker, or separate distributed worker solely for these guarantees would add operational cost beyond the current deployment shape.

The existing store already validates task JSON and replaces one file atomically. It did not serialize competing writers, represent attempt ownership, or retain lifecycle history.

## Decision

Keep file-first state and add a durable worker boundary inside the server process.

- Task JSON is the authoritative snapshot and carries a monotonic revision, budgets, counters, cancellation intent, retry timing, failure classification, and one expiring lease.
- Each attempt has an immutable `run_id`. Every progress and completion mutation verifies that it still owns the lease.
- A per-task exclusive lock serializes snapshot mutations across cooperating local processes. A short scheduler lock serializes capacity calculation and claims.
- Snapshot writes continue to use temporary-file replacement.
- Operational events append as schema-validated, redacted JSONL under `state/events/` after the snapshot mutation.
- The worker renews leases, enforces global concurrency and per-project write exclusion, and delivers persisted cancellation through an abort signal.
- Expired leases requeue without incrementing the attempt counter when budgets remain. A persisted Codex thread id is resumed through the stable App Server API.
- Transient failures use bounded exponential backoff. Policy errors, invalid structured output, explicit cancellation, and exhausted runtime or token budgets do not retry automatically.

## Transaction boundary

One task snapshot mutation is transactional with respect to cooperating processes: lock, reread, validate, atomic replace, unlock. There is intentionally no transaction across multiple tasks.

Snapshot replacement and event append are separate operations. The snapshot is authoritative if event append fails, and the event revision makes a gap detectable. This avoids pretending that two filesystem writes are atomic.

## Migration threshold

Revisit SQLite or another transactional store when one of these becomes a real requirement:

- atomic snapshot and event commit is required rather than detectable best effort;
- queries over large event histories materially affect responsiveness;
- multiple hosts or non-cooperating worker processes must schedule tasks;
- richer relationships require cross-task transactions;
- measured lock contention or recovery failures exceed the local design's operating envelope.

Any migration must preserve task ids, event order, attempt ownership, cancellation semantics, and the no-credential persistence rule.

## Consequences

Positive:

- Dispatch returns quickly and execution is independent of the HTTP request lifecycle.
- Restart recovery, cancellation intent, retry timing, usage, and budgets survive process loss.
- The design remains inspectable and operable with ordinary local files.
- Deterministic tests exercise orchestration without a paid model request.

Trade-offs:

- Worker execution stops with the API process and resumes only after restart and lease expiry.
- Event append can be missing after a snapshot succeeds.
- File locks are local coordination, not a distributed consensus mechanism.
- A separate process running as the same operating-system user remains outside this application's security boundary.

## Rejected alternatives

- SQLite now: stronger multi-record transactions, but no current query volume or deployment need justifies a storage migration.
- Redis or a hosted queue: contradicts local-first operation and introduces a service dependency.
- One child worker process per task: adds process supervision and IPC without improving the current single-host durability guarantees enough to justify the complexity.
