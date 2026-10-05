import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mutateBudgetLedger, readBudgetLedger, readBudgetTransaction } from "../state/budgets";
import type { BudgetTransaction } from "../state/budgets";
import { budgetStatePath } from "../state/paths";
import { systemProcessEnvironment } from "../security/environment";
import { resolveBudgetPolicy } from "./policy";
import type { BudgetCorrectionLineage, BudgetPolicySource, ExistingBudgetConstraint } from "./policy";
import { budgetOccurrenceIntentId, budgetTaskIntentId, claimOccurrenceBudget, claimTaskBudget, commitOccurrenceBudget, commitTaskBudget, markBudgetUnknown, observeBudgetRun, reserveOccurrenceBudget, reserveTaskBudget, settleBudgetReservation, topUpTaskBudget } from "./reservations";
import { BUDGET_DIMENSIONS } from "./types";
import type { BudgetAdmission, BudgetAmounts, BudgetAttribution, BudgetLedger, BudgetLimits, BudgetOccurrenceSubject, BudgetPeriod, BudgetPolicyRule } from "./types";
import { assertBudgetLedger, BudgetContractError } from "./validation";

// Synthetic accounting only. Valid data/transactions never substitute for a live
// task lease/controller, human approval, policy or runtime effect gate.
const at = "2026-10-05T12:00:00Z", later = "2026-10-05T12:01:00Z", digest = "a".repeat(64);
const amounts = (overrides: Partial<BudgetAmounts> = {}): BudgetAmounts => ({ attempts: 0, runtime_ms: 0, total_tokens: 0, concurrent_reads: 0, concurrent_writes: 0, review_attempts: 0, review_runtime_ms: 0, review_total_tokens: 0, corrections: 0, ...overrides });
const limits = (caps: Partial<BudgetAmounts> = {}): BudgetLimits => Object.fromEntries(BUDGET_DIMENSIONS.map((key) => [key, caps[key] === undefined ? { status: "unconfigured" } : { status: "configured", hard_cap: caps[key] }])) as BudgetLimits;
function source(caps: Partial<BudgetAmounts> = {}, period: BudgetPeriod = "none", extra: BudgetPolicyRule[] = []): BudgetPolicySource {
  return { fingerprint: digest, policy: { schema_version: 1, revision: 1, pricing: { status: "unavailable", reason: "no-versioned-source" }, rules: [{ id: "company-policy", revision: 1, scope: { kind: "company", id: "surtec" }, period, warning_percent: 80, limits: limits(caps) }, ...extra] } };
}
type Task = Parameters<typeof reserveTaskBudget>[1];
function task(options: { id?: string; source?: BudgetPolicySource; caps?: BudgetAmounts; constraints?: ExistingBudgetConstraint[]; review?: boolean; correction?: boolean; created_at?: string } = {}): Task {
  const id = options.id ?? "1", governed = options.review || options.correction, role = options.review ? "reviewer" : options.correction ? "software-engineer" : "portfolio-analyst", created = options.created_at ?? at;
  const caps = options.caps ?? amounts({ attempts: 2, runtime_ms: 1000, total_tokens: 100, concurrent_reads: options.correction ? 0 : 1, concurrent_writes: options.correction ? 1 : 0, review_attempts: options.review ? 2 : 0, review_runtime_ms: options.review ? 1000 : 0, review_total_tokens: options.review ? 100 : 0, corrections: options.correction ? 1 : 0 });
  const attribution: BudgetAttribution = { company_id: "surtec", objective_ids: ["objective-1"], project_ids: ["project-1"], issue_id: governed ? "issue-1" : null, role_id: role, execution_id: `task-${id}` };
  const ownedSource = options.source ?? source(), constraints = options.constraints, projection = resolveBudgetPolicy({ source: ownedSource, attribution, at: created, base_caps: caps, ...(constraints ? { constraints } : {}) });
  const admission: BudgetAdmission = { schema_version: 1, id: `admission-${id}`, subject_id: `subject-${id}`, task_id: `task-${id}`, project_id: "project-1", role_id: role, agent_id: "synthetic-agent", issue_id: attribution.issue_id, scope_revision: governed ? 1 : null, scope_fingerprint: governed ? digest : null, context_admission_version: governed ? 2 : 1, workflow: governed ? { workflow_id: `workflow-${id}`, stage_id: "stage-1", stage_generation: 1, grant_id: `grant-${id}` } : null, attribution, execution_mode: options.correction ? "write" : "read", manifest_fingerprint: digest, admitted_cap_fingerprint: projection.cap_fingerprint, reservation_id: `reservation-${id}`, intent_id: "intent-placeholder", created_at: created, policy_bindings: structuredClone(projection.policy_bindings), caps };
  admission.intent_id = budgetTaskIntentId(admission); return { admission, source: ownedSource, ...(constraints ? { constraints } : {}) };
}
const bound = (value: Task) => ({ ...value, persisted_admission: structuredClone(value.admission) });
const persisted = (value: Task) => ({ admission: value.admission, persisted_admission: structuredClone(value.admission) });
let root: string, path: string;
const children = new Set<ChildProcess>();
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "surtec-budget-reservations-test-")); path = budgetStatePath(root); });
afterEach(async () => {
  await Promise.all([...children].map((process) => new Promise<void>((done) => { process.once("close", () => done()); process.kill(); }))); children.clear();
  expect(dirname(resolve(root))).toBe(resolve(tmpdir())); expect(root.startsWith(join(tmpdir(), "surtec-budget-reservations-test-"))).toBe(true); expect(lstatSync(root).isSymbolicLink()).toBe(false);
  try { if (existsSync(join(root, "locks"))) expect(readdirSync(join(root, "locks"))).toEqual([]); }
  finally { rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false); vi.restoreAllMocks(); }
});
const tx = <T>(action: (transaction: BudgetTransaction) => T, stamp = at): T => mutateBudgetLedger(action, path, stamp);
const snapshot = (): BudgetLedger => { const result = readBudgetLedger(path)!; expect(result).not.toBeNull(); assertBudgetLedger(result); return result; };
const reservation = (value: Task) => snapshot().reservations[value.admission.reservation_id]!;
const charge = (run = "run-1") => Object.values(snapshot().charges).find((item) => item.run_id === run)!;
const bytes = (): Buffer | null => existsSync(path) ? readFileSync(path) : null;
function rejectPreserved(action: () => unknown): void { const before = bytes(); expect(action).toThrow(); if (before === null) expect(existsSync(path)).toBe(false); else expect(readFileSync(path).equals(before)).toBe(true); }
function reserveCommit(value: Task): void { tx((owner) => reserveTaskBudget(owner, value), value.admission.created_at); tx((owner) => commitTaskBudget(owner, persisted(value)), value.admission.created_at); }
function start(value = task(), run = "run-1"): Task { reserveCommit(value); tx((owner) => claimTaskBudget(owner, { ...bound(value), run_id: run }), value.admission.created_at); return value; }
const observe = (runtime: unknown, tokens: unknown, terminal = false, value = task(), run = "run-1", stamp = later) => tx((owner) => observeBudgetRun(owner, { reservation_id: value.admission.reservation_id, run_id: run, runtime_ms: runtime, total_tokens: tokens, terminal }), stamp);
const frozenTree = (value: unknown): boolean => value === null || typeof value !== "object" || Object.isFrozen(value) && Object.values(value).every(frozenTree);
const lineage = (ids = ["workflow-1"]): BudgetCorrectionLineage => ({ id: "lineage-1", project_id: "project-1", issue_id: "issue-1", workflow_ids: ids });
function child(program: string) {
  const processHandle = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program, path], { cwd: process.cwd(), env: systemProcessEnvironment(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); children.add(processHandle);
  let out = "", err = ""; processHandle.stdout!.on("data", (chunk) => { out += String(chunk); }); processHandle.stderr!.on("data", (chunk) => { err += String(chunk); });
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolveDone, reject) => { processHandle.once("error", reject); processHandle.once("close", (code) => { children.delete(processHandle); resolveDone({ code, out, err }); }); });
  const waitFor = (marker: string): Promise<void> => {
    if (out.includes(marker)) return Promise.resolve();
    return new Promise((resolveReady, reject) => {
      const cleanup = () => { processHandle.stdout!.off("data", onData); processHandle.off("close", onClose); processHandle.off("error", onError); };
      const onData = () => { if (out.includes(marker)) { cleanup(); resolveReady(); } };
      const onClose = () => { cleanup(); reject(new Error("Child exited before readiness marker")); }, onError = (error: Error) => { cleanup(); reject(error); };
      processHandle.stdout!.on("data", onData); processHandle.once("close", onClose); processHandle.once("error", onError);
    });
  };
  return { process: processHandle, done, waitFor };
}

