import { describe, expect, it, vi } from "vitest";
import { BUDGET_DIMENSIONS, BUDGET_LIMITS } from "./types";
import type {
  BudgetAdmission, BudgetAmounts, BudgetAttribution, BudgetLedger, BudgetLimits, BudgetOccurrenceSubject,
  BudgetPolicy, BudgetPolicyBinding, BudgetRunCharge, BudgetTaskSubject,
} from "./types";
import { assertBudgetAdmission, assertBudgetLedger, assertBudgetPolicy, BudgetContractError } from "./validation";
import envelopeSchema from "../../schemas/task-envelope.schema.json";
import contextV1Schema from "../../schemas/context-admission.schema.json";
import contextV2Schema from "../../schemas/context-admission-v2.schema.json";

// Synthetic contract shapes only: no issued previews, sealed receipts, stored
// approvals, controller proofs, normal state, providers or execution authority.
const at = "2026-10-05T12:00:00Z";
const digest = "a".repeat(64);
const limits = (): BudgetLimits => Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: "unconfigured" }])) as BudgetLimits;
const amounts = (overrides: Partial<BudgetAmounts> = {}): BudgetAmounts => ({
  attempts: 0, runtime_ms: 0, total_tokens: 0, concurrent_reads: 0, concurrent_writes: 0,
  review_attempts: 0, review_runtime_ms: 0, review_total_tokens: 0, corrections: 0, ...overrides,
});
const attribution = (): BudgetAttribution => ({ company_id: "surtec", objective_ids: ["objective-1"], project_ids: ["synthetic"], issue_id: null, role_id: "portfolio-analyst", execution_id: "T-1" });
const binding = (): BudgetPolicyBinding => ({ policy_id: "policy-company", policy_revision: 1, policy_fingerprint: digest, scope: { kind: "company", id: "surtec" }, period: "none", bucket: "none", limits: limits() });
const policy = (): BudgetPolicy => ({ schema_version: 1, revision: 1, rules: [{ id: "policy-company", revision: 1, scope: { kind: "company", id: "surtec" }, period: "none", warning_percent: 80, limits: limits() }], pricing: { status: "unavailable", reason: "no-versioned-source" } });
const subject = (): BudgetTaskSubject => ({ id: "BS-1", kind: "task", task_id: "T-1", project_id: "synthetic", role_id: "portfolio-analyst", agent_id: "synthetic-agent", issue_id: null, workflow: null, attribution: attribution() });
const admission = (): BudgetAdmission => ({
  schema_version: 1, id: "BA-1", subject_id: "BS-1", task_id: "T-1", project_id: "synthetic", role_id: "portfolio-analyst", agent_id: "synthetic-agent",
  attribution: attribution(),
  issue_id: null, scope_revision: null, scope_fingerprint: null, context_admission_version: 1, workflow: null,
  execution_mode: "read", manifest_fingerprint: digest, admitted_cap_fingerprint: digest,
  reservation_id: "BR-1", intent_id: "BI-1", created_at: at, policy_bindings: [binding()],
  caps: amounts({ attempts: 2, runtime_ms: 180000, total_tokens: 40000, concurrent_reads: 1 }),
});
const workflowAdmission = (): BudgetAdmission => ({
  ...admission(), issue_id: "I-1", scope_revision: 1, scope_fingerprint: digest, context_admission_version: 2,
  attribution: { ...attribution(), issue_id: "I-1" },
  workflow: { workflow_id: "WF-1", stage_id: "WS-1", stage_generation: 1, grant_id: "WG-1" },
  execution_mode: "write", caps: amounts({ attempts: 3, runtime_ms: 300000, total_tokens: 100000, concurrent_writes: 1, corrections: 1 }),
});
const charge = (): BudgetRunCharge => ({ id: "BC-1", subject_id: "BS-1", reservation_id: "BR-1", run_id: "run-1", attempts: 1, runtime_ms: 100, observed_total_tokens: 5, runtime_state: "complete", usage_state: "complete", status: "terminal", review: false, correction: false, created_at: at, updated_at: at });
const ledger = (): BudgetLedger => ({
  schema_version: 1, revision: 1, created_at: at, updated_at: at, subjects: { "BS-1": subject() },
  reservations: { "BR-1": { id: "BR-1", revision: 1, subject_id: "BS-1", intent_id: "BI-1", status: "settled", policy_bindings: [binding()], held: amounts(), uncertain_dimensions: [], run_ids: ["run-1"], created_at: at, updated_at: at } },
  admission_intents: { "BI-1": { id: "BI-1", subject_id: "BS-1", reservation_id: "BR-1", admission_id: "BA-1", status: "committed", created_at: at, updated_at: at } },
  charges: { "BC-1": charge() },
});
function occurrenceLedger(): BudgetLedger {
  const value = ledger();
  const occurrence: BudgetOccurrenceSubject = { id: "BS-1", kind: "occurrence", occurrence_id: "occurrence-1", routine_id: "routine-1", routine_revision: 1, slot: at, project_ids: ["synthetic"],
    attribution: { ...attribution(), issue_id: null, role_id: null, execution_id: "occurrence-1" } };
  value.subjects[occurrence.id] = occurrence; value.admission_intents["BI-1"]!.admission_id = null;
  value.charges["BC-1"]!.observed_total_tokens = 0;
  return value;
}
function unknownLedger(tokens: number | null = null): BudgetLedger {
  const value = ledger(), reserve = value.reservations["BR-1"]!, intent = value.admission_intents["BI-1"]!, run = value.charges["BC-1"]!;
  reserve.status = "unknown"; reserve.held = amounts({ runtime_ms: 1000, total_tokens: 40000, concurrent_reads: 1 }); reserve.uncertain_dimensions = ["runtime_ms", "total_tokens", "concurrent_reads"];
  intent.status = "unknown"; run.runtime_state = "unknown"; run.usage_state = "unknown"; run.observed_total_tokens = tokens;
  return value;
}
function heldLedger(): BudgetLedger {
  const value = ledger(), reserve = value.reservations["BR-1"]!;
  reserve.status = "committed"; reserve.held = amounts({ attempts: 1, runtime_ms: 1000, total_tokens: 100, concurrent_reads: 1 }); reserve.run_ids = [];
  value.charges = {}; return value;
}
function put(value: unknown, path: string[], replacement: unknown): void {
  const parent = path.slice(0, -1).reduce<unknown>((current, key) => (current as Record<string, unknown>)[key], value) as Record<string, unknown>;
  parent[path.at(-1)!] = replacement;
}
function omit(value: unknown, path: string[]): void {
  const parent = path.slice(0, -1).reduce<unknown>((current, key) => (current as Record<string, unknown>)[key], value) as Record<string, unknown>;
  delete parent[path.at(-1)!];
}
function rejectedWithoutMutation(value: unknown, assert: (value: unknown) => void): void {
  const before = structuredClone(value);
  expect(() => assert(value)).toThrow(BudgetContractError); expect(value).toEqual(before);
}
const contracts: Array<{ name: string; fixture: () => object; assert: (value: unknown) => void }> = [
  { name: "policy", fixture: policy, assert: assertBudgetPolicy },
  { name: "admission", fixture: admission, assert: assertBudgetAdmission },
  { name: "ledger", fixture: ledger, assert: assertBudgetLedger },
];

