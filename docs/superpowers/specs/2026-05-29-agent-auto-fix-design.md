# Surtec Control Plane — Agent Auto-Fix Loop (v1) — Design

- **Date:** 2026-05-29
- **Status:** Approved design (pre-implementation)
- **Slice:** Agent auto-fix loop (seventh control-plane slice; extends self-verify)
- **Builds on:** `docs/superpowers/specs/2026-05-29-self-verify-design.md`, `2026-05-29-workspace-write-design.md`

## 1. Context & Goal

Self-verify (slice 6) has the runner run a project's verify commands AFTER the agent finishes, recording
ground-truth pass/fail. The agent itself cannot react to failures. This slice adds an opt-in **auto-fix
loop**: a workspace-write task can run in a mode where the agent is given a **strictly allowlisted Bash
tool** — it may run ONLY the project's declared verify commands — so it can run tests/typecheck during
its turn, see failures, and fix its edits before finishing.

The runner's post-commit verification (slice 6) **stays** as the authoritative record. The agent's
self-run improves output quality; the runner still confirms ground truth and drives the ✓/✗ badge. So
there is no trust problem: even if the agent claims green, the runner verifies independently.

This is the one place the project's "the agent never runs shell" invariant is deliberately relaxed —
and only under an explicit per-task opt-in, behind an exact-match command allowlist enforced by
`canUseTool`.

## 2. Key Decisions

- **Complements, not replaces, slice 6.** The agent iterates during its turn; the runner still runs
  verification after the commit and records the ground-truth `VerificationReport`. The badge stays
  authoritative.
- **Exact-match allowlist.** `canUseTool` permits a Bash call ONLY when `input.command` (trimmed)
  **exactly equals** one of the project's verify commands (from `loadProjectVerifyCommands`, slice 6).
  No extra args, no `&&`/`|`/`;`, no other binary. This makes command injection impossible — the agent
  can only run a handful of fixed strings. (Targeted re-runs with args are deferred; see §10.)
- **Commands come only from the registry** (human-authored config), never from the agent or the task
  envelope.
- **Explicit opt-in.** A new `self_verify?: boolean` flag on `TaskEnvelope`, valid only with
  `sandbox: "workspace-write"`. Giving the agent shell is a deliberate per-task choice.
- **A third internal `RunMode`** `"workspace-write-verify"` in `runner/claude.ts` carries the relaxed
  tool policy. The public `sandbox` field stays a two-value security boundary (`read-only` /
  `workspace-write`) — it is not widened.
- **`BashOutput`/`KillBash` allowed ungated** in verify mode (they read/terminate the already-gated
  shell; they do not execute new commands). `NotebookEdit` stays denied. Read-only and plain
  workspace-write are completely unchanged (no Bash).

## 3. Scope

**In scope (v1):**

- `lib/state/types.ts` — `TaskEnvelope.self_verify?: boolean`.
- `schemas/task-envelope.schema.json` — mirror the optional `self_verify` boolean.
- `dashboard/src/server/dispatch.ts` — `CreateTaskInput.self_verify?`; validate (only with
  workspace-write); set on the envelope.
- `dashboard/src/server/index.ts` — widen the `createTask` body cast to include `sandbox`/`self_verify`
  (it already forwards the full parsed body).
- `dashboard/src/ui/api.ts` — `createTask` body gains `self_verify?: boolean`.
- `dashboard/src/ui/components/NewTaskForm.tsx` — a third mode option that dispatches
  `{ sandbox: "workspace-write", self_verify: true }`.
- `runner/claude.ts` — third `RunMode`; `VERIFY_TOOLS`; `RunOptions.verifyCommands?`; `buildQueryOptions`
  gates Bash by exact-match.
