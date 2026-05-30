# Surtec Control Plane — Run Commands / "Procesos" (v1) — Design

- **Date:** 2026-05-30
- **Status:** Approved design (pre-implementation)
- **Slice:** Run project commands from the dashboard (theme B "actions from one place", slice B.2)
- **Builds on:** project open actions (`2026-05-30-project-open-actions-design.md`), portfolio discovery
  (`2026-05-29-portfolio-discovery-design.md`), self-verify (`2026-05-29-self-verify-design.md`)

## 1. Context & Goal

Marcos orchestrates his projects by opening each one and running `npm run dev` / `build` / `test` by hand.
This slice lets him **launch and watch those commands from the control plane** — a dedicated **"Procesos"**
view that lists every project's runnable commands, starts them, **streams their output live**, and stops
them, all in one pane. It covers both **long-running `dev` servers** (stay alive until stopped) and
**one-shot** commands (`build`/`test`/`lint`/`install`, which run to completion and exit). The Hono server
runs on Marcos's machine, so it can spawn these processes directly; the browser receives output over SSE.

## 2. Key Decisions

- **Commands come ONLY from the trusted registry** (never free-text from the client). The client sends a
  command **key** (`"dev" | "build" | "test" | "lint" | "install"`); the server maps it to the registry
  string for that project. `cwd` = the project's `local_path`. Same trust posture as `runner/verify.ts`
  (`shell: true` on trusted strings is fine; no arg injection, no client-supplied path).
- **Two slots per project**: one **`dev`** (long-running) + one **`oneshot`** (`build`/`test`/`lint`/
  `install`). Starting a command whose slot is busy → `409`. `dev` is the only long-running kind; everything
  else is one-shot.
- **Processes are children of the dashboard server, NOT detached** → they die when the dashboard stops, so
  there are **no orphans** and **no cross-restart reconcile** is needed. In-memory state only.
- **Stop kills the process**: Windows `taskkill /PID <pid> /T /F` — the `/T` kills the whole tree (needed
  because `npm run dev` spawns node children). POSIX `process.kill(pid, "SIGTERM")` (single process; npm
  forwards the signal to its child on POSIX — acceptable for v1, and the host here is Windows). We do NOT
  detach into a process group, so there is no `-pid` group kill.
- **Live output via SSE** (`GET /api/runs/:runId/stream`): on connect, replay the buffered log, then stream
  appended chunks and status changes. A bounded **ring buffer (~256 KB)** per run caps memory.
- **No persistence (v1)**: run history is in-memory and lost on dashboard restart. Output is shown raw
  (no ANSI color parsing). Persisting history and ANSI rendering are explicit follow-ups.
- **Registry `commands` is extended with a `dev` key** and populated best-effort for the 12 real repos by
  reading each `package.json`. Projects with no commands are listed but show "sin comandos configurados".

## 3. Scope

**In scope (v1):**

- `runner/process-manager.ts` — in-memory singleton: `start`, `stop`, `get`, `list`, `subscribe`; slot
  enforcement; ring-buffer log capture; child-process lifecycle; cross-platform tree-kill.
- `runner/project-commands.ts` — `loadProjectCommands(repoRoot, projectId)` → `{ dev?, build?, test?, lint?,
  install? }` from the registry (trusted; never throws → `{}` on any error).
- `dashboard/src/server/index.ts` — routes: `GET /api/runs`, `GET /api/projects/:id/commands`,
  `POST /api/projects/:id/run`, `POST /api/runs/:runId/stop`, `GET /api/runs/:runId`,
  `GET /api/runs/:runId/stream` (SSE).
- `dashboard/src/ui/api.ts` — `listRuns`, `getProjectCommands`, `runProject`, `stopRun`, `getRun`,
  `streamRun` (EventSource).
- `dashboard/src/ui/views/ProcesosView.tsx` + a console component — the new route.
- `dashboard/src/ui/App.tsx` (or the nav/router) — a **"Procesos"** sidebar nav item + route.
- `dashboard/src/ui/components/ProjectCard.tsx` — a compact `● dev` / `● build…` running indicator.
- `registry/projects.yml` — add `dev` (and fill `build`/`test`/`lint`) for the real repos.
- `dashboard/src/ui/styles/dashboard.css` — console + Procesos styles (Estante mono).

**Out of scope (later):** persisting run history across restarts; ANSI color rendering; arbitrary/custom
commands; env-var editing per run; concurrent one-shots per project; bulk "run X across all repos"; git
pull/push (separate B slice); attaching to processes started outside the dashboard.

## 4. Architecture