describe("T001 independent budget contracts", () => {
  it("accepts the explicit unconfigured policy without guessing prices or repairing bytes", () => {
    const value = policy(), bytes = JSON.stringify(value); assertBudgetPolicy(value); expect(JSON.stringify(value)).toBe(bytes);
    expect(value.pricing).toEqual({ status: "unavailable", reason: "no-versioned-source" });
    expect(BUDGET_DIMENSIONS.every((dimension) => value.rules[0]!.limits[dimension].status === "unconfigured")).toBe(true);
  });
  it("accepts explicit finite hard caps including a configured zero without granting execution", () => {
    const value = policy(); value.rules[0]!.limits.attempts = { status: "configured", hard_cap: 0 };
    value.rules[0]!.limits.total_tokens = { status: "configured", hard_cap: 40000 }; assertBudgetPolicy(value);
    expect(value.rules[0]!.limits.attempts).toEqual({ status: "configured", hard_cap: 0 });
  });
  it.each([1, 2] as const)("keeps BudgetAdmission v1 independent from context admission v%s", (contextVersion) => {
    const value = contextVersion === 1 ? admission() : workflowAdmission(), before = structuredClone(value);
    assertBudgetAdmission(value); expect(value.schema_version).toBe(1); expect(value.context_admission_version).toBe(contextVersion); expect(value).toEqual(before);
  });
  it("keeps historical envelope fields optional and context versions independent of budget admission", () => {
    expect(envelopeSchema.additionalProperties).toBe(false);
    expect(contextV1Schema.properties.schema_version.const).toBe(1); expect(contextV2Schema.properties.schema_version.const).toBe(2);
    expect(envelopeSchema.required).not.toContain("context_admission"); expect(envelopeSchema.required).not.toContain("budget_admission");
  });
  for (const contract of contracts) {
    describe(contract.name, () => {
      it.each([null, undefined, [], "1", 1, true])("rejects non-document input %j", (value) => rejectedWithoutMutation(value, contract.assert));
      it.each([0, 2, 999, "1", null])("rejects missing/unsupported/coerced version %j", (version) => {
        const value = contract.fixture(); put(value, ["schema_version"], version); rejectedWithoutMutation(value, contract.assert);
      });
      it("rejects absent version and unknown properties rather than supplying defaults", () => {
        const missing = contract.fixture(); omit(missing, ["schema_version"]); rejectedWithoutMutation(missing, contract.assert);
        const extra = contract.fixture(); put(extra, ["authority"], "synthetic-not-authority"); rejectedWithoutMutation(extra, contract.assert);
      });
      it("rejects inherited fields, custom prototypes, symbols, accessors and serialization hooks", () => {
        expect(() => contract.assert(Object.create(contract.fixture()))).toThrow(BudgetContractError);
        const prototype = contract.fixture(); Object.setPrototypeOf(prototype, { syntheticInherited: true }); expect(() => contract.assert(prototype)).toThrow(BudgetContractError);
        const symbol = contract.fixture(); Object.defineProperty(symbol, Symbol("synthetic"), { value: true }); expect(() => contract.assert(symbol)).toThrow(BudgetContractError);
        const hooked = contract.fixture(), serialization = vi.fn(() => contract.fixture());
        Object.defineProperty(hooked, "toJSON", { value: serialization }); expect(() => contract.assert(hooked)).toThrow(BudgetContractError); expect(serialization).not.toHaveBeenCalled();
        const accessed = contract.fixture(), getter = vi.fn(() => 1);
        Object.defineProperty(accessed, "schema_version", { enumerable: true, get: getter }); expect(() => contract.assert(accessed)).toThrow(BudgetContractError); expect(getter).not.toHaveBeenCalled();
      });
      it("preserves malformed future JSON bytes without migration, repair or coercion", () => {
        const source = JSON.stringify({ ...contract.fixture(), schema_version: 987 }, null, 2), value: unknown = JSON.parse(source);
        expect(() => contract.assert(value)).toThrow(BudgetContractError); expect(JSON.stringify(value, null, 2)).toBe(source);
      });
    });
  }
});

