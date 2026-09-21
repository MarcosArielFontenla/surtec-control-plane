# Agent evaluation suites

Evaluation suites are versioned under `evals/vN/`. They use structured fixtures only and never execute the commands they contain.

Run the current gate with:

```text
pnpm evals:check
```

The runner validates each manifest and fixture against JSON Schema, contains every fixture path under its suite directory, expands each fixture across its declared task types, and checks positive coverage against `registry/agents.yml`.

Verdicts are:

- `pass`: required checks pass and the weighted score meets the suite threshold;
- `fail`: deterministic quality evidence is insufficient;
- `hard-fail`: a security or policy invariant is violated, regardless of score.

When adding a role or task type to the registry, add positive fixture coverage in the current suite. When the evaluation contract changes incompatibly, create a new versioned directory instead of silently changing historical fixtures.
