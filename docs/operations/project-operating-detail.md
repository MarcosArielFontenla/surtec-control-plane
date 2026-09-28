# Project operating detail

Open `Overview`, choose a project's `Detalle` action, and use this page as the operational read model for that repository. Profile goals and next actions are held in the local portfolio profile store; notes remain local; active/recent tasks, signals, and activity come from their existing read models.

## Integrations and freshness

`GET /api/projects/:id/integrations` is the UI's primary provider read. Snapshot version 2 includes source control, GitHub PR/issue counts and bounded waiting-review evidence, CI, dependency health, and deployment providers. Optional provider failures are represented independently with configured state, provider identity, observation time, and a concise reason; they do not hide the profile, notes, task, signal, or activity sections.

The server caches aggregate snapshots for 60 seconds. The shared dependency cache retains its legacy five-minute TTL. Portfolio and signal aggregation request the snapshot without running `npm outdated`; the project-detail endpoint requests the detailed dependency observation so Today does not synchronously inspect every repository. The detail page's `Actualizar` action calls `GET /api/projects/:id/integrations?refresh=true`, invalidating both caches for that project before reading. The route uses `Cache-Control: no-store`; concurrent client requests for the same project/mode are deduplicated.

Legacy `/github`, `/deps`, `/deploy`, and `/railway` routes remain available for compatibility. The project cards no longer query them; they navigate to the consolidated detail view instead.

## Local context and safe actions

- `Abrir código` and `Carpeta` are explicit local open actions.
- `Preparar tarea` fills the existing task form with the profile's next action or goal. It does not dispatch a task.
- Profile edits and notes mutate only local control-plane state through the existing session-protected endpoints.
- Current and recent Codex tasks link to their task detail. Signals are grouped into open, snoozed, and resolved states; recent commits and task activity are scoped to this project.
- Persisted work sessions are not available until Phase G; the page states this instead of presenting tasks as sessions.

Keep `client_id` and client names out of read-only integration evidence, activity summaries, and external links. The existing local profile editor exposes an opaque client ID only when the user explicitly opens that editor. Do not render absolute repository paths, provider payloads, credentials, task instructions, or agent results. External links are limited to validated HTTP(S) deployment URLs and GitHub links derived from the configured repository identity and bounded identifiers.

Run `pnpm smoke:project-detail:playwright` for a real-browser smoke with fictional configured, unconfigured, and degraded project fixtures. It verifies refresh/freshness behavior, continued usefulness when providers fail, the single aggregate provider read, and task prefill without dispatching.
