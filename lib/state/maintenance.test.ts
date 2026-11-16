import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireMaintenanceExclusive, acquireMaintenanceParticipant, assertMaintenanceAvailable,
  assertMaintenanceMutation, assertMaintenanceParticipant, assertSynchronousMaintenanceResult,
  maintenanceRootFingerprint, MaintenanceConflictError, MaintenanceStateError,
  readMaintenanceControl, readMaintenanceReadiness, releaseMaintenanceExclusive,
  releaseMaintenanceParticipant, setMaintenanceHold, StateLockConflictError,
  UnsupportedMaintenanceVersionError, withMaintenanceMutation,
} from "./maintenance";
import { maintenanceControlPath, maintenanceDir, maintenanceGatePath, maintenanceOwnersDir,
  stateRootForLockDirectory, stateRootForStoreDirectory, stateRootForStoreFile } from "./paths";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), renameSync: vi.fn(actual.renameSync),
    fstatSync: vi.fn(actual.fstatSync), closeSync: vi.fn(actual.closeSync),
    lstatSync: vi.fn(actual.lstatSync), readSync: vi.fn(actual.readSync) };
});
let root: string;
const children = new Set<ChildProcess>();
beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), "surtec-maintenance-")); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const method of [fs.fsyncSync, fs.renameSync, fs.fstatSync, fs.closeSync, fs.lstatSync, fs.readSync]) vi.mocked(method).mockReset();
  vi.unstubAllEnvs();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  }
  children.clear();
  expect(dirname(resolve(root))).toBe(resolve(tmpdir())); expect(basename(root)).toMatch(/^surtec-maintenance-/);
  expect(fs.lstatSync(root).isSymbolicLink()).toBe(false); fs.rmSync(root, { recursive: true, force: true });
  expect(fs.existsSync(root)).toBe(false);
});
function control() {
  return { schema_version: 1, revision: 1, root_fingerprint: typeof root === "string" ? maintenanceRootFingerprint(root) : "a".repeat(64),
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", hold: null };
}
function rawControl(value: unknown): Buffer {
  fs.mkdirSync(maintenanceDir(root), { recursive: true }); const data = Buffer.from(JSON.stringify(value));
  fs.writeFileSync(maintenanceControlPath(root), data); return data;
}
function held(kind: "restore" | "rollback" | "ownership-review" = "restore") {
  const proof = acquireMaintenanceExclusive(root);
  try { return setMaintenanceHold(proof, { operation_id: "owned-operation", kind }); }
  finally { releaseMaintenanceExclusive(proof); }
}
function unknownGate() {
  fs.mkdirSync(maintenanceDir(root), { recursive: true });
  const data = Buffer.from("unknown owner; inspection required\r\n"); fs.writeFileSync(maintenanceGatePath(root), data);
  fs.utimesSync(maintenanceGatePath(root), new Date(0), new Date(0)); return data;
}
async function liveChild(action: string): Promise<ChildProcess> {
  const module = pathToFileURL(resolve("lib/state/maintenance.ts")).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
    `import * as m from ${JSON.stringify(module)}; ${action}; process.stdout.write('OWNED\\n'); setInterval(() => {}, 1000);`],
  { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  await new Promise<void>((done, fail) => {
    let output = "", errors = "";
    const timer = setTimeout(() => fail(new Error(`Synthetic owner startup failed: ${errors.slice(-300)}`)), 12000);
    const finish = (error?: Error) => { clearTimeout(timer); child.off("exit", failed); child.off("error", finish);
      if (error) fail(error); else done(); };
    const failed = () => finish(new Error(`Synthetic owner exited before readiness: ${errors.slice(-300)}`));
    child.on("error", finish); child.on("exit", failed); child.stderr!.on("data", (data) => { errors += String(data); });
    child.stdout!.on("data", (data) => { output += String(data); if (output.includes("OWNED\n")) finish(); });
  });
  return child;
}

describe("T015 private core maintenance boundary", () => {
  it("observes optional absence without bootstrap and never reports full readiness", () => {
    const absent = join(root, "absent");
    expect(readMaintenanceControl(absent)).toBeNull(); assertMaintenanceAvailable(absent);
    expect(readMaintenanceReadiness(absent)).toEqual({ schema_version: 1, coverage: "partial", snapshot_ready: false,
      cutover_ready: false, state: "idle", participants: 0 });
    expect(fs.existsSync(absent)).toBe(false); expect(() => assertMaintenanceMutation(absent)).toThrow(MaintenanceStateError);
  });
  it("retains established contention constructor identity", () => {
    expect(MaintenanceConflictError).toBe(StateLockConflictError);
    expect(new MaintenanceConflictError().constructor.name).toBe("StateLockConflictError");
  });
  it("supports private synchronous reentrancy but excludes nested exclusive ownership", () => {
    expect(withMaintenanceMutation(root, () => {
      assertMaintenanceMutation(root); assertMaintenanceAvailable(root);
      expect(() => acquireMaintenanceExclusive(root)).toThrow(MaintenanceConflictError);
      expect(readMaintenanceReadiness(root).state).toBe("ownership-unavailable");
      return withMaintenanceMutation(root, () => 42);
    })).toBe(42);
    expect(fs.existsSync(maintenanceGatePath(root))).toBe(false);
    expect(() => assertMaintenanceMutation(root)).toThrow(MaintenanceStateError);
    const proof = acquireMaintenanceExclusive(root); releaseMaintenanceExclusive(proof);
  });
  it("cleans only its own gate after a synchronous callback failure", () => {
    const failure = new Error("synthetic synchronous failure");
    expect(() => withMaintenanceMutation(root, () => { throw failure; })).toThrow(failure);
    expect(fs.existsSync(maintenanceGatePath(root))).toBe(false);
    expect(withMaintenanceMutation(root, () => 7)).toBe(7);
  });
  it("does not share a private frame across different roots", () => {
    const other = join(root, "other");
    withMaintenanceMutation(root, () => {
      expect(() => assertMaintenanceMutation(other)).toThrow(MaintenanceStateError);
      withMaintenanceMutation(other, () => { assertMaintenanceMutation(other); assertMaintenanceMutation(root); });
    });
    expect(fs.existsSync(maintenanceGatePath(other))).toBe(false);
  });
  it.each(["SURTEC_MAINTENANCE_READY", "SURTEC_MAINTENANCE_OWNER", "SURTEC_P_ENABLED"])("does not derive ownership/readiness from %s", (name) => {
    vi.stubEnv(name, "1"); const original = unknownGate();
    expect(() => withMaintenanceMutation(root, () => undefined)).toThrow(MaintenanceConflictError);
    expect(readMaintenanceReadiness(root)).toMatchObject({ coverage: "partial", snapshot_ready: false, cutover_ready: false });
    expect(fs.readFileSync(maintenanceGatePath(root))).toEqual(original);
  });
  it.each([async () => 1, function* () { yield 1; }, new Proxy(() => 1, { apply() { throw new Error("not reached"); } })])("rejects unsupported callback before any state creation", (action) => {
    const missing = join(root, "missing");
    expect(() => withMaintenanceMutation<unknown>(missing, action)).toThrow(MaintenanceStateError);
    expect(fs.existsSync(missing)).toBe(false);
  });
  it.each([Promise.resolve(1), { then: () => 1 }, Object.create({ then: () => 1 }), new Proxy({}, {}),
    (function* () { yield 1; })(), (async function* () { yield 1; })()])("retains unknown ownership after a normal callback returns unsupported async-like work", (result) => {
    expect(() => withMaintenanceMutation(root, () => result)).toThrow(MaintenanceStateError);
    const original = fs.readFileSync(maintenanceGatePath(root));
    expect(() => withMaintenanceMutation(root, () => 1)).toThrow(MaintenanceConflictError);
    expect(() => acquireMaintenanceExclusive(root)).toThrow(MaintenanceConflictError);
    expect(fs.readFileSync(maintenanceGatePath(root))).toEqual(original);
  });
  it("never invokes then getters and cannot recover by swallowing its synchronous guard", () => {
    const getter = vi.fn(() => { throw new Error("not reached"); }), result = Object.create(null);
    Object.defineProperty(result, "then", { get: getter });
    expect(() => withMaintenanceMutation(root, () => { try { assertSynchronousMaintenanceResult(result); } catch { /* Caller cannot restore ownership. */ }
      expect(() => assertMaintenanceAvailable(root)).toThrow(MaintenanceStateError); return 1; })).toThrow(MaintenanceStateError);
    expect(getter).not.toHaveBeenCalled(); expect(fs.existsSync(maintenanceGatePath(root))).toBe(true);
  });
  it("blocks late continuation after rejecting a hidden promise", async () => {
    let continueLater!: () => void; const resumed = new Promise<void>((done) => { continueLater = done; });
    let lateCalls = 0, rejected = false;
    const result = resumed.then(() => { try { withMaintenanceMutation(root, () => { lateCalls++; }); } catch { rejected = true; } });
    expect(() => withMaintenanceMutation(root, () => result)).toThrow(MaintenanceStateError);
    continueLater(); await result; expect(lateCalls).toBe(0); expect(rejected).toBe(true);
    expect(fs.existsSync(maintenanceGatePath(root))).toBe(true);
  });
  it("preserves unknown and arbitrarily old gate bytes without age-steal or repair", () => {
    const original = unknownGate(), action = vi.fn();
    expect(() => withMaintenanceMutation(root, action)).toThrow(MaintenanceConflictError);
    expect(() => acquireMaintenanceExclusive(root)).toThrow(MaintenanceConflictError);
    expect(() => acquireMaintenanceParticipant(root, "worker")).toThrow(MaintenanceConflictError);
    expect(action).not.toHaveBeenCalled(); expect(fs.readFileSync(maintenanceGatePath(root))).toEqual(original);
  });
  it("cannot borrow an exclusive handle as mutation, copy it or release through persisted data", () => {
    const proof = acquireMaintenanceExclusive(root), original = fs.readFileSync(maintenanceGatePath(root));
    try {
      for (const fake of [{ ...proof }, JSON.parse(original.toString()), { owner: true }, new Proxy(proof, {})]) {
        expect(() => setMaintenanceHold(fake, { operation_id: "forged", kind: "restore" })).toThrow(MaintenanceStateError);
        expect(() => releaseMaintenanceExclusive(fake)).toThrow(MaintenanceStateError);
      }
      expect(() => withMaintenanceMutation(root, () => undefined)).toThrow(MaintenanceConflictError);
      expect(fs.readFileSync(maintenanceGatePath(root))).toEqual(original); expect(fs.existsSync(maintenanceControlPath(root))).toBe(false);
    } finally { releaseMaintenanceExclusive(proof); }
    expect(() => setMaintenanceHold(proof, { operation_id: "stale", kind: "restore" })).toThrow(MaintenanceStateError);
    expect(() => releaseMaintenanceExclusive(proof)).toThrow(MaintenanceStateError);
  });
  it("retains replaced owner evidence rather than deleting it on release", () => {
    const proof = acquireMaintenanceExclusive(root), replacement = Buffer.from("replacement-owner");
    fs.writeFileSync(maintenanceGatePath(root), replacement);
    expect(() => releaseMaintenanceExclusive(proof)).toThrow(MaintenanceStateError);
    expect(fs.readFileSync(maintenanceGatePath(root))).toEqual(replacement);
    expect(() => releaseMaintenanceExclusive(proof)).toThrow(MaintenanceStateError);
    expect(() => acquireMaintenanceExclusive(root)).toThrow(MaintenanceConflictError);
  });
  it("retains unknown ownership when a callback changes its gate", () => {
    expect(() => withMaintenanceMutation(root, () => fs.writeFileSync(maintenanceGatePath(root), "unknown"))).toThrow(MaintenanceStateError);
    expect(fs.readFileSync(maintenanceGatePath(root), "utf8")).toBe("unknown");
  });
  it("retains failed initialization instead of admitting a new owner", () => {
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => { throw new Error("synthetic flush failure"); });
    expect(() => withMaintenanceMutation(root, () => undefined)).toThrow(MaintenanceStateError);
    const original = fs.readFileSync(maintenanceGatePath(root));
    expect(() => acquireMaintenanceExclusive(root)).toThrow(MaintenanceConflictError);
    expect(fs.readFileSync(maintenanceGatePath(root))).toEqual(original);
  });
  it("closes a newly opened owner descriptor if identity inspection fails", () => {
    vi.mocked(fs.fstatSync).mockImplementationOnce(() => { throw new Error(`synthetic private path ${root}`); });
    expect(() => acquireMaintenanceExclusive(root)).toThrow(MaintenanceStateError);
    expect(fs.closeSync).toHaveBeenCalledOnce(); expect(fs.existsSync(maintenanceGatePath(root))).toBe(true);
    expect(() => acquireMaintenanceExclusive(root)).toThrow(MaintenanceConflictError);
  });
  it.each(["control", "exclusive-preflight"] as const)("closes its descriptor without deleting changed ownership after %s admission fails", (fault) => {
    const actual = vi.mocked(fs.lstatSync).getMockImplementation()!, replacement = Buffer.from("synthetic unknown replacement owner");
    let applied = false;
    vi.mocked(fs.lstatSync).mockImplementation(((path: fs.PathLike, options?: fs.StatSyncOptions) => {
      const target = fault === "control" ? maintenanceControlPath(root) : maintenanceOwnersDir(root);
      if (!applied && String(path) === target && fs.existsSync(maintenanceGatePath(root))) {
        applied = true; fs.writeFileSync(maintenanceGatePath(root), replacement);
        if (fault === "control") fs.writeFileSync(target, "invalid synthetic control");
        else { fs.mkdirSync(target); fs.writeFileSync(join(target, "orphan.json"), "invalid synthetic participant"); }
      }
      return Reflect.apply(actual, undefined, [path, options]);
    }) as typeof fs.lstatSync);
    expect(() => acquireMaintenanceExclusive(root)).toThrow(MaintenanceStateError);
    const ownerFd = vi.mocked(fs.fstatSync).mock.calls[0]![0];
    expect(applied).toBe(true); expect(vi.mocked(fs.closeSync).mock.calls.filter(([fd]) => fd === ownerFd)).toHaveLength(1);
    expect(() => fs.fstatSync(ownerFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(fs.readFileSync(maintenanceGatePath(root))).toEqual(replacement);
    const action = vi.fn(); expect(() => withMaintenanceMutation(root, action)).toThrow(); expect(action).not.toHaveBeenCalled();
    expect(fs.readFileSync(maintenanceGatePath(root))).toEqual(replacement);
  });
  it.each([".locks", "locks", "events/.locks", "organization/.locks", "issues/.locks", "portfolio/.locks", "sessions/.locks", "signals/.locks", "harness/.locks"])("refuses active or unknown legacy %s without removing it", (folder) => {
    const lock = join(root, folder, "legacy.lock"); fs.mkdirSync(dirname(lock), { recursive: true }); fs.writeFileSync(lock, "legacy-owner");
    fs.utimesSync(lock, new Date(0), new Date(0)); expect(() => acquireMaintenanceExclusive(root)).toThrow(MaintenanceConflictError);
    expect(fs.readFileSync(lock, "utf8")).toBe("legacy-owner"); expect(fs.existsSync(maintenanceGatePath(root))).toBe(false);
  });
  it("refuses legacy locks stored directly in an arbitrary flat override", () => {
    const path = join(root, "flat-owner.lock"); fs.writeFileSync(path, "unknown-flat-owner"); fs.utimesSync(path, new Date(0), new Date(0));
    expect(() => acquireMaintenanceExclusive(root)).toThrow(MaintenanceConflictError);
    expect(fs.readFileSync(path, "utf8")).toBe("unknown-flat-owner"); expect(fs.existsSync(maintenanceGatePath(root))).toBe(false);
  });
  it("canonicalizes layouts without moving arbitrary flat overrides outside their root", () => {
    expect(stateRootForStoreDirectory(join(root, "tasks"), "tasks")).toBe(root);
    expect(stateRootForStoreFile(join(root, "workflows", "workflows.json"), "workflows")).toBe(root);
    expect(stateRootForStoreFile(join(root, "flat", "budgets.json"), "budgets")).toBe(join(root, "flat"));
    expect(stateRootForLockDirectory(join(root, "events", ".locks"))).toBe(root);
    expect(stateRootForLockDirectory(join(root, "flat", ".locks"))).toBe(join(root, "flat"));
    expect(stateRootForLockDirectory(join(root, "locks"))).toBe(root);
  });
  it.runIf(process.platform === "win32")("binds Windows case aliases to one private identity", () => {
    withMaintenanceMutation(root, () => assertMaintenanceMutation(root.toUpperCase()));
    expect(maintenanceRootFingerprint(root)).toBe(maintenanceRootFingerprint(root.toUpperCase()));
    expect(stateRootForStoreDirectory(join(root, "TASKS"), "tasks")).toBe(root);
    expect(stateRootForLockDirectory(join(root, "EVENTS", ".LOCKS"))).toBe(root);
  });
  it("rejects drive roots and physical redirected roots before bootstrap", () => {
    expect(() => acquireMaintenanceExclusive(parse(resolve(root)).root)).toThrow(MaintenanceStateError);
    const target = join(root, "target"), alias = join(root, "alias"); fs.mkdirSync(target);
    fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    expect(() => withMaintenanceMutation(alias, () => 1)).toThrow(MaintenanceStateError);
    expect(fs.existsSync(maintenanceDir(target))).toBe(false);
  });
  it("rejects hardlinked control bytes without changing either link", () => {
    const original = rawControl(control()), other = join(root, "control-link.json"); fs.linkSync(maintenanceControlPath(root), other);
    expect(() => readMaintenanceControl(root)).toThrow(MaintenanceStateError);
    expect(() => withMaintenanceMutation(root, () => 1)).toThrow(MaintenanceStateError);
    expect(fs.readFileSync(other)).toEqual(original); expect(fs.readFileSync(maintenanceControlPath(root))).toEqual(original);
    expect(fs.existsSync(maintenanceGatePath(root))).toBe(false);
  });
  it("samples an absent control once without throwing or caching absence across reads", () => {
    fs.mkdirSync(maintenanceDir(root)); vi.mocked(fs.lstatSync).mockClear();
    expect(readMaintenanceControl(root)).toBeNull();
    const probes = vi.mocked(fs.lstatSync).mock.calls.filter(([path]) => String(path) === maintenanceControlPath(root));
    expect(probes).toHaveLength(1); expect(probes[0]![1]).toMatchObject({ throwIfNoEntry: false });
    const saved = rawControl(control()); expect(readMaintenanceControl(root)).toMatchObject({ revision: 1, hold: null });
    expect(fs.readFileSync(maintenanceControlPath(root))).toEqual(saved);
  });
  it("samples existing control prefixes afresh before and after every read", () => {
    rawControl(control()); vi.mocked(fs.lstatSync).mockClear(); readMaintenanceControl(root);
    expect(vi.mocked(fs.lstatSync).mock.calls.filter(([path]) => String(path) === maintenanceControlPath(root))).toHaveLength(2);
    fs.writeFileSync(maintenanceControlPath(root), JSON.stringify({ ...control(), schema_version: 2 }));
    expect(() => readMaintenanceControl(root)).toThrow(UnsupportedMaintenanceVersionError);
  });
  it("refuses non-ENOENT failures even when nonthrowing absence probing is requested", () => {
    rawControl(control()); const actual = vi.mocked(fs.lstatSync).getMockImplementation()!;
    vi.mocked(fs.lstatSync).mockImplementation(((path: fs.PathLike, options?: fs.StatSyncOptions) => {
      if (String(path) === maintenanceControlPath(root)) throw Object.assign(new Error("synthetic denied metadata"), { code: "EACCES" });
      return Reflect.apply(actual, undefined, [path, options]);
    }) as typeof fs.lstatSync);
    expect(() => readMaintenanceControl(root)).toThrow(MaintenanceStateError);
  });
  it.each(["missing", "hardlink", "ancestor-junction", "growth", "same-size-write", "timestamp"] as const)("refuses %s introduced during the exact metadata read", (fault) => {
    const saved = rawControl(control()), path = maintenanceControlPath(root), actual = vi.mocked(fs.readSync).getMockImplementation()!;
    let faultApplied = false;
    if (fault === "ancestor-junction") {
      const target = join(root, "junction-target"), probe = join(root, "junction-probe"); fs.mkdirSync(target);
      fs.symlinkSync(target, probe, process.platform === "win32" ? "junction" : "dir");
      const lstat = vi.mocked(fs.lstatSync).getMockImplementation()!;
      // Inject an actual fresh junction stat only after reading. Windows can
      // refuse moving a directory containing the open reader instead.
      vi.mocked(fs.lstatSync).mockImplementation(((location: fs.PathLike, options?: fs.StatSyncOptions) =>
        Reflect.apply(lstat, undefined, [faultApplied && String(location) === maintenanceDir(root) ? probe : location, options])) as typeof fs.lstatSync);
    }
    vi.mocked(fs.readSync).mockImplementationOnce(((...args: unknown[]) => {
      const count = Reflect.apply(actual, undefined, args) as number;
      if (fault === "missing") fs.unlinkSync(path);
      else if (fault === "hardlink") fs.linkSync(path, join(root, "linked-control.json"));
      else if (fault === "growth") fs.appendFileSync(path, " ");
      else if (fault === "same-size-write") { fs.writeFileSync(path, Buffer.alloc(saved.length, 32)); fs.utimesSync(path, new Date(0), new Date(0)); }
      else if (fault === "timestamp") fs.utimesSync(path, new Date(0), new Date(0));
      faultApplied = true;
      return count;
    }) as typeof fs.readSync);
    expect(() => readMaintenanceControl(root)).toThrow(MaintenanceStateError);
    expect(faultApplied).toBe(true);
    expect(fs.existsSync(maintenanceGatePath(root))).toBe(false);
  });
  it("keeps the late root identity guard after the final ancestor walk", () => {
    const nested = join(root, "state"), foreignRoot = join(root, "foreign-state"); fs.mkdirSync(foreignRoot); let observed = false;
    expect(() => withMaintenanceMutation(nested, () => {
      const original = fs.readFileSync(maintenanceGatePath(nested)), actual = vi.mocked(fs.lstatSync).getMockImplementation()!;
      let visits = 0;
      vi.mocked(fs.lstatSync).mockImplementation(((path: fs.PathLike, options?: fs.StatSyncOptions) => {
        const stat = Reflect.apply(actual, undefined, [path, options]);
        if (String(path) === nested) {
          // Windows may refuse moving an ancestor while its reader FD is open.
          // Inject the new root identity immediately after the post-walk sample;
          // keep the real marker inode/bytes and every other filesystem sample.
          const visit = ++visits;
          if (visit === 2) observed = true;
          else if (observed) return Reflect.apply(actual, undefined, [foreignRoot, options]);
        }
        return stat;
      }) as typeof fs.lstatSync);
      expect(() => assertMaintenanceMutation(nested)).toThrow(MaintenanceStateError);
      expect(fs.readFileSync(maintenanceGatePath(nested))).toEqual(original);
    })).toThrow(MaintenanceStateError);
    expect(observed).toBe(true); expect(fs.existsSync(maintenanceGatePath(nested))).toBe(true);
  });
  it("keeps the late leaf identity guard after the fresh root sample", () => {
    let replaced = false;
    expect(() => withMaintenanceMutation(root, () => {
      const path = maintenanceGatePath(root), original = fs.readFileSync(path), actual = vi.mocked(fs.lstatSync).getMockImplementation()!;
      let visits = 0;
      vi.mocked(fs.lstatSync).mockImplementation(((location: fs.PathLike, options?: fs.StatSyncOptions) => {
        const stat = Reflect.apply(actual, undefined, [location, options]);
        if (String(location) === root && ++visits === 3) {
          fs.renameSync(path, join(maintenanceDir(root), "old-owner.lock")); fs.writeFileSync(path, original); replaced = true;
        }
        return stat;
      }) as typeof fs.lstatSync);
      expect(() => assertMaintenanceMutation(root)).toThrow(MaintenanceStateError);
      expect(fs.readFileSync(path)).toEqual(original);
    })).toThrow(MaintenanceStateError);
    expect(replaced).toBe(true); expect(fs.existsSync(maintenanceGatePath(root))).toBe(true);
  });
  it("does not memoize a newly introduced hold between mutation guards", () => {
    expect(() => withMaintenanceMutation(root, () => {
      assertMaintenanceMutation(root); const source = control();
      const original = rawControl({ ...source, hold: { id: "h", operation_id: "op", kind: "restore", created_at: source.created_at } });
      expect(() => assertMaintenanceMutation(root)).toThrow(MaintenanceStateError);
      expect(fs.readFileSync(maintenanceControlPath(root))).toEqual(original);
    })).toThrow(MaintenanceStateError);
    expect(fs.existsSync(maintenanceGatePath(root))).toBe(false);
    expect(readMaintenanceReadiness(root).state).toBe("held");
  });
});

describe("durable holds and private participants", () => {
  it.each(["restore", "rollback", "ownership-review"] as const)("persists an independent %s hold and refuses operations after release/re-read", (kind) => {
    const value = held(kind), original = fs.readFileSync(maintenanceControlPath(root));
    expect(value).toMatchObject({ schema_version: 1, revision: 1, hold: { operation_id: "owned-operation", kind } });
    expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.hold)).toBe(true);
    expect(readMaintenanceControl(root)).toEqual(value);
    expect(readMaintenanceReadiness(root)).toMatchObject({ state: "held", coverage: "partial", snapshot_ready: false, cutover_ready: false });
    const action = vi.fn(); expect(() => withMaintenanceMutation(root, action)).toThrow(MaintenanceStateError);
    expect(() => acquireMaintenanceExclusive(root)).toThrow(MaintenanceStateError);
    expect(() => acquireMaintenanceParticipant(root, "worker")).toThrow(MaintenanceStateError);
    expect(action).not.toHaveBeenCalled(); expect(fs.readFileSync(maintenanceControlPath(root))).toEqual(original);
    expect(fs.existsSync(maintenanceGatePath(root))).toBe(false);
  });
  it.each([
    { ...control(), schema_version: 2 }, { ...control(), revision: 0 }, { ...control(), extra_permission: true },
    { ...control(), root_fingerprint: "0".repeat(64) }, { ...control(), created_at: "2026-02-30T00:00:00Z" },
    { ...control(), updated_at: "2025-01-01T00:00:00Z" }, { ...control(), hold: { id: "h", operation_id: "o", kind: "restore", created_at: "2027-01-01T00:00:00Z" } },
  ])("preserves unsupported, malformed or mismatched controls without auto-migration", (input) => {
    const original = rawControl({ ...input, root_fingerprint: input.root_fingerprint === "0".repeat(64) ? input.root_fingerprint : maintenanceRootFingerprint(root) });
    expect(() => readMaintenanceControl(root)).toThrow(MaintenanceStateError);
    expect(() => withMaintenanceMutation(root, () => undefined)).toThrow(MaintenanceStateError);
    expect(readMaintenanceReadiness(root).state).toBe("unavailable"); expect(fs.readFileSync(maintenanceControlPath(root))).toEqual(original);
    expect(fs.existsSync(maintenanceGatePath(root))).toBe(false);
    if (input.schema_version === 2) expect(() => readMaintenanceControl(root)).toThrow(UnsupportedMaintenanceVersionError);
  });
  it("refuses invalid UTF-8, oversized metadata and clock regression before overwrite", () => {
    fs.mkdirSync(maintenanceDir(root)); fs.writeFileSync(maintenanceControlPath(root), Buffer.from([0xff]));
    expect(() => readMaintenanceControl(root)).toThrow(MaintenanceStateError);
    const original = rawControl({ ...control(), updated_at: "9999-01-01T00:00:00Z" });
    const proof = acquireMaintenanceExclusive(root);
    try { expect(() => setMaintenanceHold(proof, { operation_id: "op", kind: "restore" })).toThrow(MaintenanceStateError); }
    finally { releaseMaintenanceExclusive(proof); }
    expect(fs.readFileSync(maintenanceControlPath(root))).toEqual(original);
    fs.writeFileSync(maintenanceControlPath(root), Buffer.alloc(16 * 1024 * 1024 + 1, 32));
    expect(() => readMaintenanceControl(root)).toThrow(MaintenanceStateError);
  });
  it("validates inert hold input without invoking getters, toJSON or proxy hooks", () => {
    const proof = acquireMaintenanceExclusive(root), hook = vi.fn(() => { throw new Error("not reached"); });
    const getter = { get operation_id() { return hook(); }, kind: "restore" };
    try {
      for (const input of [getter, new Proxy({ operation_id: "op", kind: "restore" }, { ownKeys: hook }),
        { operation_id: "op", kind: "restore", toJSON: hook }, { operation_id: "../escape", kind: "restore" },
        { operation_id: "op", kind: new Proxy({}, { get: hook }) }]) {
        expect(() => setMaintenanceHold(proof, input as Parameters<typeof setMaintenanceHold>[1])).toThrow(MaintenanceStateError);
      }
      expect(hook).not.toHaveBeenCalled(); expect(fs.existsSync(maintenanceControlPath(root))).toBe(false);
    } finally { releaseMaintenanceExclusive(proof); }
  });
  it("preserves preexisting control and cleans only owned staging after atomic replace failure", () => {
    const original = rawControl(control()), proof = acquireMaintenanceExclusive(root);
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("synthetic replace failure"); });
    try { expect(() => setMaintenanceHold(proof, { operation_id: "op", kind: "restore" })).toThrow("synthetic replace failure"); }
    finally { releaseMaintenanceExclusive(proof); }
    expect(fs.readFileSync(maintenanceControlPath(root))).toEqual(original);
    expect(fs.readdirSync(maintenanceDir(root))).toEqual(["control.json"]);
  });
  it("refuses external control replacement during hold staging without overwriting it", () => {
    rawControl(control()); const proof = acquireMaintenanceExclusive(root), replacement = Buffer.from("external-control");
    const actual = vi.mocked(fs.fsyncSync).getMockImplementation()!;
    vi.mocked(fs.fsyncSync).mockImplementationOnce((fd) => { actual(fd); fs.writeFileSync(maintenanceControlPath(root), replacement); });
    try { expect(() => setMaintenanceHold(proof, { operation_id: "op", kind: "restore" })).toThrow(MaintenanceStateError); }
    finally { releaseMaintenanceExclusive(proof); }
    expect(fs.readFileSync(maintenanceControlPath(root))).toEqual(replacement);
    expect(fs.readdirSync(maintenanceDir(root))).toEqual(["control.json"]);
  });
  it.each(["api", "worker", "task", "routine", "project-command", "operation"] as const)("requires private identity for %s participants and refuses exclusive admission", (kind) => {
    const participant = acquireMaintenanceParticipant(root, kind);
    try {
      assertMaintenanceParticipant(participant); const names = fs.readdirSync(maintenanceOwnersDir(root)); expect(names).toHaveLength(1);
      const metadata = JSON.parse(fs.readFileSync(join(maintenanceOwnersDir(root), names[0]!), "utf8"));
      expect(metadata).toMatchObject({ schema_version: 1, pid: process.pid, kind });
      expect(() => assertMaintenanceParticipant(metadata)).toThrow(MaintenanceStateError);
      expect(() => releaseMaintenanceParticipant({ ...participant })).toThrow(MaintenanceStateError);
      expect(() => acquireMaintenanceExclusive(root)).toThrow(MaintenanceConflictError);
      expect(readMaintenanceReadiness(root)).toMatchObject({ state: "ownership-unavailable", participants: 1, cutover_ready: false });
      expect(withMaintenanceMutation(root, () => 1)).toBe(1);
    } finally { releaseMaintenanceParticipant(participant); }
    expect(fs.readdirSync(maintenanceOwnersDir(root))).toEqual([]);
    expect(() => assertMaintenanceParticipant(participant)).toThrow(MaintenanceStateError);
    const exclusive = acquireMaintenanceExclusive(root); releaseMaintenanceExclusive(exclusive);
  });
  it("never adopts an orphan participant based on PID or timestamp", () => {
    const participant = acquireMaintenanceParticipant(root, "worker"), name = fs.readdirSync(maintenanceOwnersDir(root))[0]!;
    const path = join(maintenanceOwnersDir(root), name), record = JSON.parse(fs.readFileSync(path, "utf8"));
    record.pid = 9007199254740991; record.created_at = "1970-01-01T00:00:00Z"; const original = Buffer.from(JSON.stringify(record)); fs.writeFileSync(path, original);
    expect(() => releaseMaintenanceParticipant(participant)).toThrow(MaintenanceStateError);
    expect(() => acquireMaintenanceExclusive(root)).toThrow(MaintenanceConflictError);
    expect(fs.readFileSync(path)).toEqual(original); expect(readMaintenanceReadiness(root).cutover_ready).toBe(false);
  });
  it("permits only known participant shutdown under a durable hold and never clears it", () => {
    const participant = acquireMaintenanceParticipant(root, "api"), record = control();
    const original = rawControl({ ...record, hold: { id: "hold", operation_id: "op", kind: "restore", created_at: record.created_at } });
    expect(() => assertMaintenanceParticipant(participant)).toThrow(MaintenanceStateError);
    releaseMaintenanceParticipant(participant); expect(fs.readdirSync(maintenanceOwnersDir(root))).toEqual([]);
    expect(fs.readFileSync(maintenanceControlPath(root))).toEqual(original); expect(readMaintenanceReadiness(root).state).toBe("held");
  });
  it("retains a privately known participant on mere coordination contention for an explicit later release", () => {
    const participant = acquireMaintenanceParticipant(root, "worker"), name = fs.readdirSync(maintenanceOwnersDir(root))[0]!;
    const path = join(maintenanceOwnersDir(root), name), original = fs.readFileSync(path);
    withMaintenanceMutation(root, () => {
      expect(() => releaseMaintenanceParticipant(participant)).toThrow(MaintenanceConflictError);
      assertMaintenanceParticipant(participant); expect(fs.readFileSync(path)).toEqual(original);
    });
    assertMaintenanceParticipant(participant); releaseMaintenanceParticipant(participant); expect(fs.existsSync(path)).toBe(false);
  });
  it("refuses malformed participant evidence and preserves it", () => {
    fs.mkdirSync(maintenanceOwnersDir(root), { recursive: true }); const path = join(maintenanceOwnersDir(root), "orphan.json"); fs.writeFileSync(path, "unknown");
    expect(() => acquireMaintenanceExclusive(root)).toThrow(MaintenanceStateError);
    expect(fs.readFileSync(path, "utf8")).toBe("unknown"); expect(readMaintenanceReadiness(root).state).toBe("unavailable");
    expect(fs.existsSync(maintenanceGatePath(root))).toBe(false);
  });
  it("refuses a real second-process owner and retains crash evidence without stale adoption", async () => {
    const child = await liveChild(`m.acquireMaintenanceExclusive(${JSON.stringify(root)})`);
    const original = fs.readFileSync(maintenanceGatePath(root)), action = vi.fn();
    expect(() => withMaintenanceMutation(root, action)).toThrow(MaintenanceConflictError);
    expect(() => acquireMaintenanceExclusive(root)).toThrow(MaintenanceConflictError);
    const exited = once(child, "exit"); child.kill(); await exited; children.delete(child);
    fs.utimesSync(maintenanceGatePath(root), new Date(0), new Date(0));
    expect(() => acquireMaintenanceExclusive(root)).toThrow(MaintenanceConflictError);
    expect(fs.readFileSync(maintenanceGatePath(root))).toEqual(original); expect(action).not.toHaveBeenCalled();
  }, 20000);
  it("refuses real participant process presence and does not infer liveness after it exits", async () => {
    const child = await liveChild(`m.acquireMaintenanceParticipant(${JSON.stringify(root)}, 'worker')`);
    const path = join(maintenanceOwnersDir(root), fs.readdirSync(maintenanceOwnersDir(root))[0]!), original = fs.readFileSync(path);
    expect(() => acquireMaintenanceExclusive(root)).toThrow(MaintenanceConflictError);
    const exited = once(child, "exit"); child.kill(); await exited; children.delete(child);
    expect(() => acquireMaintenanceExclusive(root)).toThrow(MaintenanceConflictError);
    expect(fs.readFileSync(path)).toEqual(original); expect(readMaintenanceReadiness(root)).toMatchObject({ state: "ownership-unavailable", participants: 1, snapshot_ready: false });
  }, 20000);
});

