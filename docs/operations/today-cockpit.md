# Today decision cockpit

`GET /api/today` composes task orchestration activity with the deterministic portfolio signal feed. Existing task arrays and counters remain intact. The portfolio section includes up to three ordered recommendations, critical attention, work-to-continue signals, client commitments, personal opportunities, incomplete/stale project profiles, objective relationship/health signals, snoozed items, source warnings, and the signal-feed observation time.

Recommendation cards display the project id and category, and include the primary objective title when an association exists. Company-level objective signals route to the SURTEC objective view instead of attempting to open a repository or prepare a project task. Cards show severity, ranking tier/order, reason, suggested action, source-evidence timestamp, and feed observation time. No client id/name, private note text, provider payload, or deployment URL is placed in the card model.

Client commitments enter the same deterministic ranking stream as other work. Client names and confidential notes are omitted from compact recommendations. Preparing a task from a client signal uses generic instructions; to attach delivery or service context, select the relevant categories explicitly in the task form. The confidential-notes category is separate and unchecked by default.

Signal actions are local mutations through `POST /api/signals/:id/action` and retain the existing loopback, same-origin, and session-token protections. A card can acknowledge, pin for today, snooze for one hour, dismiss, or resolve a signal. Opening a repository invokes the existing protected local open action. Preparing a task only navigates to the existing task form and pre-fills project plus evidence-based instructions; dispatch still requires an explicit user submit and backend policy validation.

If the signal service fails as a whole, `/api/today` still returns task activity with a bounded generic warning. Provider-level warnings mark portfolio intelligence as partial while the app remains online. The signal-feed `observed_at` timestamp describes when the aggregation ran; every card separately shows its evidence timestamp so the user can judge evidence age. Provider warnings remain visible rather than being represented as a disconnected dashboard.

The session panel is backed by the validated local store. Start a focused session from any discovered project, add notes and same-project task/process links, pause with an explicit next action, resume later, or complete with a result and a next action (or literal `none`). One active session is allowed at a time. Session controls never stop processes or cancel Codex tasks. The panel degrades independently if local session state is unreadable.

Run the browser fixture smoke with `pnpm smoke:today:playwright`. It serves the real Vite dashboard in a headless browser and supplies only fictional API fixtures for healthy, degraded, overloaded, and empty portfolios. It verifies the session-token action and the prefilled-task handoff without contacting providers or dispatching a task. `pnpm smoke:work-sessions:playwright` covers the separate session workflow.

`pnpm smoke:client-commitments:playwright` also verifies the client commitment flow, synthetic Today ranking presentation, generic task prefill, and explicit-only context selector without real project API calls or Codex dispatch.

`pnpm smoke:organization:playwright` exercises the local company profile and healthy, missing, stale, paused, and achieved objective states using only synthetic browser fixtures. It does not write repository state or dispatch tasks.
