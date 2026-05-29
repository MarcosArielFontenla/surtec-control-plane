# Surtec Control Plane — Dispatch Runner (v1) — Design

- **Date:** 2026-05-29
- **Status:** Approved design (pre-implementation)
- **Slice:** Dispatch (second control-plane slice; follows the live-status dashboard v1)
- **Builds on:** `docs/superpowers/specs/2026-05-28-live-status-dashboard-design.md`

## 1. Context & Goal

The live-status dashboard (v1) shows a file-first state store, but data is seeded from
fixtures/CLI — no agent actually runs. This slice adds **dispatch**: from the dashboard
you create a task, a Claude agent executes it against a project repo, and its lifecycle
+ result are written to the same store, so the dashboard shows **real, live** progress
with no change to the existing read path.

Scope is deliberately small and safe: **read-only analysis tasks only** in v1 (the agent
inspects a repo and reports; it cannot modify files or run commands).

## 2. Key Decisions

- **Execution engine: Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, the `query()`
  async-iterator API), not Codex (per the standing Codex→Claude pivot).
- **Scope: read-only only.** Tools restricted to `Read`/`Glob`/`Grep`; no Edit/Write/Bash.
  `workspace-write` execution is a later iteration.
- **Trigger: a dashboard button.** `POST /api/tasks` records the task and fires the runner
  asynchronously; the existing polling surfaces progress. (CLI trigger is a later add.)
- **Agent definition: derived from the registry.** The system prompt is built on the fly
  from `registry/agents.yml` (description + allowed_task_types) + `AGENTS.md` rules. No new
  per-agent files; the deprecated Codex TOMLs are not used.
- **Invocation: in-process async (Approach A).** The Hono server runs `runTask()` in its own
  process after responding; the runner is an isolated, testable module so moving to a
  subprocess/queue later is localized. Orphaned `running` tasks are reconciled at startup.

## 3. Scope

**In scope (v1):**

- A `runner/` module: `runTask(taskId)`, a read-only Agent SDK wrapper, a system-prompt
  builder (from registry + AGENTS.md), an `AgentResult` builder, and startup reconciliation.
- `POST /api/tasks` (validate against the registry, build a `TaskEnvelope`, record `queued`,
  fire the runner) and `GET /api/dispatch-options` (projects + their allowed agents, for the form).
- A `NewTaskForm` in the dashboard UI (project + agent + instructions → dispatch).
- Startup reconciliation of orphaned `running` tasks.
- New dependency `@anthropic-ai/claude-agent-sdk`; auth via `ANTHROPIC_API_KEY`
  (documented in `.env.example`; `.env` already gitignored).

**Out of scope (future slices):**

- `workspace-write` execution (file edits, branches, running tests).
- Streaming the agent's step-by-step progress (v1 shows lifecycle + final result via polling).
- Queue/worker or subprocess isolation; concurrency caps.
- Approve/reject actions (the review-gate slice).
- Multi-user / authentication.

## 4. Architecture

```
Dashboard: NewTaskForm (project + agent + instructions)
  → POST /api/tasks
      ├─ validate: project exists, agent ∈ project.allowed_agents, instructions non-empty
      ├─ build TaskEnvelope (source "dashboard", sandbox "read-only", requires_human_approval true,
      │                      repo_path from registry local_path)
      ├─ store.writeTask(queued)            → 201 { id }
      └─ fire runTask(id) async (not awaited)   [injectable hook, see Testing]
runTask(id):
  load record → mark running
  → runReadOnlyAgent({ cwd: repo_path, systemPrompt, prompt, model, maxTurns, signal })
      (allowedTools [Read,Glob,Grep] + deny-by-default + canUseTool hard-deny of Write/Edit/Bash)
  → on result: toAgentResult(envelope, text) → mark finished (+ logs)
  → on error/abort/timeout/missing-key/repo-not-found: mark finished, outcome "failed", blocker
Dashboard polls /api/overview → queued→running→finished shown live (read path unchanged).
Server startup: reconcileRunning() → orphaned running → finished/failed ("interrupted by restart").
```

`lib/state` stays dependency-free; the Agent SDK is confined to a single file (`runner/claude.ts`).

## 5. Components

New top-level `runner/` module (server-side):

```
runner/
  claude.ts        # runReadOnlyAgent(opts) → { text, costUsd, usage }. ONLY file importing the SDK.
                   # buildQueryOptions(opts) (pure) bakes in read-only: allowedTools [Read,Glob,Grep],
                   # deny-by-default permission mode, canUseTool denying Write/Edit/Bash.
  agent-prompt.ts  # buildSystemPrompt(registryAgent, agentsMd) → string  (pure)
  result.ts        # toAgentResult(envelope, text) → AgentResult  (parse trailing ```json block; fallback)
  run-task.ts      # runTask(taskId): orchestrates state transitions + the agent call
  reconcile.ts     # reconcileRunning(): mark orphaned running tasks finished/failed
