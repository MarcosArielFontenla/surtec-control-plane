# SURTEC company and objectives

SURTEC is the only supported company profile. Its profile, objectives, and project-to-objective links are stored locally in `state/organization/organization.json`, a versioned, validated aggregate. A single cross-process lock and atomic replacement keep active-objective indexes and project relationships consistent. This is a single-user local operating model, not an org chart, CRM, or multi-tenant service.

The dashboard's `SURTEC` view can update the company display name, mission, operating principles, objective outcomes, criteria, status, horizon, priority, target date, and parent objective. The company id remains `surtec`; the objective owner is the fixed local owner `marcos`. Objective ancestry rejects missing parents, cycles, and depth beyond eight. Objectives are retained when paused, achieved, or cancelled; deletion is not exposed.

Project relationships are stored once in the organization aggregate. A project may support multiple objectives and may designate at most one of those as its primary objective. Objective `project_ids` are derived from this canonical project map. Project profiles retain their existing `client_id` independently from their category. A personal project remains first-class and is intentionally exempt from a strategic-objective requirement.

Objective health is a read model, not a completion score. It uses objective review/criteria/link completeness and existing project signal evidence. Active objective signals cover missing projects, missing success criteria, target dates within 14 days or overdue, and reviews at least 30 days old. Active non-personal projects with no objective and active projects linked to paused/cancelled objectives are visible. An achieved objective with unfinished work currently means an open GitHub inbox issue in one of its linked projects; local issue tracking is a later phase and is not simulated here.

`GET /api/organization` is local-only and `no-store`; writes use the existing loopback, same-origin, in-memory session-token protections. The UI never sends objective content to external services. All local state is plaintext and relies on host account/disk protections. Do not commit real mission, objective, client, repository, or issue data.

Validate the interface with `pnpm smoke:organization:playwright`; it uses an isolated Vite server, synthetic in-memory API fixtures, and no provider calls. Runtime objective rules are covered by deterministic engine tests; automated tests do not call a paid model.
