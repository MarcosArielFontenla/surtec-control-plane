import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { readBudgetTransaction, updateBudgetTransaction, type BudgetTransaction } from "../state/budgets";
import { resolveBudgetPolicy, type BudgetCorrectionLineage, type BudgetPolicySource, type ExistingBudgetConstraint, type ResolvedBudgetPolicy } from "./policy";
import { BUDGET_DIMENSIONS, BUDGET_LIMITS, type BudgetAdmission, type BudgetAmounts, type BudgetLedger, type BudgetOccurrenceSubject, type BudgetPolicyBinding, type BudgetReservation, type BudgetRunCharge, type BudgetSubject } from "./types";
import { assertBudgetAdmission, assertBudgetLedger } from "./validation";

/** Internal state-only operations. Neither their output nor a valid admission is execution authority. */
export class BudgetReservationError extends Error {
  constructor(readonly code: "binding-mismatch" | "budget-unavailable" | "invalid-transition" | "unknown-accounting") {
    super(`Budget reservation refused: ${code}`); this.name = "BudgetReservationError";
  }
}
const zero = (): BudgetAmounts => Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, 0])) as BudgetAmounts;
const clone = <T>(value: T): T => structuredClone(value);
function check(ok: boolean, code: BudgetReservationError["code"] = "binding-mismatch"): asserts ok { if (!ok) throw new BudgetReservationError(code); }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) && !value.includes("..") && !["constructor", "prototype", "__proto__"].includes(value); }
function sum(values: number[]): number { let total = 0; for (const value of values) { total += value; check(Number.isSafeInteger(total), "budget-unavailable"); } return total; }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function plain(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  check(depth <= 32);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { check(Buffer.byteLength(value) <= BUDGET_LIMITS.documentBytes); return; }
  if (typeof value === "number") { check(count(value)); return; }
  check(typeof value === "object" && !nodeTypes.isProxy(value) && !ancestors.has(value));
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  check(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null);
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  check(keys.every((key) => typeof key === "string") && keys.length <= BUDGET_LIMITS.records + (array ? 1 : 0));
  if (array) check(value.length <= BUDGET_LIMITS.records && keys.length === value.length + 1 && Array.from({ length: value.length }, (_, i) => Object.hasOwn(descriptors, String(i))).every(Boolean));
  ancestors.add(value);
  try { for (const key of keys as string[]) {
    if (array && key === "length") continue;
    const descriptor = descriptors[key]!;
    check(!["constructor", "prototype", "__proto__"].includes(key) && descriptor.enumerable === true && Object.hasOwn(descriptor, "value"));
    plain(descriptor.value, ancestors, depth + 1);
  } } finally { ancestors.delete(value); }
}
function input(value: unknown, required: string[], optional: string[] = [], raw: string[] = []): void {
  check(value !== null && typeof value === "object" && !nodeTypes.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype);
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  check(required.every((key) => Object.hasOwn(descriptors, key)) && keys.every((key) => typeof key === "string" && [...required, ...optional].includes(key)));
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]!;
    check(descriptor.enumerable === true && Object.hasOwn(descriptor, "value"));
    if (!raw.includes(key)) plain(descriptor.value);
  }
}
type PolicyInput = { source: BudgetPolicySource; constraints?: ExistingBudgetConstraint[]; correction_lineages?: BudgetCorrectionLineage[] };
type TaskInput = PolicyInput & { admission: BudgetAdmission };
type BoundTaskInput = TaskInput & { persisted_admission: unknown };
const policyOptions = ["constraints", "correction_lineages"];
function resolution(ledger: BudgetLedger | undefined, subject: BudgetSubject, at: string, caps: BudgetAmounts, options: PolicyInput): ResolvedBudgetPolicy {
  return resolveBudgetPolicy({ source: options.source, attribution: subject.attribution, at, base_caps: caps,
    ...(ledger === undefined ? {} : { ledger }), ...(options.constraints === undefined ? {} : { constraints: options.constraints }),
    ...(options.correction_lineages === undefined ? {} : { correction_lineages: options.correction_lineages }) });
}
function taskSubject(admission: BudgetAdmission): BudgetSubject {
  return { id: admission.subject_id, kind: "task", task_id: admission.task_id, project_id: admission.project_id,
    role_id: admission.role_id, agent_id: admission.agent_id, issue_id: admission.issue_id, workflow: clone(admission.workflow), attribution: clone(admission.attribution) };
}
/** Full immutable payload binding; excluding only this digest's own field avoids a circular hash. */
export function budgetTaskIntentId(admission: BudgetAdmission): string {
  assertBudgetAdmission(admission);
  const { intent_id: _intent, ...payload } = admission;
  return `intent-${createHash("sha256").update(canonical(payload)).digest("hex")}`;
}
type OccurrenceIntentInput = { subject: BudgetOccurrenceSubject; reservation_id: string; policy_bindings: BudgetPolicyBinding[]; cap_fingerprint: string; runtime_ms: number; created_at: string };
export function budgetOccurrenceIntentId(value: OccurrenceIntentInput): string {
  input(value, ["subject", "reservation_id", "policy_bindings", "cap_fingerprint", "runtime_ms", "created_at"]);
  check(identifier(value.reservation_id) && /^[a-f0-9]{64}$/.test(value.cap_fingerprint) && count(value.runtime_ms) && value.runtime_ms > 0 && value.runtime_ms <= 60000);
  const held = occurrenceCaps(value.runtime_ms), reserve = newReservation(value.reservation_id, value.subject.id, "intent-placeholder", value.policy_bindings, held, value.created_at);
  assertBudgetLedger({ schema_version: 1, revision: 1, created_at: value.created_at, updated_at: value.created_at, subjects: { [value.subject.id]: value.subject }, reservations: { [reserve.id]: reserve },
    admission_intents: { [reserve.intent_id]: { id: reserve.intent_id, subject_id: value.subject.id, reservation_id: reserve.id, admission_id: null, status: "pending", created_at: value.created_at, updated_at: value.created_at } }, charges: {} });
  return `intent-${createHash("sha256").update(canonical(value)).digest("hex")}`;
}
function taskHolds(admission: BudgetAdmission): BudgetAmounts {
  const caps = admission.caps, review = caps.review_attempts > 0 || caps.review_runtime_ms > 0 || caps.review_total_tokens > 0;
  check(!review || caps.review_attempts > 0 && caps.review_runtime_ms > 0 && caps.review_total_tokens > 0);
  check(caps.corrections === 0 || admission.workflow !== null);
  const runtime = review ? Math.min(caps.runtime_ms, caps.review_runtime_ms) : caps.runtime_ms;
  const tokens = review ? Math.min(caps.total_tokens, caps.review_total_tokens) : caps.total_tokens;
  return { ...zero(), attempts: 1, runtime_ms: runtime, total_tokens: tokens, concurrent_reads: caps.concurrent_reads, concurrent_writes: caps.concurrent_writes,
    review_attempts: review ? 1 : 0, review_runtime_ms: review ? runtime : 0, review_total_tokens: review ? tokens : 0, corrections: caps.corrections };
}
const occurrenceCaps = (runtime: number): BudgetAmounts => ({ ...zero(), attempts: 1, runtime_ms: runtime, concurrent_reads: 1 });
function fits(held: BudgetAmounts, resolved: ResolvedBudgetPolicy): void {
  for (const dimension of BUDGET_DIMENSIONS) if (held[dimension] > 0) {
    const remaining = resolved.dimensions[dimension].remaining;
    check(remaining !== null && held[dimension] <= remaining, "budget-unavailable");
  }
}
function taskStatic(value: TaskInput): void {
  assertBudgetAdmission(value.admission);
  check(value.admission.intent_id === budgetTaskIntentId(value.admission));
  const resolved = resolution(undefined, taskSubject(value.admission), value.admission.created_at, value.admission.caps, value);
  check(equal(resolved.policy_bindings, value.admission.policy_bindings) && resolved.cap_fingerprint === value.admission.admitted_cap_fingerprint);
  for (const dimension of BUDGET_DIMENSIONS) check(value.admission.caps[dimension] <= resolved.ceilings[dimension]);
}
function newReservation(id: string, subject: string, intent: string, bindings: BudgetPolicyBinding[], held: BudgetAmounts, at: string): BudgetReservation {
  return { id, revision: 1, subject_id: subject, intent_id: intent, status: "pending", policy_bindings: clone(bindings), held: clone(held), uncertain_dimensions: [], run_ids: [], created_at: at, updated_at: at };
}
function addReservation(ledger: BudgetLedger, subject: BudgetSubject, reserve: BudgetReservation): void {
  check(!Object.hasOwn(ledger.subjects, subject.id) && !Object.hasOwn(ledger.reservations, reserve.id) && !Object.hasOwn(ledger.admission_intents, reserve.intent_id));
  ledger.subjects[subject.id] = clone(subject); ledger.reservations[reserve.id] = clone(reserve);
  ledger.admission_intents[reserve.intent_id] = { id: reserve.intent_id, subject_id: subject.id, reservation_id: reserve.id, admission_id: null, status: "pending", created_at: reserve.created_at, updated_at: reserve.created_at };
}
function reserveView(tx: BudgetTransaction, id: string): BudgetReservation { return readBudgetTransaction(tx).ledger.reservations[id]!; }
function bound(ledger: BudgetLedger, admission: BudgetAdmission, persisted?: unknown): BudgetReservation {
  assertBudgetAdmission(admission); check(admission.intent_id === budgetTaskIntentId(admission));
  if (persisted !== undefined) { assertBudgetAdmission(persisted); check(equal(admission, persisted)); }
  const reserve = ledger.reservations[admission.reservation_id], intent = ledger.admission_intents[admission.intent_id];
  check(!!reserve && !!intent && equal(ledger.subjects[admission.subject_id], taskSubject(admission)) && reserve.subject_id === admission.subject_id
    && reserve.intent_id === admission.intent_id && equal(reserve.policy_bindings, admission.policy_bindings) && reserve.created_at === admission.created_at
    && intent.reservation_id === reserve.id && intent.subject_id === admission.subject_id && (intent.admission_id === null || intent.admission_id === admission.id));
  return reserve;
}
function known(reserve: BudgetReservation): void { check(reserve.status !== "unknown" && reserve.uncertain_dimensions.length === 0, "unknown-accounting"); }
function bump(reserve: BudgetReservation, at: string): void { check(reserve.revision < Number.MAX_SAFE_INTEGER, "budget-unavailable"); reserve.revision++; reserve.updated_at = at; }
function runs(ledger: BudgetLedger, reserve: BudgetReservation): BudgetRunCharge[] { return Object.values(ledger.charges).filter((charge) => charge.reservation_id === reserve.id); }
function lineage(subject: BudgetSubject, values: BudgetCorrectionLineage[] | undefined): string {
  check(subject.kind === "task" && subject.workflow !== null && values !== undefined);
  const result = values.find((value) => value.workflow_ids.includes(subject.workflow!.workflow_id));
  check(!!result && result.project_id === subject.project_id && result.issue_id === subject.issue_id);
  return result.id;
}
function correctionAvailable(ledger: BudgetLedger, subject: BudgetSubject, values: BudgetCorrectionLineage[] | undefined): void {
  const identity = lineage(subject, values);
  for (const reserve of Object.values(ledger.reservations)) {
    const charged = runs(ledger, reserve).some((charge) => charge.correction);
    if (reserve.held.corrections === 0 && !charged) continue;
    check(lineage(ledger.subjects[reserve.subject_id]!, values) !== identity, "budget-unavailable");
  }
}
export function reserveTaskBudget(tx: BudgetTransaction, value: TaskInput): BudgetReservation {
  input(value, ["admission", "source"], policyOptions); taskStatic(value);
  const { ledger, at } = readBudgetTransaction(tx), existing = ledger.reservations[value.admission.reservation_id];
  if (existing) { bound(ledger, value.admission); known(existing); check(existing.status === "pending" || existing.status === "committed", "invalid-transition"); return existing; }
  check(value.admission.created_at === at); const subject = taskSubject(value.admission), held = taskHolds(value.admission);
  fits(held, resolution(ledger, subject, at, value.admission.caps, value));
  if (held.corrections > 0) correctionAvailable(ledger, subject, value.correction_lineages);
  updateBudgetTransaction(tx, (draft) => addReservation(draft, subject, newReservation(value.admission.reservation_id, subject.id, value.admission.intent_id, value.admission.policy_bindings, held, at)));
  return reserveView(tx, value.admission.reservation_id);
}
export function commitTaskBudget(tx: BudgetTransaction, value: { admission: BudgetAdmission; persisted_admission: unknown }): BudgetReservation {
  input(value, ["admission", "persisted_admission"]); assertBudgetAdmission(value.persisted_admission);
  const { ledger } = readBudgetTransaction(tx), reserve = bound(ledger, value.admission, value.persisted_admission); known(reserve);
  if (reserve.status === "committed" || reserve.status === "active" || reserve.status === "settled") return reserve;
  check(reserve.status === "pending", "invalid-transition");
  updateBudgetTransaction(tx, (draft, at) => { const r = draft.reservations[reserve.id]!, i = draft.admission_intents[r.intent_id]!;
    i.admission_id = value.admission.id; i.status = "committed"; i.updated_at = at; r.status = "committed"; bump(r, at); });
  return reserveView(tx, reserve.id);
}
/** Projection-only exclusion after exact private ownership/binding checks. Charges and uncertainty are never removed. */
function excludingOwn(ledger: BudgetLedger, reserve: BudgetReservation): BudgetLedger {
  known(reserve); check(reserve.status === "committed" || reserve.status === "active", "invalid-transition");
  const projection = clone(ledger), own = projection.reservations[reserve.id]!; own.held = zero();
  if (!runs(ledger, reserve).some((charge) => charge.status === "running")) own.status = "settled";
  assertBudgetLedger(projection); return projection;
}
function taskReady(tx: BudgetTransaction, value: BoundTaskInput) {
  assertBudgetAdmission(value.persisted_admission); taskStatic(value);
  const view = readBudgetTransaction(tx), reserve = bound(view.ledger, value.admission, value.persisted_admission); known(reserve);
  check(view.ledger.admission_intents[reserve.intent_id]!.status === "committed" && view.ledger.admission_intents[reserve.intent_id]!.admission_id === value.admission.id);
  if (value.admission.caps.corrections > 0) lineage(taskSubject(value.admission), value.correction_lineages);
  return { ...view, reserve };
}
function ownedAvailability(ledger: BudgetLedger, reserve: BudgetReservation, subject: BudgetSubject, at: string, caps: BudgetAmounts, options: PolicyInput): ResolvedBudgetPolicy {
  const projection = excludingOwn(ledger, reserve);
  const current = resolution(projection, subject, at, caps, options), original = resolution(projection, subject, reserve.created_at, caps, options);
  const restrictive = clone(current);
  for (const dimension of BUDGET_DIMENSIONS) {
    const now = current.dimensions[dimension].remaining, then = original.dimensions[dimension].remaining;
    restrictive.dimensions[dimension].remaining = now === null || then === null ? null : Math.min(now, then);
  }
  return restrictive;
}
export function topUpTaskBudget(tx: BudgetTransaction, value: BoundTaskInput): BudgetReservation {
  input(value, ["admission", "persisted_admission", "source"], policyOptions);
  const { ledger, at, reserve } = taskReady(tx, value), previous = runs(ledger, reserve);
  check((reserve.status === "active" || reserve.status === "committed") && previous.length > 0 && previous.every((charge) => charge.status === "terminal" && charge.runtime_state === "complete" && charge.usage_state === "complete"), "invalid-transition");
  if (reserve.held.attempts === 1) return reserve;
  const wanted = taskHolds(value.admission), consumed = sum(previous.map((charge) => charge.observed_total_tokens!));
  check(previous.length < value.admission.caps.attempts && (wanted.review_attempts === 0 || previous.length < value.admission.caps.review_attempts), "budget-unavailable");
  wanted.total_tokens = Math.max(0, wanted.total_tokens - consumed); wanted.review_total_tokens = wanted.review_attempts > 0 ? wanted.total_tokens : 0;
  check(wanted.total_tokens > 0 && reserve.held.total_tokens === wanted.total_tokens, "budget-unavailable");
  wanted.corrections = 0;
  const resolved = ownedAvailability(ledger, reserve, taskSubject(value.admission), at, value.admission.caps, value);
  const remaining = resolved.dimensions.runtime_ms.remaining, reviewRemaining = wanted.review_attempts ? resolved.dimensions.review_runtime_ms.remaining : wanted.runtime_ms;
  check(remaining !== null && reviewRemaining !== null, "budget-unavailable"); wanted.runtime_ms = Math.min(wanted.runtime_ms, remaining, reviewRemaining);
  wanted.review_runtime_ms = wanted.review_attempts ? wanted.runtime_ms : 0; check(wanted.runtime_ms > 0, "budget-unavailable"); fits(wanted, resolved);
  updateBudgetTransaction(tx, (draft) => { const own = draft.reservations[reserve.id]!; own.held = clone(wanted); own.status = "committed"; bump(own, at); });
  return reserveView(tx, reserve.id);
}
type ClaimResult = { status: "claimed" | "already-claimed"; charge: BudgetRunCharge };
const chargeId = (run: string) => `charge-${createHash("sha256").update(run).digest("hex")}`;
function claim(tx: BudgetTransaction, reserve: BudgetReservation, runId: string, review: boolean, correction: boolean): ClaimResult {
  check(identifier(runId)); const { ledger } = readBudgetTransaction(tx), id = chargeId(runId), previous = ledger.charges[id];
  if (previous) { check(previous.reservation_id === reserve.id && previous.run_id === runId && previous.review === review && previous.correction === correction); return { status: "already-claimed", charge: previous }; }
  known(reserve); check((reserve.status === "committed" || reserve.status === "active") && reserve.held.attempts === 1 && reserve.held.runtime_ms > 0
    && reserve.held.concurrent_reads + reserve.held.concurrent_writes === 1 && runs(ledger, reserve).every((charge) => charge.status === "terminal" && charge.runtime_state === "complete" && charge.usage_state === "complete"), "invalid-transition");
  updateBudgetTransaction(tx, (draft, at) => {
    const own = draft.reservations[reserve.id]!; own.held.attempts = 0; own.held.review_attempts = 0; own.held.corrections = 0;
    own.status = "active"; own.run_ids.push(runId); bump(own, at);
    // Before effects: one proven claim, zero measured active elapsed time and zero usage so far.
    // An absent/invalid first final receipt never inherits this operational zero as completeness.
    draft.charges[id] = { id, subject_id: own.subject_id, reservation_id: own.id, run_id: runId, attempts: 1, runtime_ms: 0,
      observed_total_tokens: 0, runtime_state: "complete", usage_state: "complete", status: "running", review, correction, created_at: at, updated_at: at };
  });
  return { status: "claimed", charge: readBudgetTransaction(tx).ledger.charges[id]! };
}
export function claimTaskBudget(tx: BudgetTransaction, value: BoundTaskInput & { run_id: string }): ClaimResult {
  input(value, ["admission", "persisted_admission", "source", "run_id"], policyOptions);
  check(identifier(value.run_id));
  const { ledger, at, reserve } = taskReady(tx, value);
  const prior = ledger.charges[chargeId(value.run_id)];
  if (!prior) fits(reserve.held, ownedAvailability(ledger, reserve, taskSubject(value.admission), at, value.admission.caps, value));
  return claim(tx, reserve, value.run_id, value.admission.caps.review_attempts > 0, value.admission.caps.corrections > 0);
}
type OccurrenceInput = PolicyInput & { subject: BudgetOccurrenceSubject; reservation_id: string; intent_id: string; runtime_ms: number };
export function reserveOccurrenceBudget(tx: BudgetTransaction, value: OccurrenceInput): BudgetReservation {
  input(value, ["subject", "reservation_id", "intent_id", "runtime_ms", "source"], ["constraints"]);
  const { ledger, at } = readBudgetTransaction(tx); check(count(value.runtime_ms) && value.runtime_ms > 0 && value.runtime_ms <= 60000 && identifier(value.intent_id));
  const caps = occurrenceCaps(value.runtime_ms), resolved = resolution(ledger, value.subject, at, caps, value);
  const expected = budgetOccurrenceIntentId({ subject: value.subject, reservation_id: value.reservation_id, runtime_ms: value.runtime_ms, policy_bindings: resolved.policy_bindings, cap_fingerprint: resolved.cap_fingerprint, created_at: at });
  check(value.intent_id === expected); fits(caps, resolved);
  updateBudgetTransaction(tx, (draft) => addReservation(draft, value.subject, newReservation(value.reservation_id, value.subject.id, value.intent_id, resolved.policy_bindings, caps, at)));
  return reserveView(tx, value.reservation_id);
}
export function commitOccurrenceBudget(tx: BudgetTransaction, value: { subject_id: string; reservation_id: string; intent_id: string }): BudgetReservation {
  input(value, ["subject_id", "reservation_id", "intent_id"]); check(identifier(value.subject_id) && identifier(value.reservation_id) && identifier(value.intent_id));
  const { ledger } = readBudgetTransaction(tx), reserve = ledger.reservations[value.reservation_id];
  check(!!reserve && ledger.subjects[value.subject_id]?.kind === "occurrence" && reserve.subject_id === value.subject_id && reserve.intent_id === value.intent_id);
  known(reserve); if (reserve.status === "committed" || reserve.status === "active" || reserve.status === "settled") return reserve;
  check(reserve.status === "pending", "invalid-transition");
  updateBudgetTransaction(tx, (draft, at) => { const own = draft.reservations[reserve.id]!, intent = draft.admission_intents[own.intent_id]!; intent.status = "committed"; intent.updated_at = at; own.status = "committed"; bump(own, at); });
  return reserveView(tx, reserve.id);
}
export function claimOccurrenceBudget(tx: BudgetTransaction, value: { reservation_id: string; run_id: string; source: BudgetPolicySource; constraints?: ExistingBudgetConstraint[] }): ClaimResult {
  input(value, ["reservation_id", "run_id", "source"], ["constraints"]); check(identifier(value.reservation_id) && identifier(value.run_id));
  const { ledger, at } = readBudgetTransaction(tx), reserve = ledger.reservations[value.reservation_id];
  check(!!reserve); const subject = ledger.subjects[reserve.subject_id]!; check(subject.kind === "occurrence"); known(reserve);
  check(ledger.admission_intents[reserve.intent_id]!.status === "committed");
  const prior = ledger.charges[chargeId(value.run_id)];
  if (!prior) {
    check(reserve.run_ids.length === 0, "invalid-transition");
    const caps = occurrenceCaps(reserve.held.runtime_ms), original = resolution(undefined, subject, reserve.created_at, caps, value);
    check(equal(original.policy_bindings, reserve.policy_bindings) && reserve.intent_id === budgetOccurrenceIntentId({ subject, reservation_id: reserve.id, runtime_ms: caps.runtime_ms, policy_bindings: original.policy_bindings, cap_fingerprint: original.cap_fingerprint, created_at: reserve.created_at }));
    fits(reserve.held, ownedAvailability(ledger, reserve, subject, at, caps, value));
  }
  return claim(tx, reserve, value.run_id, false, false);
}
function unknown(draft: BudgetLedger, reserve: BudgetReservation, at: string): void {
  const subject = draft.subjects[reserve.subject_id]!;
  const uncertain = subject.kind === "occurrence" ? ["attempts", "runtime_ms", "concurrent_reads"] as const
    : BUDGET_DIMENSIONS.filter((dimension) => reserve.held[dimension] > 0 || dimension === "attempts" || dimension === "runtime_ms" || dimension === "total_tokens" || runs(draft, reserve).some((charge) => charge.review && dimension.startsWith("review_") || charge.correction && dimension === "corrections"));
  reserve.status = "unknown"; reserve.uncertain_dimensions = BUDGET_DIMENSIONS.filter((dimension) => reserve.uncertain_dimensions.includes(dimension) || (uncertain as readonly string[]).includes(dimension)); bump(reserve, at);
  const intent = draft.admission_intents[reserve.intent_id]!; intent.status = "unknown"; intent.updated_at = at;
}
export function markBudgetUnknown(tx: BudgetTransaction, value: { reservation_id: string }): BudgetReservation {
  input(value, ["reservation_id"]); check(identifier(value.reservation_id)); const { ledger } = readBudgetTransaction(tx), reserve = ledger.reservations[value.reservation_id]; check(!!reserve);
  if (reserve.status === "unknown") return reserve;
  check(reserve.status !== "settled", "invalid-transition"); updateBudgetTransaction(tx, (draft, at) => unknown(draft, draft.reservations[reserve.id]!, at));
  return reserveView(tx, reserve.id);
}
export function observeBudgetRun(tx: BudgetTransaction, value: { reservation_id: string; run_id: string; runtime_ms?: unknown; total_tokens?: unknown; terminal: boolean }): BudgetRunCharge {
  input(value, ["reservation_id", "run_id", "terminal"], ["runtime_ms", "total_tokens"], ["runtime_ms", "total_tokens"]);
  check(identifier(value.reservation_id) && identifier(value.run_id) && typeof value.terminal === "boolean");
  const { ledger } = readBudgetTransaction(tx), id = chargeId(value.run_id), before = ledger.charges[id], reserve = ledger.reservations[value.reservation_id];
  check(!!before && !!reserve && before.reservation_id === reserve.id); const occurrence = ledger.subjects[reserve.subject_id]!.kind === "occurrence";
  check(!occurrence || value.total_tokens === 0);
  const measuredRuntime = value.runtime_ms, measuredTokens = value.total_tokens;
  const runtimeKnown = count(measuredRuntime), tokensKnown = count(measuredTokens);
  const runtime = runtimeKnown ? Math.max(before.runtime_ms, measuredRuntime) : before.runtime_ms;
  const tokens = tokensKnown ? Math.max(before.observed_total_tokens ?? 0, measuredTokens) : before.observed_total_tokens;
  const definitive = before.status === "terminal";
  if (definitive && runtime === before.runtime_ms && tokens === before.observed_total_tokens) return before;
  if (!definitive && !value.terminal && runtime === before.runtime_ms && tokens === before.observed_total_tokens
    && (runtimeKnown || before.runtime_state === "unknown") && (tokensKnown || before.usage_state === "unknown")) return before;
  updateBudgetTransaction(tx, (draft, at) => {
    const charge = draft.charges[id]!, own = draft.reservations[reserve.id]!;
    const runtimeDelta = runtime - charge.runtime_ms, tokenDelta = (tokens ?? 0) - (charge.observed_total_tokens ?? 0);
    const wasUnknown = own.status === "unknown";
    charge.runtime_ms = runtime; charge.observed_total_tokens = tokens; charge.updated_at = at;
    if (!definitive) {
      if (!runtimeKnown) charge.runtime_state = "unknown"; if (!tokensKnown) charge.usage_state = "unknown";
      if (value.terminal) charge.status = "terminal";
    }
    if (!definitive && (!runtimeKnown || !tokensKnown)) unknown(draft, own, at);
    else if (!wasUnknown && own.status !== "settled") {
      const previousHeld = clone(own.held);
      // Runtime belongs to this attempt's slice; late facts from a prior terminal
      // run must not debit or release its successor's slice. Tokens are cumulative.
      if (!definitive) own.held.runtime_ms = Math.max(0, own.held.runtime_ms - runtimeDelta);
      own.held.total_tokens = Math.max(0, own.held.total_tokens - tokenDelta);
      if (charge.review) {
        if (!definitive) own.held.review_runtime_ms = Math.max(0, own.held.review_runtime_ms - runtimeDelta);
        own.held.review_total_tokens = Math.max(0, own.held.review_total_tokens - tokenDelta);
      }
      if (!definitive && charge.status === "terminal") { own.held.runtime_ms = 0; own.held.review_runtime_ms = 0; }
      if (!equal(previousHeld, own.held)) bump(own, at);
    }
  });
  return readBudgetTransaction(tx).ledger.charges[id]!;
}
export function settleBudgetReservation(tx: BudgetTransaction, value: { reservation_id: string }): BudgetReservation {
  input(value, ["reservation_id"]); check(identifier(value.reservation_id)); const { ledger } = readBudgetTransaction(tx), reserve = ledger.reservations[value.reservation_id]; check(!!reserve); known(reserve);
  if (reserve.status === "settled") return reserve;
  const charges = runs(ledger, reserve); check(reserve.status === "active" && charges.length > 0 && charges.every((charge) => charge.status === "terminal" && charge.runtime_state === "complete" && charge.usage_state === "complete"), "invalid-transition");
  updateBudgetTransaction(tx, (draft, at) => { const own = draft.reservations[reserve.id]!; own.status = "settled"; own.held = zero(); bump(own, at); });
  return reserveView(tx, reserve.id);
}
