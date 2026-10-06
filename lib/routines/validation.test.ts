import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BUDGET_DIMENSIONS, type BudgetLimits, type BudgetOccurrenceSubject, type BudgetPolicyBinding } from "../budgets/types";
import { budgetOccurrenceIntentId } from "../budgets/reservations";
import { ROUTINE_ACTIONS, ROUTINE_LIMITS, type RoutineAction, type RoutineDocument, type RoutineOccurrence, type RoutineReceipt, type RoutineRecord, type RoutineScope } from "./types";
import { routineRevisionKey, routineSlotKey } from "./schedule";
import { assertRoutineDocument, assertRoutineOccurrence, assertRoutineReceipt, assertRoutineRecord, createRoutineDraft, routineProposalKey, RoutineContractError } from "./validation";

// Inert synthetic shapes only: no normal state, provider calls, persistence,
// issued approvals, task envelopes, controller proofs or execution authority.
const at = "2026-10-06T12:00:00Z";
const finished = "2026-10-06T12:00:01Z";
const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const scopes: RoutineScope[] = [{ kind: "company", id: "surtec" }, { kind: "objective", id: "objective-1" }, { kind: "project", id: "synthetic" }];
const binding = (): BudgetPolicyBinding => ({ policy_id: "policy-company", policy_revision: 1, policy_fingerprint: digest,
  scope: { kind: "company", id: "surtec" }, period: "none", bucket: "none",
  limits: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: "unconfigured" }])) as BudgetLimits });
function record(action: RoutineAction = "refresh-evidence", scope: RoutineScope = scopes[0]!): RoutineRecord {
  return { schema_version: 1, id: "routine-1", revision: 1, action, scope: structuredClone(scope), enabled: true,
    schedule: null, schedule_anchor_at: null, concurrency: "skip", catch_up: "skip-missed",
    policy: { revision: 1, fingerprint: digest, policy_ids: ["policy-company"] },
    limits: { max_projects: 25, max_attempts: 1, max_runtime_ms: 60000, max_concurrent_occurrences: 1 }, created_at: at, updated_at: at };
}
function rebindBudget(value: RoutineOccurrence): void {
  const subject: BudgetOccurrenceSubject = { id: value.budget.subject_id, kind: "occurrence", occurrence_id: value.id,
    routine_id: value.routine_id, routine_revision: value.routine_revision, slot: value.slot,
    project_ids: structuredClone(value.project_ids), attribution: structuredClone(value.attribution) };
  value.budget.intent_id = budgetOccurrenceIntentId({ subject, reservation_id: value.budget.reservation_id,
    policy_bindings: value.budget.policy_bindings, cap_fingerprint: value.budget.cap_fingerprint,
    runtime_ms: value.budget.admitted_runtime_ms, created_at: value.created_at });
}
function occurrence(definition = record(), id = "occurrence-1", slot = at): RoutineOccurrence {
  const value: RoutineOccurrence = { schema_version: 1, id, revision: 1, routine_id: definition.id,
    routine_revision: definition.revision, occurrence_key: routineSlotKey(definition.id, definition.revision, slot),
    definition: structuredClone(definition), slot, trigger: "manual", project_ids: ["synthetic"],
    attribution: { company_id: "surtec", objective_ids: definition.scope.kind === "objective" ? [definition.scope.id] : [],
      project_ids: ["synthetic"], issue_id: null, role_id: null, execution_id: id },
    budget: { subject_id: `subject-${id}`, reservation_id: `reservation-${id}`, intent_id: "intent-placeholder",
      cap_fingerprint: digest, admitted_runtime_ms: 60000, policy_bindings: [binding()] },
    status: "reserved", owner: null, started_at: null, finished_at: null, cancel_requested_at: null,
    receipt: null, created_at: slot, updated_at: slot };
  rebindBudget(value); return value;
}
function receipt(value = occurrence()): RoutineReceipt {
  const start = value.started_at ?? value.created_at, end = new Date(Date.parse(start) + 1000).toISOString();
  return { schema_version: 1, occurrence_id: value.id, occurrence_key: value.occurrence_key, routine_id: value.routine_id,
    routine_revision: value.routine_revision, slot: value.slot, action: value.definition.action, scope: structuredClone(value.definition.scope),
    policy_fingerprint: value.definition.policy.fingerprint, cap_fingerprint: value.budget.cap_fingerprint,
    project_ids: structuredClone(value.project_ids), started_at: start, finished_at: end, captured_at: end,
    freshness: "fresh", sources: [{ kind: "git", project_id: "synthetic", state: "fresh", observed_at: start, fingerprint: digest }],
    counts: { projects_selected: 1, facts_total: 1, facts_fresh: 1, facts_unavailable: 0, signals_evaluated: 0, proposals_created: 0,
      reports_written: value.definition.action === "generate-local-report" ? 1 : 0 },
    consumption: { attempts: 1, runtime_ms: 1000, runtime_state: "complete", model_calls: 0, total_tokens: 0, workspace_writes: 0 },
    budget_outcome: "within-limit", proposals: [], failure_code: null, next_action: "none" };
}
function terminal(definition = record(), id = "occurrence-1", slot = at): RoutineOccurrence {
  const value = occurrence(definition, id, slot); value.status = "completed"; value.started_at = value.created_at;
  value.receipt = receipt(value); value.finished_at = value.receipt.finished_at; value.updated_at = value.receipt.captured_at; return value;
}
function deniedOccurrence(definition = record()): RoutineOccurrence {
  const value = terminal(definition); value.status = "failed"; value.started_at = null;
  const proof = value.receipt!; proof.started_at = null; proof.consumption.attempts = 0; proof.consumption.runtime_ms = 0;
  proof.freshness = "unavailable"; proof.budget_outcome = "denied"; proof.failure_code = "budget-denied"; proof.next_action = "inspect-budget";
  proof.counts.signals_evaluated = proof.counts.proposals_created = proof.counts.reports_written = 0;
  proof.proposals = []; return value;
}
function document(values: RoutineOccurrence[] = [terminal()]): RoutineDocument {
  const definition = values[0]?.definition ?? record();
  const updated = values.reduce((latest, value) => Date.parse(value.updated_at) > Date.parse(latest) ? value.updated_at : latest, finished);
  return { schema_version: 1, revision: 1, created_at: at, updated_at: updated,
    routines: { [definition.id]: structuredClone(definition) },
    definitions: { [routineRevisionKey(definition.id, definition.revision)]: structuredClone(definition) },
    occurrences: Object.fromEntries(values.map((value) => [value.id, value])),
    cursors: { [routineRevisionKey(definition.id, definition.revision)]: { schema_version: 1, routine_id: definition.id,
      routine_revision: definition.revision, evaluated_at: updated, last_slot: null, pending_slot: null } } };
}
function put(value: unknown, path: string[], replacement: unknown): void {
  const parent = path.slice(0, -1).reduce<unknown>((current, key) => (current as Record<string, unknown>)[key], value) as Record<string, unknown>;
  parent[path.at(-1)!] = replacement;
}
function omit(value: unknown, path: string[]): void {
  const parent = path.slice(0, -1).reduce<unknown>((current, key) => (current as Record<string, unknown>)[key], value) as Record<string, unknown>;
  delete parent[path.at(-1)!];
}
function rejected(value: unknown, assert: (value: unknown) => void): void {
  const before = structuredClone(value); expect(() => assert(value)).toThrow(RoutineContractError); expect(value).toEqual(before);
}
const contracts: Array<{ name: string; fixture: () => object; assert: (value: unknown) => void }> = [
  { name: "record", fixture: record, assert: assertRoutineRecord },
  { name: "occurrence", fixture: occurrence, assert: assertRoutineOccurrence },
  { name: "receipt", fixture: receipt, assert: assertRoutineReceipt },
  { name: "document", fixture: document, assert: assertRoutineDocument },
];

