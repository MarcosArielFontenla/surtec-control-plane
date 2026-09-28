# Organization state migration contract

Status: Design contract for later roadmap phases. No migration is implemented or run in Phase J.

## Existing persisted contracts

The following inventory reflects the repository at the Phase J baseline. `schema_version` refers to an explicit persisted field, not a Git commit, task `revision`, API response version, or schema filename.

| Location / contract | Current validation and versioning | Write/recovery characteristics | Later-phase treatment |
| --- | --- | --- | --- |
| `state/tasks/<task-id>.json` — `TaskRecord` / `TaskEnvelope` | `schemas/task-record.schema.json` and `schemas/task-envelope.schema.json`; no `schema_version`. `revision` is a concurrency revision, not a format version. | Per-task lock and atomic replacement for cooperating writers. | Treat the current format as a named legacy baseline; add explicit version dispatch before incompatible extension. Preserve task ids, attempt/lease ownership, cancellation, budgets, and decisions. |
| `state/events/<task-id>.jsonl` — `TaskEvent` records | `schemas/task-event.schema.json`; each line has no explicit schema version. | Append-only JSONL; snapshot write and event append are not one transaction. Event revisions expose detectable gaps. | Preserve existing lines as a legacy event format. Version new records or introduce an explicit envelope; do not rewrite the log in place without backup and replay tests. |
| `state/projects/<project-id>.json` — `ProjectStatusOverride` | `schemas/project-status-override.schema.json`; no `schema_version`. | Atomic replacement; no aggregate transaction with other stores. | Named legacy baseline. Preserve the distinction between technical registry policy and local portfolio data. |
| `state/sessions/work-sessions.json` — `WorkSessionsDocument` | `schemas/work-sessions.schema.json`; `schema_version: 1`. | Cross-process lock, schema validation, atomic replacement. | Version-step migration; preserve session ids, timestamps, associations, and accumulated focused time. |
| `state/portfolio/projects.json` — `PortfolioProfilesDocument` | `schemas/portfolio-profiles.schema.json`; `schema_version: 1`, nested `ProjectProfile` also versioned. | Cross-process lock, strict validation, atomic replacement. | Version-step migration; preserve project ids and explicit client association. |
| `state/portfolio/clients.json` — `ClientPortfolioDocument` | `schemas/client-portfolio.schema.json`; `schema_version: 1`, nested client/commitment records are schema-validated. | Cross-process lock, bounded input, strict validation, atomic replacement. | Sensitive local data: never put backups, quarantine copies, or fixtures in Git, logs, prompts, or model context. Preserve ids, privacy classifications, and links. |
| `state/signals/human-state.json` — `SignalHumanStateDocument` | `schemas/signal-human-state.schema.json`; `schema_version: 1`; first-action fields are optional for backward compatibility. | Cross-process lock, validation, atomic replacement. | Preserve human status and first-action timestamps; do not infer historical values that were never recorded. |
| `state/notes/<project-id>.json` — local notes array | No standalone JSON Schema or version field; `lib/state/notes.ts` filters entries and currently returns an empty list on parse/read failure. | Atomic replacement through `writeJsonAtomic`, but no lock; malformed input can currently appear empty to the caller. | Treat as legacy and potentially lossy. Before extension, add explicit validation and a preserve/quarantine path; never use the current empty fallback as migration evidence that data was absent. |
| `state/reconciliation/orphan-worktrees.json` — generated reconciliation report | `ReconciliationReport` in `runner/reconcile.ts`; no explicit schema version or read-side validation. | Atomically replaced report; derived from current tasks and repositories. | Preserve the report during state migration or regenerate only after preflight; do not treat an orphan listing as permission to delete worktrees. |
| `registry/projects.yml`, `registry/agents.yml` — trusted local operating policy | JSON Schema contracts in `schemas/projects-registry.schema.json` and `schemas/agents-registry.schema.json`, plus cross-reference validation; no file-level schema version. | Human-maintained policy/config tracked by Git; not ordinary `state/` data. | No unattended rewrite. Evolve validators deliberately, show a diff, preserve unknown/user-owned policy only when safe, and require explicit human acceptance of policy changes. |
| `evals/v1`, `evals/v2`, and canary fixtures — synthetic evaluation contracts | Suite/case schemas, versioned suite identifiers and fixture paths. | Tracked fixtures used by offline evaluation; live canaries are separately opt-in. | Migrate representative fixtures with each contract change, retain regression cases, and never seed fixtures from private local state. |

Read models such as `/api/today`, project integration snapshots (`schema_version: 2`), and feedback metrics (`schema_version: 1`) are versioned API contracts but are derived at request time rather than persisted. Change their response contracts independently; they do not need a state-file migration unless they become stored state.

## Versioning rules

