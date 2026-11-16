# F2 functional acceptance revision

Status: proposed for owner review; not activated.
Prepared: 2026-10-30.

The owner authorized preparing this bounded revision, with the global suite timeout recorded as explicit debt and the other checks retained. This preparation authorizes no tests, CI, process operations, commit, push or merge. It does not approve the exact revision below, modify the active specification, complete T008, or start F3.

Current references: [spec contract](../../.agents/specs/CONTRACT.md), [approved F2 specification](../../.agents/specs/factory-request-contract.spec.yaml), [design](../architecture/factory-request-contract-design.md), [tasks and evidence](../../.agents/specs/tasks/factory-request-contract.tasks.md), [acceptance runbook](../runbooks/factory-request-contract-acceptance.md), and [active roadmap](../roadmap/factory-local-poc.md).

## Decision proposed

Replace only the role of the whole-repository `pnpm test` invocation as a blocking F2 exit criterion. F2 would require the complete functional acceptance procedure below, the six unchanged catalog checks, Harness validation, the real isolated API/browser smoke and the human real-pilot readiness checkpoint.

Record the whole-repository timeout as open debt `DEBT-F2-GLOBAL-900`. Preserve every original FAIL, TIMEOUT and UNKNOWN result. Do not report the old seven-check gate, the complete repository suite, Q acceptance or CI as passed. No test is deleted, disabled, given a larger timeout or silently marked successful.

This is a prospective acceptance-scope change requiring owner approval under the spec contract. The current approved seven-check contract remains active until that approval and the explicit documentary activation. This proposal itself has no execution authority.

## Evidence and limits

- The latest original gate timed out in its first `pnpm test` command: observed outer exit 1, wall 901630 ms, both validator EOFs, empty stdout and the captured timeout error. The other six commands were not reached.
- The following complete-suite diagnostic reached 900000 ms: 151 modules observed, 150 completed/passed, zero failed; 6561 cases observed, 6560 completed, 6546 passed, zero failed and fourteen skipped. Workflow orchestration remained pending. No final suite summary, native suite exit or EOFs were observed before termination.
- The workflow file had 72 completed cases accumulating 475276.7324 ms of reported durations. Its open case at 1028:118 had local age 29514.4416 ms, which does not establish that case's timeout or internal cause. Counts do not include tests that had not started.
- The subsequent seven-negative-case checkpoint change passed 7/7, four historical references and typecheck. Seven cases still reported about 262 seconds; the timing comparison does not establish savings sufficient for a 900-second complete suite.
- The evidence supports a narrower, explicit F2 decision; it does not establish complete repository regression coverage, a causal performance diagnosis or historical fixture-cleanup success.

Baseline observed while preparing this proposal: HEAD `53ed01fd23bf62f1f08381b48f74b70595ef33f5`, branch `codex/phase-q-operating-views`, empty index and 102 pre-existing changed/untracked files. Preserve their contents. A commit does not by itself identify this dirty baseline.

## Proposed acceptance contract delta

Keep `req-001` through `req-005` and their behavior unchanged: durable request identity, strict immutable compatible receipts, explicit pending UI recovery, attributed bounded context and exact human scope/plan gates.

Keep `req-006`'s isolation, fake execution, real API/browser, honest native/cleanup evidence and human pilot confirmation. Amend its acceptance boundary explicitly: F2 requires all functional and non-functional checks in this proposal; full-repository regression/performance coverage is separately deferred under `DEBT-F2-GLOBAL-900`. Fixture evidence cannot establish real-pilot readiness, Q acceptance, F3 authority or publication.

Prospective YAML changes:

1. Retire only `ac-behavior` / `pnpm test` from the active `designContract.acceptanceChecks` array. Preserve its original definition/results in the append-only revision history and the debt record; do not relabel it PASS.
2. Retain the six check IDs, commands, requirement mappings, descriptions and expected exit codes below. Their limited purpose remains explicit: types and schemas do not prove runtime behavior.
3. Keep `checksWaiver: null`. An executable suite that times out is not a genuinely non-executable criterion.
4. Add constraints naming the mandatory external functional procedure and the human checkpoint. Do not add unsupported shell commands, placeholders, new schema fields or wrappers to the exact H4 catalog.
5. Preserve all security, scope, compatibility, budget and 900-second-per-command constraints. Preserve the original check catalog itself; changing which reviewed checks F2 requires does not modify the executor.
6. A later activation must record actual new owner-review evidence and retain the original 2026-10-24 approval as history. This draft creates no new approval metadata.

The revised six-check H4 gate would contain exactly:

| ID | Command | Requirement references | Expected exit |
| --- | --- | --- | --- |
| ac-schemas | `pnpm schemas:check` | req-001, req-002 | 0 |
| ac-types | `pnpm typecheck` | req-001 through req-006 | 0 |
| ac-build | `pnpm build` | req-003, req-004, req-005, req-006 | 0 |
| ac-repository | `pnpm repository:check` | req-006 | 0 |
| ac-secrets | `pnpm secrets:check` | req-002, req-003, req-004, req-006 | 0 |
| ac-evals | `pnpm evals:check` | req-004, req-005, req-006 | 0 |

