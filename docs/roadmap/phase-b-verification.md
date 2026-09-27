# Phase B — Credential boundary and policy-aware dispatch UX verification

## Summary

Phase B separates child-process environments by purpose, disables repository-controlled Git hooks during managed Git operations, and makes dispatch capabilities a server-owned policy read model. The task form now uses the server's safest valid default, marks unavailable modes disabled, explains their policy reason, and blocks submission when no allowed mode is selected. Backend authorization remains authoritative and fail-closed.

No external project repository was modified. No remote was changed, and nothing was pushed, merged, or deployed. No real Codex smoke or model call was run. Phase C and later remain out of scope; this phase stops for local validation.

## Files modified

- `dashboard/src/server/activity-read.ts`
- `dashboard/src/server/git-branch.ts`
- `dashboard/src/server/git-branch.test.ts`
- `dashboard/src/server/git-sync.ts`
- `dashboard/src/server/git-sync.test.ts`
- `dashboard/src/server/github-inbox.ts`
- `dashboard/src/server/github-read.ts`
- `dashboard/src/server/index.ts`
- `dashboard/src/server/index.test.ts`
- `dashboard/src/server/open-project.ts`
- `dashboard/src/ui/api.ts`
- `dashboard/src/ui/components/NewTaskForm.tsx`
- `dashboard/src/ui/components/NewTaskForm.test.tsx`
- `docs/roadmap/phase-b-plan.md`
- `docs/runbooks/local-development.md`
- `lib/git-status.ts`
- `lib/policy/service.ts`
- `lib/policy/service.test.ts`
- `lib/security/environment.ts`
- `lib/security/managed-git.d.mts`
- `lib/security/managed-git.mjs`
- `lib/security/process-environments.d.mts`
- `lib/security/process-environments.mjs`
- `lib/security/security.test.ts`
- `runner/codex-executor.ts`
- `runner/codex-executor.test.ts`
- `runner/github.ts`
- `runner/github.test.ts`
- `runner/process-manager.ts`
- `runner/worktree.ts`
- `runner/worktree.test.ts`
- `scripts/check-secrets.mjs`
- `scripts/codex-write-smoke.ts`
- `scripts/generate-codex-protocol.mjs`

The pre-existing, user-owned untracked `SURTEC_CONTROL_PLANE_PORTFOLIO_INTELLIGENCE_PROMPT.md` was preserved and not staged.

## Implementation details

- `localGitEnvironment` contains core OS variables only. `githubCliEnvironment` adds GitHub CLI auth/config variables. `gitNetworkEnvironment` adds the operator's configured global Git config path and SSH-agent socket, disables terminal prompting, and does not pass raw service tokens. Project commands, verification, Codex App Server, OS process control, and open actions each use their own explicit environment policy.
- All managed Git calls use a fixed `core.hooksPath` pointing to the empty `state/security/managed-git-hooks-empty` directory under the Control Plane. The helper rejects redirected, non-directory, or non-empty paths. Local inspection and network Git use their separate environment policies.
- The secret scanner's ownership exception is a `safe.directory` command-line setting for only the exact scanned root. It is not persisted and does not trust sibling repositories.
- `PolicyService.dispatchOptions()` reports project/agent ceilings, contained checkout and verification availability, allowed modes, default mode, and reasons for disabled modes. It shares the same denial checks as `authorizeDispatch`; React only renders the returned capabilities.
- Tests cover credential filtering at subprocess boundaries, intended GitHub CLI auth, Git hook suppression for worktree creation and commit, redaction of captured diff output, policy combinations, and form behavior when write/self-verify/checkout are unavailable.

## Commands and results

- Focused tests via `pnpm test -- lib/security/security.test.ts runner/codex-executor.test.ts runner/github.test.ts runner/worktree.test.ts lib/policy/service.test.ts dashboard/src/server/index.test.ts dashboard/src/server/git-branch.test.ts dashboard/src/server/git-sync.test.ts dashboard/src/ui/components/NewTaskForm.test.tsx`: passed, 9 files / 110 tests.
- Final `pnpm ci:check`: passed. Repository consistency passed; 11 schemas validated; secret scan passed (894 files); EVAL coverage 36/36 and expectations 42/42; 67 test files / 478 tests passed; typecheck passed; build transformed 1,910 modules.
- `pnpm smoke:api`: passed. Overview, today, dispatch options, and integrations returned HTTP 200; 21 projects discovered and 12 configured; integration schema version 1.
- `git diff --check`: passed.
- `pnpm audit:check`: blocked by network policy (`EACCES` posting to `https://registry.npmjs.org/-/npm/v1/security/audits`). This is not a vulnerability result; the dependency audit remains unverified.
- `pnpm install --frozen-lockfile`: not run because this phase changed neither dependencies nor lockfiles.

## Browser smoke

After confirming ports 4317 and 5173 were free, started `pnpm dev` and opened `http://localhost:5173/` in the in-app browser. The dashboard loaded with 21 repositories and the API connected. On the task form, `read-only` was selected by default; for the selected read-only project, both write modes were disabled and the UI displayed the server-provided project-policy reason. No task was submitted. The browser tab and the server started for this smoke were closed afterward, and both ports were confirmed free.

## Security impact

- Local Git no longer inherits GitHub, OpenAI, Railway, package-registry, or unrelated secrets. `gh` receives only its explicit GitHub CLI environment. Network Git relies on the operator's configured credential helper or SSH agent rather than raw tokens.
- Managed Git commands cannot use repository-controlled hooks; the hook fixture tests passed on this Windows environment. Git and agent output remains redacted.
- Dispatch capability display is advisory only; `PolicyService` still rejects missing checkouts, disallowed agents, sandbox-ceiling violations, and self-verify without verification commands.
- No credentials were written to repository files, task state, logs, or smoke fixtures.

## Risks and deferred work

- `pnpm audit:check` could not contact npm, so advisory status is unknown.
- This Codex sandbox runs as `CodexSandboxOffline` while sibling repositories are owned by `tecno.pc`. The API server therefore logged Git's existing `dubious ownership` warnings for sibling checkouts during the browser smoke. No global `safe.directory` entries were added; validate Git status again under the normal local account.
- The browser's selected registry project has a read-only ceiling, so live UI inspection showed write/verify disabled for that reason. Separate UI tests cover the case where write is permitted but no verification commands exist.
- Real Codex runtime smokes remain opt-in and unverified in this phase.

## Manual local validation

From PowerShell under the normal Windows account:

```powershell
git switch codex/phase-b-credential-policy
pnpm ci:check
pnpm smoke:api
pnpm dev
```

Open `http://localhost:5173/`, select `Overview`, and inspect the Nueva tarea form. Confirm the initial mode is `Analizar (read-only)`, restricted modes are disabled with a reason, and projects without a contained checkout cannot be dispatched. Do not press `Despachar` unless intentionally starting a real task. Stop the server with Ctrl+C after validation. Review network Git behavior only with an explicitly chosen fetch, pull, or push operation.

## Local commits

- `407987e docs: plan phase B credential policy`
- The implementation and this verification record are committed together after final verification; its hash is reported in the phase delivery message.

## Recommended next phase

Validate Phase B locally and report any UI or Git credential-helper differences under the normal Windows account. Begin Phase C only after that validation.
