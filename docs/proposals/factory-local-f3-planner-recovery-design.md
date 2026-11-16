# Factory Local F3 — retained Planner proposal recovery

Status: APPROVED for technical implementation and synthetic acceptance, acknowledged 2026-11-03T15:04:07Z. The owner explicitly approved the exact 32-file design, [spec](../../.agents/specs/planner-recovery.spec.yaml) and [T001–T005](../../.agents/specs/tasks/f3-planner-recovery.tasks.md) in this conversation. This acknowledgement is not an inferred earlier human timestamp. Application to the private workflow, real model calls, commit, push and merge remain unauthorized. Existing approvals and failed attempts are not rewritten.

Technical status: T001-T005 acceptance is complete. See [observed results](#technical-acceptance--2026-11-03); real application remains separate.

## Problem and observed baseline

The [renewed F3 launch](factory-local-f3-design.md#renewed-planner-launch--complete-accounting-incomplete-role-result-2026-11-03) retained one finished read-only Planner with schema-valid `kind: plan`, `status: needs-review`, unchanged scope and an exact output fingerprint. Its terminal-usage receipt passed; accounting is complete at 21512 tokens and 14232 ms, with one task/attempt. The model requests human plan approval and retains an unmeasured verification-cost risk. No pending plan decision, Engineer, candidate or review exists. The original interrupted attempt remains separately preserved with unknown final accounting.

Current code behaves consistently with its contract:

- `roleOutputResult` preserves the model status; the generic task failure label is not proof of malformed output.
- `WorkflowOrchestrator.reconcile` refuses incomplete task/output outcomes. Ordinary plan gating requires a completed planning stage and completed output.
- `WorkflowService.decide`, `admitSuccessor`, handoff sealing and stage context independently require completed predecessor facts. Unresolved questions also block ordinary admission.
- `recover` only reconciles provable existing, unstarted admission gaps. It cannot accept this executed task.
- Workflow validation requires completed stage slots at final completion. Merely adding a pending decision would leave later guards unsatisfied.

The checkout remains `codex/phase-q-operating-views` at `53ed01fd23bf62f1f08381b48f74b70595ef33f5`, with pre-existing tracked/untracked work preserved. F2 functional and F4 synthetic technical acceptance remain complete; global suite/CI debt remains open. This proposal neither completes F3 nor starts F5.

## Chosen behavior

Introduce one explicit, human-origin recovery of a retained planning proposal in an existing implementation workflow. Recovery makes the unchanged plan available for the existing exact-plan approval; it does not declare the Planner successful. There is no new model invocation, task, attempt, root grant, budget or correction allowance.

This is a prospective exception to planning-continuation eligibility, not a claim that the current guard already permits it. Ordinary completion, all other roles and existing unstarted-admission recovery keep their current rules. There is no generic acceptance of `needs-review`, retry endpoint, plan editor, arbitrary human-authored replacement or output conversion.

The operator must review the exact retained output, all original questions and risks, current scope, known charges and remaining caps. Each question receives an explicit disposition, bound by its index and text hash: either defer the requested plan-approval question to the next exact gate, or record a nonmaterial operator clarification within the unchanged plan. All risks require individual acknowledgement. Prose classification is not automated or inferred from language. An unresolved material question, changed plan/scope or request to waive a trusted check remains ineligible.

| Boundary | Result | Effects permitted |
| --- | --- | --- |
| Read recovery offer | Current eligibility/reasons and exact source fingerprint | Read only; no decision, preview issuance, reconciliation, task or role turn |
| Explicitly offer retained proposal | Immutable recovery receipt and one pending plan-approval decision; workflow `waiting-human` | One workflow aggregate replacement; no task/issue update or worker notification |
| Reject exact plan | Workflow `needs-decision`; receipt and original evidence remain | Existing human rejection semantics; no new offer or successor |
| Approve exact plan | Bind the unchanged output and human recovery to the approved plan | Existing controller may admit only the finite Engineer successor after all current checks |
| Later Engineer/Reviewer/QA and acceptance | Existing candidate-bound verification and human criterion gate | No publication, integration or new capabilities |

Design approval is not the recovery request or exact-plan approval. No action is submitted against the real pilot during technical implementation/acceptance. Its former exclusive-writer window has expired; a later operational re-entry must renew current baseline, source/runtime bindings and owner-declared writer/instance coverage before any approval capable of starting Engineer. Remaining budget is retained, not replenished.

## Eligibility and binding

The recovery offer and confirmed mutation must independently establish all of the following; missing/unavailable evidence is a denial:

1. The current owner is the existing `implementation` template, its first and only admitted stage is `planning`/`planner`/`read-only`, and the issue remains `authorized` or `working` under the exact current scope. No candidate, successor, correction consumption, approved plan, pending decision or prior recovery receipt exists. The workflow is `needs-decision`/`awaiting-human`, without a durable stop. No production P budget-admission scaffold is activated or supported through this exception.
2. The retained task is valid, finished `needs-review`, with no lease/cancellation, and its task/run/stage/generation/grant/authority/context/issue bindings and committed admission intent agree. Its stored result must equal the existing normalization of this exact valid `needs-review` plan. The expected terminal output failure must be attributable to that status, not accepted from a matching error string alone. Transport, policy, scope, budget, lease and other failures are ineligible.
3. The output validates against the existing closed plan contract and same-issue evidence, has `scope_change_required: false`, is already safe under current redaction, and still hashes to the retained fingerprint. Neither the plan array nor any original output field is editable by the request.
4. The existing terminal-usage validator accepts the retained receipt with exact task/run/context/thread/turn/usage binding. The matching charged run and all workflow accounting are complete, immutable and below applicable current caps. The receipt proves operational transcript completeness, not provider-final billing. No historical unknown ledger is repaired.
5. Current issue revision, authorized scope, role-to-agent assignments, per-role sharing, source fingerprints, policy, testing and review depth still match the original grant. No material issue change or unsafe ownership can be acknowledged away. Remaining aggregate task/attempt slots cover the three existing downstream roles; positive runtime/tokens and their existing intersections remain mandatory, without a claim of practical sufficiency.

The existing 300000 ms Engineer ceiling includes implementation, commit and verification. Its fixed 250000 ms verification reserve leaves 50000 ms implementation margin; combined cost remains unmeasured. A human may acknowledge that feasibility risk but cannot turn it into passing evidence, skip verification, raise caps or permit a retry. Every downstream role still resolves its current effective remaining budget.

## Persisted contract and immutability

Add one optional, closed, independently versioned `GovernedWorkflow.planner_recovery` v1 facet, at most one per workflow. Keep workflow aggregate v1, task/event formats, context manifest v1, admission v2, role output, grant and approved-plan reference shapes unchanged. Do not create a new store or backfill historical records.

The facet contains server-owned identity/time and a canonical fingerprint; workflow/project/issue/scope, original stage/generation/task/run and task revision; exact source-task/result, output, accepted terminal receipt and accounting fingerprints; original grant/authority/context/policy/testing/source bindings; the new plan-decision ID; explicit human recovery request identity/rationale; indexed question dispositions and risk acknowledgements. Request data never supplies the stored receipt, a task, manifest, grant or output. Bounds reuse existing text/array constraints and the 16-MiB aggregate ceiling. The confirmed HTTP input remains at most 4 KiB; a larger clarification is refused rather than increasing the request bound.

The recovery receipt is append-once and immutable, including after plan rejection or final workflow completion. The task snapshot, result, last failure, metadata, terminal receipt and event bytes are untouched. All old/new root grants, charged accounting rows, counters, correction history and original output/fingerprint remain unchanged. If its retained stage is still `running` despite the finished task, the single recovery mutation may terminalize only that exact planning stage to `needs-review`; an already terminal `needs-review` stage is unchanged. No stage is relabeled `completed`.

The pending decision uses existing `kind: plan-approval` with a composite resource fingerprint over the original output fingerprint and recovery fingerprint. `approved_plan` keeps its existing three fields: original stage ID, original output fingerprint and exact decision ID. Guards distinguish ordinary model-completed plans from human-adopted retained plans by validating the receipt and composite decision binding. Absence of the new facet retains all old behavior; null, malformed, forged or unknown versions fail closed. Older strict readers may reject the new facet; rollback preserves bytes and requires compatible code, never field stripping.

## Service, controller and context integration

Use a pure recovery-domain helper for shape/binding/adoption predicates. Services/controllers reuse the existing terminal-evidence validator at effect boundaries; an unchecked metadata object or caller-provided `verified` boolean cannot qualify. Keep `assertTerminalWorkflowTask` strict for ordinary roles. Add a specifically named planning-proposal guard, not a general terminal-success fallback. Its typed basis distinguishes an offered proposal from an approved human adoption; only the latter satisfies execution or final-completion guards.

Existing workflow detail GET adds a derived, bounded recovery-offer projection with eligibility/reasons and the source fingerprint. It reads current state only; unavailable facts remain unavailable. Reuse the context service's pure resolution/assembly path through a read-only workflow-context inspection method, without calling the preview-issuance ledger. Workflow list/operating summaries must not acquire private clarification bodies or use this receipt as delivery success; list omission is not evidence that no recovery exists, and actions require the current detail. The existing detail can expose the recovery for deliberate inspection without copying prompts, filesystem paths, protocol traces or credentials.

Add protected `POST /api/workflows/:id/planner-recovery`, using existing loopback/origin/fetch-site/session middleware, `no-store` and the existing 4-KiB JSON limit. Closed input includes exact workflow/issue revisions, offer fingerprint, `confirm: true`, approval ID, rationale, complete indexed question dispositions and risk acknowledgements. It cannot edit the plan, scope, role mapping, caps or client consent. Stale/repeated requests return conflict without a second receipt/decision. A lost response requires an explicit fresh read, never automatic replay.

Under the existing workflow lock, reread and compare captured workflow/issue/task facts, revalidate the entire proposed aggregate and atomically persist the facet, permitted stage terminalization, pending decision, workflow revision/status and metadata-only events. No nested task/issue/scheduler lock or external effect occurs. Cross-store reads are revision-fenced observations, not a new transaction or an OS-wide writer exclusion. A failed replacement leaves the prior snapshot; a lost response after replacement is reconciled by reading the one persisted receipt.

Plan approval, controller reconciliation, successor admission, handoff sealing, predecessor-context validation and final aggregate completion all use the same narrow basis. For the recovered branch only, the immutable human receipt plus exact approved decision satisfies the planning-proposal prerequisite. The task/stage remain `needs-review`. Never relax Reviewer/QA, verification/candidate, cancellation, unknown-accounting or ordinary predecessor rules.

The handoff explicitly identifies human adoption of an incomplete Planner result and retains original questions, risks and requested decision. Generated Engineer context includes the unchanged original output, exact approved reference and attributed recovery dispositions as task data, with no raw protocol/source documents. Normal 500-line/60000-byte/source-count limits apply; overflow blocks admission. The human decision resolves only the recorded questions; it never erases them or waives required checks. Repeated reconciliation/restart must admit at most one existing finite successor; partial unstarted admission still uses the unchanged legacy recovery path.

Final workflow completion may contain this one human-resolved planning prerequisite, while its original stage/task continue to report `needs-review`. It must still require completed Engineer and required independent Reviewer/QA, passing candidate-bound receipts and actual human criterion acceptance. API/UI labels must distinguish completed workflow, human-adopted plan and incomplete model result; no model-completion count is fabricated.

## UI and repeatable acceptance

WorkflowPanel displays the original outcome, exact plan, questions/risks, retained charges and recovery provenance. A separately labeled, explicitly confirmed action offers the retained plan. It is distinct from **Reconciliar workflow**, which continues to mean unstarted admission reconciliation. There is no prechecked acknowledgement or automatic POST. Refresh, changed facts, lost response and restart clear local confirmations; current detail is required again. The pending exact-plan approval remains the normal next gate. Rejection never creates an automatic second offer.

The isolated test bootstrap gains one explicit `planner-recovery` scenario. Its fake Planner returns the valid incomplete plan plus an actual synthetic receipt produced by the existing receipt constructor with live fixture bindings. Other scenarios retain their current behavior; the real runtime stays forbidden. Browser acceptance exercises recovery, independent plan approval, Engineer/Reviewer/QA, exact candidate acceptance, reload/restart, stale/refused requests and cleanup. Original source/task/event/output/accounting bytes are compared at the applicable boundaries; only expected workflow progress/candidate effects are allowed. Test assertions and existing deadlines are not weakened.

## Exact target set

The proposed set is 32 files: 11 production source/schema files, 3 smoke/fixture/validator-test files, 9 other test files and 9 documentary artifacts. No registry, dependency, lockfile, generated protocol, Harness validator/catalog/pin, normal state or sibling source is a target.

| Slice | Exact paths |
| --- | --- |
| Types and pure guards | `lib/workflows/types.ts`; `schemas/workflow-record.schema.json`; `lib/workflows/planner-recovery.ts` (new); `lib/workflows/validation.ts` |
| Contract/state tests | `lib/workflows/planner-recovery.test.ts` (new); `lib/workflows/validation.test.ts`; `lib/state/workflows.test.ts` |
| Handoff | `lib/workflows/review-evidence.ts`; `lib/workflows/review-evidence.test.ts` |
| Service and context | `dashboard/src/server/workflow-service.ts`; `dashboard/src/server/workflow-service.test.ts`; `dashboard/src/server/workflow-context-service.ts`; `dashboard/src/server/workflow-context-service.test.ts` |
| Controller | `runner/workflow-orchestrator.ts`; `runner/workflow-orchestrator.test.ts` |
| HTTP and UI | `dashboard/src/server/index.ts`; `dashboard/src/server/workflow-api.test.ts`; `dashboard/src/ui/api.ts`; `dashboard/src/ui/components/WorkflowPanel.tsx`; `dashboard/src/ui/components/WorkflowPanel.test.tsx` |
| Isolated browser | `scripts/playwright-local-app-smoke.ts`; `scripts/fixtures/local-issue-api.ts`; `scripts/harness-validators.test.ts` |
| Prospective contract | `docs/proposals/factory-local-f3-planner-recovery-design.md` (new); `.agents/specs/planner-recovery.spec.yaml` (new); `.agents/specs/tasks/f3-planner-recovery.tasks.md` (new) |
| Compatibility and evidence | `docs/architecture/current-architecture.md`; `docs/architecture/execution-runtime.md`; `docs/architecture/organization-state-migration.md`; `docs/security/threat-model.md`; `docs/proposals/factory-local-f3-design.md`; `docs/roadmap/factory-local-poc.md` |

## Proposed verification and stop boundary

At proposal time run only structural spec/task validation without `-Run`/`-ConfirmExecution`, documentary link/privacy checks and whitespace checks. Keep review metadata null. Do not run tests, typecheck, schemas, build, browser, suite, CI, evals or any real runtime now.

After actual design/spec/task approval, T001–T005 run the following mandatory sequence in the foreground, with owned external TEMP/TMP and 900 s per command. Existing test, HTTP, worker, role and capture bounds remain unchanged. New regression groups use the literal `planner-recovery` prefix so focused selection is observable; report passed/skipped/filtered counts separately. Avoid copying private pilot state into fixtures.

1. **C01 contracts:** `pnpm exec vitest run lib/workflows/planner-recovery.test.ts lib/workflows/validation.test.ts lib/state/workflows.test.ts lib/workflows/review-evidence.test.ts --testNamePattern=planner-recovery --silent=passed-only`.
2. **C02 consumers:** `pnpm exec vitest run dashboard/src/server/workflow-service.test.ts dashboard/src/server/workflow-context-service.test.ts runner/workflow-orchestrator.test.ts --testNamePattern=planner-recovery --silent=passed-only`.
3. **C03 HTTP/UI/tooling:** `pnpm exec vitest run dashboard/src/server/workflow-api.test.ts dashboard/src/ui/components/WorkflowPanel.test.tsx scripts/harness-validators.test.ts --testNamePattern=planner-recovery --silent=passed-only`.
4. **C04 existing recovery compatibility:** `pnpm exec vitest run runner/workflow-orchestrator.test.ts --testNamePattern="explicit recovery commits only an existing unstarted task/link gap without redispatch or refund|missing reserved task and source drift stay unrecoverable with retained bytes|changed sources prevent recovery even when the reserved task and link survived|missing final usage is unknown and cannot be recovered as zero or retried" --silent=passed-only`.
5. **C05 catalog gate:** `pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/planner-recovery.spec.yaml -TimeoutSeconds 900`, only after actual execution authority. Runs exactly schemas, typecheck, build and secrets. C01–C04 and browser acceptance remain additionally mandatory; these four catalog checks cannot substitute for behavior.
6. **C06 focused actual API/browser:** `pnpm smoke:local:playwright --planner-recovery-only`, a new test-only early-return selection through the existing bootstrap/cleanup, expected four fake role turns and no paid calls.
7. **C07 actual API/browser compatibility:** `pnpm smoke:local:playwright`, retaining every prior assertion and adding the new four-turn flow; expected 35 fake role turns rather than the prior 31. No retries. Both browser commands require exact terminal results and confirmed owned cleanup.

Required negative cases cover unknown/interrupted accounting, missing/tampered receipt, malformed/blocked/failed output, foreign or changed bindings, incomplete evidence, requested scope change, extra/P-bound role, active lease/cancellation/stop, stale source/revision, absent consent, insufficient aggregate slots/budgets, incomplete question/risk acknowledgement, sensitive text, oversized input/context, duplicate confirmation, approval/recovery races, plan rejection, failed replacement and process restart. Denials assert no extra task/attempt, counter refund, model/worktree/Git/publication effect or task/event rewrite. Reconstructed controllers must not reinterpret a missing or invalid recovery facet as ordinary success.

Every failed/unknown result is retained and stops dependent acceptance. Necessary routine diagnosis may use the owner's standing authority, but scope/contract/limit changes return for review. No full suite, CI, eval or audit campaign is proposed: their historical debt remains explicit, not waived or labeled passed. No synthetic PASS closes the real F3 delivery, renews the expired writer window or approves the private plan/candidate. No local commit, push or merge is included.

## Risks, alternatives and rollback

The principal risk is overgeneralizing human adoption into a success override. Limit it to this first planning stage, require complete independent terminal facts, keep the original outcome visible and use one shared, explicit recovery basis at every affected guard. Human clarification is an attestation, not an independent technical proof. Hashes bind cooperating state; they are not signatures against another process under the same OS user.

Automatic `needs-review` to `completed`, editing retained output, a prompt-only status fix, relaunching Planner or a fresh replacement grant would either falsify evidence, leave downstream guards inconsistent or require more spend/attempt capacity. They are excluded. The chosen path spends no new Planner tokens and preserves the existing three downstream slots, while honestly adding a reviewed human-origin authority path.

Before any real application, rollback is reverting only this increment after checking current user edits. After a receipt exists, retain all bytes and use a compatible reader; do not remove the facet, downgrade state, delete locks or overwrite newer progress. Real recovery, writer ownership, exact plan approval and final candidate acceptance remain separate operational decisions after technical acceptance.

## Technical acceptance — 2026-11-03

T001-T005 are complete for the approved technical increment only. The original model result remains `needs-review`; human recovery offers its unchanged output for a separate exact-plan decision. The real private workflow was not recovered and no role was dispatched against it.

| Check | Observed result | Native duration |
| --- | --- | --- |
| C01 contracts/state/handoff | 29 passed, 213 filtered; four files | 3766 ms |
| C02 service/context/controller | 14 passed, 303 filtered; three files | 73916 ms |
| C03 HTTP/UI/tooling | 7 passed, 265 filtered; three files | 7442 ms |
| C04 existing recovery | 4 passed, 81 filtered; one file | 8467 ms |
| Existing failed atomic replacement/staged write compatibility | 2 passed, 50 filtered; one file | 3631 ms |
| C05 reviewed catalog | Schemas, typecheck, build and secrets: four exit-0 checks | 27022 ms |
| C06 actual API/Chromium, focused | PASS; exactly four fake turns, independent recovery/plan gates, verified candidate, restart/no replay and owned cleanup | 107031 ms |
| C07 actual API/Chromium, complete compatibility | PASS; exactly 35 fake turns, prior workflow assertions plus retained-Planner recovery, restart/no replay and owned cleanup | 842287 ms |

There are **56 unique passing focused cases**, not a whole-suite result. The separate strengthened coherent-scope-drift case passed once after a test-helper correction; it is already counted within C02, not added again. Filtered existing cases were deliberately unselected, not passed. Every passing native capture reported exit 0, root exit and both EOFs without timeout, truncation or stream/spawn error. Both final browser runs reported browser/Vite/API/workspace closure with no cleanup failures, browser errors or HTTP errors.

The isolated browser uses synthetic records and forbidden paid-runtime configuration. It proves unchanged original task/event/output/accounting bytes at the recovery and plan gates, an independent exact-plan approval, one Engineer followed by candidate-bound Reviewer/QA, criterion acceptance and restart without replay. Atomic-store compatibility separately proves prior-byte preservation on failed replacement/staged write. No synthetic result is a real model-producer or delivery qualification.

### Retained failures and scoped corrections

Initial compile and fixture failures remain in private bounded evidence; they were not rewritten as passing attempts. Corrections included explicit header/type narrowing, helper initialization order, an existing snapshot label, and binding the terminal receipt to the execution-contract context fingerprint while separately checking the manifest fingerprint. Original outcomes and charges were never converted or refunded.

The first complete-browser attempt reported timeout and 4003307 ms wall time across an observed host suspension. The 900-second native supervisor could not run during that suspension. A Windows power observation established the sleep/wake interval; its capture lacked native closure and both EOFs, so it remains UNKNOWN beyond the observed timeout. Later read-only observation found no remaining owned fixture/root/direct children; that does not retroactively prove its missing terminal evidence. Subsequent commands used a process-scoped system-awake request, cleared on exit, without display or persistent power-policy changes. The 900-second command deadline and all existing test/HTTP/capture limits stayed unchanged.

The next complete-browser attempt returned known exit 1 after 821500 ms with complete streams and owned cleanup. The workflow-campaign interactions had returned, but restart/no-replay checks were not complete and the ordinary 10-second restart snapshot still had a workflow-detail GET pending. The final scoped correction refuses obviously ineligible recovery projections from their already validated owner snapshot, closes campaign-owned workflow/lineage panels, and drains their existing reads under the unchanged campaign boundary before the ordinary restart capture. Confirmed mutations still reread every authority fact. No assertion, request, hash input or guard was removed; no deadline was raised. Regression tests cover close-before-drain, pending reads and drain failure. C02/C03/C05/C06 and C07 were revalidated as affected.

A further complete-browser run reached the unchanged 900-second supervisor deadline after all workflow-campaign interactions and the read drain, before a terminal restart/cleanup result. Its capture reports 900012 ms, no native exit or EOFs, and is retained as a timeout with unknown terminal/cleanup evidence. The process-scoped awake request was cleared; later read-only inventory found no owned Node/Chromium survivor. The failed synthetic workspace is retained as evidence, not counted as successful cleanup. A scoped fixture adjustment closes the workflow panel during API-only gate waits, reopening it for each existing visual check, and observes independent stable final records together in their original order. Closing panels adds no wait allowance; original effect-capture and visual-transition drains remain mandatory. It preserves all 35 fake turns, every assertion and every current bound; affected focused/catalog/browser checks were rerun.

The subsequent complete-browser run returned known native exit 1 after 328788 ms, with both EOFs, no supervisor timeout/truncation and complete owned cleanup. A newly inserted global drain inside an API-only active-role wait could not settle `/api/overview`, `/api/runs` and `/api/today` within the existing 30 seconds while global pollers kept issuing reads. The correction separates panel closing from draining: server-only waits stop only the duplicate panel poller, retain tracking of every pending/global request, and leave all original drains at effect captures and visual transitions. No original drain, assertion or deadline is removed. Focused/catalog/browser acceptance was revalidated after that correction.

### Evidence, compatibility and next operational boundary

Native receipts, retained failed attempts, power-request closure and final source hashes are held in owned private temporary evidence; public documents contain only sanitized results. The source audit compared 1026 preserved baseline hashes and found all changed pinned sources within the approved 32-path set, with no unrelated changes by this increment. HEAD and the empty index remained unchanged. Final documentary links/privacy/whitespace and structural spec/task validation passed.

No real recovery request, model call, sibling modification, installation/download or commit/push/merge of project changes occurred. Disposable fixture Git commits are synthetic test effects only. Full-suite/CI/eval/audit campaigns were not run; historical global acceptance debt remains open. The additive recovery facet remains absent on the real workflow and compatible historical records.

The next operational package must freshly verify source/runtime/baseline identity and renew the expired exclusive-writer/known-instance coverage. It may then explicitly offer the exact retained plan with current question/risk dispositions; this creates only a pending decision. Actual human approval of that exact plan must precede Engineer. Preserve the original failed attempt and the additional known consumption separately; do not replenish either grant. Verification cost within the existing Engineer ceiling remains unmeasured. A real verified candidate, independent reviews and human criterion acceptance are still necessary for F3; F5 cannot close the pilot before that delivery exists.