- `runner/agent-prompt.ts` — `buildSystemPrompt` gains a verify-mode branch listing the allowed commands.
- `runner/run-task.ts` — derive the mode from `self_verify`, load the verify commands, pass them to
  `runAgent` and `buildSystemPrompt`. (Slice 6's post-commit runner verify is unchanged.)
- `README.md` — document the auto-fix loop.

**Out of scope (future):** prefix/arg matching for targeted re-runs; per-agent allowlists; a loop
timeout separate from `maxTurns`; surfacing the agent's command trace in the UI; auto-fix for read-only.

## 4. Architecture

```
Dispatch "Implementar + auto-fix" → createTask({ sandbox: "workspace-write", self_verify: true })
  envelope.self_verify = true   (validation: self_verify requires workspace-write)

run-task (workspace-write branch):
  verifyCommands = loadProjectVerifyCommands(repoRoot, project)        // loaded ONCE; reused below
  wantsVerify = self_verify === true && verifyCommands.length > 0
  mode = wantsVerify ? "workspace-write-verify" : "workspace-write"
  systemPrompt = buildSystemPrompt(agent, agentsMd, mode, verifyCommands)
  createWorktree → runAgent({ cwd: worktree, mode, verifyCommands })   // agent edits AND runs allowlisted verify
  commitAndDiff → committed ? runVerification(worktree, verifyCommands) : null   // slice 6 ground-truth record (same verifyCommands)
  finish

claude.ts policy:
  allowedTools(verify)   = VERIFY_TOOLS = [...WRITE_TOOLS, "Bash", "BashOutput", "KillBash"]
  disallowedTools(verify)= ["NotebookEdit"]
  canUseTool(verify):
    if toolName === "Bash": allow IFF verifySet.has(input.command.trim()) else deny
    else: allow IFF VERIFY_TOOLS.includes(toolName) else deny
```

If `wantsVerify` but the project has no verify commands, the mode falls back to plain `workspace-write`
(no Bash — there is nothing to allow).

## 5. Components

### `lib/state/types.ts`
`TaskEnvelope` gains `self_verify?: boolean` (optional; meaningful only with `sandbox:"workspace-write"`).

### `schemas/task-envelope.schema.json`
Add `"self_verify": { "type": "boolean" }` to `properties` (NOT to `required`). Keeps the
`additionalProperties:false` mirror honest.

### `dashboard/src/server/dispatch.ts`
- `CreateTaskInput` gains `self_verify?: boolean`.
- Validate: if `input.self_verify === true && sandbox !== "workspace-write"` →
  `throw new ValidationError("self_verify requires sandbox workspace-write")`.
- Set `self_verify: input.self_verify === true && sandbox === "workspace-write"` on the envelope.

### `dashboard/src/server/index.ts`
- Widen the cast at the `createTask` call to
  `body as { project: string; agent: string; instructions: string; sandbox?: string; self_verify?: boolean }`.
  (The full parsed body is already forwarded.)

### `dashboard/src/ui/api.ts`
- `createTask` body type gains `self_verify?: boolean`.

### `dashboard/src/ui/components/NewTaskForm.tsx`
- The mode `<select>` gains a third option with UI value `"workspace-write-verify"`:
  `<option value="workspace-write-verify">Implementar + auto-fix (verify)</option>`.
- `onSubmit` maps the UI value to the API call:
  - `"workspace-write-verify"` → `createTask({ project, agent, instructions, sandbox: "workspace-write", self_verify: true })`
  - otherwise → `createTask({ project, agent, instructions, sandbox: mode })`.

### `runner/claude.ts`
- `export type RunMode = "read-only" | "workspace-write" | "workspace-write-verify";`
- `export const VERIFY_TOOLS = [...WRITE_TOOLS, "Bash", "BashOutput", "KillBash"] as const;`
- `RunOptions` gains `verifyCommands?: string[]`.
- `buildQueryOptions(o)`:
  - `allowed` = verify → `VERIFY_TOOLS`; workspace-write → `WRITE_TOOLS`; read-only → `READ_ONLY_TOOLS`.
  - `disallowed` = read-only → `[...EXEC_TOOLS, ...WRITE_TOOLS_DISALLOWED_IN_READONLY]`; workspace-write →
    `[...EXEC_TOOLS]`; verify → `["NotebookEdit"]`.
  - `const verifySet = new Set(o.verifyCommands ?? []);`
  - `canUseTool(toolName, input)`:
    ```ts
    if (o.mode === "workspace-write-verify" && toolName === "Bash") {
      const cmd = typeof input.command === "string" ? input.command.trim() : "";
      return verifySet.has(cmd)
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: `runner (verify): Bash command not allowlisted: ${cmd}` };
    }
    return allowed.includes(toolName)
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: `runner (${o.mode}): tool '${toolName}' is not permitted` };
    ```
  - `maxTurns` default for verify mode is bumped (`o.maxTurns ?? (o.mode === "workspace-write-verify" ? 20 : 12)`)
    to give the iterate-and-fix loop room.

### `runner/agent-prompt.ts`
- `buildSystemPrompt(agent, agentsMd, mode: RunMode = "read-only", verifyCommands: string[] = [])`.
- For `mode === "workspace-write-verify"`, the mode lines become (listing the exact commands):
  ```
  You are running in WORKSPACE-WRITE mode with VERIFICATION. You MAY use Read, Grep, Glob and edit
  files with Edit, Write, MultiEdit. You MAY ALSO run ONLY these exact commands via Bash to verify
  your work:
    - <each verifyCommand>
  Run them; if they fail, fix your edits and re-run until they pass. You must NOT run any other shell
  command (anything else is denied), and you must NOT merge, deploy, or push. The control plane commits
  your edits to a branch for human review.
  ```
- `workspace-write` and `read-only` lines are unchanged.

### `runner/run-task.ts`
- In the workspace-write branch, load `verifyCommands = loadProjectVerifyCommands(repoRoot, project)` ONCE
  at the top, then derive `wantsVerify = rec.envelope.self_verify === true && verifyCommands.length > 0`
  and `mode = wantsVerify ? "workspace-write-verify" : "workspace-write"` (§4).
- Branch on `rec.envelope.sandbox === "workspace-write"` (covers both write and verify modes); pass the
  derived `mode` and `verifyCommands` to `buildSystemPrompt` and `runAgent` (verifyCommands is harmless
  in plain write mode — Bash is not allowed there).
- The slice-6 post-commit verification reuses the SAME `verifyCommands`:
  `const verification = committed ? runVerification(worktreePath, verifyCommands) : null;` (no second
  registry read). Read-only branch unchanged.

## 6. Data Flow & State Transitions

No new lifecycle states. `self_verify` is a new optional envelope flag set at dispatch. It changes the
agent's tool policy for that run only. The persisted result is unchanged in shape — the runner's
post-commit `VerificationReport` (slice 6) is still what gets recorded and badged.

## 7. Safety & Governance

- **The invariant is relaxed ONLY in the opt-in verify mode.** read-only and plain workspace-write are
  byte-for-byte unchanged (no Bash). Confirmed by mode-specific `allowedTools`/`disallowedTools`.
- **Exact-match allowlist** enforced in `canUseTool`: the agent's Bash command must equal a registry
  verify command verbatim. No args, no shell operators, no other binary → no injection surface. A
  non-matching command is denied with a message; the agent continues (it can fix or finish).
- **Commands come only from the registry**, never the agent/envelope.
- **No outward action:** the agent still cannot merge/deploy/push; git is run only by the runner; the
  human approve/PR gate is unchanged. The auto-fix loop is local to the worktree.
- **Ground truth unchanged:** the runner's post-commit verification remains the authoritative record,
  so a lying agent cannot fake a green badge.
- **Bounded:** the loop runs within the agent's `maxTurns` and the existing 5-minute run timeout.

## 8. Error Handling

A denied Bash command returns a `canUseTool` deny (not a crash) — the agent sees the denial and proceeds.
`loadProjectVerifyCommands` returns `[]` on any error → mode falls back to plain workspace-write. The
existing run-task try/catch still records `failed` on any thrown error. `runVerification` (slice 6) is
unchanged.

## 9. Testing (TDD)

- `runner/claude.test.ts` (extend): verify mode → `Bash`/`BashOutput`/`KillBash` in `allowedTools`,
  `NotebookEdit` in `disallowedTools`; `canUseTool` ALLOWS an exact allowlisted command, DENIES a
  non-listed command, DENIES an allowlisted command with extra args, DENIES one with `&&`/`;`, DENIES a
  non-Bash tool outside `VERIFY_TOOLS`; plain workspace-write still DENIES `Bash`.
- `dashboard/src/server/dispatch.test.ts` (extend): `self_verify:true` + `read-only` → `ValidationError`;
  `self_verify:true` + `workspace-write` → envelope `self_verify === true`; omitted → falsy.
- `runner/agent-prompt.test.ts` (extend): verify-mode prompt lists each allowed command and the
  "ONLY these exact commands" instruction; workspace-write/read-only prompts unchanged.
- `runner/run-task.test.ts` (extend, mocks): a `self_verify` workspace-write task → `runAgent` called
  with `mode === "workspace-write-verify"` and the loaded `verifyCommands`; a workspace-write task
  WITHOUT `self_verify` → `runAgent` called with `mode === "workspace-write"` (no verifyCommands / no
  Bash); a `self_verify` task whose project has no verify commands → falls back to `workspace-write`.
- `dashboard/src/ui/components/NewTaskForm.test.tsx` (extend): selecting the third option dispatches a
  body with `sandbox:"workspace-write"` and `self_verify:true`.

Test runner: vitest. The SDK boundary stays mocked in run-task tests; `buildQueryOptions` is unit-tested
directly (pure).

## 10. Evolution Path

- Prefix/arg matching (e.g. `pnpm test <file>`) with a shell-metacharacter blocklist, for targeted
  re-runs in the loop.
- Per-agent or per-task-type allowlists.
- A dedicated loop budget/timeout independent of `maxTurns`.
- Surface the agent's verify-command trace (and its self-fix iterations) in a task-detail view.

## 11. Open Questions

None blocking. Exact-match means the agent can only run the full declared command (e.g. the whole test
suite), not a filtered subset — acceptable for v1; arg support is the first evolution step. The verify
mode depends on the project declaring runnable verify commands (same prerequisite as slice 6).
