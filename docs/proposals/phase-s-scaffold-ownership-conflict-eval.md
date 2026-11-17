# Phase S · Preserve user-owned scaffold conflicts

## Scope

Add `org.harness.scaffold-ownership-conflict` to the mandatory S.1 offline gate. The [scaffold preview](../../lib/harness/scaffold-preview.ts) classifies a differing user-owned file as `user-owned-conflict` and excludes it from the additions. The [application service](../../lib/harness/scaffold-operation.ts) applies only the eligible missing templates in the exact approved offer. It also refuses an offered addition whose path has incompatible ownership. The [Phase R contract](phase-r-archetype-apply.md) permits an independent missing template to be added while a conflict stays preserved.

## Fixture and expected outcomes

Reuse the [disposable scaffold CLI fixture](../../scripts/testing/scaffold-cli-fixture.ts) and call the [registered preview](../../lib/harness/scaffold-project.ts) and real application service in process. Use a fresh fixture for each case. Add a synthetic ownership declaration for `.agents/templates/entity.spec.yaml` to the fixture control registry, with a distinct evidence string and classification `user-owned`. Keep the canonical source and manifest pins and confirm the source still loads as trusted. Retain the synthetic local edit in the registered target checkout. Keep all preparation and any runtime writes within the disposable root.

| Variant | Fixture | Expected result |
| --- | --- | --- |
| Unresolved conflict with no eligible additions | Place distinct user bytes at `entity.spec.yaml`. Keep the preexisting `feature.tasks.md` equal to its canonical template. | Preview reports `user-owned-conflict` and `preserve-and-review-conflict` with the expected observed, canonical and ownership evidence hashes. The additions and rollback effect lists are empty. Apply returns `no-op` with no operation ID or approval callback. |
| Unresolved conflict with an independent eligible addition | Keep the same distinct user bytes at `entity.spec.yaml`. Leave `feature.tasks.md` absent and Git-eligible. | In the fresh offer, verify that only `feature.tasks.md` is an addition and the existing conflict is still reported. Supply the exact offered digest and exclusive confirmation in the fixture callback. Apply verifies the new file's pinned bytes and preserves the conflicting file. The sealed preimage records the conflict as a preserved entry and escrows only the addition. A new preview still reports the unresolved conflict. |
| Missing path with user-owned evidence | Keep the user ownership declaration for `entity.spec.yaml` while the file is absent. Keep the preexisting canonical `feature.tasks.md`. | Preview lists the missing template and its user ownership. Apply returns `refused` with `ownership-conflict` and no operation ID, before asking for approval. The missing path stays absent. |

Assert the reported paths and exact results. Verify that the differing file text and raw ownership evidence stay out of the offer. Compare inventories and hashes for the control source and target, including Git metadata. For the mixed case the target delta is exactly the new canonical template. Check that the preserved file identity, modification time and bytes match the preimage. Verify the operation record and escrow through the normal state reader. The no-op and refused cases leave the fixture state root absent. Dispose and verify removal of each fixture using its ownership check. The test does not resolve conflicts, amend ownership, or apply anything to a real project.

## Proposed tasks and validation

| Task | Scope | Files |
| --- | --- | --- |
| T028 | Add the three conflict cases using the real preview and application service with temporary Git fixtures. | `scripts/organizational-scaffold-ownership-conflict.test.ts` |
| T029 | Add the EVAL to the single-worker organizational Vitest invocation and document its coverage. | `package.json`, `evals/README.md` |

Run these checks in order after implementation approval. Retain existing guards and timeouts. Stop on the first failure or unknown result.

1. `pnpm exec vitest run scripts/organizational-scaffold-ownership-conflict.test.ts` must pass all three variants and fixture cleanup.
2. `pnpm exec vitest run lib/harness/scaffold-preview.test.ts -t 'binds the actual Doctor, ownership, and pinned bytes|preserves a differing template'` must pass exactly four preview regressions.
3. `pnpm exec vitest run lib/harness/scaffold-operation.test.ts -t 'applies exact bytes, verifies with Doctor|protects a destination that appears immediately before the exclusive publication'` must pass exactly two operation regressions.
4. `pnpm evals:check` must pass v1, v2 and all fourteen organizational EVALs, with 55 organizational tests expected.
5. `pnpm typecheck` must exit 0.

This slice exercises the additions-only scaffold contract. Broader reconciliation and rollback conflict handling have separate coverage. The validation requires local Git and no browser, model or manual project setup.

## T028–T029 acceptance on 2026-11-17

**The [`org.harness.scaffold-ownership-conflict` increment](../../scripts/organizational-scaffold-ownership-conflict.test.ts) is complete.** T028 verified that an unresolved conflict with no eligible additions produces a no-op. An independently approved template was created with a sealed record and escrow for that addition alone. The conflicting file retained its bytes, identity and modification time. An absent path with declared user ownership was refused before approval. The affected inventories and fixture cleanup matched expectations. T029 added the EVAL to the mandatory offline gate and documented its coverage.

| Check | Observed result |
| --- | --- |
| Scaffold ownership conflict focused tests | Exit 0. All 3 cases passed. |
| Selected preview regressions | Exit 0. 4 passed and 16 skipped by the selector. |
| Selected application regressions | Exit 0. 2 passed and 18 skipped by the selector. |
| `pnpm evals:check` | Exit 0. V1 matched 42 of 42 expectations with 36 of 36 coverage. V2 matched 8 of 8. All 55 organizational tests passed in 14 files. |
| `pnpm typecheck` | Exit 0. |

The checks used disposable Git and state fixtures. The changes remained local. Phase S continues with the [proposed invalid issue transition EVAL](phase-s-issue-transition-eval.md).
