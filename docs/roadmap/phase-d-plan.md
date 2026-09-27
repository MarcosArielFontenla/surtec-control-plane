# Phase D — Deterministic signal engine plan

## Baseline

- Date: 2026-09-27.
- Reviewed `HEAD`: `b461efa` (`feat: add local portfolio project profiles`), on `codex/phase-c-portfolio-profile` before creating `codex/phase-d-deterministic-signals`.
- Tracked working tree was clean. The user-owned, untracked `SURTEC_CONTROL_PLANE_PORTFOLIO_INTELLIGENCE_PROMPT.md` remains untouched and unstaged.
- Runtime: Node.js `v24.16.0`, pnpm `10.24.0`.
- Baseline `pnpm ci:check` passed: repository consistency, 13 schemas, secret scan (906 files), 36/36 EVAL coverage and 42/42 expectations, 69 test files / 493 tests, typecheck, and production build (1,912 modules).
- No implementation changes were present when the baseline ran.

## Scope and implementation slices

1. Define a strict versioned `Signal` and `SignalFeed` contract. Generate candidates using only bounded evidence already owned by the control plane; keep reasons human-readable and identifiers stable across refreshes.
2. Add transparent ranking tiers in the order production failure, overdue client commitment, blocked work, imminent deadline, unfinished work, maintenance, and hygiene. Include the tier and order in each signal instead of an opaque score.
3. Reuse the aggregate project integration reader and inbox cache. Extend integration evidence only with bounded PR review decisions and a CI run's start time, so the engine can identify PR action and long-running CI without copying provider payloads.
4. Isolate source failures into concise warnings. Keep source aggregation server-side with bounded integration concurrency and one feed request for consumers.
5. Persist acknowledge, snooze, pin-for-today, dismiss, and resolve state in a separate strict, locked, atomically replaced local file. Keep computed evidence out of this store.
6. Add protected read and action routes under the existing loopback, same-origin, session-token middleware. Reject unknown IDs, invalid bodies, and future schema versions without overwriting local state.
7. Validate engine rules and failure isolation with deterministic tests. Add a Chromium/Playwright smoke that uses synthetic evidence, verifies same-origin session protection, exercises actions through the real HTTP server, restarts the service, and checks persisted state.
8. Document local state and privacy boundaries. Do not add the Phase E Today cockpit, real client fixture data, remote writes, or real Codex calls.

## Evidence and explicit limitations

- Current production evidence supports deployment health, CI status/start time/run identity, local Git status, open PR review decisions, GitHub issue labels/updated time, task state/attempt, local profiles, and unresolved local notes.
- Paused-session signals are supported by the deterministic engine contract but the production evidence reader supplies no sessions yet; the session model belongs to Phase G. No session signal is fabricated in Phase D.
- Long-running CI is defined as a run observed running for at least 60 minutes. “Recent” issue activity is 7 days; stale activity is 7 days; stale profile review is 30 days; unresolved notes are considered when at least 14 days old; deadline approach is within 7 local calendar days.
- Dismissed occurrences are omitted from the feed. Expired snoozes project back to open without rewriting the human-state file. Pins use the machine's local calendar date and expire automatically the next day.

## Verification and delivery

- Run focused signal/store/API/integration tests, schema validation, repository checks, secret scanning, EVALs, full test suite, typecheck, and production build.
- Run `pnpm smoke:signals:playwright`; this creates only synthetic temporary state and does not contact configured GitHub, deployment, or Codex providers.
- Run `pnpm smoke:api` and `git diff --check`.
- Stop after Phase D for local validation; Phase E remains out of scope.
