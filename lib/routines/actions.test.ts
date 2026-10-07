import { existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBudgetPolicy, type BudgetPolicySource } from "../budgets/policy";
import { budgetOccurrenceIntentId, claimOccurrenceBudget, commitOccurrenceBudget, markBudgetUnknown,
  observeBudgetRun, reserveOccurrenceBudget } from "../budgets/reservations";
import { BUDGET_DIMENSIONS, type BudgetAmounts, type BudgetLimits, type BudgetOccurrenceSubject } from "../budgets/types";
import { mutateBudgetLedger } from "../state/budgets";
import { budgetStatePath, routineStatePath } from "../state/paths";
import { assertRoutineOwnership, claimRoutineOccurrence, mutateRoutineDocument, readRoutineDocument,
  revokeRoutineOwnership, updateRoutineTransaction, type RoutineOwnership } from "../state/routines";
import { routineRevisionKey, routineSlotKey } from "./schedule";
import { type RoutineAction, type RoutineOccurrence, type RoutineRecord } from "./types";
import { assertRoutineReceipt, createRoutineDraft, routineProposalKey } from "./validation";
import { assertRoutineActionBudget, assertRoutineSignalFact, executeRoutineAction, RoutineActionEffectError,
  RoutineActionError, routineSignalFingerprint, type RoutineActionDependencies, type RoutineActionEvidence,
  type RoutineIssueProposal, type RoutineSignalFact } from "./actions";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, linkSync: vi.fn(actual.linkSync), unlinkSync: vi.fn(actual.unlinkSync), fsyncSync: vi.fn(actual.fsyncSync) };
});
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); for (const method of [linkSync, unlinkSync, fsyncSync]) vi.mocked(method).mockReset();
  for (const root of roots.splice(0)) {
    expect(dirname(root)).toBe(resolve(tmpdir())); expect(root.startsWith(join(resolve(tmpdir()), "surtec-routine-actions-"))).toBe(true);
    expect(lstatSync(root).isSymbolicLink()).toBe(false); rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false);
  }
});
const at = "2026-10-06T12:00:00.000Z", started = "2026-10-06T12:00:01.000Z", finished = "2026-10-06T12:00:01.005Z", digest = "a".repeat(64);
const amounts = (runtime: number): BudgetAmounts => Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension,
  dimension === "attempts" || dimension === "concurrent_reads" ? 1 : dimension === "runtime_ms" ? runtime : 0])) as BudgetAmounts;
const source: BudgetPolicySource = { fingerprint: digest, policy: { schema_version: 1, revision: 1,
  pricing: { status: "unavailable", reason: "no-versioned-source" }, rules: [{ id: "company-policy", revision: 1,
    scope: { kind: "company", id: "surtec" }, period: "none", warning_percent: 80,
    limits: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: "unconfigured" }])) as BudgetLimits }] } };
