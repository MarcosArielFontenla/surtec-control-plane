# Surtec Control Plane — Workspace-Write Execution (v1) — Design

- **Date:** 2026-05-29
- **Status:** Approved design (pre-implementation)
- **Slice:** Workspace-write (third control-plane slice; follows read-only dispatch)
- **Builds on:** `docs/superpowers/specs/2026-05-29-dispatch-runner-design.md`

## 1. Context & Goal

Read-only dispatch lets a Claude agent inspect a repo and report. This slice lets an agent
**implement changes**: it edits files in an **isolated git worktree** on a dedicated branch,
the runner commits them, and the dashboard surfaces the changed files + diffstat. A human
reviews the branch in VS Code and runs the tests. Nothing is pushed, merged, or deployed.

Scope is deliberately small and safe: **edit-only** (the agent may edit files but cannot run
any shell command), **worktree-isolated** (the main checkout is never touched), **local branch
only** (no push/merge/deploy).

## 2. Key Decisions

- **Isolation: a git worktree.** The agent works in `../surtec-worktrees/<repo>-<task>-<agent>`
  on branch `agent/<task>-<agent>` (as `scripts/projects/create-worktree.sh` already anticipates).
  The user's main checkout is untouched; `git worktree add` does not require it to be clean.
- **Commands: edit-only, no Bash.** Tools = `Read/Grep/Glob/Edit/Write/MultiEdit`; Bash and all
  shell/exec tools are denied. The agent never runs git, tests, or any command.
- **git is run by the runner, not the agent.** Our runner (`runner/worktree.ts`) creates the
  worktree and, after the agent edits, `git add -A` + `git commit` to the branch and captures the
  diffstat. The runner only ever runs `worktree add`, `add`, `commit`, `diff` — never push/merge/deploy.
- **Result: commit to the branch + diffstat.** `AgentResult.files_changed` is populated from
  `git diff`; `branch`/`worktree_path`/`diffstat` go in `metadata.run`. Review happens on the branch.
- **Dispatch: a mode toggle in the form.** `NewTaskForm` gains an "Analizar (read-only) / Implementar
  (workspace-write)" selector; `createTask` accepts `sandbox` per request (validated). `requires_human_approval`
  stays true.
- **Integration: thread the mode through the existing runner (Approach A).** `run-task` branches on
  `envelope.sandbox`; the read-only path is unchanged. A new `runner/worktree.ts` handles git.

## 3. Scope

**In scope (v1):**

- `runner/worktree.ts` — `createWorktree` + `commitAndDiff` (git run by the runner).
- `runner/claude.ts` — a `mode` selecting the toolset (read vs write; Bash always denied).
- `runner/agent-prompt.ts` — mode-aware system prompt.
- `runner/result.ts` — `toAgentResult` accepts a `filesChanged` override.
- `runner/run-task.ts` — branch on `envelope.sandbox`; worktree + commit + diffstat for write.
- `dashboard/src/server/dispatch.ts` — `createTask` accepts `sandbox` (validated; default read-only).
- `dashboard/src/ui/` — `NewTaskForm` mode selector; `api.ts createTask` sends `sandbox`.

**Out of scope (future slices):**

- The agent running commands/tests (Bash) — the human runs tests on the branch.
- An embedded diff viewer in the UI — review happens in VS Code on the branch.
- Auto-cleanup of worktrees (manual for now).
- Push / PR creation / merge / deploy.

## 4. Architecture

```
NewTaskForm (mode "Implementar")
  → POST /api/tasks { project, agent, instructions, sandbox: "workspace-write" }
      ├─ createTask validates (project, agent ∈ allowed_agents, instructions, sandbox ∈ {read-only,workspace-write})
      ├─ envelope.sandbox = mode; task_type = "implementation"; requires_human_approval true
      └─ writeTask(queued) → fire runTask
runTask(id):  mark running
  if envelope.sandbox === "workspace-write":
     · source = expandHome(repo_path); require it exists and is a git repo (else finished/failed)
     · { branch, worktreePath } = createWorktree(source, id, agent)   // git worktree add -b agent/<id>-<agent>
     · runAgent({ cwd: worktreePath, mode: "workspace-write", systemPrompt(write), prompt }, signal)  // Edit/Write/MultiEdit; Bash denied
     · { filesChanged, diffstat, committed } = commitAndDiff(worktreePath, "agent <id>: <title>")  // runner runs git
     · metadata.run = { mode, branch, worktree_path, diffstat, committed, cost_usd, tokens }
     · result = toAgentResult(envelope, text, logsPath, filesChanged)
  else (read-only): unchanged path (cwd = repo, read tools, files_changed = [])
  finish(result.status, result)   // same transitions/logging/timeout/failure handling
Human reviews the branch/worktree in VS Code and runs the tests. No push/merge/deploy.
Server polling shows queued→running→finished live (read path unchanged).
```

