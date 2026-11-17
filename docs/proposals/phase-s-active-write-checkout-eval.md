# Phase S · Enforce one active write checkout per project

## Scope

Add `org.execution.active-write-checkout` to the mandatory S.1 offline gate. The [production scheduler](../../runner/task-orchestrator.ts) holds a shared scheduling lock while it reads active leases. It excludes projects with a current workspace-write lease and adds newly claimed projects before considering the next task in the same tick. The [worktree module](../../runner/worktree.ts) creates a managed checkout per task. The EVAL joins these boundaries to observe whether scheduling allows two write attempts to own checkouts at the same time.

## Fixture and observations

Use the [disposable role policy fixture](../../scripts/testing/role-policy-fixture.ts) for an owned temporary root and isolated state. Initialize its synthetic project as a local Git repository with one baseline commit and no remote. Keep Git initialization and reads on fixed local arguments with an allowlisted environment. In the EVAL module, route the existing managed Git argument builder to the fixture control root so it creates its empty hooks directory inside the fixture. Reuse the real worktree create, list and removal functions.

Seed three validated queued task records for the same fixture project and repository. Give the two writers and one reader distinct IDs and strictly ordered creation timestamps. Create two `TaskOrchestrator` instances with distinct worker IDs, the same state root, an injected stable clock and capacity for all three tasks. Drive them by explicit `runOnce` calls. Both use a controlled `runAttempt` callback that checks the persisted task, worker and run lease binding. A write callback creates its real managed checkout and then waits for the test to release it. A read-only callback holds no managed checkout. The callback records each start, checkout and terminalization. The test drives every release explicitly, including on failure.

| Checkpoint | Expected observation |
| --- | --- |
| First tick with both writes queued | Worker A claims the first writer and the reader while a global slot remains free. Only the first writer's managed checkout exists. The second writer is queued with zero attempts, no lease, no `claimed` event and no managed branch or path. |
| Second worker while the first lease is current | Worker B claims nothing despite spare capacity and its empty local active set. The second writer's saved task bytes and events are unchanged. The inventory still shows only the first writer's checkout. |
| Handoff after the first attempt finishes | Persist completion through the validated task store, clear the first lease and wait for its callback and worker to settle. Keep the first checkout registered. Worker B now claims the second writer exactly once. Git reports both distinct managed worktrees, with only the second writer holding a current lease. |

At each checkpoint, correlate the callback's task and run IDs, saved leases, claim events and exact managed checkout identities. Fail on any second writer claim or checkout before the first attempt releases ownership. Check the source checkout's branch, HEAD, tracked bytes and clean status. In cleanup, release pending attempts and await both workers before removing their fixture-owned branches and worktrees. Verify their absence and dispose the owned root with the fixture's identity checks.

The injected callback supplies synthetic attempt execution and terminalization. Production scheduling, persisted claims and Git checkout creation are exercised directly. This slice covers the direct scheduler path and cooperating workers that share local state. Workflow-specific ownership, expired-lease recovery, independently launched Git processes and arbitrary user-created worktrees are outside this check.

## Proposed tasks and validation

| Task | Scope | Files |
| --- | --- | --- |
| T020 | Add the three-checkpoint EVAL with two workers, one disposable repository and controlled attempts. | `scripts/organizational-active-write-checkout.test.ts` |
| T021 | Add the EVAL to the single-worker organizational Vitest invocation and document the invariant. | `package.json`, `evals/README.md` |

Run these checks in order after implementation approval. Keep current guards and timeouts. Stop on the first failure or unknown result.

1. `pnpm exec vitest run scripts/organizational-active-write-checkout.test.ts` must pass the complete scenario and verified cleanup.
2. `pnpm exec vitest run runner/task-orchestrator.test.ts -t 'serializes writes per project|workflow reconciliation does not add a scheduler'` must pass exactly the two selected scheduler regressions.
3. `pnpm exec vitest run runner/worktree.test.ts -t 'dedicated agent branch|repeats creation'` must pass exactly the two selected worktree regressions.
4. `pnpm evals:check` must pass v1, v2 and all ten organizational EVALs, with 41 organizational tests expected.
5. `pnpm typecheck` must exit 0.

The proposed changes affect offline tests and documentation. The EVAL uses local Git and requires no service, browser, real project or model.

## T020–T021 acceptance on 2026-11-16

**The [`org.execution.active-write-checkout` increment](../../scripts/organizational-active-write-checkout.test.ts) is complete.** T020 observed two scheduler instances sharing isolated state and real Git worktrees. The second writer stayed queued without a claim, lease or checkout while the first lease was active, and the same-project reader ran alongside the first writer. After the first lease closed, the second writer acquired a distinct checkout while the inactive first tree remained registered. The source checkout was preserved, both workers stopped, and the branches, worktrees and fixture were removed. T021 added the EVAL to the mandatory offline gate and documented its coverage.

| Check | Observed result |
| --- | --- |
| Active write checkout focused test | Exit 0. The full scenario passed. |
| Selected scheduler regressions | Exit 0. 2 passed and 80 skipped by the selector. |
| Selected worktree regressions | Exit 0. 2 passed and 40 skipped by the selector. |
| `pnpm evals:check` | Exit 0. V1 matched 42 of 42 expectations with 36 of 36 coverage. V2 matched 8 of 8. All 41 organizational tests passed in 10 files. |
| `pnpm typecheck` | Exit 0. |

The attempt callbacks were synthetic and the Git worktrees were real. The changes remained local. Phase S continues with the [proposed execution budget EVAL](phase-s-execution-budget-eval.md).
