# Factory Local F3 — feasibility and accounting decision

Status: T001–T003 DOCUMENTARY COMPLETE within the four approved Markdown targets. The owner explicitly approved this exact bounded design in the conversation; session acknowledgement is 2026-11-04T01:30:42Z, not an inferred earlier human timestamp. Prepared 2026-11-04 UTC (2026-11-03 in the owner's timezone). Documentary checks passed while preserving all consumption and limits, with no model call, commit or push. Approval grants no real execution, state mutation, budget or recovery authority. Real F3/F5 remain incomplete.

## Decision in one sentence

The retained workflow cannot resume under its existing limits: observed tokens already exceed its cap, final usage is unknown, and its two arithmetic remaining charged attempts cannot cover the three required remaining roles. The first useful increment is a documentary accounting disposition and explicit NO_GO handoff, not another runtime repair or diagnostic campaign.

## Scope and sources

This proposal reads the retained original/current workflow, task, event and issue evidence, previous qualified diagnostic observations, owner-reviewed additional-grant decision and completed context-efficiency acceptance. Private identities, paths, source bodies, prompts, raw reasoning and business details remain outside Git. Only numeric/type/state observations and public code references are used here.

The design does not add a product entity, state facet, API, CLI, recovery mode or runtime behavior. Its proposed follow-up changes four Markdown documents only; there is no new implementation spec, schema, task engine, profiling layer or active Harness contract. Any later prospective change spanning execution/accounting/persistence must separately follow the [Spec-First Contract](../../.agents/specs/CONTRACT.md) with exact human-reviewed scope and checks.

Relevant evidence and code:

- [Current real F3 stop and original finite contract](factory-local-f3-design.md#real-uncharged-claim-recovery-and-engineer-token-stop--2026-11-03).
- [Original attribution defect, diagnostic observation and preserved undercount](factory-local-f3-accounting-recovery.md#historical-recovery).
- [Completed context-efficiency increment](factory-local-f3-context-efficiency-design.md#technical-acceptance--2026-11-04-utc).
- [Workflow budget availability and stop policy](../../lib/workflows/policy.ts), [controller claim/settlement guards](../../runner/workflow-orchestrator.ts) and [current stage authority](../../runner/workflow-stage.ts).
- [Immutable grants and monotonic accounting](../../lib/workflows/validation.ts), [execution-profile compatibility](../../runner/runtime-context-profile.ts) and [narrow uncharged-claim proof](../../lib/workflows/uncharged-claim-recovery.ts).

## Accounting observations — keep the scopes separate

| Evidence group | Persisted observation | Separate diagnostic observation | Completeness and treatment |
| --- | ---: | ---: | --- |
| First historical Planner, original workflow | 41408 tokens | 143738 cumulative tokens | Final usage unknown. The persisted undercount stays unchanged; the previously qualified diagnostic is disclosed alongside it, not added as another attempt or rewritten into the old ledger. |
| Renewed Planner, current workflow | 21512 tokens; 14232 ms | None needed | Complete operational terminal evidence, original needs-review result and exact human-adopted plan retained. This is not provider-final billing. |
| Interrupted Engineer, current workflow | 94366 tokens; 32092 ms | Cumulative samples 24150, 58091, 94366 | Final usage unknown; no positive terminal receipt, candidate or verification evidence. Cache remains included. Samples and duplicates are not separate charges. |

The current workflow's immutable observations sum to 21512 + 94366 = **115878 tokens**, with **46324 ms** observed active runtime, two admitted tasks and two charged attempts. Its revision is 23, status needs-decision, recovery awaiting-human and accounting_complete false. The Engineer task is finished/failed without a lease; the workflow stage still says running. That retained stage label is not proof of a live process and is not repaired by this proposal. The existing uncharged-claim recovery is a historical ready receipt; its later charged/interrupted attempt cannot reuse that exception.

The Engineer task's scheduler attempt is 2, but only its later execution has a charged workflow row. The earlier proven uncharged claim remains in task/event history; it must not become either an extra model charge or a refunded task attempt. Preserve all distinct original identities and their provenance in the private evidence.

Across the two distinct workflows, the disclosed observed lower bound is **143738 + 21512 + 94366 = 259616 tokens**. Do not add the historical 41408 again: it is an undercounted representation of the same first Planner attempt. The historical diagnostic comes from the previously qualified owner-reviewed evidence; this design did not replay raw CLI/session traces. The combined complete total remains **unknown/null**. Separate grants and attempts retain their own scopes; this informational sum is not a new shared ledger, grant, payable bill or spendable balance. Synthetic tests, unrelated disposable runtime smokes and this assistant's development work are outside that pilot sum; absence from it does not assert zero consumption elsewhere.

The first and additional workflows each retain their original 100000-token cap. Neither is pooled, transferred or topped up. No historical task, snapshot, event, charge, receipt, plan or failure is migrated, relabeled, deleted or decreased.

## Current feasibility — arithmetic is not authorization

| Dimension | Retained cap | Recorded fact / minimum need | Assessment |
| --- | ---: | --- | --- |
| Current aggregate tokens | 100000 | 115878 observed; at least 15878 above cap | Exhausted even before any missing final usage is resolved. |
| Engineer task tokens | 78488 | 94366 observed | Same 15878 overage; no candidate to reuse. |
| Current charged attempts | 4 | 2 used; Engineer, Reviewer and QA still need at least 3 | At least 5 total would be needed, even if the same Engineer task were otherwise eligible. The arithmetic headroom of 2 is insufficient and grants no attempts. |
| Current admitted tasks | 4 | 2 used | Reusing the existing Engineer task would leave room for two review tasks in arithmetic only. Replacing it with a new Engineer task plus both reviewers would require 5 admitted tasks. Neither alternative is currently authorized. |
| Current active runtime | 900000 ms | 46324 ms observed | Arithmetic difference 853676 ms; no usable availability follows from unknown accounting. |
| Engineer attempt runtime | 300000 ms | Retained verification planning reserve 250000 ms | Only a planned 50000-ms implementation/commit margin; actual combined verification cost remains unmeasured. Do not enlarge either limit. |
| Required quality path | Full review, QA required | No accepted implementation/candidate, Reviewer or QA | Preserve all three remaining roles and exact candidate-bound verification/reviews; no bypass. |
| Correction | OFF | No correction grant | A retry cannot be disguised as correction or consume an invented allowance. |

The authoritative budget policy returns **remaining: null / can_admit: false** when accounting is incomplete. The differences above are informational arithmetic, never an available wallet. An eventual trustworthy terminal usage receipt cannot lower the already proven 115878, erase an attempted role, or make this workflow fit its original caps. Setting accounting_complete true manually is not an accounting resolution.

## Context compatibility and other unresolved conditions

The new governed profile passed its scoped synthetic and actual isolated API/Chromium acceptance. It selects only a first contract without a retained binding/thread, or the exact matching supported saved contract. A retained legacy binding stays legacy if it still matches; drift is refused. Do not delete/replace a fingerprint, change a saved thread, edit its admitted source or overwrite the frozen runtime to make a stopped task appear fresh.

Consequently, context-efficiency acceptance does not retrofit savings into this charged Engineer attempt. Installed-native support, actual token savings, quality and four-role fit remain unmeasured. Byte reduction or cached-input counts cannot fund another turn. No native process/config probe belongs to this design.

The recorded 30-minute writer windows have expired. This read-only inspection does not renew them, prove global absence of other writers, requalify current project HEAD/dependencies/Docker or validate a future runtime capsule. The retained source/worktree were previously observed clean; no sibling Git/filesystem probe or edit is performed here. Any later permitted execution needs its own fresh baseline, source/runtime/verifier identity, current ownership and exact project/context/approval checks.

The existing V01–V08 trusted real-delivery verifications and their combined cost remain unqualified for an accepted candidate. No Docker/container/API setup, restore, build, package/image acquisition or verification repetition is proposed merely to estimate cost. An unchanged runtime ceiling plus unmeasured cost is uncertainty, not feasibility.

## Options and recommendation

| Option | Fits this unchanged-limit design? | Consequence |
| --- | --- | --- |
| Retain blocked operation and consolidate its documentary accounting | Yes; recommended first increment | Preserve unknown final usage and every historical charge; create no execution authority. |
| Resume/retry the same Engineer, including a fingerprint reset or reused recovery | No | Unknown accounting, exhausted tokens, insufficient attempt capacity and current controller/task guards deny it. |
| Start another workflow, private state copy or identity as an automatic continuation | No | A fresh counter is not a refund or resolution of the prior operation. Existing issue/tree ownership also cannot be assumed released. |
| Request a separately reviewed additional-execution proposal later | Outside this design | Requires a new explicit owner decision, transparent disclosure of all prior consumption and liabilities, and a supported ownership/admission path. No amount, grant, waiver, new identity or model turn is authorized or prepared here. |
| Change quality requirements, omit a role or accept manually as F3 | No | That would change the delivery contract and needs separate human review; this design leaves F3/F5 open. |

Recommended decision: accept **NO_GO_CURRENT_LIMITS** as the current operational conclusion and approve only the bounded documentary consolidation below. A later owner decision can request a prospective additional-execution design or defer the real pilot. It cannot retroactively turn unknown usage into complete accounting or make failed delivery accepted. There is no code defect to repair in order to override this arithmetic result.

## Approved first increment — four documentary targets

Only this proposal was authored at the design-only boundary. The owner subsequently approved the exact follow-up below; its addenda and T001–T003 documentary validation are complete. The approval does not extend to a real continuation.

1. `docs/proposals/factory-local-f3-feasibility-accounting-design.md`: record actual approval and documentary results after they occur; retain the proposed and observed boundaries.
2. `docs/proposals/factory-local-f3-accounting-recovery.md`: append the separate historical/current accounting view and unknown combined total without changing its historical undercount or outcomes.
3. `docs/proposals/factory-local-f3-design.md`: append the current NO_GO conclusion, minimum remaining role/attempt demand, profile continuity and missing verification feasibility; preserve the original real-pilot task statuses.
4. `docs/roadmap/factory-local-poc.md`: link the current conclusion, keep F3 blocked/F5 open and distinguish this documentary checkpoint from a real delivery or model grant.

| Task | Dependencies | Bounded work and completion |
| --- | --- | --- |
| T001 | Exact documentary scope approved | Append provenance-separated accounting to the existing accounting proposal. Preserve the 41408/143738 distinction, 115878 current aggregate and unknown/null combined final total. |
| T002 | T001 | Append feasibility and handoff to the F3 design and active roadmap. Preserve limits, full Reviewer/QA path, current blocked status and the distinction between arithmetic headroom and unavailable budget. |
| T003 | T002 | Record actual documentary validation and decision boundary in this proposal. Report results, preserved input pins and no effects; stop for the owner's next decision without starting a worker or runtime. |

No product implementation or synthetic campaign is required to establish this current conclusion. Do not introduce a new profiler, generic recovery tool, account-settlement command or persisted liability schema. If future review discovers a genuine product requirement, propose that change separately with its exact spec/tasks before implementation.

## Approved checks for that increment

Use direct read-only structural/link/whitespace/privacy/integrity checks, with owned external evidence and 900 seconds per command as the ceiling. Do not execute a suite, catalog -Run gate, CI, eval, audit, build or smoke for Markdown-only consolidation.

- Recheck all 16 pinned private inputs: ten preserved current-operation/acceptance inputs, four original historical state/event inputs, the owner-reviewed additional-grant decision and prior technical acceptance report. A changed/missing/unreadable input is UNKNOWN and stops consolidation; it is not refreshed or silently accepted.
- Preserve both existing workflow/attempt scopes and exact attribution. Confirm the current two charged rows sum to 115878 tokens and 46324 ms, with the Engineer row incomplete. Do not sum cumulative samples/duplicate reports or the historical undercount with its diagnostic replacement observation. Do not rewrite records to match derived values.
- Confirm the lower-bound calculation 259616 separately from a null complete total; unknown remains unknown. Distinguish operational terminal completeness, observed usage and provider-final billing.
- Confirm 115878 > 100000, 94366 > 78488, and 2 + 3 > 4. Preserve the remaining-role/QA requirement, correction OFF, original plan and all numeric caps. No diagnostic result may mint capacity or a controller identity.
- Check local document links, exact target list, task order, terminology, privacy and changed-line whitespace. Retain unrelated/pre-existing warnings with evidence rather than widening scope.
- Compare repository hashes before/after: only these four Markdown paths may change; runtime, tests, schemas, registries, Harness pins, dependencies, source capsules, Git HEAD/branch/index and every private input remain unchanged.
- Record no model call or native Codex probe, real state/API mutation, sibling operation, process/resource cleanup, commit, push or merge. Do not claim current machine-wide quiescence or candidate verification from these observations.

Passing these checks completes a documentary accounting checkpoint only. It does not complete final usage, settle a ledger, accept F3/F5, waive global full-suite/CI debt or authorize another attempt.

## Review and stop boundary

Approval covers the four documentary targets and T001–T003 only. No additional budget or live execution is included. If retaining all current limits is mandatory, the only permissible operational disposition remains blocked/deferred; there is no hidden retry path to approve.

After the documentary checkpoint, any request to pursue another actual delivery must first receive a separate concrete feasibility/accounting/execution design. That review must disclose all prior observed consumption and unknown liabilities, identify a supported issue/workflow/tree ownership path, renew project/runtime/source and writer authority, reserve complete verification and both reviews, preserve the original evidence and explain every additional authorization explicitly. It cannot infer scope/plan transfer, native qualification, sufficient quota or a new grant from this proposal.

## Design-only observations

The read-only preparation found the two distinct retained workflows, verified current evidence against the prior technical pins and recorded 16 preservation hashes plus repository/source metadata outside Git. It inspected only existing bounded records and relevant policy/runtime code; no product service, recovery operation, worker, Codex CLI/App Server, provider or Docker process was invoked. Numeric/state/attribution/arithmetic, local-link/privacy/target and before/after integrity checks are recorded separately from implementation acceptance. Current diagnosis is NO_GO_CURRENT_LIMITS; final consumption and native/verification feasibility remain unknown.

At the design-only boundary no follow-up task had been implemented, and approval was not inferred from the design's existence or documentary checks. The later explicit owner approval above authorizes the bounded documentary addenda only. Historical technical successes and failed real attempts retain their original meaning.

## Documentary completion — 2026-11-04 UTC

| Task | Status | Observed evidence |
| --- | --- | --- |
| T001 | COMPLETE | The existing accounting proposal now separates the original stored undercount, prior diagnostic and current two charged rows, preserving unknown final usage and all source records. |
| T002 | COMPLETE | The real F3 design and active roadmap state NO_GO_CURRENT_LIMITS, insufficient role-attempt capacity, retained verification/profile uncertainty and the separately gated next decision. |
| T003 | COMPLETE | Direct documentary checks passed: 113 local links, six added-link anchors, whitespace/privacy/target order, provenance/arithmetic/limits, 16 unchanged private input pins and unchanged Git HEAD/branch/index. |

Exactly four existing Markdown paths changed, with no new source file. All 1262 repository files outside that scope match the 1266-file baseline. Removing only the three new addenda reconstructs the prior three document bodies byte-for-byte, confirmed by their original hashes; historical content and outcomes are preserved. All 16 private inputs retain their hashes, including the old and current state/event evidence, additional-grant decision and prior technical acceptance report. Checks completed well within the 900-second command ceiling; detailed numeric/hash evidence remains outside Git.

No product tests, schemas, typecheck, build, smoke, catalog execution, CI, eval, audit, real verification, Docker/prerequisite action, native Codex probe, model call, sibling inspection, process cleanup, state/API mutation, limit change, commit, push or merge ran. Repeatable documentary checks were automated; no duplicate manual local validation is needed. Scope/caps, unknown final accounting, exact plan, role requirements and original real-pilot task statuses remain intact.

The completed checkpoint retains **NO_GO_CURRENT_LIMITS**, current observation **115878/100000**, combined observed lower bound **259616**, combined final total **unknown/null**, and unavailable/null spendable budget. Real F3 stays blocked, F5 stays open, and global full-suite/CI debt remains open. The remaining human decision is to retain/defer the pilot or request a separate prospective additional-execution design with complete historical disclosure and fresh supported authority. Nothing in this completion starts or pre-approves that work.