describe("T008 strict versioned routine contracts", () => {
  for (const contract of contracts) describe(contract.name, () => {
    it("accepts an explicit synthetic shape without modifying its bytes", () => {
      const value = contract.fixture(), bytes = JSON.stringify(value); contract.assert(value); expect(JSON.stringify(value)).toBe(bytes);
    });
    it.each([null, undefined, true, 1, "1", []])("rejects non-record input %j", (value) => rejected(value, contract.assert));
    it.each([0, 2, 987, "1", null])("rejects unsupported/coerced version %j", (version) => {
      const value = contract.fixture(); put(value, ["schema_version"], version); rejected(value, contract.assert);
    });
    it("requires an explicit version and refuses unknown authority metadata", () => {
      const missing = contract.fixture(); omit(missing, ["schema_version"]); rejected(missing, contract.assert);
      const extra = contract.fixture(); put(extra, ["execution_authority"], true); rejected(extra, contract.assert);
    });
    it("preserves malformed future JSON bytes rather than migrating or repairing", () => {
      const source = JSON.stringify({ ...contract.fixture(), schema_version: 987 }, null, 2), value: unknown = JSON.parse(source);
      expect(() => contract.assert(value)).toThrow(RoutineContractError); expect(JSON.stringify(value, null, 2)).toBe(source);
    });
    it("rejects inherited fields, custom prototypes, hidden fields, symbols and serialization hooks", () => {
      expect(() => contract.assert(Object.create(contract.fixture()))).toThrow(RoutineContractError);
      const custom = contract.fixture(); Object.setPrototypeOf(custom, { inherited: true }); expect(() => contract.assert(custom)).toThrow(RoutineContractError);
      const hidden = contract.fixture(); Object.defineProperty(hidden, "hidden", { value: true }); expect(() => contract.assert(hidden)).toThrow(RoutineContractError);
      const symbol = contract.fixture(); Object.defineProperty(symbol, Symbol("synthetic"), { value: true }); expect(() => contract.assert(symbol)).toThrow(RoutineContractError);
      const hooked = contract.fixture(), hook = vi.fn(() => contract.fixture()); Object.defineProperty(hooked, "toJSON", { value: hook });
      expect(() => contract.assert(hooked)).toThrow(RoutineContractError); expect(hook).not.toHaveBeenCalled();
    });
    it("refuses accessors and proxies without invoking user-controlled code", () => {
      const accessed = contract.fixture(), getter = vi.fn(() => 1); Object.defineProperty(accessed, "schema_version", { enumerable: true, get: getter });
      expect(() => contract.assert(accessed)).toThrow(RoutineContractError); expect(getter).not.toHaveBeenCalled();
      const trap = vi.fn(() => { throw new Error("synthetic trap should not run"); });
      expect(() => contract.assert(new Proxy(contract.fixture(), { get: trap, ownKeys: trap, getPrototypeOf: trap }))).toThrow(RoutineContractError);
      expect(trap).not.toHaveBeenCalled();
    });
  });
});

