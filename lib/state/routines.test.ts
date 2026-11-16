import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUDGET_DIMENSIONS, type BudgetLimits, type BudgetOccurrenceSubject, type BudgetPolicyBinding } from "../budgets/types";
import { budgetOccurrenceIntentId } from "../budgets/reservations";
import { routineRevisionKey, routineSlotKey } from "../routines/schedule";
import { ROUTINE_LIMITS, type RoutineDocument, type RoutineOccurrence, type RoutineReceipt, type RoutineRecord } from "../routines/types";
import { assertRoutineDocument, assertRoutineOccurrence, routineProposalKey } from "../routines/validation";
import { systemProcessEnvironment } from "../security/environment";
import { routineStatePath, routinesDir, maintenanceControlPath, maintenanceGatePath } from "./paths";
import { acquireMaintenanceExclusive, MaintenanceStateError, releaseMaintenanceExclusive, setMaintenanceHold } from "./maintenance";
import { assertRoutineOwnership, claimRoutineOccurrence, finishRoutineOccurrence, mutateRoutineDocument,
  readRoutineDocument, readRoutineTransaction, revokeRoutineOwnership, RoutineStateError,
  UnsupportedRoutineVersionError, updateRoutineTransaction, type RoutineOwnership, type RoutineTransaction } from "./routines";
import { StateLockConflictError } from "./store";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync), writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync), fsyncSync: vi.fn(actual.fsyncSync), unlinkSync: vi.fn(actual.unlinkSync) };
});
const roots: string[] = [], children = new Set<ChildProcess>();
afterEach(async () => {
  await Promise.all([...children].map((proc) => new Promise<void>((done) => { proc.once("close", () => done()); proc.kill(); })));
  children.clear(); vi.restoreAllMocks();
  for (const method of [openSync, writeFileSync, renameSync, fsyncSync, unlinkSync]) vi.mocked(method).mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const at = "2026-10-06T12:00:00Z", claimed = "2026-10-06T12:00:01Z", finished = "2026-10-06T12:00:02Z";
const later = "2026-10-06T12:00:03Z", digest = "a".repeat(64), otherDigest = "b".repeat(64);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "surtec-routine-state-")); roots.push(root);
  const state = join(root, "state");
  return { root, state, path: routineStatePath(state), lock: join(state, "locks", "routines.lock") };
}
function binding(): BudgetPolicyBinding {
  return { policy_id: "policy-company", policy_revision: 1, policy_fingerprint: digest,
    scope: { kind: "company", id: "surtec" }, period: "none", bucket: "none",
    limits: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: "unconfigured" }])) as BudgetLimits };
}
function record(id = "routine-1", time = at): RoutineRecord {
  return { schema_version: 1, id, revision: 1, action: "refresh-evidence", scope: { kind: "company", id: "surtec" },
    enabled: false, schedule: null, schedule_anchor_at: null, concurrency: "skip", catch_up: "skip-missed",
    policy: { revision: 1, fingerprint: digest, policy_ids: ["policy-company"] },
    limits: { max_projects: 25, max_attempts: 1, max_runtime_ms: 60000, max_concurrent_occurrences: 1 },
    created_at: time, updated_at: time };
}
function occurrence(definition = record(), id = "occurrence-1", slot = at): RoutineOccurrence {
  const value: RoutineOccurrence = { schema_version: 1, id, revision: 1, routine_id: definition.id,
    routine_revision: definition.revision, occurrence_key: routineSlotKey(definition.id, definition.revision, slot),
    definition: structuredClone(definition), slot, trigger: "manual", project_ids: ["synthetic"],
    attribution: { company_id: "surtec", objective_ids: [], project_ids: ["synthetic"], issue_id: null, role_id: null, execution_id: id },
    budget: { subject_id: `subject-${id}`, reservation_id: `reservation-${id}`, intent_id: "pending",
      cap_fingerprint: digest, admitted_runtime_ms: 60000, policy_bindings: [binding()] },
    status: "reserved", owner: null, started_at: null, finished_at: null, cancel_requested_at: null,
    receipt: null, created_at: slot, updated_at: slot };
  const subject: BudgetOccurrenceSubject = { id: value.budget.subject_id, kind: "occurrence", occurrence_id: id,
    routine_id: definition.id, routine_revision: definition.revision, slot, project_ids: value.project_ids, attribution: value.attribution };
  value.budget.intent_id = budgetOccurrenceIntentId({ subject, reservation_id: value.budget.reservation_id,
    policy_bindings: value.budget.policy_bindings, cap_fingerprint: digest, runtime_ms: 60000, created_at: slot });
  return value;
}
function receipt(value: RoutineOccurrence, time = finished): RoutineReceipt {
  const started = value.started_at;
  return { schema_version: 1, occurrence_id: value.id, occurrence_key: value.occurrence_key,
    routine_id: value.routine_id, routine_revision: value.routine_revision, slot: value.slot,
    action: value.definition.action, scope: structuredClone(value.definition.scope),
    policy_fingerprint: value.definition.policy.fingerprint, cap_fingerprint: value.budget.cap_fingerprint,
    project_ids: structuredClone(value.project_ids), started_at: started, finished_at: time, captured_at: time,
    freshness: "fresh", sources: [{ kind: "git", project_id: "synthetic", state: "fresh", observed_at: started, fingerprint: digest }],
    counts: { projects_selected: 1, facts_total: 1, facts_fresh: 1, facts_unavailable: 0,
      signals_evaluated: 0, proposals_created: 0, reports_written: 0 },
    consumption: { attempts: 1, runtime_ms: Date.parse(time) - Date.parse(started!), runtime_state: "complete",
      model_calls: 0, total_tokens: 0, workspace_writes: 0 },
    budget_outcome: "within-limit", proposals: [], failure_code: null, next_action: "none" };
}
function denied(value: RoutineOccurrence, time = claimed): RoutineReceipt {
  return { ...receipt(value, time), started_at: null, freshness: "unavailable", sources: [],
    counts: { projects_selected: 1, facts_total: 0, facts_fresh: 0, facts_unavailable: 0,
      signals_evaluated: 0, proposals_created: 0, reports_written: 0 },
    consumption: { attempts: 0, runtime_ms: 0, runtime_state: "complete", model_calls: 0, total_tokens: 0, workspace_writes: 0 },
    budget_outcome: "denied", failure_code: "budget-denied", next_action: "inspect-budget" };
}
function seed(draft: RoutineDocument, time: string, id = "routine-1"): void {
  const definition = record(id, time); draft.routines[id] = definition;
  draft.definitions[routineRevisionKey(id, 1)] = structuredClone(definition);
}
function setup(path: string, withOccurrence = false): void {
  mutateRoutineDocument((tx) => {
    updateRoutineTransaction(tx, seed);
    updateRoutineTransaction(tx, (draft, time) => configure(draft, time, { enabled: true }));
    if (withOccurrence) updateRoutineTransaction(tx, (draft, time) => {
      const value = occurrence(draft.routines["routine-1"]!, "occurrence-1", time); draft.occurrences[value.id] = value;
    });
  }, path, at);
}
function mutate(path: string, operation: (draft: RoutineDocument, time: string) => void, time = claimed): void {
  mutateRoutineDocument((tx) => updateRoutineTransaction(tx, operation), path, time);
}
function configure(draft: RoutineDocument, time: string, update: Partial<RoutineRecord> = {}): void {
  const value = { ...structuredClone(draft.routines["routine-1"]!), ...update,
    revision: draft.routines["routine-1"]!.revision + 1, updated_at: time };
  if (value.schedule !== null) value.schedule_anchor_at = time;
  draft.routines[value.id] = value; draft.definitions[routineRevisionKey(value.id, value.revision)] = structuredClone(value);
}
function claim(path: string): RoutineOwnership {
  return mutateRoutineDocument((tx) => claimRoutineOccurrence(tx, "occurrence-1", 1, "worker-1"), path, claimed);
}
function finish(path: string, proof: RoutineOwnership, status: "completed" | "partial" | "failed" | "cancelled" | "needs-review" = "completed", data?: RoutineReceipt): void {
  const value = readRoutineDocument(path)!.occurrences["occurrence-1"]!;
  mutateRoutineDocument((tx) => finishRoutineOccurrence(tx, proof, value.revision, data ?? receipt(value), status), path, data?.captured_at ?? finished);
}
function raw(path: string, bytes: string | Buffer): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); }
function openedPath(fd: number): string | undefined {
  const mock = vi.mocked(openSync).mock;
  for (let index = mock.results.length - 1; index >= 0; index--) {
    const result = mock.results[index]!;
    if (result.type === "return" && result.value === fd) {
      const file = mock.calls[index]?.[0]; return typeof file === "string" ? file : undefined;
    }
  }
  return undefined;
}
function hold(state: string): void {
  const ownership = acquireMaintenanceExclusive(state);
  try { setMaintenanceHold(ownership, { operation_id: "synthetic-restore", kind: "restore" }); }
  finally { releaseMaintenanceExclusive(ownership); }
}
function child(source: string, path: string) {
  const proc = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, path],
    { cwd: process.cwd(), env: systemProcessEnvironment(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  children.add(proc); let out = "", err = "";
  proc.stdout!.on("data", (data) => { out += String(data); }); proc.stderr!.on("data", (data) => { err += String(data); });
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolveDone, reject) => {
    proc.on("error", reject); proc.on("close", (code) => { children.delete(proc); resolveDone({ code, out, err }); });
  }); return { proc, done };
}
const moduleUrl = pathToFileURL(resolve("lib/state/routines.ts")).href;

