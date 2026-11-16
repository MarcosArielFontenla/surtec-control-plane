# Factory Local F2 - request, context, and plan contract

Status: the owner-approved F2 functional acceptance revision is active as of 2026-10-30T13:46:42Z. This timestamp acknowledges the explicit review in the current conversation; it is not a claim that acceptance passed.

The [reviewed revision](../proposals/f2-functional-acceptance-revision.md) is retained unchanged as the review artifact. The owner authorized activation in five existing documents and documentary checks only. No acceptance command, model call, process cleanup, CI, commit, push, merge or F3 operation is authorized by this activation.

## Current acceptance contract

Behavioral requirements req-001 through req-005, their implementation scope, and all scope/consent/plan, compatibility, receipt and privacy rules are unchanged. Req-006 now explicitly requires the functional procedure below, six catalog checks, Harness, real isolated API/browser evidence and the human pilot checkpoint. Whole-repository regression/performance completion is separately tracked as open `DEBT-F2-GLOBAL-900`.

The [active specification](../../.agents/specs/factory-request-contract.spec.yaml) now lists six formal checks with their original IDs, commands, mappings, descriptions and expected exit 0: `ac-schemas`, `ac-types`, `ac-build`, `ac-repository`, `ac-secrets`, `ac-evals`. `checksWaiver` remains null. Only the blocking F2 role of `ac-behavior` / complete `pnpm test` is retired prospectively; its original definition and failures/timeouts remain historical, never PASS.

The unchanged validator and exact command catalog execute only those six active entries after separate execution authorization. Types/schema/build results are not behavioral acceptance. Unsupported commands, aliases, placeholders, wrappers and waiver-based substitutions are not added to the YAML.

Mandatory external procedure IDs are runbook/task references:

| Procedure | Complete scope | Requirements |
| --- | --- | --- |
| f2-functional-state-http | `lib/state/issues.test.ts`, `dashboard/src/server/issue-service.test.ts`, `dashboard/src/server/index.test.ts` | req-001/002, protected HTTP and zero intake execution effects |
| f2-functional-context-plan | `lib/context/sources.test.ts`, `dashboard/src/server/context-service.test.ts`, `dashboard/src/server/workflow-api.test.ts` | req-004/005, current sources, scope/consent and exact human plan gates |
| f2-functional-ui | `dashboard/src/ui/views/IssuesView.test.tsx`, `dashboard/src/ui/components/ContextPreview.test.tsx`, `dashboard/src/ui/components/WorkflowPanel.test.tsx` | req-003/004/005, pending request recovery, evidence/privacy and bound UI decisions |
| f2-functional-smoke-helpers | Existing read-synchronization / Issues-refresh helper selection in `scripts/harness-validators.test.ts` | req-006; helpers do not replace the real browser |

