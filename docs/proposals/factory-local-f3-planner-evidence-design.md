# Factory Local F3 — Planner evidence citations

Status: proposed for review. This document defines a private pilot change and three synthetic acceptance cases. Implementation and any future execution decision are separate.

## Observed failure

The revision 8 Planner returned a six-step JSON plan with `status: needs-review` and `scope_change_required: false`. The exact final item matched the native thread, turn and terminal receipt. The unchanged validator rejected it because none of the four `evidence_ids` existed in the issue evidence store. The stage has no accepted output or output fingerprint. The existing retained-Plan recovery path therefore has no eligible proposal.

The attempt retains one charge of 19070 tokens and a verified terminal receipt. The pilot has an observed lower bound of 278686 tokens and an unknown combined final total. Preserve the original grant, stage, task, charge, receipt and native artifact by hash in place. Use only synthetic data in the acceptance fixtures.

## Citation contract

`evidence_ids` is a required array whose schema allows zero items. It contains persisted issue-evidence IDs, with the issue, task, scope and candidate checks enforced by the [role output validator](../../lib/workflows/role-output.ts). The [Planner approval action](../../dashboard/src/server/workflow-service.ts) additionally requires every cited entry to belong to this Planner task and its exact execution. A reference can pass output validation and still fail the approval action.

The [workflow context](../../dashboard/src/server/context-service.ts) supplies the issue scope and acceptance criteria. Its issue source contains no citation inventory. Task admission creates a reservation reference with a null execution ID. Normal read-only Planner completion writes output and accounting to their existing stores and provides no issue-evidence reference owned by that execution. The terminal usage receipt attests to accounting and is not an issue-evidence ID. The ordinary Planner path therefore uses an empty array.

Append this exact guidance to the current Planner `responsibility` in the role registry of a newly reviewed private capsule.

> For this Planner turn, return an empty evidence_ids array. This context supplies no issue-evidence IDs owned by this exact task and execution. Put relevant observations and permitted repository-relative file references in the plan prose. Never put file paths, task IDs, context source IDs, or invented labels in evidence_ids.

The existing `policy/logical-role` context source carries this field. Its changed text is bound to the Planner source revision, root preview, stage manifest and derived thread contract through the existing fingerprint machinery. During qualification, show the exact text, verify it fits the existing complete-context limits, and verify that effective scope, tools, sandbox, roles, verification, review requirements and budgets match the reviewed baseline. The reference list stays empty because this delta adds no producer or reader of issue-evidence records for the prompt.

The change is guidance for one pilot role. Keep the [schema](../../schemas/workflow-role-output.schema.json), role validator, exact approval predicate, retained-Plan eligibility and all accounting rules intact. Preserve every earlier capsule and its pins. A new capsule and new preview require review before use. This single-domain configuration delta adds no primary entity and does not trigger a new Spec-First entity contract. Generalized evidence delivery or a production evidence producer would require separate design.

## Three cases with fakes

Use an isolated synthetic project and state with the real context assembler, workflow controller, scheduler, output validator and decision service. Inject a fake Planner executor and a matching fake terminal usage receipt. Confirm that the sole queued task is Planner and use one scheduler tick. No real executor, worktree, project verifier or Engineer task is allowed. Each case uses a valid completed plan with `scope_change_required: false` so that citation handling is the variable under test.

| Case | Fake output and setup | Required observation |
| --- | --- | --- |
| A. No citations | Ordinary Planner fixture. Assert that its admitted prompt includes the exact new guidance. Return `evidence_ids: []`. | Output and fingerprint are retained unchanged. The single charge and terminal receipt remain valid. The workflow reaches `waiting-human` with an exact pending `plan-approval` decision. Stop the worker. |
| B. Valid exact-run citation | After the synthetic claim, seed one issue-evidence row in the fixture with the exact issue, scope, Planner task and charged execution IDs and no candidate. Index it on that same issue. Return its ID. The fixture supplies the row solely to exercise the validators. | The original nonempty array is retained and the workflow reaches the same exact human gate. With the worker stopped, exercise the existing approval action on synthetic state to prove the exact-run reference passes. Do not reconcile or tick after this check. No Engineer stage or task is admitted. |
| C. Missing citation | Return one well-formed ID absent from the synthetic evidence store. Preserve valid terminal accounting in the fake so the failure is attributable to evidence. | The unchanged validator returns `needs-review`. Stage output and fingerprint remain null, there is no pending plan approval and the workflow requires a decision. The single charge and receipt remain intact. No fallback plan, rewritten reference, or Engineer admission occurs. |

Case B is a compatibility control for legitimate data. It does not establish that the live first Planner has any usable IDs. Do not use the reservation reference or an earlier task's evidence as the positive fixture. The exact task-and-execution predicate must run in the test, rather than being replaced by a fake boolean.

## Proposed implementation boundary

1. Build a new private capsule from the reviewed source and overlay pins. Change only the `planner.responsibility` string in its private `registry/agent-roles.yml`. Compare the parsed registry before and after, pin the new leaf and preserve the old capsule and real state hashes.
2. Add a private `planner-evidence.test.mjs` using the three synthetic cases above. Run Node syntax and import checks and the focused fake suite with the pinned TypeScript loader, isolated state and owned TEMP/TMP. Check full admitted prompt bounds, current grant and exact gate bindings, one charge per case and zero real model calls. Preserve the prior G1 receipt and observed totals by hash before and after.
3. Record the fake results and changed fingerprints. Stop at technical preparation. Any future live preview and G1 need a fresh capsule review, exact matching preview, current owner window and separately approved accounting and execution decision. The prior invalid output stays ineligible and remains available only as historical diagnostic evidence.