describe("T008 finite definition allowlist and safe defaults", () => {
  for (const action of ROUTINE_ACTIONS) for (const scope of scopes) it.each([null, "every:15m", "every:10080m"])(
    `accepts ${action} for ${scope.kind} with schedule %s`, (schedule) => {
      const value = record(action, scope); value.schedule = schedule; value.schedule_anchor_at = schedule === null ? null : at;
      const bytes = JSON.stringify(value); assertRoutineRecord(value); expect(JSON.stringify(value)).toBe(bytes);
    });
  it("creates a detached deeply frozen disabled manual draft with reviewed finite limits", () => {
    const policy = record().policy, scope: RoutineScope = { kind: "project", id: "synthetic" };
    const value = createRoutineDraft({ id: "routine-new", action: "refresh-evidence", scope, policy, at });
    expect(value).toEqual({ ...record("refresh-evidence", scope), id: "routine-new", enabled: false });
    expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.scope)).toBe(true);
    expect(Object.isFrozen(value.policy.policy_ids)).toBe(true); expect(Object.isFrozen(value.limits)).toBe(true);
    policy.policy_ids.push("policy-later"); scope.id = "other-project";
    expect(value.scope.id).toBe("synthetic"); expect(value.policy.policy_ids).toEqual(["policy-company"]); assertRoutineRecord(value);
  });
  it("refuses forged draft metadata and descriptor hooks before copying without invoking them", () => {
    const input = { id: "routine-new", action: "refresh-evidence" as const, scope: scopes[0]!, policy: record().policy, at };
    const forged = { ...input, enabled: true }; expect(() => createRoutineDraft(forged)).toThrow(RoutineContractError);
    const accessed = structuredClone(input), getter = vi.fn(() => "routine-new");
    Object.defineProperty(accessed, "id", { enumerable: true, get: getter }); expect(() => createRoutineDraft(accessed)).toThrow(RoutineContractError);
    expect(getter).not.toHaveBeenCalled();
    const trap = vi.fn(() => { throw new Error("synthetic draft trap should not run"); });
    expect(() => createRoutineDraft(new Proxy(input, { get: trap, ownKeys: trap, getPrototypeOf: trap }))).toThrow(RoutineContractError);
    expect(trap).not.toHaveBeenCalled();
  });
  it.each(["run-command", "publish", "implement", "objective-update", "model-call", "refresh-evidence "])("rejects action %s", (action) => {
    const value = record(); put(value, ["action"], action); rejected(value, assertRoutineRecord);
  });
  it.each(["command", "url", "path", "destination", "prompt", "adapter", "model", "credentials"])("rejects caller-defined %s in definitions", (field) => {
    const value = record(); put(value, [field], "synthetic-private-not-stored"); rejected(value, assertRoutineRecord);
  });
  it.each(["role", "issue", "execution", "tenant", "company "])("refuses scope kind %s", (kind) => {
    const value = record(); put(value, ["scope"], { kind, id: "synthetic" }); rejected(value, assertRoutineRecord);
  });
  it("refuses another company and an unsupported field inside otherwise valid scope", () => {
    const other = record(); put(other, ["scope"], { kind: "company", id: "other" }); rejected(other, assertRoutineRecord);
    const extra = record(); put(extra, ["scope", "authority"], true); rejected(extra, assertRoutineRecord);
  });
  it.each(["", "every:0m", "every:14m", "every:10081m", "every:15.5m", "every:015m", "every:+15m", "every:15h", "*/15 * * * *", " every:15m", "every:15m\n"])(
    "rejects non-canonical or unsupported schedule %j", (schedule) => { const value = record(); value.schedule = schedule; value.schedule_anchor_at = at; rejected(value, assertRoutineRecord); });
  it("requires an interval anchor and forbids an anchor for manual-only definitions", () => {
    const noAnchor = record(); noAnchor.schedule = "every:15m"; rejected(noAnchor, assertRoutineRecord);
    const manualAnchor = record(); manualAnchor.schedule_anchor_at = at; rejected(manualAnchor, assertRoutineRecord);
  });
  it.each(["parallel", "replace", "unbounded", null])("rejects concurrency %j", (concurrency) => {
    const value = record(); put(value, ["concurrency"], concurrency); rejected(value, assertRoutineRecord);
  });
  it.each(["replay-all", "forever", "run-once ", null])("rejects catch-up %j", (catchUp) => {
    const value = record(); put(value, ["catch_up"], catchUp); rejected(value, assertRoutineRecord);
  });
  it("accepts explicit coalescing and one finite catch-up without enabling them by default", () => {
    const value = record(); value.concurrency = "coalesce"; value.catch_up = "run-once"; assertRoutineRecord(value);
  });
  it.each([["max_projects", 0], ["max_projects", 26], ["max_attempts", 0], ["max_attempts", 2],
    ["max_runtime_ms", 0], ["max_runtime_ms", 60001], ["max_concurrent_occurrences", 0], ["max_concurrent_occurrences", 2]])(
    "rejects unsafe limit %s=%s", (field, value) => { const target = record(); put(target, ["limits", String(field)], value); rejected(target, assertRoutineRecord); });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null])("rejects unsafe numeric policy revision %j", (revision) => {
    const value = record(); put(value, ["policy", "revision"], revision); rejected(value, assertRoutineRecord);
  });
  it("rejects missing, duplicate, malformed or excessive policy references", () => {
    for (const ids of [[], ["policy-company", "policy-company"], ["../unsafe"], Array.from({ length: 65 }, (_, index) => `policy-${index}`)]) {
      const value = record(); value.policy.policy_ids = ids; rejected(value, assertRoutineRecord);
    }
    const malformed = record(); malformed.policy.fingerprint = digest.toUpperCase(); rejected(malformed, assertRoutineRecord);
  });
});

