# Organization state migration contract

Status: Historical Phase J migration contract with implemented Phase K, Phase N, Phase O, Phase Q and Factory Local F2 compatibility addenda. Phase J itself implemented or ran no migration; later addenda describe current behavior without changing that baseline. Implementation descriptions do not establish a passed phase gate; see each acceptance record.

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
3. Existing unversioned files remain named supported legacy formats. Only an explicit migrator may convert them to a versioned whole-document contract; additive independently versioned fields do not imply that conversion. The normal reader must not silently reinterpret malformed or unknown-future versions as the current version.
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

## Phase N additive task compatibility

Phase N does not introduce a whole-task/event migration or rewrite historical normal state. The outer task envelope/record and existing event lines remain the named unversioned baseline. New strict subdocuments have independent version dispatch and cross-record binding; a task revision is still a concurrency counter, not a storage version.

| Contract | Current reader/admission behavior |
| --- | --- |
| Historical task without context/admission/testing fields | Readable without rewriting bytes or inventing manifests, consent, receipt, approval or timestamps. Initial legacy execution remains supported only without a persisted thread; a second attempt, thread resume or manual retry requires a new explicitly previewed governed task. |
| `TaskEnvelope.context_manifest` | Optional for legacy reads; every new admitted task includes `schema_version: 1`. Strict validation checks fingerprint, identities, sandbox, consent and budget bindings. Persist source hashes, reasons, classifications and sizes, not selected source-document copies. |
| `TaskEnvelope.context_admission` | Strict `schema_version: 1`, required for governed execution/retry. Stores original instruction hash/length and preview/issue references; cannot exist without a valid manifest or be fabricated from current observations. |
| `TaskRecord.testing_evidence` | Strict `schema_version: 1`, captured by verification infrastructure and bound to task/run/project/issue/scope/policy/context/candidate. Absence is not verified completion; legacy evidence-gap acknowledgement cannot waive a governed receipt. |
| Malformed, tampered or future subdocuments | Fail closed on read/write and preserve original bytes. A present invalid value cannot fall back to the legacy branch; no silent downgrade or unknown-property tolerance. |
| Append-only task events | Existing lines remain unchanged. New context/verification observations use the existing event contract; snapshot replacement and event append remain separate durable operations. |
| Existing issue `assigned_role_id` | Continues to identify the registered agent adapter. Logical context role is recorded separately; preview/dispatch must retain the authorized assignment, scope and revision. |

Task updates retain their existing per-task locks and atomic replacement. Issue and task records, candidate/evidence updates and events are not one multi-file transaction. Cancellation, leases, attempt/token/runtime ceilings, explicit issue review and publication gates remain authoritative. Rejecting incompatible context does not repair or delete user state.

Preview's issuance ledger holds at most 256 fingerprints for five minutes and is not persisted. API restart loses pending issuance and rotates the session token: obtain a fresh token and explicitly regenerate preview before new dispatch. Already admitted tasks retain their versioned binding and receipts; execution reconstructs current context without requiring the old ledger. Changed required sources, policy, consent or issue scope stop safely; thread reuse also requires an unchanged prompt/execution contract. A working issue can use its existing explicit blocked/resume workflow to authorize a new task, not to retrofit missing historical evidence.

Context preview must not trigger the Phase K portfolio-profile migration: a v1 profile store refuses preview with an explicit migration requirement and unchanged bytes. The existing ordinary migration flow remains separate. Phase L issue and Phase M observation state retain their existing version-1 contracts; Phase N does not migrate or refresh them as a side effect of preview.

