# Phase A — Acceptance baseline and operational corrections plan

## Baseline

- Date: 2026-09-27.
- Reviewed `HEAD`: `df49a43de15e20ac833cda4258b06f1034c30557` (`docs: finalize phase 5 verification`).
- Default branch: `master`; local `master` matched `origin/master` before work.
- Working tree: tracked files clean. The user-owned, untracked `SURTEC_CONTROL_PLANE_PORTFOLIO_INTELLIGENCE_PROMPT.md` is preserved and will not be staged.
- Runtime: Node.js `v24.16.0`, pnpm `10.24.0`, Codex CLI and generated App Server bindings both `0.145.0`.
- State inspection: no task or event records; reconciliation reports no orphaned worktrees or errors.
- `pnpm install --frozen-lockfile` could not replace the existing `node_modules` without an interactive terminal. `pnpm install --frozen-lockfile --lockfile-only` passed without a tracked lockfile change.
- Baseline `pnpm ci:check` passed: 11 schemas, secret scan (883 files), 36/36 EVAL coverage and 42/42 expectations, 66 test files / 465 tests, typecheck, and build.
- Baseline `pnpm smoke:api` passed: overview, today, dispatch options, and integrations returned HTTP 200; integration schema version 1.
- Baseline `pnpm audit:check` was blocked by network policy (`EACCES` posting to the npm audit endpoint), not by an advisory result.

## Implementation slices

1. Make `docs/operations/repository-settings.md` the tracked source for the documented default branch (`master`) and record the GitHub metadata checklist without claiming external settings are complete.
2. Align the CI push trigger with `master`; add a deterministic repository-consistency check to local CI and GitHub Actions while preserving pull-request runs, permissions, concurrency, and all existing checks.
3. Strengthen the opt-in read-only Codex smoke to verify the fixture boundary, report schema, non-empty thread and turn identifiers, usage capture, terminal completion, and unchanged fixture contents even when execution fails.
4. Add a separately gated real write smoke that creates its own temporary Git repository and managed worktree, requests one bounded fixture change, validates structured output, commits/captures the diff, runs verification, and explicitly removes the worktree and temporary repository. Never target sibling projects or push.
5. Document exact PowerShell commands, quota warnings, fixture boundaries, and cleanup behavior. Keep both real Codex smokes outside CI and do not execute either without explicit opt-in.

## Verification and delivery

- Run the repository-consistency check, `pnpm ci:check`, `pnpm audit:check`, and `pnpm smoke:api`; report blocked network-only checks distinctly.
- Run a browser smoke against the local dashboard without terminating a pre-existing user server.
- Do not run a real Codex smoke without explicit opt-in.
- Do not change GitHub metadata, push, merge, deploy, or modify external project repositories.
- Stop after Phase A for local validation; Phase B and later remain out of scope.
