# Phase S · Verify an allowed logical role before execution

## Scope

Add `org.execution.permitted-role` to the mandatory S.1 offline gate. The [v1 denial fixture](../../evals/v1/cases/hard-task-type-denied.json) evaluates a synthetic report against registered agent task-type rules. This EVAL exercises the production logical role check, both before admission and after a governed read-only analysis task has been queued.

The [context service](../../dashboard/src/server/context-service.ts) requires an explicit role ID and uses [`PolicyService.authorizeRole`](../../lib/policy/service.ts) to check the agent and task kind against the selected role. The [runner](../../runner/run-task.ts) revalidates that admitted context before reaching its executor. The runner records an unauthorized governed context as `needs-review` without marking it retryable. The [governed runner tests](../../runner/run-task.test.ts#L830) already show the admitted-context fixture and cover changed source and thread bindings.

## Fixture and expected outcomes

Use an owned temporary directory with a synthetic contained project, an isolated state root and temporary copies of the registered agents, roles, context policy and referenced evaluation sources. Follow the existing governed analysis fixture's preview and task admission path. Select `backend-engineer` for `software-engineer` in read-only analysis. The project policy explicitly allows the agent.

| Variant | Change | Expected result |
| --- | --- | --- |
| Allowed role | Issue a valid preview, admit the task and keep the same role policy | `runTask` completes and calls the injected fake executor exactly once in read-only mode. |
| Missing role | Omit `role_id` from the analysis preview request | The context service rejects the missing identity with a 400 error. No task is admitted. |
| Unknown role | Select a well-formed ID absent from the copied registry | The policy service denies the unknown logical role. No task is admitted. |
| Revoked role | Admit a valid task, then remove only `backend-engineer` from the copied `software-engineer` role | General dispatch still allows the agent, but current role authorization denies the pair. The persisted task finishes `needs-review`, is non-retryable and never reaches the executor. |

For the revoked case, confirm the queued manifest and admission binding before changing the copied policy. Confirm the current role denial using the real policy service and then run the same queued task. Require that the final record retains its admission binding, has no execution thread or worktree evidence, and records the existing terminal result. Assert zero calls to the executor, worktree creation, commit and verification. The runner's generic reason alone cannot establish the role-specific denial.

Use an injected fake executor that returns a valid structured result for the positive case and spies on effect boundaries. Restore process-local environment overrides in teardown and verify removal of the owned temporary directory. The EVAL covers the existing governed read-only analysis path. It makes zero paid calls and leaves the product runtime, role registry, legacy admission and workflow v2 paths outside the change.

## Proposed tasks and validation

| Task | Scope | Files |
| --- | --- | --- |
| T008 | Add the isolated fixture and four variants using the real policy, preview and runner. | `scripts/organizational-execution-role.test.ts` |
| T009 | Include the new test file in the existing single-worker organizational Vitest invocation and document the case. | `package.json`, `evals/README.md` |

Run these checks in order after implementation approval. Retain the existing test timeouts.

1. `pnpm exec vitest run scripts/organizational-execution-role.test.ts` must pass all four variants.
2. `pnpm exec vitest run runner/run-task.test.ts -t "executes current admitted project context|holds changed governed"` must run and pass the three selected existing regressions.
3. `pnpm evals:check` must pass v1, v2 and all four organizational EVALs.
4. `pnpm typecheck` must exit 0.

Role capability above a project or global policy ceiling is a separate S.1 invariant.

## T008–T009 acceptance on 2026-11-16

**The [`org.execution.permitted-role` increment](../../scripts/organizational-execution-role.test.ts) is complete.** T008 covered the allowed, missing, unknown and revoked role variants with the production policy, admission and runner paths. In the revocation case, the runner rechecked the current role, retained the prior binding and finished `needs-review` without retry or execution effects. The fixture cleanup assertions passed. T009 added the EVAL to the mandatory offline gate and documented it in the [evaluation guide](../../evals/README.md).

| Check | Observed result |
| --- | --- |
| Permitted-role focused tests | Exit 0. All 4 variants passed. |
| Selected governed runner regressions | Exit 0. 3 passed and 108 skipped by the selector. |
| `pnpm evals:check` | Exit 0. V1 matched 42 of 42 expectations with 36 of 36 coverage. V2 matched 8 of 8. All 16 organizational tests passed. |
| `pnpm typecheck` | Exit 0. |

Acceptance used the injected fake executor. The changes remained local. Phase S continues with the [proposed role permissions EVAL](phase-s-role-permissions-eval.md).
