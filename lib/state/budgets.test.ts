import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUDGET_DIMENSIONS, BUDGET_LIMITS, type BudgetAmounts, type BudgetLedger, type BudgetLimits, type BudgetTaskSubject } from "../budgets/types";
import { assertBudgetLedger } from "../budgets/validation";
import { systemProcessEnvironment } from "../security/environment";
import { budgetStatePath, budgetsDir, maintenanceControlPath, maintenanceGatePath } from "./paths";
import { acquireMaintenanceExclusive, MaintenanceStateError, releaseMaintenanceExclusive, setMaintenanceHold } from "./maintenance";
import { BudgetStateError, mutateBudgetLedger, readBudgetLedger, readBudgetTransaction, UnsupportedBudgetVersionError, updateBudgetTransaction, type BudgetTransaction } from "./budgets";
import { StateLockConflictError } from "./store";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync), writeFileSync: vi.fn(actual.writeFileSync), renameSync: vi.fn(actual.renameSync), fsyncSync: vi.fn(actual.fsyncSync), unlinkSync: vi.fn(actual.unlinkSync) };
});
const roots: string[] = [], children = new Set<ChildProcess>();
afterEach(async () => {
  await Promise.all([...children].map((proc) => new Promise<void>((done) => { proc.once("close", () => done()); proc.kill(); }))); children.clear();
  vi.restoreAllMocks(); for (const method of [openSync, writeFileSync, renameSync, fsyncSync, unlinkSync]) vi.mocked(method).mockReset();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); vi.unstubAllEnvs();
});
const at = "2026-10-06T12:00:00Z", later = "2026-10-06T12:00:01Z", digest = "a".repeat(64);
const amounts = (values: Partial<BudgetAmounts> = {}): BudgetAmounts => Object.assign(Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, 0])), values) as BudgetAmounts;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "surtec-budget-state-")); roots.push(root); const state = join(root, "state");
  return { root, state, path: budgetStatePath(state), lock: join(state, "locks", "budgets.lock") };
}
function seed(draft: BudgetLedger, time: string, suffix = "1"): void {
  const subject: BudgetTaskSubject = { id: `S-${suffix}`, kind: "task", task_id: `T-${suffix}`, project_id: "synthetic", role_id: "analyst", agent_id: "synthetic-agent", issue_id: null, workflow: null,
    attribution: { company_id: "surtec", objective_ids: [], project_ids: ["synthetic"], issue_id: null, role_id: "analyst", execution_id: `T-${suffix}` } };
  draft.subjects[subject.id] = subject;
  draft.reservations[`R-${suffix}`] = { id: `R-${suffix}`, revision: 1, subject_id: subject.id, intent_id: `I-${suffix}`, status: "committed", policy_bindings: [{ policy_id: "company", policy_revision: 1, policy_fingerprint: digest, scope: { kind: "company", id: "surtec" }, period: "none", bucket: "none", limits: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: "unconfigured" }])) as BudgetLimits }], held: amounts({ attempts: 1, runtime_ms: 1000, total_tokens: 100, concurrent_reads: 1 }), uncertain_dimensions: [], run_ids: [], created_at: time, updated_at: time };
  draft.admission_intents[`I-${suffix}`] = { id: `I-${suffix}`, subject_id: subject.id, reservation_id: `R-${suffix}`, admission_id: `A-${suffix}`, status: "committed", created_at: time, updated_at: time };
}
function claim(draft: BudgetLedger, time: string): void {
  const reservation = draft.reservations["R-1"]!; reservation.revision++; reservation.status = "active"; reservation.updated_at = time; reservation.held.attempts = 0; reservation.run_ids.push("run-1");
  draft.charges["C-1"] = { id: "C-1", subject_id: "S-1", reservation_id: "R-1", run_id: "run-1", attempts: 1, runtime_ms: 0, observed_total_tokens: 0, runtime_state: "complete", usage_state: "complete", status: "running", review: false, correction: false, created_at: time, updated_at: time };
}
function terminal(draft: BudgetLedger, time: string): void {
  const charge = draft.charges["C-1"]!, reserve = draft.reservations["R-1"]!; charge.status = "terminal"; charge.runtime_ms = 100; charge.observed_total_tokens = 10; charge.updated_at = time;
  reserve.held.runtime_ms = 0; reserve.held.total_tokens = 90; reserve.revision++; reserve.updated_at = time;
}
function setup(path: string, active = false): void {
  mutateBudgetLedger((tx) => { updateBudgetTransaction(tx, seed); if (active) updateBudgetTransaction(tx, claim); }, path, at);
}
function mutate(path: string, operation: (draft: BudgetLedger, time: string) => void, time = later): void { mutateBudgetLedger((tx) => updateBudgetTransaction(tx, operation), path, time); }
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
  const proc = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, path], { cwd: process.cwd(), env: systemProcessEnvironment(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); children.add(proc);
  let out = "", err = ""; proc.stdout!.on("data", (data) => { out += String(data); }); proc.stderr!.on("data", (data) => { err += String(data); });
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolveDone, reject) => { proc.on("error", reject); proc.on("close", (code) => { children.delete(proc); resolveDone({ code, out, err }); }); });
  return { proc, done };
}
const moduleUrl = pathToFileURL(resolve("lib/state/budgets.ts")).href;