describe("T003 immutable intents and all-or-nothing task admission", () => {
  it("hashes the full schema-validated immutable admission, excluding only intent_id", () => {
    const value = task().admission, before = JSON.stringify(value), id = budgetTaskIntentId(value); expect(id).toMatch(/^intent-[a-f0-9]{64}$/); expect(JSON.stringify(value)).toBe(before);
    expect(budgetTaskIntentId({ ...value, intent_id: "other-placeholder" })).toBe(id); expect(budgetTaskIntentId({ ...value, manifest_fingerprint: "b".repeat(64) })).not.toBe(id);
    expect(budgetTaskIntentId({ ...value, caps: { ...value.caps, total_tokens: 99 } })).not.toBe(id);
    expect(budgetTaskIntentId(Object.fromEntries(Object.entries(value).reverse()) as unknown as BudgetAdmission)).toBe(id);
  });
  it.each([null, {}, { schema_version: 2 }, { ...task().admission, caps: null }])("rejects malformed/future intent payload %j", (admission) => { expect(() => budgetTaskIntentId(admission as BudgetAdmission)).toThrow(BudgetContractError); });
  it("reserves one prospective attempt/runtime/slot and cumulative tokens, not all attempts", () => {
    const value = task(), before = JSON.stringify(value); const result = tx((owner) => reserveTaskBudget(owner, value));
    expect(result.status).toBe("pending"); expect(result.held).toEqual(amounts({ attempts: 1, runtime_ms: 1000, total_tokens: 100, concurrent_reads: 1 })); expect(result.run_ids).toEqual([]); expect(frozenTree(result)).toBe(true); expect(JSON.stringify(value)).toBe(before);
    const state = snapshot(); expect(state.admission_intents[value.admission.intent_id]).toMatchObject({ status: "pending", admission_id: null }); expect(Object.values(state.subjects)).toHaveLength(1);
    const beforeRepeat = bytes()!; tx((owner) => reserveTaskBudget(owner, value)); expect(bytes()!.equals(beforeRepeat)).toBe(true);
  });
  it("commits only an exact validated persisted admission and preserves immutable data on repeats", () => {
    const value = task(); tx((owner) => reserveTaskBudget(owner, value)); const result = tx((owner) => commitTaskBudget(owner, persisted(value)), later);
    expect(result.status).toBe("committed"); expect(snapshot().admission_intents[value.admission.intent_id]).toMatchObject({ admission_id: value.admission.id, status: "committed" });
    const before = bytes()!; tx((owner) => commitTaskBudget(owner, persisted(value)), later); expect(bytes()!.equals(before)).toBe(true);
  });
  it.each(["missing", "null", "future", "changed-caps", "changed-agent", "changed-manifest"])("refuses commit with %s persisted binding without partial changes", (kind) => {
    const value = task(); tx((owner) => reserveTaskBudget(owner, value)); let persisted: unknown = structuredClone(value.admission);
    if (kind === "missing") persisted = undefined; if (kind === "null") persisted = null;
    if (kind === "future") persisted = { ...value.admission, schema_version: 2 };
    if (kind === "changed-caps") persisted = { ...value.admission, caps: { ...value.admission.caps, total_tokens: 99 } };
    if (kind === "changed-agent") persisted = { ...value.admission, agent_id: "other-agent" };
    if (kind === "changed-manifest") persisted = { ...value.admission, manifest_fingerprint: "b".repeat(64) };
    rejectPreserved(() => tx((owner) => commitTaskBudget(owner, { admission: value.admission, persisted_admission: persisted })));
  });
  it("contests the last company unit using two already-issued callers with no partial reservation", async () => {
    const current = source({ attempts: 1 }), caps = amounts({ attempts: 1, runtime_ms: 1000, total_tokens: 100, concurrent_reads: 1 }), first = task({ source: current, caps }), second = task({ source: current, caps, id: "2" });
    const outcomes = await Promise.allSettled([first, second].map((value) => Promise.resolve().then(() => tx((owner) => reserveTaskBudget(owner, value)))));
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1); expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1); const state = snapshot(); expect(Object.keys(state.subjects)).toHaveLength(1); expect(Object.keys(state.reservations)).toHaveLength(1); expect(Object.keys(state.admission_intents)).toHaveLength(1);
  });
  it("serializes the last unit across real child processes and rechecks the committed reservation after restart", async () => {
    const current = source({ attempts: 1 }), caps = amounts({ attempts: 1, runtime_ms: 1000, total_tokens: 100, concurrent_reads: 1 }), first = task({ source: current, caps }), second = task({ source: current, caps, id: "2" });
    const imports = `import {mutateBudgetLedger} from ${JSON.stringify(pathToFileURL(resolve("lib/state/budgets.ts")).href)};import {reserveTaskBudget} from ${JSON.stringify(pathToFileURL(resolve("lib/budgets/reservations.ts")).href)};`;
    const holder = child(`${imports}import {readSync} from 'node:fs';mutateBudgetLedger(owner=>{reserveTaskBudget(owner,${JSON.stringify(first)});process.stdout.write('READY\\n');readSync(0,Buffer.alloc(1),0,1,null);},process.argv[1],${JSON.stringify(at)});process.stdout.write('COMMITTED');`);
    try {
      await Promise.race([holder.waitFor("READY\n"), holder.done.then((result) => { throw new Error(`Holder exited before private ownership: ${result.code}`); })]);
      const contenderProgram = `${imports}let callbacks=0,effects=0;try{mutateBudgetLedger(owner=>{callbacks++;reserveTaskBudget(owner,${JSON.stringify(second)});effects++;},process.argv[1],${JSON.stringify(at)});process.exitCode=2;}catch(error){process.stdout.write(JSON.stringify({name:error.constructor.name,code:error.code??null,callbacks,effects}));}`;
      const contender = await child(contenderProgram).done; expect(contender.code).toBe(0); expect(contender.err).toBe(""); expect(JSON.parse(contender.out)).toEqual({ name: "StateLockConflictError", code: null, callbacks: 0, effects: 0 }); expect(readBudgetLedger(path)).toBeNull();
      holder.process.stdin!.end("x"); const committed = await holder.done; expect(committed.code).toBe(0); expect(committed.err).toBe(""); expect(committed.out).toContain("COMMITTED"); const before = bytes()!;
      const restarted = await child(contenderProgram).done; expect(restarted.code).toBe(0); expect(restarted.err).toBe(""); expect(JSON.parse(restarted.out)).toEqual({ name: "BudgetReservationError", code: "budget-unavailable", callbacks: 1, effects: 0 }); expect(bytes()!.equals(before)).toBe(true); expect(Object.keys(snapshot().reservations)).toHaveLength(1);
    } finally { if (children.has(holder.process)) holder.process.stdin!.end("x"); await holder.done; }
  }, 10000);
  it("refuses a restrictive objective dimension atomically across every company/project projection", () => {
    const objectiveRule: BudgetPolicyRule = { id: "objective-policy", revision: 1, scope: { kind: "objective", id: "objective-1" }, period: "none", warning_percent: 80, limits: limits({ total_tokens: 100 }) };
    const current = source({}, "none", [objectiveRule]), first = task({ source: current }), second = task({ source: current, id: "2" }); tx((owner) => reserveTaskBudget(owner, first)); rejectPreserved(() => tx((owner) => reserveTaskBudget(owner, second))); expect(Object.keys(snapshot().reservations)).toEqual([first.admission.reservation_id]);
  });
  it("rolls back a deliberate failure after reserve before task persistence without publishing a snapshot", () => {
    rejectPreserved(() => tx((owner) => { reserveTaskBudget(owner, task()); throw new Error("Synthetic reserve/persist fault"); })); expect(readBudgetLedger(path)).toBeNull();
  });
  it("keeps a persisted pending gap held and unclaimable after a fresh store read", () => {
    const value = task(); tx((owner) => reserveTaskBudget(owner, value)); expect(readBudgetLedger(path)!.reservations[value.admission.reservation_id]!.held.total_tokens).toBe(100);
    rejectPreserved(() => tx((owner) => claimTaskBudget(owner, { ...bound(value), run_id: "run-1" }))); rejectPreserved(() => tx((owner) => settleBudgetReservation(owner, { reservation_id: value.admission.reservation_id })));
  });
  it.each(["past", "future"])("refuses a fresh %s-dated admission instead of borrowing another transaction time", (kind) => {
    const value = task({ created_at: kind === "past" ? at : later }); rejectPreserved(() => tx((owner) => reserveTaskBudget(owner, value), kind === "past" ? later : at));
  });
  it("cannot reset settled consumption using fresh record IDs for the same canonical task", () => {
    const first = start(); observe(100, 10, true, first); tx((owner) => settleBudgetReservation(owner, { reservation_id: first.admission.reservation_id }), later);
    const replacement = task({ id: "2", created_at: later }); replacement.admission.task_id = first.admission.task_id; replacement.admission.attribution.execution_id = first.admission.task_id;
    replacement.admission.admitted_cap_fingerprint = resolveBudgetPolicy({ source: replacement.source, attribution: replacement.admission.attribution, at: later, base_caps: replacement.admission.caps }).cap_fingerprint; replacement.admission.intent_id = budgetTaskIntentId(replacement.admission);
    rejectPreserved(() => tx((owner) => reserveTaskBudget(owner, replacement), later)); expect(Object.keys(snapshot().subjects)).toHaveLength(1); expect(charge().observed_total_tokens).toBe(10);
  });
});

