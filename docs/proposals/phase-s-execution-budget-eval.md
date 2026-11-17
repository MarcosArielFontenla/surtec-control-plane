# Phase S · Enforce execution budgets

## Scope

Add `org.execution.budget-overrun` to the mandatory S.1 offline gate. The [runner](../../runner/run-task.ts) charges observed token deltas, aborts when cumulative usage exceeds the admitted cap, and enforces the runtime deadline for each attempt. The [scheduler](../../runner/task-orchestrator.ts) charges each claim and checks remaining attempts and tokens before retry. The EVAL exercises those existing controls on a directly admitted governed v1 analysis task. Workflow aggregate budgets, correction-specific budgets and the deferred independent budget controller are outside this slice.

## Fixture and expected outcomes

Reuse the [disposable role policy fixture](../../scripts/testing/role-policy-fixture.ts). In its private context policy set the budget selected by the fixture's logical role to 2 attempts, 1,000 ms per attempt and 10 cumulative tokens. Check the exact limits in the allowed analysis preview and in the saved task from the [real admission path](../../dashboard/src/server/dispatch.ts). Give each case a fresh fixture and a fake executor. Drive the production scheduler through explicit ticks and use the production runner for each claimed task. Capture the runner's completion and await worker settlement before inspecting the terminal state. Use a fake clock with explicit executor-start synchronization for the runtime boundary and deterministic retry backoff.

| Variant | Stimulus | Required result |
| --- | --- | --- |
| Tokens at the limit | Emit usage for 10 total tokens, then return a valid completed result reporting the same total. | The executor signal stays live through its return. The task completes with one claim, exactly 10 recorded tokens and a single usage debit. |
| Tokens over the limit | Emit 9 tokens, repeat the same cumulative observation, then emit 11. The fake observes and cooperatively handles the abort. | The signal stays live below the cap and aborts on the 11-token observation. Deltas of 9 and 2 retain all 11 tokens. The terminal task and event report the exact token-budget failure, release the lease, and schedule no retry. A manual retry returns the existing token-budget conflict and preserves the task and events. |
| Runtime at the deadline | Hold the fake executor until cancellation. Advance the clock to one millisecond before the admitted deadline, then advance the final millisecond. | The executor remains active just before the deadline. It receives the runtime abort at the deadline. The terminal task and event report the exact runtime-budget failure, release the lease, and schedule no automatic retry. |
| Attempts exhausted | Return a transient executor error before emitting any thread, turn or usage event. At the persisted retry time, claim the second attempt and repeat the transient failure. | The first failure schedules one retry. Two claims have distinct run IDs and consume exactly the two allowed attempts. Further ticks start no third attempt. A manual retry returns the existing attempt-budget conflict and preserves the finished task and events. |

Bind claim, usage and terminal events to the observed run IDs. For the budget aborts, require `failed`, `last_failure.kind: budget`, the exact reason and `retryable: false` from the runner. In the attempts case, the last failure remains transient and the scheduler refuses to queue more work once attempts are exhausted. Preserve the synthetic project and verify worker shutdown and fixture cleanup in every case. The fake executor supplies only scripted observations and respects aborts. The EVAL keeps real Codex, worktree creation, verification commands and external effects outside the fixture.

## Proposed tasks and validation

| Task | Scope | Files |
| --- | --- | --- |
| T022 | Add the four deterministic cases with real preview, admission, scheduling and budget enforcement. | `scripts/organizational-execution-budget.test.ts` |
| T023 | Add the EVAL to the single-worker organizational Vitest invocation and document its coverage. | `package.json`, `evals/README.md` |

Run these checks in order after implementation approval. Keep existing guards and timeouts. Stop on the first failure or unknown result.

1. `pnpm exec vitest run scripts/organizational-execution-budget.test.ts` must pass all four variants and fixture cleanup.
2. `pnpm exec vitest run runner/run-task.test.ts -t 'five-minute runtime budget|cumulative token usage exceeds the task budget'` must pass exactly the two selected runner regressions.
3. `pnpm exec vitest run runner/task-orchestrator.test.ts -t 'bounded retry for a transient owned failure|fails an expired attempt when its attempt budget is exhausted'` must pass exactly the two selected scheduler regressions.
4. `pnpm evals:check` must pass v1, v2 and all eleven organizational EVALs, with 45 organizational tests expected.
5. `pnpm typecheck` must exit 0.

The proposed changes affect offline tests and documentation. Validation uses synthetic task limits, state and usage and requires no manual setup.

## T022–T023 acceptance on 2026-11-17

**The [`org.execution.budget-overrun` increment](../../scripts/organizational-execution-budget.test.ts) is complete.** T022 verified exact-cap completion without duplicate debit, an overrun that retained all 11 observed tokens against a cap of 10, runtime abort at the admitted deadline, and rejection of a third attempt. Both denied manual retries preserved the task and event files. The workers stopped and fixture cleanup passed. T023 added the EVAL to the mandatory offline gate and documented its coverage.

| Check | Observed result |
| --- | --- |
| Execution budget focused tests | Exit 0. All 4 cases passed. |
| Selected runner regressions | Exit 0. 2 passed and 109 skipped by the selector. |
| Selected scheduler regressions | Exit 0. 2 passed and 80 skipped by the selector. |
| `pnpm evals:check` | Exit 0. V1 matched 42 of 42 expectations with 36 of 36 coverage. V2 matched 8 of 8. All 45 organizational tests passed in 11 files. |
| `pnpm typecheck` | Exit 0. |

The checks used the production scheduler and runner with synthetic limits and a fake executor. The changes remained local. Phase S continues with the [proposed routine prohibited action EVAL](phase-s-routine-prohibited-action-eval.md).
