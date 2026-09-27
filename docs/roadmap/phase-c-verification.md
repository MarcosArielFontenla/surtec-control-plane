# Phase C — Portfolio operating profile and privacy boundary verification

## Summary

Phase C adds a versioned local `ProjectProfile` contract and an ignored portfolio store separate from technical registry policy. The dashboard can view and edit personal/client classification, lifecycle, priority, criticality, goal, next action, deadline, client reference, review date, and tags. Invalid or future-version state fails closed; saves are locked and atomically replaced. The editor labels the data as local-only and existing projects remain usable without profiles.

No sibling project repositories were modified. No profile was saved during the browser smoke. Nothing was pushed, merged, or deployed. Phase D and later remain out of scope; this phase stops for local validation.

## Files modified

- `.gitignore`
- `dashboard/src/server/index.ts`
- `dashboard/src/server/index.test.ts`
- `dashboard/src/ui/App.tsx`
- `dashboard/src/ui/api.ts`
- `dashboard/src/ui/components/ProjectCard.tsx`
- `dashboard/src/ui/components/ProjectProfileEditor.tsx`
- `dashboard/src/ui/components/ProjectProfileEditor.test.tsx`
- `dashboard/src/ui/styles/dashboard.css`
- `docs/operations/portfolio-profiles.md`
- `docs/roadmap/phase-c-plan.md`
- `docs/security/threat-model.md`
- `fixtures/portfolio-profiles.example.json`
- `lib/portfolio-profile.ts`
- `lib/state/paths.ts`
- `lib/state/paths.test.ts`
- `lib/state/portfolio-profiles.ts`
- `lib/state/portfolio-profiles.test.ts`
- `lib/state/validation.ts`
- `schemas/portfolio-profiles.schema.json`
- `schemas/project-profile.schema.json`
- `scripts/api-smoke.ts`
- `scripts/check-schemas.mjs`
- `scripts/check-secrets.mjs`

The user-owned, untracked `SURTEC_CONTROL_PLANE_PORTFOLIO_INTELLIGENCE_PROMPT.md` was preserved and not staged.

## Implementation details

- `registry/projects.yml` remains technical configuration. Operational context is stored only at `state/portfolio/projects.json`, under the existing `/state/` Git ignore boundary.
- The profile and document schemas reject unknown fields, unsafe IDs, invalid enums/ranges, impossible dates, duplicate tags, and inconsistent personal/client references. The current schema version is 1; a future version returns a conflict and is never migrated or overwritten automatically.
- A cross-process state lock serializes updates. Writes use a unique same-directory temporary file and atomic rename. POSIX mode `0700`/`0600` is requested where supported; Windows relies on inherited ACLs.
- Profile reads and mutations are loopback-only through the existing API middleware; mutations require the in-memory session token. Profile responses use `Cache-Control: no-store`.
- The secret scanner runs a privacy-boundary self-test and flags every tracked path under `state/portfolio/`, including force-added ignored files. A synthetic fixture is the only committed profile example; it contains no actual client data.
- The editor is visually separated from Git-backed configuration, accessible by labels and keyboard, and disables editing if the existing store cannot be read.

## Commands and results

- Baseline `pnpm ci:check` before implementation: passed (11 schemas, 67 test files / 478 tests, typecheck, build).
- Focused checks: 4 test files / 70 tests passed; schemas passed; `node scripts/check-secrets.mjs --self-test` passed; typecheck passed.
- Final `pnpm ci:check`: passed. Repository consistency passed; 13 schemas validated; secret scanner self-test and 905-file scan passed; EVAL coverage 36/36 and expectations 42/42 passed; 69 test files / 493 tests passed; typecheck passed; production build transformed 1,912 modules.
- Final `pnpm smoke:api`: passed. Overview, today, dispatch options, profile list, and integrations returned HTTP 200; 21 projects discovered, 12 configured, and the empty local profile list was valid.
- `git check-ignore -v state/portfolio/projects.json`: passed; `.gitignore:16` ignores the local profile store.
- `git diff --check`: passed.
- `pnpm audit:check`: unverified. npm registry audit requests failed with `EACCES` after retry; this is a network-policy failure, not a vulnerability result.
- `pnpm install --frozen-lockfile`: not run because no dependencies or lockfiles changed.

## Browser smoke

After confirming ports 4317 and 5173 were free, started `pnpm dev` and opened `http://localhost:5173/`. The dashboard loaded 21 repositories. In Overview, the profile section was visually distinct and labeled local-only; the editor exposed all fields applicable to the default personal classification. The component test confirms that the opaque client-reference field appears for a client profile. No profile was submitted. The temporary tab and the server started for this smoke were closed afterward.

The API startup logged the existing Git `dubious ownership` warnings for sibling repositories because this sandbox runs as `CodexSandboxOffline` while those repositories are owned by `tecno.pc`. No global `safe.directory` entries were added. The browser UI itself loaded and the profile API was healthy.

## Security impact

- No client names, contacts, or commercial notes were added to tracked configuration or committed fixtures. The app stores an opaque `client_id`; Phase C does not implement a client directory or CRM.
- The scanner blocks tracked local portfolio-state paths, while Git ignores the whole state tree. This is defense-in-depth, not content classification for client details accidentally written to arbitrary tracked files.
- Local state is not encrypted by the application. Protect it with the host account and disk protections, particularly before entering real client details.
- No credentials were added to files, state, logs, screenshots, or fixtures.

## Risks and deferred work

- `pnpm audit:check` could not reach npm, so dependency advisory status is unknown.
- This sandbox's identity mismatch still prevents reliable Git inspection in sibling repositories and can emit startup warnings. Do not add broad/global Git trust exceptions for this phase.
- The local profile store is not encrypted and currently has no dedicated UI for deleting a profile or managing client records. Client directory support remains for Phase H.
- Real Codex runtime smokes remain opt-in and were not run.

## Manual local validation

From PowerShell under the normal Windows account:

```powershell
git switch codex/phase-c-portfolio-profile
pnpm ci:check
pnpm smoke:api
pnpm dev
```

Open `http://localhost:5173/`, select `Overview`, open a project's `Completar perfil` editor, and inspect the local-only notice and fields. If validating persistence manually, use clearly fictional values, save once, reopen the page, and confirm the summary reappears. Confirm `state/portfolio/projects.json` is ignored by Git. Keep real client context out of tracked files; the application does not encrypt local state. Stop the server with Ctrl+C after validation.

## Local commits

- `2a30384 docs: plan phase C portfolio profile`
- The implementation and this verification record are committed together after final verification; the commit hash is reported in the phase delivery message.
