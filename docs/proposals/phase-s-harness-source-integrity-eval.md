# Phase S · Verify Harness source and manifest integrity

## Scope

Add `org.harness.source-integrity` to the mandatory S.1 offline gate. The [Harness source loader](../../lib/harness/source.ts) validates the trusted registry, checks the manifest SHA-256 against its registry pin, then checks every expected source entry against its manifest pin. [Doctor](../../dashboard/src/server/harness-service.ts) and the [scaffold preview](../../lib/harness/scaffold-preview.ts) consume that trust decision. Exercise both consumers with isolated source and manifest discrepancies.

## Fixture and expected outcomes

Reuse the [disposable scaffold CLI fixture](../../scripts/testing/scaffold-cli-fixture.ts) for a copy of the reviewed source, registry and manifest, a registered synthetic Git checkout, a selected `personal@1` archetype and an absent state root. Use a fresh fixture for each variant. Verify the trusted baseline with the real loader before introducing drift. Use the real Doctor read service with fixture policy, state and a fixed clock. Call the [registered preview](../../lib/harness/scaffold-project.ts) in process. It requests template content on the successful path so the negative cases can check that a refusal contains no template body or partial plan.

| Variant | Fixture change | Expected result |
| --- | --- | --- |
| Reviewed source and manifest | Keep the pins and all file bytes intact. | The loader returns `trusted` and a non-null fingerprint. Doctor reports the reviewed canonical version and the missing template. Preview returns the expected addition with its pinned hash, the same source fingerprint and `execution_authority: none`. |
| Pinned source file differs | Append one LF byte to the copied `.agents/orchestration/ROUTING.md` outside the selected template set. Preserve the registry and manifest bytes. | The file hash differs from its recorded pin while the manifest still matches the registry. The loader returns `unknown` without a trusted manifest or source fingerprint. Doctor reports unknown comparison with the `source-unavailable` finding. Preview returns the exact unavailable result with reason `source-unavailable` and no plan. |
| Pinned manifest differs | Append one LF byte to the copied manifest. Verify it still parses to the same JSON and preserve the registry and all pinned source files. | The manifest hash differs from the registry pin. The loader, Doctor and preview expose the same unavailable-source behavior as for file drift. |

Check both hashes around each deliberate change to isolate the failing integrity boundary. For each variant, capture the fixture inventory and file hashes after setup and compare them after each observation. Include the control source, target checkout and Git metadata, and verify that the state root stays absent. Confirm Doctor returns no saved profile and exposes a null canonical version and source fingerprint on either mismatch. Require preview's exact unavailable object so no template text, fingerprint or addition survives a refusal. Dispose the fixture using its existing ownership check and verify removal. The changes are limited to offline coverage of existing behavior.

## Proposed tasks and validation

| Task | Scope | Files |
| --- | --- | --- |
| T026 | Add the three integrity cases with the production loader, Doctor and registered preview. | `scripts/organizational-harness-source-integrity.test.ts` |
| T027 | Add the EVAL to the single-worker organizational Vitest invocation and document its coverage. | `package.json`, `evals/README.md` |

Run these checks in order after implementation approval. Retain existing guards and timeouts. Stop on the first failure or unknown result.

1. `pnpm exec vitest run scripts/organizational-harness-source-integrity.test.ts` must pass all three variants and fixture cleanup.
2. `pnpm exec vitest run lib/harness/source.test.ts` must pass all four source regressions.
3. `pnpm exec vitest run lib/harness/inspect.test.ts lib/harness/scaffold-preview.test.ts -t 'reports invalid routing and unknown canonical comparison|refuses a changed canonical entry without returning a partial plan'` must pass exactly two consumer regressions.
4. `pnpm evals:check` must pass v1, v2 and all thirteen organizational EVALs, with 52 organizational tests expected.
5. `pnpm typecheck` must exit 0.

The proposed changes affect offline tests and documentation. Validation uses local Git and requires no browser, model or manual setup.

## T026–T027 acceptance on 2026-11-17

**The [`org.harness.source-integrity` increment](../../scripts/organizational-harness-source-integrity.test.ts) is complete.** T026 verified the reviewed source and pinned addition, then independently changed a source file and the manifest. Both discrepancies made canonical comparison unavailable in Doctor and caused the registered preview to return `source-unavailable` without a partial plan. Each observation preserved the fixture inventory and file hashes, and fixture cleanup passed. T027 added the EVAL to the mandatory offline gate and documented its coverage.

| Check | Observed result |
| --- | --- |
| Harness source integrity focused tests | Exit 0. All 3 cases passed. |
| Source loader regressions | Exit 0. All 4 cases passed. |
| Selected Doctor and scaffold preview regressions | Exit 0. 2 passed and 34 skipped by the selector. |
| `pnpm evals:check` | Exit 0. V1 matched 42 of 42 expectations with 36 of 36 coverage. V2 matched 8 of 8. All 52 organizational tests passed in 13 files. |
| `pnpm typecheck` | Exit 0. |

The changes remained local. Phase S continues with the [proposed scaffold ownership conflict EVAL](phase-s-scaffold-ownership-conflict-eval.md).