The six-check gate alone cannot complete F2. Behavioral acceptance remains executable and mandatory through the separately reviewed fixed commands below, just as the existing real browser procedure is outside the guarded catalog. No waiver stands in for those results.

## Mandatory functional procedure

These are proposed future commands, not commands executed by this document. Each invocation retains the existing 900-second limit, foreground execution, separately owned qualified external TEMP/TMP, purpose-specific environment and owned-process termination boundary. Test timeouts, the two configured workers, assertions and runtime capabilities remain unchanged.

Run the nine complete test files already named by the F2 design in their three existing groups. Do not filter individual cases within these files. Record the actual inventory, native result, expected files, skips and reasons; an unexplained or requirement-critical skip cannot count as completed acceptance.

| External procedure ID | Complete files / scope | Required coverage |
| --- | --- | --- |
| f2-functional-state-http | issues store, issue service and API index | req-001/002: canonical identity, replay/conflict, progress/restart, capacity, legacy/future/malformed/immutable receipts, locks/atomic failures, protected HTTP and zero intake execution effects |
| f2-functional-context-plan | context sources, context service and workflow API | req-004/005: contained README/architecture/ADR/contracts, attribution and revisions, bounds/exclusions, fresh issuance, consent/scope and exact current human plan decisions/refusals |
| f2-functional-ui | IssuesView, ContextPreview and WorkflowPanel | req-003/004/005: pending UUID/payload, storage/refusal, retry/reload/cancellation, context evidence/privacy and bound root/plan/risk/final decisions |
| f2-functional-smoke-helpers | existing read-synchronization / Issues-refresh helper selection | req-006: helper correctness supporting the browser procedure; never a substitute for the real browser run |

```text
pnpm exec vitest run lib/state/issues.test.ts dashboard/src/server/issue-service.test.ts dashboard/src/server/index.test.ts --bail=1

pnpm exec vitest run lib/context/sources.test.ts dashboard/src/server/context-service.test.ts dashboard/src/server/workflow-api.test.ts --bail=1

pnpm exec vitest run dashboard/src/ui/views/IssuesView.test.tsx dashboard/src/ui/components/ContextPreview.test.tsx dashboard/src/ui/components/WorkflowPanel.test.tsx --bail=1

pnpm exec vitest run scripts/harness-validators.test.ts --testNamePattern="isolated browser smoke (read synchronization|Issues refresh)" --bail=1
```

The helper filter is the existing reviewed selection, historically 28 active cases with 70 filtered skips. Verify actual coverage against the current source; missing selected cases are not passing evidence. The other three groups select complete files. Prior passes and complete-suite partial counts remain historical rather than automatically satisfying the revised acceptance.

External procedure IDs are runbook/task references, not invented `acceptanceChecks` entries or aliases in the guarded YAML. Their execution still needs explicit owner authority and fixed argument lists. No generic shell evaluator, package script, dependency or new capture framework is added.

## Other required checks and human confirmation

`pnpm harness:check` remains required. After preceding required checks pass, `pnpm smoke:local:playwright` remains required through its actual local API, Vite and browser, using isolated synthetic repositories/state and the injected fake executor.

The browser run must retain all prior K-O scenarios and exactly 31 fake turns, with no extra dispatch from the new intake/context/recovery assertions. Require the real identity/replay/byte checks, double submission, lost acknowledgement, retry/reload reconciliation, progress/restart behavior, stale/forged scope/preview/plan refusals and explicit human gates. Record browser/API errors, native completion, owned process closure and fixture removal separately. An unconfirmed lifecycle/cleanup result is incomplete acceptance; do not silently delete evidence or unknown resources.

The owner must confirm the already selected private pilot's exact baseline, requested outcome and criteria, allowed/excluded paths/categories, contained context sources, trusted verification commands and approver. The business request already supplied in the conversation is not requested again. Technical preparation/inspection needs its own authorized scope; this proposal neither touches the private checkout nor persists its source, paths or business details.

Fixtures cannot satisfy that human checkpoint. If automated functional verification passes but pilot readiness is missing, retain T008 unchecked and F2 in progress, reporting functional verification complete with pilot preparation pending.

## Proposed future sequence and stop conditions

After exact owner approval of this revision:

1. Apply the five existing-document changes listed below and record the approval. Run only separately authorized structural/documentary validation without `-Run` or `-ConfirmExecution`; it is not acceptance.
2. Under separate explicit execution authority, run the revised six-check H4 gate once using its unchanged validator and `-TimeoutSeconds 900`. Label it the revised six-check gate, never the original seven-check PASS.
3. If all six pass, execute each of the four fixed functional commands once in the order above.
4. If they pass, run `pnpm harness:check`; only after that passes, run the isolated real API/browser smoke once.
5. Complete and obtain the private-pilot technical/human readiness confirmation, without creating a real issue or making a paid model call.
6. Only after every required result is known and passing, relevant cleanup is confirmed and the human checkpoint is complete, mark T008 complete under the revised functional acceptance. Record the global debt as still open.

