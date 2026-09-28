# Local portfolio profiles

`registry/projects.yml` remains the tracked source of technical configuration and execution policy: repository identity, allowed agents, sandbox limits, commands, verification, approval, and non-secret integration identifiers.

Operating context belongs in the local-only profile store at `state/portfolio/projects.json`. The repository's `/state/` ignore rule keeps this file out of Git, including client IDs, goals, next actions, deadlines, and review dates. The secret scan also rejects any tracked path under `state/portfolio/`, including a file force-added despite the ignore rule.

Each document and each profile currently uses `schema_version: 2`. Profiles are validated against `schemas/project-profile.schema.json`; the document is validated against `schemas/portfolio-profiles.schema.json`. Unknown fields and unsupported future document versions fail closed.

Phase K adds the categories `personal`, `internal-tool`, `surtec-product`, `client-product`, `experiment`, and `template`. The locked v1-to-v2 migration is deterministic: `personal` remains `personal`, and legacy `client` becomes `client-product`. All other profile fields, including the opaque `client_id`, are preserved. A category change in the editor also keeps an existing client reference; it is not used for client commitments unless the category is `client-product`.

Before replacing a v1 profile document, the reader validates the complete source and target, computes source/target SHA-256 hashes and category counts, emits a content-free preflight/completion summary, writes and verifies a byte-for-byte backup under `state/backups/phase-k-portfolio-profiles/`, stages the target beside the source, validates the staged JSON, then atomically replaces the source while holding the portfolio lock. A malformed or future-version file is left untouched. Keep the backup until local validation is complete; backups remain ignored local state and must never be committed.

The profile's `client_id` is an opaque local reference. Phase H adds a delivery-only client directory and commitments in `state/portfolio/clients.json`; its project list is derived from profile references rather than stored as a competing association. It is not a sales CRM and does not manage contacts, deals, or billing. `fixtures/portfolio-profiles.example.json` is synthetic documentation/test data and must never be replaced with real client details.

Manage client delivery records in the dashboard's `Clientes` view. Associate a client with a repository from that project's `Perfil operativo → Cliente asociado` selector. Only discovered projects can be linked to commitments. Client names can be temporarily masked in compact rows; opening a record intentionally reveals the local detail fields.

Client context is never appended to a Codex task implicitly. The task form offers category-only availability and starts with every category unchecked. Select only the categories needed for that task; confidential notes require their own explicit selection. The created task records the chosen category names and opaque client ID, not chain-of-thought. Once selected, the actual chosen context is included in local task instructions and is subject to the same local-state protections as other task inputs.

Local state is plaintext and relies on operating-system account and disk protections. Keep real client data out of tracked files, issue fixtures, screenshots, and reports. The secret scanner protects tracked `state/portfolio/` paths, but it cannot identify every private detail accidentally copied into another tracked file.

The fictional UI workflow can be verified without real projects or client data with `pnpm smoke:client-commitments:playwright`; it starts a temporary Vite server, routes every API request to in-memory synthetic fixtures, and does not dispatch to Codex.

The API and editor are intended for the single-user local dashboard. On filesystems that support POSIX modes, the store is created with owner-only directory/file permissions; Windows relies on inherited host ACLs. Local state is not encrypted by this application; protect it using the host account and disk protections. Back up `state/` only through a private local backup mechanism, never by committing it.