describe("T003 exact private ownership, self-exclusion and current policy", () => {
  it("rejects forged, copied and expired transaction objects without state effects", () => {
    const value = task(); let stale: BudgetTransaction | undefined; tx((owner) => { stale = owner; });
    for (const owner of [{}, structuredClone(stale), stale]) { rejectPreserved(() => reserveTaskBudget(owner as BudgetTransaction, value)); expect(() => readBudgetTransaction(owner)).toThrow(); }
  });
  it("claims its own exact hold at full capacity once without self-invalidation or duplicate debit", () => {
    const current = source({ concurrent_reads: 1 }), value = task({ source: current }); reserveCommit(value);
    const result = tx((owner) => claimTaskBudget(owner, { ...bound(value), run_id: "run-1" }), later); expect(result.status).toBe("claimed"); expect(result.charge.attempts).toBe(1); expect(frozenTree(result.charge)).toBe(true); expect(reservation(value).held.attempts).toBe(0); expect(reservation(value).held.concurrent_reads).toBe(1);
    const before = bytes()!; expect(tx((owner) => claimTaskBudget(owner, { ...bound(value), run_id: "run-1" }), later).status).toBe("already-claimed"); expect(bytes()!.equals(before)).toBe(true); expect(Object.keys(snapshot().charges)).toHaveLength(1);
  });
  it.each(["fingerprint", "rule-revision", "caps", "scope", "exclusion"])("rejects stale/forged %s before a fake execution effect", (kind) => {
    const value = task(); reserveCommit(value); const request: Record<string, unknown> = { ...bound(value), run_id: "run-1" }, effect = vi.fn();
    if (kind === "fingerprint") request.source = { ...value.source, fingerprint: "b".repeat(64) };
    if (kind === "rule-revision") { const changed = structuredClone(value.source); changed.policy.rules[0]!.revision++; request.source = changed; }
    if (kind === "caps") request.admission = { ...value.admission, caps: { ...value.admission.caps, runtime_ms: 2000 } };
    if (kind === "scope") request.admission = { ...value.admission, attribution: { ...value.admission.attribution, objective_ids: ["other"] } };
    if (kind === "exclusion") request.exclude_reservation_id = value.admission.reservation_id;
    rejectPreserved(() => tx((owner) => { claimTaskBudget(owner, request as never); effect(); })); expect(effect).not.toHaveBeenCalled(); expect(Object.keys(snapshot().charges)).toHaveLength(0);
  });
  it("cannot lend one reservation or global run identity to another exact task", () => {
    const first = start(), second = task({ id: "2" }); reserveCommit(second);
    rejectPreserved(() => tx((owner) => claimTaskBudget(owner, { ...bound(second), run_id: "run-1" }))); rejectPreserved(() => tx((owner) => claimTaskBudget(owner, { ...bound(second), admission: { ...second.admission, reservation_id: first.admission.reservation_id }, run_id: "run-2" })));
  });
  it("computes exact self-exclusion without adding an own hold back to an already-clamped zero", () => {
    const current = source({ total_tokens: 100 }), caps = amounts({ attempts: 2, runtime_ms: 1000, total_tokens: 20, concurrent_reads: 1 }), own = task({ source: current, caps }); reserveCommit(own);
    const foreign = start(task({ id: "2", source: current, caps }), "foreign-run"); observe(100, 90, true, foreign, "foreign-run"); rejectPreserved(() => tx((owner) => claimTaskBudget(owner, { ...bound(own), run_id: "own-run" }), later)); expect(reservation(own).held.total_tokens).toBe(20); expect(charge("foreign-run").observed_total_tokens).toBe(90); expect(charge("own-run")).toBeUndefined();
  });
  it("refuses accessors before invoking their hooks inside a private transaction", () => {
    const getter = vi.fn(() => task().admission), request = { source: source() }; Object.defineProperty(request, "admission", { enumerable: true, get: getter }); rejectPreserved(() => tx((owner) => reserveTaskBudget(owner, request as never))); expect(getter).not.toHaveBeenCalled();
  });
});

