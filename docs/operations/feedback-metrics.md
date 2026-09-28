# Local feedback metrics

The Feedback dashboard view and `GET /api/feedback/metrics` summarize local control-plane state on demand. The API is no-store and read-only. It returns counts and rates only; signal/task/session IDs, project names, prompts, paths, notes, and result text are not included. No analytics or external telemetry is sent.

Recommendation actions count only the first recorded action for a signal occurrence. `acknowledge` and `resolve` are classified as accepted; `snooze` and `dismiss` are separate outcomes; `pin-for-today` is reported as engagement, not acceptance. Evidence-to-action latency is measured from the signal's `evidence_at` timestamp to the first action timestamp, not from first screen display. The application does not persist first-display time. Existing signal-state records remain readable; their unobservable historical actions are not backfilled or inferred.

Task success and needs-review rates use finished tasks with a known outcome. Retry rate uses all stored tasks and counts records with more than one orchestration attempt. Verification pass rate compares only terminal tasks whose verification is explicitly passed or failed; skipped and missing results are shown separately and excluded from that denominator. Session completion rate uses all saved sessions. Next-action capture rate uses paused or completed sessions and counts a non-empty explicit `next_action` value, including an explicit value such as `none`.

Signal freshness uses valid evidence timestamps in the current signal feed. The fixed source windows are: CI 1 day; Git and notes 14 days; profile and commitment 30 days; GitHub, issue, deployment, task, and session 7 days. Invalid timestamps are excluded from the denominator, future timestamps are treated as fresh to tolerate clock skew, and the view shows both the stale count and eligible denominator.

Metrics are descriptive operational indicators, not a quality score or a proxy for customer value. Small sample sizes, legacy state without first-action timestamps, and varying task types can make rates noisy. Inspect the denominators before drawing conclusions.