describe("T003 private budget ledger store", () => {
  it("reads explicit absence without directories, clock snapshots or fabricated history", () => {
    const f = fixture(); expect(readBudgetLedger(f.path)).toBeNull(); expect(readBudgetLedger(f.path)).toBeNull(); expect(existsSync(f.state)).toBe(false);
  });
  it("honors the selected state path while preserving unrelated state", () => {
    const f = fixture(); vi.stubEnv("SURTEC_STATE_DIR", f.state); raw(join(f.state, "unrelated.json"), "SYNTHETIC-UNTOUCHED");
    expect(budgetsDir()).toBe(dirname(f.path)); expect(budgetStatePath()).toBe(f.path); setup(f.path);
    expect(readBudgetLedger()!.revision).toBe(1); expect(readFileSync(join(f.state, "unrelated.json"), "utf8")).toBe("SYNTHETIC-UNTOUCHED");
  });
  it("writes once per transaction, increments the aggregate once, and reloads exact data", () => {
    const f = fixture(); setup(f.path, true); const first = readBudgetLedger(f.path)!; expect(first.revision).toBe(1); expect(first.reservations["R-1"]!.revision).toBe(2);
    mutate(f.path, terminal); expect(readBudgetLedger(f.path)!.revision).toBe(2); expect(readBudgetLedger(f.path)!.updated_at).toBe(later); expect(readdirSync(dirname(f.path))).toEqual(["budgets.json"]); expect(existsSync(f.lock)).toBe(false);
  });
  it("does not create an absent document or rewrite bytes/revisions for no-op updates", () => {
    const f = fixture(); mutateBudgetLedger(() => undefined, f.path, at); expect(existsSync(f.path)).toBe(false); setup(f.path); const bytes = readFileSync(f.path), stat = lstatSync(f.path);
    mutateBudgetLedger((tx) => { updateBudgetTransaction(tx, () => undefined); return { saved: true }; }, f.path, later);
    expect(readFileSync(f.path)).toEqual(bytes); expect(lstatSync(f.path).mtimeMs).toBe(stat.mtimeMs); expect(readBudgetLedger(f.path)!.revision).toBe(1);
  });
  it("provides frozen detached snapshots and never retains a callback's mutable draft", () => {
    const f = fixture(); let saved: BudgetTransaction | undefined, exposed: BudgetLedger | undefined;
    mutateBudgetLedger((tx) => { saved = tx; expect(Object.keys(tx)).toEqual([]); expect(Object.isFrozen(tx)).toBe(true); updateBudgetTransaction(tx, (draft, time) => { seed(draft, time); exposed = draft; });
      const snapshot = readBudgetTransaction(tx); expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.ledger.reservations["R-1"]!.held)).toBe(true); expect(snapshot.at).toBe(at);
      exposed!.reservations["R-1"]!.held.total_tokens = 0; expect(readBudgetTransaction(tx).ledger.reservations["R-1"]!.held.total_tokens).toBe(100);
    }, f.path, at);
    expect(readBudgetLedger(f.path)!.reservations["R-1"]!.held.total_tokens).toBe(100); expect(() => readBudgetTransaction(saved)).toThrow(/stale/); expect(() => updateBudgetTransaction(saved, seed)).toThrow(/stale/);
  });
  it.each([null, undefined, {}, Object.freeze({}), "proof", 1])("rejects fabricated transaction proof %j before callbacks", (proof) => {
    const operation = vi.fn(seed); expect(() => readBudgetTransaction(proof)).toThrow(BudgetStateError); expect(() => updateBudgetTransaction(proof, operation)).toThrow(BudgetStateError); expect(operation).not.toHaveBeenCalled();
  });
  it("rejects copied/proxied proofs and nested mutations/updates", () => {
    const f = fixture(), hook = vi.fn(); mutateBudgetLedger((tx) => {
      expect(() => readBudgetTransaction({ ...tx })).toThrow(); expect(() => readBudgetTransaction(structuredClone(tx))).toThrow(); expect(() => readBudgetTransaction(new Proxy(tx, { getPrototypeOf: hook as never }))).toThrow(); expect(hook).not.toHaveBeenCalled();
      expect(() => mutateBudgetLedger(() => undefined, f.path, at)).toThrow(/reentrant/); expect(() => updateBudgetTransaction(tx, () => readBudgetTransaction(tx))).toThrow(/reentrant/);
      updateBudgetTransaction(tx, seed);
    }, f.path, at); expect(readBudgetLedger(f.path)!.revision).toBe(1);
  });
  it("rejects async and accessor/proxy thenables without invoking hooks or publishing drafts", () => {
    const f = fixture(); setup(f.path); const before = readFileSync(f.path), hook = vi.fn();
    expect(() => mutateBudgetLedger(async () => undefined, f.path, later)).toThrow(/synchronous/);
    expect(() => mutateBudgetLedger((tx) => updateBudgetTransaction(tx, async (draft, time) => seed(draft, time, "2")), f.path, later)).toThrow(/synchronous/);
    const thenable = Object.defineProperty({}, "then", { get: hook });
    for (const result of [thenable, { then: hook }, new Proxy({}, { ownKeys: hook as never }), Promise.resolve()]) {
      const owned = fixture(); setup(owned.path); const bytes = readFileSync(owned.path);
      expect(() => mutateBudgetLedger(() => result, owned.path, later)).toThrow(BudgetStateError);
      expect(readFileSync(owned.path)).toEqual(bytes); expect(existsSync(maintenanceGatePath(owned.state))).toBe(true);
    }
    expect(hook).not.toHaveBeenCalled(); expect(readFileSync(f.path)).toEqual(before);
  });
  it("rolls back thrown/invalid/accessor drafts while revoking escaped transaction proofs", () => {
    const f = fixture(); setup(f.path); const bytes = readFileSync(f.path), hook = vi.fn(); let escaped: BudgetTransaction | undefined;
    expect(() => mutateBudgetLedger((tx) => { escaped = tx; updateBudgetTransaction(tx, (draft, time) => seed(draft, time, "2")); throw new Error("synthetic failure"); }, f.path, later)).toThrow(/synthetic failure/);
    expect(() => mutate(f.path, (draft) => Object.defineProperty(draft, "subjects", { enumerable: true, get: hook }))).toThrow(); expect(hook).not.toHaveBeenCalled(); expect(() => readBudgetTransaction(escaped)).toThrow(); expect(readFileSync(f.path)).toEqual(bytes);
  });
  it.each(["{", "null", "[]", '{"schema_version":"1"}', '{"schema_version":0}', '{"schema_version":1}', '{"schema_version":2}', '{"schema_version":1,"private":"SYNTHETIC-PRIVATE"}'])("preserves invalid/future bytes without locks, repair or callback %s", (bytes) => {
    const f = fixture(); raw(f.path, bytes); const callback = vi.fn(); expect(() => readBudgetLedger(f.path)).toThrow(BudgetStateError); expect(() => mutateBudgetLedger(callback, f.path, at)).toThrow(BudgetStateError);
    expect(callback).not.toHaveBeenCalled(); expect(readFileSync(f.path, "utf8")).toBe(bytes); expect(existsSync(dirname(f.lock))).toBe(false);
  });
  it("reports unsupported version without echoing body or private paths", () => {
    const f = fixture(); raw(f.path, '{"schema_version":987,"private":"SYNTHETIC-PRIVATE"}');
    try { readBudgetLedger(f.path); throw new Error("must reject"); } catch (error) { expect(error).toBeInstanceOf(UnsupportedBudgetVersionError); expect((error as UnsupportedBudgetVersionError).version).toBe(987); expect((error as Error).message).not.toContain("SYNTHETIC-PRIVATE"); expect((error as Error).message).not.toContain(f.root); }
  });
  it("rejects oversized and invalid UTF8 bytes before effects", () => {
    const f = fixture(); raw(f.path, " "); truncateSync(f.path, BUDGET_LIMITS.documentBytes + 1); expect(() => mutateBudgetLedger(() => undefined, f.path, at)).toThrow(); expect(lstatSync(f.path).size).toBe(BUDGET_LIMITS.documentBytes + 1);
    raw(f.path, Buffer.from([0xff, 0xfe])); expect(() => readBudgetLedger(f.path)).toThrow(); expect(readFileSync(f.path)).toEqual(Buffer.from([0xff, 0xfe]));
  });
  it("rejects 10001-record mutation before replacement while preserving existing exact bytes", () => {
    const f = fixture(); setup(f.path); const bytes = readFileSync(f.path); vi.mocked(renameSync).mockClear();
    expect(() => mutate(f.path, (draft) => {
      const original = draft.subjects["S-1"]! as BudgetTaskSubject;
      for (let index = 0; index < BUDGET_LIMITS.records; index++) { const id = `extra-${index}`, task = `task-extra-${index}`; draft.subjects[id] = { ...structuredClone(original), id, task_id: task, attribution: { ...structuredClone(original.attribution), execution_id: task } }; }
    })).toThrow(/collection exceeds/);
    expect(vi.mocked(renameSync)).not.toHaveBeenCalled(); expect(readFileSync(f.path)).toEqual(bytes); expect(existsSync(f.lock)).toBe(false);
  });
  it.each(["state", "budgets", "file", "locks"])("rejects redirected %s paths without touching destination", (kind) => {
    const f = fixture(), target = join(f.root, "target"); mkdirSync(target); raw(join(target, "sentinel"), "untouched");
    if (kind === "state") symlinkSync(target, f.state, "junction"); else if (kind === "budgets") { mkdirSync(f.state); symlinkSync(target, dirname(f.path), "junction"); }
    else if (kind === "locks") { mkdirSync(f.state); symlinkSync(target, dirname(f.lock), "junction"); } else { mkdirSync(dirname(f.path), { recursive: true }); symlinkSync(target, f.path, "junction"); }
    expect(() => setup(f.path)).toThrow(BudgetStateError); expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("untouched"); expect(existsSync(join(target, "budgets.lock"))).toBe(false);
  });
  it("rejects hardlinks and directory snapshots without mutation", () => {
    const f = fixture(); raw(join(f.root, "original"), "{}"); mkdirSync(dirname(f.path), { recursive: true }); linkSync(join(f.root, "original"), f.path); expect(() => setup(f.path)).toThrow(); expect(readFileSync(join(f.root, "original"), "utf8")).toBe("{}");
    const other = fixture(); mkdirSync(other.path, { recursive: true }); expect(() => readBudgetLedger(other.path)).toThrow();
  });
  it.each([0, 60_000, 86_400_000])("never steals an existing lock at age %i", (age) => {
    const f = fixture(); raw(f.lock, "unknown owner"); const time = new Date(Date.now() - age); utimesSync(f.lock, time, time);
    expect(() => setup(f.path)).toThrow(StateLockConflictError); expect(readFileSync(f.lock, "utf8")).toBe("unknown owner"); expect(existsSync(f.path)).toBe(false);
  });
  it("preserves a replacement lock and old snapshot after live proof loses ownership", () => {
    const f = fixture(); setup(f.path); const before = readFileSync(f.path);
    expect(() => mutateBudgetLedger((tx) => { updateBudgetTransaction(tx, (draft, time) => seed(draft, time, "2")); raw(f.lock, "replacement owner"); expect(() => readBudgetTransaction(tx)).toThrow(/ownership/); }, f.path, later)).toThrow(/ownership/);
    expect(readFileSync(f.path)).toEqual(before); expect(readFileSync(f.lock, "utf8")).toBe("replacement owner");
  });
  it.each(["write", "flush", "rename"])("preserves old snapshot and cleans only its owned stage on %s failure", async (kind) => {
    const f = fixture(); setup(f.path); raw(`${f.path}.unknown.tmp`, "unowned"); const before = readFileSync(f.path), actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const stage = (file: string | undefined) => file?.startsWith(`${f.path}.`) && file.endsWith(".tmp") && !file.endsWith(".unknown.tmp");
    if (kind === "write") vi.mocked(writeFileSync).mockImplementation((file, data, options) => {
      if (typeof file === "number" && stage(openedPath(file))) throw new Error("SYNTHETIC-PRIVATE");
      actual.writeFileSync(file, data, options);
    });
    if (kind === "flush") vi.mocked(fsyncSync).mockImplementation((fd) => { if (stage(openedPath(fd))) throw new Error("SYNTHETIC-PRIVATE"); actual.fsyncSync(fd); });
    if (kind === "rename") vi.mocked(renameSync).mockImplementation((from, to) => { if (to === f.path) throw new Error("SYNTHETIC-PRIVATE"); actual.renameSync(from, to); });
    expect(() => mutate(f.path, (draft, time) => seed(draft, time, "2"))).toThrow(/replacement failed/); expect(readFileSync(f.path)).toEqual(before);
    expect(readdirSync(dirname(f.path)).sort()).toEqual(["budgets.json", "budgets.json.unknown.tmp"]); expect(existsSync(f.lock)).toBe(false);
  });
  it("cleans only an owned uninitialized lock when token writing fails", async () => {
    const f = fixture(), actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(writeFileSync).mockImplementation((file, data, options) => { if (typeof file === "number" && openedPath(file) === f.lock) throw new Error("SYNTHETIC-PRIVATE"); actual.writeFileSync(file, data, options); });
    expect(() => setup(f.path)).toThrow(/initialization failed/); expect(existsSync(f.lock)).toBe(false); expect(existsSync(f.path)).toBe(false);
  });
  it("reports lock release failure honestly after replacement without undoing committed state", async () => {
    const f = fixture(); setup(f.path); const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(unlinkSync).mockImplementation((file) => { if (file === f.lock) throw new Error("SYNTHETIC-PRIVATE"); actual.unlinkSync(file); });
    expect(() => mutate(f.path, (draft, time) => seed(draft, time, "2"))).toThrow(/lock release failed/);
    expect(readBudgetLedger(f.path)!.revision).toBe(2); expect(readBudgetLedger(f.path)!.subjects["S-2"]).toBeDefined(); expect(existsSync(f.lock)).toBe(true);
    expect(() => mutateBudgetLedger(() => undefined, f.path, later)).toThrow(StateLockConflictError);
  });
  it("never unlinks a different inode that replaced its lock", () => {
    const f = fixture(); setup(f.path); const before = readFileSync(f.path);
    expect(() => mutateBudgetLedger((tx) => { updateBudgetTransaction(tx, (draft, time) => seed(draft, time, "2")); renameSync(f.lock, `${f.lock}.old`); raw(f.lock, "other inode"); }, f.path, later)).toThrow(/ownership/);
    expect(readFileSync(f.path)).toEqual(before); expect(readFileSync(f.lock, "utf8")).toBe("other inode"); expect(existsSync(`${f.lock}.old`)).toBe(true);
  });
  it("sanitizes inaccessible reads without substituting absent state", () => {
    const f = fixture(); raw(f.path, "{}"); vi.mocked(openSync).mockImplementationOnce(() => { throw Object.assign(new Error(f.root), { code: "EACCES" }); });
    try { readBudgetLedger(f.path); throw new Error("must reject"); } catch (error) { expect(error).toBeInstanceOf(BudgetStateError); expect((error as Error).message).not.toContain(f.root); }
  });
  it.each(["map-delete", "subject-binding", "reservation-binding", "revision-reset", "clock-reset", "token-refund", "slot-release", "intent-rebind", "charge-decrease", "terminal-reopen"])("rejects monotonic mutation %s while retaining exact bytes", (kind) => {
    const f = fixture(); setup(f.path, true); if (kind === "terminal-reopen") mutate(f.path, terminal);
    if (kind === "charge-decrease") mutate(f.path, (draft, time) => { draft.charges["C-1"]!.runtime_ms = 2; draft.charges["C-1"]!.updated_at = time; }); const bytes = readFileSync(f.path);
    expect(() => mutate(f.path, (draft, time) => {
      const reserve = draft.reservations["R-1"]!, charge = draft.charges["C-1"]!;
      if (kind === "map-delete") delete draft.subjects["S-1"];
      if (kind === "subject-binding") { draft.subjects["S-1"]!.attribution.objective_ids = ["OTHER"]; }
      if (kind === "reservation-binding") reserve.policy_bindings[0]!.policy_revision++;
      if (kind === "revision-reset") draft.revision++;
      if (kind === "clock-reset") draft.updated_at = "2026-10-05T12:00:00Z";
      if (kind === "token-refund") { reserve.held.total_tokens++; reserve.revision++; reserve.updated_at = time; }
      if (kind === "slot-release") { reserve.held.concurrent_reads = 0; reserve.revision++; reserve.updated_at = time; }
      if (kind === "intent-rebind") { draft.admission_intents["I-1"]!.admission_id = "OTHER"; draft.admission_intents["I-1"]!.updated_at = time; }
      if (kind === "charge-decrease") { charge.runtime_ms = 1; charge.updated_at = time; }
      if (kind === "terminal-reopen") { charge.status = "running"; charge.updated_at = time; }
    })).toThrow(); expect(readFileSync(f.path)).toEqual(bytes);
  });
  it("retains unknown holds/uncertainty permanently while permitting increasing proven high-water", () => {
    const f = fixture(); setup(f.path, true); mutate(f.path, (draft, time) => { const reserve = draft.reservations["R-1"]!, charge = draft.charges["C-1"]!; reserve.status = "unknown"; reserve.uncertain_dimensions = ["runtime_ms", "total_tokens", "concurrent_reads"]; reserve.revision++; reserve.updated_at = time; charge.status = "terminal"; charge.runtime_state = "unknown"; charge.usage_state = "unknown"; charge.updated_at = time; });
    const bytes = readFileSync(f.path); expect(() => mutate(f.path, (draft, time) => { draft.reservations["R-1"]!.held.runtime_ms--; draft.reservations["R-1"]!.revision++; draft.reservations["R-1"]!.updated_at = time; })).toThrow(); expect(readFileSync(f.path)).toEqual(bytes);
    mutate(f.path, (draft, time) => { draft.charges["C-1"]!.runtime_ms = 200; draft.charges["C-1"]!.observed_total_tokens = 20; draft.charges["C-1"]!.updated_at = time; });
    const result = readBudgetLedger(f.path)!; expect(result.charges["C-1"]!.usage_state).toBe("unknown"); expect(result.reservations["R-1"]!.held.total_tokens).toBe(100);
    expect(() => mutate(f.path, (draft, time) => { draft.charges["C-1"]!.usage_state = "complete"; draft.charges["C-1"]!.updated_at = time; })).toThrow(/unknown/);
  });
  it.each(["no-prospective-attempt", "fabricated-runtime", "fabricated-tokens", "terminal-at-claim", "multiple-runs", "slot-switch"])("rejects new claim bypass %s before writing", (kind) => {
    const f = fixture(); setup(f.path, kind === "no-prospective-attempt"); if (kind === "no-prospective-attempt") mutate(f.path, terminal); const bytes = readFileSync(f.path);
    expect(() => mutate(f.path, (draft, time) => {
      if (kind === "no-prospective-attempt") { const previous = draft.charges["C-1"]!; draft.charges["C-2"] = { ...previous, id: "C-2", run_id: "run-2", runtime_ms: 0, observed_total_tokens: 0, status: "running", created_at: time, updated_at: time }; const reserve = draft.reservations["R-1"]!; reserve.status = "active"; reserve.run_ids.push("run-2"); reserve.revision++; reserve.updated_at = time; }
      else {
        claim(draft, time);
        if (kind === "fabricated-runtime") draft.charges["C-1"]!.runtime_ms = 10;
        if (kind === "fabricated-tokens") draft.charges["C-1"]!.observed_total_tokens = 10;
        if (kind === "terminal-at-claim") draft.charges["C-1"]!.status = "terminal";
        if (kind === "multiple-runs") { draft.charges["C-2"] = { ...draft.charges["C-1"]!, id: "C-2", run_id: "run-2" }; draft.reservations["R-1"]!.run_ids.push("run-2"); }
        if (kind === "slot-switch") { draft.reservations["R-1"]!.held.concurrent_reads = 0; draft.reservations["R-1"]!.held.concurrent_writes = 1; }
      }
    })).toThrow(); expect(readFileSync(f.path)).toEqual(bytes);
  });
  it.each(["zero-runtime", "zero-task-tokens", "unexpected-review", "missing-review", "unexpected-correction", "missing-correction"])("rejects prospective claim dimension/label bypass %s", (kind) => {
    const f = fixture();
    if (kind === "zero-runtime" || kind === "zero-task-tokens") {
      setup(f.path, true); mutate(f.path, terminal); const draft = structuredClone(readBudgetLedger(f.path)!); const reserve = draft.reservations["R-1"]!;
      reserve.status = "committed"; reserve.held.attempts = 1; reserve.held.runtime_ms = kind === "zero-runtime" ? 0 : 1000; if (kind === "zero-task-tokens") reserve.held.total_tokens = 0;
      assertBudgetLedger(draft); raw(f.path, JSON.stringify(draft));
    } else mutateBudgetLedger((tx) => updateBudgetTransaction(tx, (draft, time) => {
      seed(draft, time); const held = draft.reservations["R-1"]!.held;
      if (kind === "missing-review") { held.review_attempts = 1; held.review_runtime_ms = 1000; held.review_total_tokens = 100; }
      if (kind === "missing-correction") held.corrections = 1;
    }), f.path, at);
    const bytes = readFileSync(f.path);
    expect(() => mutate(f.path, (draft, time) => {
      if (kind === "zero-runtime" || kind === "zero-task-tokens") {
        draft.charges["C-2"] = { ...draft.charges["C-1"]!, id: "C-2", run_id: "run-2", runtime_ms: 0, observed_total_tokens: 0, status: "running", created_at: time, updated_at: time };
        const reserve = draft.reservations["R-1"]!; reserve.run_ids.push("run-2"); reserve.status = "active"; reserve.held.attempts = 0; reserve.revision++; reserve.updated_at = time;
      } else {
        claim(draft, time); const reserve = draft.reservations["R-1"]!;
        if (kind === "unexpected-review") draft.charges["C-1"]!.review = true;
        if (kind === "missing-review") reserve.held.review_attempts = 0;
        if (kind === "unexpected-correction") draft.charges["C-1"]!.correction = true;
        if (kind === "missing-correction") reserve.held.corrections = 0;
      }
    })).toThrow(/Budget claim/); expect(readFileSync(f.path)).toEqual(bytes);
  });
  it("allows known terminal runtime release, retry top-up without token recharge, and complete settlement", () => {
    const f = fixture(); setup(f.path, true); mutate(f.path, terminal); mutate(f.path, (draft, time) => { const reserve = draft.reservations["R-1"]!; reserve.status = "committed"; reserve.held.attempts = 1; reserve.held.runtime_ms = 1000; reserve.revision++; reserve.updated_at = time; });
    expect(readBudgetLedger(f.path)!.reservations["R-1"]!.held.total_tokens).toBe(90);
    mutate(f.path, (draft, time) => { const reserve = draft.reservations["R-1"]!; reserve.held = amounts(); reserve.status = "settled"; reserve.revision++; reserve.updated_at = time; }); expect(readBudgetLedger(f.path)!.reservations["R-1"]!.status).toBe("settled");
    expect(() => mutate(f.path, (draft, time) => { const reserve = draft.reservations["R-1"]!; reserve.status = "committed"; reserve.held = amounts({ attempts: 1, runtime_ms: 100, total_tokens: 20, concurrent_reads: 1 }); reserve.revision++; reserve.updated_at = time; })).toThrow(/reopen/);
  });
  it.each(["prepared", "running"])("rejects old terminal high-water debiting the %s retry runtime slice", (state) => {
    const f = fixture(); setup(f.path, true); mutate(f.path, terminal);
    mutate(f.path, (draft, time) => { const reserve = draft.reservations["R-1"]!; reserve.status = "committed"; reserve.held.attempts = 1; reserve.held.runtime_ms = 1000; reserve.revision++; reserve.updated_at = time; });
    if (state === "running") mutate(f.path, (draft, time) => {
      const reserve = draft.reservations["R-1"]!; reserve.status = "active"; reserve.held.attempts = 0; reserve.run_ids.push("run-2"); reserve.revision++; reserve.updated_at = time;
      draft.charges["C-2"] = { ...draft.charges["C-1"]!, id: "C-2", run_id: "run-2", runtime_ms: 0, observed_total_tokens: 0, status: "running", created_at: time, updated_at: time };
    });
    const bytes = readFileSync(f.path);
    expect(() => mutate(f.path, (draft, time) => { draft.charges["C-1"]!.runtime_ms = 200; draft.charges["C-1"]!.updated_at = time; const reserve = draft.reservations["R-1"]!; reserve.held.runtime_ms = 900; reserve.revision++; reserve.updated_at = time; })).toThrow(/proven canonical debit/);
    expect(readFileSync(f.path)).toEqual(bytes);
    mutate(f.path, (draft, time) => { draft.charges["C-1"]!.runtime_ms = 200; draft.charges["C-1"]!.observed_total_tokens = 20; draft.charges["C-1"]!.updated_at = time; const reserve = draft.reservations["R-1"]!; reserve.held.total_tokens = 80; reserve.revision++; reserve.updated_at = time; });
    expect(readBudgetLedger(f.path)!.reservations["R-1"]!.held.runtime_ms).toBe(1000); expect(readBudgetLedger(f.path)!.reservations["R-1"]!.held.total_tokens).toBe(80);
  });
  it("rejects clock regression and exhausted aggregate revisions without changing bytes", () => {
    const f = fixture(); setup(f.path); const bytes = readFileSync(f.path); expect(() => mutateBudgetLedger(() => undefined, f.path, "2026-10-05T12:00:00Z")).toThrow(/clock/); expect(readFileSync(f.path)).toEqual(bytes);
    const ledger = structuredClone(readBudgetLedger(f.path)!); ledger.revision = Number.MAX_SAFE_INTEGER; raw(f.path, JSON.stringify(ledger)); const high = readFileSync(f.path); expect(() => mutate(f.path, (draft, time) => seed(draft, time, "2"))).toThrow(/revision/); expect(readFileSync(f.path)).toEqual(high);
  });
  it("retains settled state while recording larger late known terminal high-water exactly once", () => {
    const f = fixture(); setup(f.path, true); mutate(f.path, terminal); mutate(f.path, (draft, time) => { const reserve = draft.reservations["R-1"]!; reserve.status = "settled"; reserve.held = amounts(); reserve.revision++; reserve.updated_at = time; });
    const reservation = structuredClone(readBudgetLedger(f.path)!.reservations["R-1"]!);
    mutate(f.path, (draft, time) => { draft.charges["C-1"]!.runtime_ms = 200; draft.charges["C-1"]!.observed_total_tokens = 20; draft.charges["C-1"]!.updated_at = time; });
    expect(readBudgetLedger(f.path)!.reservations["R-1"]).toEqual(reservation); expect(readBudgetLedger(f.path)!.charges["C-1"]!.observed_total_tokens).toBe(20);
    const bytes = readFileSync(f.path); mutate(f.path, () => undefined); expect(readFileSync(f.path)).toEqual(bytes);
  });
  it("serializes real child-process transactions and exposes the last committed snapshot after restart", async () => {
    const f = fixture(); setup(f.path, true);
    const holder = child(`import { mutateBudgetLedger,updateBudgetTransaction } from ${JSON.stringify(moduleUrl)}; import {readSync} from 'node:fs'; mutateBudgetLedger(tx=>{process.stdout.write('LOCKED\\n');readSync(0,Buffer.alloc(1),0,1,null);updateBudgetTransaction(tx,(d,at)=>{d.charges['C-1'].runtime_ms=1;d.charges['C-1'].updated_at=at;});},process.argv[1],${JSON.stringify(later)});`, f.path);
    await new Promise<void>((ready, reject) => { let output = ""; holder.proc.stdout!.on("data", (data) => { output += String(data); if (output.includes("LOCKED")) ready(); }); holder.proc.on("error", reject); holder.proc.on("close", (code) => reject(new Error(`holder exited before locking: ${code}`))); });
    const gateBytes = readFileSync(maintenanceGatePath(f.state));
    expect(() => acquireMaintenanceExclusive(f.state)).toThrow(StateLockConflictError);
    expect(readFileSync(maintenanceGatePath(f.state))).toEqual(gateBytes);
    const contender = child(`import {mutateBudgetLedger} from ${JSON.stringify(moduleUrl)};try{mutateBudgetLedger(()=>{throw new Error('must not run')},process.argv[1],${JSON.stringify(later)});process.exitCode=2;}catch(e){if(e.constructor.name!=='StateLockConflictError')throw e;process.stdout.write('CONFLICT');}`, f.path);
    expect(await contender.done).toEqual({ code: 0, out: "CONFLICT", err: "" }); holder.proc.stdin!.end("x"); expect((await holder.done).code).toBe(0); expect(existsSync(f.lock)).toBe(false);
    const restarted = child(`import {readBudgetLedger,mutateBudgetLedger,updateBudgetTransaction} from ${JSON.stringify(moduleUrl)};if(readBudgetLedger(process.argv[1]).charges['C-1'].runtime_ms!==1)throw new Error('lost snapshot');mutateBudgetLedger(tx=>updateBudgetTransaction(tx,(d,at)=>{d.charges['C-1'].runtime_ms=2;d.charges['C-1'].updated_at=at;}),process.argv[1],${JSON.stringify(later)});`, f.path);
    expect(await restarted.done).toEqual({ code: 0, out: "", err: "" }); expect(readBudgetLedger(f.path)!.charges["C-1"]!.runtime_ms).toBe(2); assertBudgetLedger(readBudgetLedger(f.path));
  }, 10_000);
});