There is no Phase N bulk migrator, backup rewrite, downgrade tool or rollback command to run. Preserve ignored local state and earlier Phase K backups. Test evidence uses synthetic legacy/current/future/tampered records and isolated restart fixtures, never normal client state; see [Phase N acceptance](../runbooks/phase-n-acceptance.md#t012-final-closure---2026-10-01). Future incompatible whole-document changes still require the explicit migration/backup/rollback procedure above.

## Phase O additive workflow compatibility

`state/workflows/workflows.json` is an optional strict `schema_version: 1` aggregate, bounded to 16 MiB, 500 workflows, 10000 retained stage generations, 5000 handoffs, 5000 review receipts and 20000 events. Missing reads return empty without creating directories/files; malformed/future/unsafe/inaccessible bytes block ownership and execution without repair. Synchronous state-only mutations reread under the exclusive workflow lock and validate ownership/revisions/immutable history before unique flushed staging and atomic replacement. Unknown or crashed locks are not stolen by age; recovery requires inspected ownership, not deletion to make a test pass.

| Contract | Current behavior; no migration authority |
| --- | --- |
| Legacy task/event history and admission v1 | Remain explicitly supported without byte rewrite or invented grants/reviews. Phase N's legacy retry/thread restrictions remain; changed bound role sources require a new preview, not backfill. |
| `TaskEnvelope.context_admission` v2 | Strict `workflow-stage` binding to server-owned workflow/stage/generation/grant, task/role/scope/plan/handoff/candidate/context. Manifest stays v1; generic API/CLI metadata cannot manufacture this authority. |
| Candidate, issue and testing evidence v1 | Remain unchanged. V2 writer receipts bind admitted scope/context, not legacy implementation metadata; fresh Reviewer/QA receipts supplement rather than rewrite captured verification or historical non-workflow acceptance. |
| Workflow aggregate, RoleHandoff and ReviewReceipt v1 | Strict bounded records retain completed output, grants, decisions, run charges and consumed correction lineage. Supersession appends history; new workflow/task ids, stop or restart do not refund consumption. |

Issue/task/workflow snapshots, task events and Git effects are separate durable operations, not a cross-store transaction. Reserved identities and intents precede admission; execution requires commitment and current controller/lease authority. Recovery may reconcile only exact existing unstarted gaps; missing/progressed/drifted facts and unknown usage pause for a human without redispatch or zero-cost defaults. An active owner fences generic retry/CLI publication/cleanup, including older retained candidate trees.

No Phase O bulk migrator, downgrade, normal-state rewrite or backup conversion is required or executed. Pending preview issuance/session state does not survive restart; durable evidence does, and renewed explicit actions revalidate current sources/policy/consent. Keep earlier ignored state/backups. Synthetic legacy/v1/v2, corrupt/future, partial-persistence and actual API-process restart checks are in [Phase O acceptance](../runbooks/phase-o-acceptance.md); future incompatible formats still require the migration procedure above.

## Phase Q read-model and delivery-facet compatibility

Q adds no primary state file, whole-document version upgrade, bulk migrator, downgrade tool or normal-state rewrite. Its operating API `schema_version: 1` is independently derived from existing validated stores. The existing issue aggregate and evidence record stay v1; only an optional independently versioned nested facet is additive.

| Contract | Current behavior; no migration authority |
| --- | --- |
| Four `/api/operating/` read views | Closed derived v1 responses over bounded, independently read sources. Read paths do not acquire writer locks, create stores, migrate profiles, repair data, refresh providers/Harness, reconcile or dispatch. |
| Existing portfolio profile v1 | Remains unchanged and unavailable to Q composition with a migration-required source refusal. Q never calls the migration-bearing profile list; the earlier explicit Phase K migration flow remains separate. |
| Missing optional source vs invalid/future source | Valid absence stays absent; malformed, future, inaccessible, redirected or unstable sources become unavailable, preserving bytes. One failed source does not discard independent valid sections. Partial/default project facts cannot establish exact totals or readiness. |
| Existing issue evidence without `delivery_observation` | Remains readable without synthesizing the facet, timestamps, manual provenance, candidate acceptance or client response. Ordinary reads do not backfill/rewrite historical records. |
| Present `IssueEvidenceReference.delivery_observation` | Own plain JSON data, closed nested `schema_version: 1`; `null`, undefined, inherited/accessor/proxy, malformed or future facets fail closed. A present invalid value cannot downgrade to absent legacy evidence. |
| Historical manual bindings | Retain their exact candidate revision/fingerprint and historical scope after later candidate invalidation, scope change or commitment-link removal. Historical recording is not a claim that those bindings are currently eligible or technically accepted. |

The five facet kinds are `readiness-reviewed`, `environment-observed`, `handoff-recorded`, `client-response-recorded` and `follow-up-recorded`, always `origin: operator-entered`. Required fields include an explicit nullable commitment ID, occurred-at time, private summary (1..500 characters), inert source reference (1..300) and next action (1..500). Observed time must not exceed server-created time; request generation, file time and current observations do not manufacture historical evidence. Source references are opaque identifiers or restricted HTTP(S) text, never fetched, executed or interpreted as paths. The runtime validator, evidence schema and issue cross-record invariants validate the facet together; its informational status, null task/run identities and absence of a testing receipt prevent it from replacing verification/review evidence.

Recording is an explicit 8-KiB no-store protected POST through the existing issue aggregate lock: reread, validate current aggregate, check exact issue/project/revision/scope and explicit confirmation, append evidence plus metadata-only audit, validate, uniquely stage and atomically replace. A candidate triple must be all-null or match the latest non-invalidated same-project candidate and its exact scope/revision/fingerprint at recording. An optional commitment must already be linked to the issue and pass a stable strict bounded same-project portfolio read; that store is neither locked for a joint transaction nor written. Existing cooperating-reader/race limitations remain.

Queued/running linked tasks, a workflow owner other than completed/cancelled, unavailable ownership, stale/repeated revisions and overflow refuse without appending or changing source bytes. Manual records are capped at 64 per issue within the existing 500 issue-evidence, 5000 aggregate-evidence and 20000 audit-event limits; no automatic eviction is permitted. The append advances ordinary issue revision/audit but changes no lifecycle, authorized scope, task/grant ownership, correction allowance or commitment. Explicit subsequent previews/actions must use the new revision normally; no existing progress guard or timeout is weakened.

There is no Q migration/rollback command to run and no reason to rewrite earlier backups. Keep ignored local state and existing Phase K backups. Do not strip facets, silently repair invalid state or overwrite newer bytes to simulate downgrade compatibility; an incompatible future conversion still requires the explicit backup/migration/rollback procedure above. API restart rotates the HTTP token; durable manual facts remain stored, while new actions require fresh session authority and current bindings.

Synthetic legacy/current/future/malformed, refusal, exact-byte and isolated real API/browser reload/restart coverage is described in [Phase Q acceptance](../runbooks/phase-q-acceptance.md). That record, not this compatibility description or a scoped PASS, determines the actual gate result. Q does not complete deferred P T015-T026 or activate production budget cutover, pending routine effects, maintenance, backup, restore or recovery.

## Factory Local retained Planner recovery compatibility

The workflow v1 aggregate supports one optional closed independently versioned `GovernedWorkflow.planner_recovery` v1 facet. Historical absence remains absence without backfill; present null, malformed, inherited/accessor/proxy or unknown versions fail closed. The receipt stores server-resolved task/run/context/output/grant/accounting fingerprints and explicit human question/risk dispositions, not a copied task or new grant. Once inserted it cannot be removed or changed, including after rejection, cancellation or final workflow completion.

Confirmed offering and its pending exact-plan decision share one existing workflow-lock/atomic replacement. Only the exact already finished planning stage may move from retained running to `needs-review`; task/result/metadata/event bytes, output, grants, accounting, caps and counters are unchanged. Reads and failed/stale requests do not repair state. No issue mutation, new store, bulk migration or multi-store transaction is introduced. A composite decision fingerprint binds the original output and immutable recovery; the approved-plan reference and context-admission v2 shapes remain unchanged.

The new reader explicitly recognizes a human-approved planning prerequisite when validating successor handoff/context and final workflow completion. It retains `needs-review` in the original stage/task and does not reinterpret other incomplete stages. Missing or invalid recovery cannot act as ordinary success. Existing unstarted-intent recovery retains its prior conditions. An older strict reader may refuse the facet: rollback must preserve full state and use compatible code, never strip it, rewrite task history or overwrite newer progress. See the [delta](../proposals/factory-local-f3-planner-recovery-design.md) for actual acceptance status; real recovery remains separately authorized.

## Factory Local uncharged first-claim journal compatibility

Workflow aggregate v1 additionally supports optional closed nested `uncharged_claim_recovery` v1. Historical absence stays absent without migration or backfill; null, future, unsafe or malformed values fail closed. Immutable provenance binds original archive/task/event/source/native/plan/context facts and a human operational decision. Only the journal phase and its exact appended event binding advance monotonically from prepared to task-requeued to ready. It cannot be removed, replaced, reused, regressed or skipped, including after completion/cancellation.

Workflow, task and event stores retain separate existing locks and replacements; this is not a cross-store transaction. Each boundary revalidates immutable facts and expected revisions. Prepared state blocks dispatch; same-operation restart continuation is allowed only at recognized exact snapshots, while a requeued snapshot missing its recovery event stays blocked. Only the final proven transition can mark the specific explained accounting gap complete, with every numeric charge unchanged. Original Engineer bytes are archived rather than kept as the current snapshot; Planner bytes and prior event prefixes are retained exactly. Rollback requires compatible code and complete preserved state, never facet stripping or forced overwrite. See the [delta](../proposals/factory-local-f3-engineer-claim-recovery-design.md) for actual acceptance status and separate real-action authority.

## Factory Local F2 additive manual-intake compatibility

F2 retains `state/issues/issues.json`, the issue aggregate `schema_version: 1` and `WorkIssue.schema_version: 1`. It adds only the optional, independently versioned `WorkIssue.intake_receipt` facet; no new store, whole-document upgrade, bulk migration or legacy backfill is introduced. This implementation description does not establish full F2 acceptance.

| Contract | Current behavior; no migration authority |
| --- | --- |
| Historical issue without `intake_receipt` | Remains readable with the facet absent. Reads and later issue updates cannot manufacture an original request identity or retrofit a receipt. Identified direct internal legacy callers may still create an unkeyed issue; the manual HTTP endpoint does not expose that compatibility path. |
| Present `intake_receipt` | Closed own plain-JSON data with exactly `schema_version: 1`, `request_id` and `request_fingerprint`. The ID is lowercase hexadecimal in UUID 8-4-4-4-12 form; the fingerprint is 64 lowercase hexadecimal characters containing SHA-256 of the original normalized create input. |
| Null, undefined, inherited/accessor, proxy, malformed or future facet | Fails closed with source bytes retained. A present invalid facet cannot fall back to the absent legacy branch; there is no automatic repair or field stripping. |
| Request identity and immutable ownership | Request IDs are globally unique across the issue aggregate, including different projects. Existing receipts and their issue owners must remain unchanged: later mutations cannot remove/change a receipt, delete its owner or backfill a legacy issue. |
| Original request fingerprint | Covers the 16 declared normalized create-input fields; `request_id` itself is excluded. It uses current normalization/defaults, stable object-key order and preserved array order. Generated IDs, lifecycle/revisions/timestamps and derived classification are excluded; the fingerprint is not recomputed from a subsequently changed issue. No duplicate request body is persisted. |

The manual `POST /api/work-issues` requires its own valid `request_id` and refuses caller-supplied `intake_receipt`. Existing loopback/origin/session, project-access and input-validation checks still apply. Under the existing issue lock, the service rereads and validates the aggregate, then resolves identity before new-create capacity, reference and classification/plan constraints. Equal original normalized payload returns the current issue, including legitimate later progress, without replacement, another audit event, revision/timestamp advance or state reset. A different valid normalized payload or project with the same identity returns `409`; distinct identities permit intentionally identical content. New creation remains bounded to 500 issues.

The response remains `201` with `{ issue }`, including replay. That status does not count new records or authorize scope, tasks, workflow grants or publication. Only the explicit keyed conditional writer skips replacement when validated state is unchanged; ordinary issue mutations retain their prior write behavior, lock and atomic replacement. This is one issue-aggregate operation, not a transaction with tasks, workflows or Git effects.

The browser keeps only the pending UUID in `sessionStorage`; the submitted body remains in memory for an explicit identical retry. Reload loses that private body and consults the existing validated GET. Missing, failed or incomplete evidence remains uncertain; cancelling the pending local intent requires acknowledgement that a server issue might already exist and does not delete it. Request identity is neither a credential nor a human approval, and no new route or automatic execution follows recovery.

An older pre-F2 strict reader may reject issues carrying the new facet. Rolling back code is not a state downgrade procedure: preserve the complete bytes and earlier ignored backups, never strip receipts or overwrite newer state to force compatibility. Any future incompatible conversion still requires the explicit backup/migration/rollback procedure above and a separate human recovery decision. No F2 migration or downgrade command exists to run.

See [Factory request contract acceptance](../runbooks/factory-request-contract-acceptance.md) and the [approved task evidence](../../.agents/specs/tasks/factory-request-contract.tasks.md). T002-T006 focused results do not certify the new full API/Vite/browser campaign, its cleanup, the final gate or a prepared real pilot. Those remain T008 work requiring separate continuation; historical P/Q acceptance and all execution/publication gates remain unchanged.
