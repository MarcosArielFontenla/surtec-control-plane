# Phase 4 — Evaluations and quality gates plan

## Outcome

Phase 4 adds an offline, deterministic evaluation suite for agent results. The suite is versioned, fixture-based, and organized as a complete role-by-task-type matrix derived from the agent registry.

Evaluation is a development and CI quality gate. It does not make paid model calls, execute fixture commands, mutate project repositories, or replace runtime policy enforcement.

## Baseline

Phase 4 starts from the completed Phase 3 branch state:

- 61 test files and 440 tests pass.
- TypeScript typechecking passes.
- All 8 JSON Schemas validate.
- Agent roles and allowed task types are defined in `registry/agents.yml`.
- Structured runtime output is validated through the agent report and agent result schemas.
- Dispatch, execution, review, approvals, verification, and lifecycle evidence already have durable boundaries.

## Evaluation contract

### Versioned suite

The first suite lives under `evals/v1/` and contains:

- a manifest with the suite version, aggregate threshold, and fixture list;
- positive fixtures covering every registered role and every allowed task type;
- negative fixtures proving that hard security and policy failures cannot be offset by quality score;
- JSON Schemas for the manifest and fixture formats.

One fixture may expand across multiple task types for the same role. The runner evaluates each role/task-type pair independently and fails if the positive fixture matrix does not cover the current registry.

### Deterministic checks

Quality checks use only structured fixture data. They include:

- non-trivial summaries and absence of placeholder language;
- outcome/blocker consistency;
- explicit next steps;
- risks for review-oriented roles and task types;
- changed-file evidence for implementation and documentation task types;
- declared tests and passed verification for code-changing task types;
- role-specific evidence for product, QA, security, reality-checking, documentation, operations, and legal review.

Checks have explicit weights. Required quality checks and the aggregate score determine `pass` or `fail`.

### Non-compensable hard failures

The following produce `hard-fail` regardless of aggregate score:

- role or task-type policy mismatch;
- a workspace-write sandbox assigned to a read-only role;
- an explicit denied policy decision;
- task/result identity mismatch;
- reported filesystem mutation or shell execution in read-only mode;
- a command outside the fixture's exact allowlist;
- prohibited push, merge, deploy, destructive, or credential-exfiltration commands;
- secret-like material in structured output;
- a requested action that requires human approval without matching approval evidence.

## Architecture

- `lib/evals/evaluator.ts` contains the pure scoring and hard-failure engine.
- `lib/evals/suite.ts` loads, validates, contains, expands, and verifies fixtures.
- `scripts/run-evals.ts` is the CLI entrypoint.
- `npm run evals:check` runs the versioned suite and exits non-zero on schema errors, coverage gaps, expectation mismatches, or failed positive fixtures.
- CI and `ci:check` run evaluations before the general test suite.

The evaluator consumes the canonical `AgentResult` shape and registry policy types instead of defining a parallel agent contract.

## Security and safety invariants

- Fixtures are data only; commands are compared as strings and never executed.
- Manifest paths are contained under the selected suite directory.
- Unknown schema versions, duplicate identifiers, missing fixtures, and registry drift fail closed.
- Negative fixtures use synthetic non-credential strings and must also pass the repository secret scan.
- Security and policy failure codes are explicit and machine-testable.
- Evaluation output contains no prompts, environment values, or chain-of-thought.

## Vertical slices

1. **Contracts and evaluator** — types, schemas, deterministic checks, hard failures, and unit tests.
2. **Versioned fixture matrix** — manifest, positive role/task-type coverage, and negative guard fixtures.
3. **Suite runner and CI** — containment, schema validation, coverage enforcement, CLI, package scripts, and workflow gate.
4. **Verification and documentation** — full automated gates, exact evidence, security review, and manual extension guidance.

## Non-goals

- Paid model-as-judge evaluations.
- Fuzzy semantic grading, embeddings, or network-backed scoring.
- Executing fixture commands or modifying external project repositories.
- Automatically blocking or approving a live task based on an offline fixture score.
- Replacing policy checks in dispatch, execution, or review.
- Benchmark dashboards, trend storage, or remote evaluation services.

## Completion criteria

- Every registered role and allowed task type has positive fixture coverage.
- Negative fixtures demonstrate every hard-failure category at least once across focused tests and the suite.
- Required checks and aggregate thresholds fail deterministically.
- Fixture and manifest schemas validate before evaluation.
- CI runs the evaluation gate without network or model access.
- Tests, typecheck, build, schemas, secret scan, and evaluation suite pass.
