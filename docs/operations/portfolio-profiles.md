# Local portfolio profiles

`registry/projects.yml` remains the tracked source of technical configuration and execution policy: repository identity, allowed agents, sandbox limits, commands, verification, approval, and non-secret integration identifiers.

Operating context belongs in the local-only profile store at `state/portfolio/projects.json`. The repository's `/state/` ignore rule keeps this file out of Git, including client IDs, goals, next actions, deadlines, and review dates. The secret scan also rejects any tracked path under `state/portfolio/`, including a file force-added despite the ignore rule.

Each document and each profile uses `schema_version: 1`. Profiles are validated against `schemas/project-profile.schema.json`; the document is validated against `schemas/portfolio-profiles.schema.json`. Unknown fields and unsupported future document versions fail closed. They are not rewritten or automatically migrated; a future schema change must introduce an explicit migration path before writes are enabled.

The profile's `client_id` is an opaque local reference, not a client name or contact record. Phase C does not add a client directory or CRM. `fixtures/portfolio-profiles.example.json` is synthetic documentation/test data and must never be replaced with real client details.

The API and editor are intended for the single-user local dashboard. On filesystems that support POSIX modes, the store is created with owner-only directory/file permissions; Windows relies on inherited host ACLs. Local state is not encrypted by this application; protect it using the host account and disk protections. Back up `state/` only through a private local backup mechanism, never by committing it.