describe("T003 canonical high-water observations and conservative settlement", () => {
  it("debits monotonic progress once, then settles known terminal evidence without duplicating charges", () => {
    const value = start(); observe(300, 20, false, value); expect(reservation(value).held).toEqual(amounts({ runtime_ms: 700, total_tokens: 80, concurrent_reads: 1 }));
    const before = bytes()!; observe(300, 20, false, value); observe(200, 10, false, value); expect(bytes()!.equals(before)).toBe(true);
    observe(700, 30, true, value); expect(reservation(value).held).toEqual(amounts({ total_tokens: 70, concurrent_reads: 1 })); expect(charge()).toMatchObject({ runtime_ms: 700, observed_total_tokens: 30, status: "terminal", runtime_state: "complete", usage_state: "complete" });
    const result = tx((owner) => settleBudgetReservation(owner, { reservation_id: value.admission.reservation_id }), later); expect(result.status).toBe("settled"); expect(result.held).toEqual(amounts()); const settled = bytes()!; tx((owner) => settleBudgetReservation(owner, { reservation_id: result.id }), later); expect(bytes()!.equals(settled)).toBe(true);
  });
  it("accepts explicit complete zero but never treats a missing final receipt as that zero", () => {
    const value = start(); observe(0, 0, true, value); expect(charge()).toMatchObject({ runtime_state: "complete", usage_state: "complete", observed_total_tokens: 0 }); tx((owner) => settleBudgetReservation(owner, { reservation_id: value.admission.reservation_id }), later); expect(reservation(value).status).toBe("settled");
  });
  it("accepts a first valid decreasing final as complete high-water evidence, not uncertainty", () => {
    const value = start(); observe(500, 20, false, value); observe(400, 10, true, value); expect(charge()).toMatchObject({ runtime_ms: 500, observed_total_tokens: 20, status: "terminal", runtime_state: "complete", usage_state: "complete" }); expect(reservation(value).held).toEqual(amounts({ total_tokens: 80, concurrent_reads: 1 })); tx((owner) => settleBudgetReservation(owner, { reservation_id: value.admission.reservation_id }), later); expect(reservation(value).status).toBe("settled");
  });
  it("classifies truly absent first-final measurements as unknown instead of inheriting claim-time zero", () => {
    const value = start(); tx((owner) => observeBudgetRun(owner, { reservation_id: value.admission.reservation_id, run_id: "run-1", terminal: true }), later);
    expect(charge()).toMatchObject({ runtime_state: "unknown", usage_state: "unknown", status: "terminal" }); expect(reservation(value).status).toBe("unknown"); expect(reservation(value).held).toEqual(amounts({ runtime_ms: 1000, total_tokens: 100, concurrent_reads: 1 })); rejectPreserved(() => tx((owner) => settleBudgetReservation(owner, { reservation_id: value.admission.reservation_id }), later));
  });
  it("rejects hooked raw measurement properties without invoking provider-supplied accessors", () => {
    const value = start(), getter = vi.fn(() => 100), request = { reservation_id: value.admission.reservation_id, run_id: "run-1", total_tokens: 0, terminal: true };
    Object.defineProperty(request, "runtime_ms", { enumerable: true, get: getter }); rejectPreserved(() => tx((owner) => observeBudgetRun(owner, request), later)); expect(getter).not.toHaveBeenCalled();
  });
  it.each([undefined, null, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "20"])("preserves terminal unknown usage %j after a proven intermediate chunk", (bad) => {
    const value = start(); observe(300, 20, false, value); const held = structuredClone(reservation(value).held); observe(500, bad, true, value);
    expect(charge()).toMatchObject({ runtime_ms: 500, observed_total_tokens: 20, usage_state: "unknown", status: "terminal" }); expect(reservation(value).status).toBe("unknown"); expect(reservation(value).held).toEqual(held); expect(reservation(value).uncertain_dimensions).toContain("total_tokens");
    rejectPreserved(() => tx((owner) => topUpTaskBudget(owner, bound(value)), later)); rejectPreserved(() => tx((owner) => settleBudgetReservation(owner, { reservation_id: value.admission.reservation_id }), later));
  });
  it.each([undefined, null, -1, 0.5, Infinity, NaN, "500"])("preserves terminal unknown runtime %j and does not release known token/slot holds", (bad) => {
    const value = start(); observe(300, 20, false, value); const held = structuredClone(reservation(value).held); observe(bad, 30, true, value); expect(charge().runtime_ms).toBe(300); expect(charge().observed_total_tokens).toBe(30); expect(charge().runtime_state).toBe("unknown"); expect(reservation(value).held).toEqual(held);
  });
  it("never forgives prior unknown accounting when later counters become complete", () => {
    const value = start(); observe(100, undefined, false, value); const before = reservation(value).held; observe(200, 30, true, value); expect(charge().usage_state).toBe("unknown"); expect(reservation(value).status).toBe("unknown"); expect(reservation(value).held).toEqual(before); rejectPreserved(() => tx((owner) => settleBudgetReservation(owner, { reservation_id: value.admission.reservation_id }), later));
  });
  it("keeps duplicate terminal malformed/decreasing notifications harmless but records larger proven totals", () => {
    const value = start(); observe(500, 20, true, value); const before = bytes()!; observe(undefined, null, true, value); observe(400, 10, true, value); expect(bytes()!.equals(before)).toBe(true); observe(600, 30, true, value); expect(charge()).toMatchObject({ runtime_ms: 600, observed_total_tokens: 30, usage_state: "complete", status: "terminal" }); expect(reservation(value).held.total_tokens).toBe(70);
  });
  it.each([false, true])("never debits a prepared/current attempt runtime slice for an older terminal charge (review=%s)", (review) => {
    const value = start(task({ review })); observe(500, 20, true, value); tx((owner) => topUpTaskBudget(owner, bound(value)), later); observe(600, 30, true, value);
    expect(charge()).toMatchObject({ runtime_ms: 600, observed_total_tokens: 30, status: "terminal" }); expect(reservation(value).held).toMatchObject({ attempts: 1, runtime_ms: 1000, total_tokens: 70, concurrent_reads: 1 }); if (review) expect(reservation(value).held).toMatchObject({ review_attempts: 1, review_runtime_ms: 1000, review_total_tokens: 70 });
    tx((owner) => claimTaskBudget(owner, { ...bound(value), run_id: "run-2" }), later); observe(100, 5, false, value, "run-2"); observe(700, 40, true, value);
    expect(reservation(value).held).toMatchObject({ attempts: 0, runtime_ms: 900, total_tokens: 55, concurrent_reads: 1 }); expect(charge("run-2")).toMatchObject({ runtime_ms: 100, observed_total_tokens: 5, status: "running" }); if (review) expect(reservation(value).held).toMatchObject({ review_runtime_ms: 900, review_total_tokens: 55 });
  });
  it("retains actual overshoot rather than clipping it and denies another attempt", () => {
    const value = start(); observe(1200, 110, true, value); expect(charge()).toMatchObject({ runtime_ms: 1200, observed_total_tokens: 110 }); expect(reservation(value).held.total_tokens).toBe(0); rejectPreserved(() => tx((owner) => topUpTaskBudget(owner, bound(value)), later)); tx((owner) => settleBudgetReservation(owner, { reservation_id: value.admission.reservation_id }), later);
  });
  it.each(["pending", "committed", "active"])("marks a %s cross-store gap unknown with all existing holds retained", (kind) => {
    const value = task(); tx((owner) => reserveTaskBudget(owner, value)); if (kind !== "pending") tx((owner) => commitTaskBudget(owner, persisted(value))); if (kind === "active") tx((owner) => claimTaskBudget(owner, { ...bound(value), run_id: "run-1" }));
    const held = structuredClone(reservation(value).held); tx((owner) => markBudgetUnknown(owner, { reservation_id: value.admission.reservation_id }), later); expect(reservation(value).held).toEqual(held); expect(reservation(value).uncertain_dimensions).toEqual(expect.arrayContaining(["attempts", "runtime_ms", "total_tokens", "concurrent_reads"])); expect(snapshot().admission_intents[value.admission.intent_id]!.status).toBe("unknown"); rejectPreserved(() => tx((owner) => settleBudgetReservation(owner, { reservation_id: value.admission.reservation_id }), later));
  });
  it("rejects foreign run observations and running settlement without changing bytes", () => {
    const value = start(); rejectPreserved(() => observe(1, 1, true, value, "foreign-run")); rejectPreserved(() => tx((owner) => settleBudgetReservation(owner, { reservation_id: value.admission.reservation_id }), later));
  });
});

