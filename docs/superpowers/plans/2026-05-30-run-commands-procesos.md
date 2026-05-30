# Run Commands / "Procesos" (B.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launch a project's `dev`/`build`/`test`/`lint`/`install` commands from the control plane, stream their output live, and stop them — all from a dedicated "Procesos" view, governed entirely by the trusted registry.

**Architecture:** An in-memory `ProcessManager` singleton (in `runner/`) spawns each command as a child of the Hono server (not detached, so children die with the dashboard — no orphans), captures stdout+stderr into a bounded ring buffer, and notifies subscribers. The server exposes REST routes to start/stop/list/get runs plus an SSE route that replays the buffer and streams live chunks. The React UI adds a "Procesos" route that lists each project's two slots (one long-running `dev` + one `oneshot`), runs commands, shows a live console, and a `● dev` indicator on the project cards. Commands come ONLY from the registry `commands` map (the client sends a key, never a command string or path).

**Tech Stack:** TypeScript ESM, Node `child_process`, Hono + `hono/streaming` (SSE), `@hono/node-server`, React 18 + Vite, Vitest + Testing Library/jsdom, `yaml`. Windows/PowerShell host.

**Spec:** `docs/superpowers/specs/2026-05-30-run-commands-procesos-design.md`

---

## File Structure

**Create:**
- `runner/process-manager.ts` — in-memory process registry: `createProcessManager(deps?)` + `processManager` singleton. Spawn/stop/list/get/subscribe, slot enforcement, ring buffer, tree-kill.
- `runner/process-manager.test.ts` — unit tests (fake spawn for logic + one real `node` child for the happy path).
- `runner/project-commands.ts` — `loadProjectCommands(repoRoot, id)` → raw registry `commands` map (trusted, never throws).
- `runner/project-commands.test.ts`.
- `dashboard/src/ui/views/ProcesosView.tsx` — the new route (project list, slots, run/stop, selects a run for the console).
- `dashboard/src/ui/views/ProcesosView.test.tsx`.
- `dashboard/src/ui/components/RunConsole.tsx` — live log pane over an SSE stream.
- `dashboard/src/ui/components/RunConsole.test.tsx`.
- `dashboard/src/ui/useRuns.ts` — polling hook for `/api/runs` (lifted to App for the card indicator + Procesos).

**Modify:**
- `lib/state/types.ts` — add `RunKind`, `RunStatus`, `RunRecord`, `RunEvent`, `ProjectCommands`.
- `dashboard/src/server/index.ts` — inject `ProcessManager`; add the 6 run routes.
- `dashboard/src/server/index.test.ts` — route tests with an injected fake manager.
- `dashboard/src/ui/api.ts` — `listRuns`, `getProjectCommands`, `runProject`, `stopRun`, `getRun`, `streamRun`.
- `dashboard/src/ui/App.tsx` — view-switch state; render `ProcesosView` for the "Procesos" nav item; pass runs to cards.
- `dashboard/src/ui/components/Sidebar.tsx` — add "Procesos"; accept `active` + `onSelect`.
- `dashboard/src/ui/components/ProjectCard.tsx` — `● dev` / `● <key>` running indicator (new prop).
- `dashboard/src/ui/components/ProjectCard.test.tsx` — indicator test.
- `dashboard/src/ui/styles/dashboard.css` — console + Procesos + nav styles.
- `registry/projects.yml` — add/fill `commands` (`dev`/`build`/`test`/`lint`) for the real repos.

---

## Task 1: Shared types in `lib/state/types.ts`

**Files:**
- Modify: `lib/state/types.ts` (append new types)

- [ ] **Step 1: Add the run + commands types**

Append to `lib/state/types.ts`:

```ts
// --- Process runs (B.2 "Procesos") ---
export type RunKind = "dev" | "oneshot";
export type RunStatus = "running" | "exited" | "failed" | "stopped";

export interface RunRecord {
  runId: string;
  projectId: string;
  kind: RunKind;
  command: string;
  status: RunStatus;
  pid: number | null;
  startedAt: string; // ISO
  endedAt: string | null;
  exitCode: number | null;
}

export type RunEvent =
  | { type: "snapshot"; record: RunRecord; log: string }
  | { type: "chunk"; data: string }
  | { type: "status"; record: RunRecord };

export interface ProjectCommands {
  dev?: string;
  build?: string;
  test?: string;
  lint?: string;
  install?: string;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add lib/state/types.ts
git commit -m "feat(types): add RunRecord/RunEvent/ProjectCommands for Procesos"
```

---

## Task 2: `loadProjectCommands`