describe("T008 identifiers, calendar and JSON resource bounds", () => {
  it("refuses a string whose escaped bytes exceed the limit before encoding it", () => {
    const value = record(), oversized = "\0".repeat(Math.floor(ROUTINE_LIMITS.documentBytes / 6) + 1);
    put(value, ["extra"], oversized);
    const original = JSON.stringify, oversizedEncoding = vi.fn(); let error: unknown;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation(((input: unknown) => {
      if (input === oversized) oversizedEncoding();
      return original(input);
    }) as typeof JSON.stringify);
    try { assertRoutineRecord(value); } catch (caught) { error = caught; } finally { spy.mockRestore(); }
    expect(error).toBeInstanceOf(RoutineContractError); expect(oversizedEncoding).not.toHaveBeenCalled();
    expect((value as unknown as Record<string, unknown>).extra === oversized).toBe(true);
  });
  it.each(["", "../outside", "a..b", "a/b", "a\\b", "C:\\outside", "constructor", "prototype", "__proto__", "a".repeat(161), "é", "a\n"])(
    "rejects unsafe routine identity %j", (id) => { const value = record(); value.id = id; rejected(value, assertRoutineRecord); });
  it.each(["0000-01-01T00:00:00Z", "2025-02-29T00:00:00Z", "2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z", "2026-13-01T00:00:00Z",
    "2026-10-06T24:00:00Z", "2026-10-06T12:60:00Z", "2026-10-06T12:00:60Z", "2026-10-06T12:00:00.0000Z", "2026-10-06T12:00:00+00:00",
    "2026-10-06 12:00:00Z", "2026-10-06T12:00:00z"])("rejects invalid/non-UTC calendar %s", (timestamp) => {
      const value = record(); value.created_at = timestamp; rejected(value, assertRoutineRecord);
    });
  it.each(["0001-01-01T00:00:00Z", "2000-02-29T00:00:00.1Z", "9999-12-31T23:59:59.999Z"])("accepts strict calendar boundary %s", (timestamp) => {
    const value = record(); value.created_at = timestamp; value.updated_at = timestamp; assertRoutineRecord(value);
  });
  it("rejects reversed definition times instead of normalizing them", () => {
    const value = record(); value.created_at = finished; rejected(value, assertRoutineRecord);
  });
  it("refuses nested serialization hooks, cycles, sparse arrays and decorated arrays", () => {
    const hook = vi.fn(() => []), hooked = record(); Object.defineProperty(hooked.policy.policy_ids, "toJSON", { value: hook });
    expect(() => assertRoutineRecord(hooked)).toThrow(RoutineContractError); expect(hook).not.toHaveBeenCalled();
    const cyclic = record(); put(cyclic, ["cycle"], cyclic); expect(() => assertRoutineRecord(cyclic)).toThrow(RoutineContractError);
    const sparse = record(); sparse.policy.policy_ids = new Array(1); expect(() => assertRoutineRecord(sparse)).toThrow(RoutineContractError);
    const decorated = record(); Object.defineProperty(decorated.policy.policy_ids, "extra", { enumerable: true, value: "hidden" });
    expect(() => assertRoutineRecord(decorated)).toThrow(RoutineContractError);
  });
  it("rejects nesting beyond 32 before schema dispatch without modifying the input", () => {
    const value = record(); let nested: unknown = null;
    for (let index = 0; index < ROUTINE_LIMITS.nesting + 1; index++) nested = { nested };
    put(value, ["nested"], nested); const before = JSON.stringify(value);
    expect(() => assertRoutineRecord(value)).toThrow(/nesting exceeds limit/); expect(JSON.stringify(value)).toBe(before);
  });
  it("does not invoke inherited serialization hooks for validation or proposal hashing", () => {
    const objectHook = vi.fn(() => ({ substituted: true })), arrayHook = vi.fn(() => []);
    const originalObject = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON"), originalArray = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    try {
      Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value: objectHook });
      Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value: arrayHook });
      assertRoutineRecord(record()); expect(routineProposalKey(digest, otherDigest)).toMatch(/^[a-f0-9]{64}$/);
      expect(objectHook).not.toHaveBeenCalled(); expect(arrayHook).not.toHaveBeenCalled();
    } finally {
      if (originalObject) Object.defineProperty(Object.prototype, "toJSON", originalObject); else delete (Object.prototype as Record<string, unknown>).toJSON;
      if (originalArray) Object.defineProperty(Array.prototype, "toJSON", originalArray); else delete (Array.prototype as unknown as Record<string, unknown>).toJSON;
    }
  });
  it("refuses more than 10000 retained records without eviction", () => {
    const value = document([]); value.routines = Object.fromEntries(Array.from({ length: ROUTINE_LIMITS.records + 1 }, (_, index) => {
      const item = record(); item.id = `routine-${index}`; return [item.id, item];
    }));
    const before = JSON.stringify(value); expect(() => assertRoutineDocument(value)).toThrow(RoutineContractError); expect(JSON.stringify(value) === before).toBe(true);
  });
  it("refuses a shape-valid document above 16 MiB without clipping or mutating bytes", () => {
    const value = document([]); value.routines = {}; value.definitions = {}; value.cursors = {};
    const ids = Array.from({ length: 64 }, (_, index) => `policy-${String(index).padStart(2, "0")}-${"x".repeat(150)}`);
    for (let index = 0; index < 1000; index++) {
      const item = record(); item.id = `routine-${index}`; item.policy.policy_ids = [...ids];
      value.routines[item.id] = item; value.definitions[routineRevisionKey(item.id, 1)] = structuredClone(item);
    }
    const before = JSON.stringify(value); expect(Buffer.byteLength(before)).toBeGreaterThan(ROUTINE_LIMITS.documentBytes);
    expect(() => assertRoutineDocument(value)).toThrow(RoutineContractError); expect(JSON.stringify(value) === before).toBe(true);
  });
});

describe("T008 exact occurrence and budget bindings", () => {
  it.each(scopes)("accepts scoped read-only occurrence for $kind without task or role identity", (scope) => {
    const value = occurrence(record("refresh-evidence", scope)); assertRoutineOccurrence(value);
    expect(value.attribution.issue_id).toBeNull(); expect(value.attribution.role_id).toBeNull(); expect(value.attribution.execution_id).toBe(value.id);
    expect(value.budget.intent_id).toMatch(/^intent-[a-f0-9]{64}$/);
  });
  it.each(["routine_id", "routine_revision", "occurrence_key", "slot"])("rejects a mismatched %s", (field) => {
    const value = occurrence(); put(value, [field], field === "routine_revision" ? 2 : field === "slot" ? finished : "other-binding"); rejected(value, assertRoutineOccurrence);
  });
  it.each(["issue_id", "role_id", "execution_id"])("refuses invented attribution %s", (field) => {
    const value = occurrence(); put(value, ["attribution", field], "invented-task-role-issue"); rejected(value, assertRoutineOccurrence);
  });
  it.each(["subject_id", "reservation_id", "intent_id", "cap_fingerprint", "admitted_runtime_ms", "policy_bindings"])(
    "refuses absent occurrence budget %s", (field) => { const value = occurrence(); omit(value, ["budget", field]); rejected(value, assertRoutineOccurrence); });
  it("refuses a changed intent, project set or policy binding rather than recomputing authority", () => {
    const changedIntent = occurrence(); changedIntent.budget.intent_id = `intent-${otherDigest}`; rejected(changedIntent, assertRoutineOccurrence);
    const projects = occurrence(); projects.project_ids.push("other-project"); rejected(projects, assertRoutineOccurrence);
    const policy = occurrence(); policy.budget.policy_bindings[0]!.policy_id = "other-policy"; rebindBudget(policy); rejected(policy, assertRoutineOccurrence);
  });
  it("allows a more restrictive admitted runtime and refuses a larger one", () => {
    const smaller = occurrence(); smaller.budget.admitted_runtime_ms = 1000; rebindBudget(smaller); assertRoutineOccurrence(smaller);
    const larger = occurrence(); larger.definition.limits.max_runtime_ms = 1000; rejected(larger, assertRoutineOccurrence);
  });
  it("refuses missing company provenance and fabricated read policy scopes", () => {
    const missing = occurrence(); missing.budget.policy_bindings = []; rejected(missing, assertRoutineOccurrence);
    const role = occurrence(); role.budget.policy_bindings[0]!.scope = { kind: "role", id: "invented" }; rejected(role, assertRoutineOccurrence);
  });
  it.each(["project_ids", "objective_ids"])("refuses duplicate attribution %s", (field) => {
    const value = occurrence(); put(value, ["attribution", field], ["synthetic", "synthetic"]); rejected(value, assertRoutineOccurrence);
  });
  it("enforces the selected scope, project ceiling and depth bounds", () => {
    const wrongProject = occurrence(record("refresh-evidence", scopes[2]!)); wrongProject.definition.scope.id = "other-project"; rejected(wrongProject, assertRoutineOccurrence);
    const wrongObjective = occurrence(record("refresh-evidence", scopes[1]!)); wrongObjective.attribution.objective_ids = []; rejected(wrongObjective, assertRoutineOccurrence);
    const tooMany = occurrence(); tooMany.project_ids = Array.from({ length: 26 }, (_, index) => `project-${index}`); rejected(tooMany, assertRoutineOccurrence);
    const tooDeep = occurrence(); tooDeep.attribution.objective_ids = Array.from({ length: 9 }, (_, index) => `objective-${index}`); rejected(tooDeep, assertRoutineOccurrence);
  });
  it("requires an owner for running, refuses reserved ownership and retains historical terminal owner inventory", () => {
    const running = occurrence(); running.status = "running"; running.started_at = at; rejected(running, assertRoutineOccurrence);
    running.owner = { run_id: "run-1", worker_id: "worker-1", claimed_at: at }; assertRoutineOccurrence(running);
    const reserved = occurrence(); reserved.owner = structuredClone(running.owner); rejected(reserved, assertRoutineOccurrence);
    const completed = terminal(); completed.owner = structuredClone(running.owner); assertRoutineOccurrence(completed);
  });
  it.each(["completed", "partial", "failed", "cancelled", "needs-review"])("requires terminal evidence for %s", (status) => {
    const value = occurrence(); put(value, ["status"], status); rejected(value, assertRoutineOccurrence);
  });
  it.each(["occurrence_id", "occurrence_key", "routine_id", "routine_revision", "slot", "action", "scope", "policy_fingerprint", "cap_fingerprint", "project_ids", "started_at", "finished_at"])(
    "refuses detached receipt %s", (field) => {
      const value = terminal(); const replacements: Record<string, unknown> = { routine_revision: 2, action: "evaluate-signals", scope: scopes[1], project_ids: ["other-project"], started_at: finished, finished_at: "2026-10-06T12:00:02Z", slot: finished };
      put(value, ["receipt", field], replacements[field] ?? (field.endsWith("fingerprint") ? otherDigest : "different-id")); rejected(value, assertRoutineOccurrence);
    });
});