```
Start:
  Button → api.runProject(id, key) → POST /api/projects/:id/run { command: key }
    handler: cmd = loadProjectCommands(repoRoot, id)[key]
      if !cmd                         → 400 "command not configured"
      kind = key === "dev" ? "dev" : "oneshot"
      try processManager.start({ projectId:id, kind, command:cmd, cwd:<local_path> })
        if slot busy                  → SlotBusyError → 409
      → 201 { runId }

start() (process-manager):
  spawn(command, { cwd, shell:true, windowsHide:true })   // child of server, NOT detached
  record = { runId, projectId, kind, command, status:"running", pid, startedAt, log:Ring(256KB) }
  child.stdout/​stderr → record.log.push(chunk) + emit({type:"chunk"}) to subscribers
  child.on("exit", code) → status = code===0 ? "exited" : "failed"; endedAt; exitCode; emit({type:"status"})
  slot[projectId][kind] = runId (cleared on exit); bounded history of finished runs kept

Stop:
  Button → POST /api/runs/:runId/stop → processManager.stop(runId)
    win32: spawnSync("taskkill", ["/PID", pid, "/T", "/F"])   // kills the tree
    else:  process.kill(pid, "SIGTERM")
    status = "stopped"; emit({type:"status"})

Stream (live console):
  EventSource("/api/runs/:runId/stream")
    on connect: send one "snapshot" event (full buffered log + status)
    subscribe(runId): forward {type:"chunk"|"status"} as SSE events until status is terminal & client closes
```

`spawn`, `spawnSync` (tree-kill), and `process.platform` are injectable into the process-manager so it is
unit-testable with `node -e` and without depending on the host's `taskkill`.

## 5. Components

### `runner/process-manager.ts`

```ts
export type RunKind = "dev" | "oneshot";
export type RunStatus = "running" | "exited" | "failed" | "stopped";

export interface RunRecord {
  runId: string;
  projectId: string;
  kind: RunKind;
  command: string;
  status: RunStatus;
  pid: number | null;
  startedAt: string;       // ISO; stamped by caller-injected clock (Date is unavailable in some contexts)
  endedAt: string | null;
  exitCode: number | null;
}

export type RunEvent =
  | { type: "snapshot"; record: RunRecord; log: string }
  | { type: "chunk"; data: string }
  | { type: "status"; record: RunRecord };

export class SlotBusyError extends Error { constructor(public kind: RunKind) { super(`slot busy: ${kind}`); } }

export interface ProcessManager {
  start(opts: { projectId: string; kind: RunKind; command: string; cwd: string }): RunRecord; // throws SlotBusyError
  stop(runId: string): void;                       // no-op if unknown / already terminal
  get(runId: string): { record: RunRecord; log: string } | null;
  list(): RunRecord[];                              // active first, then bounded recent history
  subscribe(runId: string, cb: (e: RunEvent) => void): () => void; // returns unsubscribe
}

export function createProcessManager(deps?: {
  spawn?: typeof import("node:child_process").spawn;
  spawnSync?: typeof import("node:child_process").spawnSync;
  platform?: NodeJS.Platform;
  now?: () => string;                              // injectable ISO clock
  newId?: () => string;                            // injectable id (no Math.random in tests)
}): ProcessManager;

// Module-level singleton used by the server:
export const processManager: ProcessManager;
```

- **Ring buffer**: appends raw stdout+stderr (interleaved by arrival), capped at ~256 KB; when full, drops
  from the front. `get()`/snapshot returns the current buffer as a string.
- **Slot index**: `Map<projectId, { dev?: runId; oneshot?: runId }>`. `start` throws `SlotBusyError(kind)`
  if that slot already has a *running* run. On exit/stop the slot entry is cleared.
- **History**: keep up to N (e.g. 10) most-recent finished runs per project in `list()`; running runs always
  included. Subscribers to a terminal run still get a `snapshot` then the connection can close.
- **Never throws on spawn failure**: a child that fails to spawn is recorded as `status:"failed"` with the
  error text appended to the log (mirrors `verify.ts`).

### `runner/project-commands.ts`

```ts
export interface ProjectCommands { dev?: string; build?: string; test?: string; lint?: string; install?: string; }
export function loadProjectCommands(repoRoot: string, projectId: string): ProjectCommands;
```

- Reads `registry/projects.yml`, returns `projects[projectId].commands ?? {}`, keeping only string,
  non-empty values among the known keys. Any error (missing file, parse, unknown project) → `{}`. Never
  throws. (Mirrors `runner/registry-project.ts`; the two can share the registry read but stay separate
  functions — `loadProjectVerifyCommands` derives a *verify list*, this returns the *raw map*.)

### `dashboard/src/server/index.ts` (routes)

