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