describe("T008 privacy-safe honest receipts", () => {
  it("derives proposal keys from the full exact occurrence/fingerprint tuple without granting authority", () => {
    const key = routineSlotKey("routine-1", 1, at), expected = createHash("sha256").update(JSON.stringify([key, digest])).digest("hex");
    expect(routineProposalKey(key, digest)).toBe(expected);
    expect(routineProposalKey(key, otherDigest)).not.toBe(expected);
    expect(routineProposalKey(routineSlotKey("routine-1", 2, at), digest)).not.toBe(expected);
  });
  it.each(["", "a".repeat(63), "g".repeat(64), digest.toUpperCase(), null])("refuses malformed proposal fingerprint %j", (fingerprint) => {
    expect(() => routineProposalKey(digest, fingerprint as string)).toThrow(RoutineContractError);
  });
  it.each(ROUTINE_ACTIONS)("accepts explicit zero-model read receipt for %s", (action) => {
    const value = receipt(occurrence(record(action))); assertRoutineReceipt(value);
    expect(value.consumption.model_calls).toBe(0); expect(value.consumption.total_tokens).toBe(0); expect(value.consumption.workspace_writes).toBe(0);
  });
  it.each(["notes", "instructions", "raw_output", "credentials", "url", "path", "command", "report_path", "summary"])("rejects private/free-form receipt field %s", (field) => {
    const value = receipt(); put(value, [field], "synthetic-private-not-stored"); rejected(value, assertRoutineReceipt);
  });
  it.each(["model_calls", "total_tokens", "workspace_writes"])("refuses nonzero forbidden resource %s", (field) => {
    const value = receipt(); put(value, ["consumption", field], 1); rejected(value, assertRoutineReceipt);
  });
  it.each(["projects_selected", "facts_total", "facts_fresh", "facts_unavailable"])("checks exact %s rather than accepting a self-report", (field) => {
    const value = receipt(); put(value, ["counts", field], 9); rejected(value, assertRoutineReceipt);
  });
  it("preserves explicit complete zero separately from unavailable usage", () => {
    const zero = receipt(); zero.consumption.runtime_ms = 0; assertRoutineReceipt(zero);
    const unknown = receipt(); unknown.consumption.runtime_ms = null; unknown.consumption.runtime_state = "unknown";
    unknown.budget_outcome = "unknown"; unknown.failure_code = "accounting-unavailable"; unknown.next_action = "inspect-budget"; unknown.freshness = "partial";
    assertRoutineReceipt(unknown); expect(unknown.consumption.runtime_ms).toBeNull();
    unknown.consumption.runtime_ms = 750; assertRoutineReceipt(unknown); expect(unknown.consumption.runtime_ms).toBe(750);
  });
  it("keeps a proven unstarted zero and an unknown claim distinguishable without fabricating a run", () => {
    const denied = receipt(); denied.started_at = null; denied.finished_at = null;
    denied.consumption.attempts = 0; denied.consumption.runtime_ms = 0; denied.budget_outcome = "denied"; denied.freshness = "unavailable";
    denied.sources = []; denied.counts.facts_total = denied.counts.facts_fresh = 0;
    denied.failure_code = "budget-denied"; denied.next_action = "inspect-budget"; assertRoutineReceipt(denied);
    const unknown = structuredClone(denied); unknown.consumption.attempts = null; unknown.consumption.runtime_ms = null;
    unknown.consumption.runtime_state = "unknown"; unknown.budget_outcome = "unknown"; unknown.failure_code = "accounting-unavailable"; assertRoutineReceipt(unknown);
    const falseClaim = structuredClone(denied); falseClaim.consumption.attempts = 1; rejected(falseClaim, assertRoutineReceipt);
    const falseZero = structuredClone(denied); falseZero.consumption.runtime_ms = 1; rejected(falseZero, assertRoutineReceipt);
    const falseComplete = structuredClone(unknown); falseComplete.consumption.runtime_state = "complete"; rejected(falseComplete, assertRoutineReceipt);
  });
  it("retains real observed runtime overshoot without clipping while classifying exhaustion", () => {
    const value = terminal(); value.status = "failed"; value.receipt!.consumption.runtime_ms = 60001;
    value.receipt!.budget_outcome = "exhausted"; value.receipt!.failure_code = "budget-exhausted"; value.receipt!.next_action = "inspect-budget"; value.receipt!.freshness = "partial";
    assertRoutineOccurrence(value); expect(value.receipt!.consumption.runtime_ms).toBe(60001);
    value.receipt!.budget_outcome = "within-limit"; rejected(value, assertRoutineOccurrence);
  });
  it("refuses unknown consumption presented as fresh successful within-limit evidence", () => {
    const missing = receipt(); missing.consumption.runtime_ms = null; rejected(missing, assertRoutineReceipt);
    const unknown = receipt(); unknown.consumption.runtime_state = "unknown"; rejected(unknown, assertRoutineReceipt);
    const incomplete = terminal(); incomplete.receipt!.budget_outcome = "unknown"; rejected(incomplete, assertRoutineOccurrence);
  });
  it.each([2, -1, 0.5, "1"])("refuses unsafe attempts %j", (attempts) => {
    const value = receipt(); put(value, ["consumption", "attempts"], attempts); rejected(value, assertRoutineReceipt);
  });
  it("rejects stale/unavailable sources advertised as fresh, and exact duplicate source identities", () => {
    const unavailable = receipt(); unavailable.sources[0]!.state = "unavailable"; unavailable.sources[0]!.observed_at = null;
    unavailable.sources[0]!.fingerprint = null; unavailable.counts.facts_fresh = 0; unavailable.counts.facts_unavailable = 1; rejected(unavailable, assertRoutineReceipt);
    const stale = receipt(); stale.sources[0]!.state = "stale"; stale.counts.facts_fresh = 0; rejected(stale, assertRoutineReceipt);
    const duplicate = receipt(); duplicate.sources.push(structuredClone(duplicate.sources[0]!)); duplicate.counts.facts_total = 2; duplicate.counts.facts_fresh = 2; rejected(duplicate, assertRoutineReceipt);
  });
  it("accepts honest unavailable and stale facts without inventing a current successful observation", () => {
    const unavailable = receipt(); unavailable.sources[0]!.state = "unavailable"; unavailable.sources[0]!.observed_at = null; unavailable.sources[0]!.fingerprint = null;
    unavailable.counts.facts_fresh = 0; unavailable.counts.facts_unavailable = 1; unavailable.freshness = "unavailable";
    unavailable.failure_code = "source-unavailable"; unavailable.next_action = "inspect-evidence"; assertRoutineReceipt(unavailable);
    const stale = receipt(); stale.sources[0]!.state = "stale"; stale.counts.facts_fresh = 0; stale.freshness = "stale";
    stale.failure_code = "source-unavailable"; stale.next_action = "inspect-evidence"; assertRoutineReceipt(stale);
    stale.sources[0]!.fingerprint = null; rejected(stale, assertRoutineReceipt);
    unavailable.sources[0]!.observed_at = at; rejected(unavailable, assertRoutineReceipt);
  });
  it("requires measured source provenance and source project membership", () => {
    const noTime = receipt(); noTime.sources[0]!.observed_at = null; rejected(noTime, assertRoutineReceipt);
    const noHash = receipt(); noHash.sources[0]!.fingerprint = null; rejected(noHash, assertRoutineReceipt);
    const other = receipt(); other.sources[0]!.project_id = "not-selected"; rejected(other, assertRoutineReceipt);
    const future = receipt(); future.sources[0]!.observed_at = "2026-10-06T12:00:02Z"; rejected(future, assertRoutineReceipt);
  });
  it("only proposal actions admit derived proposal keys and count actual created issues", () => {
    const value = receipt(occurrence(record("propose-issues"))), key = routineProposalKey(value.occurrence_key, digest);
    value.proposals = [{ key, fingerprint: digest, issue_id: "issue-1" }, { key: routineProposalKey(value.occurrence_key, otherDigest), fingerprint: otherDigest, issue_id: null }];
    value.counts.proposals_created = 1; value.next_action = "review-proposals"; assertRoutineReceipt(value);
    const wrongCount = structuredClone(value); wrongCount.counts.proposals_created = 2; rejected(wrongCount, assertRoutineReceipt);
    const forged = structuredClone(value); forged.proposals[0]!.key = otherDigest; rejected(forged, assertRoutineReceipt);
    const duplicate = structuredClone(value); duplicate.proposals.push(structuredClone(value.proposals[0]!)); duplicate.counts.proposals_created = 2; rejected(duplicate, assertRoutineReceipt);
    value.action = "refresh-evidence"; rejected(value, assertRoutineReceipt);
  });
  it("admits a report count only for the fixed local-report action without a destination", () => {
    const value = receipt(occurrence(record("generate-local-report"))); value.counts.reports_written = 1; assertRoutineReceipt(value);
    value.action = "refresh-evidence"; rejected(value, assertRoutineReceipt);
  });
  it("requires ordered receipt times and terminal capture", () => {
    const reversed = receipt(); reversed.started_at = "2026-10-06T12:00:02Z"; rejected(reversed, assertRoutineReceipt);
    const early = receipt(); early.captured_at = at; rejected(early, assertRoutineReceipt);
  });
  it("refuses non-allowlisted failures and next actions rather than persisting private free text", () => {
    const failure = receipt(); put(failure, ["failure_code"], "synthetic private command output"); rejected(failure, assertRoutineReceipt);
    const next = receipt(); put(next, ["next_action"], "run-any-command"); rejected(next, assertRoutineReceipt);
    const source = receipt(); put(source, ["sources", "0", "raw_output"], "synthetic private provider payload"); rejected(source, assertRoutineReceipt);
  });
});

