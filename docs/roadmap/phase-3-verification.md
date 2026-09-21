# Phase 3 — Daily operations and observability verification

## Delivery summary

Phase 3 adds a deterministic Today view and an evidence-backed task detail view. The implementation persists previously missing operational facts at their source, projects them through read-only API models, and presents them in the dashboard without parsing free-form logs.

The phase also introduces a dependency-injected tracing boundary. The default remains a no-op, so tracing is optional and adds no runtime package or remote service requirement.

## Implemented evidence

- Dispatch, execution, and review policy decisions.
- Runtime approvals without command text, prompts, or reasoning content.
- Worktree creation, commit metadata, bounded diff artifacts, and verification outcomes.
- Review checkpoints and cleanup outcomes.
- Usage, retry, cancellation, lease recovery, and complete lifecycle events.
- Optional trace and span identifiers when a tracer is injected.
- Explicit cleanup states: `not-applicable`, `retained`, `completed`, `failed`, or `unknown`.

## Read models and API

- `GET /api/today` returns active work and unresolved attention regardless of age, plus outcomes and operational events for the configured local date.
- `SURTEC_TIME_ZONE` controls the IANA time zone and defaults to `America/Buenos_Aires`.
- `GET /api/tasks/:id/detail` consolidates the task record, ordered events, execution metadata, bounded diff, policy, approvals, usage, retries, review history, and cleanup state.
- Missing optional evidence degrades to an explicit status instead of being inferred.

## Dashboard

- `Hoy` is the default navigation destination.
- Today shows daily counters, active work, pending decisions, completed/failed/cancelled outcomes, retries, cancellations, and lease recoveries.
- Task references in Today and Overview open the complete evidence view.
- Task detail shows lifecycle, duration, attempts, token budget, result, execution metadata, trace identifiers, diff, commands, declared tests, verification output, policy decisions, approvals, usage, retries, review, cleanup, risks, blockers, next steps, and the complete event timeline.

## Automated verification

Baseline before Phase 3:

```text
npm run test -- --run
57 test files passed
429 tests passed

npm run typecheck
passed

npm run schemas:check
Validated 8 JSON Schemas.
```

Final gates:

```text
npm run test -- --run
61 test files passed
440 tests passed

npm run typecheck
passed

npm run build
1910 modules transformed
dist/index.html                  0.42 kB | gzip 0.28 kB
dist/assets/index-DMGXPO77.css 30.44 kB | gzip 6.55 kB
dist/assets/index-j7oHpGIN.js 207.73 kB | gzip 62.15 kB

npm run schemas:check
Validated 8 JSON Schemas.

npm run secrets:check
Secret scan passed (843 repository files checked).

npm run smoke:api
overview_status: 200
today_status: 200
today_date: 2026-09-21
discovered_projects: 20
dispatch_options_status: 200
configured_projects: 12
```

Focused coverage also verified:

- UTC-to-`America/Buenos_Aires` day-boundary classification.
- Active and unresolved-attention carryover across days.
- Bounded diff reads and rejection of paths outside `reports/`.
- Optional no-op and injected tracing.
- Policy, approval, review, cleanup, usage, retry, and lifecycle projection.
- Today and task-detail rendering.

## Browser smoke

The production build was served on loopback-only temporary ports.

Verified with browser automation:

1. The real empty-state Today view loaded with the configured date and time zone.
2. Today → Overview navigation preserved the existing portfolio dashboard.
3. An isolated finished-task fixture appeared in Today with completed, attention, and retry evidence.
4. Opening the fixture showed result, execution metadata, trace identifiers, diff, commands, verification, policy, approval, usage, retry, cleanup, risks, next steps, and ordered lifecycle events.
5. The layout remained readable at the browser's compact viewport.

The isolated fixture and its diff artifact were removed after validation. Both temporary servers were terminated. An already-running process on port `4317` was detected and left untouched.

## Security impact

- Diff artifact reads are contained under `reports/`, restricted to `.diff`, and capped at 200,000 bytes.
- Generated diff artifacts are ignored by Git and pass through the existing redaction boundary before persistence.
- Runtime approval evidence records category and decision but deliberately omits command text.
- Event payloads still use schema validation and redacted JSON serialization.
- Today and task-detail endpoints are read-only; mutation session protection is unchanged.
- No telemetry package, collector, network export, credential, prompt, message delta, or chain-of-thought persistence was added.

## Known risks and deferred work

- Task records and append-only events are separate files; a process failure between the two writes can leave partial observability evidence. A storage migration remains deferred until stronger transaction requirements justify it.
- Diff artifacts contain local source changes in plaintext. They are bounded and ignored, but retention is still manual.
- Cleanup `retained` is based on durable task evidence, not a continuous live filesystem probe, so out-of-band worktree removal can temporarily drift from the displayed state.
- The tracing interface has no exporter or backend by design.
- Startup reconciliation reported sandbox-only Git `dubious ownership` warnings for sibling repositories during browser smoke. No global Git configuration was changed; this did not affect the control-plane views or APIs.
- A real paid Codex runtime smoke was not run because Phase 3 did not authorize paid model calls.

## Manual local validation

```text
npm run build
npm run start
```

Then open `http://127.0.0.1:4317` and verify:

1. `Hoy` is selected by default.
2. Active and pending-decision tasks remain visible even when created before today.
3. Today's outcomes and retry/cancellation/recovery activity match task records and events.
4. Selecting a task opens the complete evidence view.
5. A write task with a commit shows a bounded diff and verification checks.
6. `Volver` returns to the originating dashboard view.

## Local commits

- `b80fa6e` — `docs: define phase 3 observability plan`
- `3725ff4` — `feat: persist task observability evidence`
- `7f6be92` — `feat: add daily and task detail read models`
- `ff7c3fa` — `feat: add Today and task evidence views`

The verification documentation and smoke extension are committed separately at phase close.

## Recommended next phase

Proceed to Phase 4 with versioned, fixture-based evaluations for each task type and role. Security and policy violations should remain hard failures independent of aggregate quality scores.