Any failed or unknown command stops the sequence; successors stay NOT RUN. Do not rerun the complete suite through this sequence, repeat it through CI, repair automatically, add profiling, loosen assertions, change limits or clean unrelated processes. No timing completion guarantee is made for the proposed groups.

Future gate invocation after activation and execution approval:

```text
pwsh -NoProfile -File .agents/scripts/validate-spec.ps1 -Run -ConfirmExecution -SpecPath .agents/specs/factory-request-contract.spec.yaml -TimeoutSeconds 900
```

Until activation, that same invocation still means the existing seven-check gate and includes `pnpm test`; it must not be executed on the assumption that this proposal has changed it.

## Completion labels and remaining authority

| State | Allowed report / task status |
| --- | --- |
| This draft exists | Proposed revision only; current contract active; T008 unchecked |
| Revision approved and documented, checks not executed | Revised acceptance pending; T008 unchecked |
| Any required check fails or is unknown | Acceptance incomplete; T008 unchecked; successors not run |
| Automated checks pass, human pilot checkpoint missing | Functional verification complete; pilot preparation pending; T008 unchecked |
| All revised requirements, current evidence and human checkpoint complete | F2 functional acceptance complete for the local PoC; T008 complete; global debt open |

Closure under the revised scope does not say that the original gate or full repository passed. It does not close Q, activate deferred P work, approve a product candidate, or start F3. F3 still needs a separate design/plan, exact pilot baseline, permissions, budget, one-writer ownership and explicit real-runtime opt-in. CI/audit, integration, push, merge and deploy retain their own authority.

## Explicit debt: DEBT-F2-GLOBAL-900

| Field | Proposed record |
| --- | --- |
| Status | Open; recorded as timeout/incomplete whole-suite coverage, not PASS |
| Scope | Whole-repository regression completion/performance, including the unfinished workflow module and interactions beyond the F2 functional matrix |
| Evidence | Original gate wall 901630 ms and the 900000-ms attribution cutoff; seven-negative-case validation does not establish adequate savings |
| Uncertainty | Remaining cases and complete regression result are unknown; historical timeout-fixture cleanup is not retroactively confirmed |
| F2 effect after approval | Non-blocking only for the explicitly revised functional F2 exit; all new mandatory checks still block |
| Ownership | Repository owner prioritizes a separately scoped performance/regression follow-up; no invented due date or automatic campaign |
| Resolution | Complete unfiltered `pnpm test`, known native exit 0, required terminal/stream evidence and relevant lifecycle facts under existing limits, with declared skips/limitations |

Keep this debt in a separate roadmap table, outside F2's unfinished task list. Do not create an unchecked T009 whose presence would contradict a later done status. Do not close the debt using focused file results, duration extrapolation, a model summary or an increased timeout.

Cross-module regression coverage remains incomplete outside the functional matrix. The package/CI script still includes the full suite and is unchanged; this local acceptance revision does not convert CI to green or exempt any future publication/merge checks.

## Prospective file scope

Preparation now adds only this proposal. Following a later exact approval, activation would modify only these five existing artifacts:

| Artifact | Exact proposed change |
| --- | --- |
| `.agents/specs/factory-request-contract.spec.yaml` | Preserve req-001..005; explicitly revise req-006/constraints/non-goals; retire only active ac-behavior; retain six checks and null waiver; append actual approval/history |
| `.agents/specs/tasks/factory-request-contract.tasks.md` | Preserve T001..007 completion/history and T008 pending; append revised T008 evidence procedure; remove only ac-behavior from the eight machine-validated maps-to lists, explaining that these are current references rather than rewritten historical outcomes |
| `docs/architecture/factory-request-contract-design.md` | Add the reviewed prospective functional acceptance boundary and debt; preserve historical design/implementation evidence |
| `docs/runbooks/factory-request-contract-acceptance.md` | Make the six-check gate plus functional matrix, Harness/browser, human checkpoint and stop/reporting sequence explicit; preserve old failed gates |
| `docs/roadmap/factory-local-poc.md` | Record revised F2 exit conditions and separate open debt; preserve P/Q results and separate F3 authority |

The mapping update is necessary because `validate-tasks.ps1` rejects any maps-to ID absent from the active spec. Each list retains its existing remaining valid IDs. No completed checkbox, original execution result or dated evidence is deleted or rewritten.

Out of scope: validators, spec schema, command catalog, Harness policies/pins/manifests, runtime/policy/state/UI code, tests, package scripts/lockfile, workers, budgets, timeouts, capture artifacts and sibling repositories.

## Preparation outcome and requested review

No acceptance test, structural validator, gate, CI, smoke, cleanup or external operation is run to prepare this text. Commands are reviewable data. Documentary reference/content-preservation inspection does not certify product behavior.

The owner is being asked to approve the exact prospective scope above, including the explicit coverage tradeoff and the continuing mandatory checks. Approval of the revision would permit its documentary activation only; running the acceptance sequence still requires an explicit execution instruction. Until then the active approved spec, task states and guards remain unchanged.