describe("T008 immutable definition history and aggregate uniqueness", () => {
  it("retains an old enabled revision after a later disable without rewriting historical occurrences", () => {
    const value = document(), old = structuredClone(value.definitions[routineRevisionKey("routine-1", 1)]!);
    const latest = { ...structuredClone(old), revision: 2, enabled: false, updated_at: finished };
    value.routines[latest.id] = latest; value.definitions[routineRevisionKey(latest.id, 2)] = structuredClone(latest);
    const before = JSON.stringify(value); assertRoutineDocument(value); expect(JSON.stringify(value)).toBe(before);
    expect(value.occurrences["occurrence-1"]!.definition).toEqual(old); expect(value.routines[latest.id]!.enabled).toBe(false);
  });
  it("refuses missing history, revision gaps, current aliases and mutable embedded snapshots", () => {
    const missing = document(); missing.definitions = {}; rejected(missing, assertRoutineDocument);
    const gap = document(); const current = gap.routines["routine-1"]!; current.revision = 3;
    gap.definitions[routineRevisionKey(current.id, 3)] = structuredClone(current); rejected(gap, assertRoutineDocument);
    const alias = document(); alias.routines["wrong-key"] = alias.routines["routine-1"]!; delete alias.routines["routine-1"]; rejected(alias, assertRoutineDocument);
    const historyAlias = document(); historyAlias.definitions["wrong-key"] = historyAlias.definitions[routineRevisionKey("routine-1", 1)]!;
    delete historyAlias.definitions[routineRevisionKey("routine-1", 1)]; rejected(historyAlias, assertRoutineDocument);
    const changed = document(); changed.occurrences["occurrence-1"]!.definition.enabled = false; rejected(changed, assertRoutineDocument);
  });
  it("requires occurrence map identities and existing definition references", () => {
    const alias = document(); alias.occurrences["wrong-key"] = alias.occurrences["occurrence-1"]!; delete alias.occurrences["occurrence-1"]; rejected(alias, assertRoutineDocument);
    const missing = document(); missing.routines = {}; rejected(missing, assertRoutineDocument);
  });
  it("refuses equivalent epoch duplicate slots and re-used reservation/intent subjects", () => {
    const first = terminal(), second = terminal(record(), "occurrence-2", "2026-10-06T12:00:00.000Z");
    const duplicate = document([first, second]); rejected(duplicate, assertRoutineDocument);
    const differentSlot = terminal(record(), "occurrence-2", "2026-10-06T12:00:01Z");
    differentSlot.budget.subject_id = first.budget.subject_id; rebindBudget(differentSlot);
    rejected(document([first, differentSlot]), assertRoutineDocument);
  });
  it("permits epoch-equivalent receipt aliases without rewriting original strings", () => {
    const value = terminal(); value.receipt!.slot = "2026-10-06T12:00:00.000Z";
    const before = JSON.stringify(value); assertRoutineOccurrence(value); expect(JSON.stringify(value)).toBe(before);
  });
  it("permits several historical unknown receipts but refuses two running owners globally", () => {
    const first = occurrence(), second = occurrence(record(), "occurrence-2", finished);
    for (const value of [first, second]) { value.status = "running"; value.started_at = value.created_at; value.owner = { run_id: `run-${value.id}`, worker_id: "worker-1", claimed_at: value.started_at }; }
    rejected(document([first, second]), assertRoutineDocument);
    for (const value of [first, second]) {
      value.status = "needs-review"; value.owner = null; value.receipt = receipt(value); value.finished_at = value.receipt.finished_at; value.updated_at = value.receipt.captured_at;
      value.receipt.consumption.runtime_state = "unknown"; value.receipt.consumption.runtime_ms = null; value.receipt.freshness = "partial";
      value.receipt.budget_outcome = "unknown"; value.receipt.failure_code = "accounting-unavailable"; value.receipt.next_action = "inspect-budget";
    }
    assertRoutineDocument(document([first, second]));
  });
  it("refuses cursor aliases, missing definitions, reversed high-water and multiple pending slots", () => {
    const alias = document(); alias.cursors["wrong-key"] = alias.cursors[routineRevisionKey("routine-1", 1)]!; delete alias.cursors[routineRevisionKey("routine-1", 1)]; rejected(alias, assertRoutineDocument);
    const missing = document(); missing.cursors[routineRevisionKey("routine-1", 1)]!.routine_revision = 2; rejected(missing, assertRoutineDocument);
    const definition = record(); definition.schedule = "every:15m"; definition.schedule_anchor_at = "2026-10-06T11:00:00Z";
    definition.created_at = definition.updated_at = definition.schedule_anchor_at;
    const future = document([terminal(definition)]); future.cursors[routineRevisionKey("routine-1", 1)]!.last_slot = "2026-10-06T12:15:00Z"; rejected(future, assertRoutineDocument);
    const pending = document(); put(pending, ["cursors", routineRevisionKey("routine-1", 1), "pending_slot"], [at, finished]); rejected(pending, assertRoutineDocument);
  });
});