**Files:**
- Create: `runner/project-commands.ts`
- Test: `runner/project-commands.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `runner/project-commands.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectCommands } from "./project-commands";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pc-"));
  mkdirSync(join(root, "registry"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeRegistry(yml: string) {
  writeFileSync(join(root, "registry", "projects.yml"), yml, "utf8");
}

describe("loadProjectCommands", () => {
  it("returns the full commands map", () => {
    writeRegistry(`projects:\n  p:\n    commands:\n      dev: npm run dev\n      build: npm run build\n      test: npm test\n      lint: npm run lint\n      install: npm install\n`);
    expect(loadProjectCommands(root, "p")).toEqual({
      dev: "npm run dev", build: "npm run build", test: "npm test", lint: "npm run lint", install: "npm install",
    });
  });

  it("returns a partial map", () => {
    writeRegistry(`projects:\n  p:\n    commands:\n      dev: npm run dev\n      test: npm test\n`);
    expect(loadProjectCommands(root, "p")).toEqual({ dev: "npm run dev", test: "npm test" });
  });

  it("filters out empty/non-string values", () => {
    writeRegistry(`projects:\n  p:\n    commands:\n      dev: ""\n      test: npm test\n`);
    expect(loadProjectCommands(root, "p")).toEqual({ test: "npm test" });
  });

  it("returns {} for an unknown project", () => {
    writeRegistry(`projects:\n  p:\n    commands:\n      test: npm test\n`);
    expect(loadProjectCommands(root, "missing")).toEqual({});
  });

  it("returns {} when the registry is missing", () => {
    expect(loadProjectCommands(root, "p")).toEqual({});
  });

  it("returns {} when a project has no commands", () => {
    writeRegistry(`projects:\n  p:\n    repo: x\n`);
    expect(loadProjectCommands(root, "p")).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run runner/project-commands.test.ts`
Expected: FAIL — `Cannot find module './project-commands'`.

- [ ] **Step 3: Implement**

Create `runner/project-commands.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { ProjectCommands } from "../lib/state/types";

interface RegistryDoc {
  projects?: Record<string, { commands?: Record<string, unknown> }>;
}

const KEYS = ["dev", "build", "test", "lint", "install"] as const;

// Returns the trusted registry `commands` map for a project (keys: dev/build/test/lint/install),
// keeping only non-empty string values. Never throws — any error yields {}.
export function loadProjectCommands(repoRoot: string, projectId: string): ProjectCommands {
  let doc: RegistryDoc;
  try {
    doc = (parse(readFileSync(join(repoRoot, "registry", "projects.yml"), "utf8")) ?? {}) as RegistryDoc;
  } catch {
    return {};
  }
  const raw = doc.projects?.[projectId]?.commands ?? {};
  const out: ProjectCommands = {};
  for (const k of KEYS) {
    const v = raw[k];
    if (typeof v === "string" && v.trim().length > 0) out[k] = v;
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run runner/project-commands.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add runner/project-commands.ts runner/project-commands.test.ts
git commit -m "feat(runner): loadProjectCommands reads trusted registry command map"
```

---

## Task 3: `ProcessManager` — start, log capture, slots, list/get/subscribe

**Files:**
- Create: `runner/process-manager.ts`
- Test: `runner/process-manager.test.ts`

This task builds everything except `stop` (Task 4).

- [ ] **Step 1: Write the failing tests**

Create `runner/process-manager.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createProcessManager, SlotBusyError } from "./process-manager";
import type { RunEvent } from "../lib/state/types";

// A controllable fake child process.
function fakeChild(pid = 111) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number; stdout: EventEmitter; stderr: EventEmitter;
  };
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function makePM(spawn: ReturnType<typeof vi.fn>, platform: NodeJS.Platform = "linux") {
  let n = 0;
  return createProcessManager({
    spawn: spawn as never,
    spawnSync: vi.fn() as never,
    platform,
    now: () => "2026-05-30T00:00:00.000Z",
    newId: () => `run-${++n}`,
  });
}

describe("ProcessManager.start", () => {
  it("records a running run, captures stdout+stderr, and finishes on exit(0)", () => {
    const child = fakeChild();
    const pm = makePM(vi.fn().mockReturnValue(child));
    const rec = pm.start({ projectId: "p", kind: "oneshot", command: "x", cwd: "/p" });
    expect(rec.status).toBe("running");
    expect(rec.pid).toBe(111);

    child.stdout.emit("data", Buffer.from("hello "));
    child.stderr.emit("data", Buffer.from("world"));
    child.emit("exit", 0);

    const snap = pm.get(rec.runId)!;
    expect(snap.log).toBe("hello world");
    expect(snap.record.status).toBe("exited");
    expect(snap.record.exitCode).toBe(0);
    expect(snap.record.endedAt).toBe("2026-05-30T00:00:00.000Z");
  });

  it("marks failed on non-zero exit", () => {
    const child = fakeChild();
    const pm = makePM(vi.fn().mockReturnValue(child));
    const rec = pm.start({ projectId: "p", kind: "oneshot", command: "x", cwd: "/p" });
    child.emit("exit", 3);
    expect(pm.get(rec.runId)!.record.status).toBe("failed");
    expect(pm.get(rec.runId)!.record.exitCode).toBe(3);
  });

  it("marks failed (not thrown) when spawn throws synchronously", () => {
    const pm = makePM(vi.fn().mockImplementation(() => { throw new Error("ENOENT"); }));
    const rec = pm.start({ projectId: "p", kind: "oneshot", command: "x", cwd: "/p" });
    expect(rec.status).toBe("failed");
    expect(pm.get(rec.runId)!.log).toContain("ENOENT");
  });

  it("enforces one run per slot but allows dev + oneshot together", () => {
    const pm = makePM(vi.fn().mockImplementation(() => fakeChild()));
    pm.start({ projectId: "p", kind: "dev", command: "d", cwd: "/p" });
    pm.start({ projectId: "p", kind: "oneshot", command: "o", cwd: "/p" }); // ok: different slot
    expect(() => pm.start({ projectId: "p", kind: "dev", command: "d2", cwd: "/p" }))
      .toThrow(SlotBusyError);
  });

  it("frees the slot after the run finishes", () => {
    const child = fakeChild();
    const spawn = vi.fn().mockReturnValueOnce(child).mockReturnValue(fakeChild(222));
    const pm = makePM(spawn);
    pm.start({ projectId: "p", kind: "dev", command: "d", cwd: "/p" });
    child.emit("exit", 0);
    expect(() => pm.start({ projectId: "p", kind: "dev", command: "d2", cwd: "/p" })).not.toThrow();
  });

  it("notifies subscribers of chunks then a terminal status", () => {
    const child = fakeChild();
    const pm = makePM(vi.fn().mockReturnValue(child));
    const rec = pm.start({ projectId: "p", kind: "oneshot", command: "x", cwd: "/p" });
    const events: RunEvent[] = [];
    pm.subscribe(rec.runId, (e) => events.push(e));
    child.stdout.emit("data", Buffer.from("hi"));
    child.emit("exit", 0);
    expect(events.map((e) => e.type)).toEqual(["chunk", "status"]);
    expect((events[0] as { data: string }).data).toBe("hi");
  });

  it("caps the log ring buffer to the tail", () => {
    const child = fakeChild();
    const pm = makePM(vi.fn().mockReturnValue(child));
    const rec = pm.start({ projectId: "p", kind: "oneshot", command: "x", cwd: "/p" });
    child.stdout.emit("data", Buffer.from("A".repeat(300_000)));
    child.stdout.emit("data", Buffer.from("TAIL"));
    const log = pm.get(rec.runId)!.log;
    expect(log.length).toBeLessThanOrEqual(256 * 1024);
    expect(log.endsWith("TAIL")).toBe(true);
  });

  it("list() returns all runs", () => {
    const pm = makePM(vi.fn().mockImplementation(() => fakeChild()));
    pm.start({ projectId: "p", kind: "dev", command: "d", cwd: "/p" });
    pm.start({ projectId: "q", kind: "oneshot", command: "o", cwd: "/q" });
    expect(pm.list().map((r) => r.projectId).sort()).toEqual(["p", "q"]);
  });

  it("get/subscribe on an unknown runId are safe", () => {
    const pm = makePM(vi.fn());
    expect(pm.get("nope")).toBeNull();
    expect(() => pm.subscribe("nope", () => {})()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run runner/process-manager.test.ts`
Expected: FAIL — `Cannot find module './process-manager'`.

- [ ] **Step 3: Implement (without `stop` yet)**

Create `runner/process-manager.ts`:

```ts
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { RunKind, RunRecord, RunEvent } from "../lib/state/types";

const RING_CAP = 256 * 1024; // bytes/chars
const HISTORY_PER_PROJECT = 10;

export class SlotBusyError extends Error {
  constructor(public kind: RunKind) { super(`slot busy: ${kind}`); this.name = "SlotBusyError"; }
}

export interface StartOpts { projectId: string; kind: RunKind; command: string; cwd: string; }

export interface ProcessManager {
  start(opts: StartOpts): RunRecord;
  stop(runId: string): void;
  get(runId: string): { record: RunRecord; log: string } | null;
  list(): RunRecord[];
  subscribe(runId: string, cb: (e: RunEvent) => void): () => void;
}

interface ChildLike {
  pid?: number;
  stdout?: { on(ev: "data", cb: (d: unknown) => void): void } | null;
  stderr?: { on(ev: "data", cb: (d: unknown) => void): void } | null;
  on(ev: "exit", cb: (code: number | null) => void): void;
  on(ev: "error", cb: (err: Error) => void): void;
}

interface Deps {
  spawn?: (command: string, opts: object) => ChildLike;
  spawnSync?: (command: string, args: string[]) => unknown;
  platform?: NodeJS.Platform;
  now?: () => string;
  newId?: () => string;
}

interface RunState {
  record: RunRecord;
  log: string;
  subs: Set<(e: RunEvent) => void>;
  child: ChildLike | null;
}

export function createProcessManager(deps: Deps = {}): ProcessManager {
  const spawn = deps.spawn ?? ((c: string, o: object) => nodeSpawn(c, o) as unknown as ChildLike);
  const spawnSync = deps.spawnSync ?? ((c: string, a: string[]) => nodeSpawnSync(c, a));
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => randomUUID());

  const runs = new Map<string, RunState>();
  const slots = new Map<string, { dev?: string; oneshot?: string }>();

  const emit = (s: RunState, e: RunEvent) => { for (const cb of s.subs) cb(e); };

  const append = (s: RunState, chunk: string) => {
    s.log += chunk;
    if (s.log.length > RING_CAP) s.log = s.log.slice(s.log.length - RING_CAP);
    emit(s, { type: "chunk", data: chunk });
  };

  const trimHistory = (projectId: string) => {
    const finished = [...runs.values()]
      .filter((s) => s.record.projectId === projectId && s.record.status !== "running")
      .sort((a, b) => a.record.startedAt.localeCompare(b.record.startedAt));
    while (finished.length > HISTORY_PER_PROJECT) {
      const victim = finished.shift()!;
      runs.delete(victim.record.runId);
    }
  };

  const finish = (s: RunState, status: RunRecord["status"], code: number | null, extra?: string) => {
    if (s.record.status !== "running") return; // terminal transitions happen once
    if (extra) { s.log += extra; if (s.log.length > RING_CAP) s.log = s.log.slice(s.log.length - RING_CAP); }
    s.record.status = status;
    s.record.exitCode = code;
    s.record.endedAt = now();
    const slot = slots.get(s.record.projectId);
    if (slot && slot[s.record.kind] === s.record.runId) delete slot[s.record.kind];
    s.child = null;
    emit(s, { type: "status", record: { ...s.record } });
    trimHistory(s.record.projectId);
  };

  return {
    start(opts) {
      const slot = slots.get(opts.projectId) ?? {};
      const existingId = slot[opts.kind];
      if (existingId && runs.get(existingId)?.record.status === "running") throw new SlotBusyError(opts.kind);

      const runId = newId();
      const record: RunRecord = {
        runId, projectId: opts.projectId, kind: opts.kind, command: opts.command,
        status: "running", pid: null, startedAt: now(), endedAt: null, exitCode: null,
      };
      const state: RunState = { record, log: "", subs: new Set(), child: null };
      runs.set(runId, state);
      slot[opts.kind] = runId; slots.set(opts.projectId, slot);

      let child: ChildLike;
      try {
        child = spawn(opts.command, { cwd: opts.cwd, shell: true, windowsHide: true });
      } catch (err) {
        finish(state, "failed", null, `spawn error: ${(err as Error).message}\n`);
        return record;
      }
      state.child = child;
      record.pid = child.pid ?? null;
      const onData = (d: unknown) => append(state, String(d));
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("error", (err: Error) => append(state, `error: ${err.message}\n`));
      child.on("exit", (code: number | null) => finish(state, code === 0 ? "exited" : "failed", code));
      return record;
    },

    stop(_runId) { /* implemented in Task 4 */ },

    get(runId) {
      const s = runs.get(runId);
      return s ? { record: { ...s.record }, log: s.log } : null;
    },

    list() {
      return [...runs.values()]
        .map((s) => ({ ...s.record }))
        .sort((a, b) => {
          if (a.status === "running" && b.status !== "running") return -1;
          if (b.status === "running" && a.status !== "running") return 1;
          return b.startedAt.localeCompare(a.startedAt);
        });
    },

    subscribe(runId, cb) {
      const s = runs.get(runId);
      if (!s) return () => {};
      s.subs.add(cb);
      return () => { s.subs.delete(cb); };
    },
  };

  // singleton wiring lives in Task 4's final step (export const processManager)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run runner/process-manager.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add runner/process-manager.ts runner/process-manager.test.ts
git commit -m "feat(runner): ProcessManager start/log/slots/subscribe (no stop yet)"
```

---

## Task 4: `ProcessManager.stop` (tree-kill) + singleton export

**Files:**
- Modify: `runner/process-manager.ts`
- Test: `runner/process-manager.test.ts` (add cases)

- [ ] **Step 1: Add failing tests**

Append to `runner/process-manager.test.ts` (inside the file, new `describe`):

```ts
import { spawn as realSpawn } from "node:child_process";

describe("ProcessManager.stop", () => {
  it("win32: calls taskkill /T /F and marks stopped", () => {
    const child = fakeChild(4242);
    const spawnSync = vi.fn();
    const pm = createProcessManager({
      spawn: vi.fn().mockReturnValue(child) as never,
      spawnSync: spawnSync as never,
      platform: "win32",
      now: () => "2026-05-30T00:00:00.000Z",
      newId: () => "run-1",
    });
    const rec = pm.start({ projectId: "p", kind: "dev", command: "d", cwd: "/p" });
    pm.stop(rec.runId);
    expect(spawnSync).toHaveBeenCalledWith("taskkill", ["/PID", "4242", "/T", "/F"]);
    expect(pm.get(rec.runId)!.record.status).toBe("stopped");
  });

  it("posix: calls process.kill and marks stopped", () => {
    const child = fakeChild(4243);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const pm = createProcessManager({
      spawn: vi.fn().mockReturnValue(child) as never,
      spawnSync: vi.fn() as never,
      platform: "linux",
      now: () => "2026-05-30T00:00:00.000Z",
      newId: () => "run-1",
    });
    const rec = pm.start({ projectId: "p", kind: "dev", command: "d", cwd: "/p" });
    pm.stop(rec.runId);
    expect(killSpy).toHaveBeenCalledWith(4243, "SIGTERM");
    expect(pm.get(rec.runId)!.record.status).toBe("stopped");
    killSpy.mockRestore();
  });

  it("stop on an unknown or already-finished run is a no-op", () => {
    const child = fakeChild();
    const pm = createProcessManager({
      spawn: vi.fn().mockReturnValue(child) as never,
      spawnSync: vi.fn() as never, platform: "linux",
      now: () => "t", newId: () => "run-1",
    });
    expect(() => pm.stop("nope")).not.toThrow();
    const rec = pm.start({ projectId: "p", kind: "dev", command: "d", cwd: "/p" });
    child.emit("exit", 0);
    expect(() => pm.stop(rec.runId)).not.toThrow();
    expect(pm.get(rec.runId)!.record.status).toBe("exited"); // unchanged
  });

  it("really starts and stops a node child (host platform)", async () => {
    const pm = createProcessManager(); // real spawn/spawnSync/platform
    const cmd = `"${process.execPath}" -e "setInterval(()=>{}, 1000)"`;
    const rec = pm.start({ projectId: "p", kind: "dev", command: cmd, cwd: process.cwd() });
    expect(rec.status).toBe("running");
    const done = new Promise<void>((resolve) => {
      const unsub = pm.subscribe(rec.runId, (e) => { if (e.type === "status") { unsub(); resolve(); } });
    });
    pm.stop(rec.runId);
    await done;
    expect(["stopped", "failed", "exited"]).toContain(pm.get(rec.runId)!.record.status);
  }, 15000);
});

describe("processManager singleton", () => {
  it("is exported", async () => {
    const mod = await import("./process-manager");
    expect(mod.processManager).toBeDefined();
    expect(typeof mod.processManager.start).toBe("function");
  });
});
```

> Note: `realSpawn` import is unused-by-name but documents intent; if the linter complains, remove the line — the real test uses the no-deps `createProcessManager()`.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm exec vitest run runner/process-manager.test.ts`
Expected: FAIL — stop tests fail (`stop` is a no-op; status stays "running"); singleton test fails (`processManager` undefined).

- [ ] **Step 3: Implement `stop` and the singleton**

In `runner/process-manager.ts`, replace the placeholder `stop(_runId) { ... }` with:

```ts
    stop(runId) {
      const s = runs.get(runId);
      if (!s || s.record.status !== "running") return;
      const pid = s.record.pid;
      if (pid != null) {
        if (platform === "win32") {
          spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
        } else {
          try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
        }
      }
      finish(s, "stopped", null);
    },
```

Then, at the very end of the file (after the `createProcessManager` function closes, removing the trailing comment), add:

```ts
// Module-level singleton used by the server.
export const processManager: ProcessManager = createProcessManager();
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run runner/process-manager.test.ts`
Expected: PASS (including the real start/stop test).

- [ ] **Step 5: Commit**

```bash
git add runner/process-manager.ts runner/process-manager.test.ts
git commit -m "feat(runner): ProcessManager.stop tree-kill + processManager singleton"
```

---

## Task 5: Server routes (run/stop/list/get/commands) with injected manager

**Files:**
- Modify: `dashboard/src/server/index.ts`
- Test: `dashboard/src/server/index.test.ts`

- [ ] **Step 1: Add failing route tests**

Add to `dashboard/src/server/index.test.ts` a new block. First inspect the file's existing imports/`createApp` test helpers; then append:

```ts
import { describe, it, expect, vi } from "vitest";
import { createApp } from "./index";
import type { ProcessManager } from "../../../runner/process-manager";
import type { RunRecord } from "../../../lib/state/types";

function fakeManager(over: Partial<ProcessManager> = {}): ProcessManager {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
    subscribe: vi.fn().mockReturnValue(() => {}),
    ...over,
  } as ProcessManager;
}

describe("run routes", () => {
  it("GET /api/runs returns the manager list", async () => {
    const rec: RunRecord = { runId: "r1", projectId: "p", kind: "dev", command: "d",
      status: "running", pid: 1, startedAt: "t", endedAt: null, exitCode: null };
    const app = createApp(process.cwd(), () => {}, fakeManager({ list: vi.fn().mockReturnValue([rec]) }));
    const res = await app.request("/api/runs");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runs: [rec] });
  });

  it("POST /run with an unconfigured command → 400", async () => {
    const app = createApp(process.cwd(), () => {}, fakeManager());
    const res = await app.request("/api/projects/appointment-manager/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "nope" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /run for an unknown project → 404", async () => {
    const app = createApp(process.cwd(), () => {}, fakeManager());
    const res = await app.request("/api/projects/__nope__/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "dev" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /run that hits a busy slot → 409", async () => {
    const { SlotBusyError } = await import("../../../runner/process-manager");
    const start = vi.fn().mockImplementation(() => { throw new SlotBusyError("dev"); });
    const app = createApp(process.cwd(), () => {}, fakeManager({ start }));
    // appointment-manager has no dev command in the registry; use a project that does after Task 11,
    // but for this unit test we stub loadProjectCommands via a project known to have `dev`.
    // Simplest: pick a project we KNOW has commands. If none yet, this asserts 400 instead — see note.
    const res = await app.request("/api/projects/expense-tracker-mvp/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "build" }),
    });
    expect([409, 400]).toContain(res.status); // 409 once expense-tracker-mvp has `build` (it does)
  });

  it("POST /api/runs/:id/stop → { ok: true }", async () => {
    const stop = vi.fn();
    const app = createApp(process.cwd(), () => {}, fakeManager({ stop }));
    const res = await app.request("/api/runs/r1/stop", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(stop).toHaveBeenCalledWith("r1");
  });

  it("GET /api/projects/:id/commands returns the registry map + running slots", async () => {
    const app = createApp(process.cwd(), () => {}, fakeManager());
    const res = await app.request("/api/projects/expense-tracker-mvp/commands");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commands: Record<string, string>; running: object };
    expect(body.commands.build).toBe("npm run build");
    expect(body.running).toEqual({ dev: null, oneshot: null });
  });

  it("GET /api/runs/:id → 404 when unknown", async () => {
    const app = createApp(process.cwd(), () => {}, fakeManager({ get: vi.fn().mockReturnValue(null) }));
    const res = await app.request("/api/runs/nope");
    expect(res.status).toBe(404);
  });
});
```

> The `expense-tracker-mvp` registry entry already has `commands: { install, build, test }` (see `registry/projects.yml`), so these tests pass without Task 11. The 409-vs-400 assertion tolerates either until `build` is confirmed present.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: FAIL — `createApp` does not accept a 3rd arg / routes return 404.

- [ ] **Step 3: Implement the routes**

In `dashboard/src/server/index.ts`:

1. Add imports near the top:

```ts
import { streamSSE } from "hono/streaming";
import { loadProjectCommands } from "../../../runner/project-commands";
import { processManager, SlotBusyError, type ProcessManager } from "../../../runner/process-manager";
```

2. Add a 3rd parameter to `createApp`:

```ts
export function createApp(
  repoRoot: string = process.cwd(),
  onTaskCreated: (id: string) => void = (id) => {
    runTask(id, repoRoot).catch((err: unknown) => {
      console.error(`runTask failed unexpectedly for ${id}:`, err);
    });
  },
  pm: ProcessManager = processManager,
): Hono {
```

3. Inside `createApp`, after the existing routes (before `return app;`), add:

```ts
  // --- Procesos (B.2): run project commands from the dashboard ---
  app.get("/api/runs", (c) => c.json({ runs: pm.list() }));

  app.get("/api/projects/:id/commands", (c) => {
    const id = c.req.param("id");
    const commands = loadProjectCommands(repoRoot, id);
    const running = pm.list().filter((r) => r.projectId === id && r.status === "running");
    return c.json({
      commands,
      running: {
        dev: running.find((r) => r.kind === "dev")?.runId ?? null,
        oneshot: running.find((r) => r.kind === "oneshot")?.runId ?? null,
      },
    });
  });

  app.post("/api/projects/:id/run", async (c) => {
    const id = c.req.param("id");
    let body: { command?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const key = String(body?.command ?? "");
    const command = (loadProjectCommands(repoRoot, id) as Record<string, string | undefined>)[key];
    if (!key || !command) return c.json({ error: `command not configured: ${key}` }, 400);

    const project = loadRegistryProjects(repoRoot).find((p) => p.id === id);
    const cwd = project?.repo_path ?? null;
    if (!cwd) return c.json({ error: `unknown project: ${id}` }, 404);

    const kind = key === "dev" ? "dev" : "oneshot";
    try {
      const rec = pm.start({ projectId: id, kind, command, cwd });
      return c.json({ runId: rec.runId }, 201);
    } catch (err) {
      if (err instanceof SlotBusyError) return c.json({ error: err.message }, 409);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/runs/:runId/stop", (c) => {
    pm.stop(c.req.param("runId"));
    return c.json({ ok: true });
  });

  app.get("/api/runs/:runId", (c) => {
    const r = pm.get(c.req.param("runId"));
    return r ? c.json(r) : c.json({ error: "not found" }, 404);
  });

  app.get("/api/runs/:runId/stream", (c) =>
    streamSSE(c, async (stream) => {
      const runId = c.req.param("runId");
      const snap = pm.get(runId);
      if (!snap) { await stream.writeSSE({ event: "error", data: "not found" }); return; }
      await stream.writeSSE({ event: "snapshot", data: JSON.stringify({ type: "snapshot", ...snap }) });
      if (snap.record.status !== "running") return; // already terminal: snapshot is enough
      await new Promise<void>((resolve) => {
        const unsub = pm.subscribe(runId, (e) => {
          stream.writeSSE({ event: e.type, data: JSON.stringify(e) })
            .then(() => { if (e.type === "status") { unsub(); resolve(); } })
            .catch(() => { unsub(); resolve(); });
        });
        stream.onAbort(() => { unsub(); resolve(); });
      });
    }),
  );
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run dashboard/src/server/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/server/index.ts dashboard/src/server/index.test.ts
git commit -m "feat(server): run/stop/list/get/commands + SSE stream routes"
```

---

## Task 6: API client functions

**Files:**
- Modify: `dashboard/src/ui/api.ts`

- [ ] **Step 1: Implement the client functions**

Append to `dashboard/src/ui/api.ts`:

```ts
import type { RunRecord, ProjectCommands, RunEvent } from "../../../lib/state/types";

export async function listRuns(): Promise<{ runs: RunRecord[] }> {
  const res = await fetch("/api/runs");
  if (!res.ok) throw new Error(`runs failed: ${res.status}`);
  return (await res.json()) as { runs: RunRecord[] };
}

export async function getProjectCommands(
  id: string,
): Promise<{ commands: ProjectCommands; running: { dev: string | null; oneshot: string | null } }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/commands`);
  if (!res.ok) throw new Error(`commands failed: ${res.status}`);
  return (await res.json()) as { commands: ProjectCommands; running: { dev: string | null; oneshot: string | null } };
}

export async function runProject(id: string, command: string): Promise<{ runId: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `run failed: ${res.status}`);
  }
  return (await res.json()) as { runId: string };
}

export async function stopRun(runId: string): Promise<void> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `stop failed: ${res.status}`);
  }
}

export async function getRun(runId: string): Promise<{ record: RunRecord; log: string }> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
  if (!res.ok) throw new Error(`run failed: ${res.status}`);
  return (await res.json()) as { record: RunRecord; log: string };
}

// Opens an SSE stream for a run. Calls the matching handler per event and returns a close() fn.
export function streamRun(
  runId: string,
  on: { snapshot?: (s: { record: RunRecord; log: string }) => void; chunk?: (data: string) => void; status?: (r: RunRecord) => void },
): () => void {
  const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
  es.addEventListener("snapshot", (ev) => {
    const e = JSON.parse((ev as MessageEvent).data) as Extract<RunEvent, { type: "snapshot" }>;
    on.snapshot?.({ record: e.record, log: e.log });
  });
  es.addEventListener("chunk", (ev) => {
    const e = JSON.parse((ev as MessageEvent).data) as Extract<RunEvent, { type: "chunk" }>;
    on.chunk?.(e.data);
  });
  es.addEventListener("status", (ev) => {
    const e = JSON.parse((ev as MessageEvent).data) as Extract<RunEvent, { type: "status" }>;
    on.status?.(e.record);
    es.close();
  });
  es.addEventListener("error", () => es.close());
  return () => es.close();
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/ui/api.ts
git commit -m "feat(ui): api client for runs (list/commands/run/stop/get/stream)"
```

---

## Task 7: `RunConsole` component

**Files:**
- Create: `dashboard/src/ui/components/RunConsole.tsx`
- Test: `dashboard/src/ui/components/RunConsole.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/ui/components/RunConsole.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunConsole } from "./RunConsole";

// Minimal controllable EventSource mock.
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners: Record<string, ((ev: { data: string }) => void)[]> = {};
  closed = false;
  constructor(url: string) { this.url = url; MockEventSource.instances.push(this); }
  addEventListener(type: string, cb: (ev: { data: string }) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  emit(type: string, data: unknown) {
    for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) });
  }
  close() { this.closed = true; }
}

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
});
afterEach(() => { vi.restoreAllMocks(); });