1. Every new persisted document has a required integer `schema_version` whose value is checked by its JSON Schema. Do not overload a record revision, timestamp, suite id, or API version as a storage version.
2. An incompatible format change increments one version. Migration is explicit and sequential (`v1 -> v2 -> v3`); a reader never guesses a format from incidental fields.
3. Existing unversioned files remain named legacy formats and are handled only by an explicit legacy-to-versioned migrator. The normal reader must not silently reinterpret malformed or unknown-future versions as the current version.
4. For append-only JSONL, version each new event record or wrap it in a versioned envelope. Readers must continue to parse the supported legacy line format; never rewrite an existing event log in place merely to add a version tag.
5. Keep runtime and JSON Schema validation aligned. Add migration fixtures for every supported source version and validate both source and target contracts. Do not accept unknown properties by default to simulate forward compatibility.
6. Version API read models separately from storage contracts. A derived response version does not imply a persisted-state migration.

## Safe migration procedure

Before a migration that changes local bytes:

1. Identify the exact migration id, source/target versions, affected files, data classifications, and compatibility window. Provide a dry-run report with counts, hashes, and validation findings; do not print private content.
2. Acquire the same store locks used by writers. Re-read and validate the source after locking, and abort if its fingerprint or expected version changed since preflight.
3. Create a recoverable byte-for-byte backup of every affected source before the first mutation, under ignored local state such as `state/backups/<timestamp>-<migration-id>/`. Use restrictive host permissions where supported; never copy local state to a repository, external service, or model context.
4. Run a deterministic, side-effect-free migrator into uniquely named temporary files on the same volume. Validate every staged file against the target schema and cross-record invariants before replacement.
5. Replace one file at a time with same-volume atomic rename and record progress in a migration journal. Atomic rename protects one file, not a multi-file transaction. Readers/writers must be paused or use the migration lock for the full set. The journal must allow a restart to identify exact old/new hashes and safely resume or restore.
6. If validation or replacement fails, stop further writes and restore from the exact backup while holding the lock. Do not overwrite a post-migration file whose hash differs from the migration's recorded output; surface that conflict for human review.
7. Retain the backup and completion manifest until a human has validated the resulting application behavior. Rollback is allowed only when current files still match the migration output; otherwise preserve both versions and require a target-specific human decision.
8. If source data is malformed, unknown-future, or violates cross-record invariants, preserve the original bytes and refuse migration. A private quarantine copy may be created with restrictive permissions and a manifest/hash, but quarantine is not repair. Surface `needs-review`/`needs-decision`; never continue from a fabricated empty store.

If restoration itself fails, do not claim rollback success. Preserve the source backup, journal, and conflicting bytes, block affected writes, and require human recovery.

## Defaults and missing data

- A completely absent optional store may use its already-documented empty default only if absence is valid for that contract. Record the default's provenance when it affects a future decision.
- Optional additive fields may receive a deterministic, conservative default only when that default preserves existing meaning and cannot grant scope, permissions, budget, or external authority.
- Missing required scope, authorization, evidence, ownership, policy, or approval is not equivalent to approval. Keep the work in `needs-decision` (or fail closed before organization state exists) until a human resolves it.
- Unknown/future versions, parse errors, and failed validation are errors, not empty state. Never overwrite their source as a side effect of reading.
- Do not backfill historical evidence or timestamps from current observations. Mark unavailable facts as unavailable.

## Fixture policy

- Maintain synthetic fixtures for each supported source version and target version, with no real client, repository, path, prompt, secret, or user state.
- Exercise migration success, idempotent restart, stale-source abort, unknown version, malformed state, cross-record failure, partial multi-file apply, rollback, and rollback-conflict cases.
- Update production schemas, runtime validators, migration fixtures, and golden expectations in one reviewed change. Preserve pre-migration fixtures needed to prove compatibility.
- Fixture migration is deterministic and reviewable; do not rewrite fixtures as an unexamined bulk formatter or derive them from live state.

## Phase J exclusions

This contract does not add `Company`, `Objective`, or `Issue` records, a schema migrator, backup or quarantine directories, a migration command, or state changes. Each later phase must implement and test only the migration needed by its concrete persisted contract before writing new-format data.

## Phase K implementation addendum

Phase K adds `state/organization/organization.json` as a new `schema_version: 1` aggregate for the single SURTEC company, objective records, and canonical project-objective links. The aggregate is validated as a whole, checked for parent cycles/depth and cross-record consistency, and replaced atomically under its own lock. An absent organization store returns the documented empty SURTEC profile without creating a file; malformed and future versions fail closed.

The existing portfolio profile contract moves from v1 to v2. On its first read, the locked migration validates the complete v1 source and target, reports only counts and SHA-256 fingerprints, saves/verifies a byte-for-byte ignored backup under `state/backups/phase-k-portfolio-profiles/`, validates a unique same-directory staged file, then atomically replaces the source. The deterministic category map is `personal -> personal` and `client -> client-product`; every other profile field is copied unchanged. No v1 portfolio profile file was present in the local workspace when Phase K began, so the migration path was validated with synthetic fixtures and no user profile bytes were migrated during implementation.
