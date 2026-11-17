# Phase S · Reduce the read-only Harness EVAL cost

## Observed failure

During T006–T007 acceptance, both focused EVALs passed (10 of 10), and the selected issue service regression passed. The v1 and v2 suites also passed. The organizational Vitest invocation then reported 11 of 12 tests passed. The positive `org.harness.read-only` case took 5,422 ms against the existing 5,000 ms test timeout. Vitest reported the test-level timeout at the test declaration. The output did not identify a slow stage or a subprocess error. Typecheck was not reached.

The positive case runs three Git setup calls, prepares the pinned source fixture, reads Doctor, spawns the real scaffold CLI through the TypeScript loader, and scans the full fixture after each read. For the fixture's single proposed addition, the registered preview path performs four Git commands per checkout observation, observes the checkout twice, and runs two more commands for exclusion checks. These operations and fixture cleanup share the test's 5,000 ms. The output gives no per-operation measurements. The CLI launcher has its own unchanged 4,000 ms limit, and the report does not establish that it reached that limit. [Test](../../scripts/organizational-harness-read-only.test.ts), [launcher](../../scripts/testing/scaffold-cli-fixture.ts), [registered preview](../../lib/harness/scaffold-project.ts).

### Work that can be removed

The preliminary setup snapshot hashes every file and then discards the hashes. `baseline` uses only the sorted entry paths to seed old timestamps. The full snapshot immediately after seeding supplies the actual baseline. The [Vitest configuration](../../vitest.config.ts) also allows two workers. With three organizational files now in the same invocation, the Harness case can overlap another worker's imports and tests. Competing workers are a plausible contributor. The recorded failure does not establish how much time they consumed.

## Proposed change

| File | Change |
| --- | --- |
| `scripts/organizational-harness-read-only.test.ts` | Use the existing contained inventory walk in a metadata-only preparation mode to collect timestamp seed paths. Preserve entry-kind, link, identity, stability and directory enumeration checks. Continue seeding every entry in the same order and take the complete SHA-256 and metadata baseline afterward. Keep the full comparisons immediately after Doctor and preview, all three mutation controls, and identity-checked cleanup. |
| `package.json` | Set `--maxWorkers=1` on the existing organizational Vitest invocation inside `evals:check`. Keep the same three selected files and the same v1/v2 order. The global test configuration keeps its existing worker setting. |

The preparation change removes one full round of file reads and SHA-256 calculations per fixture. Serial execution limits overlap during the mandatory gate and may increase the total duration of that invocation. The production Doctor and native CLI, all Git observations, the full baseline and post-operation inventories, all assertions, and both existing timeouts are carried forward. No fixture path is excluded. The change stays in test and evaluation infrastructure.

## Proposed validation

After approval, stop on the first failure or unknown result.

1. Run `pnpm exec vitest run scripts/organizational-harness-read-only.test.ts --reporter=verbose` once. Require both tests and their existing checks to pass, and record the duration of the positive case from Vitest.
2. Run `pnpm evals:check` once. Require v1, v2, and all 12 organizational tests to pass under the existing limits.
3. Run `pnpm typecheck` and require exit 0.

The earlier issue-cycle and objective-ancestry focused results and the issue service regression already passed. The proposed sequence resumes the remaining acceptance without rerunning those commands. If the timeout recurs, capture the observed failure before proposing any further changes.