function signal(id = "signal-1", projectId = "synthetic"): RoutineSignalFact {
  const projection = { id, project_id: projectId, source: "ci" as const, severity: "warning" as const, observed_at: started };
  return { ...projection, fingerprint: routineSignalFingerprint(projection) };
}
function facts(): RoutineActionEvidence {
  return { sources: [{ kind: "ci", project_id: "synthetic", state: "fresh", observed_at: started, fingerprint: digest }], signals: [signal()] };
}
function fixture(action: RoutineAction = "refresh-evidence", runtime = 60000, budget: "active" | "pending" | "committed" | "absent" = "active") {
  const root = mkdtempSync(join(resolve(tmpdir()), "surtec-routine-actions-")); roots.push(root);
  const state = join(root, "state"); mkdirSync(state, { mode: 0o700 });
  const path = routineStatePath(state), ledgerPath = budgetStatePath(state);
  const draft = createRoutineDraft({ id: "routine-1", action, scope: { kind: "company", id: "surtec" },
    policy: { revision: 1, fingerprint: digest, policy_ids: ["company-policy"] }, at });
  let occurrence!: RoutineOccurrence;
  mutateRoutineDocument((tx) => {
    updateRoutineTransaction(tx, (document) => { document.routines[draft.id] = structuredClone(draft); document.definitions[routineRevisionKey(draft.id, 1)] = structuredClone(draft); });
    updateRoutineTransaction(tx, (document) => {
      const definition: RoutineRecord = { ...structuredClone(draft), revision: 2, enabled: true };
      document.routines[definition.id] = definition; document.definitions[routineRevisionKey(definition.id, 2)] = structuredClone(definition);
      const attribution = { company_id: "surtec" as const, objective_ids: [], project_ids: ["synthetic"], issue_id: null, role_id: null, execution_id: "occurrence-1" };
      const subject: BudgetOccurrenceSubject = { id: "subject-1", kind: "occurrence", occurrence_id: "occurrence-1",
        routine_id: definition.id, routine_revision: definition.revision, slot: at, project_ids: ["synthetic"], attribution };
      const projection = resolveBudgetPolicy({ source, attribution, at, base_caps: amounts(runtime) });
      const budgetReference = { subject_id: subject.id, reservation_id: "reservation-1", intent_id: "pending",
        cap_fingerprint: projection.cap_fingerprint, admitted_runtime_ms: runtime, policy_bindings: projection.policy_bindings };
      budgetReference.intent_id = budgetOccurrenceIntentId({ subject, reservation_id: budgetReference.reservation_id,
        policy_bindings: budgetReference.policy_bindings, cap_fingerprint: budgetReference.cap_fingerprint, runtime_ms: runtime, created_at: at });
      occurrence = { schema_version: 1, id: subject.occurrence_id, revision: 1, routine_id: definition.id,
        routine_revision: definition.revision, occurrence_key: routineSlotKey(definition.id, definition.revision, at), definition,
        slot: at, trigger: "manual", project_ids: ["synthetic"], attribution, budget: budgetReference,
        status: "reserved", owner: null, started_at: null, finished_at: null, cancel_requested_at: null, receipt: null, created_at: at, updated_at: at };
      document.occurrences[occurrence.id] = occurrence;
    });
  }, path, at);
  if (budget !== "absent") {
    const subject: BudgetOccurrenceSubject = { id: occurrence.budget.subject_id, kind: "occurrence", occurrence_id: occurrence.id,
      routine_id: occurrence.routine_id, routine_revision: occurrence.routine_revision, slot: occurrence.slot,
      project_ids: occurrence.project_ids, attribution: occurrence.attribution };
    mutateBudgetLedger((tx) => reserveOccurrenceBudget(tx, { subject, reservation_id: occurrence.budget.reservation_id,
      intent_id: occurrence.budget.intent_id, runtime_ms: runtime, source }), ledgerPath, at);
    if (budget !== "pending") mutateBudgetLedger((tx) => commitOccurrenceBudget(tx, { subject_id: occurrence.budget.subject_id,
      reservation_id: occurrence.budget.reservation_id, intent_id: occurrence.budget.intent_id }), ledgerPath, at);
  }
  const ownership = mutateRoutineDocument((tx) => claimRoutineOccurrence(tx, occurrence.id, 1, "worker-1"), path, started);
  const claimed = assertRoutineOwnership(ownership, path);
  if (budget === "active") mutateBudgetLedger((tx) => claimOccurrenceBudget(tx, {
    reservation_id: occurrence.budget.reservation_id, run_id: claimed.owner!.run_id, source }), ledgerPath, started);
  const current = vi.fn(() => undefined), read = vi.fn(async () => facts()), propose = vi.fn(() => "issue-1"), privacy = vi.fn(() => undefined);
  const dependencies: RoutineActionDependencies = { state_root: state, assert_current: current, read_evidence: read,
    propose_issue: propose, assert_report_privacy: privacy, clock: () => new Date(finished), monotonic: () => 0 };
  return { root, state, path, ledgerPath, ownership, occurrence: claimed, current, read, propose, privacy, dependencies };
}

