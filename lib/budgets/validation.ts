import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { types as nodeTypes } from "node:util";
import policySchema from "../../schemas/budget-policy.schema.json";
import admissionSchema from "../../schemas/budget-admission.schema.json";
import ledgerSchema from "../../schemas/budget-ledger.schema.json";
import {
  BUDGET_DIMENSIONS, BUDGET_LIMITS, type BudgetAdmission, type BudgetAmounts, type BudgetAttribution,
  type BudgetLedger, type BudgetPolicy, type BudgetPolicyBinding, type BudgetReservation,
  type BudgetRunCharge, type BudgetScope, type BudgetSubject,
} from "./types";

/** Pure data validation. It cannot prove policy, approval, commitment or live ownership. */
export class BudgetContractError extends Error {
  constructor(message: string) { super(message); this.name = "BudgetContractError"; }
}
function invariant(ok: boolean, message: string): asserts ok {
  if (!ok) throw new BudgetContractError(message);
}
function calendar(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year! >= 1 && month! >= 1 && month! <= 12 && day! >= 1 && day! <= days[month! - 1]!;
}
function timestamp(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/.exec(value);
  return !!match && calendar(match[1]!) && Number(match[2]) <= 23 && Number(match[3]) <= 59
    && Number(match[4]) <= 59 && Number.isFinite(Date.parse(value));
}
const ajv = new Ajv2020({ strict: true, allErrors: true, ownProperties: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
ajv.addFormat("date-time", { type: "string", validate: timestamp });
for (const schema of [policySchema, admissionSchema, ledgerSchema]) ajv.addSchema(schema);
const validators = {
  policy: ajv.getSchema(policySchema.$id)!, admission: ajv.getSchema(admissionSchema.$id)!, ledger: ajv.getSchema(ledgerSchema.$id)!,
};

// Inspect descriptors before serialization/validation: neither accessors nor toJSON
// may hide data, invoke user code or substitute an apparently valid document.
function plainJson(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  invariant(depth <= 32, "Budget JSON nesting exceeds limit");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    invariant(Buffer.byteLength(value, "utf8") <= BUDGET_LIMITS.documentBytes, "Budget string exceeds byte limit");
    return;
  }
  if (typeof value === "number") { invariant(Number.isSafeInteger(value), "Budget number is not a finite safe integer"); return; }
  invariant(typeof value === "object" && !nodeTypes.isProxy(value), "Budget data must be plain JSON");
  invariant(!ancestors.has(value), "Budget data contains a cycle");
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  invariant(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null, "Budget data has an unsupported prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  invariant(keys.every((key) => typeof key === "string"), "Budget data contains symbol properties");
  if (array) {
    invariant(value.length <= BUDGET_LIMITS.records && keys.length === value.length + 1, "Budget array is sparse, decorated or oversized");
    for (let index = 0; index < value.length; index++) invariant(Object.hasOwn(descriptors, String(index)), "Budget array contains a missing element");
  } else invariant(keys.length <= BUDGET_LIMITS.records, "Budget collection exceeds record limit");
  ancestors.add(value);
  try {
    for (const key of keys as string[]) {
      if (array && key === "length") continue;
      invariant(key !== "constructor" && key !== "prototype" && key !== "__proto__", "Budget data contains an unsafe property");
      const descriptor = descriptors[key]!;
      invariant(descriptor.enumerable === true && Object.hasOwn(descriptor, "value"), "Budget data contains hidden properties or accessors");
      plainJson(descriptor.value, ancestors, depth + 1);
    }
  } finally { ancestors.delete(value); }
}
function shape<T>(validate: ValidateFunction, value: unknown, label: string): T {
  let encoded: string | undefined;
  try { plainJson(value); encoded = JSON.stringify(value); }
  catch (error) {
    if (error instanceof BudgetContractError) throw error;
    throw new BudgetContractError(`Invalid ${label} JSON data`);
  }
  invariant(encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= BUDGET_LIMITS.documentBytes, `${label} exceeds serialized byte limit`);
  invariant(validate(value), `Invalid or unsupported ${label}`);
  return value as T;
}
function unique(values: string[], label: string): void {
  invariant(new Set(values).size === values.length, `${label} contains duplicate identities`);
}
function ordered(created: string, updated: string): void {
  invariant(Date.parse(created) <= Date.parse(updated), "Reversed budget timestamps");
}
function scopeValid(scope: BudgetScope, attribution: BudgetAttribution): boolean {
  switch (scope.kind) {
    case "company": return scope.id === attribution.company_id;
    case "objective": return attribution.objective_ids.includes(scope.id);
    case "project": return attribution.project_ids.includes(scope.id);
    case "issue": return scope.id === attribution.issue_id;
    case "role": return scope.id === attribution.role_id;
    case "execution": return scope.id === attribution.execution_id;
  }
}
function bindingsValid(bindings: BudgetPolicyBinding[], attribution: BudgetAttribution, createdAt: string, amounts?: BudgetAmounts): void {
  unique(bindings.map((binding) => binding.policy_id), "Policy bindings");
  invariant(bindings.some((binding) => binding.scope.kind === "company" && binding.scope.id === "surtec"), "Missing company budget provenance");
  for (const binding of bindings) {
    invariant(scopeValid(binding.scope, attribution), "Policy scope differs from frozen budget attribution");
    const bucket = binding.period === "none" ? "none" : createdAt.slice(0, binding.period === "utc-day" ? 10 : 7);
    invariant(binding.bucket === bucket, "Policy bucket differs from original UTC admission period");
    if (binding.period === "utc-day") invariant(calendar(binding.bucket), "Invalid UTC day bucket");
    if (binding.period === "utc-month") invariant(calendar(`${binding.bucket}-01`), "Invalid UTC month bucket");
    if (amounts) for (const dimension of BUDGET_DIMENSIONS) {
      const limit = binding.limits[dimension];
      invariant(limit.status === "unconfigured" || amounts[dimension] <= limit.hard_cap, "Budget amount exceeds a configured binding ceiling");
    }
  }
}
function taskAttribution(task: { task_id: string; project_id: string; role_id: string; issue_id: string | null; attribution: BudgetAttribution }): void {
  const attribution = task.attribution;
  invariant(attribution.project_ids.length === 1 && attribution.project_ids[0] === task.project_id
    && attribution.issue_id === task.issue_id && attribution.role_id === task.role_id && attribution.execution_id === task.task_id,
  "Task differs from frozen budget attribution");
}
function overlappingAmounts(amounts: BudgetAmounts): void {
  invariant(amounts.review_attempts <= amounts.attempts && amounts.review_runtime_ms <= amounts.runtime_ms
    && amounts.review_total_tokens <= amounts.total_tokens, "Review labels exceed canonical budget amounts");
  invariant(amounts.corrections <= 1, "Budget cannot allocate an extra correction");
}
export function assertBudgetPolicy(value: unknown): asserts value is BudgetPolicy {
  const policy = shape<BudgetPolicy>(validators.policy, value, "budget policy");
  unique(policy.rules.map((rule) => rule.id), "Budget policy rules");
  invariant(policy.rules.some((rule) => rule.scope.kind === "company" && rule.scope.id === "surtec"), "Missing company budget policy");
  invariant(policy.rules.every((rule) => rule.scope.kind !== "company" || rule.scope.id === "surtec"), "Unsupported budget company");
}
export function assertBudgetAdmission(value: unknown): asserts value is BudgetAdmission {
  const admission = shape<BudgetAdmission>(validators.admission, value, "budget admission");
  taskAttribution(admission);
  const hasIssue = admission.issue_id !== null;
  invariant(hasIssue ? admission.scope_revision !== null && admission.scope_fingerprint !== null
    : admission.scope_revision === null && admission.scope_fingerprint === null, "Admission issue scope binding is incomplete or invented");
  invariant(admission.context_admission_version === 2 ? hasIssue && admission.workflow !== null : admission.workflow === null,
    "Admission workflow differs from independent context version");
  const caps = admission.caps;
  invariant(caps.attempts > 0 && caps.runtime_ms > 0 && caps.total_tokens > 0, "Admission requires positive finite primary ceilings");
  invariant(caps.concurrent_reads === (admission.execution_mode === "read" ? 1 : 0)
    && caps.concurrent_writes === (admission.execution_mode === "write" ? 1 : 0), "Admission must reserve its exact execution slot");
  overlappingAmounts(caps);
  bindingsValid(admission.policy_bindings, admission.attribution, admission.created_at, caps);
}
function subjectValid(subject: BudgetSubject): void {
  if (subject.kind === "task") {
    taskAttribution(subject);
    invariant(subject.workflow === null || subject.issue_id !== null, "Task workflow requires an issue binding");
  } else {
    const attribution = subject.attribution;
    invariant(attribution.role_id === null && attribution.issue_id === null && attribution.execution_id === subject.occurrence_id,
      "Occurrence cannot invent task or agent attribution");
    invariant(attribution.project_ids.length === subject.project_ids.length
      && subject.project_ids.every((id) => attribution.project_ids.includes(id)), "Occurrence differs from frozen project attribution");
  }
}
function heldValid(reservation: BudgetReservation, subject: BudgetSubject): void {
  const held = reservation.held;
  overlappingAmounts(held);
  invariant(held.attempts <= 1 && held.concurrent_reads + held.concurrent_writes <= 1, "Reservation doubles an attempt or execution slot");
  if ((reservation.status === "pending" || reservation.status === "committed") && reservation.run_ids.length === 0) {
    invariant(held.attempts === 1 && held.concurrent_reads + held.concurrent_writes === 1 && held.runtime_ms > 0,
      "Fresh reservation requires its first attempt, exact execution slot and bounded runtime hold");
    if (subject.kind === "task") invariant(held.total_tokens > 0, "Fresh task reservation requires its cumulative token hold");
  }
  if (subject.kind === "occurrence") {
    invariant(held.runtime_ms <= 60000 && held.total_tokens === 0 && held.concurrent_writes === 0
      && held.review_attempts === 0 && held.review_runtime_ms === 0 && held.review_total_tokens === 0 && held.corrections === 0,
    "Occurrence cannot reserve model, write, review or correction resources");
    invariant(reservation.uncertain_dimensions.every((dimension) => dimension === "attempts" || dimension === "runtime_ms" || dimension === "concurrent_reads"),
      "Occurrence cannot invent uncertain model, write, review or correction resources");
  }
  invariant(reservation.status !== "unknown" || reservation.uncertain_dimensions.length > 0, "Unknown reservation requires explicit uncertainty");
  invariant(reservation.status === "unknown" || reservation.uncertain_dimensions.length === 0, "Known reservation cannot hide uncertain dimensions");
  if (reservation.status === "settled") invariant(BUDGET_DIMENSIONS.every((dimension) => held[dimension] === 0)
    && reservation.uncertain_dimensions.length === 0, "Settled reservation retains a hold or uncertainty");
}
function chargeValid(charge: BudgetRunCharge, reservation: BudgetReservation, subject: BudgetSubject): void {
  invariant(reservation.status !== "pending", "Claimed run cannot belong to a pending reservation");
  invariant(charge.usage_state !== "complete" || charge.observed_total_tokens !== null, "Complete usage requires an observed total, including explicit zero");
  if (subject.kind === "occurrence") invariant(charge.usage_state === "complete" && charge.observed_total_tokens === 0 && !charge.review && !charge.correction,
    "Occurrence cannot invent model usage or review/correction charges");
  if (charge.status === "terminal" && (charge.runtime_state === "unknown" || charge.usage_state === "unknown")) {
    invariant(reservation.status === "unknown", "Unknown terminal receipt cannot settle its reservation");
    if (charge.runtime_state === "unknown") invariant(reservation.uncertain_dimensions.includes("runtime_ms")
      && (!charge.review || reservation.uncertain_dimensions.includes("review_runtime_ms")), "Unknown runtime requires conservative dimensions");
    if (charge.usage_state === "unknown") invariant(reservation.uncertain_dimensions.includes("total_tokens")
      && (!charge.review || reservation.uncertain_dimensions.includes("review_total_tokens")), "Unknown usage requires conservative dimensions");
  }
  invariant(reservation.status !== "settled" || charge.status === "terminal"
    && charge.runtime_state === "complete" && charge.usage_state === "complete", "Settlement requires complete terminal receipts");
  invariant(charge.status !== "running" || reservation.status === "active" || reservation.status === "unknown", "Running charge requires active or uncertain ownership");
}
function keyed<T extends { id: string }>(records: Record<string, T>): T[] {
  for (const [id, record] of Object.entries(records)) invariant(id === record.id, "Budget map key differs from record identity");
  return Object.values(records);
}
export function assertBudgetLedger(value: unknown): asserts value is BudgetLedger {
  const ledger = shape<BudgetLedger>(validators.ledger, value, "budget ledger");
  ordered(ledger.created_at, ledger.updated_at);
  const subjects = keyed(ledger.subjects), reservations = keyed(ledger.reservations), intents = keyed(ledger.admission_intents), charges = keyed(ledger.charges);
  unique(reservations.filter((reservation) => reservation.status !== "settled").map((reservation) => reservation.subject_id), "Open subject reservations");
  unique(subjects.map((subject) => subject.kind === "task" ? `task:${subject.task_id}` : `occurrence:${subject.occurrence_id}`), "Canonical budget subjects");
  unique(subjects.filter((subject) => subject.kind === "occurrence").map((subject) => JSON.stringify([subject.routine_id, subject.routine_revision, Date.parse(subject.slot)])), "Routine occurrence slots");
  unique(charges.map((charge) => JSON.stringify([charge.subject_id, charge.run_id])), "Canonical budget run charges");
  unique(charges.map((charge) => charge.run_id), "Budget run identities");
  unique(intents.flatMap((intent) => intent.admission_id === null ? [] : [intent.admission_id]), "Budget admission identities");
  for (const subject of subjects) subjectValid(subject);
  const runs = new Map(charges.map((charge) => [charge.run_id, charge]));
  for (const reservation of reservations) {
    ordered(reservation.created_at, reservation.updated_at);
    const subject = ledger.subjects[reservation.subject_id], intent = ledger.admission_intents[reservation.intent_id];
    invariant(!!subject && !!intent && intent.subject_id === reservation.subject_id && intent.reservation_id === reservation.id,
      "Reservation lacks exact subject and intent bindings");
    invariant(reservation.status === "unknown" || intent.status === (reservation.status === "pending" ? "pending" : "committed"),
      "Reservation commitment differs from its intent");
    heldValid(reservation, subject);
    bindingsValid(reservation.policy_bindings, subject.attribution, reservation.created_at, reservation.held);
    for (const runId of reservation.run_ids) {
      const charge = runs.get(runId);
      invariant(!!charge && charge.subject_id === reservation.subject_id && charge.reservation_id === reservation.id, "Reservation contains an unknown or foreign run");
    }
  }
  for (const intent of intents) {
    ordered(intent.created_at, intent.updated_at);
    const subject = ledger.subjects[intent.subject_id], reservation = ledger.reservations[intent.reservation_id];
    invariant(!!subject && !!reservation && reservation.subject_id === intent.subject_id && reservation.intent_id === intent.id,
      "Intent lacks exact subject and reservation bindings");
    invariant(subject.kind === "occurrence" ? intent.admission_id === null : intent.status !== "committed" || intent.admission_id !== null,
      "Intent admission differs from its canonical subject");
    invariant(intent.status !== "unknown" || reservation.status === "unknown", "Unknown intent requires a conservative reservation");
  }
  const occurrenceCharges = new Set<string>();
  for (const charge of charges) {
    ordered(charge.created_at, charge.updated_at);
    const subject = ledger.subjects[charge.subject_id], reservation = ledger.reservations[charge.reservation_id];
    invariant(!!subject && !!reservation && reservation.subject_id === charge.subject_id && reservation.run_ids.includes(charge.run_id),
      "Charge lacks exact subject, reservation and run bindings");
    if (subject.kind === "occurrence") {
      invariant(!occurrenceCharges.has(subject.id), "Occurrence cannot charge another attempt");
      occurrenceCharges.add(subject.id);
    }
    chargeValid(charge, reservation, subject);
  }
}