```ts
app.get("/api/runs", (c) => c.json({ runs: processManager.list() }));

app.get("/api/projects/:id/commands", (c) => {
  const commands = loadProjectCommands(repoRoot, c.req.param("id"));
  const runs = processManager.list().filter(r => r.projectId === c.req.param("id") && r.status === "running");
  return c.json({ commands, running: { dev: runs.find(r=>r.kind==="dev")?.runId ?? null,
                                       oneshot: runs.find(r=>r.kind==="oneshot")?.runId ?? null } });
});

app.post("/api/projects/:id/run", async (c) => {
  let body: { command?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  const key = String(body?.command ?? "");
  const commands = loadProjectCommands(repoRoot, c.req.param("id"));
  const cmd = (commands as Record<string,string|undefined>)[key];
  if (!key || !cmd) return c.json({ error: `command not configured: ${key}` }, 400);
  const local = <resolve local_path from registry/discovery for :id>;
  if (!local) return c.json({ error: `unknown project: ${c.req.param("id")}` }, 404);
  const kind = key === "dev" ? "dev" : "oneshot";
  try { const rec = processManager.start({ projectId: c.req.param("id"), kind, command: cmd, cwd: local });
        return c.json({ runId: rec.runId }, 201);
  } catch (err) {
    if (err instanceof SlotBusyError) return c.json({ error: err.message }, 409);
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/runs/:runId/stop", (c) => { processManager.stop(c.req.param("runId")); return c.json({ ok: true }); });

app.get("/api/runs/:runId", (c) => {
  const r = processManager.get(c.req.param("runId"));
  return r ? c.json(r) : c.json({ error: "not found" }, 404);
});

app.get("/api/runs/:runId/stream", (c) => streamSSE(c, async (stream) => {
  const snap = processManager.get(c.req.param("runId"));
  if (!snap) { await stream.writeSSE({ event: "error", data: "not found" }); return; }
  await stream.writeSSE({ event: "snapshot", data: JSON.stringify(snap) });
  await new Promise<void>((resolve) => {
    const unsub = processManager.subscribe(c.req.param("runId"), (e) => {
      stream.writeSSE({ event: e.type, data: JSON.stringify(e) }).catch(() => { unsub(); resolve(); });
    });
    stream.onAbort(() => { unsub(); resolve(); });
  });
}));
```

The `local_path` resolution reuses the registry (`loadRegistryProjects` exposes `repo_path`) and falls back
to discovery, exactly like `/api/overview` and `open-project.ts` resolve paths server-side — the client
never sends a path.

### `dashboard/src/ui/api.ts`

```ts
export async function listRuns(): Promise<{ runs: RunRecord[] }>;
export async function getProjectCommands(id: string): Promise<{ commands: ProjectCommands; running: {dev:string|null; oneshot:string|null} }>;
export async function runProject(id: string, command: string): Promise<{ runId: string }>; // throws on !ok (409/400 message)
export async function stopRun(runId: string): Promise<void>;
export async function getRun(runId: string): Promise<{ record: RunRecord; log: string }>;
export function streamRun(runId: string, on: { snapshot?: (s)=>void; chunk?: (d:string)=>void; status?: (r)=>void }): () => void; // EventSource; returns close()
```

### `dashboard/src/ui/views/ProcesosView.tsx` + `RunConsole.tsx`

- **ProcesosView**: polls `listRuns()` (e.g. every 2 s) for the project/slot status; lists configured
  projects (from overview/commands). Per project: the `dev` slot and the `oneshot` slot, each with a
  run control (a small menu/buttons for the available keys) + status dot + **Detener** when running.
  Selecting a run opens **RunConsole** for its `runId`.
- **RunConsole**: opens `streamRun(runId, …)`, renders the buffered + live log in a monospace, auto-scrolling
  pane (Estante mono, tabular). Shows status (running/exited/failed/stopped) and exit code. Closes the
  EventSource on unmount or when a terminal status arrives.

### `dashboard/src/ui/components/ProjectCard.tsx`

- A compact running indicator: when `listRuns()` (lifted to the app/overview poll) shows a running run for
  `p.id`, render `● dev` / `● <key>` chips (`.es-dot--ok` for dev, `.es-dot--info` for one-shot). No launch
  controls on the card in v1 — launching lives in Procesos (per the chosen UI).

## 6. Data Flow & State Transitions

`running → exited` (exit 0) | `running → failed` (exit ≠ 0 or spawn error) | `running → stopped` (user Stop).
Terminal states never transition again. Slots: a slot holds a `runId` only while `running`; cleared on any
terminal transition, freeing the slot for the next start. All state lives in the process-manager singleton;
the server holds no other run state; the UI is a pure view over `/api/runs` + the SSE stream.

## 7. Safety & Governance

- **Trusted commands only**: the client sends a key from a fixed set; the server resolves it against the
  registry `commands` map. No client string is ever executed. `cwd` is server-resolved from the registry/
  discovery, never client-supplied. This matches the existing `verify.ts` posture.