describe("routine compact signal facts", () => {
  it("hashes only the exact scalar projection and validates its fingerprint", () => {
    const fact = signal(); expect(fact.fingerprint).toHaveLength(64); expect(() => assertRoutineSignalFact(fact)).not.toThrow();
    expect(() => assertRoutineSignalFact({ ...fact, severity: "critical" })).toThrow();
    expect(() => assertRoutineSignalFact({ ...fact, fingerprint: "b".repeat(64) })).toThrow();
  });
  it.each(["title", "reason", "evidence", "instructions", "url", "path", "command", "toJSON"])("rejects extra %s without leaking private data", (field) => {
    expect(() => assertRoutineSignalFact({ ...signal(), [field]: "synthetic-private-payload" })).toThrow(RoutineActionError);
  });
  it.each(["../escape", "a..b", "constructor", "__proto__", "prototype", "x\n", "x".repeat(161)])("rejects unsafe signal ID %j", (id) => {
    expect(() => signal(id)).toThrow();
  });
  it.each(["model", "raw-provider", null, 1])("rejects non-allowlisted source %j", (value) => {
    expect(() => assertRoutineSignalFact({ ...signal(), source: value })).toThrow();
  });
  it("does not invoke a getter, serialization hook or proxy trap", () => {
    const hook = vi.fn(() => "synthetic-private-payload"); const hooked = { ...signal() };
    Object.defineProperty(hooked, "observed_at", { get: hook, enumerable: true });
    expect(() => assertRoutineSignalFact(hooked)).toThrow();
    expect(() => assertRoutineSignalFact(new Proxy(signal(), { get: hook }))).toThrow(); expect(hook).not.toHaveBeenCalled();
  });
  it("does not invoke an inherited array serialization hook during hashing", () => {
    const hook = vi.fn(() => "synthetic-private-payload");
    Object.defineProperty(Array.prototype, "toJSON", { value: hook, configurable: true });
    try { expect(signal().fingerprint).toHaveLength(64); expect(hook).not.toHaveBeenCalled(); }
    finally { Reflect.deleteProperty(Array.prototype, "toJSON"); }
  });
});
describe("four private deterministic routine actions", () => {
  it.each(["refresh-evidence", "evaluate-signals", "propose-issues", "generate-local-report"] as const)("executes %s with known zero model/write resources", async (action) => {
    const setup = fixture(action), result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    assertRoutineReceipt(result); expect(result.freshness).toBe("fresh"); expect(result.failure_code).toBeNull();
    expect(result.consumption).toEqual({ attempts: 1, runtime_ms: 5, runtime_state: "complete", model_calls: 0, total_tokens: 0, workspace_writes: 0 });
    expect(result.counts.signals_evaluated).toBe(["evaluate-signals", "propose-issues"].includes(action) ? 1 : 0);
    expect(result.counts.proposals_created).toBe(action === "propose-issues" ? 1 : 0);
    expect(result.counts.reports_written).toBe(action === "generate-local-report" ? 1 : 0);
    expect(setup.propose).toHaveBeenCalledTimes(action === "propose-issues" ? 1 : 0);
    expect(result.next_action).toBe(action === "propose-issues" ? "review-proposals" : "none");
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.sources[0])).toBe(true);
    expect(readRoutineDocument(setup.path)!.occurrences["occurrence-1"]!.status).toBe("running"); // T011 settles/persists, not this slice.
  });
  it("does not adopt persisted inventory, copied, forged or revoked ownership", async () => {
    const setup = fixture();
    for (const proof of [{}, { ...setup.ownership }, setup.occurrence.owner]) {
      await expect(executeRoutineAction({ ownership: proof as RoutineOwnership }, setup.dependencies)).rejects.toMatchObject({ code: "ownership-unavailable" });
    }
    revokeRoutineOwnership(setup.ownership);
    await expect(executeRoutineAction({ ownership: setup.ownership }, setup.dependencies)).rejects.toMatchObject({ code: "ownership-unavailable" });
    expect(setup.read).not.toHaveBeenCalled(); expect(setup.propose).not.toHaveBeenCalled(); expect(existsSync(join(setup.state, "reports"))).toBe(false);
  });
  it.each(["absent", "pending", "committed"] as const)("refuses %s accounting before provider or mutation effects", async (budget) => {
    const setup = fixture("propose-issues", 60000, budget), result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    expect(result).toMatchObject({ failure_code: "accounting-unavailable", budget_outcome: "unknown", counts: { proposals_created: 0 }, consumption: { attempts: 1 } });
    expect(setup.read).not.toHaveBeenCalled(); expect(setup.propose).not.toHaveBeenCalled(); expect(existsSync(join(setup.state, "reports"))).toBe(false);
  });
  it("requires the independent current gate after real store/accounting proofs", async () => {
    const setup = fixture("propose-issues"); setup.current.mockImplementation(() => { throw new Error("synthetic-private-payload"); });
    const result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    expect(result.failure_code).toBe("state-invalid"); expect(JSON.stringify(result)).not.toContain("synthetic-private-payload");
    expect(setup.read).not.toHaveBeenCalled(); expect(setup.propose).not.toHaveBeenCalled();
  });
  it("refuses asynchronous current gates before invoking them", async () => {
    const setup = fixture(), invoked = vi.fn(); const gate = async () => { invoked(); };
    const result = await executeRoutineAction({ ownership: setup.ownership }, { ...setup.dependencies, assert_current: gate });
    expect(result.failure_code).toBe("state-invalid"); expect(invoked).not.toHaveBeenCalled(); expect(setup.read).not.toHaveBeenCalled();
  });
  it("rejects a thenable gate without invoking its then getter", async () => {
    const setup = fixture(), hook = vi.fn();
    const result = await executeRoutineAction({ ownership: setup.ownership }, { ...setup.dependencies,
      assert_current: () => ({ get then() { hook(); return hook; } }) as never });
    expect(result.failure_code).toBe("state-invalid"); expect(hook).not.toHaveBeenCalled(); expect(setup.read).not.toHaveBeenCalled();
  });
  it("consumes the process-private action attempt once, including after source failure", async () => {
    const setup = fixture(); setup.read.mockRejectedValue(new Error("synthetic-private-payload"));
    const result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies); expect(result.failure_code).toBe("action-failed");
    await expect(executeRoutineAction({ ownership: setup.ownership }, setup.dependencies)).rejects.toMatchObject({ code: "ownership-unavailable" });
    expect(setup.read).toHaveBeenCalledTimes(1);
  });
  it("denies current cancellation/configuration drift before and after asynchronous evidence", async () => {
    const setup = fixture("propose-issues");
    setup.read.mockImplementation(async () => {
      mutateRoutineDocument((tx) => updateRoutineTransaction(tx, (document) => {
        const original = document.routines["routine-1"]!, changed = { ...original, enabled: false, revision: original.revision + 1, updated_at: finished };
        document.routines[changed.id] = changed; document.definitions[routineRevisionKey(changed.id, changed.revision)] = changed;
      }), setup.path, finished); return facts();
    });
    const result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    expect(result.failure_code).toBe("ownership-unavailable"); expect(setup.propose).not.toHaveBeenCalled();
  });
  it("denies budget uncertainty observed during evidence without refunds or effects", async () => {
    const setup = fixture("propose-issues");
    setup.read.mockImplementation(async () => { mutateBudgetLedger((tx) => markBudgetUnknown(tx, { reservation_id: "reservation-1" }), setup.ledgerPath, finished); return facts(); });
    const result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    expect(result.failure_code).toBe("accounting-unavailable"); expect(setup.propose).not.toHaveBeenCalled();
  });
  it("flags observed actual runtime excess instead of clipping it to the admitted cap", async () => {
    const setup = fixture("propose-issues", 10); let time = 5;
    setup.read.mockImplementation(async () => { time = 20; return facts(); });
    const result = await executeRoutineAction({ ownership: setup.ownership }, { ...setup.dependencies, clock: () => new Date(Date.parse(started) + time) });
    expect(result).toMatchObject({ failure_code: "deadline-exceeded", budget_outcome: "exhausted", consumption: { runtime_ms: 20 } });
    expect(setup.propose).not.toHaveBeenCalled();
  });
  it("checks deadline and cancellation again after the synchronous current gate", async () => {
    const setup = fixture("propose-issues", 10); let time = 5;
    setup.current.mockImplementation(() => { time = 15; });
    const result = await executeRoutineAction({ ownership: setup.ownership }, { ...setup.dependencies,
      clock: () => new Date(Date.parse(started) + time) });
    expect(result.failure_code).toBe("deadline-exceeded"); expect(setup.read).not.toHaveBeenCalled(); expect(setup.propose).not.toHaveBeenCalled();
  });
  it("denies an already requested AbortSignal before provider effects", async () => {
    const setup = fixture("propose-issues"), cancellation = new AbortController(); cancellation.abort();
    const result = await executeRoutineAction({ ownership: setup.ownership, signal: cancellation.signal }, setup.dependencies);
    expect(result.failure_code).toBe("cancelled"); expect(setup.read).not.toHaveBeenCalled(); expect(setup.propose).not.toHaveBeenCalled();
  });
  it("keeps the event loop responsive and returns at a deadline even when a fake provider never resolves", async () => {
    const setup = fixture("propose-issues", 30); const ticks = vi.fn();
    setup.read.mockImplementation(() => new Promise(() => undefined)); const heartbeat = setInterval(ticks, 2);
    try {
      const result = await executeRoutineAction({ ownership: setup.ownership }, { ...setup.dependencies, clock: () => new Date(started) });
      expect(result.failure_code).toBe("deadline-exceeded"); expect(result.budget_outcome).toBe("exhausted"); expect(ticks.mock.calls.length).toBeGreaterThan(0);
      expect(setup.propose).not.toHaveBeenCalled();
    } finally { clearInterval(heartbeat); }
  });
  it("cancels a fake slow read and fences its late callbacks without proposing", async () => {
    const setup = fixture("propose-issues"), cancellation = new AbortController(); let checked: (() => void) | undefined;
    setup.dependencies.read_evidence = async (_occurrence, options) => { checked = options.check; return new Promise(() => undefined); };
    const running = executeRoutineAction({ ownership: setup.ownership, signal: cancellation.signal }, setup.dependencies);
    cancellation.abort(); const result = await running;
    expect(result.failure_code).toBe("cancelled"); expect(() => checked!()).toThrow(RoutineActionError); expect(setup.propose).not.toHaveBeenCalled();
  });
});
describe("closed evidence and bounded proposals", () => {
  it.each([
    () => ({ ...facts(), raw: "synthetic-private-payload" }),
    () => ({ ...facts(), sources: [{ ...facts().sources[0], notes: "synthetic-private-payload" }] }),
    () => ({ ...facts(), sources: [{ ...facts().sources[0], project_id: "foreign" }] }),
    () => ({ ...facts(), sources: [{ ...facts().sources[0], observed_at: "2026-10-07T12:00:00Z" }] }),
    () => ({ ...facts(), sources: [facts().sources[0], facts().sources[0]] }),
    () => ({ ...facts(), signals: [signal("signal-1", "foreign")] }),
    () => ({ ...facts(), signals: [signal(), signal()] }),
    () => ({ ...facts(), signals: [{ ...signal(), fingerprint: digest }] }),
    () => ({ ...facts(), signals: Array.from({ length: 5001 }, (_, index) => signal(`signal-${index}`)) }),
  ])("refuses malformed/private/foreign facts without mutation", async (create) => {
    const setup = fixture("propose-issues"); setup.dependencies.read_evidence = async () => create();
    const result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    expect(result.failure_code).not.toBeNull(); expect(result.freshness).toBe("unavailable"); expect(setup.propose).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("synthetic-private-payload");
  });
  it("keeps optional unavailable sources visible instead of inventing fresh evidence", async () => {
    const setup = fixture(); setup.read.mockResolvedValue({ sources: [...facts().sources,
      { kind: "dependencies", project_id: "synthetic", state: "unavailable", observed_at: null, fingerprint: null }], signals: [] });
    const result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    expect(result).toMatchObject({ freshness: "partial", failure_code: "source-unavailable", counts: { facts_total: 2, facts_fresh: 1, facts_unavailable: 1 } });
  });
  it("orders safe signals, derives exact occurrence-specific keys and requires review of retained proposals", async () => {
    const setup = fixture("propose-issues"), observed: RoutineIssueProposal[] = [];
    setup.read.mockResolvedValue({ ...facts(), signals: [signal("signal-z"), signal("signal-a")] });
    setup.dependencies.propose_issue = (proposal, check) => { check(); observed.push(proposal); return `issue-${observed.length}`; };
    const result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    expect(observed.map((proposal) => proposal.signal.id)).toEqual(["signal-a", "signal-z"]);
    expect(result.proposals).toEqual(observed.map((proposal, index) => ({ key: routineProposalKey(setup.occurrence.occurrence_key, proposal.signal.fingerprint),
      fingerprint: proposal.signal.fingerprint, issue_id: `issue-${index + 1}` })));
    expect(result.next_action).toBe("review-proposals");
  });
  it("fences each proposal independently after the prior effect changes current policy", async () => {
    const setup = fixture("propose-issues"); let changed = false;
    setup.read.mockResolvedValue({ ...facts(), signals: [signal("signal-a"), signal("signal-b")] });
    setup.current.mockImplementation(() => { if (changed) throw new RoutineActionError("state-invalid"); });
    setup.propose.mockImplementation(() => { changed = true; return "issue-1"; });
    const result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    expect(setup.propose).toHaveBeenCalledTimes(1); expect(result.counts.proposals_created).toBe(1);
    expect(result).toMatchObject({ freshness: "partial", failure_code: "state-invalid", next_action: "review-proposals" });
  });
  it.each([false, true])("retains the pending key and independently proven creation through an ambiguous gap (proved=%s)", async (proved) => {
    const setup = fixture("propose-issues");
    setup.dependencies.propose_issue = (proposal) => { throw new RoutineActionEffectError(proved
      ? { key: proposal.key, fingerprint: proposal.fingerprint, issue_id: "issue-1" } : undefined); };
    const result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    expect(result).toMatchObject({ failure_code: "accounting-unavailable", budget_outcome: "unknown", counts: { proposals_created: proved ? 1 : 0 } });
    expect(result.proposals[0]).toEqual({ key: routineProposalKey(setup.occurrence.occurrence_key, signal().fingerprint), fingerprint: signal().fingerprint,
      issue_id: proved ? "issue-1" : null }); expect(result.next_action).toBe(proved ? "review-proposals" : "inspect-budget");
  });
  it("does not adopt a foreign creation from an ambiguous effect error", async () => {
    const setup = fixture("propose-issues"); setup.dependencies.propose_issue = () => { throw new RoutineActionEffectError({ key: digest, fingerprint: digest, issue_id: "foreign-issue" }); };
    const result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    expect(result.counts.proposals_created).toBe(0); expect(result.budget_outcome).toBe("unknown"); expect(result.proposals[0]!.issue_id).toBeNull();
  });
});
describe("private code-owned routine report boundary", () => {
  it("publishes only compact metadata at a fixed safe filename and leaves no owned staging file", async () => {
    const setup = fixture("generate-local-report"), result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    expect(result.counts.reports_written).toBe(1); const directory = join(setup.state, "reports", "routines");
    expect(readdirSync(directory)).toEqual(["occurrence-1.json"]); expect(lstatSync(join(directory, "occurrence-1.json")).nlink).toBe(1);
    const report = JSON.parse(readFileSync(join(directory, "occurrence-1.json"), "utf8"));
    expect(report.sources).toEqual(facts().sources); expect(report).not.toHaveProperty("consumption"); expect(report).not.toHaveProperty("finished_at");
    for (const field of ["signals", "title", "reason", "instructions", "url", "path", "credentials"]) expect(report).not.toHaveProperty(field);
    expect(setup.privacy).toHaveBeenCalledWith(setup.state);
    if (process.platform !== "win32") { expect(lstatSync(directory).mode & 0o077).toBe(0); expect(lstatSync(join(directory, "occurrence-1.json")).mode & 0o077).toBe(0); }
  });
  it("requires an explicit trusted privacy assertion before making report directories", async () => {
    const setup = fixture("generate-local-report"); const { assert_report_privacy: _privacy, ...dependencies } = setup.dependencies;
    const result = await executeRoutineAction({ ownership: setup.ownership }, dependencies);
    expect(result.failure_code).toBe("source-unavailable"); expect(result.counts.reports_written).toBe(0); expect(existsSync(join(setup.state, "reports"))).toBe(false);
  });
  it("preserves a privacy denial and does not serialize its private error", async () => {
    const setup = fixture("generate-local-report"); setup.privacy.mockImplementation(() => { throw new Error("synthetic-private-payload"); });
    const result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    expect(result.counts.reports_written).toBe(0); expect(existsSync(join(setup.state, "reports"))).toBe(false); expect(JSON.stringify(result)).not.toContain("synthetic-private-payload");
  });
  it("accepts existing private directories but never overwrites an existing report", async () => {
    const setup = fixture("generate-local-report"), directory = join(setup.state, "reports", "routines");
    mkdirSync(join(setup.state, "reports"), { mode: 0o700 }); mkdirSync(directory, { mode: 0o700 });
    const destination = join(directory, "occurrence-1.json"), bytes = "synthetic-user-owned-report\n"; writeFileSync(destination, bytes, { mode: 0o600 });
    const result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    expect(result.counts.reports_written).toBe(0); expect(result.failure_code).toBe("source-unavailable"); expect(readFileSync(destination, "utf8")).toBe(bytes);
    expect(readdirSync(directory)).toEqual(["occurrence-1.json"]);
  });
  it("refuses a report-directory junction and preserves the external target", async () => {
    const setup = fixture("generate-local-report"), external = join(setup.root, "external"); mkdirSync(external, { mode: 0o700 });
    symlinkSync(external, join(setup.state, "reports"), process.platform === "win32" ? "junction" : "dir");
    const result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    expect(result.counts.reports_written).toBe(0); expect(readdirSync(external)).toEqual([]);
  });
  it("does not overwrite or unlink a hard-linked report target", async () => {
    const setup = fixture("generate-local-report"), directory = join(setup.state, "reports", "routines");
    mkdirSync(join(setup.state, "reports"), { mode: 0o700 }); mkdirSync(directory, { mode: 0o700 });
    const target = join(setup.root, "target.json"); writeFileSync(target, "synthetic-user-owned-data", { mode: 0o600 });
    const destination = join(directory, "occurrence-1.json"); linkSync(target, destination);
    const result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    expect(result.counts.reports_written).toBe(0); expect(readFileSync(target, "utf8")).toBe("synthetic-user-owned-data"); expect(lstatSync(destination).nlink).toBe(2);
  });
  it("keeps an actually written report visible in the receipt when the final current gate refuses completion", async () => {
    const setup = fixture("generate-local-report");
    setup.dependencies.assert_current = (_occurrence, boundary) => { if (boundary === "complete") throw new RoutineActionError("state-invalid"); };
    const result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    expect(result).toMatchObject({ freshness: "partial", failure_code: "state-invalid", counts: { reports_written: 1 } });
    expect(existsSync(join(setup.state, "reports", "routines", "occurrence-1.json"))).toBe(true);
  });
  it("retains a report actually published before an injected link failure without claiming rollback", async () => {
    const setup = fixture("generate-local-report"), actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(linkSync).mockImplementation((existing, path) => { actual.linkSync(existing, path); throw new Error("synthetic-private-payload"); });
    const result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    expect(result).toMatchObject({ failure_code: "accounting-unavailable", budget_outcome: "unknown", counts: { reports_written: 1 } });
    expect(result.freshness).toBe("partial"); expect(JSON.stringify(result)).not.toContain("synthetic-private-payload");
    const directory = join(setup.state, "reports", "routines"); expect(readdirSync(directory)).toEqual(["occurrence-1.json"]);
    expect(lstatSync(join(directory, "occurrence-1.json")).nlink).toBe(1);
  });
  it("preserves a known published report and the owned stage if unlink cleanup is unavailable", async () => {
    const setup = fixture("generate-local-report"), actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(unlinkSync).mockImplementation((path) => {
      if (String(path).includes(`${join("reports", "routines")}`) && String(path).endsWith(".tmp")) throw new Error("synthetic cleanup unavailable");
      actual.unlinkSync(path);
    });
    const result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    expect(result).toMatchObject({ failure_code: "accounting-unavailable", budget_outcome: "unknown", counts: { reports_written: 1 } });
    const directory = join(setup.state, "reports", "routines"); expect(readdirSync(directory)).toHaveLength(2);
    expect(lstatSync(join(directory, "occurrence-1.json")).nlink).toBe(2); expect(result.freshness).not.toBe("fresh");
  });
  it("cleans only its owned stage and retains zero proven report count on prepublication fsync failure", async () => {
    const setup = fixture("generate-local-report"); vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error("synthetic-private-payload"); });
    const result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    expect(result.counts.reports_written).toBe(0); expect(result.failure_code).toBe("source-unavailable");
    expect(readdirSync(join(setup.state, "reports", "routines"))).toEqual([]); expect(JSON.stringify(result)).not.toContain("synthetic-private-payload");
  });
  it("treats an ambiguous unavailable exclusive publication as unknown rather than refunded success", async () => {
    const setup = fixture("generate-local-report"); vi.mocked(linkSync).mockImplementationOnce(() => { throw new Error("synthetic publication unavailable"); });
    const result = await executeRoutineAction({ ownership: setup.ownership }, setup.dependencies);
    expect(result).toMatchObject({ failure_code: "accounting-unavailable", budget_outcome: "unknown", counts: { reports_written: 0 } });
    expect(readdirSync(join(setup.state, "reports", "routines"))).toEqual([]);
  });
  it("does not accept caller destination, command or URL fields", async () => {
    const setup = fixture("generate-local-report");
    for (const field of ["destination", "command", "url", "path", "model"]) {
      await expect(executeRoutineAction({ ownership: setup.ownership, [field]: "synthetic-untrusted" } as never, setup.dependencies)).rejects.toThrow();
    }
    expect(setup.read).not.toHaveBeenCalled(); expect(existsSync(join(setup.state, "reports"))).toBe(false);
  });
  it("denies a broad root alias without reading user state or creating report paths", async () => {
    const setup = fixture("generate-local-report");
    expect(parse(setup.state).root).not.toBe(setup.state);
    await expect(executeRoutineAction({ ownership: setup.ownership }, { ...setup.dependencies, state_root: parse(setup.state).root })).rejects.toMatchObject({ code: "ownership-unavailable" });
    expect(setup.read).not.toHaveBeenCalled();
  });
});
describe("real occurrence accounting evidence", () => {
  it("reads a committed privately claimed occurrence without allocating, settling or changing bytes", () => {
    const setup = fixture(), routineBytes = readFileSync(setup.path), budgetBytes = readFileSync(setup.ledgerPath);
    expect(() => assertRoutineActionBudget(setup.occurrence, setup.state)).not.toThrow();
    expect(readFileSync(setup.path).equals(routineBytes)).toBe(true); expect(readFileSync(setup.ledgerPath).equals(budgetBytes)).toBe(true);
  });
  it("does not treat a budget terminal charge or missing document as current execution authority", () => {
    const setup = fixture(); mutateBudgetLedger((tx) => observeBudgetRun(tx, { reservation_id: "reservation-1", run_id: setup.occurrence.owner!.run_id,
      runtime_ms: 5, total_tokens: 0, terminal: true }), setup.ledgerPath, finished);
    expect(() => assertRoutineActionBudget(setup.occurrence, setup.state)).toThrow(RoutineActionError);
    unlinkSync(setup.ledgerPath); expect(() => assertRoutineActionBudget(setup.occurrence, setup.state)).toThrow(RoutineActionError);
  });
  it("retains an exhausted observed charge and does not reinterpret it as zero", () => {
    const setup = fixture("refresh-evidence", 10); mutateBudgetLedger((tx) => observeBudgetRun(tx, { reservation_id: "reservation-1",
      run_id: setup.occurrence.owner!.run_id, runtime_ms: 11, total_tokens: 0, terminal: false }), setup.ledgerPath, finished);
    expect(() => assertRoutineActionBudget(setup.occurrence, setup.state)).toThrow(expect.objectContaining({ code: "budget-exhausted" }));
  });
});
