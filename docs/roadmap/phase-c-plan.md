# Phase C — Portfolio operating profile and privacy boundary plan

## Baseline

- Date: 2026-09-27.
- Reviewed `HEAD`: `00fba28` (`feat: enforce phase B credential and dispatch policies`), on `codex/phase-b-credential-policy` before creating the Phase C branch.
- Phase C work branch: `codex/phase-c-portfolio-profile`, created locally from the accepted Phase B commit.
- Working tree: tracked files clean. The user-owned, untracked `SURTEC_CONTROL_PLANE_PORTFOLIO_INTELLIGENCE_PROMPT.md` is preserved and will not be staged.
- Runtime: Node.js `v24.16.0`, pnpm `10.24.0`.
- Baseline `pnpm ci:check` passed: repository consistency, 11 schemas, secret scan (895 files), 36/36 EVAL coverage and 42/42 expectations, 67 test files / 478 tests, typecheck, and build (1,910 modules).
- Phase C scope: keep technical execution policy in `registry/projects.yml`; add an ignored, versioned local profile store; validate profiles at runtime; expose protected local API operations; and add a visually distinct editor to project cards.
- No implementation changes were present when the baseline ran.

## Implementation slices

1. Add strict JSON Schemas and TypeScript contracts for an individual `ProjectProfile` and the versioned local portfolio document. Validate calendar dates and IDs at runtime, reject unsupported future document versions, and use atomic writes plus a state lock for updates.
2. Keep `state/portfolio/projects.json` under the existing ignored `state/` boundary. Add a synthetic example fixture and operations documentation that distinguish local portfolio context from tracked technical policy. Extend the secret check to fail if local portfolio state is force-added to Git.
3. Add protected local API routes to list profiles and save one profile, with validation, ID matching, bounded fields, and safe error handling.
4. Add an accessible, focused per-project profile editor in the overview cards, visually separated and explicitly labeled as local portfolio data. Preserve projects with no profile and show save/validation errors without exposing the profile in technical registry configuration.
5. Add storage, API, privacy-scanner, and UI tests; run focused tests, the full CI gate, API smoke, browser validation, and `git diff --check`. Do not run paid Codex smokes or make remote changes.

## Verification and delivery

- Verify the API and UI locally in a browser after checking ports; stop only any server started for this smoke.
- Run `pnpm ci:check`, `pnpm smoke:api`, `pnpm secrets:check -- --self-test` (or the equivalent direct self-test), and `git diff --check`.
- Run `pnpm audit:check` as a read-only dependency check; distinguish network-policy failures from vulnerability results.
- Do not run a real Codex smoke without explicit opt-in. Do not push, merge, deploy, or modify sibling project repositories.
- Stop after Phase C for local validation; Phase D and later remain out of scope.
