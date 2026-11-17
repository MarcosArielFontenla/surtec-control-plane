# Phase S · Reject invalid issue state transitions

## Scope

Add `org.issue.invalid-transition` to the mandatory S.1 offline gate. The [v1 lifecycle contract](../architecture/issue-lifecycle-v1.md) defines the allowed state pairs and terminal states. The [local issue service](../../dashboard/src/server/issue-service.ts) invokes the [transition guard](../../lib/organization/issue-lifecycle.ts) before persisting a state change and its audit event. The EVAL covers that boundary with four service cases and two terminal-state controls at the guard.

## Fixture and expected outcomes

Reuse the [disposable role policy fixture](../../scripts/testing/role-policy-fixture.ts) with isolated state and the real issue service. For service cases, create a valid proposed issue with bounded documentation scope. Use a fixed clock and a synthetic approval ID. In the working-issue case, reach `working` through exact scope authorization, the real context preview and queue admission. This fixture ends at admission and starts no worker or agent.

| Variant | Stimulus | Required result |
| --- | --- | --- |
| Current, allowed transition | Authorize the proposed issue at its current revision. | The issue reaches `authorized`. The revision increments once, the scope and scope revision are preserved, and exactly one `scope-authorization-recorded` event binds the approval. No work is queued. |
| Stale revision on an otherwise allowed edge | Authorize a proposed issue using its previous positive revision. | The service rejects with 409 and `issue transition rejected: stale-revision`. It preserves the proposal, revision, and audit history. |
| Same-state replay | Authorize a valid proposed issue, then submit a second authorization with the resulting current revision. | The service rejects the `authorized → authorized` edge with 409 and `issue transition rejected: transition-not-allowed`. The original authorization remains the sole approval event. |
| Forbidden edge with an active task binding | Admit one queued task and call the same-scope decision resolution directly while the issue is `working`, with the current revision, approval and rationale. | The service rejects `working → authorized` with the same forbidden-edge 409. It preserves the working issue and the original queued task. No decision event, evidence, or second task is created. |
| Terminal state `done` | Call the pure guard from `done` against every v1 destination with a new event ID and current revision. | Each result is `transition-not-allowed`, including a same-state transition. The input state and seen event IDs are preserved. |
| Terminal state `cancelled` | Repeat the terminal check from `cancelled`. | The same refusal and preservation hold for every v1 destination. |

Use the existing state reader to verify the saved revision and audit events. Around each rejected service call compare the issue file bytes and fixture state inventory. In the working case also compare the task snapshot and its event bytes. Keep the checkout unchanged and verify ownership-based fixture cleanup. The terminal controls check the reference guard directly through its full destination vocabulary.

## Related service finding

Code inspection found that the common transition helper matches `from`, `to` and revision, while the service supplies the audit event name independently. `authorize`, `resumeBlocked` and `resolveDecision` all target `authorized`. For example, at the current revision, `resumeBlocked` can select the legal `proposed → authorized` pair and record `blocker-resolved`. This is a separate action/source binding gap. T030–T031 cover invalid state pairs and revision checks. A follow-up should define the accepted source state per operation and exercise those service and HTTP entry points before claiming action/source coverage. These tests neither encode the observed gap as expected behavior nor change production guards.

## Proposed tasks and validation

| Task | Scope | Files |
| --- | --- | --- |
| T030 | Add the four service and two terminal guard cases using disposable state and the existing lifecycle contract. | `scripts/organizational-issue-transition.test.ts` |
| T031 | Add the EVAL to the single-worker organizational Vitest invocation and document its coverage. | `package.json`, `evals/README.md` |

Run these checks in order after implementation approval. Retain existing guards and timeouts. Stop on the first failure or unknown result.

1. `pnpm exec vitest run scripts/organizational-issue-transition.test.ts` must pass all six variants.
2. `pnpm exec vitest run lib/organization/issue-lifecycle.test.ts` must pass all lifecycle contract regressions.
3. `pnpm exec vitest run dashboard/src/server/issue-service.test.ts -t 'requires explicit scope authorization and prevents duplicate issue task ownership|requires an explicit human resume after a blocked execution'` must pass exactly two service regressions.
4. `pnpm evals:check` must pass v1, v2 and all fifteen organizational EVALs, with 61 organizational tests expected.
5. `pnpm typecheck` must exit 0.

The proposed changes affect offline tests and documentation. Validation requires no browser, model or manual project setup.

## T030–T031 acceptance · 2026-11-17

T030–T031 passed. The offline EVAL checked the allowed authorization, rejected transitions and terminal states in disposable fixtures. Its denials preserved the recorded issue, related task files and audit evidence. The fixture checks covered checkout preservation and cleanup.

| Check | Observed result |
| --- | --- |
| Focused `org.issue.invalid-transition` | 6 passed. |
| v1 lifecycle regressions | 14 passed. |
| Issue service authorization and blocked-resume regressions | 2 passed. |
| `pnpm evals:check` | v1 passed 42/42 expectations and covered 36/36 cases. v2 passed 8/8. The organizational gate passed 61/61 tests across 15 files. |
| `pnpm typecheck` | Exit 0. |

The action/source binding finding remains open. Its [follow-up design](phase-s-issue-authorization-source-state.md) scopes the service correction and the offline, service and browser regressions.
