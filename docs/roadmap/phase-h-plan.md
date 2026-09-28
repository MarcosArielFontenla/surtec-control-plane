# Phase H — Client commitments plan

## Goal and baseline

Add a small local-only client directory and delivery commitment register. Surface dated commitments through the existing deterministic Signal Engine and Today cockpit, while keeping personal projects first-class and preventing confidential notes from entering Codex task prompts by default.

- Starting branch: `codex/phase-g-work-sessions`.
- Baseline HEAD: `77f6582` (`docs: record Phase G verification`).
- Working tree before this plan: clean except for the pre-existing, user-owned untracked prompts `SURTEC_CONTROL_PLANE_PORTFOLIO_INTELLIGENCE_PROMPT.md` and `SURTEC_CONTROL_PLANE_ORGANIZATION_HARNESS_ROADMAP_PROMPT.md`. Both remain excluded from commits.
- Marcos's request to proceed to Phase H is treated as acceptance of Phase G's local-validation stop.
- Runtime baseline: Node `v24.16.0`, pnpm `10.24.0`, package `0.1.0`.
- `pnpm ci:check`: passed before edits; 21 schemas, 948-file secret scan, EVAL 36/36 and expectations 42/42, 77 test files / 521 tests, typecheck, and Vite build (1,914 modules).
- `pnpm smoke:api`: passed before edits; Overview, Today, dispatch options, profiles, integrations, and signals returned HTTP 200; 21 projects discovered, 12 configured, zero local profiles, integration schema v2, and 3 signals.
- The previous phase could not reach `pnpm audit:check` due registry `EACCES`; Phase H adds no dependencies.

## Domain invariants

1. Client records and commitments are local plaintext under the existing ignored `/state/` boundary; no client information or real client fixtures are committed.
2. `ProjectProfile.client_id` remains the canonical project-to-client relationship for backward compatibility. Client `project_ids` are a validated read-model projection, not a second source of truth. Personal profiles continue to use `client_id: null`.
3. Client lifecycle is only active/paused. Commitment state is deterministic and bounded; no sales, billing, contact-management, or CRM workflow is introduced.
4. A commitment belongs to one discovered project and may reference a registered client only when the project's profile links to that client. Its title, outcome, deadline, priority, criticality, safe linked IDs, and next action are allowlisted and runtime validated.
5. Only non-completed/non-cancelled commitments with a due date within the fixed seven-calendar-day signal window produce a deadline signal. Overdue/imminent client commitments use the existing `client-commitment` ranking tier; personal work remains independent.
6. Today signals and compact portfolio cards never contain client display names, confidential notes, or unrestricted client records.
7. No client context is added to a task by default. A task request must explicitly select bounded context categories; the server resolves them from local state and stores only the selected category names, opaque client ID, and timestamp in task metadata. Confidential notes are one separately selected category. No chain-of-thought is recorded.
8. Invalid, corrupt, oversized, or future-version client state is never silently repaired or overwritten. Client writes and explicit context sharing fail closed. Signal read failures degrade only client evidence and leave other portfolio signals available.
9. Client and commitment mutations use local API protections, runtime schemas, bounded bodies, state locks, and atomic replacement. No external repository is changed.

## Failure modes to cover

- Invalid input/unsafe IDs/unsupported relationships: reject without writing.
- Future schema or corrupt/oversized state: return a bounded error, preserve bytes, and do not overwrite.
- Missing/disassociated client or unavailable selected category: reject explicit context share before task creation.
- Client-store read failure during signal generation: retain other signal categories and add a generic warning without exposing notes.
- Unselected confidential note: it must not appear in task instructions, events, Today payloads, or signal evidence.
- Personal project without a client: remains dispatchable and does not require a client record.

## Vertical slices

1. Add strict versioned client/commitment contracts and one bounded local document at `state/portfolio/clients.json`, reusing cross-process locking and atomic writes. Add isolated unit tests for validation, version safety, concurrency, and local privacy boundaries.
2. Add an application service and protected API for client creation/read/update/status and commitment creation/read/update/state. Derive each client's project IDs from validated project profiles; validate commitment projects, same-project task/session links, and safe issue/PR identifiers. Deletion is intentionally not exposed; clients can be paused and commitments can be completed/cancelled without severing audit references.
3. Extend signal evidence with local commitments and client status. Generate deterministic overdue/imminent/blocked commitment signals without client names or notes, validate the updated feed schema, and keep the current project-profile deadline behavior backward compatible.
4. Add a focused `Clientes` view for delivery-only client and commitment management. Support temporary masking of names in compact client rows; label notes local/confidential. Replace the profile's free-form client ID editor with a registry-backed choice while retaining any existing unresolved opaque reference for backward compatibility.
5. Add an explicit task-form context selector. Show available categories without returning confidential content; include chosen data server-side only after the user selects categories; audit categories (not contents or reasoning) with the created task. Test that no selection means no client data in the prompt.
6. Add fictional-fixture browser smoke coverage for managing a client and a commitment, masking, Today ranking, explicit context choice, and absence of automatic sharing. Update runbooks/roadmap and record final verification. Commit locally in coherent slices; do not push.

## Scope exclusions

- No external project edits, provider calls, networked/paid Codex calls, or real client data in fixtures.
- No multi-user access, CRM pipeline, invoicing, generic automation, or provider/runtime changes.
- No schema migration of existing ProjectProfile records; their current version and opaque client references remain readable.
- No changes to Phase I or to the separate Organization/Harness roadmap's Phase J+.

## Verification plan

Run repository consistency, schema validation, secret scan, EVALs, focused tests, full tests with the repository command, typecheck, build, API smoke, and browser smoke. Record audit/install environment limitations without forcing destructive dependency-directory replacement. Stop after Phase H for Marcos's local validation.
