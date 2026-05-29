# Surtec Control Plane — Self-Verify (runner-run verification) (v1) — Design

- **Date:** 2026-05-29
- **Status:** Approved design (pre-implementation)
- **Slice:** Self-verify (sixth control-plane slice; extends workspace-write + review-gate)
- **Builds on:** `docs/superpowers/specs/2026-05-29-workspace-write-design.md`, `2026-05-29-review-gate-design.md`

## 1. Context & Goal

Workspace-write tasks finish as a committed branch in an isolated worktree; a human then
approves (push + PR) or rejects from the dashboard. Today that decision is made without any
machine signal that the agent's edits actually build or pass tests. This slice has **the runner run
the project's declared verification commands** (e.g. install + tests, optionally typecheck/build) in
the worktree after committing, capture the **real exit code (ground truth)**, and record it on the
task result so the reviewer sees verified work before approving.

The runner performs the verification — the agent never runs shell. This preserves the project's
defense-in-depth invariant ("the agent never executes commands; the runner performs all side effects":
git in `worktree.ts`, gh in `github.ts`, and now verification in `verify.ts`).

## 2. Key Decisions

- **The runner runs verification, not the agent.** The agent's toolset is unchanged (no Bash, ever).
  Verification is the fourth runner-side side effect, parallel to `worktree.ts` / `github.ts`.
- **Ground truth, not self-report.** `spawnSync` exit codes are authoritative; the agent cannot claim
  green.
- **The "allowlist" is the registry's declared commands** (`registry/projects.yml`), which is
  human-authored config — never the agent's or the task envelope's input. The agent cannot influence
  which commands run.
- **Commit before verify.** The commit captures only the agent's source edits; verification artifacts
  (`node_modules`, build output) are produced afterward and never committed (they are discarded when
  the worktree is removed on reject, and are not part of the pushed branch on approve).
- **Fail-fast.** Run the configured commands in order; on the first failure, mark the report `failed`
  and stop (later checks would cascade-fail).
- **Verification never crashes the run.** A verify failure is recorded; the task still finishes and is
  available for human review. v1 does **not** block approve on a failed verification — the human
  decides with the badge visible.
- **Read-only tasks are not verified** (no branch, nothing to build/test).

## 3. Scope

**In scope (v1):**

- `lib/state/types.ts` — `VerificationCheck`, `VerificationReport`; `AgentResult.verification?`;
  `AttentionItem.verification?`.
- `runner/verify.ts` — `runVerification(worktreePath, commands)` (spawnSync; fail-fast; no throw).
- `runner/registry-project.ts` — `loadProjectVerifyCommands(repoRoot, projectId)` (resolves the
  per-project verify command list from the registry).
- `runner/result.ts` — `toAgentResult` accepts and attaches the `verification` report;
  `failureResult` sets it `null`.
- `runner/run-task.ts` — after `commitAndDiff`, when `committed`, run verification in the worktree and
  attach the report. Read-only: unchanged (no verification).
- `lib/state/derive.ts` — populate `AttentionItem.verification` for the finished-task item.
- `dashboard/src/ui/components/AttentionPanel.tsx` — render a verification badge on task items.
- `README.md` — document self-verify.

**Out of scope (future):** an agent auto-fix loop (agent runs tests, fixes failures, re-runs); blocking
approve on a failed verification; verifying read-only tasks; a task-detail view showing full verify
output; parallelizing checks; configurable per-command timeouts.

## 4. Architecture

```
run-task.ts (workspace-write branch only):
  { branch, worktreePath } = createWorktree(...)
  { text, ... }            = runAgent({ cwd: worktreePath, mode: "workspace-write" })   // agent edits; no shell
  { filesChanged, diffstat, committed } = commitAndDiff(worktreePath, msg)               // commit edits FIRST
  let verification = null
  if (committed):
      cmds = loadProjectVerifyCommands(repoRoot, project)        // from registry; trusted config
      verification = runVerification(worktreePath, cmds)         // runner runs cmds; ground-truth exit codes
  result = toAgentResult(envelope, text, logsPath, filesChanged, verification)
  finish(result.status, result)

read-only branch: unchanged — no worktree, no verification.
```

`runVerification` is confined to `runner/verify.ts`. Commands come only from the registry via
`runner/registry-project.ts`. Nothing the agent produces selects or alters the commands.

## 5. Components

### `lib/state/types.ts`
```ts
export interface VerificationCheck {
  command: string;
  ok: boolean;
  output_tail: string; // last ~4000 chars of combined stdout+stderr (full output goes to the jsonl log)
}
export interface VerificationReport {
  status: "passed" | "failed" | "skipped";
  checks: VerificationCheck[];
}
// AgentResult gains:   verification?: VerificationReport | null;
// AttentionItem gains: verification?: VerificationReport["status"] | null;
```
`passed` = every command ran and exited 0. `failed` = a command failed (fail-fast; the failing command
is the last entry in `checks`). `skipped` = no commands configured (or a read-only task — no report).

### `runner/verify.ts` (new)
- `const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;` and `const TAIL_CHARS = 4000;`
- `runVerification(worktreePath: string, commands: string[]): VerificationReport` —
  - If `commands.length === 0` → `{ status: "skipped", checks: [] }`.
  - For each command in order: `spawnSync(command, { cwd: worktreePath, shell: true, encoding: "utf8", timeout: VERIFY_TIMEOUT_MS })`.
    `shell: true` is acceptable because the command string is trusted registry config (not agent input)
    and it resolves `pnpm`/`pnpm.cmd` cross-platform. `ok = r.status === 0 && !r.error`.
    `output_tail = ((r.stdout ?? "") + (r.stderr ?? "") + (r.error ? r.error.message : "")).slice(-TAIL_CHARS)`.
    Push `{ command, ok, output_tail }`.
  - On the first `ok === false`, stop (do not run the remaining commands) and return
    `{ status: "failed", checks }`. If all pass → `{ status: "passed", checks }`.
  - Never throws.