describe("T009 private routine store", () => {
  it("reads optional absence without creating directories, history or locks", () => {
    const f = fixture(); expect(readRoutineDocument(f.path)).toBeNull(); expect(readRoutineDocument(f.path)).toBeNull(); expect(existsSync(f.state)).toBe(false);
  });
  it("honors additive selected paths and preserves unrelated state", () => {
    const f = fixture(); vi.stubEnv("SURTEC_STATE_DIR", f.state); raw(join(f.state, "unrelated.json"), "SYNTHETIC-UNTOUCHED");
    expect(routinesDir()).toBe(dirname(f.path)); expect(routineStatePath()).toBe(f.path); setup(f.path);
    expect(readRoutineDocument()!.revision).toBe(1); expect(readFileSync(join(f.state, "unrelated.json"), "utf8")).toBe("SYNTHETIC-UNTOUCHED");
  });
  it("commits once per transaction and retains exact immutable definition revisions", () => {
    const f = fixture(); setup(f.path); vi.mocked(renameSync).mockClear();
    mutateRoutineDocument((tx) => {
      updateRoutineTransaction(tx, (draft, time) => configure(draft, time, { enabled: false }));
      updateRoutineTransaction(tx, (draft, time) => configure(draft, time, { enabled: true }));
    }, f.path, claimed);
    const result = readRoutineDocument(f.path)!; expect(result.revision).toBe(2); expect(result.routines["routine-1"]!.revision).toBe(4);
    expect(result.definitions[routineRevisionKey("routine-1", 1)]).toEqual(record()); expect(Object.keys(result.definitions)).toHaveLength(4);
    expect(vi.mocked(renameSync)).toHaveBeenCalledTimes(1); expect(readdirSync(dirname(f.path))).toEqual(["routines.json"]); expect(existsSync(f.lock)).toBe(false);
  });
  it("never creates absent state or rewrites bytes and revision on no-op transactions", () => {
    const f = fixture(); mutateRoutineDocument(() => undefined, f.path, at); expect(existsSync(f.path)).toBe(false); setup(f.path);
    const bytes = readFileSync(f.path), stamp = lstatSync(f.path).mtimeMs;
    mutateRoutineDocument((tx) => { updateRoutineTransaction(tx, () => undefined); return { saved: true }; }, f.path, claimed);
    expect(readFileSync(f.path)).toEqual(bytes); expect(lstatSync(f.path).mtimeMs).toBe(stamp); expect(readRoutineDocument(f.path)!.revision).toBe(1);
  });
  it("returns frozen detached snapshots and revokes escaped transactions", () => {
    const f = fixture(); let escaped: RoutineTransaction | undefined, exposed: RoutineDocument | undefined;
    mutateRoutineDocument((tx) => {
      escaped = tx; expect(Object.isFrozen(tx)).toBe(true); expect(Object.keys(tx)).toEqual([]);
      updateRoutineTransaction(tx, (draft, time) => { seed(draft, time); exposed = draft; });
      const snapshot = readRoutineTransaction(tx); expect(snapshot.at).toBe(at); expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.document.routines["routine-1"]!.limits)).toBe(true);
      exposed!.routines["routine-1"]!.limits.max_projects = 1;
      expect(readRoutineTransaction(tx).document.routines["routine-1"]!.limits.max_projects).toBe(25);
    }, f.path, at);
    const result = readRoutineDocument(f.path)!; expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.routines["routine-1"]!)).toBe(true);
    expect(result.routines["routine-1"]!.limits.max_projects).toBe(25); expect(() => readRoutineTransaction(escaped)).toThrow();
  });
  it.each([null, undefined, {}, Object.freeze({}), "proof", 1])("rejects fabricated transaction proof %j before callbacks", (proof) => {
    const operation = vi.fn(seed); expect(() => readRoutineTransaction(proof)).toThrow(RoutineStateError);
    expect(() => updateRoutineTransaction(proof, operation)).toThrow(RoutineStateError); expect(operation).not.toHaveBeenCalled();
  });
  it("refuses copied/proxy proofs and reentrant transactions/updates without invoking traps", () => {
    const f = fixture(), hook = vi.fn(); mutateRoutineDocument((tx) => {
      expect(() => readRoutineTransaction({ ...tx })).toThrow(); expect(() => readRoutineTransaction(structuredClone(tx))).toThrow();
      expect(() => readRoutineTransaction(new Proxy(tx, { getPrototypeOf: hook as never }))).toThrow();
      expect(() => mutateRoutineDocument(() => undefined, f.path, at)).toThrow(/reentrant/);
      expect(() => updateRoutineTransaction(tx, () => readRoutineTransaction(tx))).toThrow(/reentrant/); updateRoutineTransaction(tx, seed);
    }, f.path, at); expect(hook).not.toHaveBeenCalled();
  });
  it("rejects async/proxy callbacks and thenables without publishing staged edits or invoking hooks", () => {
    const f = fixture(); setup(f.path); const before = readFileSync(f.path), hook = vi.fn();
    expect(() => mutateRoutineDocument(async () => undefined, f.path, claimed)).toThrow(/synchronous/);
    expect(() => mutateRoutineDocument(new Proxy(() => undefined, { apply: hook }), f.path, claimed)).toThrow();
    expect(() => mutateRoutineDocument((tx) => updateRoutineTransaction(tx, async (draft, time) => configure(draft, time)), f.path, claimed)).toThrow(/synchronous/);
    const thenable = Object.defineProperty({}, "then", { get: hook });
    for (const result of [thenable, { then: hook }, new Proxy({}, { ownKeys: hook as never }), Promise.resolve()]) {
      const owned = fixture(); setup(owned.path); const bytes = readFileSync(owned.path);
      expect(() => mutateRoutineDocument(() => result, owned.path, claimed)).toThrow(RoutineStateError);
      expect(readFileSync(owned.path)).toEqual(bytes); expect(existsSync(maintenanceGatePath(owned.state))).toBe(true);
    }
    expect(hook).not.toHaveBeenCalled(); expect(readFileSync(f.path)).toEqual(before);
  });
  it("rolls back thrown/invalid/accessor drafts and invalidates retained transactions", () => {
    const f = fixture(); setup(f.path); const before = readFileSync(f.path), hook = vi.fn(); let escaped: RoutineTransaction | undefined;
    expect(() => mutateRoutineDocument((tx) => { escaped = tx; updateRoutineTransaction(tx, (draft, time) => configure(draft, time)); throw new Error("synthetic failure"); }, f.path, claimed)).toThrow(/synthetic failure/);
    expect(() => mutate(f.path, (draft) => Object.defineProperty(draft, "routines", { enumerable: true, get: hook }))).toThrow();
    expect(hook).not.toHaveBeenCalled(); expect(() => readRoutineTransaction(escaped)).toThrow(); expect(readFileSync(f.path)).toEqual(before);
  });
  it.each(["{", "null", "[]", '{"schema_version":"1"}', '{"schema_version":0}', '{"schema_version":1}', '{"schema_version":2}', '{"schema_version":1,"private":"SYNTHETIC-PRIVATE"}'])
    ("preserves invalid/future bytes without locks, repair or callbacks %s", (bytes) => {
      const f = fixture(); raw(f.path, bytes); const callback = vi.fn(); expect(() => readRoutineDocument(f.path)).toThrow(RoutineStateError);
      expect(() => mutateRoutineDocument(callback, f.path, at)).toThrow(RoutineStateError); expect(callback).not.toHaveBeenCalled();
      expect(readFileSync(f.path, "utf8")).toBe(bytes); expect(existsSync(dirname(f.lock))).toBe(false);
    });
  it("reports future version without leaking the body or selected private path", () => {
    const f = fixture(); raw(f.path, '{"schema_version":987,"private":"SYNTHETIC-PRIVATE"}');
    try { readRoutineDocument(f.path); throw new Error("must reject"); } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedRoutineVersionError); expect((error as UnsupportedRoutineVersionError).version).toBe(987);
      expect((error as Error).message).not.toContain("SYNTHETIC-PRIVATE"); expect((error as Error).message).not.toContain(f.root);
    }
  });
  it("rejects oversized and invalid UTF8 before lock/callback effects", () => {
    const f = fixture(); raw(f.path, " "); truncateSync(f.path, ROUTINE_LIMITS.documentBytes + 1); const callback = vi.fn();
    expect(() => mutateRoutineDocument(callback, f.path, at)).toThrow(); expect(lstatSync(f.path).size).toBe(ROUTINE_LIMITS.documentBytes + 1);
    expect(callback).not.toHaveBeenCalled(); expect(existsSync(dirname(f.lock))).toBe(false);
    raw(f.path, Buffer.from([0xff, 0xfe])); expect(() => readRoutineDocument(f.path)).toThrow(); expect(readFileSync(f.path)).toEqual(Buffer.from([0xff, 0xfe]));
  });
  it("rejects 10001-record drafts before replacement without losing the previous bytes", () => {
    const f = fixture(); setup(f.path); const before = readFileSync(f.path); vi.mocked(renameSync).mockClear();
    expect(() => mutate(f.path, (draft) => { for (let index = 0; index < ROUTINE_LIMITS.records; index++) draft.routines[`extra-${index}`] = record(`extra-${index}`); })).toThrow();
    expect(vi.mocked(renameSync)).not.toHaveBeenCalled(); expect(readFileSync(f.path)).toEqual(before); expect(existsSync(f.lock)).toBe(false);
  });
  it.each(["state", "routines", "file", "locks"])("refuses redirected %s paths without touching the destination", (kind) => {
    const f = fixture(), target = join(f.root, "target"); mkdirSync(target); raw(join(target, "sentinel"), "untouched");
    if (kind === "state") symlinkSync(target, f.state, "junction");
    else if (kind === "routines") { mkdirSync(f.state); symlinkSync(target, dirname(f.path), "junction"); }
    else if (kind === "locks") { mkdirSync(f.state); symlinkSync(target, dirname(f.lock), "junction"); }
    else { mkdirSync(dirname(f.path), { recursive: true }); symlinkSync(target, f.path, "junction"); }
    expect(() => setup(f.path)).toThrow(RoutineStateError); expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("untouched");
    expect(existsSync(join(target, "routines.lock"))).toBe(false);
  });
  it("refuses hard-linked and directory snapshots without mutation", () => {
    const f = fixture(); raw(join(f.root, "original"), "{}"); mkdirSync(dirname(f.path), { recursive: true }); linkSync(join(f.root, "original"), f.path);
    expect(() => setup(f.path)).toThrow(); expect(readFileSync(join(f.root, "original"), "utf8")).toBe("{}");
    const other = fixture(); mkdirSync(other.path, { recursive: true }); expect(() => readRoutineDocument(other.path)).toThrow();
  });
  it.each([0, 60000, 86400000])("never steals an unknown lock at age %i", (age) => {
    const f = fixture(); raw(f.lock, "unknown owner"); const time = new Date(Date.now() - age); utimesSync(f.lock, time, time);
    expect(() => setup(f.path)).toThrow(StateLockConflictError); expect(readFileSync(f.lock, "utf8")).toBe("unknown owner"); expect(existsSync(f.path)).toBe(false);
  });
  it.each(["token", "inode"])("preserves a replacement lock and previous snapshot after %s ownership loss", (kind) => {
    const f = fixture(); setup(f.path); const before = readFileSync(f.path);
    expect(() => mutateRoutineDocument((tx) => {
      updateRoutineTransaction(tx, (draft, time) => configure(draft, time)); if (kind === "inode") renameSync(f.lock, `${f.lock}.old`);
      raw(f.lock, "replacement owner"); expect(() => readRoutineTransaction(tx)).toThrow(/ownership/);
    }, f.path, claimed)).toThrow(/ownership/);
    expect(readFileSync(f.path)).toEqual(before); expect(readFileSync(f.lock, "utf8")).toBe("replacement owner");
  });
  it.each(["write", "flush", "rename"])("preserves the old snapshot and unowned stage on %s failure", async (kind) => {
    const f = fixture(); setup(f.path); raw(`${f.path}.unknown.tmp`, "unowned"); const before = readFileSync(f.path);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const stage = (file: string | undefined) => file?.startsWith(`${f.path}.`) && file.endsWith(".tmp") && !file.endsWith(".unknown.tmp");
    if (kind === "write") vi.mocked(writeFileSync).mockImplementation((file, data, options) => {
      if (typeof file === "number" && stage(openedPath(file))) throw new Error("SYNTHETIC-PRIVATE");
      actual.writeFileSync(file, data, options);
    });
    if (kind === "flush") vi.mocked(fsyncSync).mockImplementation((fd) => { if (stage(openedPath(fd))) throw new Error("SYNTHETIC-PRIVATE"); actual.fsyncSync(fd); });
    if (kind === "rename") vi.mocked(renameSync).mockImplementation((from, to) => { if (to === f.path) throw new Error("SYNTHETIC-PRIVATE"); actual.renameSync(from, to); });
    expect(() => mutate(f.path, (draft, time) => configure(draft, time))).toThrow(/replacement failed/);
    expect(readFileSync(f.path)).toEqual(before); expect(readdirSync(dirname(f.path)).sort()).toEqual(["routines.json", "routines.json.unknown.tmp"]);
    expect(existsSync(f.lock)).toBe(false);
  });
  it("cleans only its own uninitialized lock when token writing fails", async () => {
    const f = fixture(), actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(writeFileSync).mockImplementation((file, data, options) => { if (typeof file === "number" && openedPath(file) === f.lock) throw new Error("SYNTHETIC-PRIVATE"); actual.writeFileSync(file, data, options); });
    expect(() => setup(f.path)).toThrow(/initialization failed/); expect(existsSync(f.lock)).toBe(false); expect(existsSync(f.path)).toBe(false);
  });
  it("reports unlock failure honestly without refunding an already committed revision", async () => {
    const f = fixture(); setup(f.path); const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(unlinkSync).mockImplementation((file) => { if (file === f.lock) throw new Error("SYNTHETIC-PRIVATE"); actual.unlinkSync(file); });
    expect(() => mutate(f.path, (draft, time) => configure(draft, time))).toThrow(/lock release failed/);
    expect(readRoutineDocument(f.path)!.revision).toBe(2); expect(existsSync(f.lock)).toBe(true);
    expect(() => mutateRoutineDocument(() => undefined, f.path, claimed)).toThrow(StateLockConflictError);
  });
  it("sanitizes inaccessible reads without substituting optional absence", () => {
    const f = fixture(); raw(f.path, "{}"); vi.mocked(openSync).mockImplementationOnce(() => { throw Object.assign(new Error(f.root), { code: "EACCES" }); });
    try { readRoutineDocument(f.path); throw new Error("must reject"); } catch (error) { expect(error).toBeInstanceOf(RoutineStateError); expect((error as Error).message).not.toContain(f.root); }
  });
  it.each(["routine-delete", "history-delete", "history-rewrite", "routine-rebind", "created-reset", "child-revision-skip", "aggregate-revision", "aggregate-clock", "occurrence-delete", "occurrence-rebind", "occurrence-revision", "budget-rebind"])
    ("preserves exact bytes after append-only/revision violation %s", (kind) => {
      const f = fixture(); setup(f.path, true); const before = readFileSync(f.path);
      expect(() => mutate(f.path, (draft, time) => {
        const value = draft.occurrences["occurrence-1"]!;
        if (kind === "routine-delete") delete draft.routines["routine-1"];
        if (kind === "history-delete") delete draft.definitions[routineRevisionKey("routine-1", 1)];
        if (kind === "history-rewrite") { draft.routines["routine-1"]!.enabled = false; draft.definitions[routineRevisionKey("routine-1", 1)]!.enabled = false; }
        if (kind === "routine-rebind") draft.routines["routine-1"]!.id = "other";
        if (kind === "created-reset") { configure(draft, time); draft.routines["routine-1"]!.created_at = time; }
        if (kind === "child-revision-skip") { configure(draft, time); draft.routines["routine-1"]!.revision++; }
        if (kind === "aggregate-revision") draft.revision++;
        if (kind === "aggregate-clock") draft.updated_at = later;
        if (kind === "occurrence-delete") delete draft.occurrences[value.id];
        if (kind === "occurrence-rebind") { value.slot = time; value.revision++; value.updated_at = time; }
        if (kind === "occurrence-revision") { value.cancel_requested_at = time; value.revision += 2; value.updated_at = time; }
        if (kind === "budget-rebind") { value.budget.cap_fingerprint = otherDigest; value.revision++; value.updated_at = time; }
      })).toThrow(); expect(readFileSync(f.path)).toEqual(before);
    });
  it("rejects clock regression and exhausted aggregate revision without replacing bytes", () => {
    const f = fixture(); setup(f.path); const before = readFileSync(f.path);
    expect(() => mutateRoutineDocument(() => undefined, f.path, "2026-10-05T12:00:00Z")).toThrow(/clock/); expect(readFileSync(f.path)).toEqual(before);
    const draft = structuredClone(readRoutineDocument(f.path)!); draft.revision = Number.MAX_SAFE_INTEGER; raw(f.path, JSON.stringify(draft)); const high = readFileSync(f.path);
    expect(() => mutate(f.path, (value, time) => configure(value, time))).toThrow(/revision/); expect(readFileSync(f.path)).toEqual(high);
  });
  it("preserves cancellation intent once requested and permits unstarted denied closure", () => {
    const f = fixture(); setup(f.path, true);
    mutate(f.path, (draft, time) => { const value = draft.occurrences["occurrence-1"]!; value.cancel_requested_at = time; value.revision++; value.updated_at = time; });
    const before = readFileSync(f.path);
    expect(() => mutate(f.path, (draft, time) => { const value = draft.occurrences["occurrence-1"]!; value.cancel_requested_at = null; value.revision++; value.updated_at = time; }, finished)).toThrow();
    expect(readFileSync(f.path)).toEqual(before);
    mutate(f.path, (draft, time) => { const value = draft.occurrences["occurrence-1"]!; value.status = "cancelled"; value.finished_at = time;
      value.receipt = denied(value, time); value.receipt.budget_outcome = "within-limit"; value.receipt.failure_code = "cancelled"; value.receipt.next_action = "run-new-occurrence";
      value.revision++; value.updated_at = time; }, finished);
    expect(readRoutineDocument(f.path)!.occurrences["occurrence-1"]!.receipt!.consumption.attempts).toBe(0);
  });
  it("blocks overlapping admissions and stale/disabled definitions before any claim", () => {
    const f = fixture(); setup(f.path, true); const before = readFileSync(f.path);
    expect(() => mutate(f.path, (draft, time) => { const value = occurrence(draft.routines["routine-1"]!, "occurrence-2", time); draft.occurrences[value.id] = value; })).toThrow();
    expect(readFileSync(f.path)).toEqual(before); mutate(f.path, (draft, time) => configure(draft, time, { enabled: false }));
    expect(() => claim(f.path)).toThrow(); expect(readRoutineDocument(f.path)!.occurrences["occurrence-1"]!.status).toBe("reserved");
  });
  it("cannot fabricate running state or executed terminal evidence through generic updates", () => {
    const f = fixture(); setup(f.path, true); const before = readFileSync(f.path);
    for (const status of ["running", "completed"] as const) expect(() => mutate(f.path, (draft, time) => {
      const value = draft.occurrences["occurrence-1"]!; value.status = status; value.started_at = time;
      value.owner = { run_id: "fabricated-run", worker_id: "worker-1", claimed_at: time }; value.revision++; value.updated_at = time;
      if (status === "completed") { value.receipt = receipt(value, time); value.finished_at = time; }
    })).toThrow(); expect(readFileSync(f.path)).toEqual(before);
  });
  it("admits a new slot only after a proven terminal and never replays a duplicate slot alias", () => {
    const f = fixture(); setup(f.path, true); const proof = claim(f.path); finish(f.path, proof); const before = readFileSync(f.path);
    expect(() => mutate(f.path, (draft) => { const value = occurrence(draft.routines["routine-1"]!, "occurrence-2", "2026-10-06T12:00:00.000Z"); draft.occurrences[value.id] = value; }, later)).toThrow();
    expect(readFileSync(f.path)).toEqual(before);
    mutate(f.path, (draft, time) => { const value = occurrence(draft.routines["routine-1"]!, "occurrence-2", time); draft.occurrences[value.id] = value; }, later);
    expect(Object.keys(readRoutineDocument(f.path)!.occurrences)).toHaveLength(2);
  });
  it("retains terminal receipts/configuration history across disable and refuses terminal edits", () => {
    const f = fixture(); setup(f.path, true); const proof = claim(f.path); finish(f.path, proof);
    const terminal = structuredClone(readRoutineDocument(f.path)!.occurrences["occurrence-1"]!);
    mutate(f.path, (draft, time) => configure(draft, time, { enabled: false }), later);
    expect(readRoutineDocument(f.path)!.occurrences["occurrence-1"]).toEqual(terminal); const before = readFileSync(f.path);
    for (const field of ["status", "receipt", "revision"] as const) expect(() => mutate(f.path, (draft, time) => {
      const value = draft.occurrences["occurrence-1"]!;
      if (field === "status") value.status = "reserved";
      if (field === "receipt") value.receipt!.consumption.runtime_ms = 0;
      if (field === "revision") { value.revision++; value.updated_at = time; }
    }, later)).toThrow(); expect(readFileSync(f.path)).toEqual(before);
  });
  it("maintains schedule high-water and cannot resurrect a cleared pending slot", () => {
    const f = fixture(); setup(f.path); const first = "2026-10-06T12:15:00Z", second = "2026-10-06T12:30:00Z";
    mutate(f.path, (draft, time) => configure(draft, time, { schedule: "every:15m", concurrency: "coalesce" }), at);
    const key = routineRevisionKey("routine-1", 3);
    mutate(f.path, (draft, time) => { draft.cursors[key] = { schema_version: 1, routine_id: "routine-1", routine_revision: 3, evaluated_at: time, last_slot: first, pending_slot: first }; }, first);
    mutate(f.path, (draft, time) => { draft.cursors[key]!.evaluated_at = time; draft.cursors[key]!.pending_slot = null; }, first);
    const before = readFileSync(f.path);
    expect(() => mutate(f.path, (draft) => { draft.cursors[key]!.pending_slot = first; }, first)).toThrow(); expect(readFileSync(f.path)).toEqual(before);
    mutate(f.path, (draft, time) => { draft.cursors[key]!.evaluated_at = time; draft.cursors[key]!.last_slot = second; draft.cursors[key]!.pending_slot = second; }, second);
    const high = readFileSync(f.path);
    for (const kind of ["delete", "evaluated", "slot"] as const) expect(() => mutate(f.path, (draft) => {
      if (kind === "delete") delete draft.cursors[key]; if (kind === "evaluated") draft.cursors[key]!.evaluated_at = first;
      if (kind === "slot") { draft.cursors[key]!.last_slot = first; draft.cursors[key]!.pending_slot = null; }
    }, second)).toThrow(); expect(readFileSync(f.path)).toEqual(high);
  });

  it("issues private ownership only for an already durable reservation and after lock release", () => {
    const f = fixture(); setup(f.path, true); let issued: RoutineOwnership | undefined;
    const proof = mutateRoutineDocument((tx) => {
      issued = claimRoutineOccurrence(tx, "occurrence-1", 1, "worker-1"); expect(Object.isFrozen(issued)).toBe(true); expect(Object.keys(issued)).toEqual([]);
      expect(() => assertRoutineOwnership(issued, f.path)).toThrow(); return issued;
    }, f.path, claimed);
    expect(proof).toBe(issued); expect(existsSync(f.lock)).toBe(false); const owned = assertRoutineOwnership(proof, f.path);
    expect(owned.status).toBe("running"); expect(owned.revision).toBe(2); expect(Object.isFrozen(owned)).toBe(true);
    expect(owned.owner!.worker_id).toBe("worker-1"); expect(owned.owner!.run_id).not.toBe("worker-1"); expect(owned.started_at).toBe(claimed);
  });
  it("refuses same-transaction synthetic admission/claim without publishing a new store", () => {
    const f = fixture(); expect(() => mutateRoutineDocument((tx) => {
      updateRoutineTransaction(tx, seed); updateRoutineTransaction(tx, (draft, time) => configure(draft, time, { enabled: true }));
      updateRoutineTransaction(tx, (draft, time) => { draft.occurrences["occurrence-1"] = occurrence(draft.routines["routine-1"]!, "occurrence-1", time); });
      claimRoutineOccurrence(tx, "occurrence-1", 1, "worker-1");
    }, f.path, at)).toThrow(); expect(existsSync(f.path)).toBe(false);
  });
  it.each([null, undefined, {}, Object.freeze({}), "proof", 1])("rejects fabricated execution ownership %j", (proof) => {
    expect(() => assertRoutineOwnership(proof)).toThrow(RoutineStateError);
  });
  it("rejects copied/proxy proofs, wrong paths, stale claims and duplicate owners", () => {
    const f = fixture(), other = fixture(); setup(f.path, true); const proof = claim(f.path), hook = vi.fn(); const before = readFileSync(f.path);
    for (const copied of [{ ...proof }, structuredClone(proof), new Proxy(proof, { getPrototypeOf: hook as never }), readRoutineDocument(f.path)!.occurrences["occurrence-1"]!.owner])
      expect(() => assertRoutineOwnership(copied, f.path)).toThrow();
    expect(hook).not.toHaveBeenCalled(); expect(() => assertRoutineOwnership(proof, other.path)).toThrow();
    expect(() => mutateRoutineDocument((tx) => claimRoutineOccurrence(tx, "occurrence-1", 1, "worker-1"), f.path, finished)).toThrow();
    expect(readFileSync(f.path)).toEqual(before); expect(assertRoutineOwnership(proof, f.path).owner).toEqual(readRoutineDocument(f.path)!.occurrences["occurrence-1"]!.owner);
  });
  it("revokes claims from aborted, failed writes or failed lock release", () => {
    for (const kind of ["callback", "rename", "unlock"] as const) {
      const f = fixture(); setup(f.path, true); let proof: RoutineOwnership | undefined; const before = readFileSync(f.path);
      if (kind === "rename") vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("synthetic rename"); });
      if (kind === "unlock") vi.mocked(unlinkSync).mockImplementationOnce(() => { throw new Error("synthetic unlock"); });
      expect(() => mutateRoutineDocument((tx) => { proof = claimRoutineOccurrence(tx, "occurrence-1", 1, "worker-1"); if (kind === "callback") throw new Error("synthetic abort"); }, f.path, claimed)).toThrow();
      expect(() => assertRoutineOwnership(proof, f.path)).toThrow();
      if (kind !== "unlock") expect(readFileSync(f.path)).toEqual(before); else expect(readRoutineDocument(f.path)!.occurrences["occurrence-1"]!.status).toBe("running");
    }
  });
  it("supports exact once private completion and rejects stale revision/foreign receipt before writing", () => {
    const f = fixture(); setup(f.path, true); const proof = claim(f.path), value = readRoutineDocument(f.path)!.occurrences["occurrence-1"]!, before = readFileSync(f.path);
    expect(() => mutateRoutineDocument((tx) => finishRoutineOccurrence(tx, proof, 1, receipt(value), "completed"), f.path, finished)).toThrow();
    const foreign = receipt(value); foreign.occurrence_id = "other";
    expect(() => mutateRoutineDocument((tx) => finishRoutineOccurrence(tx, proof, 2, foreign, "completed"), f.path, finished)).toThrow(); expect(readFileSync(f.path)).toEqual(before);
    finish(f.path, proof); expect(readRoutineDocument(f.path)!.occurrences["occurrence-1"]!.revision).toBe(3);
    expect(() => assertRoutineOwnership(proof, f.path)).toThrow(); expect(() => finish(f.path, proof)).toThrow();
  });
  it("permits cancellation/disabled configuration closure but denies further effects", () => {
    const f = fixture(); setup(f.path, true); const proof = claim(f.path);
    mutate(f.path, (draft, time) => {
      configure(draft, time, { enabled: false }); const value = draft.occurrences["occurrence-1"]!;
      value.cancel_requested_at = time; value.revision++; value.updated_at = time;
    }, finished); expect(() => assertRoutineOwnership(proof, f.path)).toThrow();
    const value = readRoutineDocument(f.path)!.occurrences["occurrence-1"]!, data = receipt(value, later);
    data.freshness = "partial"; data.failure_code = "cancelled"; data.next_action = "run-new-occurrence";
    finish(f.path, proof, "cancelled", data); expect(readRoutineDocument(f.path)!.occurrences["occurrence-1"]!.status).toBe("cancelled");
    expect(readRoutineDocument(f.path)!.occurrences["occurrence-1"]!.definition.enabled).toBe(true);
  });
  it("cannot wash an earlier configuration fence through a later revision", () => {
    const f = fixture(); setup(f.path, true); const proof = claim(f.path);
    mutate(f.path, (draft, time) => configure(draft, time, { enabled: false }), finished);
    const value = readRoutineDocument(f.path)!.occurrences["occurrence-1"]!;
    const data = receipt(value, later), after = "2026-10-06T12:00:04Z";
    mutate(f.path, (draft, time) => configure(draft, time, { enabled: true }), after);
    data.captured_at = after; const before = readFileSync(f.path);
    expect(() => finish(f.path, proof, "completed", data)).toThrow(/configuration change/);
    expect(readFileSync(f.path)).toEqual(before);
    const earlier = receipt(value, finished); earlier.captured_at = after;
    finish(f.path, proof, "completed", earlier);
    expect(readRoutineDocument(f.path)!.occurrences[value.id]!.receipt).toEqual(earlier);
  });
  it("cannot erase the known attempt through private uncertain completion", () => {
    const f = fixture(); setup(f.path, true); const proof = claim(f.path);
    const value = readRoutineDocument(f.path)!.occurrences["occurrence-1"]!, data = receipt(value);
    data.finished_at = null; data.freshness = "unavailable"; data.sources = [];
    data.counts.facts_total = data.counts.facts_fresh = 0;
    data.consumption.attempts = null; data.consumption.runtime_ms = null; data.consumption.runtime_state = "unknown";
    data.budget_outcome = "unknown"; data.failure_code = "ownership-unavailable"; data.next_action = "resolve-ownership";
    const before = readFileSync(f.path);
    expect(() => finish(f.path, proof, "needs-review", data)).toThrow(/known claimed attempt/);
    expect(readFileSync(f.path)).toEqual(before);
    data.consumption.attempts = 1; finish(f.path, proof, "needs-review", data);
    expect(readRoutineDocument(f.path)!.occurrences[value.id]!.receipt!.consumption.attempts).toBe(1);
  });
  it("retains exact runtime excess as exhausted rather than clipping to the admitted cap", () => {
    const f = fixture(); setup(f.path, true); const proof = claim(f.path), value = readRoutineDocument(f.path)!.occurrences["occurrence-1"]!;
    const data = receipt(value, "2026-10-06T12:01:02Z"); data.freshness = "partial"; data.budget_outcome = "exhausted";
    data.failure_code = "deadline-exceeded"; data.next_action = "inspect-budget";
    finish(f.path, proof, "failed", data); expect(readRoutineDocument(f.path)!.occurrences["occurrence-1"]!.receipt!.consumption.runtime_ms).toBe(61000);
  });
  it.each(["cancel", "configuration"])("refuses fresh completion after the %s fence but retains a known earlier finish", (kind) => {
    const f = fixture(); setup(f.path, true); const proof = claim(f.path);
    mutate(f.path, (draft, time) => {
      if (kind === "configuration") configure(draft, time, { enabled: false });
      else { const value = draft.occurrences["occurrence-1"]!; value.cancel_requested_at = time; value.revision++; value.updated_at = time; }
    }, finished);
    const value = readRoutineDocument(f.path)!.occurrences["occurrence-1"]!, bytes = readFileSync(f.path);
    expect(() => finish(f.path, proof, "completed", receipt(value, later))).toThrow(); expect(readFileSync(f.path)).toEqual(bytes);
    const known = receipt(value, finished); known.captured_at = later;
    finish(f.path, proof, "completed", known);
    expect(readRoutineDocument(f.path)!.occurrences["occurrence-1"]!.finished_at).toBe(finished);
    expect(readRoutineDocument(f.path)!.occurrences["occurrence-1"]!.receipt).toEqual(known);
  });
  it("revocation never reconstructs persisted authority or allows private finalization", () => {
    const f = fixture(); setup(f.path, true); const proof = claim(f.path), before = readFileSync(f.path);
    revokeRoutineOwnership(proof); revokeRoutineOwnership(proof); expect(() => assertRoutineOwnership(proof, f.path)).toThrow();
    expect(() => finish(f.path, proof)).toThrow(); expect(readFileSync(f.path)).toEqual(before);
    expect(() => assertRoutineOwnership(readRoutineDocument(f.path)!.occurrences["occurrence-1"]!.owner, f.path)).toThrow();
  });
  it("permits conservative ownership-loss recovery without new facts/effects or later replay", () => {
    const f = fixture(); setup(f.path, true); const proof = claim(f.path); revokeRoutineOwnership(proof);
    mutate(f.path, (draft, time) => {
      const value = draft.occurrences["occurrence-1"]!, data = receipt(value, time);
      value.status = "needs-review"; value.revision++; value.updated_at = time; value.finished_at = null;
      data.finished_at = null; data.freshness = "unavailable"; data.sources = []; data.counts.facts_total = data.counts.facts_fresh = 0;
      data.consumption.runtime_ms = null; data.consumption.runtime_state = "unknown"; data.budget_outcome = "unknown";
      data.failure_code = "ownership-unavailable"; data.next_action = "resolve-ownership"; value.receipt = data;
    }, finished);
    const result = readRoutineDocument(f.path)!.occurrences["occurrence-1"]!; expect(result.owner!.worker_id).toBe("worker-1");
    expect(result.receipt!.consumption.runtime_ms).toBeNull(); const before = readFileSync(f.path);
    expect(() => mutate(f.path, (draft, time) => { const value = occurrence(draft.routines["routine-1"]!, "occurrence-2", time); draft.occurrences[value.id] = value; }, later)).toThrow();
    expect(readFileSync(f.path)).toEqual(before);
  });
  it("never fabricates recovery facts/proposals/effects while ownership is lost", () => {
    const f = fixture(); setup(f.path, true); const proof = claim(f.path); revokeRoutineOwnership(proof); const before = readFileSync(f.path);
    expect(() => mutate(f.path, (draft, time) => {
      const value = draft.occurrences["occurrence-1"]!, data = receipt(value, time); value.status = "needs-review"; value.revision++; value.updated_at = time;
      value.finished_at = null; data.finished_at = null; data.freshness = "partial"; data.consumption.runtime_ms = null;
      data.consumption.runtime_state = "unknown"; data.budget_outcome = "unknown"; data.failure_code = "ownership-unavailable";
      data.next_action = "resolve-ownership"; value.receipt = data;
    }, finished)).toThrow(); expect(readFileSync(f.path)).toEqual(before);
  });
  it("never erases a known durable attempt when recovering unknown runtime", () => {
    const f = fixture(); setup(f.path, true); const proof = claim(f.path); revokeRoutineOwnership(proof); const before = readFileSync(f.path);
    expect(() => mutate(f.path, (draft, time) => {
      const value = draft.occurrences["occurrence-1"]!, data = receipt(value, time);
      value.status = "needs-review"; value.revision++; value.updated_at = time; value.finished_at = null;
      data.finished_at = null; data.freshness = "unavailable"; data.sources = []; data.counts.facts_total = data.counts.facts_fresh = 0;
      data.consumption.attempts = null; data.consumption.runtime_ms = null; data.consumption.runtime_state = "unknown"; data.budget_outcome = "unknown";
      data.failure_code = "ownership-unavailable"; data.next_action = "resolve-ownership"; value.receipt = data;
    }, finished)).toThrow(); expect(readFileSync(f.path)).toEqual(before);
  });
  it("refuses out-of-band snapshot changes before publishing its draft and preserves the newer bytes", () => {
    const f = fixture(); setup(f.path); let externalBytes = "";
    expect(() => mutateRoutineDocument((tx) => {
      updateRoutineTransaction(tx, (draft, time) => configure(draft, time, { enabled: false }));
      const external = structuredClone(readRoutineDocument(f.path)!); configure(external, claimed, { concurrency: "coalesce" });
      external.revision++; external.updated_at = claimed; assertRoutineDocument(external); externalBytes = JSON.stringify(external); raw(f.path, externalBytes);
    }, f.path, claimed)).toThrow(/snapshot changed/);
    expect(readFileSync(f.path, "utf8")).toBe(externalBytes); expect(existsSync(f.lock)).toBe(false);
    expect(readdirSync(dirname(f.path))).toEqual(["routines.json"]);
  });
  it.each(["owner", "run", "start", "configuration"])("refuses persisted %s rebinding without reconstructing ownership", (kind) => {
    const f = fixture(); setup(f.path, true); const proof = claim(f.path), changed = structuredClone(readRoutineDocument(f.path)!);
    const value = changed.occurrences["occurrence-1"]!;
    if (kind === "owner") value.owner!.worker_id = "other-worker";
    if (kind === "run") value.owner!.run_id = "other-run";
    if (kind === "start") { value.started_at = finished; value.updated_at = finished; changed.updated_at = finished; }
    if (kind === "configuration") {
      value.definition.action = "evaluate-signals"; changed.routines[value.routine_id]!.action = "evaluate-signals";
      changed.definitions[routineRevisionKey(value.routine_id, value.routine_revision)]!.action = "evaluate-signals";
    }
    assertRoutineDocument(changed); raw(f.path, JSON.stringify(changed)); const bytes = readFileSync(f.path);
    expect(() => assertRoutineOwnership(proof, f.path)).toThrow(); expect(() => finish(f.path, proof)).toThrow();
    expect(readFileSync(f.path)).toEqual(bytes);
  });
  it("retains live proof after a failed private finish and commits the same exact receipt on retry", () => {
    const f = fixture(); setup(f.path, true); const proof = claim(f.path), value = readRoutineDocument(f.path)!.occurrences["occurrence-1"]!, data = receipt(value);
    const bytes = readFileSync(f.path); vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("synthetic rename"); });
    expect(() => finish(f.path, proof, "completed", data)).toThrow(/replacement failed/); expect(readFileSync(f.path)).toEqual(bytes);
    expect(assertRoutineOwnership(proof, f.path).revision).toBe(2); finish(f.path, proof, "completed", data);
    expect(readRoutineDocument(f.path)!.occurrences["occurrence-1"]!.receipt).toEqual(data);
  });
  it("retains exact proposal identities permanently after private completion", () => {
    const f = fixture(); setup(f.path); mutate(f.path, (draft, time) => configure(draft, time, { action: "propose-issues" }), at);
    mutate(f.path, (draft, time) => { const value = occurrence(draft.routines["routine-1"]!, "occurrence-1", time); draft.occurrences[value.id] = value; }, at);
    const proof = claim(f.path), value = readRoutineDocument(f.path)!.occurrences["occurrence-1"]!, data = receipt(value);
    data.counts.proposals_created = 1; data.proposals = [{ key: routineProposalKey(value.occurrence_key, digest), fingerprint: digest, issue_id: "issue-1" }];
    data.next_action = "review-proposals"; finish(f.path, proof, "completed", data);
    const before = readFileSync(f.path); expect(() => mutate(f.path, (draft) => { draft.occurrences["occurrence-1"]!.receipt!.proposals = []; }, later)).toThrow();
    expect(readFileSync(f.path)).toEqual(before); expect(readRoutineDocument(f.path)!.occurrences["occurrence-1"]!.receipt!.proposals[0]!.issue_id).toBe("issue-1");
  });

  it("serializes real processes and reloads exact history without duplicate restart admission", async () => {
    const f = fixture(); setup(f.path, true);
    const holder = child(`import {mutateRoutineDocument,updateRoutineTransaction} from ${JSON.stringify(moduleUrl)};import{readSync}from'node:fs';mutateRoutineDocument(tx=>{process.stdout.write('LOCKED\\n');readSync(0,Buffer.alloc(1),0,1,null);updateRoutineTransaction(tx,(d,time)=>{const v=d.occurrences['occurrence-1'];v.cancel_requested_at=time;v.revision++;v.updated_at=time;});},process.argv[1],${JSON.stringify(claimed)});`, f.path);
    await new Promise<void>((ready, reject) => { let output = ""; holder.proc.stdout!.on("data", (data) => { output += String(data); if (output.includes("LOCKED")) ready(); });
      holder.proc.on("error", reject); holder.proc.on("close", (code) => reject(new Error(`holder exited before locking: ${code}`))); });
    const gateBytes = readFileSync(maintenanceGatePath(f.state));
    expect(() => acquireMaintenanceExclusive(f.state)).toThrow(StateLockConflictError);
    expect(readFileSync(maintenanceGatePath(f.state))).toEqual(gateBytes);
    const contender = child(`import{mutateRoutineDocument}from ${JSON.stringify(moduleUrl)};try{mutateRoutineDocument(()=>{throw new Error('must not run')},process.argv[1],${JSON.stringify(claimed)});process.exitCode=2;}catch(e){if(e.constructor.name!=='StateLockConflictError')throw e;process.stdout.write('CONFLICT');}`, f.path);
    expect(await contender.done).toEqual({ code: 0, out: "CONFLICT", err: "" }); holder.proc.stdin!.end("x"); expect(await holder.done).toEqual({ code: 0, out: "LOCKED\n", err: "" });
    expect(existsSync(f.lock)).toBe(false); const before = readFileSync(f.path);
    const restarted = child(`import{readRoutineDocument,mutateRoutineDocument,updateRoutineTransaction}from ${JSON.stringify(moduleUrl)};const path=process.argv[1],v=readRoutineDocument(path).occurrences['occurrence-1'];if(v.revision!==2||v.cancel_requested_at!==${JSON.stringify(claimed)})throw new Error('lost history');try{mutateRoutineDocument(tx=>updateRoutineTransaction(tx,d=>{d.occurrences['occurrence-2']={...structuredClone(v),id:'occurrence-2'};}),path,${JSON.stringify(finished)});process.exitCode=2;}catch(e){if(!['RoutineStateError','RoutineContractError'].includes(e.constructor.name))throw e;process.stdout.write('REPLAY-REFUSED');}`, f.path);
    expect(await restarted.done).toEqual({ code: 0, out: "REPLAY-REFUSED", err: "" }); expect(readFileSync(f.path)).toEqual(before); assertRoutineDocument(readRoutineDocument(f.path));
  }, 10000);
  it("cannot import stored owner inventory as authority after a real process restart", async () => {
    const f = fixture(); setup(f.path, true); const proof = claim(f.path); const before = readFileSync(f.path);
    const restarted = child(`import{readRoutineDocument,assertRoutineOwnership,mutateRoutineDocument,claimRoutineOccurrence}from ${JSON.stringify(moduleUrl)};const path=process.argv[1],v=readRoutineDocument(path).occurrences['occurrence-1'];let denied=0;try{assertRoutineOwnership(v.owner,path)}catch(e){if(e.constructor.name!=='RoutineStateError')throw e;denied++;}try{mutateRoutineDocument(tx=>claimRoutineOccurrence(tx,v.id,v.revision,'new-worker'),path,${JSON.stringify(finished)})}catch(e){if(e.constructor.name!=='RoutineStateError')throw e;denied++;}if(denied!==2)throw new Error('authority restored');process.stdout.write('OWNERSHIP-UNAVAILABLE');`, f.path);
    expect(await restarted.done).toEqual({ code: 0, out: "OWNERSHIP-UNAVAILABLE", err: "" }); expect(readFileSync(f.path)).toEqual(before);
    expect(assertRoutineOwnership(proof, f.path).status).toBe("running"); assertRoutineOccurrence(readRoutineDocument(f.path)!.occurrences["occurrence-1"]);
  }, 10000);
  it("preserves old committed bytes and refuses unknown lock takeover after its owned child crashes", async () => {
    const f = fixture(); setup(f.path, true); const before = readFileSync(f.path);
    const holder = child(`import{mutateRoutineDocument,updateRoutineTransaction}from ${JSON.stringify(moduleUrl)};import{readSync}from'node:fs';mutateRoutineDocument(tx=>{updateRoutineTransaction(tx,(d,time)=>{const v=d.occurrences['occurrence-1'];v.cancel_requested_at=time;v.revision++;v.updated_at=time;});process.stdout.write('STAGED\\n');readSync(0,Buffer.alloc(1),0,1,null);},process.argv[1],${JSON.stringify(claimed)});`, f.path);
    await new Promise<void>((ready, reject) => { let output = ""; holder.proc.stdout!.on("data", (data) => { output += String(data); if (output.includes("STAGED")) ready(); });
      holder.proc.on("error", reject); holder.proc.on("close", (code) => reject(new Error(`holder exited before staging: ${code}`))); });
    const lock = readFileSync(f.lock); expect(holder.proc.kill()).toBe(true); await holder.done;
    expect(readFileSync(f.path)).toEqual(before); expect(readFileSync(f.lock)).toEqual(lock); expect(readdirSync(dirname(f.path))).toEqual(["routines.json"]);
    const restarted = child(`import{readRoutineDocument,mutateRoutineDocument}from ${JSON.stringify(moduleUrl)};const path=process.argv[1];if(readRoutineDocument(path).occurrences['occurrence-1'].revision!==1)throw new Error('uncommitted history');try{mutateRoutineDocument(()=>{throw new Error('must not run')},path,${JSON.stringify(finished)});process.exitCode=2;}catch(e){if(e.constructor.name!=='StateLockConflictError')throw e;process.stdout.write('RECOVERY-REQUIRED');}`, f.path);
    expect(await restarted.done).toEqual({ code: 0, out: "RECOVERY-REQUIRED", err: "" }); expect(readFileSync(f.path)).toEqual(before); expect(readFileSync(f.lock)).toEqual(lock);
  }, 10000);
});