`lib/state` stays dependency-free; the Agent SDK stays confined to `runner/claude.ts`.

## 5. Components

`runner/worktree.ts` (new) — git run by the runner (`node:child_process`), never by the agent:
- `createWorktree(sourceRepo, taskId, agentId): { branch, worktreePath }` — sanitizes ids;
  `branch = agent/<id>-<agent>`; `worktreeRoot = join(dirname(sourceRepo), "surtec-worktrees")`;
  `worktreePath = join(worktreeRoot, "<basename(source)>-<id>-<agent>")`;
  `git -C <source> worktree add -b <branch> <worktreePath>` — throws on failure.
- `commitAndDiff(worktreePath, message): { filesChanged: string[]; diffstat: string; committed: boolean }`
  — `git -C <wt> add -A`; `filesChanged = git -C <wt> diff --cached --name-only`;
  `diffstat = git -C <wt> diff --cached --stat`; if no staged changes → `{ [], "", false }`;
  else `git -C <wt> commit -m <message>` → `{ filesChanged, diffstat, true }`.

`runner/claude.ts` — `RunOptions` gains `mode: "read-only" | "workspace-write"`:
- `READ_ONLY_TOOLS = [Read, Grep, Glob]`; `WRITE_TOOLS = [...READ_ONLY_TOOLS, Edit, Write, MultiEdit]`.
- `allowedTools = mode === "workspace-write" ? WRITE_TOOLS : READ_ONLY_TOOLS`.
- `disallowedTools` = the shell/exec set (Bash, BashOutput, KillBash) in **both** modes.
- `canUseTool` allows only `allowedTools`, denies everything else (⇒ Bash always denied; Edit/Write only in write).

