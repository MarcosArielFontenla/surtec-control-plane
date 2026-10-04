---
name: file-state-contracts
description: Change or review file-first stores, JSON schemas, version dispatch, locks, atomic replacement, cross-record invariants, and explicit migrations using synthetic state.
metadata:
  version: "1.0.0"
  snapshotPath: ".agents/cold-start/snapshots/file-state-contracts.snapshot.md"
  snapshotVersion: "1.0.0"
  driftStatus: "inactive"
---

# File State Contracts

Use for persistence boundaries, not a derived read model that never changes stored state. Read `docs/decisions/ADR-0002-file-first-durable-orchestration.md`. When changing format compatibility or migration, read `docs/architecture/organization-state-migration.md` completely, including later-phase addenda; its historical inventory is not a substitute for current code.

## Store invariants

- Inspect the affected `lib/state/` reader, writer, path resolution, runtime validator, `schemas/` contract and callers together. Distinguish a completely absent optional store from malformed JSON, failed invariants and unknown-future versions; errors must not become invented empty state.
- New persisted documents require an integer `schema_version` checked by their schema. Record revision, API version and timestamps do not identify a storage format. Keep supported legacy formats explicit and format migration separate from ordinary reads unless a reviewed existing migration requires otherwise.
- Mutate under the store's existing lock, reread after acquiring it, validate the complete aggregate and cross-record invariants, then atomically replace a staged file. Check how that specific store handles temporary names, cleanup and stale locks instead of assuming every helper has identical guarantees.
- Task snapshots are authoritative; their event append is a separate operation, not one atomic transaction. Preserve monotonic revisions, run/lease ownership, cancellation, event order and detectable gaps.
- Keep derived API versions independent from persisted versions. Missing evidence, scope or approval cannot grant authority through an additive default.
- A migration needs validated source and target fixtures, preflight fingerprints, recoverable ignored backups, staged validation and restart/rollback conflict handling. Preserve malformed or future-version source bytes; quarantine is not repair.
- Never seed fixtures or backups from private normal state, write user data into Git, or migrate sibling repositories. Use unique test-owned temporary roots and do not claim rollback/cleanup succeeded without checking it.

## Verification and stopping condition

Locate the affected store tests under `lib/state/` and service tests under `dashboard/src/server/`. Cover applicable missing/malformed/future versions, concurrent mutation, failed writes, invariant failures and deterministic restart/migration behavior. Run `pnpm schemas:check`, focused tests, and typecheck; run the complete repository checks before phase delivery.

When persistence affects dashboard workflows, also load `.agents/skills/local-dashboard-validation/SKILL.md` and prove real API/browser reload or restart behavior against synthetic state. Stop before any migration that lacks a recoverable procedure or expands the approved data scope; report the exact preserved bytes/operation boundary without private contents.
