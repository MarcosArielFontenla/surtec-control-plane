# Phase E — Today decision cockpit plan

## Baseline

- Branch: `codex/phase-d-deterministic-signals`
- HEAD: `30f77c53262a156b36a4eee83882ff269c9f4744`
- Working tree: the user-owned, untracked `SURTEC_CONTROL_PLANE_PORTFOLIO_INTELLIGENCE_PROMPT.md` is preserved.
- Runtime: Node.js `v24.16.0`, pnpm `10.24.0`.
- Baseline `pnpm ci:check`: passed; 17 schemas, 36/36 EVAL coverage and 42/42 expectations, 73 test files / 516 tests, typecheck, and production build (1,912 modules).

## Scope

1. Compose the existing task-centric Today model with the deterministic signal feed, keeping every current task array and counter intact.
2. Expose a bounded top-three recommendation list, actionable attention, work to continue, client commitments, personal opportunities, stale/incomplete profiles, source warnings, and observation timestamps.
3. Preserve client privacy: show only project id and personal/client category; never include `client_id`, client names, provider payloads, or confidential notes.
4. Add a cockpit UI with explainable recommendation cards, signal state actions, project/task navigation, and the existing Codex task activity sections.
5. Keep optional signal/provider errors isolated: return task activity with a warning instead of treating an optional integration failure as total dashboard disconnection.
6. Add focused read-model/API/UI tests and a real Playwright browser smoke against the Vite dashboard using representative fictional API fixtures for healthy, degraded, overloaded, and empty portfolios.
7. Document manual local validation, security boundaries, and deferred work; create coherent local commits only after final verification.

## Boundaries and decisions

- No remote writes, deployment links, PR/issue mutations, Codex dispatch, or process starts are triggered by recommendation cards. Local signal actions use the existing protected session-token endpoint; opening a repository and opening a Codex task remain explicit user clicks.
- Active/paused work-session arrays are returned as empty with an explicit unavailable capability until Phase G provides a persisted session source. Existing active Codex tasks remain visible under “Continuar”.
- Ranking stays deterministic and comes from the Phase D signal engine. The UI renders server-provided ordering/explanations and does not recreate priority rules.
- No dependencies or external project repositories are changed.

## Verification

- Run focused tests for model composition, provider degradation, signal actions, and UI states.
- Run `pnpm ci:check`, `pnpm smoke:api`, and a new actual-browser Playwright cockpit smoke with fictional fixture data.
- Do not push, merge, deploy, or run paid Codex smoke tests.