// T015 actual API/browser acceptance is appended below and is explicitly opt-in.
it.runIf(process.env.SURTEC_MAINTENANCE_BROWSER_SMOKE === "1")("T015 validates maintenance denials through the actual local API and browser without activating execution", async () => {
  const { serve } = await import("@hono/node-server"), { createServer: createViteServer } = await import("vite"), { default: react } = await import("@vitejs/plugin-react");
  const { chromium } = await import("playwright"), { execFileSync } = await import("node:child_process");
  const { createApp } = await import("../../dashboard/src/server/index"), { createHttpSecurity } = await import("../../dashboard/src/server/http-security");
  const { createRoutineService } = await import("../../dashboard/src/server/routine-service"), { readRoutineDocument } = await import("./routines");
  const { readBudgetPolicy } = await import("../budgets/policy"), { BUDGET_DIMENSIONS } = await import("../budgets/types");
  const { routineStatePath } = await import("./paths"), { systemProcessEnvironment } = await import("../security/environment");
  const fixture = fs.mkdtempSync(join(tmpdir(), "surtec-maintenance-browser-")), state = join(fixture, "state"), projectsRoot = join(fixture, "projects");
  let api: ReturnType<typeof serve> | undefined, vite: import("vite").ViteDevServer | undefined, browser: import("playwright").Browser | undefined;
  let browserClosed = false, viteClosed = false, apiClosed = false;
  const at = new Date().toISOString(), companyScope = { kind: "company", id: "surtec" } as const;
  const dispatch = vi.fn(() => { throw new Error("The maintenance fixture forbids agent dispatch."); });
  const effect = vi.fn(() => { throw new Error("The maintenance fixture forbids providers and project execution."); });
  const pm = { start: effect, stop: effect, get: vi.fn(() => null), list: vi.fn(() => []), subscribe: vi.fn(() => () => {}) };
  const organization = (): import("../organization").OrganizationSnapshot => ({
    company: { schema_version: 1, id: "surtec", display_name: "Synthetic company", mission: null, operating_principles: [], active_objective_ids: [], last_reviewed_at: null },
    objectives: [], project_objectives: {},
  });
  const closeApi = async () => {
    if (!api?.listening) { apiClosed = true; return; }
    await new Promise<void>((done, fail) => { api!.close((error) => error ? fail(error) : done());
      if ("closeAllConnections" in api! && typeof api!.closeAllConnections === "function") api!.closeAllConnections(); });
    apiClosed = !api.listening;
  };
  try {
    expect(dirname(resolve(fixture))).toBe(resolve(tmpdir())); expect(fs.lstatSync(fixture).isSymbolicLink()).toBe(false);
    fs.mkdirSync(projectsRoot); const project = join(projectsRoot, "alpha"), templates = join(fixture, "empty-git-template"); fs.mkdirSync(project); fs.mkdirSync(templates);
    execFileSync("git", ["-c", "core.hooksPath=", "-c", `init.templateDir=${templates}`, "init", "--initial-branch=main", project],
      { env: systemProcessEnvironment(), stdio: "ignore", windowsHide: true });
    fs.cpSync(resolve("registry"), join(fixture, "registry"), { recursive: true }); fs.cpSync(resolve("schemas"), join(fixture, "schemas"), { recursive: true });
    fs.writeFileSync(join(fixture, "registry", "projects.yml"), JSON.stringify({ projects: { alpha: { local_path: project, default_branch: "main", status: "active",
      allowed_agents: ["tech-lead"], sandbox: { default: "read-only" }, commands: {}, approval: { before_merge: true, before_deploy: true } } } }));
    fs.writeFileSync(join(fixture, "registry", "budget-policy.yml"), JSON.stringify({ schema_version: 1, revision: 1, pricing: { status: "unavailable", reason: "no-versioned-source" },
      rules: [{ id: "company-policy", revision: 1, scope: companyScope, period: "none", warning_percent: 80,
        limits: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: "unconfigured" }])) }] }));
    vi.stubEnv("SURTEC_STATE_DIR", state); vi.stubEnv("SURTEC_PROJECTS_ROOT", projectsRoot); vi.stubEnv("SURTEC_TIME_ZONE", "UTC");
    const source = readBudgetPolicy(fixture), path = routineStatePath(state);
    const dependencies = (): import("../../dashboard/src/server/index").AppDependencies => ({
      routines: createRoutineService(fixture, { stateRoot: state, readBudgetPolicy: () => source, readOrganization: organization, listProjects: () => [{ id: "alpha" }] }),
      organization: { read: organization } as unknown as import("../../dashboard/src/server/index").AppDependencies["organization"],
      signals: { read: async () => ({ schema_version: 1, observed_at: at, pinned_signal_ids: [], warnings: [], signals: [] }), decide: effect } as unknown as import("../../dashboard/src/server/index").AppDependencies["signals"],
      inbox: async () => ({ items: [], repos: [] }),
      integrations: { read: async () => ({ schema_version: 2, project_id: "alpha", observed_at: at, trace_id: null,
        source_control: { provider: "git", configured: true, health: "ok", branch: "main", dirty: false, uncommitted: 0, ahead: 0, behind: 0,
          remote: { provider: "github", configured: false, health: "unconfigured", pull_requests: null, issues: null } },
        ci: { provider: "github-actions", configured: false, health: "unconfigured", status: null, branch: null, run_id: null },
        dependencies: { provider: "npm", configured: false, health: "unconfigured", outdated: null, observed_at: at }, deployments: [] }), invalidate: vi.fn() } as unknown as import("../../dashboard/src/server/index").AppDependencies["integrations"],
    });
    const app = () => createApp(fixture, dispatch, pm as unknown as import("../../runner/process-manager").ProcessManager, createHttpSecurity(), dependencies());
    api = serve({ fetch: app().fetch, hostname: "127.0.0.1", port: 0 }); if (!api.listening) await once(api, "listening");
    const apiPort = (api.address() as import("node:net").AddressInfo).port, apiUrl = `http://127.0.0.1:${apiPort}`;
    vite = await createViteServer({ configFile: false, root: resolve("dashboard"), plugins: [react()], cacheDir: join(fixture, "vite-cache"),
      server: { host: "127.0.0.1", port: 0, strictPort: true, proxy: { "/api": { target: apiUrl } } } });
    await vite.listen(); const dashboardUrl = `http://127.0.0.1:${(vite.httpServer!.address() as import("node:net").AddressInfo).port}`;
    try { browser = await chromium.launch({ headless: true }); }
    catch (error) { if (process.platform !== "win32" || !(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error;
      browser = await chromium.launch({ headless: true, channel: "msedge" }); }
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), pageErrors: string[] = [], externalRequests: string[] = [];
    const consoleErrors: Array<{ text: string; path: string }> = [], httpErrors: Array<{ status: number; method: string; path: string }> = [];
    const mutations: Array<{ method: string; path: string; body: unknown }> = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") { const url = message.location().url; consoleErrors.push({ text: message.text(), path: url ? new URL(url).pathname : "" }); } });
    page.on("response", (response) => { if (response.status() >= 400) httpErrors.push({ status: response.status(), method: response.request().method(), path: new URL(response.url()).pathname }); });
    page.on("request", (request) => { const url = new URL(request.url()); if (url.pathname.startsWith("/api/") && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method()))
      mutations.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() }); });
    await page.route("**/*", async (route) => { const url = new URL(route.request().url());
      if ([dashboardUrl, apiUrl].includes(url.origin)) await route.continue();
      else if (url.hostname === "fonts.googleapis.com" && url.pathname === "/css2" && route.request().resourceType() === "stylesheet")
        await route.fulfill({ status: 200, contentType: "text/css", body: "" });
      else { externalRequests.push(url.hostname); await route.abort(); } });
    await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" }); await page.getByText("Cockpit diario", { exact: true }).waitFor();
    await page.getByText("En vivo", { exact: true }).waitFor(); const panel = page.getByRole("region", { name: "Rutinas locales", exact: true });
    await panel.getByRole("button", { name: "Revisar creación", exact: true }).waitFor(); expect(mutations).toEqual([]); expect(fs.existsSync(path)).toBe(false);
    await panel.getByRole("button", { name: "Revisar creación", exact: true }).click(); expect(mutations).toEqual([]);
    await panel.getByRole("button", { name: "Confirmar creación", exact: true }).click(); await panel.getByRole("checkbox", { name: "Rutina habilitada", exact: true }).waitFor();
    const id = Object.keys(readRoutineDocument(path)!.routines)[0]!;
    expect(readRoutineDocument(path)!.routines[id]).toMatchObject({ revision: 1, enabled: false, schedule: null });
    await panel.getByRole("combobox", { name: "Programación de rutina", exact: true }).selectOption("interval");
    await panel.getByRole("spinbutton", { name: "Intervalo en minutos", exact: true }).fill("15");
    await panel.getByRole("combobox", { name: "Concurrencia de rutina", exact: true }).selectOption("coalesce");
    await panel.getByRole("button", { name: "Revisar configuración", exact: true }).click(); await panel.getByRole("button", { name: "Confirmar configuración", exact: true }).click();
    await expect.poll(() => readRoutineDocument(path)!.routines[id]!.revision).toBe(2);
    expect(readRoutineDocument(path)!.routines[id]).toMatchObject({ enabled: false, schedule: "every:15m", concurrency: "coalesce", catch_up: "skip-missed" });
    await panel.getByRole("button", { name: "Revisar ejecución", exact: true }).waitFor(); expect(await panel.getByRole("button", { name: "Revisar ejecución", exact: true }).isDisabled()).toBe(true);
    expect(await panel.textContent()).toContain("Ejecución productiva inactiva"); expect(readRoutineDocument(path)!.occurrences).toEqual({});
    const saved = fs.readFileSync(path), savedModified = fs.lstatSync(path).mtimeMs, proof = acquireMaintenanceExclusive(state);
    try { setMaintenanceHold(proof, { operation_id: "synthetic-browser-operation", kind: "ownership-review" }); }
    finally { releaseMaintenanceExclusive(proof); }
    const controlPath = maintenanceControlPath(state), held = fs.readFileSync(controlPath);
    const unchanged = () => { expect(fs.readFileSync(path)).toEqual(saved); expect(fs.lstatSync(path).mtimeMs).toBe(savedModified); expect(fs.readFileSync(controlPath)).toEqual(held); };
    unchanged(); expect(readMaintenanceReadiness(state)).toMatchObject({ state: "held", coverage: "partial", snapshot_ready: false, cutover_ready: false });
    await panel.getByRole("combobox", { name: "Programación de rutina", exact: true }).selectOption("manual");
    await panel.getByRole("button", { name: "Revisar configuración", exact: true }).click(); const beforeHeld = mutations.length;
    await panel.getByRole("button", { name: "Confirmar configuración", exact: true }).click(); await panel.getByRole("alert").waitFor();
    expect(mutations).toHaveLength(beforeHeld + 1); unchanged(); expect(await panel.getByRole("button", { name: "Confirmar configuración", exact: true }).count()).toBe(0);
    expect(await panel.getByRole("alert").textContent()).toContain("No hubo reintento automático");
    await panel.getByRole("button", { name: "Actualizar rutinas", exact: true }).click(); await panel.getByRole("checkbox", { name: "Rutina habilitada", exact: true }).waitFor();
    expect(await panel.getByRole("checkbox", { name: "Rutina habilitada", exact: true }).isChecked()).toBe(false); expect(readRoutineDocument(path)!.routines[id]!.revision).toBe(2);
    await page.evaluate(async () => { const value = await (await fetch("/api/session", { cache: "no-store" })).json() as { token: string };
      (globalThis as typeof globalThis & { __maintenancePriorSession: string }).__maintenancePriorSession = value.token; });
    await page.waitForLoadState("networkidle"); await closeApi();
    api = serve({ fetch: app().fetch, hostname: "127.0.0.1", port: apiPort }); if (!api.listening) await once(api, "listening"); apiClosed = false;
    await panel.getByRole("button", { name: "Revisar configuración", exact: true }).click(); const beforeStale = mutations.length;
    await panel.getByRole("button", { name: "Confirmar configuración", exact: true }).click(); await panel.getByRole("alert").waitFor();
    expect(mutations).toHaveLength(beforeStale + 1); unchanged(); expect(await panel.getByRole("button", { name: "Confirmar configuración", exact: true }).count()).toBe(0);
    expect(await page.evaluate(async () => { const value = await (await fetch("/api/session", { cache: "no-store" })).json() as { token: string };
      return value.token !== (globalThis as typeof globalThis & { __maintenancePriorSession: string }).__maintenancePriorSession; })).toBe(true);
    await panel.getByRole("button", { name: "Actualizar rutinas", exact: true }).click(); await panel.getByRole("checkbox", { name: "Rutina habilitada", exact: true }).waitFor();
    await panel.getByRole("button", { name: "Revisar configuración", exact: true }).click(); const beforeFresh = mutations.length;
    await panel.getByRole("button", { name: "Confirmar configuración", exact: true }).click(); await panel.getByRole("alert").waitFor();
    expect(mutations).toHaveLength(beforeFresh + 1); unchanged();
    await page.reload(); await page.getByText("Cockpit diario", { exact: true }).waitFor(); await panel.getByRole("combobox", { name: "Seleccionar rutina", exact: true }).selectOption(id);
    await panel.getByRole("checkbox", { name: "Rutina habilitada", exact: true }).waitFor(); unchanged();
    expect(await panel.getByRole("checkbox", { name: "Rutina habilitada", exact: true }).isChecked()).toBe(false);
    expect(await panel.getByRole("button", { name: "Revisar ejecución", exact: true }).isDisabled()).toBe(true);
    expect(Object.keys(readRoutineDocument(path)!.definitions)).toHaveLength(2); expect(readRoutineDocument(path)!.occurrences).toEqual({});
    for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 1000 });
      const layout = await panel.evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth })); expect(layout.scroll).toBeLessThanOrEqual(layout.client + 2); }
    expect(mutations).toHaveLength(5); expect(mutations.map(({ method, path: target }) => [method, target])).toEqual([["POST", "/api/routines"], ...Array.from({ length: 4 }, () => ["PUT", `/api/routines/${id}`])]);
    expect(mutations.map(({ body }) => body)).toEqual([{ action: "refresh-evidence", scope: companyScope },
      { expected_revision: 1, action: "refresh-evidence", scope: companyScope, enabled: false, schedule: "every:15m", concurrency: "coalesce", catch_up: "skip-missed" },
      { expected_revision: 2, action: "refresh-evidence", scope: companyScope, enabled: false, schedule: null, concurrency: "coalesce", catch_up: "skip-missed" },
      ...Array.from({ length: 2 }, () => ({ expected_revision: 2, action: "refresh-evidence", scope: companyScope, enabled: false, schedule: "every:15m", concurrency: "coalesce", catch_up: "skip-missed" }))]);
    // This existing GET always acquires the common store lock because it may
    // migrate. Under a hold its current API handler returns 500; the two React
    // development-mount requests are denied rather than bypassing the barrier.
    expect(httpErrors).toEqual([{ status: 409, method: "PUT", path: `/api/routines/${id}` }, { status: 403, method: "PUT", path: `/api/routines/${id}` }, { status: 409, method: "PUT", path: `/api/routines/${id}` },
      { status: 500, method: "GET", path: "/api/portfolio/profiles" }, { status: 500, method: "GET", path: "/api/portfolio/profiles" }]);
    expect(await page.getByText("En vivo", { exact: true }).count()).toBe(1); expect(fs.existsSync(join(state, "portfolio", "projects.json"))).toBe(false);
    expect(consoleErrors.filter((error) => !error.text.startsWith("Failed to load resource:") || !httpErrors.some((expected) => expected.path === error.path))).toEqual([]);
    expect(pageErrors).toEqual([]); expect(externalRequests).toEqual([]); expect(dispatch).not.toHaveBeenCalled(); expect(effect).not.toHaveBeenCalled();
    for (const name of ["tasks", "events", "budgets", "reports", "issues"]) expect(fs.existsSync(join(state, name))).toBe(false);
    unchanged(); expect(readMaintenanceReadiness(state).cutover_ready).toBe(false);
  } finally {
    try { if (browser) await browser.close(); browserClosed = !browser?.isConnected(); }
    finally { try { if (vite) await vite.close(); viteClosed = !vite?.httpServer?.listening; }
      finally { await closeApi(); if (browserClosed && viteClosed && apiClosed) {
        expect(dirname(resolve(fixture))).toBe(resolve(tmpdir())); expect(basename(fixture).startsWith("surtec-maintenance-browser-")).toBe(true); expect(fs.lstatSync(fixture).isSymbolicLink()).toBe(false);
        fs.rmSync(fixture, { recursive: true, force: true });
      }
      const result = { fixture_id: basename(fixture), browser_closed: browserClosed, vite_closed: viteClosed, api_stopped: apiClosed, workspace_removed: !fs.existsSync(fixture) };
      console.log("MAINTENANCE_BROWSER_CLEANUP", JSON.stringify(result)); expect(result).toMatchObject({ browser_closed: true, vite_closed: true, api_stopped: true, workspace_removed: true });
    } }
  }
}, 90000);