### `runner/registry-project.ts` (new — mirrors `runner/registry-agents.ts`, keeps the runner from importing dashboard)
- `loadProjectVerifyCommands(repoRoot: string, projectId: string): string[]` — read
  `registry/projects.yml` with `yaml.parse`, find the project, then resolve:
  - explicit `verify: string[]` present and non-empty → return it verbatim.
  - else if `commands.install` and `commands.test` → `[commands.install, commands.test]`.
  - else if `commands.test` → `[commands.test]`.
  - else → `[]`.
  - Unknown project / missing file / parse error → `[]` (verification becomes `skipped`; never throws).

### `runner/result.ts`
- `toAgentResult(envelope, text, logsPath, filesChanged = [], verification: VerificationReport | null = null)`
  — set `verification` on the returned `AgentResult` (defaults to `null`).
- `failureResult(...)` — set `verification: null`.

### `runner/run-task.ts`
- In the workspace-write branch, after `commitAndDiff`: if `committed`, call
  `loadProjectVerifyCommands(repoRoot, rec.envelope.project)` then
  `runVerification(worktreePath, cmds)`; pass the report into `toAgentResult` and include it in the
  `writeLog` line and `metadata.run`. If not committed, verification is `null` (omitted).
- Read-only branch: unchanged (`toAgentResult` called without a verification report → `null`).

### `lib/state/derive.ts`
- When pushing the `needs-review` / `awaiting-approval` attention item for a finished task, set
  `verification: t.result?.verification?.status ?? null` on the item.

### `dashboard/src/ui/components/AttentionPanel.tsx`
- For task-kind items, render a small badge from `a.verification`:
  `"passed"` → `✓ verificado`, `"failed"` → `✗ verificación falló`, otherwise `(sin verificar)`.
  Purely informational; the Aprobar/Rechazar buttons are unchanged.

## 6. Data Flow & State Transitions

No new lifecycle states. `verification` is a new optional field on `AgentResult`. On a workspace-write
task that produced commits, the report is computed once at finish and persisted with the result.
Decided tasks still drop from the attention panel (unchanged). The badge is derived from the persisted
report on each poll.

## 7. Safety & Governance

- **The agent never runs shell** — the runner runs verification, in the isolated worktree. The agent's
  `allowedTools` / `canUseTool` policy in `claude.ts` is untouched.
- **Commands come only from the registry** (human-authored, trusted), never from the agent or the task
  envelope — no command injection via agent output. `shell: true` is therefore safe.
- **Commit happens before verify**, so the branch/commit contains only source edits; build/install
  artifacts are never committed and are discarded with the worktree on reject.
- **Verification never crashes the server/runner**: `spawnSync` with a per-command timeout, no throw; a
  failure is a recorded outcome.
- **No new secrets**: verification uses the user's ambient toolchain; only a truncated output tail is
  stored (local-only, same criterion as existing run logs).
- **No new outward actions**: verification is local to the worktree (no push/merge/deploy).

## 8. Error Handling

`runVerification` catches nothing because `spawnSync` does not throw on non-zero exit; a spawn error
(missing binary, timeout) surfaces via `r.error` and is recorded as `ok: false` with the message in the
tail. `loadProjectVerifyCommands` returns `[]` on any error (missing file, parse error, unknown
project) → `skipped`. `run-task.ts` keeps its existing try/catch; a verification step that somehow
throws is caught there and the task is recorded `failed` (verification absent).

## 9. Testing (TDD)

- `runner/verify.test.ts` (new): a passing command → `passed`; a failing command → `failed` and the
  next command is NOT run (fail-fast); empty list → `skipped`; a long output is truncated to the tail.
  (Use cross-platform commands, e.g. `node -e "process.exit(0)"` / `node -e "process.exit(1)"`.)
- `runner/registry-project.test.ts` (new, temp registry): explicit `verify` returned verbatim; default
  resolves `[install, test]`; project with only `test` → `[test]`; unknown project / missing file → `[]`.
- `runner/result.test.ts` (extend): `toAgentResult` attaches a passed/failed `verification`; default is
  `null`; `failureResult` → `verification: null`.
- `lib/state/derive.test.ts` (extend): a finished awaiting-approval task whose result has
  `verification.status` surfaces that status on the attention item; absent → `null`.
- `dashboard/src/ui/components/AttentionPanel.test.tsx` (extend): renders ✓/✗/sin-verificar per the
  item's `verification`.
- `runner/run-task.test.ts` (extend, mock `./verify` and `./registry-project`): a workspace-write task
  with committed edits → `runVerification` called and `result.verification` set; a read-only task →
  `runVerification` NOT called.

Test runner: vitest. `runVerification` is unit-tested directly with real subprocesses; in `run-task`
tests it is mocked (like the SDK/gh boundaries).

## 10. Evolution Path

- An agent auto-fix loop: surface failing-test output to the agent and let it iterate (would require a
  curated Bash allowlist via `canUseTool` — the alternative considered and deferred here).
- Block (or warn harder on) approve when verification failed; mark a failed verification as
  `needs-review`.
- A task-detail view showing full per-check output and durations.
- Configurable per-command timeouts and parallel checks.

## 11. Open Questions

None blocking. Reliable verification requires the project's verify commands to be runnable from the
repo root in a fresh worktree (e.g. `pnpm install` first, since `node_modules` is gitignored and absent
in a new worktree). Projects tune this via the registry `verify:` list; the default `[install, test]`
covers the common pnpm case.