describe("T003 bounded retry top-ups, original periods and independent labels", () => {
  it.each([undefined, 3000])("permits cumulative runtime over the leaf per-attempt cap with parent runtime %j", (parentCap) => {
    const value = start(task({ source: source(parentCap === undefined ? {} : { runtime_ms: parentCap }) })); observe(700, 20, true, value); const topped = tx((owner) => topUpTaskBudget(owner, bound(value)), later);
    expect(topped.status).toBe("committed"); expect(topped.held).toEqual(amounts({ attempts: 1, runtime_ms: 1000, total_tokens: 80, concurrent_reads: 1 })); const before = bytes()!; tx((owner) => topUpTaskBudget(owner, bound(value)), later); expect(bytes()!.equals(before)).toBe(true);
    tx((owner) => claimTaskBudget(owner, { ...bound(value), run_id: "run-2" }), later); observe(700, 30, true, value, "run-2"); expect(Object.values(snapshot().charges).reduce((total, item) => total + item.runtime_ms, 0)).toBe(1400); expect(reservation(value).held.total_tokens).toBe(50); rejectPreserved(() => tx((owner) => topUpTaskBudget(owner, bound(value)), later));
  });
  it("narrows each retry runtime slice to remaining cumulative parent capacity", () => {
    const value = start(task({ source: source({ runtime_ms: 1500 }) })); observe(900, 20, true, value); expect(tx((owner) => topUpTaskBudget(owner, bound(value)), later).held.runtime_ms).toBe(600);
  });
  it("keeps the original day binding and cap through rollover rather than borrowing a new day's full allowance", () => {
    const value = start(task({ source: source({ runtime_ms: 1500 }, "utc-day") })); observe(900, 20, true, value); const nextDay = "2026-10-06T00:00:00Z", topped = tx((owner) => topUpTaskBudget(owner, bound(value)), nextDay);
    expect(topped.held.runtime_ms).toBe(600); expect(topped.policy_bindings[0]!.bucket).toBe("2026-10-05"); expect(topped.created_at).toBe(at); expect(topped.updated_at).toBe(nextDay);
  });
  it("also respects tighter current-day consumption while preserving the original admission bucket", () => {
    const current = source({ runtime_ms: 1500 }, "utc-day"), first = start(task({ source: current })); observe(900, 20, true, first);
    const nextDay = "2026-10-06T00:00:00Z", second = start(task({ id: "2", source: current, created_at: nextDay }), "run-2"); observe(700, 20, true, second, "run-2", nextDay);
    tx((owner) => topUpTaskBudget(owner, bound(second)), nextDay); tx((owner) => claimTaskBudget(owner, { ...bound(second), run_id: "run-3" }), nextDay); observe(400, 10, true, second, "run-3", nextDay); tx((owner) => settleBudgetReservation(owner, { reservation_id: second.admission.reservation_id }), nextDay);
    const topped = tx((owner) => topUpTaskBudget(owner, bound(first)), nextDay); expect(topped.held.runtime_ms).toBe(400); expect(topped.policy_bindings[0]!.bucket).toBe("2026-10-05");
  });
  it("does not top up a running attempt or reserve cumulative tokens twice", () => {
    const value = start(); observe(300, 20, false, value); rejectPreserved(() => tx((owner) => topUpTaskBudget(owner, bound(value)), later)); expect(reservation(value).held.total_tokens).toBe(80);
  });
  it("uses review labels as an independent bounded overlap, not extra canonical charges", () => {
    const value = start(task({ review: true, caps: amounts({ attempts: 2, runtime_ms: 1000, total_tokens: 100, concurrent_reads: 1, review_attempts: 1, review_runtime_ms: 600, review_total_tokens: 40 }) })); expect(reservation(value).held).toEqual(amounts({ runtime_ms: 600, total_tokens: 40, concurrent_reads: 1, review_runtime_ms: 600, review_total_tokens: 40 })); observe(300, 20, true, value); expect(charge().review).toBe(true);
    const projection = resolveBudgetPolicy({ source: value.source, attribution: value.admission.attribution, at: later, base_caps: value.admission.caps, ledger: snapshot() }); expect(projection.sources[0]!.dimensions.total_tokens.proven_consumed).toBe(20); expect(projection.sources[0]!.dimensions.review_total_tokens.proven_consumed).toBe(20); rejectPreserved(() => tx((owner) => topUpTaskBudget(owner, bound(value)), later));
  });
  it("consumes one opted-in correction allowance before effects and never refunds it on replacement workflow", () => {
    const mappings = [lineage(["workflow-1", "workflow-2"])], first = { ...task({ correction: true }), correction_lineages: mappings }; reserveCommit(first); expect(reservation(first).held.corrections).toBe(1);
    tx((owner) => claimTaskBudget(owner, { ...bound(first), run_id: "run-1" })); expect(charge().correction).toBe(true); expect(reservation(first).held.corrections).toBe(0); observe(100, 10, true, first); tx((owner) => settleBudgetReservation(owner, { reservation_id: first.admission.reservation_id }), later);
    const next = { ...task({ correction: true, id: "2", created_at: later }), correction_lineages: mappings }; rejectPreserved(() => tx((owner) => reserveTaskBudget(owner, next), later));
  });
  it("refuses correction allocation without exact trusted candidate-lineage binding", () => {
    rejectPreserved(() => tx((owner) => reserveTaskBudget(owner, task({ correction: true })))); const value = { ...task({ correction: true }), correction_lineages: [{ ...lineage(), issue_id: "other-issue" }] }; rejectPreserved(() => tx((owner) => reserveTaskBudget(owner, value)));
  });
  it("allows a bounded retry of the same correction stage without consuming another lineage allowance", () => {
    const value = start({ ...task({ correction: true, source: source({ corrections: 1 }) }), correction_lineages: [lineage()] }); observe(400, 20, true, value); expect(tx((owner) => topUpTaskBudget(owner, bound(value)), later).held.corrections).toBe(0);
    tx((owner) => claimTaskBudget(owner, { ...bound(value), run_id: "run-2" }), later); observe(500, 20, true, value, "run-2"); const state = snapshot(); expect(Object.values(state.charges).map((item) => item.correction)).toEqual([true, true]); expect(Object.keys(state.reservations)).toHaveLength(1);
    const projection = resolveBudgetPolicy({ source: value.source, attribution: value.admission.attribution, at: later, base_caps: value.admission.caps, ledger: state, correction_lineages: [lineage()] }); expect(projection.sources[0]!.dimensions.corrections).toMatchObject({ consumed: 1, reserved: 0, remaining: 0 }); expect(projection.sources[0]!.dimensions.attempts.proven_consumed).toBe(2);
  });
});

