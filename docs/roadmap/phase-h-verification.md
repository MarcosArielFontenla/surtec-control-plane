# Phase H — Client commitments verification

## Summary

Phase H adds a delivery-focused, local-only client directory and commitment register without adding CRM workflows. Commitments feed the deterministic signal engine and Today ranking. The project-to-client association continues to use `ProjectProfile.client_id`; project lists are derived. Client context is never added to tasks by default, and confidential notes require a distinct explicit selection.

The scope is the portfolio-intelligence prompt's Phase H. It is distinct from the legacy collaborative-workspace Phase 6 and from the separate Organization/Harness roadmap. No real client data, provider integrations, external project edits, Codex calls, push, merge, or deployment were used.

## Files modified

- Domain and persistence: `lib/client-portfolio.ts`, `lib/state/client-portfolio.ts`, `lib/state/client-portfolio.test.ts`, `lib/state/paths.ts`, `lib/state/validation.ts`.
- Contracts: `schemas/client-record.schema.json`, `schemas/client-input.schema.json`, `schemas/client-commitment.schema.json`, `schemas/commitment-input.schema.json`, `schemas/client-portfolio.schema.json`, and updated `schemas/signal.schema.json`.
- Server and signals: `dashboard/src/server/client-portfolio-service.ts` and its tests; updated `dashboard/src/server/index.ts` and tests, `signal-evidence.ts` and tests, `dispatch.ts` and tests; updated `lib/signals/engine.ts` and tests and `lib/signals/types.ts`.
- Dashboard: new `dashboard/src/ui/views/ClientCommitmentsView.tsx`; updated `App.tsx`, `api.ts`, `Sidebar.tsx`, `dashboard.css`, `NewTaskForm.tsx` and tests, `ProjectProfileEditor.tsx` and tests, `ProjectDetailView.tsx` and tests, and `TaskDetailView.tsx`.
- Browser/API verification: new `scripts/playwright-client-commitments-smoke.ts`; updated `scripts/playwright-project-detail-smoke.ts`, `scripts/api-smoke.ts`, and `package.json` with the new smoke command.
- Documentation: `docs/roadmap/phase-h-plan.md`, this verification, `docs/roadmap/control-plane-evolution.md`, `docs/roadmap/phase-g-verification.md`, `docs/operations/portfolio-profiles.md`, `docs/operations/signals.md`, `docs/operations/today-cockpit.md`, `docs/runbooks/local-development.md`, and `docs/security/threat-model.md`.

The two user-owned prompt files remain untracked and are excluded from all commits: `SURTEC_CONTROL_PLANE_PORTFOLIO_INTELLIGENCE_PROMPT.md` and `SURTEC_CONTROL_PLANE_ORGANIZATION_HARNESS_ROADMAP_PROMPT.md`.

## Commands and exact results

- `pnpm ci:check` — passed: repository consistency; 26 JSON schemas; secret scanner self-test and 961-file scan; EVAL coverage 36/36 with expectations 42/42; 79 test files and 536 tests; `tsc --noEmit`; Vite production build with 1,915 modules.
- Focused suite `pnpm test -- dashboard/src/server/dispatch.test.ts dashboard/src/server/index.test.ts dashboard/src/server/client-portfolio-service.test.ts lib/state/client-portfolio.test.ts lib/signals/engine.test.ts dashboard/src/server/signal-evidence.test.ts dashboard/src/ui/components/NewTaskForm.test.tsx dashboard/src/ui/components/ProjectProfileEditor.test.tsx dashboard/src/ui/views/ProjectDetailView.test.tsx` — passed: 9 files, 107 tests.
- `pnpm typecheck` — passed after the final smoke-script edits.
- `git diff --check` — passed; Git printed only the repository's existing LF/CRLF normalization and inaccessible global-ignore-file warnings.
- `pnpm smoke:api` — passed: overview, Today, dispatch options, profiles, clients, commitments, client-context options, integrations, and signals all returned 200; 21 projects discovered, 12 configured; the local store contained zero client and commitment records; 3 signals. Only endpoint statuses and counts were printed.
- `pnpm smoke:client-commitments:playwright` — passed using in-memory synthetic fixtures: client creation, masked/revealed names, project association, commitment registration, Today presentation, generic client-signal task prefill, unchecked-by-default categories, explicit notes selection, protected mutations, and no client note in the browser's task request.
- `pnpm smoke:today:playwright` — passed: healthy, degraded, overloaded, and empty fixtures plus protected signal actions and task handoff.
- `pnpm smoke:project-detail:playwright` — passed: configured, unconfigured, degraded, refresh, project state, and client-safe task prefill.
- `pnpm smoke:signals:playwright` — passed: same-origin reads, session-protected mutations, and restart persistence.
- `pnpm smoke:work-sessions:playwright` — passed: start, notes, links, pause/reload/resume/completion, protected writes, and process safety.
- `pnpm install --frozen-lockfile` — not run because no dependencies or lockfile entries changed. `pnpm audit:check` was not repeated for this phase; Phase G recorded registry `EACCES`, and Phase H changes no dependencies.
- No real Codex runtime smoke was run; the browser fixtures never dispatched to Codex.

