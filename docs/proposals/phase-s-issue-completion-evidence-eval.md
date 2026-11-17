# Phase S · Require evidence for issue completion

## Scope

Add `org.issue.completion-evidence` to the mandatory S.1 offline gate for issue completion without required evidence. The [issue service](../../dashboard/src/server/issue-service.ts) derives governed verification status from the task's captured receipt. Final acceptance also requires that receipt and a passing issue evidence reference bound to the candidate and run. The [existing service regressions](../../dashboard/src/server/issue-service.test.ts) cover both checks with synthetic state. The new EVAL exercises both boundaries against a candidate from the production context preview and issue admission path.

## Fixture and expected outcomes

Reuse the [disposable role policy fixture](../../scripts/testing/role-policy-fixture.ts) with local workspace-write policy for the software engineer and one inert configured functional verification command. Create and authorize one documentation issue with bounded paths and explicit criteria. Dispatch it through the real issue service using its issued preview and task writer. Check the saved governed v1 admission and exact verification requirement. Seed the leased attempt and finished task state through the validated task store, following the service tests. Record the synthetic candidate through the production issue service with the linked task, active run, current scope revision and an in-scope path.

For the receipt cases, use the [production receipt builder and sealer](../../lib/context/testing-evidence.ts) with the admitted command, exact run and candidate, and one synthetic passing observation at that candidate revision. Keep command execution, Git operations, the worker and the model out of the fixture. Use a fresh owned root for each case and require verified cleanup.

| Variant | Action | Expected result |
| --- | --- | --- |
| Success reported without a captured receipt | Report `passed` through `recordVerification` with the current candidate and active lease. Finish the task and attempt acceptance with all criteria and gap acknowledgment. | The issue stores informational verification without a receipt fingerprint and moves to `needs-decision`. Acceptance returns the existing readiness conflict, HTTP 409. No `candidate-accepted` event or review evidence is recorded. |
| Receipt lost after verification | Attach the bound passing receipt, record verification and finish the task. Remove only the receipt through the validated fixture task store. Attempt acceptance at the current revision with the exact candidate, all criteria and gap acknowledgment. | The issue starts the acceptance attempt in `ready-for-review` with its original passing evidence reference. Acceptance returns the governed missing-evidence conflict, HTTP 409. The status, revision, passing reference and audit history stay intact. |
| Exact passing evidence and human acceptance | Keep the bound receipt through verification and task completion. Accept the exact candidate with a synthetic approval ID, rationale and every confirmed criterion. | The issue moves from `checking` to `ready-for-review`, then to `done`. The passing reference binds the receipt, run, candidate and scope. The persisted acceptance event binds the same candidate and scope, exact approval and criteria, with no evidence-gap acknowledgment. |

On each denied acceptance, assert the precise service error and compare the issue and task file bytes and fixture state inventory before and after the attempt. On successful acceptance, reload from the store and check exactly one `candidate-accepted` event preceded by `verification-passed`, plus one passed review evidence reference. Keep the checkout unchanged throughout. This slice covers direct governed issue acceptance. Workflow Reviewer and QA gates, candidate invalidation and Strict TDD have separate roadmap checks.

## Proposed tasks and validation

| Task | Scope | Files |
| --- | --- | --- |
| T018 | Add the three cases with production issue admission, verification and acceptance in isolated state. | `scripts/organizational-issue-completion-evidence.test.ts` |
| T019 | Add the file to the single-worker organizational Vitest invocation and document the invariant. | `package.json`, `evals/README.md` |

Run these checks in order after implementation approval. Keep the existing guards and timeouts and stop on the first failure or unknown result.

1. `pnpm exec vitest run scripts/organizational-issue-completion-evidence.test.ts` must pass all three variants.
2. `pnpm exec vitest run dashboard/src/server/issue-service.test.ts -t 'derives governed verification|refuses model/caller success|cannot waive missing or replaced governed receipt evidence'` must run and pass exactly those three regressions.
3. `pnpm exec vitest run lib/context/testing-evidence.test.ts` must pass the receipt validation regressions.
4. `pnpm evals:check` must pass v1, v2 and all nine organizational EVALs, with 40 organizational tests expected.
5. `pnpm typecheck` must exit 0.

The proposed changes affect offline tests and documentation. Acceptance needs no browser or manual setup.

## T018–T019 acceptance on 2026-11-16

**The [`org.issue.completion-evidence` increment](../../scripts/organizational-issue-completion-evidence.test.ts) is complete.** T018 verified that reported success without a receipt holds the issue for a decision and that receipt loss after verification blocks final acceptance. Both denied attempts preserved the issue and task records. Exact passing evidence and explicit confirmation of all criteria allowed completion with a candidate-bound approval. The synthetic checkout was preserved and fixture cleanup passed. T019 added the EVAL to the mandatory offline gate and documented its coverage.

| Check | Observed result |
| --- | --- |
| Issue completion evidence focused tests | Exit 0. All 3 cases passed. |
| Selected issue service regressions | Exit 0. 3 passed and 188 skipped by the selector. |
| Testing receipt regressions | Exit 0. All 27 cases passed. |
| `pnpm evals:check` | Exit 0. V1 matched 42 of 42 expectations with 36 of 36 coverage. V2 matched 8 of 8. All 40 organizational tests passed in 9 files. |
| `pnpm typecheck` | Exit 0. |

The checks used disposable state and synthetic receipts. The changes remained local. Phase S continues with the [proposed active write checkout EVAL](phase-s-active-write-checkout-eval.md).
