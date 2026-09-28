# Agent evaluation suites

Evaluation suites are versioned under `evals/vN/`. Offline suites use structured synthetic fixtures only and never execute the commands they contain.

Run the mandatory offline gate with:

```text
pnpm evals:check
```

This runs both `v1` policy/contract coverage and the pinned `surtec-outcome-golden-v2` suite. The v1 runner validates manifests and fixtures against JSON Schema, contains paths under the suite directory, expands cases across declared task types, and checks positive coverage against `registry/agents.yml`. V2 retains the same hard-failure evaluator and adds observable checks for required report sections, evidence references, changed-file scope, tests, verification, risks, actionable next steps, and prohibited side effects.

Verdicts are:

- `pass`: required checks pass and the weighted score meets the suite threshold;
- `fail`: deterministic quality or scope evidence is insufficient;
- `hard-fail`: a security or policy invariant is violated, or required evidence is absent, regardless of score.

The golden cases are synthetic examples, not copied client tasks. Do not add private client content, credentials, real prompts, or user-specific paths. When adding a role or task type to the registry, add positive fixture coverage to v1. When the evaluation contract changes incompatibly, create a new versioned suite rather than silently changing historical fixtures.

## Optional live canaries

The live canary command is not part of CI and skips without explicit opt-in. It uses exactly two pinned read-only cases against `fixtures/evals-canary`, refuses execution when `CI` is set, verifies both offline suites before running, snapshots the fixture before and after, and reports only status, runtime, and token usage. It does not print model output or estimate monetary cost. Usage notifications trigger an abort at 3,000 tokens per request; because the runtime reports usage asynchronously, a notification can arrive after some usage has already accrued. Each turn is capped at two minutes and the suite at five minutes.

To intentionally run the two real turns in PowerShell:

```powershell
$env:SURTEC_LIVE_CANARIES = "1"
pnpm run evals:canary -- --confirm-live-canaries
Remove-Item Env:SURTEC_LIVE_CANARIES
```

The command can consume model quota. Automated tests use a fake executor; no live call is required for ordinary development or CI.
