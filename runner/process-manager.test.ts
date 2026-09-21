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

  it("redacts credentials from the stored command and streamed output", () => {
    const child = fakeChild();
    const pm = makePM(vi.fn().mockReturnValue(child));
    const rec = pm.start({ projectId: "p", kind: "oneshot", command: "tool --api_key=top-secret-value", cwd: "/p" });
    child.stdout.emit("data", Buffer.from("authorization=top-secret-value"));
    child.emit("exit", 0);
    const snap = pm.get(rec.runId)!;
    expect(snap.record.command).not.toContain("top-secret-value");
    expect(snap.log).not.toContain("top-secret-value");
    expect(snap.log).toContain("[REDACTED]");
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

  it("marks failed and frees the slot when the child emits 'error' without 'exit'", () => {
    const child = fakeChild();
    const pm = makePM(vi.fn().mockReturnValue(child));
    const rec = pm.start({ projectId: "p", kind: "dev", command: "d", cwd: "/bad" });
    child.emit("error", new Error("spawn ENOENT"));
    expect(pm.get(rec.runId)!.record.status).toBe("failed");
    expect(pm.get(rec.runId)!.log).toContain("ENOENT");
    // slot freed: a new dev start must NOT throw SlotBusyError
    expect(() => pm.start({ projectId: "p", kind: "dev", command: "d2", cwd: "/p" })).not.toThrow();
  });
});

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
    expect(spawnSync).toHaveBeenCalledWith("taskkill", ["/PID", "4242", "/T", "/F"], expect.objectContaining({ env: expect.any(Object) }));
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