## Manual local validation

1. Start `pnpm dev` and open the dashboard. In `Clientes`, create a clearly fictional record and confirm its name is masked in compact rows by default. Toggle visibility and inspect the clearly local/confidential field labels.
2. Open a project detail, set its profile to `Cliente`, and associate it with that record. Return to `Clientes` and add a commitment for that project with a due date in the next seven calendar days. Confirm it appears in Hoy with a deterministic client-commitment rank. Mark it completed/cancelled and confirm the active signal disappears after refresh; a blocked commitment should remain visible as a blocked action.
3. Open the task form for the linked project. Verify the category selector returns no client content and begins fully unchecked. Leave every category unselected; no client context will be appended. Select a category only when you intentionally want that local field included in task instructions. Confidential notes have their own checkbox.
4. Verify `state/portfolio/clients.json` is ignored by Git. Use only synthetic data for local validation unless you have chosen to enter real local client information; the application does not encrypt this state. No actual Codex dispatch is required to validate the workflow.

## Security impact

- Client and commitment records stay in ignored local state, are schema-validated, bounded, cross-process locked, and atomically replaced. Future or malformed state fails closed. The API uses the existing loopback/origin/session-token protections.
- Client project IDs are derived from local project profiles; no second project-client association source is persisted. Commitment task/session links must resolve to the same project.
- Context-options responses disclose category availability only. Explicitly selected context is composed server-side, bounded to 8,000 characters, redacted, and attached to task instructions only after selection. Audit metadata stores categories, an opaque client ID, and timestamp—not notes or reasoning. Task display titles are derived from the user's base request rather than server-appended client context.
- Today evidence excludes client names and confidential notes. Client project quick-task actions prefill generic instructions so profile text is not silently passed to Codex.
- State is plaintext and relies on host account/disk protections. After a user explicitly selects context and dispatches a task, the selected text is present in the local task envelope and may be sent to the configured local Codex App Server; the audit entry makes the category selection visible.

## Known risks and deferred work

- Local client state is not encrypted. Keep sensitive details concise and out of tracked files, fixtures, logs, screenshots, and ordinary commitment titles/next actions that appear in Today.
- Client deletion is intentionally not exposed to avoid silently severing profile and commitment history. Clients can be paused; commitments can be completed or cancelled.
- This remains single-user local software, not a CRM or multi-user security boundary. The client-to-project association projection depends on the project profile store remaining available.
- No dependency audit or frozen install was repeated because the phase has no dependency changes; registry audit access was previously limited by `EACCES`.

## Local commits

- `03799a9` — `feat: add local client commitments and signals`.
- `77aa837` — `feat: add client commitments UI and privacy controls`.
- The Phase H plan and verification record are in a separate documentation commit. No push, merge, or deploy is part of Phase H.

## Recommended next phase

Stop for Marcos's local validation. After acceptance, proceed to Phase I — Outcome-oriented EVALs and operating feedback.