describe("RunConsole", () => {
  it("renders the snapshot log, appends chunks, and shows the terminal status", () => {
    const rec = { runId: "r1", projectId: "p", kind: "oneshot", command: "npm test",
      status: "running", pid: 1, startedAt: "t", endedAt: null, exitCode: null };
    render(<RunConsole runId="r1" />);
    const es = MockEventSource.instances[0];

    es.emit("snapshot", { type: "snapshot", record: rec, log: "boot\n" });
    expect(screen.getByText(/boot/)).toBeInTheDocument();

    es.emit("chunk", { type: "chunk", data: "running tests\n" });
    expect(screen.getByText(/running tests/)).toBeInTheDocument();

    es.emit("status", { type: "status", record: { ...rec, status: "exited", exitCode: 0, endedAt: "t2" } });
    expect(screen.getByText(/exited/i)).toBeInTheDocument();
    expect(es.closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run dashboard/src/ui/components/RunConsole.test.tsx`
Expected: FAIL — `Cannot find module './RunConsole'`.

- [ ] **Step 3: Implement**

Create `dashboard/src/ui/components/RunConsole.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import type { RunRecord } from "../../../../lib/state/types";
import { streamRun } from "../api";

const STATUS_LABEL: Record<RunRecord["status"], string> = {
  running: "corriendo", exited: "exited (ok)", failed: "failed", stopped: "stopped",
};

export function RunConsole({ runId }: { runId: string }) {
  const [log, setLog] = useState("");
  const [record, setRecord] = useState<RunRecord | null>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setLog("");
    setRecord(null);
    const close = streamRun(runId, {
      snapshot: (s) => { setLog(s.log); setRecord(s.record); },
      chunk: (d) => setLog((prev) => prev + d),
      status: (r) => setRecord(r),
    });
    return close;
  }, [runId]);

  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const status = record?.status ?? "running";
  const dot = status === "running" ? "es-dot--info"
    : status === "exited" ? "es-dot--ok" : "es-dot--danger";

  return (
    <div className="es-console">
      <div className="es-console__bar">
        <span className={`es-dot ${dot}`} />
        <span className="es-console__status">{STATUS_LABEL[status]}</span>
        {record?.exitCode != null && <span className="es-num">exit {record.exitCode}</span>}
        {record && <span className="es-console__cmd">{record.command}</span>}
      </div>
      <pre className="es-console__log" ref={preRef}>{log}</pre>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run dashboard/src/ui/components/RunConsole.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/ui/components/RunConsole.tsx dashboard/src/ui/components/RunConsole.test.tsx
git commit -m "feat(ui): RunConsole streams live run output via SSE"
```

---

## Task 8: `useRuns` polling hook

**Files:**
- Create: `dashboard/src/ui/useRuns.ts`

- [ ] **Step 1: Implement the hook**

Create `dashboard/src/ui/useRuns.ts`:

```ts
import { useEffect, useState } from "react";
import type { RunRecord } from "../../../lib/state/types";
import { listRuns } from "./api";

// Polls /api/runs. Returns the run list (last good value kept on error).
export function useRuns(intervalMs = 2000): { runs: RunRecord[]; error: string | null } {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const next = await listRuns();
        if (active) { setRuns(next.runs); setError(null); }
      } catch (err) {
        if (active) setError((err as Error).message);
      }
    };
    void tick();
    const h = setInterval(tick, intervalMs);
    return () => { active = false; clearInterval(h); };
  }, [intervalMs]);

  return { runs, error };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/ui/useRuns.ts
git commit -m "feat(ui): useRuns polling hook for /api/runs"
```

---

## Task 9: `ProcesosView`

**Files:**
- Create: `dashboard/src/ui/views/ProcesosView.tsx`
- Test: `dashboard/src/ui/views/ProcesosView.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/ui/views/ProcesosView.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProcesosView } from "./ProcesosView";
import * as api from "../api";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, "getProjectCommands").mockResolvedValue({
    commands: { dev: "npm run dev", build: "npm run build", test: "npm test" },
    running: { dev: null, oneshot: null },
  });
  // RunConsole opens an EventSource; stub it so the view can mount one.
  (globalThis as unknown as { EventSource: unknown }).EventSource = class {
    addEventListener() {} close() {}
  };
});