describe("T008 reviewed terminal honesty and human proposal gates", () => {
  it("requires a visible failure and safe next action for a standalone unstarted budget denial", () => {
    const value = deniedOccurrence().receipt!; value.failure_code = null; value.next_action = "none";
    rejected(value, assertRoutineReceipt);
  });
  it("refuses hiding an unstarted budget denial as a partial occurrence without a visible failure", () => {
    const value = deniedOccurrence(); value.status = "partial"; value.receipt!.failure_code = null; value.receipt!.next_action = "none";
    rejected(value, assertRoutineOccurrence);
  });
  it.each(["signals_evaluated", "reports_written"])("rejects unstarted denied %s effects", (field) => {
    const action = field === "reports_written" ? "generate-local-report" : "evaluate-signals";
    const value = deniedOccurrence(record(action)).receipt!; put(value, ["counts", field], 1); rejected(value, assertRoutineReceipt);
  });
  it("rejects actual issue creation on an unstarted denied receipt with otherwise exact proposal bindings", () => {
    const value = deniedOccurrence(record("propose-issues")).receipt!;
    value.proposals = [{ key: routineProposalKey(value.occurrence_key, digest), fingerprint: digest, issue_id: "issue-denied" }];
    value.counts.proposals_created = 1; value.next_action = "review-proposals"; rejected(value, assertRoutineReceipt);
  });
  it("permits an unexecuted proposal fingerprint preview with a null issue reference and no claimed effect", () => {
    const value = deniedOccurrence(record("propose-issues")).receipt!;
    value.proposals = [{ key: routineProposalKey(value.occurrence_key, digest), fingerprint: digest, issue_id: null }];
    assertRoutineReceipt(value); expect(value.counts.proposals_created).toBe(0); expect(value.consumption.attempts).toBe(0);
  });
  it.each(["reserved", "running", "completed", "failed"])("refuses execution from an already-disabled historical definition with status %s", (status) => {
    const definition = record(); definition.enabled = false;
    let value = status === "completed" || status === "failed" ? terminal(definition) : occurrence(definition);
    put(value, ["status"], status);
    if (status === "running") { value.started_at = at; value.owner = { run_id: "run-disabled", worker_id: "worker-1", claimed_at: at }; }
    if (status === "failed") { value.receipt!.freshness = "partial"; value.receipt!.failure_code = "action-failed"; value.receipt!.next_action = "inspect-evidence"; }
    rejected(value, assertRoutineOccurrence);
  });
  it("preserves an already-disabled definition's terminal unstarted denial without fabricating execution", () => {
    const definition = record(); definition.enabled = false; const value = deniedOccurrence(definition);
    const before = JSON.stringify(value); assertRoutineOccurrence(value); expect(JSON.stringify(value)).toBe(before);
    expect(value.receipt!.consumption.attempts).toBe(0); expect(value.started_at).toBeNull();
  });
  it.each(["failed", "cancelled", "needs-review"])("requires a visible safe failure for terminal status %s", (status) => {
    const value = terminal(); put(value, ["status"], status); value.receipt!.freshness = "partial";
    if (status === "cancelled") value.cancel_requested_at = at;
    rejected(value, assertRoutineOccurrence);
  });
  it("rejects cancellation without an exact request and rejects a different failure substituted for cancellation", () => {
    const missing = terminal(); missing.status = "cancelled"; missing.receipt!.freshness = "partial";
    missing.receipt!.failure_code = "cancelled"; missing.receipt!.next_action = "run-new-occurrence"; rejected(missing, assertRoutineOccurrence);
    const relabeled = structuredClone(missing); relabeled.cancel_requested_at = at; relabeled.receipt!.failure_code = "accounting-unavailable";
    rejected(relabeled, assertRoutineOccurrence);
  });
  it("retains an exact human cancellation with known finish but unknown accounting instead of relabeling it", () => {
    const value = terminal(); value.status = "cancelled"; value.cancel_requested_at = at;
    value.receipt!.consumption.runtime_state = "unknown"; value.receipt!.consumption.runtime_ms = 750;
    value.receipt!.freshness = "partial"; value.receipt!.budget_outcome = "unknown";
    value.receipt!.failure_code = "cancelled"; value.receipt!.next_action = "run-new-occurrence";
    const before = JSON.stringify(value); assertRoutineOccurrence(value); expect(JSON.stringify(value)).toBe(before);
    expect(value.status).toBe("cancelled"); expect(value.receipt!.failure_code).toBe("cancelled");
  });
  it.each(["none", "run-new-occurrence", "inspect-evidence"])("requires human proposal review instead of next action %s after actual issue creation", (nextAction) => {
    const value = receipt(occurrence(record("propose-issues")));
    value.proposals = [{ key: routineProposalKey(value.occurrence_key, digest), fingerprint: digest, issue_id: "issue-created" }];
    value.counts.proposals_created = 1; put(value, ["next_action"], nextAction); rejected(value, assertRoutineReceipt);
  });
  it("retains the proposal human-review gate after partial action failure", () => {
    const value = receipt(occurrence(record("propose-issues")));
    value.proposals = [{ key: routineProposalKey(value.occurrence_key, digest), fingerprint: digest, issue_id: "issue-created" }];
    value.counts.proposals_created = 1; value.freshness = "partial"; value.failure_code = "action-failed"; value.next_action = "review-proposals";
    assertRoutineReceipt(value); value.next_action = "inspect-evidence"; rejected(value, assertRoutineReceipt);
  });
  it("refuses claiming creation of the same actual issue in two different occurrences", () => {
    const definition = record("propose-issues"), first = terminal(definition), second = terminal(definition, "occurrence-2", finished);
    for (const value of [first, second]) {
      const proof = value.receipt!; proof.proposals = [{ key: routineProposalKey(proof.occurrence_key, digest), fingerprint: digest, issue_id: "issue-created-once" }];
      proof.counts.proposals_created = 1; proof.next_action = "review-proposals"; assertRoutineOccurrence(value);
    }
    rejected(document([first, second]), assertRoutineDocument);
  });
  it("permits matching preview fingerprints across occurrences without inventing created issue identity", () => {
    const definition = record("propose-issues"), first = terminal(definition), second = terminal(definition, "occurrence-2", finished);
    for (const value of [first, second]) {
      const proof = value.receipt!; proof.proposals = [{ key: routineProposalKey(proof.occurrence_key, digest), fingerprint: digest, issue_id: null }];
      proof.counts.proposals_created = 0;
    }
    assertRoutineDocument(document([first, second]));
  });
});