function occurrence(id = "1", current = source(), runtime = 60000, stamp = at, constraints?: ExistingBudgetConstraint[]) {
  const subject: BudgetOccurrenceSubject = { id: `occurrence-subject-${id}`, kind: "occurrence", occurrence_id: `occurrence-${id}`, routine_id: "routine-1", routine_revision: 1, slot: stamp, project_ids: [], attribution: { company_id: "surtec", objective_ids: [], project_ids: [], issue_id: null, role_id: null, execution_id: `occurrence-${id}` } };
  const projection = resolveBudgetPolicy({ source: current, attribution: subject.attribution, at: stamp, base_caps: amounts({ attempts: 1, runtime_ms: runtime, concurrent_reads: 1 }), ...(constraints ? { constraints } : {}) });
  const reservation_id = `occurrence-reservation-${id}`, intent_id = budgetOccurrenceIntentId({ subject, reservation_id, policy_bindings: structuredClone(projection.policy_bindings), cap_fingerprint: projection.cap_fingerprint, runtime_ms: runtime, created_at: stamp }); return { subject, reservation_id, intent_id, source: current, runtime_ms: runtime, ...(constraints ? { constraints } : {}) };
}
describe("T003 explicit bounded occurrence subjects", () => {
  it("reserves and charges one read-only occurrence with zero model/write/review/correction resources", () => {
    const value = occurrence(), pending = tx((owner) => reserveOccurrenceBudget(owner, value)); expect(pending.held).toEqual(amounts({ attempts: 1, runtime_ms: 60000, concurrent_reads: 1 }));
    tx((owner) => commitOccurrenceBudget(owner, { subject_id: value.subject.id, reservation_id: value.reservation_id, intent_id: value.intent_id })); const result = tx((owner) => claimOccurrenceBudget(owner, { reservation_id: value.reservation_id, run_id: "routine-run-1", source: value.source })); expect(result.charge).toMatchObject({ attempts: 1, observed_total_tokens: 0, review: false, correction: false }); expect(snapshot().admission_intents[value.intent_id]!.admission_id).toBeNull();
    tx((owner) => observeBudgetRun(owner, { reservation_id: value.reservation_id, run_id: "routine-run-1", runtime_ms: 60001, total_tokens: 0, terminal: true }), later); tx((owner) => settleBudgetReservation(owner, { reservation_id: value.reservation_id }), later); expect(charge("routine-run-1").runtime_ms).toBe(60001); expect(snapshot().reservations[value.reservation_id]!.held).toEqual(amounts());
  });
  it("intersects a multi-project occurrence into exactly one runtime allocation and canonical charge", () => {
    const rules: BudgetPolicyRule[] = [40000, 30000].map((runtime, index) => ({ id: `project-policy-${index + 1}`, revision: 1, scope: { kind: "project", id: `project-${index + 1}` }, period: "none", warning_percent: 80, limits: limits({ runtime_ms: runtime }) })), current = source({}, "none", rules);
    const prepare = (id: string) => { const value = occurrence(id, current, 30000); value.subject.routine_id = `routine-${id}`; value.subject.project_ids = ["project-1", "project-2"]; value.subject.attribution.project_ids = [...value.subject.project_ids]; const projection = resolveBudgetPolicy({ source: current, attribution: value.subject.attribution, at, base_caps: amounts({ attempts: 1, runtime_ms: 30000, concurrent_reads: 1 }) }); value.intent_id = budgetOccurrenceIntentId({ subject: value.subject, reservation_id: value.reservation_id, policy_bindings: structuredClone(projection.policy_bindings), cap_fingerprint: projection.cap_fingerprint, runtime_ms: 30000, created_at: at }); return value; };
    const value = prepare("1"), held = tx((owner) => reserveOccurrenceBudget(owner, value)); expect(held.held).toEqual(amounts({ attempts: 1, runtime_ms: 30000, concurrent_reads: 1 })); expect(held.policy_bindings).toHaveLength(3); const next = prepare("2"); rejectPreserved(() => tx((owner) => reserveOccurrenceBudget(owner, next))); expect(Object.keys(snapshot().reservations)).toHaveLength(1);
    tx((owner) => commitOccurrenceBudget(owner, { subject_id: value.subject.id, reservation_id: value.reservation_id, intent_id: value.intent_id })); tx((owner) => claimOccurrenceBudget(owner, { reservation_id: value.reservation_id, run_id: "routine-run-1", source: current })); tx((owner) => observeBudgetRun(owner, { reservation_id: value.reservation_id, run_id: "routine-run-1", runtime_ms: 1000, total_tokens: 0, terminal: true }), later);
    const projection = resolveBudgetPolicy({ source: current, attribution: value.subject.attribution, at: later, base_caps: amounts({ attempts: 1, runtime_ms: 30000, concurrent_reads: 1 }), ledger: snapshot() }); expect(Object.keys(snapshot().charges)).toHaveLength(1); expect(projection.sources.map((view) => view.dimensions.runtime_ms.proven_consumed)).toEqual([1000, 1000, 1000]); expect(projection.sources.map((view) => view.dimensions.total_tokens.proven_consumed)).toEqual([0, 0, 0]);
  });
  it("rejects replay/new identity of the same UTC slot, including its equivalent millisecond spelling", () => {
    const first = occurrence(); tx((owner) => reserveOccurrenceBudget(owner, first)); rejectPreserved(() => tx((owner) => reserveOccurrenceBudget(owner, first)));
    for (const slot of [at, "2026-10-05T12:00:00.000Z"]) { const next = occurrence("2", source(), 60000, slot); rejectPreserved(() => tx((owner) => reserveOccurrenceBudget(owner, next), slot)); }
  });
  it("requires occurrence commitment and denies another run/retry after its known terminal attempt", () => {
    const value = occurrence(); tx((owner) => reserveOccurrenceBudget(owner, value)); rejectPreserved(() => tx((owner) => claimOccurrenceBudget(owner, { reservation_id: value.reservation_id, run_id: "routine-run-1", source: value.source })));
    tx((owner) => commitOccurrenceBudget(owner, { subject_id: value.subject.id, reservation_id: value.reservation_id, intent_id: value.intent_id })); tx((owner) => claimOccurrenceBudget(owner, { reservation_id: value.reservation_id, run_id: "routine-run-1", source: value.source })); const before = bytes()!; expect(tx((owner) => claimOccurrenceBudget(owner, { reservation_id: value.reservation_id, run_id: "routine-run-1", source: value.source })).status).toBe("already-claimed"); expect(bytes()!.equals(before)).toBe(true);
    tx((owner) => observeBudgetRun(owner, { reservation_id: value.reservation_id, run_id: "routine-run-1", runtime_ms: 100, total_tokens: 0, terminal: true }), later); rejectPreserved(() => tx((owner) => claimOccurrenceBudget(owner, { reservation_id: value.reservation_id, run_id: "routine-run-2", source: value.source }), later));
  });
  it.each([0, 60001, -1, 0.5, Infinity])("refuses unsafe occurrence runtime %j without reserving", (runtime) => {
    const value = occurrence(); rejectPreserved(() => tx((owner) => reserveOccurrenceBudget(owner, { ...value, runtime_ms: runtime })));
  });
  it("refuses invented role/agent metadata, forged intents and model usage on an occurrence", () => {
    const value = occurrence(); rejectPreserved(() => tx((owner) => reserveOccurrenceBudget(owner, { ...value, role_id: "reviewer" } as never))); rejectPreserved(() => tx((owner) => reserveOccurrenceBudget(owner, { ...value, intent_id: "forged-intent" })));
    tx((owner) => reserveOccurrenceBudget(owner, value)); tx((owner) => commitOccurrenceBudget(owner, { subject_id: value.subject.id, reservation_id: value.reservation_id, intent_id: value.intent_id })); tx((owner) => claimOccurrenceBudget(owner, { reservation_id: value.reservation_id, run_id: "routine-run-1", source: value.source })); rejectPreserved(() => tx((owner) => observeBudgetRun(owner, { reservation_id: value.reservation_id, run_id: "routine-run-1", runtime_ms: 100, total_tokens: 1, terminal: true }), later));
  });
  it("retains only measured occurrence uncertainty and all its read/runtime holds after interruption", () => {
    const value = occurrence(); tx((owner) => reserveOccurrenceBudget(owner, value)); const held = snapshot().reservations[value.reservation_id]!.held; tx((owner) => markBudgetUnknown(owner, { reservation_id: value.reservation_id }), later); const result = snapshot().reservations[value.reservation_id]!; expect(result.held).toEqual(held); expect(result.uncertain_dimensions).toEqual(["attempts", "runtime_ms", "concurrent_reads"]); rejectPreserved(() => tx((owner) => settleBudgetReservation(owner, { reservation_id: value.reservation_id }), later));
  });
  it.each(["id", "revision", "fingerprint", "omitted"])("refuses changed occurrence constraint %s despite identical resource caps", (kind) => {
    const existing: ExistingBudgetConstraint = { id: "routine-limit", kind: "routine", revision: 1, fingerprint: digest, limits: limits({ runtime_ms: 60000, concurrent_reads: 1 }) }, value = occurrence("1", source(), 60000, at, [existing]);
    tx((owner) => reserveOccurrenceBudget(owner, value)); tx((owner) => commitOccurrenceBudget(owner, { subject_id: value.subject.id, reservation_id: value.reservation_id, intent_id: value.intent_id })); const changed = structuredClone(existing);
    if (kind === "id") changed.id = "replacement-limit"; if (kind === "revision") changed.revision++; if (kind === "fingerprint") changed.fingerprint = "b".repeat(64); const effects = vi.fn();
    rejectPreserved(() => tx((owner) => { claimOccurrenceBudget(owner, { reservation_id: value.reservation_id, run_id: "routine-run-1", source: value.source, ...(kind === "omitted" ? {} : { constraints: [changed] }) }); effects(); })); expect(effects).not.toHaveBeenCalled(); expect(Object.keys(snapshot().charges)).toHaveLength(0);
  });
});
