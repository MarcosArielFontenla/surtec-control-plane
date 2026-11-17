# Phase S · Required scope approval before issue dispatch

## Scope

Add `org.issue.required-approval` to the mandatory S.1 offline gate. The [v1 missing-approval fixture](../../evals/v1/cases/hard-missing-approval.json) compares a reported deployment action against a list of approvals. The new EVAL observes the actual scope-approval boundary for admitting a local issue write task. The [issue service](../../dashboard/src/server/issue-service.ts) checks the current issue revision and scope authorization before it calls the task writer. The [context service](../../dashboard/src/server/context-service.ts) marks a proposed issue's context preview as blocked and issues admissible previews only for allowed contexts. The [existing service regression](../../dashboard/src/server/issue-service.test.ts#L519) covers the scope gate with a stub task writer.

## Fixture and expected outcomes

Reuse the [disposable role policy fixture](../../scripts/testing/role-policy-fixture.ts) with an isolated state root, `backend-engineer` assigned to the issue, the `software-engineer` logical role, and one inert verification command in project policy. Use a proposed issue with exact bounded scope, no blockers, no existing task and no workflow owner. Bind the issue service and its context service to the same fixture. Use a spy that delegates to the real `createTask` function. The EVAL stops at queue admission.

| Variant | Action | Expected result |
| --- | --- | --- |
| Missing approval | Request a preview for the proposed issue, then attempt dispatch with its current revision, role and preview fingerprint | The preview reports the missing exact-scope authorization. Dispatch returns `IssueServiceError` 409 for the scope gate, and the task writer has zero calls. |
| Blank approval | Attempt to authorize the current proposed issue with a whitespace-only approval ID | `IssueServiceError` 400 identifies the required approval ID. The issue remains proposed and records no approval. |
| Explicit approval | Authorize the same kind of issue with a synthetic approval ID, request a fresh preview for the updated issue revision, and dispatch once | The approval event binds the ID to the current scope revision. The allowed preview admits exactly one queued task bound to that issue and scope, and the issue moves to `working`. |

In the negative cases, compare the issue document bytes and persisted state inventory before and after the rejected action. Require no added approval or admission event, no task record and no managed worktree. In the positive case, require the recorded approval event to precede `execution-admitted` and verify the queued task's manifest, admission and issue scope binding. All cases use temporary state, restore environment overrides and verify fixture cleanup. Capture the actual status and denial reason so unrelated errors cannot count as a pass.

The proposed scope is this local issue admission boundary. Workflow plan approval, final candidate acceptance, publication, stale approval handling and execution remain outside this slice.

## Proposed tasks and validation

| Task | Scope | Files |
| --- | --- | --- |
| T012 | Add the three issue scope approval cases using the production preview, issue service and task admission paths. | `scripts/organizational-issue-approval.test.ts` |
| T013 | Add the file to the single-worker organizational Vitest invocation and document the EVAL. | `package.json`, `evals/README.md` |

Run these checks in order after implementation approval. Retain the existing timeouts and stop on the first failure or unknown result.

1. `pnpm exec vitest run scripts/organizational-issue-approval.test.ts` must pass all three variants.
2. `pnpm exec vitest run dashboard/src/server/issue-service.test.ts -t "requires explicit scope authorization and prevents duplicate issue task ownership"` must run and pass the existing regression.
3. `pnpm evals:check` must pass v1, v2 and all six organizational EVALs.
4. `pnpm typecheck` must exit 0.

## T012–T013 acceptance on 2026-11-16

**The [`org.issue.required-approval` increment](../../scripts/organizational-issue-approval.test.ts) is complete.** T012 verified production issue preview and dispatch with missing, blank and explicit scope approval. Both denials preserved the proposed issue and the empty task queue. Explicit approval was recorded before exactly one task was queued with the current issue revision and scope. Fixture cleanup passed. T013 added the case to the mandatory offline gate and documented its coverage.

| Check | Observed result |
| --- | --- |
| Required scope approval focused tests | Exit 0. All 3 variants passed. |
| Selected issue service authorization regression | Exit 0. 1 passed and 190 skipped by the selector. |
| `pnpm evals:check` | Exit 0. V1 matched 42 of 42 expectations with 36 of 36 coverage. V2 matched 8 of 8. All 26 organizational tests passed. |
| `pnpm typecheck` | Exit 0. |

The positive case stopped at queue admission in disposable state. The changes remained local. Phase S continues with the [proposed context budget EVAL](phase-s-context-budget-eval.md).