describe("T001 policy and admitted cap boundaries", () => {
  it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "4", null])("rejects unsafe hard cap %j", (counter) => {
    const value = policy(); put(value, ["rules", "0", "limits", "total_tokens"], { status: "configured", hard_cap: counter }); rejectedWithoutMutation(value, assertBudgetPolicy);
  });
  it.each(["attempts", "runtime_ms", "total_tokens", "concurrent_reads", "review_runtime_ms", "corrections"])("rejects unsafe %s counters in admission and reservation", (dimension) => {
    for (const counter of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      const admitted = admission(); put(admitted, ["caps", dimension], counter); rejectedWithoutMutation(admitted, assertBudgetAdmission);
      const value = heldLedger(); put(value, ["reservations", "BR-1", "held", dimension], counter); rejectedWithoutMutation(value, assertBudgetLedger);
    }
  });
  it.each(["attempts", "runtime_ms", "total_tokens"])("requires a positive admitted %s ceiling", (dimension) => {
    const value = admission(); put(value, ["caps", dimension], 0); rejectedWithoutMutation(value, assertBudgetAdmission);
  });
  it.each([0, 101, 80.5, "80"])("rejects invalid warning percent %j", (percent) => {
    const value = policy(); put(value, ["rules", "0", "warning_percent"], percent); rejectedWithoutMutation(value, assertBudgetPolicy);
  });
  it("requires every dimension, company provenance and unavailable-only pricing", () => {
    for (const change of [
      (value: BudgetPolicy) => { value.rules = []; },
      (value: BudgetPolicy) => { value.rules[0]!.scope = { kind: "company", id: "other" }; },
      (value: BudgetPolicy) => { omit(value, ["rules", "0", "limits", "attempts"]); },
      (value: BudgetPolicy) => { put(value, ["rules", "0", "limits", "attempts", "hard_cap"], 0); },
      (value: BudgetPolicy) => { put(value, ["pricing", "status"], "configured"); },
      (value: BudgetPolicy) => { put(value, ["pricing", "source"], "synthetic-price-source"); },
      (value: BudgetPolicy) => { put(value, ["rules", "0", "limits", "currency"], { status: "configured", hard_cap: 1 }); },
    ]) { const value = policy(); change(value); rejectedWithoutMutation(value, assertBudgetPolicy); }
  });
  it("rejects duplicate policy identities but permits independent constraints on the same scope/period", () => {
    const sameId = policy(); sameId.rules.push({ ...structuredClone(sameId.rules[0]!), scope: { kind: "project", id: "synthetic" } }); rejectedWithoutMutation(sameId, assertBudgetPolicy);
    const sameScope = policy(); sameScope.rules.push({ ...structuredClone(sameScope.rules[0]!), id: "policy-second" }); assertBudgetPolicy(sameScope);
  });
  it("admits exact cap equality and refuses a cap above a configured binding", () => {
    const value = admission(); value.policy_bindings[0]!.limits.total_tokens = { status: "configured", hard_cap: value.caps.total_tokens }; assertBudgetAdmission(value);
    value.caps.total_tokens++; rejectedWithoutMutation(value, assertBudgetAdmission);
  });
  it.each([
    ["read", 0, 0], ["read", 1, 1], ["read", 2, 0], ["write", 1, 1], ["write", 0, 0], ["write", 0, 2],
  ])("rejects %s with read/write slots %s/%s", (mode, reads, writes) => {
    const value = admission(); put(value, ["execution_mode"], mode); put(value, ["caps", "concurrent_reads"], reads); put(value, ["caps", "concurrent_writes"], writes); rejectedWithoutMutation(value, assertBudgetAdmission);
  });
  it("refuses an extra correction allowance or a workflow binding on context v1", () => {
    const extra = workflowAdmission(); extra.caps.corrections = 2; rejectedWithoutMutation(extra, assertBudgetAdmission);
    const wrongVersion = workflowAdmission(); wrongVersion.context_admission_version = 1; rejectedWithoutMutation(wrongVersion, assertBudgetAdmission);
  });
  it.each(["workflow", "issue_id", "scope_revision", "scope_fingerprint"])("requires exact context v2 %s", (field) => {
    const value = workflowAdmission(); put(value, [field], null); rejectedWithoutMutation(value, assertBudgetAdmission);
  });
  it.each(["manifest_fingerprint", "admitted_cap_fingerprint"])("rejects a malformed %s", (field) => {
    for (const fingerprint of [digest.toUpperCase(), "a".repeat(63), "g".repeat(64), ""]) { const value = admission(); put(value, [field], fingerprint); rejectedWithoutMutation(value, assertBudgetAdmission); }
  });
  it("bounds bindings while preserving independent policies on one scope", () => {
    const value = admission(); value.policy_bindings = Array.from({ length: BUDGET_LIMITS.bindings }, (_, index) => ({ ...binding(), policy_id: `policy-${index}` }));
    assertBudgetAdmission(value); value.policy_bindings.push({ ...binding(), policy_id: "policy-overflow" }); rejectedWithoutMutation(value, assertBudgetAdmission);
  });
});

