# Phase S · Bind authorization actions to their source states

Status **T032 and T033 passed.**

## Finding and required behavior

The [T030–T031 EVAL](phase-s-issue-transition-eval.md) proves invalid state pairs fail closed. Code inspection found a gap among valid pairs. The issue service validates the state pair and revision, then records the audit event supplied by the caller. Each action below targets `authorized`. At the current revision a request can therefore use a different action to reach the same destination and record the wrong event.

| Service action | Existing HTTP route | Required source | Canonical v1 event |
| --- | --- | --- | --- |
| `authorize` | `POST /api/work-issues/:id/authorize` | `proposed` | `scope-authorization-recorded` |
| `resumeBlocked` | `POST /api/work-issues/:id/resume` | `blocked` | `blocker-resolved` |
| `resolveDecision` | `POST /api/work-issues/:id/resolve-decision` | `needs-decision` | `decision-recorded` |

Each of the six wrong action/source combinations must return the existing 409 `issue transition rejected: transition-not-allowed` with a valid payload at the current issue revision. Preserve the issue, revision, scope, candidates, evidence, audit history and linked task records. The correct action must still advance the issue once and record its canonical event with the existing payload.

## Implementation boundary

In the [issue service](../../dashboard/src/server/issue-service.ts), compare the requested audit type with the accepted rule's `event` for transitions into `authorized`. Use the existing [v1 guard](../../lib/organization/issue-lifecycle.ts) as the source of the event, inside the issue lock and after its current rejection checks. Reject a mismatch before changing issue status or appending the audit event. A stale revision still receives the existing stale-revision response. Other destinations keep their current audit handling.

In `resolveDecision`, keep the pending scope proposal check first and move the guarded transition ahead of candidate invalidation and review evidence in the same mutation. `approveScopeRevision` already emits `decision-recorded` from `needs-decision` through a separately bound proposal approval. Its focused regression must still pass. The change uses existing request shapes, lifecycle rules, state format, capabilities and timeouts. The historical audit remains as recorded.

## Tasks

| Task | Files | Acceptance |
| --- | --- | --- |
| T032 | `dashboard/src/server/issue-service.ts`, `dashboard/src/server/issue-service.test.ts`, `scripts/organizational-issue-transition.test.ts`, `evals/README.md` | Add the guard and extend the offline EVAL with one proposed-origin case covering both wrong actions. Compare issue bytes and state inventory around each rejection, then authorize at the original revision. Extend the existing blocked and same-scope decision service fixtures to cover the other four mismatches before the existing valid action. Compare the issue file and linked task snapshot, and check that authorization adds exactly the correct issue event. Preserve the decision candidate and evidence on denial and check the existing invalidation and evidence on success. Cover stale-revision precedence and the pending proposal guard using the existing fixtures. |
| T033 | `scripts/playwright-local-app-smoke.ts` | In the existing proposed-issue flow, send valid authenticated `/resume` and `/resolve-decision` requests at the current revision before authorizing in the UI. In the existing scope-proposal flow, send `/authorize` while the issue needs a decision before the explicit scope decision. Assert the exact 409 responses, unchanged persisted issue and execution effects, and the original UI state. Let the existing valid UI actions and reload assertions prove the normal flows. Verify the real API/browser run and owned cleanup using synthetic state and the injected executor. |

## Proposed validation order

Stop at the first failure or unknown result. Keep the existing timeouts and allow at most 900 seconds per command.

1. `pnpm exec vitest run scripts/organizational-issue-transition.test.ts lib/organization/issue-lifecycle.test.ts` must pass the expanded seven-case EVAL and all 14 lifecycle cases.
2. `pnpm exec vitest run dashboard/src/server/issue-service.test.ts -t 'requires explicit scope authorization and prevents duplicate issue task ownership|routes skipped or failed verification to an explicit same-scope decision|requires an explicit human resume after a blocked execution|records out-of-scope discovery without granting permission and increments scope only on approval'` must pass the four service regressions.
3. `pnpm evals:check` must pass v1, v2 and the organizational gate with 62 organizational tests expected.
4. `pnpm schemas:check` and then `pnpm typecheck` must exit 0.
5. `pnpm smoke:local:playwright` must pass with the real loopback API, Vite and Playwright, including the new denials and fixture cleanup. Capture statuses and cleanup results using synthetic state only.

## Acceptance checkpoint

- T032 passed 21 focused EVAL and lifecycle cases and four selected service regressions.
- The partial scaffold apply case passed outside the Windows sandbox with an owned temporary directory. Inside the sandbox its hard-link publication returned `EPERM`. The existing no-overwrite and ownership checks remain in force.
- `pnpm evals:check` passed v1 and v2 and all 62 organizational cases. `pnpm schemas:check` validated 65 schemas. `pnpm typecheck` passed after the diagnostic label wiring correction.
- The T033 smoke reached T013 after the HTTP refusals and their state comparisons. A budget read was pending for about 37 seconds when the existing 30-second read-drain deadline fired. Chromium, Vite and the API closed and the owned workspace was removed.
- The T013 diagnostic distinguishes panel drain from pre-preview effect capture. It retains per-request Chromium header arrival and aggregate Vite ingress, forwarding, upstream headers and upstream body completion. The aggregates do not correlate individual proxy requests with browser sequences. Eleven synthetic tests passed.
- The subsequent integrated `pnpm smoke:local:playwright` on `b2743cf` passed with Chromium and the real local API. It exercised all three HTTP refusals and the valid dashboard actions, reached all five workflow templates and verified restart behavior. The run recorded 35 synthetic executor turns, exit 0 and 648.193 seconds. Chromium, Vite, the API, the fixture and the launcher's temporary root completed cleanup. T033 is closed.
