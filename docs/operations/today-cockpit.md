# Today decision cockpit

`GET /api/today` composes task orchestration activity with the deterministic portfolio signal feed. Existing task arrays and counters remain intact. The portfolio section includes up to three ordered recommendations, critical attention, work-to-continue signals, client commitments, personal opportunities, incomplete/stale project profiles, snoozed items, source warnings, and the signal-feed observation time.

Recommendation cards display only the project id and its `personal`/`client` category. They show severity, ranking tier/order, reason, suggested action, source-evidence timestamp, and feed observation time. No client id/name, private note text, provider payload, or deployment URL is placed in the card model.

Signal actions are local mutations through `POST /api/signals/:id/action` and retain the existing loopback, same-origin, and session-token protections. A card can acknowledge, pin for today, snooze for one hour, dismiss, or resolve a signal. Opening a repository invokes the existing protected local open action. Preparing a task only navigates to the existing task form and pre-fills project plus evidence-based instructions; dispatch still requires an explicit user submit and backend policy validation.

If the signal service fails as a whole, `/api/today` still returns task activity with a bounded generic warning. Provider-level warnings mark portfolio intelligence as partial while the app remains online. The signal-feed `observed_at` timestamp describes when the aggregation ran; every card separately shows its evidence timestamp so the user can judge evidence age. Provider warnings remain visible rather than being represented as a disconnected dashboard.

Work-session arrays are deliberately empty and marked unavailable until Phase G adds a persisted session source. Active Codex tasks continue to appear under `Continuar`; they are not presented as work sessions.

Run the browser fixture smoke with `pnpm smoke:today:playwright`. It serves the real Vite dashboard in a headless browser and supplies only fictional API fixtures for healthy, degraded, overloaded, and empty portfolios. It verifies the session-token action and the prefilled-task handoff without contacting providers or dispatching a task.