Run the nine complete files in the three approved groups; only the existing helper selection uses a name filter. The [current acceptance runbook](../runbooks/factory-request-contract-acceptance.md#current-f2-functional-acceptance) fixes commands, order and evidence. Each command retains 900 seconds, foreground native completion, owned qualified external TEMP/TMP, existing environments/termination boundaries, two configured workers and all test/poll/command limits.

After all six checks and four functional commands pass, `pnpm harness:check` and the existing `pnpm smoke:local:playwright` remain mandatory under separate execution authority. The smoke uses the real local API/Vite/browser with isolated synthetic state/repositories and exactly 31 fake turns, preserving K-O and all F2 intake/context/plan/replay/reload/restart/refusal assertions. Record native result, scope/inventory/skips, browser/API errors, owned closure and fixture removal independently. Unknown or failed evidence stops successors.

The owner must still confirm the already supplied private pilot's exact baseline, outcome/criteria, allowed/excluded paths/categories, sources, trusted verification and approver. No private checkout is accessed or reproduced by this revision. A missing checkpoint leaves T008 unchecked, even after automated functional verification passes.

F2 may be reported complete only as functional acceptance for the local PoC, after all revised criteria and the human checkpoint pass with current attributable evidence. The [task plan](../../.agents/specs/tasks/factory-request-contract.tasks.md) remains in progress and T008 unchecked. This does not certify the original full gate, complete-repository/CI/Q success or deferred P work, and grants no F3 dispatch, paid call or publication authority.

## Global suite debt and preserved boundaries

`DEBT-F2-GLOBAL-900` is an open separate [roadmap debt](../roadmap/factory-local-poc.md#debt-f2-global-900), not a waived non-executable check or an unfinished extra F2 task. The original gate timed out at 901630 ms outer wall; complete-suite attribution reached 900000 ms with workflows pending. Seven negative tests, four references and typecheck passed later, without proving sufficient global savings. Preserve every historical outcome and cleanup uncertainty.

Resolving the debt requires a complete unfiltered `pnpm test` result with known native exit 0, terminal/stream and relevant lifecycle evidence under the existing limits, with skips/limitations reported. The package/CI script and its full suite remain unchanged. No new profiler, test deletion, worker/concurrency change, timeout increase, runtime permission, Harness guard/schema/catalog/pin change or migration is part of this acceptance revision.

The owner explicitly approved this delta on 2026-10-30. Original approval acknowledged at 2026-10-24T14:25:58Z remains in the preserved history below. Current authorization is documentary only; the revised acceptance has NOT RUN.

## Original design and evidence (historical)

The original design below is preserved verbatim. Its original seven-check gate and T001-only notices describe earlier checkpoints; the current acceptance contract above supersedes only their F2 acceptance/authority descriptions.

Status: prospective design approved by the repository owner in the current conversation. The owner approved the 22 target paths and ordered T001-T008 plan, then authorized **T001 only**, including documentary checks. Approval was acknowledged at `2026-10-24T14:25:58Z`; this is the session acknowledgement time, not an inferred earlier approval or phase-completion time.

The [specification](../../.agents/specs/factory-request-contract.spec.yaml) and [task plan](../../.agents/specs/tasks/factory-request-contract.tasks.md) record the same scope. The [Factory Local roadmap](../roadmap/factory-local-poc.md) remains the active direction. Its earlier not-started label is historical relative to this explicit T001 continuation; the roadmap will be updated only in its authorized T007 slice. This document does not start T002 or F3.

## Goal and existing-code baseline

F2 closes the manual request contract through one functional delta: durable intake idempotency. Reuse the existing WorkIssue, attributed context preview, exact-plan approval, and workflow authority. Demonstrate those existing paths rather than adding a tracker, screen, context engine, or runtime.

Static inspection found that `dashboard/src/server/issue-service.ts` creates a new issue UUID per call and `lib/state/issues.ts` always writes after a mutation callback. `ContextPreview` already displays source identities, revisions, inclusion reasons, bounds, exclusions, and configured verification commands. `WorkflowPanel` already exposes role manifests, exact root confirmation, and decision/revision/fingerprint-bound plan approval. These findings are not new execution evidence.

The observed baseline remains branch `codex/phase-q-operating-views`, HEAD `53ed01fd23bf62f1f08381b48f74b70595ef33f5`, empty index, and 91 pre-existing changed/untracked paths after F1. Preserve those files. A commit alone does not identify the dirty worktree, and T001 neither isolates nor integrates it.

## Requirements and authority

| ID | Observable requirement | Planned coverage |
| --- | --- | --- |
| req-001 | Repeating a manual request preserves identity and returns the current issue without duplicate issues, events, revisions, or state writes | T002-T004, T006, ac-behavior |
| req-002 | The receipt is strict, globally unique and immutable; historical absent receipts remain readable without migration | T002-T003, ac-schemas, ac-behavior |
| req-003 | UI preserves pending request identity through a lost response and exposes unresolved outcomes instead of silently creating again | T004, T006, ac-behavior |
| req-004 | Context shows selected sources, revisions, reasons, exclusions, and trusted configured checks without granting authority | T005-T006, ac-behavior |
| req-005 | Current human scope, consent, and exact-plan decisions remain required; obsolete authority cannot enable writing | T005-T006, ac-behavior |
| req-006 | Acceptance uses isolated synthetic state and repositories, real local API/browser, protocol fakes, and honest terminal/cleanup evidence | T006-T008, ac-behavior and repository/security/evaluation checks |

Only T001's three planning artifacts may be written now. T002-T008 execution requires continuation authorization. Embedded commands, approved metadata, and structural validation do not execute checks or confer product authority. No paid runtime, real issue creation, normal-state migration, sibling change, process cleanup, publication, or F3 operation is authorized by this checkpoint.

## Intake identity and compatibility

Add an optional independently versioned `WorkIssue.intake_receipt` inside the existing issue v1 aggregate. Its closed plain-JSON shape is `schema_version: 1`, canonical UUID `request_id`, and SHA-256 `request_fingerprint`. The server owns the receipt; a request-supplied receipt cannot manufacture it or any approval. Keep the existing 500-issue bound and use a bounded lookup rather than a new state file or index.

The public manual `POST /api/work-issues` requires `request_id`; missing or invalid keys return 400. Retain `IssueCreateInput.request_id` as optional for identified internal legacy callers and existing direct-service fixtures. Preserve `create(raw): WorkIssue`. That compatibility path is not exposed as an HTTP escape hatch. Inventory and update all existing HTTP callers: the UI client/form, the current index test, and the general smoke's synthetic create requests.

Keep the response body `{ issue }` and current HTTP 201 contract, including replay. This status must not be interpreted as a new-create count or writing authority; identity, receipt, audit count, and unchanged bytes establish replay behavior.

| Input under the existing issue lock | Result |
| --- | --- |
| New valid UUID and valid payload | Persist one proposed issue, server receipt, and existing proposal audit event atomically in the issue aggregate |
| Existing UUID and equal normalized original payload | Return the current issue with its original receipt; no write, audit append, timestamp/revision advance, state reset, task, or grant |
| Existing UUID and different payload, including project | 409; preserve bytes and existing identity |
| Different UUIDs and identical content | Allow distinct legitimate proposals; do not deduplicate by title or payload hash |
| Existing local lock conflict | Preserve current 409 behavior; any later explicit retry uses the same UUID, with no new automatic retry loop |

Normalize the complete input with current field validation/defaults and stable object-key ordering. Include project, objective, parent, title, expected outcome, acceptance criteria, the complete authorized scope, declared classification inputs, plan, priority, criticality, blockers, assigned role, commitments, external references, and next action. Preserve array order. Exclude only `request_id` and generated/derived values such as issue ID, work scale/rationale, status, revision, and timestamps. Persist no duplicate payload body. Never recompute the original fingerprint from a subsequently mutable issue.

After current HTTP protection and input normalization, acquire the existing issue lock, reread/validate the aggregate, then resolve identity/replay/conflict. Only a new request checks create capacity and mutable creation references before generating and writing the new record. Replay must remain recoverable when capacity has reached 500 or later legitimate changes altered the issue/references. Preserve current access/authority checks; the UUID is not a credential.

Provide an explicit locked no-write path for replay, keeping the ordinary mutator's existing behavior for other callers. Validate receipt shape before unsafe in-memory property access/serialization, enforce global UUID uniqueness, and prevent later removal/change or backfill on an existing legacy issue. Do not weaken the reader, lock, atomic replacement, or temporary-file ownership rules.

Historical missing facets remain missing. Present null, malformed, inherited/accessor, or future facets fail closed without repair. A pre-F2 strict reader may reject new facets: code rollback must preserve their bytes and cannot silently delete them for downgrade compatibility.

## UI intent and uncertain outcomes

Generate a UUID for the logical form attempt, not inside `createWorkIssue()` on each call. Keep the pending UUID and submitted payload in memory for explicit same-request retries. A confirmed success permits a new identity for a subsequent deliberate request. A payload conflict must not silently rotate the UUID.

Persist only the pending UUID in `sessionStorage`, never private form text or the complete request. After reload, use the existing validated issue GET to reconcile the UUID. A matching receipt identifies the current issue. Missing data, failed reads, or incomplete coverage do not prove that creation never happened. Keep an unresolved state visible and provide an explicit resolve/cancel decision; do not automatically create another request. If safe identity retention or resolution is unavailable, expose that limitation rather than claiming safe replay.

Existing busy controls remain useful for interaction, while the server receipt establishes durable replay behavior. Intake and reconciliation never authorize scope, queue a task, or approve a workflow.

## Context and exact-plan demonstration

Keep production `ContextPreview`, `WorkflowPanel`, `context-service`, source selection, and `registry/context-policy.yml` unchanged. Use the existing test mechanisms and a synthetic project's contained manifest to select a small README, architecture/ADR, and contract. Assert paths/IDs, revisions, inclusion reasons, verification commands, and exclusion of unselected or other-project content. Do not add global routes: the current route contract has no project filter.

Demonstrate no-effect preview, source/scope/consent drift refusal, fresh issuance after restart, exact human plan decisions, and context text that cannot broaden capabilities. Reuse existing component/workflow tests where coverage already exists. A configured command is not a successful verification result. No universal semantic contradiction detector or stronger runtime read isolation is claimed.

## Ordered scope and exact target paths

The approved whole-feature whitelist contains 22 paths. Only the first three belong to the current T001 write boundary.

| Task | Exact paths |
| --- | --- |
| T001 | `docs/architecture/factory-request-contract-design.md`, `.agents/specs/factory-request-contract.spec.yaml`, `.agents/specs/tasks/factory-request-contract.tasks.md` |
| T002 | `lib/issues/types.ts`, `schemas/work-issue.schema.json`, `lib/state/validation.ts`, `lib/state/issues.ts`, `lib/state/issues.test.ts` |
| T003 | `dashboard/src/server/issue-service.ts`, `dashboard/src/server/issue-service.test.ts`, `dashboard/src/server/index.ts`, `dashboard/src/server/index.test.ts` |
| T004 | `dashboard/src/ui/api.ts`, `dashboard/src/ui/views/IssuesView.tsx`, `dashboard/src/ui/views/IssuesView.test.tsx` |
| T005 | `lib/context/sources.test.ts`, `dashboard/src/server/context-service.test.ts` |
| T006 | `scripts/playwright-local-app-smoke.ts` |
| T007 | `docs/architecture/organization-state-migration.md`, `docs/runbooks/local-work-issues.md`, `docs/runbooks/factory-request-contract-acceptance.md`, `docs/roadmap/factory-local-poc.md` |
| T008 | Acceptance/evidence updates only in the already listed task plan, acceptance runbook, and active roadmap |

Tasks are sequential T001 -> T002 -> T003 -> T004 -> T005 -> T006 -> T007 -> T008. Add/update tests before or alongside behavior. Keep progress/evidence edits within these planning artifacts and each authorized slice; material scope changes require review. No source change is included in T001.

## Checks and execution boundary

T001 checks are structural validation of this exact spec/tasks pair without `-Run` or `-ConfirmExecution`, local document references, six-requirement/check coverage, ordered eight-task dependencies, exact 22-path whitelist/T001 boundary, whitespace/final newlines, and preservation of pre-existing files. No future runbook is required to exist during T001. The outcome is documentary completion, not F2 acceptance.

The following commands are recorded for later authorization, not executed by T001:

```text
pnpm exec vitest run lib/state/issues.test.ts dashboard/src/server/issue-service.test.ts dashboard/src/server/index.test.ts
pnpm exec vitest run lib/context/sources.test.ts dashboard/src/server/context-service.test.ts dashboard/src/server/workflow-api.test.ts
pnpm exec vitest run dashboard/src/ui/views/IssuesView.test.tsx dashboard/src/ui/components/ContextPreview.test.tsx dashboard/src/ui/components/WorkflowPanel.test.tsx
```

After authorized scoped checks, the formal spec gate uses the unchanged exact catalog: `pnpm test`, `pnpm schemas:check`, `pnpm typecheck`, `pnpm build`, `pnpm repository:check`, `pnpm secrets:check`, and `pnpm evals:check`. Planned expected exits are zero, not observed results. The guarded command is:

```text
pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/factory-request-contract.spec.yaml -TimeoutSeconds 900
```

The complete suite is planned once in that gate. Separate authorized checks are `pnpm harness:check` and `pnpm smoke:local:playwright`; browser smoke remains outside the guarded exact catalog. Keep existing timeouts, assertions, budgets, environments, and cleanup ownership. Stop at the first failed or unknown result; do not automatically replay a campaign, run CI again, add profiling, or modify a guard. Distinguish an intentionally observed behavior RED within an authorized test-development cycle from a failed acceptance gate.

Future cases cover replay after service/API restart and later issue progress; changed payload categories; distinct identities; full capacity; cooperative lock contention; failed replacement with preserved bytes; legacy/invalid/future/duplicate/immutable facets; protected HTTP; lost response after persistence; reload reconciliation; zero tasks/grants from intake; selected source attribution; stale previews; and exact plan approval. Actual API/Vite/browser runs use unique synthetic fixture roots, fake execution, and separately reported owned cleanup.

## Preconditions, risks, rollback, and closure

Q's original protected gate remains a historical PASS. Its latest final CI launch is UNKNOWN because the terminal receipt was unavailable; audit and conditional final smokes were not run. Before another workload, a separately authorized bounded decision must establish ownership/closure and review the completion lifecycle. This document authorizes neither that investigation nor cleanup, and does not infer that old processes remain alive. P T015-T026 remain deferred; no production P cutover or unaccepted continuity/routine effect is activated.

Until that execution precondition is established, do not launch F2 tests or campaigns or mark them passed. T001's documentary checks do not run a product workload or resolve Q. Keep acceptance results, unknowns, and fixture cleanup independently attributable.

Principal risks are payload canonicalization drift, silent UUID rotation, replay that rewrites state, mutable receipt loss, unkeyed HTTP escape, and confusion between a fixture proof and a prepared real request. Enforce the specified invariants and preserve existing privacy/session protections. No dependencies, runtime, schema version migration, policy capabilities, model choice, or budget increases are part of the delta.

T001 rollback removes only these three newly created planning files after confirming ownership and subsequent edits; preserve all pre-existing work. Later implementation rollback cannot erase new normal-state receipts or promise that older strict binaries can read them. Preserve state, explain any incompatibility, and obtain a separate version-aware recovery decision if needed.

Full F2 closure also requires Marcos to identify the real project, desired request, criteria, project sources, and trusted verification commands. The proposed local issue-status filter remains a candidate. If that checkpoint is deferred, report **contract verified with fixtures; real pilot preparation pending**, not full F2 completion or F3 readiness. Do not create a real WorkIssue or make a model call automatically. F3, paid runtime, integration, commit, push, merge, and deploy retain separate authority.

T001's delivery reports actual documentary checks and not-run acceptance commands in the conversation/task checkpoint. T002-T008 remain pending after T001, and historical P/Q statuses are unchanged.