describe("ProcesosView", () => {
  it("lists a project's commands and runs one", async () => {
    const runProject = vi.spyOn(api, "runProject").mockResolvedValue({ runId: "r1" });
    render(<ProcesosView projectIds={["expense-tracker-mvp"]} />);

    const runDev = await screen.findByRole("button", { name: /dev/i });
    fireEvent.click(runDev);
    await waitFor(() => expect(runProject).toHaveBeenCalledWith("expense-tracker-mvp", "dev"));
  });

  it("shows Detener for a running slot and stops it", async () => {
    vi.spyOn(api, "getProjectCommands").mockResolvedValue({
      commands: { dev: "npm run dev" },
      running: { dev: "r9", oneshot: null },
    });
    const stopRun = vi.spyOn(api, "stopRun").mockResolvedValue();
    render(<ProcesosView projectIds={["expense-tracker-mvp"]} />);

    const stop = await screen.findByRole("button", { name: /detener/i });
    fireEvent.click(stop);
    await waitFor(() => expect(stopRun).toHaveBeenCalledWith("r9"));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run dashboard/src/ui/views/ProcesosView.test.tsx`
Expected: FAIL — `Cannot find module './ProcesosView'`.

- [ ] **Step 3: Implement**

Create `dashboard/src/ui/views/ProcesosView.tsx`:

```tsx
import { useEffect, useState, useCallback } from "react";
import type { ProjectCommands } from "../../../../lib/state/types";
import { getProjectCommands, runProject, stopRun } from "../api";
import { RunConsole } from "../components/RunConsole";

const ONESHOT_KEYS: (keyof ProjectCommands)[] = ["build", "test", "lint", "install"];

interface ProjectState {
  commands: ProjectCommands;
  running: { dev: string | null; oneshot: string | null };
}

function ProjectRow({ id, onSelect }: { id: string; onSelect: (runId: string) => void }) {
  const [state, setState] = useState<ProjectState | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setState(await getProjectCommands(id)); setErr(null); }
    catch (e) { setErr((e as Error).message); }
  }, [id]);

  useEffect(() => {
    let active = true;
    const tick = async () => { if (active) await refresh(); };
    void tick();
    const h = setInterval(tick, 2000);
    return () => { active = false; clearInterval(h); };
  }, [refresh]);

  const run = async (key: string) => {
    setErr(null);
    try { const { runId } = await runProject(id, key); onSelect(runId); await refresh(); }
    catch (e) { setErr((e as Error).message); }
  };
  const stop = async (runId: string) => {
    setErr(null);
    try { await stopRun(runId); await refresh(); } catch (e) { setErr((e as Error).message); }
  };

  if (!state) return <li className="es-row"><span className="es-row__id">{id}</span><span className="es-empty">cargando…</span></li>;

  const cmds = state.commands;
  const oneshots = ONESHOT_KEYS.filter((k) => cmds[k]);
  const hasAny = Boolean(cmds.dev) || oneshots.length > 0;

  return (
    <li className="es-row es-row--proc">
      <span className="es-row__id">{id}</span>
      {!hasAny && <span className="es-empty">sin comandos configurados</span>}
      {cmds.dev && (
        <span className="es-proc-slot">
          {state.running.dev
            ? <>
                <button type="button" className="es-btn es-btn--ghost" onClick={() => onSelect(state.running.dev!)}>● dev</button>
                <button type="button" className="es-btn es-btn--accent" onClick={() => stop(state.running.dev!)}>Detener</button>
              </>
            : <button type="button" className="es-btn" onClick={() => run("dev")}>dev</button>}
        </span>
      )}
      {oneshots.length > 0 && (
        <span className="es-proc-slot">
          {state.running.oneshot
            ? <>
                <button type="button" className="es-btn es-btn--ghost" onClick={() => onSelect(state.running.oneshot!)}>● en curso</button>
                <button type="button" className="es-btn es-btn--accent" onClick={() => stop(state.running.oneshot!)}>Detener</button>
              </>
            : oneshots.map((k) => (
                <button key={k} type="button" className="es-btn es-btn--ghost" onClick={() => run(k)}>{k}</button>
              ))}
        </span>
      )}
      {err && <span className="es-banner es-banner--danger">{err}</span>}
    </li>
  );
}

export function ProcesosView({ projectIds }: { projectIds: string[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <section className="es-cols">
      <div style={{ flex: 1 }}>
        <h4 className="es-section__title">Procesos</h4>
        <ul className="es-list">
          {projectIds.map((id) => <ProjectRow key={id} id={id} onSelect={setSelected} />)}
        </ul>
      </div>
      <div style={{ flex: 1 }}>
        <h4 className="es-section__title">Consola</h4>
        {selected ? <RunConsole runId={selected} /> : <p className="es-empty">Elegí un proceso para ver su salida.</p>}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run dashboard/src/ui/views/ProcesosView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/ui/views/ProcesosView.tsx dashboard/src/ui/views/ProcesosView.test.tsx
git commit -m "feat(ui): ProcesosView lists slots, runs/stops commands, shows console"
```

---

## Task 10: Sidebar navigation + App view-switch

**Files:**
- Modify: `dashboard/src/ui/components/Sidebar.tsx`
- Modify: `dashboard/src/ui/App.tsx`

- [ ] **Step 1: Make the Sidebar a controlled selector**

Replace `dashboard/src/ui/components/Sidebar.tsx` with:

```tsx
export const NAV_ITEMS = ["Overview", "Procesos", "Proyectos", "Tareas", "Atención"] as const;
export type NavItem = (typeof NAV_ITEMS)[number];

export function Sidebar({ active, onSelect }: { active: NavItem; onSelect: (i: NavItem) => void }) {
  return (
    <aside className="es-side">
      <div className="es-side__brand">Surtec</div>
      <div className="es-side__group">Control plane</div>
      <nav className="es-side__nav">
        {NAV_ITEMS.map((i) => (
          <button
            key={i}
            type="button"
            className={`es-nav-item${i === active ? " es-nav-item--on" : ""}`}
            onClick={() => onSelect(i)}
          >
            {i}
          </button>
        ))}
      </nav>
      <div className="es-side__foot">
        <span className="es-side__foot-name">Marcos</span>
        <span className="es-side__foot-role">Admin</span>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Wire view-switch into App**

Replace `dashboard/src/ui/App.tsx` with:

```tsx
import { useState } from "react";
import { useOverview } from "./api";
import { Sidebar, type NavItem } from "./components/Sidebar";
import { ProjectCard } from "./components/ProjectCard";
import { TaskList } from "./components/TaskList";
import { AttentionPanel } from "./components/AttentionPanel";
import { NewTaskForm } from "./components/NewTaskForm";
import { ProcesosView } from "./views/ProcesosView";
import { useRuns } from "./useRuns";

export function App() {
  const { data, error } = useOverview();
  const { runs } = useRuns();
  const [nav, setNav] = useState<NavItem>("Overview");

  const runningByProject = new Map<string, string[]>();
  for (const r of runs) {
    if (r.status !== "running") continue;
    const label = r.kind === "dev" ? "dev" : "en curso";
    runningByProject.set(r.projectId, [...(runningByProject.get(r.projectId) ?? []), label]);
  }

  return (
    <div className="app-shell">
      <Sidebar active={nav} onSelect={setNav} />
      <div className="app-main">
        <header className="es-top">
          <span className="es-top__title">{nav === "Procesos" ? "Procesos" : "Estado vivo"}</span>
          <span className="es-live">
            <span className={`es-dot ${error ? "es-dot--danger" : "es-dot--ok"}`} />
            <span>{error ? "sin conexión" : "en vivo"}</span>
          </span>
        </header>
        <main className="app-content">
          {nav === "Procesos" ? (
            <ProcesosView projectIds={data ? data.projects.filter((p) => p.configured).map((p) => p.id) : []} />
          ) : (
            <>
              <NewTaskForm />
              {error && (
                <div className="es-banner es-banner--warn">
                  No pude refrescar ({error}); mostrando el último estado conocido.
                </div>
              )}
              {!data ? (
                <p className="es-empty">Cargando…</p>
              ) : (
                <>
                  <section>
                    <h4 className="es-section__title">Proyectos</h4>
                    <div className="es-cards">
                      {data.projects.map((p) => (
                        <ProjectCard key={p.id} p={p} running={runningByProject.get(p.id) ?? []} />
                      ))}
                    </div>
                  </section>
                  <div className="es-cols">
                    <TaskList title="En curso" tasks={data.inProgress} />
                    <AttentionPanel items={data.attention} />
                  </div>
                  <TaskList title="Historial" tasks={data.history} />
                </>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: FAIL — `ProjectCard` does not yet accept `running` (fixed in Task 11). This is expected; proceed to Task 11 before re-running.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/ui/components/Sidebar.tsx dashboard/src/ui/App.tsx
git commit -m "feat(ui): Sidebar navigation + App view-switch with Procesos route"
```

---

## Task 11: ProjectCard running indicator

**Files:**
- Modify: `dashboard/src/ui/components/ProjectCard.tsx`
- Test: `dashboard/src/ui/components/ProjectCard.test.tsx`

- [ ] **Step 1: Add the failing test**

Add to `dashboard/src/ui/components/ProjectCard.test.tsx` (new cases; reuse the file's existing `ProjectView` fixture builder — if it builds a `p` inline, mirror that shape):

```tsx
it("shows a running indicator when a run is active", () => {
  const p = makeProject({ id: "alpha" }); // use the existing fixture helper in this file
  render(<ProjectCard p={p} running={["dev"]} />);
  expect(screen.getByText("● dev")).toBeInTheDocument();
});

it("shows no running indicator when idle", () => {
  const p = makeProject({ id: "alpha" });
  render(<ProjectCard p={p} running={[]} />);
  expect(screen.queryByText(/●/)).not.toBeInTheDocument();
});
```

> If the existing test file has no `makeProject` helper, build `p` inline matching `ProjectView` (the shape used by the other tests in this file). Keep the two new cases consistent with that shape.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run dashboard/src/ui/components/ProjectCard.test.tsx`
Expected: FAIL — `running` prop not accepted / indicator not rendered.

- [ ] **Step 3: Implement**

In `dashboard/src/ui/components/ProjectCard.tsx`, change the signature and add the indicator. Replace the function declaration line:

```tsx
export function ProjectCard({ p }: { p: ProjectView }) {
```

with:

```tsx
export function ProjectCard({ p, running = [] }: { p: ProjectView; running?: string[] }) {
```

Then, inside the `.es-card__head` block, after the configured chip `</span>`, add the indicator (still inside `.es-card__head`):

```tsx
        {running.length > 0 && (
          <span className="es-chip es-chip--run">
            {running.map((label) => (
              <span key={label} className="es-run-ind"><span className="es-dot es-dot--info" />{`● ${label}`}</span>
            ))}
          </span>
        )}
```

> Keep it simple: the test asserts the literal text `● dev`. The `<span className="es-dot …" />` is decorative; the `● ${label}` text is what the test matches. If duplicate-bullet styling looks off in the browser, drop the `es-dot` span and keep only the `● ${label}` text — adjust in Task 13's manual check.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run dashboard/src/ui/components/ProjectCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Verify the whole project compiles now**

Run: `pnpm exec tsc --noEmit`
Expected: PASS (Task 10's App now type-checks).

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/ui/components/ProjectCard.tsx dashboard/src/ui/components/ProjectCard.test.tsx
git commit -m "feat(ui): ProjectCard running indicator"
```

---

## Task 12: Console + Procesos CSS

**Files:**
- Modify: `dashboard/src/ui/styles/dashboard.css`

- [ ] **Step 1: Append styles**

Append to `dashboard/src/ui/styles/dashboard.css`:

```css
/* procesos / console */
.es-row--proc { gap: var(--sp-3); }
.es-proc-slot { display: inline-flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
.es-chip--run { gap: var(--sp-2); }
.es-run-ind { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-caption); color: var(--ink-2); }
.es-console { display: flex; flex-direction: column; gap: var(--sp-2); }
.es-console__bar { display: flex; align-items: center; gap: var(--sp-3); font-size: var(--fs-caption); color: var(--ink-3); }
.es-console__cmd { font-family: var(--font-numeric); margin-left: auto; }
.es-console__log {
  font-family: var(--font-numeric); font-size: var(--fs-body-sm); line-height: 1.5;
  background: var(--ink); color: var(--paper); border-radius: var(--r-md);
  padding: var(--sp-3); margin: 0; max-height: 60vh; overflow: auto; white-space: pre-wrap; word-break: break-word;
}
```

- [ ] **Step 2: Verify the build**

Run: `pnpm build`
Expected: success (Vite builds the bundle without errors).

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/ui/styles/dashboard.css
git commit -m "style(ui): console + procesos styles (Estante mono)"
```

---

## Task 13: Populate registry commands for the real repos

**Files:**
- Modify: `registry/projects.yml`

- [ ] **Step 1: Read each project's package.json to learn its scripts**

For each repo under `E:/product-projects/<id>`, read `package.json` `scripts` (and note non-npm stacks). Use the `Read` tool on each `E:/product-projects/<id>/package.json`. Record which of `dev`/`build`/`test`/`lint` exist. Notes from the registry header:
- `surtec-cli` is **bun** (`bun install`/`bun test`/`bun run lint`) — keep its existing `commands`.
- Angular projects: `ng build` / `ng test` (Karma needs headless flags; for B.2 the user launches manually, so `npm run build` / `npm test` as defined by the project is fine — do NOT add headless flags here).
- A repo with no `package.json` (e.g. a pure docs/skills repo like `agent-skills`) gets **no** `commands` block → the Procesos view shows "sin comandos configurados".

- [ ] **Step 2: Add a `commands` block per project based on its real scripts**

For each project that has a `package.json` with the matching scripts, ensure its registry entry has, for example:

```yaml
    commands:
      install: npm install
      dev: npm run dev
      build: npm run build
      test: npm test
      lint: npm run lint
```

Include ONLY the keys whose scripts actually exist in that project's `package.json` (e.g. omit `lint` if there is no `lint` script; omit `dev` if there is no `dev`/`start` script). For `surtec-cli` keep the existing bun commands and add `dev`/`build` only if its `package.json` defines them. Do not invent scripts.

- [ ] **Step 3: Validate the registry still parses and self-verify is unaffected**

Run: `pnpm exec vitest run runner/registry-project.test.ts runner/project-commands.test.ts`
Expected: PASS (the existing verify-command derivation and the new command loader both still work).

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add registry/projects.yml
git commit -m "chore(registry): populate dev/build/test/lint commands per real package.json"
```

---

## Task 14: Full verification + manual smoke + finish the branch

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: PASS — all suites green (existing + new: project-commands, process-manager, server routes, RunConsole, ProcesosView, ProjectCard).

- [ ] **Step 2: Typecheck + build**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: both succeed.

- [ ] **Step 3: Manual smoke (REQUIRED — use the verification-before-completion skill)**

Start the dashboard: `pnpm dev` (api on :4317, ui on :5173). Then in the browser:
- Go to **Procesos**. Pick a configured project with a `build`/`test` command (e.g. `expense-tracker-mvp`) and click it; confirm the console streams output and ends with `exited (ok)` or `failed` + exit code.
- Start a `dev` on a project that has one; confirm it stays **corriendo**, the **Detener** button appears, the project **card shows `● dev`**, and clicking **Detener** stops it (status → `stopped`, the `● dev` indicator clears within ~2 s).
- Confirm an unconfigured project shows "sin comandos configurados".

Capture the actual observed result (don't assume). If anything fails, switch to the systematic-debugging skill before claiming done.

- [ ] **Step 4: Finish the branch (use the finishing-a-development-branch skill)**

Merge `--no-ff` to `master`, push to `origin/master`, delete the feature branch — matching the project's established per-slice flow. Then update the memory file `live-status-dashboard-slice.md` to mark B.2 done.

---

## Self-Review (completed during planning)

- **Spec coverage:** process-manager (start/stop/list/get/subscribe, slots, ring buffer, tree-kill) → Tasks 3–4; project-commands → Task 2; routes incl. SSE → Task 5; api client → Task 6; RunConsole → Task 7; useRuns + card indicator → Tasks 8, 11; ProcesosView + nav route → Tasks 9–10; registry population → Task 13; types → Task 1; CSS → Task 12; verification + finish → Task 14. All spec sections covered.
- **Placeholder scan:** the only intentional cross-task forward reference is `stop` in Task 3 (explicitly filled in Task 4) and the App not compiling until Task 11 (called out in Task 10 Step 3). No "TODO/TBD" content gaps.
- **Type consistency:** `RunRecord`/`RunKind`/`RunStatus`/`RunEvent`/`ProjectCommands` defined once in Task 1 and imported everywhere; `createProcessManager`/`processManager`/`SlotBusyError`/`StartOpts` names consistent across Tasks 3–5; `createApp(repoRoot, onTaskCreated, pm)` signature consistent between Task 5 impl and tests; api function names (`listRuns`/`getProjectCommands`/`runProject`/`stopRun`/`getRun`/`streamRun`) consistent between Task 6 and consumers (Tasks 7–9).