describe("T008 inherited serialization refusal at the budget intent boundary", () => {
  const boundContracts: Array<{ name: string; fixture: () => object; assert: (value: unknown) => void }> = [
    { name: "occurrence", fixture: occurrence, assert: assertRoutineOccurrence },
    { name: "document", fixture: document, assert: assertRoutineDocument },
  ];
  for (const contract of boundContracts) for (const prototypeName of ["Object", "Array"] as const) it.each(["function", "accessor"] as const)(
    `${contract.name} rejects inherited ${prototypeName}.prototype.toJSON %s without invoking it`, (kind) => {
      const value = contract.fixture(), before = structuredClone(value);
      const prototype = prototypeName === "Object" ? Object.prototype : Array.prototype;
      const original = Object.getOwnPropertyDescriptor(prototype, "toJSON"), hook = vi.fn(() => null), getter = vi.fn(() => hook);
      let actualError: unknown;
      try {
        Object.defineProperty(prototype, "toJSON", kind === "function"
          ? { configurable: true, value: hook }
          : { configurable: true, get: getter });
        try { contract.assert(value); } catch (error) { actualError = error; }
      } finally {
        if (original) Object.defineProperty(prototype, "toJSON", original);
        else delete (prototype as unknown as Record<string, unknown>).toJSON;
      }
      expect.soft(actualError).toBeInstanceOf(RoutineContractError);
      expect.soft(getter).not.toHaveBeenCalled(); expect.soft(hook).not.toHaveBeenCalled();
      expect(value).toEqual(before);
    });
});