describe("T001 frozen subjects, policy bindings and calendars", () => {
  it.each(["company_id", "execution_id", "project_ids", "role_id", "issue_id"])("refuses contradictory task attribution %s", (field) => {
    const value = ledger(); put(value, ["subjects", "BS-1", "attribution", field], field === "project_ids" ? ["other"] : "other"); rejectedWithoutMutation(value, assertBudgetLedger);
  });
  it.each(["company_id", "execution_id", "project_ids", "role_id", "issue_id"])("refuses contradictory immutable admission attribution %s", (field) => {
    const value = admission(); put(value, ["attribution", field], field === "project_ids" ? ["other"] : "other"); rejectedWithoutMutation(value, assertBudgetAdmission);
  });
  it("bounds and deduplicates frozen objective ancestry and occurrence projects", () => {
    const depth = ledger(); (depth.subjects["BS-1"] as BudgetTaskSubject).attribution.objective_ids = Array.from({ length: BUDGET_LIMITS.objectiveDepth }, (_, index) => `objective-${index}`); assertBudgetLedger(depth);
    (depth.subjects["BS-1"] as BudgetTaskSubject).attribution.objective_ids.push("objective-overflow"); rejectedWithoutMutation(depth, assertBudgetLedger);
    const repeated = ledger(); (repeated.subjects["BS-1"] as BudgetTaskSubject).attribution.objective_ids = ["objective-1", "objective-1"]; rejectedWithoutMutation(repeated, assertBudgetLedger);
    const many = occurrenceLedger(), occurrence = many.subjects["BS-1"] as BudgetOccurrenceSubject;
    occurrence.project_ids = Array.from({ length: BUDGET_LIMITS.projects }, (_, index) => `project-${index}`); occurrence.attribution.project_ids = [...occurrence.project_ids]; assertBudgetLedger(many);
    occurrence.project_ids.push("project-overflow"); occurrence.attribution.project_ids.push("project-overflow"); rejectedWithoutMutation(many, assertBudgetLedger);
  });
  it.each(["role_id", "agent_id", "issue_id", "workflow"])("cannot invent routine %s", (field) => {
    const value = occurrenceLedger(); put(value, ["subjects", "BS-1", field], "synthetic-invented"); rejectedWithoutMutation(value, assertBudgetLedger);
  });
  it.each(["issue_id", "role_id"])("requires null routine attribution %s", (field) => {
    const value = occurrenceLedger(); put(value, ["subjects", "BS-1", "attribution", field], "synthetic-invented"); rejectedWithoutMutation(value, assertBudgetLedger);
  });
  it("rejects nested non-JSON objects and accessor hooks before evaluating them", () => {
    const inherited = admission(); Object.setPrototypeOf(inherited.caps, { inheritedLimit: 1 }); expect(() => assertBudgetAdmission(inherited)).toThrow(BudgetContractError);
    const value = ledger(), getter = vi.fn(() => 5); Object.defineProperty(value.charges["BC-1"]!, "observed_total_tokens", { enumerable: true, get: getter });
    expect(() => assertBudgetLedger(value)).toThrow(BudgetContractError); expect(getter).not.toHaveBeenCalled();
  });
  it.each(["empty", "duplicate", "missing-company", "foreign-project", "foreign-role", "foreign-issue", "foreign-execution", "foreign-objective"])("rejects %s admission policy bindings", (change) => {
    const value = admission();
    if (change === "empty") value.policy_bindings = [];
    else if (change === "duplicate") value.policy_bindings.push(structuredClone(value.policy_bindings[0]!));
    else if (change === "missing-company") value.policy_bindings[0]!.scope = { kind: "project", id: "synthetic" };
    else value.policy_bindings.push({ ...binding(), policy_id: "policy-foreign", scope: { kind: change.slice(8) as "project" | "role" | "issue" | "execution" | "objective", id: "other" } });
    rejectedWithoutMutation(value, assertBudgetAdmission);
  });
  it("accepts valid explicit UTC calendar buckets including leap day", () => {
    for (const [period, bucket] of [["none", "none"], ["utc-day", "2024-02-29"], ["utc-month", "2026-10"]] as const) {
      const value = admission(); value.policy_bindings[0]!.period = period; value.policy_bindings[0]!.bucket = bucket;
      if (period === "utc-day") value.created_at = `${bucket}T12:00:00Z`; assertBudgetAdmission(value);
    }
  });
  it.each([
    ["none", "2026-10-05"], ["utc-day", "none"], ["utc-day", "2026-02-29"], ["utc-day", "2026-04-31"], ["utc-day", "2026-13-01"], ["utc-month", "2026-00"], ["utc-month", "2026-13"], ["utc-month", "2026-10-05"],
  ])("rejects contradictory/impossible %s bucket %s", (period, bucket) => {
    const value = admission(); put(value, ["policy_bindings", "0", "period"], period); value.policy_bindings[0]!.bucket = bucket; rejectedWithoutMutation(value, assertBudgetAdmission);
  });
  it("rejects a valid calendar bucket borrowed from another admission period", () => {
    for (const [period, bucket] of [["utc-day", "2026-10-04"], ["utc-month", "2026-09"]] as const) {
      const value = admission(); value.policy_bindings[0]!.period = period; value.policy_bindings[0]!.bucket = bucket; rejectedWithoutMutation(value, assertBudgetAdmission);
    }
  });
  it("keeps a reservation's original bucket when measured completion crosses UTC rollover", () => {
    const value = ledger(), reserve = value.reservations["BR-1"]!, completed = "2026-10-06T00:01:00Z";
    reserve.policy_bindings[0]!.period = "utc-day"; reserve.policy_bindings[0]!.bucket = "2026-10-05";
    value.updated_at = completed; reserve.updated_at = completed; value.admission_intents["BI-1"]!.updated_at = completed;
    value.charges["BC-1"]!.created_at = completed; value.charges["BC-1"]!.updated_at = completed;
    assertBudgetLedger(value); expect(reserve.policy_bindings[0]!.bucket).toBe("2026-10-05");
  });
  it.each(["2026-02-29T12:00:00Z", "2026-10-05T24:00:00Z", "2026-10-05T12:00:00+03:00", "2026-10-05", "invalid"])("rejects a noncanonical/impossible UTC timestamp %s", (timestamp) => {
    const value = admission(); value.created_at = timestamp; rejectedWithoutMutation(value, assertBudgetAdmission);
  });
  it.each(["ledger", "reservation", "intent", "charge"])("rejects reversed %s timestamps", (kind) => {
    const paths: Record<string, string[]> = { ledger: [], reservation: ["reservations", "BR-1"], intent: ["admission_intents", "BI-1"], charge: ["charges", "BC-1"] };
    const value = ledger(), path = paths[kind]!;
    put(value, [...path, "updated_at"], "2026-10-05T11:59:59Z"); rejectedWithoutMutation(value, assertBudgetLedger);
  });
});