describe("T015 budget cooperative maintenance fencing", () => {
  it.each(["promise", "thenable", "getter", "inherited-then", "proxy"].flatMap((kind) => ["outer", "update"].map((phase) => [kind, phase])))
    ("retains unknown ownership after a normal callback returns %s from %s without getter/proxy effects", (kind, phase) => {
      const f = fixture(); setup(f.path); const before = readFileSync(f.path), hook = vi.fn(); let escaped: BudgetTransaction | undefined;
      const result = kind === "promise" ? Promise.resolve() : kind === "thenable" ? { then: hook }
        : kind === "getter" ? Object.defineProperty({}, "then", { get: hook })
          : kind === "inherited-then" ? Object.create(Object.defineProperty({}, "then", { get: hook }))
            : new Proxy({}, { get: hook, ownKeys: hook as never, getPrototypeOf: hook as never });
      expect(() => mutateBudgetLedger((tx) => {
        escaped = tx;
        if (phase === "update") return updateBudgetTransaction(tx, (draft, time) => { seed(draft, time, "2"); return result; });
        updateBudgetTransaction(tx, (draft, time) => seed(draft, time, "2")); return result;
      }, f.path, later)).toThrow(BudgetStateError);
      expect(hook).not.toHaveBeenCalled(); expect(readFileSync(f.path)).toEqual(before); expect(existsSync(f.lock)).toBe(false);
      const marker = readFileSync(maintenanceGatePath(f.state)), callback = vi.fn();
      expect(() => mutateBudgetLedger(callback, f.path, later)).toThrow(StateLockConflictError);
      expect(() => acquireMaintenanceExclusive(f.state)).toThrow(StateLockConflictError);
      expect(() => updateBudgetTransaction(escaped, callback)).toThrow(BudgetStateError); expect(callback).not.toHaveBeenCalled();
      expect(readFileSync(f.path)).toEqual(before); expect(readFileSync(maintenanceGatePath(f.state))).toEqual(marker);
    });
  it("refuses a durable hold before creating a missing budget directory or running a callback", () => {
    const f = fixture(); hold(f.state); const control = readFileSync(maintenanceControlPath(f.state));
    const callback = vi.fn((tx: BudgetTransaction) => updateBudgetTransaction(tx, seed));
    expect(() => mutateBudgetLedger(callback, f.path, at)).toThrow(MaintenanceStateError);
    expect(callback).not.toHaveBeenCalled(); expect(existsSync(dirname(f.path))).toBe(false);
    expect(existsSync(dirname(f.lock))).toBe(false); expect(readBudgetLedger(f.path)).toBeNull();
    expect(readFileSync(maintenanceControlPath(f.state))).toEqual(control);
  });
  it("retains unknown accounting, exact holds and proven high-water without accepting a held settlement", () => {
    const f = fixture(); setup(f.path, true);
    mutate(f.path, (draft, time) => {
      const reserve = draft.reservations["R-1"]!, charge = draft.charges["C-1"]!;
      reserve.status = "unknown"; reserve.uncertain_dimensions = ["runtime_ms", "total_tokens", "concurrent_reads"];
      reserve.revision++; reserve.updated_at = time; charge.status = "terminal"; charge.runtime_state = charge.usage_state = "unknown";
      charge.runtime_ms = 27; charge.observed_total_tokens = 12; charge.updated_at = time;
    });
    const before = readFileSync(f.path), stamp = lstatSync(f.path).mtimeMs; hold(f.state);
    const callback = vi.fn((tx: BudgetTransaction) => updateBudgetTransaction(tx, (draft) => { draft.reservations["R-1"]!.held = amounts(); }));
    expect(() => mutateBudgetLedger(callback, f.path, later)).toThrow(MaintenanceStateError);
    expect(callback).not.toHaveBeenCalled(); expect(readFileSync(f.path)).toEqual(before); expect(lstatSync(f.path).mtimeMs).toBe(stamp);
    const snapshot = readBudgetLedger(f.path)!;
    expect(snapshot.reservations["R-1"]!.held).toEqual(amounts({ runtime_ms: 1000, total_tokens: 100, concurrent_reads: 1 }));
    expect(snapshot.charges["C-1"]!.observed_total_tokens).toBe(12); expect(snapshot.charges["C-1"]!.usage_state).toBe("unknown");
  });
  it("blocks private exclusive ownership without treating inspected budget bytes as authority", () => {
    const f = fixture(); setup(f.path); const before = readFileSync(f.path), ownership = acquireMaintenanceExclusive(f.state), callback = vi.fn();
    try {
      expect(() => mutateBudgetLedger(callback, f.path, later)).toThrow(StateLockConflictError);
      expect(callback).not.toHaveBeenCalled(); expect(readFileSync(f.path)).toEqual(before);
      expect(readBudgetLedger(f.path)!.revision).toBe(1);
    } finally { releaseMaintenanceExclusive(ownership); }
    mutate(f.path, (draft, time) => seed(draft, time, "2")); expect(readBudgetLedger(f.path)!.revision).toBe(2);
  });
  it.each(["{", "null", '{"schema_version":2}', '{"schema_version":1}'])
    ("preserves malformed or unsupported maintenance control before callback and store effects %s", (bytes) => {
      const f = fixture(); raw(maintenanceControlPath(f.state), bytes); const callback = vi.fn();
      expect(() => mutateBudgetLedger(callback, f.path, at)).toThrow(MaintenanceStateError);
      expect(callback).not.toHaveBeenCalled(); expect(readFileSync(maintenanceControlPath(f.state), "utf8")).toBe(bytes);
      expect(existsSync(f.path)).toBe(false); expect(existsSync(dirname(f.lock))).toBe(false);
    });
  it("rejects a late transaction when its root gate is replaced and preserves both old payload and the unknown owner", () => {
    const f = fixture(); setup(f.path); const before = readFileSync(f.path), callback = vi.fn(seed); let escaped: BudgetTransaction | undefined;
    expect(() => mutateBudgetLedger((tx) => {
      escaped = tx; updateBudgetTransaction(tx, (draft, time) => seed(draft, time, "2"));
      raw(maintenanceGatePath(f.state), "unknown replacement");
      expect(() => updateBudgetTransaction(tx, callback)).toThrow(); expect(callback).not.toHaveBeenCalled();
    }, f.path, later)).toThrow();
    expect(readFileSync(f.path)).toEqual(before); expect(readFileSync(maintenanceGatePath(f.state), "utf8")).toBe("unknown replacement");
    expect(() => updateBudgetTransaction(escaped, callback)).toThrow(BudgetStateError); expect(callback).not.toHaveBeenCalled();
    expect(readdirSync(dirname(f.path))).toEqual(["budgets.json"]);
  });
  it("uses a custom file's dedicated parent root rather than a shared temporary maintenance or store lock", () => {
    const f = fixture(), path = join(f.root, "custom-ledger.json"), callback = vi.fn();
    mutateBudgetLedger((tx) => updateBudgetTransaction(tx, seed), path, at);
    expect(readBudgetLedger(path)!.revision).toBe(1); expect(existsSync(join(f.root, "locks", "budgets.lock"))).toBe(false);
    hold(f.root); const before = readFileSync(path);
    expect(() => mutateBudgetLedger(callback, path, later)).toThrow(MaintenanceStateError);
    expect(callback).not.toHaveBeenCalled(); expect(readFileSync(path)).toEqual(before);
  });
});