```

Server (`dashboard/src/server/`):

- `dispatch.ts` — `createTask({project, agent, instructions}, repoRoot) → { id }`: validates against
  the registry, builds the `TaskEnvelope`, `writeTask(queued)`. Rejects non-`read-only` sandbox in v1.
- `registry.ts` — extended so `RegistryProject` includes `allowed_agents: string[]` and `repo_path`
  (`local_path` from `projects.yml`), plus a loader for the agent list as needed.
- `index.ts` — adds `POST /api/tasks` (calls `createTask`, returns 201 `{id}`, fires the runner hook)
  and `GET /api/dispatch-options`; calls `reconcileRunning()` in the entrypoint block at startup.
  `createApp` accepts an optional runner hook (default `runTask`) so API tests stay hermetic.

UI (`dashboard/src/ui/`):

- `components/NewTaskForm.tsx` — project select + agent select (filtered by project) + instructions
  textarea + "Despachar" button → `POST /api/tasks`; clears on success (polling surfaces the task);
  shows a submit error on failure.
- `App.tsx` — renders `<NewTaskForm/>` above "Proyectos".
- `api.ts` — adds `fetchDispatchOptions()` and `createTask(body)`.

Task IDs: generated, e.g. `T-${Date.now().toString(36)}` — unique, readable, no dependency.

## 6. Data Flow & State Transitions

A `TaskRecord` moves through the existing lifecycle (no new states):

- POST → `queued` (created_at/updated_at = now; started_at/result/outcome null).
- runTask start → `running` (started_at = now).
- Agent SDK `query()` runs read-only; the runner captures the `result` message
  (`result` text, `total_cost_usd`, `usage`).
- **Success** → `toAgentResult(envelope, text)`:
  - The system prompt instructs the agent to end with a fenced ```json block
    `{ summary, risks[], blockers[], next_steps[], status }`. `result.ts` parses the last such
    block; the parsed `status` is validated against the `AgentOutcome` enum
    (`completed|partial|blocked|failed|needs-review`) and defaults to `"completed"` if invalid.
    If no parseable block is present, **fallback**: `summary = full text`, empty arrays,
    `status = "completed"`.
  - `files_changed`/`commands_run`/`tests_run` = `[]` (read-only). `logs_path` → the jsonl.
  - → `finished` (finished_at = now, `outcome = status`, `result` = the AgentResult).
- **Failure/abort/timeout/missing key/repo-not-found** → `finished`, `outcome = "failed"`,
  `result.blockers = [reason]`.
- **Logs:** `reports/<id>-<agent>-<ts>.jsonl` with the messages + `cost_usd`/`usage` (gitignored).
  Cost/tokens also stored in `envelope.metadata.run`.
- **Startup reconciliation:** any `running` record is orphaned (in-process runs don't survive a
  restart) → `finished`/`outcome:"failed"` + blocker "interrupted by server restart".

## 7. Safety & Governance

Read-only, defense in depth:
1. `allowedTools = ["Read","Glob","Grep"]`.
2. Deny-by-default permission mode (exact value confirmed against the installed SDK version).
3. A `canUseTool` callback that hard-denies any tool outside {Read,Glob,Grep} —
   version-independent guarantee.
4. `createTask` accepts only `sandbox: "read-only"` in v1.

Secrets/auth: `ANTHROPIC_API_KEY` is read only from `process.env`; never logged or written to the
store/logs. Missing key → the run fails cleanly (no crash). No other secrets touched.

Governance (AGENTS.md): no merge, deploy, push, or file mutation; `requires_human_approval` stays
`true` on every dispatched task; the agent's system prompt embeds the AGENTS.md rules.

Limits: `maxTurns` (~12); a timeout via `AbortController` (~5 min) → `failed` + "timeout";
optional cost cap if the SDK supports it. Missing repo path → fails cleanly. Concurrency is
unbounded in v1 (single user) — noted as future hardening.

## 8. Error Handling

`runTask` is wrapped in try/catch so no failure crashes the server (the POST has already
responded). POST validation errors → 400 with a message the UI shows. Agent SDK errors / aborts
are caught in `run-task.ts`. Malformed agent output is handled by `result.ts`'s fallback.

## 9. Testing (TDD)

- `runner/agent-prompt.test.ts` — system prompt includes the agent role + AGENTS.md rules +
  read-only constraint text.
- `runner/result.test.ts` — parses the trailing ```json block; fallback when absent;
  read-only fields empty; failure shape.
- `runner/claude.test.ts` — tests the pure `buildQueryOptions()` (read-only `allowedTools` +
  `canUseTool` denying Write/Edit/Bash) **without invoking the SDK**.
- `runner/run-task.test.ts` — with `claude.ts` mocked: queued→running→finished+AgentResult;
  error → finished/failed + blocker (temp `SURTEC_STATE_DIR`).
- `runner/reconcile.test.ts` — seeded `running` → finished/failed.
- `dashboard/src/server/dispatch.test.ts` — `createTask` rejects unknown project / disallowed
  agent / empty instructions; records the correct envelope.
- `dashboard/src/server/index.test.ts` (extend) — `POST /api/tasks` → 201 `{id}` + a `queued`
  record; the runner hook is a no-op in the test (hermetic, no real SDK call).
- `dashboard/src/ui/NewTaskForm.test.tsx` (jsdom) — populates selects from mocked
  dispatch-options; submit POSTs the correct body.

Test runner: vitest (already configured).

## 10. Evolution Path

- **workspace-write** execution: the agent edits files on a branch and runs tests; review the diff.
- Streaming step-by-step progress (persist intermediate events; SSE) — the store interface and
  polling already accommodate finer-grained updates.
- CLI trigger reusing the same `runTask` entrypoint; subprocess/queue invocation; concurrency caps.
- Review-gate slice: approve/reject finished tasks from the UI.

## 11. Open Questions

None blocking. The exact Agent SDK `permissionMode` value and cost-cap option are confirmed
against the installed SDK version during implementation; the `canUseTool` hard-deny guarantees
read-only regardless.
