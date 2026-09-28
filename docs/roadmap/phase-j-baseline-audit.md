# Phase J.1 — Phases A–I acceptance audit

Date: 2026-09-28

## Baseline

- Branch: `codex/phase-g-work-sessions`.
- Starting HEAD: `2be86414fce18af2fa7401691eb05e599a704917`.
- Node.js: `v24.16.0`; pnpm: `10.24.0`; Codex CLI: `0.145.0`.
- The two user-owned roadmap prompts were untracked before work and remain untracked; neither is included in this audit commit.
- CI's documented default branch and push filter both resolve to `master`.

## Traceability matrix

| Phase | Expected capability | Implementation evidence | Test evidence | Manual validation evidence | Status | Gap |
| --- | --- | --- | --- | --- | --- | --- |
| A | Default-branch CI and repository drift check; real read-only and disposable-write Codex paths | `.github/workflows/ci.yml`; `scripts/check-repository-consistency.ts`; `scripts/codex-smoke.ts`; `scripts/codex-write-smoke.ts` | `pnpm ci:check` passed. Real read-only smoke completed with a valid report and unchanged fixture. The disposable-write smoke returned `blocked` twice before changing its fixture. | Read-only GitHub GETs observed `master`, public visibility, the old Paperclip-adapter description, and no branch protection. No GitHub settings were changed. The historical Phase A GitHub checklist remains open. | **Blocked** | The write path has no successful real-runtime validation in this environment. Codex's Windows sandbox helper failed (`CreateProcessWithLogonW`, error 2); the fallback permission request was declined. Do not bypass the sandbox. Decide separately whether to change visibility/description/protection. |
| B | Credential-separated subprocesses, managed Git without repository hooks, policy-aware dispatch UI | `lib/security/environment.ts`; `lib/security/managed-git.mjs`; `dashboard/src/server/dispatch.ts`; `dashboard/src/ui/components/NewTaskForm.tsx` | Full suite passed (553 tests), including subprocess environment, managed Git, dispatch policy, and form tests. API smoke returned dispatch options HTTP 200. | Phase B's prior browser inspection used the sandbox account and did not dispatch a task. This run exercised API and synthetic browser flows, not a real dispatch. | Automated pass | A native-account dispatch-form inspection remains unrecorded; no task was dispatched. |
| C | Runtime-validated versioned `ProjectProfile`, separate from technical registry, local-only state | `schemas/project-profile.schema.json`; `lib/portfolio-profile.ts`; `lib/state/portfolio-profiles.ts`; portfolio profile API/UI | Full suite passed; schema gate passed (29 schemas); API smoke returned profiles HTTP 200. | Phase C's prior UI inspection used the sandbox account and saved no profile. Current API smoke found zero persisted profiles. | Automated pass | Actual local-profile persistence in Marcos's normal account was not rechecked. |
| D | Deterministic signals and persisted human signal state | `lib/signals/engine.ts`; `lib/state/signals.ts`; signal API/UI | Full suite passed; `pnpm smoke:signals:playwright` passed same-origin reads, protected mutations, and restart persistence. | Current Playwright run used synthetic state and verified the browser/API interaction. | Verified by automation | Real portfolio signal relevance/preferences remain outside synthetic fixtures. |
| E | Today portfolio decision cockpit with explainable rankings | Today portfolio service and view; `scripts/playwright-today-smoke.ts` | Full suite passed; `pnpm smoke:today:playwright` passed healthy, degraded, overloaded, empty, and protected-action fixtures. | Current browser smoke used route-intercepted synthetic fixtures; it did not validate visual preferences against Marcos's local portfolio. | Verified by automation | Native-account visual/product review remains unrecorded. |
| F | Project detail backed by aggregate integration snapshot | `dashboard/src/server/project-integrations.ts`; project detail API/view | Full suite passed; `pnpm smoke:project-detail:playwright` passed configured, unconfigured, degraded, refresh, and safe-prefill paths. | Roadmap records Phase F as complete after local validation. Current smoke used synthetic browser data. | Verified; historical local acceptance recorded | No new gap beyond the normal-account review limitation noted for I. |
| G | Durable, resumable Work Sessions | `lib/state/work-sessions.ts`; `dashboard/src/server/work-session-service.ts`; Work Sessions UI | Full suite passed; `pnpm smoke:work-sessions:playwright` passed start, notes, links, pause/reload/resume/completion, protected writes, and process-safety checks. | Roadmap records acceptance when Marcos authorized Phase H. Current browser test used synthetic state. | Verified by automation and prior progression acceptance | Real local session history was not exercised. |
| H | Local client commitments without CRM behavior; client context explicit-only | `lib/client-portfolio.ts`; `lib/state/client-portfolio.ts`; `dashboard/src/server/client-portfolio-service.ts`; client UI | Full suite passed; `pnpm smoke:client-commitments:playwright` passed synthetic client/commitment, masking, explicit-context, and protected-write flows. | Roadmap records acceptance when Marcos authorized Phase I. Current API smoke found zero persisted client/commitment records; browser data was synthetic. | Verified by automation and prior progression acceptance | No real client data was accessed or needed; normal-account visual review remains unrecorded. |
| I | Mandatory deterministic EVALs, golden outcomes, opt-in canaries, local feedback metrics | `lib/evals/`; `lib/feedback-metrics.ts`; feedback API/UI | EVAL v1: 36/36 coverage and 42/42 expectations; outcome golden v2: 8/8. `pnpm smoke:feedback:playwright` and API smoke passed. Live canaries remained disabled and were not called. | `docs/roadmap/phase-i-verification.md` explicitly leaves the consolidated native-account review outstanding. | Automated pass; product acceptance pending | Synthetic tests do not validate Marcos's actual account, local portfolio, or visual preferences. |

