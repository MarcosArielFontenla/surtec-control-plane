# Phase G implementation plan

## Goal

Add durable, resumable work sessions to the single-user local control plane. Keep task/process execution independent from session actions: pausing or completing a session changes only session state.

## Baseline

- Starting branch: `codex/phase-f-project-operating-detail`.
- Baseline HEAD: `2e3f9eb0521764307b849d093fa39bea47464bcb`.
- Working tree contained only two user-owned untracked prompts: `SURTEC_CONTROL_PLANE_PORTFOLIO_INTELLIGENCE_PROMPT.md` and `SURTEC_CONTROL_PLANE_ORGANIZATION_HARNESS_ROADMAP_PROMPT.md`. Both remain outside commits.
- `pnpm ci:check`: passed; 17 schemas, secret scan across 934 files, EVAL coverage 36/36 and expectations 42/42, 74 test files / 506 tests, typecheck, and production build (1,913 modules).
- `pnpm smoke:api`: passed; Overview, Today, dispatch options, profiles, integrations, and signals returned HTTP 200; 21 projects discovered, 12 configured, three synthetic signals.
- `pnpm audit:check`: not verified; npm registry audit endpoint was blocked by environment network permissions (`EACCES`). No dependency changes are planned.
- Phase G starts on `codex/phase-g-work-sessions`, created from the baseline HEAD.

## Vertical slices

1. Define strict versioned work-session and request schemas; persist a bounded local document with atomic replacement and a global state lock. Enforce one active session inside the lock.
2. Add a server service that resolves projects from discovered sibling repositories, captures the current Git branch, validates linked task/run IDs against the same project, and implements start, note, associate, pause, resume, and complete transitions.
3. Build a deterministic resume read model from session notes, linked task lifecycle/events/verification, linked process status, and any validated PR URL already recorded on a linked task. Never call an LLM or expose task instructions, agent results, raw process commands, absolute paths, or event payloads.
4. Expose the session snapshot through Today and a same-origin, session-token-protected mutation API. Degrade only the session panel if its store is unavailable or invalid.
5. Add a reusable session panel to Today and project detail. Pause requires an explicit next action; completion requires a result and a next action or literal `none`. Add browser automation for start, associations, notes, pause/resume, completion, project detail visibility, and rejection of an implicit second active session.
6. Document local state, end-of-day use, safety boundaries, and verification. Run all applicable gates and create local commits only; do not push.

## Focus-time accounting decision

Retain the requested public session fields and add two persisted bookkeeping fields: `focused_ms` (completed active intervals) and `active_since` (start of the current active interval). On pause/completion, add only the current interval; on resume, begin a new interval. The read model adds the current interval to `focused_ms`. This supports repeated pauses and process restarts without collecting keystrokes, app activity, or interval-level telemetry.

## Exclusions

- No changes to Phase H or external repositories.
- No automatic task cancellation or process shutdown.
- No LLM-generated resume summaries.
- No push, merge, deploy, or staging of either user-owned prompt.