`runner/agent-prompt.ts` — `buildSystemPrompt(agent, agentsMd, mode)`: read-only ("inspect only") vs
write ("you MAY edit files with Edit/Write/MultiEdit; you must NOT run commands, merge, deploy, or push").
The trailing ```json report instruction is unchanged.

`runner/result.ts` — `toAgentResult(envelope, text, logsPath, filesChanged?)`: when `filesChanged` is
provided (write mode), it populates `files_changed`; otherwise `[]`.

`runner/run-task.ts` — branches on `envelope.sandbox`. Write path: verify the source is a git repo,
`createWorktree`, run the agent with `cwd = worktreePath` + write mode, `commitAndDiff`, stamp
`metadata.run` (mode/branch/worktree_path/diffstat/committed/cost/tokens), build the result with
`filesChanged`. Read-only path unchanged. Worktree-create / source-not-git / commit failures →
`finished` + `outcome:"failed"` + blocker (runTask never throws).

`dashboard/src/server/dispatch.ts` — `CreateTaskInput` gains `sandbox?`; validated against
`{read-only, workspace-write}` (default `read-only`); `envelope.sandbox` set; `task_type` =
`"implementation"` for write, `"analysis"` for read-only.

`dashboard/src/ui/` — `NewTaskForm` adds a mode `<select>` (Analizar → read-only / Implementar →
workspace-write); `api.ts createTask` includes `sandbox` in the POST body.

## 6. Data Flow & State Transitions

No new lifecycle states.

- POST → `queued` (envelope.sandbox = requested; task_type per mode).
- runTask → `running`.
- **Write path:** resolve source → fail cleanly if missing / not a git repo → create worktree →
  run agent (write tools) → `commitAndDiff` → `metadata.run` + `files_changed` → `finished` with the
  outcome from the agent's json report.
- **Read-only path:** unchanged (`files_changed = []`).
- **No changes** (write, the agent edited nothing): `committed:false`, `files_changed:[]`, empty
  diffstat — a valid `completed` result.
- **Failure after the worktree exists** (agent error/timeout/commit failure): `finished`/`failed` +
  blocker; the worktree is **left in place** for inspection (no auto-cleanup in v1); `worktree_path`
  is in `metadata.run` for recovery.
- Logs: `reports/<id>-<agent>-<ts>.jsonl` (text + cost; for write, branch/worktree/diffstat).

## 7. Safety & Governance

The agent mutates files, so defense in depth:

1. **Edit-only:** `allowedTools = [Read,Grep,Glob,Edit,Write,MultiEdit]` — no Bash. `disallowedTools`
   covers shell/exec in both modes. `canUseTool` denies anything outside `allowedTools` ⇒ Bash is
   hard-denied even in write mode. The agent cannot run any command (no git, push, deploy, or shell `rm`).
2. **git is run only by the runner** (`worktree.ts`), with fixed commands — never push/merge/deploy.
3. **Worktree isolation:** the agent's `cwd` is the isolated worktree, not the main checkout. Blast
   radius is a throwaway branch.
4. **Confined writes:** `additionalDirectories` is not set, so the SDK's file tools stay within the
   worktree `cwd`.
5. **No push/merge/deploy (AGENTS.md):** the runner only commits to a local branch; the dashboard
   never merges/deploys; `requires_human_approval` stays true; the human reviews and decides.
6. **Secrets:** `ANTHROPIC_API_KEY` is read only from env, never logged/persisted. The agent can read
   repo files (as in read-only mode) but cannot exfiltrate (no Bash, no WebFetch).
7. **Limits:** the same `maxTurns` + ~5-min `AbortController` timeout as read-only.

## 8. Error Handling

`runTask` is fully try/caught — no failure crashes the server. Source not a git repo / missing →
`failed` + blocker (before any worktree). `git worktree add` failure → `failed` + blocker. Agent
error/timeout → `failed` + blocker (worktree preserved). Commit failure → `failed` + blocker (edits
remain in the worktree, recoverable via the `worktree_path` in `metadata.run`).

## 9. Testing (TDD)

- `runner/worktree.test.ts` — a real temp git repo (`git init` + initial commit): `createWorktree`
  creates the branch + dir; write a file in the worktree → `commitAndDiff` returns the file +
  non-empty diffstat + `committed:true`; a no-change case → `committed:false`, `[]`.
- `runner/claude.test.ts` (extend) — `buildQueryOptions("workspace-write")` allows Edit/Write/MultiEdit;
  `canUseTool` allows Edit and **still denies Bash**. Keep the read-only assertions.
- `runner/agent-prompt.test.ts` (extend) — write mode grants edit + forbids running commands; read-only
  keeps its wording.
- `runner/result.test.ts` (extend) — `toAgentResult` with a `filesChanged` arg uses it; without → `[]`.
- `runner/run-task.test.ts` (extend) — mock `./claude` AND `./worktree`: a write task calls
  `createWorktree`, runs the agent with write mode, calls `commitAndDiff`, and the record has
  `files_changed` + `metadata.run.branch`; worktree-create failure → `failed` + blocker; source-not-git
  → `failed`.
- `dashboard/src/server/dispatch.test.ts` (extend) — `createTask` with `sandbox:"workspace-write"` →
  write envelope + `task_type:"implementation"`; invalid sandbox → `ValidationError`; absent → default read-only.
- `dashboard/src/ui/components/NewTaskForm.test.tsx` (extend) — the mode selector is present; choosing
  "Implementar" POSTs `sandbox:"workspace-write"`.

Test runner: vitest.

## 10. Evolution Path

- Let the agent run the project's test/lint/build via a curated Bash allowlist (self-verification).
- Embedded diff viewer in the UI; "discard task" action that removes the worktree + branch.
- Push / open a PR for an approved branch (review-gate slice).

## 11. Open Questions

None blocking. The `git` CLI must be on PATH for the runner (it already is in this environment);
`worktree.test.ts` exercises real git.