describe("T001 canonical ledger references and conservative receipts", () => {
  it("accepts explicit empty historical collections without fabricating any authority", () => {
    const value = ledger(); value.subjects = {}; value.reservations = {}; value.admission_intents = {}; value.charges = {};
    const before = structuredClone(value); assertBudgetLedger(value); expect(value).toEqual(before);
  });
  it("accepts one canonical task charge with review/correction labels, not copied totals", () => {
    const value = ledger(); value.charges["BC-1"]!.review = true; value.charges["BC-1"]!.correction = true;
    const before = structuredClone(value); assertBudgetLedger(value); expect(value).toEqual(before); expect(Object.values(value.charges)).toHaveLength(1);
    expect(Object.values(value.charges).reduce((sum, run) => sum + run.observed_total_tokens!, 0)).toBe(5);
  });
  it("distinguishes proven complete zero from unknown missing or partial usage", () => {
    const zero = ledger(); zero.charges["BC-1"]!.observed_total_tokens = 0; assertBudgetLedger(zero);
    for (const observed of [null, 0, 17]) { const unknown = unknownLedger(observed); assertBudgetLedger(unknown); expect(unknown.charges["BC-1"]!.usage_state).toBe("unknown"); expect(unknown.charges["BC-1"]!.observed_total_tokens).toBe(observed); }
    const absent = unknownLedger(); omit(absent, ["charges", "BC-1", "observed_total_tokens"]); rejectedWithoutMutation(absent, assertBudgetLedger);
  });
  it("accepts one unstarted prospective attempt reservation without inventing charges", () => {
    const value = heldLedger(), before = structuredClone(value); assertBudgetLedger(value); expect(value).toEqual(before); expect(value.charges).toEqual({});
  });
  it("cannot attach a claimed charge to a still-pending reservation and intent", () => {
    const value = ledger(); value.reservations["BR-1"]!.status = "pending"; value.admission_intents["BI-1"]!.status = "pending";
    rejectedWithoutMutation(value, assertBudgetLedger);
  });
  it("cannot duplicate an unsettled subject hold through a second exact intent and reservation", () => {
    const value = heldLedger();
    value.reservations["BR-2"] = { ...structuredClone(value.reservations["BR-1"]!), id: "BR-2", intent_id: "BI-2" };
    value.admission_intents["BI-2"] = { ...structuredClone(value.admission_intents["BI-1"]!), id: "BI-2", reservation_id: "BR-2", admission_id: "BA-2" };
    rejectedWithoutMutation(value, assertBudgetLedger);
  });
  it.each(["attempts", "runtime_ms", "total_tokens", "concurrent_reads"])("cannot create a fresh pending/committed task hold with zero %s", (dimension) => {
    for (const status of ["pending", "committed"] as const) {
      const value = heldLedger(); value.reservations["BR-1"]!.status = status; value.admission_intents["BI-1"]!.status = status;
      assertBudgetLedger(value); put(value, ["reservations", "BR-1", "held", dimension], 0); rejectedWithoutMutation(value, assertBudgetLedger);
    }
  });
  it("preserves exhausted prior-run holds and unknown accounting without fresh-hold defaults", () => {
    const prior = ledger(); prior.reservations["BR-1"]!.status = "committed"; assertBudgetLedger(prior);
    const unknown = unknownLedger(17); unknown.reservations["BR-1"]!.held = amounts();
    const before = structuredClone(unknown); assertBudgetLedger(unknown); expect(unknown).toEqual(before);
    expect(unknown.charges["BC-1"]!.usage_state).toBe("unknown"); expect(unknown.reservations["BR-1"]!.uncertain_dimensions).not.toHaveLength(0);
  });
  it.each(["null-complete", "unknown-settled", "unknown-no-dimensions", "settled-hold", "settled-running"])("refuses fabricated settlement %s", (change) => {
    const value = change.startsWith("unknown") ? unknownLedger() : ledger();
    if (change === "null-complete") value.charges["BC-1"]!.observed_total_tokens = null;
    if (change === "unknown-settled") { value.reservations["BR-1"]!.status = "settled"; value.reservations["BR-1"]!.held = amounts(); value.reservations["BR-1"]!.uncertain_dimensions = []; }
    if (change === "unknown-no-dimensions") value.reservations["BR-1"]!.uncertain_dimensions = [];
    if (change === "settled-hold") value.reservations["BR-1"]!.held.total_tokens = 1;
    if (change === "settled-running") value.charges["BC-1"]!.status = "running";
    rejectedWithoutMutation(value, assertBudgetLedger);
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"])("rejects unsafe measured charge %j", (counter) => {
    for (const field of ["runtime_ms", "observed_total_tokens"]) { const value = ledger(); put(value, ["charges", "BC-1", field], counter); rejectedWithoutMutation(value, assertBudgetLedger); }
  });
  it.each(["subject-key", "reserve-key", "intent-key", "charge-key", "missing-subject", "reserve-subject", "intent-reserve", "reserve-intent", "charge-reserve", "charge-subject", "missing-run", "duplicate-run", "duplicate-charge", "duplicate-task"])("rejects exact aggregate reference defect %s", (change) => {
    const value = ledger();
    const maps = { "subject-key": value.subjects, "reserve-key": value.reservations, "intent-key": value.admission_intents, "charge-key": value.charges };
    if (change in maps) { const map = maps[change as keyof typeof maps] as Record<string, { id: string }>, [key] = Object.keys(map); map["different-key"] = map[key!]!; delete map[key!]; }
    if (change === "missing-subject") delete value.subjects["BS-1"];
    if (change === "reserve-subject") value.reservations["BR-1"]!.subject_id = "other";
    if (change === "intent-reserve") value.admission_intents["BI-1"]!.reservation_id = "other";
    if (change === "reserve-intent") value.reservations["BR-1"]!.intent_id = "other";
    if (change === "charge-reserve") value.charges["BC-1"]!.reservation_id = "other";
    if (change === "charge-subject") value.charges["BC-1"]!.subject_id = "other";
    if (change === "missing-run") value.reservations["BR-1"]!.run_ids = [];
    if (change === "duplicate-run") value.reservations["BR-1"]!.run_ids.push("run-1");
    if (change === "duplicate-charge") value.charges["BC-2"] = { ...charge(), id: "BC-2" };
    if (change === "duplicate-task") value.subjects["BS-2"] = { ...subject(), id: "BS-2" };
    rejectedWithoutMutation(value, assertBudgetLedger);
  });
  it.each(["__proto__", "constructor", "prototype", "unsafe..id", "../outside", "a/b", "a\\b", "", "a".repeat(161)])("rejects unsafe persisted identity %s without prototype mutation", (id) => {
    const value = ledger(); Object.defineProperty(value.subjects, id, { enumerable: true, configurable: true, value: { ...subject(), id } });
    expect(() => assertBudgetLedger(value)).toThrow(BudgetContractError); expect(Object.getPrototypeOf(value.subjects)).toBe(Object.prototype); expect({}).not.toHaveProperty("polluted");
  });
  it("cannot reuse a canonical run ID for another fully linked task subject", () => {
    const value = ledger(); value.subjects["BS-2"] = { ...subject(), id: "BS-2", task_id: "T-2", attribution: { ...attribution(), execution_id: "T-2" } };
    value.reservations["BR-2"] = { ...structuredClone(value.reservations["BR-1"]!), id: "BR-2", subject_id: "BS-2", intent_id: "BI-2" };
    value.admission_intents["BI-2"] = { ...structuredClone(value.admission_intents["BI-1"]!), id: "BI-2", subject_id: "BS-2", reservation_id: "BR-2", admission_id: "BA-2" };
    value.charges["BC-2"] = { ...charge(), id: "BC-2", subject_id: "BS-2", reservation_id: "BR-2" }; rejectedWithoutMutation(value, assertBudgetLedger);
  });
  it("cannot alias a routine revision/slot by changing its occurrence ID", () => {
    const value = occurrenceLedger(), occurrence = value.subjects["BS-1"] as BudgetOccurrenceSubject;
    value.subjects["BS-2"] = { ...structuredClone(occurrence), id: "BS-2", occurrence_id: "occurrence-2", attribution: { ...structuredClone(occurrence.attribution), execution_id: "occurrence-2" } };
    rejectedWithoutMutation(value, assertBudgetLedger);
  });
  it("cannot alias the same UTC slot by adding a millisecond representation", () => {
    const value = occurrenceLedger(), occurrence = value.subjects["BS-1"] as BudgetOccurrenceSubject;
    value.subjects["BS-2"] = { ...structuredClone(occurrence), id: "BS-2", occurrence_id: "occurrence-2", slot: "2026-10-05T12:00:00.000Z",
      attribution: { ...structuredClone(occurrence.attribution), execution_id: "occurrence-2" } };
    expect(Date.parse(occurrence.slot)).toBe(Date.parse((value.subjects["BS-2"] as BudgetOccurrenceSubject).slot)); rejectedWithoutMutation(value, assertBudgetLedger);
  });
  it("accepts a routine's exact zero-model deterministic charge", () => {
    const value = occurrenceLedger(), before = structuredClone(value); assertBudgetLedger(value); expect(value).toEqual(before);
    expect(value.charges["BC-1"]).toMatchObject({ attempts: 1, observed_total_tokens: 0, review: false, correction: false });
  });
  it("allows a company occurrence without inventing project attribution and preserves runtime excess", () => {
    const value = occurrenceLedger(), occurrence = value.subjects["BS-1"] as BudgetOccurrenceSubject;
    occurrence.project_ids = []; occurrence.attribution.project_ids = [];
    value.reservations["BR-1"]!.policy_bindings[0]!.limits.runtime_ms = { status: "configured", hard_cap: 60000 };
    value.charges["BC-1"]!.runtime_ms = 60001; assertBudgetLedger(value);
    expect(occurrence.project_ids).toEqual([]); expect(value.charges["BC-1"]!.runtime_ms).toBe(60001);
  });
  it("accepts an unstarted routine with exactly one read/attempt hold and no model allowance", () => {
    const value = occurrenceLedger(), reserve = value.reservations["BR-1"]!;
    reserve.status = "committed"; reserve.held = amounts({ attempts: 1, runtime_ms: 1000, concurrent_reads: 1 }); reserve.run_ids = []; value.charges = {};
    assertBudgetLedger(value); expect(reserve.held).toMatchObject({ attempts: 1, concurrent_reads: 1, concurrent_writes: 0, total_tokens: 0, review_attempts: 0, corrections: 0 });
  });
  it("retains interrupted routine runtime while refusing invented token uncertainty", () => {
    const value = occurrenceLedger(), reserve = value.reservations["BR-1"]!;
    reserve.status = "unknown"; reserve.held = amounts({ runtime_ms: 1000, concurrent_reads: 1 }); reserve.uncertain_dimensions = ["runtime_ms", "concurrent_reads"];
    value.admission_intents["BI-1"]!.status = "unknown"; value.charges["BC-1"]!.runtime_state = "unknown";
    assertBudgetLedger(value); expect(value.charges["BC-1"]!.observed_total_tokens).toBe(0);
    reserve.uncertain_dimensions.push("total_tokens"); rejectedWithoutMutation(value, assertBudgetLedger);
  });
  it.each(["tokens", "unknown-tokens", "extra-attempt", "write-slot", "review-hold", "correction-hold", "runtime-hold", "attempt-hold", "read-hold", "token-hold", "review-charge", "correction-charge", "foreign-project", "duplicate-project", "duplicate-occurrence"])("rejects routine accounting defect %s", (change) => {
    const value = occurrenceLedger(), reserve = value.reservations["BR-1"]!, occurrence = value.subjects["BS-1"] as BudgetOccurrenceSubject;
    if (change === "tokens") value.charges["BC-1"]!.observed_total_tokens = 1;
    if (change === "unknown-tokens") {
      reserve.status = "unknown"; reserve.held = amounts({ runtime_ms: 1000, concurrent_reads: 1 }); reserve.uncertain_dimensions = ["runtime_ms", "concurrent_reads"];
      value.admission_intents["BI-1"]!.status = "unknown"; value.charges["BC-1"]!.runtime_state = "unknown";
      value.charges["BC-1"]!.observed_total_tokens = null; value.charges["BC-1"]!.usage_state = "unknown";
    }
    if (change === "extra-attempt") put(value, ["charges", "BC-1", "attempts"], 2);
    if (["write-slot", "review-hold", "correction-hold", "runtime-hold", "attempt-hold", "read-hold", "token-hold"].includes(change)) {
      reserve.status = "committed"; reserve.held = amounts({ attempts: 1, runtime_ms: 1000, concurrent_reads: 1 }); reserve.run_ids = []; value.charges = {};
      const alterations: Record<string, [string, number]> = { "write-slot": ["concurrent_writes", 1], "review-hold": ["review_runtime_ms", 1], "correction-hold": ["corrections", 1], "runtime-hold": ["runtime_ms", 60001], "attempt-hold": ["attempts", 2], "read-hold": ["concurrent_reads", 2], "token-hold": ["total_tokens", 1] };
      const altered = alterations[change]!; put(reserve, ["held", altered[0]], altered[1]);
    }
    if (change === "review-charge") value.charges["BC-1"]!.review = true;
    if (change === "correction-charge") value.charges["BC-1"]!.correction = true;
    if (change === "foreign-project") occurrence.attribution.project_ids = ["other"];
    if (change === "duplicate-project") { occurrence.project_ids.push("synthetic"); occurrence.attribution.project_ids.push("synthetic"); }
    if (change === "duplicate-occurrence") value.subjects["BS-2"] = { ...structuredClone(occurrence), id: "BS-2" };
    rejectedWithoutMutation(value, assertBudgetLedger);
  });
  it("refuses collection overflow without needing a huge fixture or filtering facts", () => {
    const value = ledger();
    for (let index = 0; index < BUDGET_LIMITS.records - 1; index++) { const id = `subject-${index}`, taskId = `task-${index}`; value.subjects[id] = { ...subject(), id, task_id: taskId, attribution: { ...attribution(), execution_id: taskId } }; }
    expect(Object.keys(value.subjects)).toHaveLength(10000); assertBudgetLedger(value);
    value.subjects["overflow-subject"] = { ...subject(), id: "overflow-subject", task_id: "overflow-task", attribution: { ...attribution(), execution_id: "overflow-task" } };
    expect(Object.keys(value.subjects)).toHaveLength(10001); expect(() => assertBudgetLedger(value)).toThrow(BudgetContractError); expect(Object.keys(value.subjects)).toHaveLength(10001);
  });
  it("refuses the 16 MiB document limit with individually bounded synthetic records", () => {
    const value = ledger(); value.subjects = {}; value.reservations = {}; value.admission_intents = {}; value.charges = {};
    const projects = Array.from({ length: BUDGET_LIMITS.projects }, (_, index) => `project-${index}-`.padEnd(160, "p"));
    const objectives = Array.from({ length: BUDGET_LIMITS.objectiveDepth }, (_, index) => `objective-${index}-`.padEnd(160, "o"));
    for (let index = 0; index < 2300; index++) { const id = `subject-${index}`, occurrenceId = `occurrence-${index}`;
      value.subjects[id] = { id, kind: "occurrence", occurrence_id: occurrenceId, routine_id: `routine-${index}`, routine_revision: 1, slot: at, project_ids: projects,
        attribution: { company_id: "surtec", objective_ids: objectives, project_ids: projects, issue_id: null, role_id: null, execution_id: occurrenceId } };
    }
    expect(Object.keys(value.subjects).length).toBeLessThan(BUDGET_LIMITS.records);
    expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeGreaterThan(BUDGET_LIMITS.documentBytes);
    expect(() => assertBudgetLedger(value)).toThrow(BudgetContractError); expect(Object.keys(value.subjects)).toHaveLength(2300);
  });
});