## Revalidation results

- `pnpm install --frozen-lockfile`: passed with `CI=true`; lockfile resolution was unchanged and 215 packages were available. The initial non-TTY attempt aborted; the ordinary sandbox then denied tarball downloads, so the same frozen install was completed with network access. pnpm reported the existing ignored `esbuild` build-script policy.
- `pnpm ci:check`: passed on rerun. Repository consistency passed; 29 schemas validated; secret scan passed across 994 files; EVAL v1 coverage 36/36 and expectations 42/42; outcome suite 8/8; 84 test files and 553 tests passed; typecheck passed; Vite transformed 1,916 modules.
- The first aggregate test run had one 5-second timeout in `project-integrations.test.ts`; the isolated test passed, and the full suite passed on rerun.
- `pnpm audit:check`: passed; no known vulnerabilities.
- `pnpm smoke:api`: passed. All exercised endpoints returned HTTP 200; 21 projects discovered, 12 configured, zero portfolio profiles/clients/commitments, integration schema v2, three signals, and feedback schema v1.
- Playwright passed sequentially: Signals, Today, Project Detail, Work Sessions, Client Commitments, and Feedback Metrics.
- Real read-only Codex smoke: passed with temporary model override `gpt-5.6-sol`; completed structured report, usage 16,211 tokens, fixture unchanged. The installed/default `gpt-6-sol` was rejected by Codex CLI 0.145.0 for this ChatGPT account. No cancellation smoke was requested.
- Real disposable-write Codex smoke: blocked on two attempts using the same temporary model override. The structured report states that the Windows sandbox helper failed with `CreateProcessWithLogonW` error 2 and the fallback permission request was declined. The script's `finally` cleanup completed; no push or external repository write occurred. Failed reports did not return usage to the smoke output, so their quota consumption is unknown.
- `codex doctor` identified this process as running under `CodexSandboxOffline`, with restricted filesystem/network and unreachable provider endpoints. No sandbox or approval boundary was weakened.
- `git diff --check`: passed for the smoke-script fixes.

## Gate decision

**Do not proceed to J.2–J.5 yet.** The highest-priority acceptance gap is the absence of a successful real disposable-write Codex run. The safe next step is to rerun `pnpm smoke:codex:write` from Marcos's normal Windows Codex environment with a supported model and working sandbox helper, or explicitly revise the roadmap to defer that prerequisite. Do not solve it by disabling the sandbox or accepting full filesystem access.

The read-only GitHub review also found unresolved Phase A settings: the repository is public, its description still advertises a Paperclip adapter, and `master` has no branch protection. This audit did not change GitHub. Visibility requires Marcos's decision; description and protection changes require separate explicit authorization.

The automated browser checks provide strong fixture-based evidence, but `docs/roadmap/phase-i-verification.md` still records that the consolidated normal-account product review is outstanding. If Marcos considers the automated review sufficient, record that acceptance explicitly; otherwise complete the normal-account visual/local-state pass.

No organization ADR, migration contract, domain transition table, or product behavior was changed in this partial J.1 audit.
