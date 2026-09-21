# Phase 4 — Evaluations and quality gates verification

## Delivery summary

Phase 4 adds an offline, deterministic evaluation gate for structured agent results. The first versioned suite expands fixtures across the current role/task-type registry, checks quality evidence, and proves that security or policy violations remain hard failures even when the aggregate quality score is perfect.

The gate is available as `pnpm evals:check`, is included in `pnpm ci:check`, and runs as an explicit GitHub Actions step before the general test suite.

## Versioned suite

`evals/v1/` contains:

- one schema-versioned manifest;
- ten positive fixtures, one for each registered role;
- positive expansion across all 36 allowed role/task-type pairs;
- one expected quality failure with insufficient implementation evidence;
- five expected hard-failure fixtures for secret exposure, denied task type, read-only mutation, missing human approval, and prohibited push;
- extension guidance in `evals/README.md`.

The suite currently evaluates 42 cases and matches 42 expectations.

## Deterministic quality checks

The evaluator checks:

- summary substance and placeholder absence;
- outcome/blocker consistency;
- next-step evidence;
- risk evidence for review-oriented roles and task types;
- changed files for implementation and documentation work;
- declared tests and passed verification for code-changing tasks;
- product actionability;
- QA test/scenario evidence;
- security findings;
- reality-checker challenge and blocker evidence;
- documentation artifacts;
- operations safety evidence;
- explicit human lawyer review for Argentine legal output.

Checks have explicit weights. Required check failures produce `fail` even when the remaining aggregate score would otherwise pass.

## Hard failures

The evaluator returns `hard-fail`, independent of score, for:

- unknown roles or disallowed task types;
- sandbox escalation beyond the role policy;
- task/result identity mismatch;
- explicit runtime policy denial;
- read-only filesystem mutation or shell execution;
- commands outside the exact fixture allowlist;
- push, merge, deploy, destructive, or credential-exfiltration commands;
- secret-like structured output;
- approval-required actions without matching human approval evidence.

Unit tests cover every hard-failure code. Negative suite fixtures demonstrate representative policy and security cases with quality scores of `1.000`.

## Suite integrity

- Manifest and fixture documents validate against JSON Schema before evaluation.
- Fixture paths are restricted by schema and contained under the selected suite directory.
- Unknown versions, duplicate fixture identifiers, unreadable fixtures, and invalid schemas fail closed.
- Positive coverage is compared with `registry/agents.yml`; adding a role or task type without a passing fixture breaks the gate.
- Fixture commands are strings only and are never executed.

## Automated verification

Baseline before Phase 4:

```text
npm run test -- --run
61 test files passed
440 tests passed

npm run typecheck
passed

npm run schemas:check
Validated 8 JSON Schemas.
```

Final offline gate:

```text
npm run ci:check

schemas:check
Validated 10 JSON Schemas.

secrets:check
Secret scan passed (871 repository files checked).

evals:check
Coverage 36/36; expectations 42/42.

test
63 test files passed
451 tests passed

typecheck
passed

build
passed
```

Build detail:

```text
1910 modules transformed
dist/index.html                  0.42 kB | gzip 0.28 kB
dist/assets/index-DMGXPO77.css 30.44 kB | gzip 6.55 kB
dist/assets/index-j7oHpGIN.js 207.73 kB | gzip 62.15 kB
```

Focused tests also verify:

- a required quality failure remains distinct from a hard security failure;
- a secret exposure hard-fails with a perfect quality score;
- all hard-failure categories are explicit and machine-testable;
- registry drift produces a positive coverage failure;
- traversal fixture paths are rejected before filesystem access;
- manifests outside the evaluations root are rejected.

No browser smoke was run because Phase 4 changes no UI behavior. No real Codex runtime smoke or paid model call was run because the suite is intentionally offline.

## Security impact

- Security and policy failures cannot be averaged away by strong quality evidence.
- Fixture commands are never executed.
- Result content, including verification tails, is checked for secret-like material.
- Path containment and schema validation protect the fixture loader.
- Evaluation output contains operational verdicts and check identifiers only; it stores no prompts, environment values, credentials, or reasoning.
- Runtime dispatch, execution, review, and approval policy remain the authoritative enforcement boundaries.

## Known risks and deferred work

- Deterministic structural checks cannot prove semantic correctness, factual accuracy, or usefulness.
- Fixtures can overfit the current heuristics; changes to checks require deliberate fixture review.
- Project-specific policy is not represented in the core role/task-type matrix. Runtime `PolicyService` remains responsible for repository, sandbox, and project authorization.
- Ordinary allowed commands are trusted fixture data, although prohibited external and destructive operations remain independent hard failures.
- The offline suite does not grade live model variance or prompt regressions. Paid model evaluation remains out of scope.
- Evaluation history, trends, and a dashboard are deferred.
- Suite results do not automatically approve, reject, or mutate live tasks.

## Manual local validation

Run the evaluation gate independently:

```text
pnpm evals:check
```

Expected final line:

```text
Coverage 36/36; expectations 42/42.
```

To validate registry drift protection locally:

1. Add a temporary allowed task type to one role in `registry/agents.yml`.
2. Run `pnpm evals:check` and confirm it reports the missing positive role/task-type pair.
3. Restore the registry change.

To add coverage, place a schema-valid case under `evals/v1/cases/`, add its contained relative path to `evals/v1/suite.json`, and run `pnpm ci:check`.

## Local commits

- `8475a2a` — `docs: define phase 4 evaluation plan`
- `8c9aeb1` — `feat: add deterministic evaluation engine`
- `c3b7983` — `feat: add versioned evaluation suite gate`

The verification documentation and roadmap status are committed separately at phase close.

## Recommended next phase

Proceed to Phase 5 only when at least two real implementations justify an integration interface. Keep source-control, CI, deployment, and observability adapters narrow and preserve the offline evaluation gate as a regression boundary.