- **Process lifecycle**: children are spawned NOT detached, `windowsHide:true`, so they are tied to the
  dashboard and reaped when it exits — no orphaned dev servers. Stop is an explicit, reversible action
  (`taskkill /T /F` on Windows kills the tree so `npm run dev`'s node children don't linger).
- **Resource caps**: one dev + one one-shot per project; ~256 KB ring buffer per run; bounded run history.
- **No git, no network mutation, no agent, no secrets** beyond whatever the project's own command does. This
  is local developer tooling, not a deploy action — no approval gate (consistent with "open" actions; unlike
  approve/push which DO gate).

## 8. Error Handling

- `loadProjectCommands` never throws → `{}`; an unconfigured key → `400`.
- Unknown project (no `local_path`) → `404`.
- Slot busy → `409` with `slot busy: dev|oneshot`.
- Spawn failure → recorded as `status:"failed"` with the error in the log (the `POST /run` still returns the
  `runId`; the failure surfaces via the run state/stream, not as an HTTP 500), mirroring `verify.ts`.
- SSE: unknown `runId` → an `error` event then close. Client `streamRun` also exposes `getRun` for a
  non-streaming snapshot/refresh.
- UI surfaces `runProject`/`stopRun` errors inline (e.g. a banner in Procesos).

## 9. Testing (TDD)

- `runner/project-commands.test.ts`: full map; partial map (only some keys); unknown project → `{}`;
  missing/invalid registry → `{}`; non-string/empty values filtered out.
- `runner/process-manager.test.ts` (uses `node -e` for cross-platform child processes, injected `now`/`newId`):
  - `start` a quick command (`node -e "console.log('hi')"`) → record `running`, then on exit `exited`,
    exit code 0, and the log contains `hi`.
  - a failing command (`node -e "process.exit(3)"`) → `failed`, exitCode 3.
  - **slot enforcement**: starting a second `dev` while one is running → throws `SlotBusyError("dev")`;
    a `oneshot` alongside a `dev` is allowed; the slot frees after exit (a new start succeeds).
  - **subscribe**: a subscriber receives `chunk` events for output and a terminal `status` event; the
    snapshot via `get()` includes buffered output.
  - **stop**: with an injected `spawnSync` spy + `platform:"win32"`, `stop(runId)` calls
    `taskkill /PID <pid> /T /F` and marks the record `stopped`; `platform:"linux"` path calls `kill`.
    (A real long-running `node` child is started and stopped in one cross-platform test using the real
    kill path guarded to the host platform.)
  - **ring buffer**: output larger than the cap keeps only the tail (assert length ≤ cap and the last bytes
    present).
  - `stop`/`get` on an unknown runId → no throw / `null`.
- `dashboard/src/server/index.test.ts` (inject a fake process-manager into `createApp`, or pin
  `SURTEC_PROJECTS_ROOT` so no real spawn): `POST /run` with an unconfigured key → `400`; unknown project →
  `404`; slot busy → `409`; `GET /api/projects/:id/commands` returns the registry map; `GET /api/runs`
  returns the list; `POST /api/runs/:id/stop` → `{ ok:true }`. (Avoid launching real dev servers in route
  tests by injecting a fake manager.)
- `dashboard/src/ui/views/ProcesosView.test.tsx`: renders projects + slots from a stubbed `listRuns`/
  `getProjectCommands`; clicking a run control calls `runProject(id, key)`; a running slot shows **Detener**
  which calls `stopRun`.
- `dashboard/src/ui/components/RunConsole.test.tsx`: with a mocked `EventSource`, a `snapshot` then `chunk`
  events render the accumulated log; a terminal `status` shows the final state and closes the stream.
- `dashboard/src/ui/components/ProjectCard.test.tsx`: given a running run for the project, the `● dev`
  indicator renders; none → no indicator.

To make `createApp` testable with a fake process-manager, `createApp` gains an optional injected manager
(default `processManager` singleton), mirroring how it already injects `onTaskCreated`.

## 10. Evolution Path

- Persist run history (so Procesos shows past runs after a restart) + reconcile.
- ANSI color rendering in the console; search/filter; download log.
- Launch controls directly on the project cards (the "both" UI option), and bulk "run X across selected
  repos".
- Per-run env overrides; a custom-command palette (still registry-gated).
- Surface a clickable localhost URL for `dev` servers (parse the port from output).

## 11. Open Questions

None blocking. `dev` commands for the real repos are filled best-effort from each `package.json`; a wrong or
missing one is a one-line registry edit and the view degrades to "sin comandos". Windows tree-kill relies on
`taskkill` (always present on Windows); the POSIX path uses `process.kill`.