describe("T015 routine cooperative maintenance fencing", () => {
  it.each(["promise", "thenable", "getter", "inherited-then", "proxy"].flatMap((kind) => ["outer", "update"].map((phase) => [kind, phase])))
    ("retains uncertain routine ownership for a normal %s result from %s and invokes no hooks", (kind, phase) => {
      const f = fixture(); setup(f.path); const before = readFileSync(f.path), hook = vi.fn(); let escaped: RoutineTransaction | undefined;
      const result = kind === "promise" ? Promise.resolve() : kind === "thenable" ? { then: hook }
        : kind === "getter" ? Object.defineProperty({}, "then", { get: hook })
          : kind === "inherited-then" ? Object.create(Object.defineProperty({}, "then", { get: hook }))
            : new Proxy({}, { get: hook, ownKeys: hook as never, getPrototypeOf: hook as never });
      expect(() => mutateRoutineDocument((tx) => {
        escaped = tx;
        if (phase === "update") return updateRoutineTransaction(tx, (draft, time) => { configure(draft, time, { enabled: false }); return result; });
        updateRoutineTransaction(tx, (draft, time) => configure(draft, time, { enabled: false })); return result;
      }, f.path, claimed)).toThrow(RoutineStateError);
      expect(hook).not.toHaveBeenCalled(); expect(readFileSync(f.path)).toEqual(before); expect(existsSync(f.lock)).toBe(false);
      const marker = readFileSync(maintenanceGatePath(f.state)), callback = vi.fn();
      expect(() => mutateRoutineDocument(callback, f.path, claimed)).toThrow(StateLockConflictError);
      expect(() => acquireMaintenanceExclusive(f.state)).toThrow(StateLockConflictError);
      expect(() => updateRoutineTransaction(escaped, callback)).toThrow(RoutineStateError); expect(callback).not.toHaveBeenCalled();
      expect(readFileSync(f.path)).toEqual(before); expect(readFileSync(maintenanceGatePath(f.state))).toEqual(marker);
    });
  it("refuses a durable hold before missing-store mkdir, routine locking or callbacks", () => {
    const f = fixture(); hold(f.state); const control = readFileSync(maintenanceControlPath(f.state));
    const callback = vi.fn((tx: RoutineTransaction) => updateRoutineTransaction(tx, seed));
    expect(() => mutateRoutineDocument(callback, f.path, at)).toThrow(MaintenanceStateError);
    expect(callback).not.toHaveBeenCalled(); expect(existsSync(dirname(f.path))).toBe(false);
    expect(existsSync(dirname(f.lock))).toBe(false); expect(readRoutineDocument(f.path)).toBeNull();
    expect(readFileSync(maintenanceControlPath(f.state))).toEqual(control);
  });
  it("preserves immutable definitions, receipt history, proposal keys and cursor high-water under hold", () => {
    const f = fixture(); setup(f.path); mutate(f.path, (draft, time) => configure(draft, time, { action: "propose-issues" }), at);
    mutate(f.path, (draft, time) => { draft.occurrences["occurrence-1"] = occurrence(draft.routines["routine-1"]!, "occurrence-1", time); }, at);
    const proof = claim(f.path), entry = readRoutineDocument(f.path)!.occurrences["occurrence-1"]!, data = receipt(entry);
    data.counts.proposals_created = 1; data.proposals = [{ key: routineProposalKey(entry.occurrence_key, digest), fingerprint: digest, issue_id: "issue-1" }];
    data.next_action = "review-proposals"; finish(f.path, proof, "completed", data);
    mutate(f.path, (draft, time) => configure(draft, time, { schedule: "every:15m", concurrency: "coalesce" }), later);
    const slot = "2026-10-06T12:15:03Z", key = routineRevisionKey("routine-1", 4);
    mutate(f.path, (draft, time) => { draft.cursors[key] = { schema_version: 1, routine_id: "routine-1", routine_revision: 4, evaluated_at: time, last_slot: slot, pending_slot: slot }; }, slot);
    const before = readFileSync(f.path), stamp = lstatSync(f.path).mtimeMs; hold(f.state); const callback = vi.fn();
    expect(() => mutateRoutineDocument(callback, f.path, slot)).toThrow(MaintenanceStateError);
    expect(callback).not.toHaveBeenCalled(); expect(readFileSync(f.path)).toEqual(before); expect(lstatSync(f.path).mtimeMs).toBe(stamp);
    const snapshot = readRoutineDocument(f.path)!; expect(snapshot.occurrences[entry.id]!.receipt).toEqual(data);
    expect(snapshot.cursors[key]!.pending_slot).toBe(slot); expect(Object.keys(snapshot.definitions)).toHaveLength(4);
  });
  it("denies a held live routine proof and late completion without clearing or reconstructing ownership", () => {
    const f = fixture(); setup(f.path, true); const proof = claim(f.path), before = readFileSync(f.path); hold(f.state);
    expect(() => assertRoutineOwnership(proof, f.path)).toThrow(MaintenanceStateError);
    expect(() => finish(f.path, proof)).toThrow(MaintenanceStateError);
    expect(readFileSync(f.path)).toEqual(before); expect(readRoutineDocument(f.path)!.occurrences["occurrence-1"]!.status).toBe("running");
    expect(() => revokeRoutineOwnership(proof)).not.toThrow(); expect(() => revokeRoutineOwnership(proof)).not.toThrow();
    expect(() => assertRoutineOwnership(proof, f.path)).toThrow(RoutineStateError); expect(readFileSync(f.path)).toEqual(before);
  });
  it("never activates an issued routine proof when maintenance release fails after the durable claim", async () => {
    const f = fixture(); setup(f.path, true); const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    let proof: RoutineOwnership | undefined;
    vi.mocked(unlinkSync).mockImplementation((file) => {
      if (file === maintenanceGatePath(f.state)) throw new Error("synthetic maintenance release failure");
      actual.unlinkSync(file);
    });
    expect(() => mutateRoutineDocument((tx) => { proof = claimRoutineOccurrence(tx, "occurrence-1", 1, "worker-1"); }, f.path, claimed)).toThrow();
    expect(readRoutineDocument(f.path)!.occurrences["occurrence-1"]!.status).toBe("running");
    expect(existsSync(f.lock)).toBe(false); expect(existsSync(maintenanceGatePath(f.state))).toBe(true);
    expect(() => assertRoutineOwnership(proof, f.path)).toThrow(RoutineStateError);
  });
  it("blocks a held exclusive owner before callback and allows a fresh configuration only after proven release", () => {
    const f = fixture(); setup(f.path); const before = readFileSync(f.path), ownership = acquireMaintenanceExclusive(f.state), callback = vi.fn();
    try {
      expect(() => mutateRoutineDocument(callback, f.path, claimed)).toThrow(StateLockConflictError);
      expect(callback).not.toHaveBeenCalled(); expect(readFileSync(f.path)).toEqual(before); expect(readRoutineDocument(f.path)!.revision).toBe(1);
    } finally { releaseMaintenanceExclusive(ownership); }
    mutate(f.path, (draft, time) => configure(draft, time, { enabled: false })); expect(readRoutineDocument(f.path)!.revision).toBe(2);
  });
  it.each(["{", "null", '{"schema_version":2}', '{"schema_version":1}'])
    ("preserves malformed or future maintenance control without executing callbacks %s", (bytes) => {
      const f = fixture(); raw(maintenanceControlPath(f.state), bytes); const callback = vi.fn();
      expect(() => mutateRoutineDocument(callback, f.path, at)).toThrow(MaintenanceStateError);
      expect(callback).not.toHaveBeenCalled(); expect(readFileSync(maintenanceControlPath(f.state), "utf8")).toBe(bytes);
      expect(existsSync(f.path)).toBe(false); expect(existsSync(dirname(f.lock))).toBe(false);
    });
  it("rejects late transaction use after root-gate replacement without publishing a configured revision", () => {
    const f = fixture(); setup(f.path); const before = readFileSync(f.path), callback = vi.fn(configure); let escaped: RoutineTransaction | undefined;
    expect(() => mutateRoutineDocument((tx) => {
      escaped = tx; updateRoutineTransaction(tx, (draft, time) => configure(draft, time, { enabled: false }));
      raw(maintenanceGatePath(f.state), "unknown replacement");
      expect(() => updateRoutineTransaction(tx, callback)).toThrow(); expect(callback).not.toHaveBeenCalled();
    }, f.path, claimed)).toThrow();
    expect(readFileSync(f.path)).toEqual(before); expect(readFileSync(maintenanceGatePath(f.state), "utf8")).toBe("unknown replacement");
    expect(() => updateRoutineTransaction(escaped, callback)).toThrow(RoutineStateError); expect(callback).not.toHaveBeenCalled();
    expect(readdirSync(dirname(f.path))).toEqual(["routines.json"]);
  });
  it("fences a custom routine file at its dedicated parent without using an OS-temp shared root", () => {
    const f = fixture(), path = join(f.root, "custom-routines.json"), callback = vi.fn(); setup(path);
    expect(readRoutineDocument(path)!.revision).toBe(1); expect(existsSync(join(f.root, "locks", "routines.lock"))).toBe(false);
    hold(f.root); const before = readFileSync(path);
    expect(() => mutateRoutineDocument(callback, path, claimed)).toThrow(MaintenanceStateError);
    expect(callback).not.toHaveBeenCalled(); expect(readFileSync(path)).toEqual(before);
  });
});
