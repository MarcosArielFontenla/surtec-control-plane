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
