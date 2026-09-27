# Phase A — Acceptance baseline and operational corrections verification

## Delivery summary

Phase A aligns CI with the repository's documented `master` default branch, adds a deterministic drift check, records the GitHub metadata items for manual confirmation, and strengthens both real Codex smoke paths without running a paid model call.

This phase does not alter GitHub settings, push, merge, deploy, or change any external project repository. Phase B and later are not started. Phase A is stopping here for Marcos's local validation.

## Baseline and implementation

- Baseline: `df49a43de15e20ac833cda4258b06f1034c30557` on `master`; it matched `origin/master` before implementation.
- Baseline Node.js `v24.16.0`, pnpm `10.24.0`, Codex CLI `0.145.0`, and generated App Server bindings `0.145.0`.
- `.github/workflows/ci.yml` now runs push CI only on `master` and retains the pull-request trigger, read-only permissions, concurrency cancellation, frozen-lockfile install, schema/secret/EVAL/test/typecheck/build checks, and dependency audit.
- `pnpm repository:check` parses the tracked repository settings and workflow and rejects branch drift, missing/disabled pull-request CI, malformed YAML, or ambiguous branch documentation. Four focused regression cases cover the matching configuration and drift/failure cases.
- `docs/operations/repository-settings.md` is the documented branch source and contains unchecked manual GitHub metadata items. The prior public visibility / stale description observation is labeled unverified; no item is claimed complete.
- The read-only smoke is pinned to the checked-in fixture, rejects symlinks, hashes contents before and after even on failure, validates structured output and captures thread, turn, usage, and completed status. An additional cancellation attempt is optional and separately configured.
- The write smoke accepts no project path. It creates a temporary Git repository and managed worktree under the OS temporary directory, pins inherited Windows temp variables to that worktree for the agent turn, allows network-disabled workspace-write only for that smoke context, accepts exactly one controlled file change, validates the report, captures the commit/diff, executes a verification command, and explicitly cleans up. Neither smoke pushes or participates in ordinary CI.

## Automated checks

Final `pnpm ci:check` result:

- Repository consistency: passed; documented `master` matches CI push trigger.
- JSON Schemas: 11 validated.
- Secret scan: passed, 888 repository files checked.
- Deterministic EVALs: coverage 36/36; expectations 42/42.
- Tests: 67 files passed; 469 tests passed.
- Typecheck: passed.
- Build: passed; 1,910 modules transformed.

Additional checks:

- `pnpm smoke:api`: passed. Overview, today, dispatch options, and integrations returned HTTP 200; 21 projects discovered; integration schema version 1.
- `pnpm audit:check`: passed; npm reported no known vulnerabilities.
- `git diff --check`: passed.
- `pnpm install --frozen-lockfile --lockfile-only`: passed without a tracked lockfile change. A full `pnpm install --frozen-lockfile` was attempted before implementation but pnpm aborted rather than replace the existing `node_modules` in a non-interactive session. The local dependency directory was preserved.

## Browser smoke

Started `pnpm dev` after confirming ports 4317 and 5173 were free. The in-app browser loaded `http://localhost:5173/` with title `Surtec Control Plane`; the dashboard finished loading the “Hoy” view and showed 21 repositories with no active tasks. The temporary tab and only the server process started for this check were closed afterward.

At startup, Git reported “dubious ownership” for nine sibling repositories because this automation session runs as `CodexSandboxOffline`, while those repositories are owned by `tecno.pc`. The app continued to serve the dashboard and reported no orphan worktrees. No `safe.directory` exceptions were added and no sibling repository was changed. The local reconciliation report now records these environment-specific read errors; this does not establish that Marcos's normal local session will have the same warnings.

## Real Codex smoke status

Neither paid smoke was executed. With each opt-in variable explicitly unset, `pnpm smoke:codex` and `pnpm smoke:codex:write` both exited successfully with a skip message. No Codex model call was made. The real read-only and disposable write paths remain available for a later explicit local opt-in; their smoke results are therefore not yet part of this verification.

## Security impact

- The branch check is local and read-only; no GitHub metadata API or mutation is involved.
- Ordinary CI has no Codex runtime call. Smokes have distinct explicit environment-variable gates and quota warnings.
- The read-only smoke cannot accept an alternate path and fails on fixture mutation or symlinks.
- The write smoke is scoped to a newly created disposable repository/worktree, has network access disabled, uses no remote, validates the sole expected file change, and cleans its verified temporary root in `finally`.
- Credentials and raw agent response text are not included in smoke output.
- The existing fake-protocol tests remain the automated test path; no paid model calls are made by tests.

## Known risks and deferred work

- Marcos still needs to review the unchecked GitHub visibility, description, branch protection, required CI check, and feature-branch/PR checklist. The app has not changed any of those remote settings.
- The full frozen install was not completed because pnpm requested an interactive replacement of the existing dependency directory. CI still uses the unchanged frozen-lockfile install step.
- The real Codex smokes were intentionally not run, so their end-to-end results remain unverified until explicit opt-in.
- The in-app browser smoke used a sandbox account with different ownership from sibling repositories; local Git observations for nine projects degraded in that session. Do not work around this by globally trusting sibling directories; validate under Marcos's normal Windows account.
- No Phase B implementation is included.

## Manual local validation

From PowerShell on Marcos's normal Windows account:

```powershell
git switch codex/phase-a-acceptance-baseline
pnpm repository:check
pnpm ci:check
pnpm audit:check
pnpm smoke:api
pnpm dev
```

Open `http://localhost:5173/`, confirm the dashboard loads and the API responds at `http://127.0.0.1:4317`, then stop the development server with Ctrl+C. Review [repository-settings.md](../operations/repository-settings.md) manually in GitHub. Run either real Codex smoke only when explicitly choosing to spend the associated model quota; see [codex-runtime.md](../runbooks/codex-runtime.md) for the isolated commands and cleanup boundaries.

## Recommended next step

Complete local validation and confirm the manual GitHub checklist. Do not begin Phase B until Marcos accepts this phase and gives the next instruction.
