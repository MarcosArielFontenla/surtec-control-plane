import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUDGET_DIMENSIONS, type BudgetLimits } from "../lib/budgets/types";
import type { BudgetPolicySource, ExistingBudgetConstraint } from "../lib/budgets/policy";
import { RoutineActionError, type RoutineActionEvidence, type RoutineEvidenceReadOptions } from "../lib/routines/actions";
import * as actions from "../lib/routines/actions";
import { routineRevisionKey } from "../lib/routines/schedule";
import type { RoutineOccurrence, RoutineRecord } from "../lib/routines/types";
import { createRoutineDraft } from "../lib/routines/validation";
import { budgetStatePath, routineStatePath } from "../lib/state/paths";
import { readBudgetLedger } from "../lib/state/budgets";
import * as budgetStore from "../lib/state/budgets";
import { mutateRoutineDocument, readRoutineDocument, updateRoutineTransaction } from "../lib/state/routines";
import * as routineStore from "../lib/state/routines";
import { isRoutineRunner, RoutineRunner, type RoutineExecutionComposition, type RoutineExecutionPolicy } from "./routine-runner";

const digest = "a".repeat(64), anchor = Date.parse("2026-10-06T12:00:00.000Z");
function limits(overrides: Partial<Record<typeof BUDGET_DIMENSIONS[number], number>> = {}): BudgetLimits {
  return Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, overrides[dimension] === undefined
    ? { status: "unconfigured" } : { status: "configured", hard_cap: overrides[dimension] }])) as BudgetLimits;
}
function source(overrides: Parameters<typeof limits>[0] = {}): BudgetPolicySource {
  return { fingerprint: digest, policy: { schema_version: 1, revision: 1, pricing: { status: "unavailable", reason: "no-versioned-source" },
    rules: [{ id: "company-policy", revision: 1, scope: { kind: "company", id: "surtec" }, period: "none", warning_percent: 80, limits: limits(overrides) }] } };
}
describe("T011 finite privately owned routine runner", () => {
  let root: string, state: string, path: string, ledgerPath: string, now: number, policy: BudgetPolicySource;
  const runners: RoutineRunner[] = [];
  beforeEach(() => {
    root = mkdtempSync(join(resolve(tmpdir()), "surtec-routine-runner-")); state = join(root, "state"); mkdirSync(state, { mode: 0o700 });
    path = routineStatePath(state); ledgerPath = budgetStatePath(state); now = anchor; policy = source();
  });
  afterEach(async () => {
    vi.restoreAllMocks(); for (const runner of runners.splice(0)) await runner.stop(); vi.unstubAllEnvs();
    expect(dirname(root)).toBe(resolve(tmpdir())); expect(lstatSync(root).isSymbolicLink()).toBe(false);
    rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false);
  });
  function definition(id = "routine-1", options: Partial<RoutineRecord> = {}): RoutineRecord {
    const at = new Date(anchor).toISOString(), draft = createRoutineDraft({ id, action: "refresh-evidence", scope: { kind: "company", id: "surtec" },
      policy: { revision: 1, fingerprint: digest, policy_ids: ["company-policy"] }, at });
    const enabled: RoutineRecord = { ...structuredClone(draft), revision: 2, enabled: true, schedule: "every:15m", schedule_anchor_at: at, catch_up: "run-once", ...options };
    mutateRoutineDocument((tx) => {
      updateRoutineTransaction(tx, (doc) => { doc.routines[id] = structuredClone(draft); doc.definitions[routineRevisionKey(id, 1)] = structuredClone(draft); });
      updateRoutineTransaction(tx, (doc) => { doc.routines[id] = structuredClone(enabled); doc.definitions[routineRevisionKey(id, 2)] = structuredClone(enabled); });
    }, path, at);
    return enabled;
  }
  function evidence(): RoutineActionEvidence {
    return { sources: [{ kind: "organization", project_id: null, state: "fresh", observed_at: new Date(now).toISOString(), fingerprint: digest }], signals: [] };
  }
  function execution(options: Partial<RoutineExecutionComposition> = {}): RoutineExecutionComposition {
    return { resolve: (_definition, id) => ({ source: policy, attribution: { company_id: "surtec", project_ids: ["synthetic"], objective_ids: [],
      issue_id: null, role_id: null, execution_id: id } }), assert_current: () => undefined, read_evidence: async () => evidence(), monotonic: () => 0, ...options };
  }
  function runner(wiring: RoutineExecutionComposition | undefined = execution()) {
    const value = new RoutineRunner({ stateRoot: state, now: () => new Date(now), ...(wiring === undefined ? {} : { execution: wiring }) });
    runners.push(value); return value;
  }
  const occurrences = () => Object.values(readRoutineDocument(path)?.occurrences ?? {});
  const charges = () => Object.values(readBudgetLedger(ledgerPath)?.charges ?? {});
  const reservations = () => Object.values(readBudgetLedger(ledgerPath)?.reservations ?? {});
  function due(minutes = 15): void { now = anchor + minutes * 60000; }
  function reconfigure(change: Partial<RoutineRecord>): void {
    mutateRoutineDocument((tx) => updateRoutineTransaction(tx, (doc, at) => {
      const previous = doc.routines["routine-1"]!, next: RoutineRecord = { ...previous, ...change, revision: previous.revision + 1,
        updated_at: at, schedule_anchor_at: change.schedule === null || previous.schedule === null ? null : at };
      doc.routines[next.id] = next; doc.definitions[routineRevisionKey(next.id, next.revision)] = structuredClone(next);
    }), path, new Date(now).toISOString());
  }
  it("inactive production composition does not read or create state, even with enabling environment flags", async () => {
    definition(); const before = readFileSync(path); vi.stubEnv("SURTEC_ROUTINES_ENABLED", "1"); vi.stubEnv("SURTEC_BUDGET_CUTOVER", "1"); due();
    const inactive = new RoutineRunner({ stateRoot: state, now: () => new Date(now) }); runners.push(inactive);
    const read = vi.spyOn(routineStore, "readRoutineDocument"); inactive.tick("worker", 1); inactive.runManual("routine-1", 2, "worker", 1); await inactive.stop();
    expect(read).not.toHaveBeenCalled(); expect(readFileSync(path)).toEqual(before); expect(existsSync(ledgerPath)).toBe(false);
  });
  it("optional absence has no lock, clock or history side effects", () => {
    const clock = vi.fn(() => new Date(now)), value = new RoutineRunner({ stateRoot: state, now: clock, execution: execution() }); runners.push(value);
    value.tick("worker", 1); expect(clock).not.toHaveBeenCalled(); expect(existsSync(path)).toBe(false); expect(existsSync(join(state, "locks"))).toBe(false);
  });
  it("round-robins one definition per tick instead of performing an unbounded cursor-write burst", async () => {
    definition("routine-1", { enabled: false }); definition("routine-2"); due(); const read = vi.fn(async () => evidence()), value = runner(execution({ read_evidence: read }));
    const mutate = vi.spyOn(routineStore, "mutateRoutineDocument"); value.tick("worker", 1); expect(mutate).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled(); value.tick("worker", 1); await value.idle(); expect(read).toHaveBeenCalledOnce(); expect(occurrences()[0].routine_id).toBe("routine-2");
  });
  it.each(["{", '{"schema_version":2}', '{"schema_version":1}'])("preserves invalid/future source %s with zero provider or budget effects", (bytes) => {
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); const read = vi.fn(), value = runner(execution({ read_evidence: read }));
    value.tick("worker", 1); expect(value.lastFailure).toBe("state-invalid"); expect(read).not.toHaveBeenCalled(); expect(readFileSync(path, "utf8")).toBe(bytes); expect(existsSync(ledgerPath)).toBe(false);
  });
  it.each(["resolve", "assert_current", "monotonic"] as const)("rejects an async %s gate before stores/effects", (name) => {
    expect(() => runner(execution({ [name]: async () => undefined } as never))).toThrow(RoutineActionError); expect(existsSync(path)).toBe(false);
  });
  it.each(["proxy", "getter", "extra"] as const)("rejects %s constructor metadata without invoking hooks", (kind) => {
    const hook = vi.fn(), options: Record<string, unknown> = { stateRoot: state };
    if (kind === "getter") Object.defineProperty(options, "execution", { enumerable: true, get: hook });
    if (kind === "extra") options.enabled = true;
    expect(() => new RoutineRunner((kind === "proxy" ? new Proxy(options, { get: hook }) : options) as never)).toThrow(); expect(hook).not.toHaveBeenCalled();
  });
  it("recognizes only the exact registered instance, never inventory/copies/proxies", () => {
    const value = runner(); expect(isRoutineRunner(value)).toBe(true); expect(isRoutineRunner({ ...value })).toBe(false);
    expect(isRoutineRunner(new Proxy(value, {}))).toBe(false); expect(isRoutineRunner(null)).toBe(false);
  });
  it("reserves, persists, commits, privately claims, accounts, terminalizes and settles once", async () => {
    definition(); policy = source({ attempts: 1, concurrent_reads: 1 }); due();
    const read = vi.fn(async (occurrence: Readonly<RoutineOccurrence>, options: RoutineEvidenceReadOptions) => {
      expect(occurrence.owner?.worker_id).toBe("worker"); expect(occurrence.status).toBe("running"); options.check();
      expect(reservations()[0]).toMatchObject({ status: "active", held: { attempts: 0, concurrent_reads: 1, total_tokens: 0, concurrent_writes: 0 } });
      now += 15; return evidence();
    });
    const value = runner(execution({ read_evidence: read })); value.tick("worker", 1); expect(value.activeCount).toBe(1); await value.idle();
    expect(read).toHaveBeenCalledOnce(); expect(occurrences()).toMatchObject([{ status: "completed", trigger: "catch-up", receipt: { consumption: {
      attempts: 1, runtime_ms: 15, total_tokens: 0, model_calls: 0, workspace_writes: 0 }, budget_outcome: "within-limit" } }]);
    expect(charges()).toMatchObject([{ attempts: 1, runtime_ms: 15, observed_total_tokens: 0, status: "terminal", review: false, correction: false }]);
    expect(reservations()).toMatchObject([{ status: "settled", held: Object.fromEntries(BUDGET_DIMENSIONS.map((d) => [d, 0])) }]);
    expect(value.activeCount).toBe(0); value.tick("worker", 1); await value.idle(); expect(read).toHaveBeenCalledOnce(); expect(charges()).toHaveLength(1);
  });
  it.each(["skip-missed", "run-once"] as const)("restart uses finite %s, no backlog and no completed-slot replay", async (catchUp) => {
    definition("routine-1", { catch_up: catchUp }); due(1500); const read = vi.fn(async () => evidence()), first = runner(execution({ read_evidence: read }));
    first.tick("worker", 1); await first.idle(); expect(read).toHaveBeenCalledTimes(catchUp === "run-once" ? 1 : 0);
    const restarted = runner(execution({ read_evidence: read })); restarted.tick("new-worker", 1); await restarted.idle();
    expect(read).toHaveBeenCalledTimes(catchUp === "run-once" ? 1 : 0); due(1515); restarted.tick("new-worker", 1); await restarted.idle();
    expect(read).toHaveBeenCalledTimes(catchUp === "run-once" ? 2 : 1); expect(occurrences().at(-1)?.trigger).toBe("scheduled");
  });
  it("manual-only requires explicit exact-revision invocation and suppresses its retained slot", async () => {
    definition("routine-1", { schedule: null, schedule_anchor_at: null }); const read = vi.fn(async () => evidence()), value = runner(execution({ read_evidence: read }));
    value.tick("worker", 1); await value.idle(); expect(read).not.toHaveBeenCalled(); due(); value.runManual("routine-1", 1, "worker", 1);
    expect(value.lastFailure).toBe("state-invalid"); value.runManual("routine-1", 2, "worker", 1); await value.idle(); expect(read).toHaveBeenCalledOnce();
    value.runManual("routine-1", 2, "worker", 1); await value.idle(); expect(read).toHaveBeenCalledOnce(); expect(occurrences()[0].trigger).toBe("manual");
  });
  it("disabled current definitions never admit, even for an explicit manual request", async () => {
    definition("routine-1", { enabled: false }); due(); const read = vi.fn(), value = runner(execution({ read_evidence: read }));
    value.tick("worker", 1); value.runManual("routine-1", 2, "worker", 1); await value.idle(); expect(read).not.toHaveBeenCalled(); expect(charges()).toEqual([]);
  });
  it("one worker read slot is required after ordinary task claims", async () => {
    definition(); due(); const read = vi.fn(async () => evidence()), value = runner(execution({ read_evidence: read }));
    value.tick("worker", 0); await value.idle(); expect(read).not.toHaveBeenCalled(); value.tick("worker", 1); await value.idle(); expect(read).not.toHaveBeenCalled();
    due(30); value.tick("worker", 1); await value.idle(); expect(read).toHaveBeenCalledOnce();
  });
  it.each(["skip", "coalesce"] as const)("busy %s keeps at most one slot while background evidence is unresolved", async (concurrency) => {
    definition("routine-1", { concurrency }); due(); let release!: () => void;
    const read = vi.fn(async () => { if (read.mock.calls.length === 1) await new Promise<void>((done) => { release = done; }); return evidence(); });
    const value = runner(execution({ read_evidence: read })); value.tick("worker", 1); await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    due(30); value.tick("worker", 1); due(45); value.tick("worker", 1); expect(read).toHaveBeenCalledOnce();
    const cursor = Object.values(readRoutineDocument(path)!.cursors)[0]; expect(cursor.pending_slot).toBe(concurrency === "coalesce" ? new Date(now).toISOString() : null);
    release(); await value.idle(); value.tick("worker", 1); await value.idle(); expect(read).toHaveBeenCalledTimes(concurrency === "coalesce" ? 2 : 1);
    expect(occurrences()).toHaveLength(concurrency === "coalesce" ? 2 : 1);
  });
  it("two live controllers cannot adopt or duplicate the privately owned occurrence", async () => {
    definition(); due(); let release!: () => void; const read = vi.fn(async () => { await new Promise<void>((done) => { release = done; }); return evidence(); });
    const first = runner(execution({ read_evidence: read })), second = runner(execution({ read_evidence: read }));
    first.tick("first", 1); await vi.waitFor(() => expect(read).toHaveBeenCalledOnce()); const before = readFileSync(path), ledger = readFileSync(ledgerPath);
    second.tick("second", 1); expect(second.lastFailure).toBe("ownership-unavailable"); expect(second.activeCount).toBe(0);
    expect(readFileSync(path)).toEqual(before); expect(readFileSync(ledgerPath)).toEqual(ledger); expect(charges()).toHaveLength(1); release(); await first.idle();
  });
  it.each(["cancel", "stop", "disable"] as const)("%s aborts a non-resolving provider and prevents late callbacks/effects", async (operation) => {
    definition("routine-1", { action: "propose-issues" }); due(); let late!: () => void, options!: RoutineEvidenceReadOptions;
    const read = vi.fn(async (_occurrence, supplied) => { options = supplied; await new Promise<void>((done) => { late = done; }); supplied.check(); return evidence(); });
    const propose = vi.fn(), value = runner(execution({ read_evidence: read, propose_issue: propose }));
    value.tick("worker", 1); await vi.waitFor(() => expect(read).toHaveBeenCalledOnce()); now += 10;
    if (operation === "cancel") value.cancel(); else if (operation === "stop") await value.stop(); else { reconfigure({ enabled: false }); value.tick("worker", 1); }
    await value.idle(); expect(options.signal.aborted).toBe(true); expect(propose).not.toHaveBeenCalled(); late(); await Promise.resolve();
    expect(propose).not.toHaveBeenCalled(); expect(occurrences()[0].status).toBe(operation === "disable" ? "needs-review" : "cancelled");
    expect(occurrences()[0].receipt?.consumption.runtime_ms).toBe(10); expect(reservations()[0].status).toBe("settled");
    const bytes = readFileSync(ledgerPath); value.tick("worker", 1); expect(readFileSync(ledgerPath)).toEqual(bytes); expect(read).toHaveBeenCalledOnce();
  });
  it("stopping before the dispatch microtask prevents provider effects and retains known accounting", async () => {
    definition(); due(); const read = vi.fn(), value = runner(execution({ read_evidence: read })); value.tick("worker", 1); await value.stop();
    expect(read).not.toHaveBeenCalled(); expect(occurrences()[0].status).toBe("cancelled"); expect(reservations()[0].status).toBe("settled");
  });
  it("deadline terminates a non-resolving provider with measured exhaustion and no successor replay", async () => {
    const d = definition("routine-1", { limits: { max_attempts: 1, max_projects: 25, max_runtime_ms: 25, max_concurrent_occurrences: 1 } }); due();
    const read = vi.fn(async () => new Promise<never>(() => undefined)), value = runner(execution({ read_evidence: read })); value.tick("worker", 1); await value.idle();
    expect(read).toHaveBeenCalledOnce(); expect(occurrences()[0]).toMatchObject({ status: "failed", receipt: { failure_code: "deadline-exceeded", budget_outcome: "exhausted" } });
    expect(reservations()[0].status).toBe("settled"); expect(occurrences()[0].budget.admitted_runtime_ms).toBe(d.limits.max_runtime_ms);
  });
  it("measured excess is retained, not clipped or refunded as zero", async () => {
    definition(); due(); const value = runner(execution({ read_evidence: async () => { now += 65000; return evidence(); } }));
    value.tick("worker", 1); await value.idle(); expect(charges()[0].runtime_ms).toBe(65000); expect(occurrences()[0].receipt?.budget_outcome).toBe("exhausted");
  });
  it.each(["partial", "stale", "unavailable", "throw"] as const)("optional source result %s is not fresh success or a global outage", async (kind) => {
    definition(); due(); const value = runner(execution({ read_evidence: async () => {
      if (kind === "throw") throw new Error("synthetic-private-payload"); const facts = evidence();
      if (kind === "partial") facts.sources.push({ kind: "ci", project_id: "synthetic", state: "unavailable", observed_at: null, fingerprint: null });
      else facts.sources[0].state = kind; return facts;
    } })); value.tick("worker", 1); await value.idle();
    expect(occurrences()[0].status).toBe(kind === "throw" ? "failed" : "partial"); expect(occurrences()[0].receipt?.freshness).not.toBe("fresh");
    expect(JSON.stringify(readRoutineDocument(path))).not.toContain("synthetic-private-payload"); expect(reservations()[0].status).toBe("settled");
  });
  it("parent attempt denial persists an unstarted receipt and cannot reattempt its slot", async () => {
    definition(); policy = source({ attempts: 1 }); due(); const read = vi.fn(async () => evidence()), value = runner(execution({ read_evidence: read }));
    value.tick("worker", 1); await value.idle(); due(30); value.tick("worker", 1); await value.idle(); expect(read).toHaveBeenCalledOnce(); expect(occurrences()[1]).toMatchObject({ status: "failed",
      receipt: { budget_outcome: "denied", failure_code: "budget-denied", consumption: { attempts: 0, runtime_ms: 0 } } });
    expect(charges()).toHaveLength(1); expect(reservations()).toHaveLength(1); const before = readFileSync(path); value.tick("worker", 1); expect(readFileSync(path)).toEqual(before);
  });
  it.each(["attempts", "runtime_ms", "concurrent_reads"] as const)("zero static %s cap never fabricates a positive admission and retains considered-slot denial", async (dimension) => {
    definition(); policy = source({ [dimension]: 0 }); due(); const read = vi.fn(), value = runner(execution({ read_evidence: read }));
    value.tick("worker", 1); await value.idle(); expect(value.lastFailure).toBe("budget-denied"); expect(read).not.toHaveBeenCalled(); expect(existsSync(ledgerPath)).toBe(false);
    expect(occurrences()).toEqual([]); const before = readFileSync(path); value.tick("worker", 1); expect(readFileSync(path)).toEqual(before);
  });
  it("ambiguous action effects retain measured high-water and unused runtime/read holds, not a refund", async () => {
    definition(); due(); const value = runner(execution({ read_evidence: async () => { now += 10; throw new RoutineActionError("accounting-unavailable"); } }));
    value.tick("worker", 1); await value.idle(); expect(occurrences()[0].status).toBe("needs-review");
    expect(charges()[0]).toMatchObject({ runtime_ms: 10, attempts: 1, observed_total_tokens: 0, status: "terminal" });
    expect(reservations()[0]).toMatchObject({ status: "unknown", held: { runtime_ms: 59990, concurrent_reads: 1 }, uncertain_dimensions: ["attempts", "runtime_ms", "concurrent_reads"] });
    const before = readFileSync(ledgerPath); due(30); value.tick("worker", 1); expect(readFileSync(ledgerPath)).toEqual(before);
  });
  it.each(["ledger", "receipt", "occurrence"] as const)("a foreign %s binding cannot debit another subject at completion", async (kind) => {
    definition(); due(); const read = vi.fn(async () => evidence()), actual = actions.executeRoutineAction;
    vi.spyOn(actions, "executeRoutineAction").mockImplementation(async (input, dependencies) => {
      const receipt = await actual(input, dependencies);
      if (kind === "ledger") {
        const ledger = structuredClone(readBudgetLedger(ledgerPath)!), subject = Object.values(ledger.subjects)[0];
        if (subject.kind === "occurrence") subject.routine_id = "foreign-routine";
        writeFileSync(ledgerPath, JSON.stringify(ledger));
      } else if (kind === "receipt") return { ...receipt, occurrence_id: "foreign-occurrence", consumption: { ...receipt.consumption, runtime_ms: 5000 } };
      else {
        const document = structuredClone(readRoutineDocument(path)!), occurrence = Object.values(document.occurrences)[0];
        occurrence.owner!.worker_id = "foreign-worker"; writeFileSync(path, JSON.stringify(document));
      }
      return receipt;
    });
    const value = runner(execution({ read_evidence: read })); value.tick("worker", 1); await value.idle();
    expect(read).toHaveBeenCalledOnce(); expect(charges()[0]).toMatchObject({ runtime_ms: 0, status: "running" }); expect(reservations()[0].status).toBe("unknown");
    expect(occurrences()[0].status).toBe("running"); const ledger = readFileSync(ledgerPath), routine = readFileSync(path);
    value.tick("worker", 1); expect(readFileSync(ledgerPath)).toEqual(ledger); expect(readFileSync(path)).toEqual(routine);
  });
  it("a cancellation raced after the action is not overwritten by settlement", async () => {
    definition(); due(); const actual = actions.executeRoutineAction; let value!: RoutineRunner;
    vi.spyOn(actions, "executeRoutineAction").mockImplementation(async (input, dependencies) => {
      const receipt = await actual(input, dependencies); value.cancel(); return receipt;
    });
    value = runner(); value.tick("worker", 1); await value.idle();
    // The action's equal-timestamp completion preceded the durable stop; both facts survive.
    expect(occurrences()[0].cancel_requested_at).not.toBeNull(); expect(occurrences()[0].status).toBe("completed"); expect(reservations()[0].status).toBe("settled");
  });
  it("intersects selected project constraints and parent runtime without inventing per-project consumption", async () => {
    definition(); due(); const constraints: ExistingBudgetConstraint[] = [800, 400].map((cap, index) => ({ id: `project-${index}`, kind: "project",
      revision: 1, fingerprint: digest, limits: limits({ runtime_ms: cap }) })); policy = source({ runtime_ms: 600 });
    const wiring = execution({ resolve: (_definition, id) => ({ source: policy, constraints, attribution: { company_id: "surtec", project_ids: ["p1", "p2"],
      objective_ids: [], issue_id: null, role_id: null, execution_id: id } }), read_evidence: async () => { now += 50; return evidence(); } });
    const value = runner(wiring); value.tick("worker", 1); await value.idle(); expect(occurrences()[0].budget.admitted_runtime_ms).toBe(400);
    expect(charges()).toMatchObject([{ runtime_ms: 50, attempts: 1, observed_total_tokens: 0 }]); expect(charges()).toHaveLength(1);
  });
  it.each(["fingerprint", "attribution", "scope-overflow", "role", "source-hook", "async-data"] as const)("denies %s policy drift/data before effects without invoking hooks", async (kind) => {
    definition(); due(); const hook = vi.fn(), base = execution();
    const value = runner(execution({ resolve: (d, id) => {
      const result = base.resolve(d, id);
      if (kind === "fingerprint") result.source.fingerprint = "b".repeat(64);
      if (kind === "attribution") result.attribution.execution_id = "borrowed";
      if (kind === "scope-overflow") result.attribution.project_ids = Array.from({ length: 26 }, (_, i) => `p-${i}`);
      if (kind === "role") result.attribution.role_id = "invented";
      if (kind === "source-hook") Object.defineProperty(result, "source", { get: hook, enumerable: true });
      return kind === "async-data" ? Promise.resolve(result) as unknown as RoutineExecutionPolicy : result;
    }, read_evidence: hook })); value.tick("worker", 1); await value.idle(); expect(hook).not.toHaveBeenCalled(); expect(charges()).toEqual([]); expect(existsSync(ledgerPath)).toBe(false);
  });
  it("revalidates consent/policy after every await and before effects", async () => {
    definition("routine-1", { action: "propose-issues" }); due(); let allowed = true;
    const propose = vi.fn(), read = vi.fn(async () => { allowed = false; return evidence(); });
    const value = runner(execution({ assert_current: () => { if (!allowed) throw new RoutineActionError("state-invalid"); }, read_evidence: read, propose_issue: propose }));
    value.tick("worker", 1); await value.idle(); expect(read).toHaveBeenCalledOnce(); expect(propose).not.toHaveBeenCalled(); expect(occurrences()[0].receipt?.failure_code).toBe("state-invalid");
  });
  it.each(["persist", "commit", "claim", "observe", "finish", "settle"] as const)("cross-store %s fault retains holds and never automatically adopts/replays", async (fault) => {
    definition(); due(); const read = vi.fn(async () => evidence());
    const originalBudget = budgetStore.mutateBudgetLedger, originalRoutine = routineStore.mutateRoutineDocument;
    let budgets = 0, routines = 0;
    const budgetFault = { commit: 2, claim: 3, observe: 4, settle: 5 }[fault as "commit" | "claim" | "observe" | "settle"];
    vi.spyOn(budgetStore, "mutateBudgetLedger").mockImplementation((fn, file, at) => {
      if (++budgets === budgetFault) throw new Error("synthetic-private-payload"); return originalBudget(fn, file, at);
    });
    vi.spyOn(routineStore, "mutateRoutineDocument").mockImplementation((fn, file, at) => {
      if (++routines === (fault === "persist" ? 1 : fault === "finish" ? 3 : -1)) throw new Error("synthetic-private-payload"); return originalRoutine(fn, file, at);
    });
    const value = runner(execution({ read_evidence: read })); value.tick("worker", 1); await value.idle();
    expect(read).toHaveBeenCalledTimes(["observe", "finish", "settle"].includes(fault) ? 1 : 0);
    expect(reservations()[0].status).toBe("unknown"); expect(reservations()[0].held.concurrent_reads).toBe(1);
    const bytes = readFileSync(ledgerPath), occurrenceBytes = existsSync(path) ? readFileSync(path) : null;
    value.tick("worker", 1); const restarted = runner(execution({ read_evidence: read })); restarted.tick("restarted", 1); await restarted.idle();
    expect(readFileSync(ledgerPath)).toEqual(bytes); expect(readFileSync(path)).toEqual(occurrenceBytes); expect(charges()).toHaveLength(fault === "persist" || fault === "commit" || fault === "claim" ? 0 : 1);
  });
});
