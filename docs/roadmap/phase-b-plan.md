# Phase B — Credential boundary and policy-aware dispatch UX plan

## Baseline

- Date: 2026-09-27.
- Reviewed `HEAD`: `3cb697488fbda1acd9cd3255b8f9a284bbf69108` (`docs: record phase A verification`), on `codex/phase-a-acceptance-baseline` before creating the Phase B branch.
- Phase B work branch: `codex/phase-b-credential-policy`, created locally from the accepted Phase A commit.
- Working tree: tracked files clean. The user-owned, untracked `SURTEC_CONTROL_PLANE_PORTFOLIO_INTELLIGENCE_PROMPT.md` is preserved and will not be staged.
- Runtime: Node.js `v24.16.0`, pnpm `10.24.0`.
- Baseline `pnpm ci:check` passed: repository consistency, 11 schemas, secret scan (889 files), 36/36 EVAL coverage and 42/42 expectations, 67 test files / 469 tests, typecheck, and build.
- Baseline `pnpm smoke:api` passed: overview, today, dispatch options, and integrations returned HTTP 200; 21 projects discovered; integration schema version 1.
- Baseline findings: `gitEnvironment` includes GitHub auth and is reused by local Git and `gh`; managed Git commands do not share a fixed hooks path; `/api/dispatch-options` returns only project and agent IDs; the task form offers all modes regardless of policy.

## Implementation slices

1. Define named, minimal subprocess environment policies for local Git, Git network operations, GitHub CLI, project commands, OS process control, open actions, and Codex App Server. Audit all subprocess call sites, including maintenance scripts, and preserve output redaction.
2. Add a control-plane-owned, cross-platform empty hooks directory and prepend a fixed `core.hooksPath` Git config argument to every managed Git operation. Prove managed worktree creation and commits do not execute fixture hooks; cover the separate network/push environment and redacted Git output.
3. Extend `PolicyService` with the authoritative dispatch capability read model: project and per-agent sandbox ceilings, checkout availability, verification availability, allowed modes, safe default, and concise reasons for disabled modes.
4. Update the task form to render server-provided capabilities only, default to the safest valid mode, prevent submission when no allowed mode is selected, and explain unavailable modes without duplicating policy logic.
5. Verify with focused security, Git-hook, policy, API, and UI tests; run the full offline gate, API smoke, and local browser smoke. Do not run paid Codex smokes or make remote changes.

## Verification and delivery

- Run focused tests while implementing; then `pnpm ci:check`, `pnpm smoke:api`, and `git diff --check`.
- Run `pnpm audit:check` as a read-only dependency check; distinguish network-policy failures from vulnerability results.
- Start the API/UI only after checking the target ports and do not terminate a pre-existing server. Verify mode availability and disabled-mode explanations in the browser.
- Do not run a real Codex smoke without explicit opt-in. Do not push, merge, deploy, or modify sibling project repositories.
- Stop after Phase B for local validation; Phase C and later remain out of scope.
