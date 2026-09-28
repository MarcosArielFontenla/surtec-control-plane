# Phase F — Project operating detail plan

## Baseline

- Branch before Phase F: `codex/phase-e-today-cockpit`.
- Baseline HEAD: `a901149c7ad18d3a03e1bf8b8bf2c2e38d41852b`.
- Working tree baseline: only the user-owned, untracked `SURTEC_CONTROL_PLANE_PORTFOLIO_INTELLIGENCE_PROMPT.md`; it remains excluded from all commits and pushes.
- Runtime: Node.js `v24.16.0`, pnpm `10.24.0`.
- Baseline `pnpm ci:check`: passed; 17 JSON Schemas, 36/36 EVAL coverage, 42/42 expectations, 73 test files / 524 tests, typecheck, and production build (1,912 modules).

## Scope and implementation decisions

1. Make the aggregate integration snapshot the detail UI's single provider read. Extend its validated contract with dependency health, preserve legacy routes until parity is covered, and share the dependency cache between the aggregate and legacy endpoint. Defer the potentially slow dependency check for portfolio/signal readers; request it only for project detail.
2. Add explicit aggregate refresh (`?refresh=true`), in-flight client request deduplication, `no-store` response behavior, and freshness timestamps so a refresh cannot appear successful while showing stale provider data.
3. Add an on-demand project operating-detail view with profile goal/next action, Git state, bounded GitHub evidence, CI, deployments, dependency health, notes, active/recent tasks, signals by human state, recent task/commit activity, and safe open/prepare-task actions.
4. Keep sessions explicitly unavailable until Phase G; do not fabricate work sessions. Keep each source independently useful when another provider is unconfigured or degraded.
5. Remove provider-specific reads and note/profile fetches from `ProjectCard`; keep its existing Git branch/sync and open actions while making detail navigation explicit.
6. Protect privacy: keep `client_id` and client names out of read-only evidence, activity summaries, and external links; preserve the existing explicit local profile-editor behavior. Do not display absolute repository paths, provider payloads, credentials, or task instructions/results. External links are built only from validated HTTP(S) URLs or known GitHub identities.
7. Add unit/API/schema coverage and a real-browser Playwright smoke using fictional configured, unconfigured, and degraded project fixtures. Document local validation, security effects, risks, and deferrals.

## Verification

- Run focused integration-service, dependency-cache, API, `ProjectCard`, project-detail, and app tests.
- Run `pnpm ci:check`, `pnpm smoke:api`, and the new project-detail Playwright smoke.
- Run `git diff --check`; do not run paid Codex smoke tests.
- Create local implementation and verification/documentation commits only. Do not push, merge, deploy, or stage the user-owned prompt.
