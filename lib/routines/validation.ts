import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import budgetPolicySchema from "../../schemas/budget-policy.schema.json";
import recordSchema from "../../schemas/routine-record.schema.json";
import occurrenceSchema from "../../schemas/routine-occurrence.schema.json";
import documentSchema from "../../schemas/routine-document.schema.json";
import { budgetOccurrenceIntentId } from "../budgets/reservations";
import type { BudgetOccurrenceSubject } from "../budgets/types";
import { parseRoutineSchedule, routineRevisionKey, routineSlotKey, routineTimestampEpoch } from "./schedule";
import { ROUTINE_LIMITS, type RoutineAction, type RoutineDocument, type RoutineOccurrence, type RoutineReceipt,
  type RoutineRecord, type RoutineScheduleCursor, type RoutineScope, type RoutinePolicyReference } from "./types";

/** Pure contracts only: current domain/policy validity, consent and live ownership are separate gates. */
export class RoutineContractError extends Error {
  constructor(message: string) { super(message); this.name = "RoutineContractError"; }
}
function invariant(ok: boolean, message: string): asserts ok {
  if (!ok) throw new RoutineContractError(message);
}
function epoch(value: unknown): number {
  try { return routineTimestampEpoch(value); }
  catch { throw new RoutineContractError("Invalid routine UTC timestamp"); }
}
const ajv = new Ajv2020({ strict: true, allErrors: true, ownProperties: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
ajv.addFormat("date-time", { type: "string", validate: (value: string) => {
  try { routineTimestampEpoch(value); return true; } catch { return false; }
} });
for (const schema of [budgetPolicySchema, recordSchema, occurrenceSchema, documentSchema]) ajv.addSchema(schema);
const validators = { record: ajv.getSchema(recordSchema.$id)!, occurrence: ajv.getSchema(occurrenceSchema.$id)!,
  receipt: ajv.getSchema(`${occurrenceSchema.$id}#/$defs/receipt`)!, document: ajv.getSchema(documentSchema.$id)! };

// Serialize only inspected descriptors, not untrusted objects. No accessor,
// proxy trap, toJSON or inherited serialization hook is invoked, even on failure.
function inspectJson(value: unknown, ancestors = new Set<object>(), depth = 0, budget = { bytes: 0 }): string {
  invariant(depth <= ROUTINE_LIMITS.nesting, "Routine JSON nesting exceeds limit");
  const add = (text: string): string => {
    budget.bytes += Buffer.byteLength(text, "utf8");
    invariant(budget.bytes <= ROUTINE_LIMITS.documentBytes, "Routine JSON exceeds byte limit");
    return text;
  };
  const encodeString = (input: string): string => {
    let bytes = 2;
    for (let index = 0; index < input.length; index++) {
      const unit = input.charCodeAt(index);
      if (unit === 0x22 || unit === 0x5c) bytes += 2;
      else if (unit < 0x20) bytes += [8, 9, 10, 12, 13].includes(unit) ? 2 : 6;
      else if (unit < 0x80) bytes++;
      else if (unit < 0x800) bytes += 2;
      else if (unit >= 0xd800 && unit <= 0xdbff) {
        const following = input.charCodeAt(index + 1);
        if (following >= 0xdc00 && following <= 0xdfff) { bytes += 4; index++; }
        else bytes += 6;
      } else bytes += unit >= 0xdc00 && unit <= 0xdfff ? 6 : 3;
      invariant(budget.bytes + bytes <= ROUTINE_LIMITS.documentBytes, "Routine JSON exceeds byte limit");
    }
    invariant(budget.bytes + bytes <= ROUTINE_LIMITS.documentBytes, "Routine JSON exceeds byte limit");
    return add(JSON.stringify(input));
  };
  if (value === null || typeof value === "boolean") return add(JSON.stringify(value));
  if (typeof value === "string") return encodeString(value);
  if (typeof value === "number") {
    invariant(Number.isSafeInteger(value), "Routine number is not a finite safe integer");
    return add(JSON.stringify(value));
  }
  invariant(typeof value === "object" && !nodeTypes.isProxy(value), "Routine data must be inert JSON");
  invariant(!ancestors.has(value), "Routine JSON contains a cycle");
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  invariant(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null, "Unsupported routine JSON prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  invariant(keys.every((key) => typeof key === "string"), "Routine JSON contains symbol properties");
  if (array) {
    invariant(value.length <= ROUTINE_LIMITS.records && keys.length === value.length + 1, "Routine array is sparse, decorated or oversized");
    for (let index = 0; index < value.length; index++) invariant(Object.hasOwn(descriptors, String(index)), "Routine array is sparse");
  } else invariant(keys.length <= ROUTINE_LIMITS.records, "Routine collection exceeds record limit");
  ancestors.add(value);
  try {
    add(array ? "[" : "{");
    const parts: string[] = [];
    for (const key of keys as string[]) {
      if (array && key === "length") continue;
      invariant(!["constructor", "prototype", "__proto__"].includes(key), "Routine JSON contains an unsafe property");
      const descriptor = descriptors[key]!;
      invariant(descriptor.enumerable === true && Object.hasOwn(descriptor, "value"), "Routine JSON has hooks or hidden properties");
      if (parts.length) add(",");
      let prefix = "";
      if (!array) {
        prefix = encodeString(key) + add(":");
      }
      parts.push(prefix + inspectJson(descriptor.value, ancestors, depth + 1, budget));
    }
    add(array ? "]" : "}");
    return (array ? "[" : "{") + parts.join(",") + (array ? "]" : "}");
  } finally { ancestors.delete(value); }
}
function shape<T>(validate: ValidateFunction, value: unknown, label: string): T {
  try { inspectJson(value); }
  catch (error) { if (error instanceof RoutineContractError) throw error; throw new RoutineContractError(`Invalid ${label} JSON`); }
  invariant(validate(value), `Invalid or unsupported ${label}`);
  return value as T;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));
function unique(values: string[], label: string): void { invariant(new Set(values).size === values.length, `${label} has duplicate identities`); }
function ordered(first: string, last: string): void { invariant(epoch(first) <= epoch(last), "Routine timestamps are reversed"); }
function identifier(value: unknown): asserts value is string {
  invariant(typeof value === "string" && value.length <= 160 && !["constructor", "prototype", "__proto__"].includes(value)
    && !value.includes("..") && /^[A-Za-z0-9][A-Za-z0-9._-]*$(?![\s\S])/.test(value), "Invalid routine identifier");
}
function fingerprint(value: unknown): asserts value is string {
  invariant(typeof value === "string" && /^[a-f0-9]{64}$(?![\s\S])/.test(value), "Invalid routine fingerprint");
}
function slotValid(definition: RoutineRecord, slot: string): void {
  const schedule = parseRoutineSchedule(definition.schedule);
  invariant(schedule.kind === "interval" && definition.schedule_anchor_at !== null, "Automatic occurrence requires an interval");
  const anchor = epoch(definition.schedule_anchor_at), at = epoch(slot);
  invariant(at > anchor && (at - anchor) % schedule.interval_ms === 0, "Routine slot is off-grid or precedes its first interval");
}
function recordValid(record: RoutineRecord): void {
  ordered(record.created_at, record.updated_at);
  const schedule = parseRoutineSchedule(record.schedule);
  invariant(schedule.kind === "manual" ? record.schedule_anchor_at === null
    : record.schedule_anchor_at !== null && epoch(record.schedule_anchor_at) === epoch(record.updated_at), "Schedule anchor differs from its exact revision");
}
export function assertRoutineRecord(value: unknown): asserts value is RoutineRecord {
  const record = shape<RoutineRecord>(validators.record, value, "routine record");
  try { recordValid(record); } catch (error) { if (error instanceof RoutineContractError) throw error; throw new RoutineContractError("Invalid routine schedule binding"); }
}
/** Occurrence-specific proposal identity only, never approval or publication authority. */
export function routineProposalKey(occurrenceKey: unknown, proposalFingerprint: unknown): string {
  fingerprint(occurrenceKey); fingerprint(proposalFingerprint);
  return createHash("sha256").update(`[${JSON.stringify(occurrenceKey)},${JSON.stringify(proposalFingerprint)}]`).digest("hex");
}
function receiptValid(receipt: RoutineReceipt): void {
  invariant(receipt.occurrence_key === routineSlotKey(receipt.routine_id, receipt.routine_revision, receipt.slot), "Receipt has a foreign occurrence slot");
  if (receipt.started_at !== null) ordered(receipt.started_at, receipt.captured_at);
  if (receipt.finished_at !== null) {
    ordered(receipt.finished_at, receipt.captured_at);
    if (receipt.started_at !== null) ordered(receipt.started_at, receipt.finished_at);
  }
  const usage = receipt.consumption;
  invariant(usage.runtime_state !== "complete" || usage.runtime_ms !== null && usage.attempts !== null, "Complete runtime requires proven counts, including zero");
  invariant(usage.attempts !== null || usage.runtime_state === "unknown", "Unknown attempt cannot claim complete runtime");
  invariant(usage.attempts !== 0 || receipt.started_at === null && usage.runtime_ms === 0 && usage.runtime_state === "complete", "Unstarted receipt invents execution usage");
  invariant(usage.attempts !== 1 || receipt.started_at !== null, "Claimed attempt lacks its start time");
  invariant(usage.runtime_state !== "complete" || usage.attempts === 0 || receipt.finished_at !== null, "Complete execution runtime lacks a known finish");
  invariant(usage.runtime_state !== "unknown" || ["unknown", "exhausted"].includes(receipt.budget_outcome), "Unknown runtime cannot claim available accounting");
  invariant(receipt.budget_outcome !== "denied" || usage.attempts === 0, "Pre-execution budget denial cannot hide an executed attempt");
  invariant(receipt.budget_outcome !== "denied" || receipt.failure_code !== null && receipt.next_action !== "none", "Budget denial lacks visible safe failure");
  if (receipt.budget_outcome === "unknown") invariant(receipt.freshness !== "fresh" && receipt.failure_code !== null, "Unknown accounting lacks visible failure");
  if (receipt.budget_outcome === "exhausted") invariant(receipt.freshness !== "fresh" && receipt.failure_code !== null, "Exhaustion cannot claim fresh success");
  unique(receipt.sources.map((fact) => canonical([fact.kind, fact.project_id])), "Receipt source facts");
  for (const fact of receipt.sources) {
    invariant(fact.project_id === null || receipt.project_ids.includes(fact.project_id), "Receipt source has a foreign project");
    invariant((fact.observed_at === null) === (fact.fingerprint === null), "Source observation and fingerprint are incomplete");
    invariant(fact.state === "unavailable" || fact.observed_at !== null && fact.fingerprint !== null, "Known source lacks observation evidence");
    if (fact.observed_at !== null) ordered(fact.observed_at, receipt.captured_at);
  }
  const counts = receipt.counts;
  invariant(usage.attempts !== 0 || counts.signals_evaluated === 0 && counts.proposals_created === 0
    && counts.reports_written === 0 && receipt.proposals.every((proposal) => proposal.issue_id === null), "Unstarted receipt invents action effects");
  invariant(counts.projects_selected === receipt.project_ids.length && counts.facts_total === receipt.sources.length
    && counts.facts_fresh === receipt.sources.filter((fact) => fact.state === "fresh").length
    && counts.facts_unavailable === receipt.sources.filter((fact) => fact.state === "unavailable").length, "Receipt counters differ from retained facts");
  invariant(counts.proposals_created === receipt.proposals.filter((proposal) => proposal.issue_id !== null).length, "Receipt proposal count differs from retained effects");
  invariant(counts.proposals_created === 0 || receipt.next_action === "review-proposals", "Created proposals require human review");
  invariant(receipt.action === "propose-issues" || receipt.proposals.length === 0, "This routine action cannot propose issues");
  invariant(receipt.action === "generate-local-report" || counts.reports_written === 0, "This routine action cannot write a report");
  unique(receipt.proposals.map((proposal) => proposal.key), "Receipt proposal keys");
  unique(receipt.proposals.flatMap((proposal) => proposal.issue_id === null ? [] : [proposal.issue_id]), "Receipt created issue identities");
  for (const proposal of receipt.proposals) invariant(proposal.key === routineProposalKey(receipt.occurrence_key, proposal.fingerprint), "Proposal key has a foreign occurrence binding");
  invariant(receipt.failure_code === null || receipt.next_action !== "none", "Failed receipt lacks a safe next action");
  if (receipt.freshness === "fresh") {
    invariant(receipt.sources.length > 0 && receipt.sources.every((fact) => fact.state === "fresh")
      && usage.attempts === 1 && usage.runtime_state === "complete" && receipt.finished_at !== null
      && receipt.budget_outcome === "within-limit" && receipt.failure_code === null, "Fresh result lacks complete bounded evidence");
    invariant(receipt.action !== "generate-local-report" || counts.reports_written === 1, "Fresh report lacks its actual local effect");
  }
}
export function assertRoutineReceipt(value: unknown): asserts value is RoutineReceipt {
  receiptValid(shape<RoutineReceipt>(validators.receipt, value, "routine receipt"));
}
function occurrenceValid(occurrence: RoutineOccurrence): void {
  const definition = occurrence.definition;
  recordValid(definition);
  invariant(definition.enabled || !["reserved", "running", "completed"].includes(occurrence.status)
    && occurrence.started_at === null && occurrence.owner === null && occurrence.receipt?.consumption.attempts === 0,
  "Disabled historical definition cannot admit or execute an occurrence");
  invariant(definition.id === occurrence.routine_id && definition.revision === occurrence.routine_revision, "Occurrence differs from its historical definition");
  invariant(occurrence.occurrence_key === routineSlotKey(occurrence.routine_id, occurrence.routine_revision, occurrence.slot), "Occurrence has a foreign slot identity");
  ordered(occurrence.created_at, occurrence.updated_at); ordered(definition.updated_at, occurrence.created_at); ordered(occurrence.slot, occurrence.created_at);
  if (occurrence.trigger !== "manual") slotValid(definition, occurrence.slot);
  invariant(occurrence.trigger !== "catch-up" || definition.catch_up === "run-once", "Catch-up is not opted in");
  invariant(occurrence.trigger !== "coalesced" || definition.concurrency === "coalesce", "Coalescing is not opted in");
  invariant(occurrence.project_ids.length <= definition.limits.max_projects, "Occurrence exceeds its admitted project count");
  invariant(definition.scope.kind !== "project" || occurrence.project_ids.length === 1 && occurrence.project_ids[0] === definition.scope.id, "Project routine selected a foreign project");
  const attribution = occurrence.attribution, budget = occurrence.budget;
  for (const id of attribution.objective_ids) identifier(id);
  invariant(attribution.issue_id === null && attribution.role_id === null && attribution.execution_id === occurrence.id
    && sameSet(attribution.project_ids, occurrence.project_ids), "Occurrence invents task/role or foreign attribution");
  invariant(definition.scope.kind !== "objective" || attribution.objective_ids[0] === definition.scope.id, "Occurrence lacks its selected objective anchor");
  invariant(budget.admitted_runtime_ms <= definition.limits.max_runtime_ms, "Occurrence raises its admitted runtime cap");
  invariant(sameSet(budget.policy_bindings.map((binding) => binding.policy_id), definition.policy.policy_ids)
    && budget.policy_bindings.every((binding) => binding.policy_fingerprint === definition.policy.fingerprint), "Occurrence differs from its original policy references");
  for (const binding of budget.policy_bindings) {
    const scope = binding.scope;
    invariant(scope.kind === "company" && scope.id === "surtec" || scope.kind === "objective" && attribution.objective_ids.includes(scope.id)
      || scope.kind === "project" && occurrence.project_ids.includes(scope.id) || scope.kind === "execution" && scope.id === occurrence.id, "Routine policy invents an issue, role or foreign scope");
  }
  const subject: BudgetOccurrenceSubject = { id: budget.subject_id, kind: "occurrence", occurrence_id: occurrence.id,
    routine_id: occurrence.routine_id, routine_revision: occurrence.routine_revision, slot: occurrence.slot,
    project_ids: occurrence.project_ids, attribution };
  try {
    // The existing budget helper validates a synthetic ledger by serializing it.
    // Refuse inherited serialization hooks without invoking them or changing globals.
    invariant(!Object.hasOwn(Object.prototype, "toJSON") && !Object.hasOwn(Array.prototype, "toJSON"), "Routine budget binding has unsafe serialization hooks");
    invariant(budget.intent_id === budgetOccurrenceIntentId({ subject, reservation_id: budget.reservation_id,
      policy_bindings: budget.policy_bindings, cap_fingerprint: budget.cap_fingerprint,
      runtime_ms: budget.admitted_runtime_ms, created_at: occurrence.created_at }), "Occurrence has a foreign budget intent digest");
  } catch (error) { if (error instanceof RoutineContractError) throw error; throw new RoutineContractError("Invalid routine budget binding"); }
  if (occurrence.started_at !== null) { ordered(occurrence.created_at, occurrence.started_at); ordered(occurrence.started_at, occurrence.updated_at); }
  if (occurrence.finished_at !== null) { ordered(occurrence.created_at, occurrence.finished_at); ordered(occurrence.finished_at, occurrence.updated_at); if (occurrence.started_at !== null) ordered(occurrence.started_at, occurrence.finished_at); }
  if (occurrence.cancel_requested_at !== null) { ordered(occurrence.created_at, occurrence.cancel_requested_at); ordered(occurrence.cancel_requested_at, occurrence.updated_at); }
  if (occurrence.owner !== null) {
    ordered(occurrence.created_at, occurrence.owner.claimed_at); ordered(occurrence.owner.claimed_at, occurrence.updated_at);
    invariant(occurrence.started_at !== null && epoch(occurrence.owner.claimed_at) <= epoch(occurrence.started_at), "Owner inventory lacks its exact start");
  }
  if (occurrence.status === "reserved") {
    invariant(occurrence.owner === null && occurrence.started_at === null && occurrence.finished_at === null && occurrence.receipt === null, "Unstarted occurrence invents execution or a terminal receipt");
  } else if (occurrence.status === "running") {
    invariant(occurrence.owner !== null && occurrence.started_at !== null && occurrence.finished_at === null && occurrence.receipt === null, "Running occurrence lacks its owner/start or has terminal evidence");
  } else {
    invariant(occurrence.receipt !== null, "Terminal occurrence lacks a bounded receipt");
    const receipt = occurrence.receipt;
    receiptValid(receipt);
    invariant(receipt.occurrence_id === occurrence.id && receipt.occurrence_key === occurrence.occurrence_key
      && receipt.routine_id === occurrence.routine_id && receipt.routine_revision === occurrence.routine_revision
      && epoch(receipt.slot) === epoch(occurrence.slot) && receipt.action === definition.action && same(receipt.scope, definition.scope)
      && receipt.policy_fingerprint === definition.policy.fingerprint && receipt.cap_fingerprint === budget.cap_fingerprint
      && sameSet(receipt.project_ids, occurrence.project_ids), "Receipt differs from the exact occurrence bindings");
    invariant(same(receipt.started_at, occurrence.started_at) && same(receipt.finished_at, occurrence.finished_at), "Receipt differs from the exact execution times");
    ordered(occurrence.created_at, receipt.captured_at); ordered(receipt.captured_at, occurrence.updated_at);
    invariant(occurrence.status !== "completed" || receipt.freshness === "fresh" && receipt.failure_code === null, "Completed occurrence cannot claim unknown or partial success");
    invariant(occurrence.status === "completed" || receipt.freshness !== "fresh", "Failed/partial occurrence cannot claim fresh success");
    invariant(!["failed", "cancelled", "needs-review"].includes(occurrence.status)
      || receipt.failure_code !== null && receipt.next_action !== "none", "Failed terminal occurrence lacks visible safe failure");
    invariant(occurrence.status !== "cancelled" || occurrence.cancel_requested_at !== null && receipt.failure_code === "cancelled",
      "Cancelled occurrence lacks its exact request and failure");
    invariant(occurrence.status === "needs-review" || occurrence.finished_at !== null, "Known terminal occurrence lacks a finish time");
    if (receipt.consumption.runtime_ms !== null && receipt.consumption.runtime_ms > budget.admitted_runtime_ms) {
      invariant(receipt.budget_outcome === "exhausted" || receipt.consumption.runtime_state === "unknown" && receipt.budget_outcome === "unknown", "Measured runtime excess was hidden as within-limit");
    }
  }
}
export function assertRoutineOccurrence(value: unknown): asserts value is RoutineOccurrence {
  const occurrence = shape<RoutineOccurrence>(validators.occurrence, value, "routine occurrence");
  try { occurrenceValid(occurrence); } catch (error) { if (error instanceof RoutineContractError) throw error; throw new RoutineContractError("Invalid routine occurrence binding"); }
}
function cursorValid(cursor: RoutineScheduleCursor, definition: RoutineRecord, updatedAt: string): void {
  invariant(cursor.routine_id === definition.id && cursor.routine_revision === definition.revision, "Cursor differs from its configuration revision");
  ordered(definition.updated_at, cursor.evaluated_at); ordered(cursor.evaluated_at, updatedAt);
  if (cursor.last_slot !== null) { slotValid(definition, cursor.last_slot); ordered(cursor.last_slot, cursor.evaluated_at); }
  if (cursor.pending_slot !== null) {
    slotValid(definition, cursor.pending_slot);
    invariant(definition.concurrency === "coalesce" && cursor.last_slot !== null && epoch(cursor.pending_slot) === epoch(cursor.last_slot), "Cursor invents another pending slot");
  }
}
export function assertRoutineDocument(value: unknown): asserts value is RoutineDocument {
  const document = shape<RoutineDocument>(validators.document, value, "routine document");
  try {
    ordered(document.created_at, document.updated_at);
    const histories = new Map<string, RoutineRecord[]>();
    for (const [key, definition] of Object.entries(document.definitions)) {
      recordValid(definition); ordered(definition.updated_at, document.updated_at);
      invariant(key === routineRevisionKey(definition.id, definition.revision) && Object.hasOwn(document.routines, definition.id), "Orphaned or aliased routine definition");
      const history = histories.get(definition.id) ?? []; history.push(definition); histories.set(definition.id, history);
    }
    for (const [id, current] of Object.entries(document.routines)) {
      recordValid(current); invariant(id === current.id, "Routine map key differs from identity");
      const history = histories.get(id) ?? [];
      invariant(history.length === current.revision && history.length <= ROUTINE_LIMITS.records, "Routine revision history is incomplete");
      history.sort((a, b) => a.revision - b.revision);
      for (let index = 0; index < history.length; index++) {
        const definition = history[index]!;
        invariant(definition.revision === index + 1 && definition.created_at === current.created_at, "Routine history rewrites its identity or original creation time");
        if (index > 0) ordered(history[index - 1]!.updated_at, definition.updated_at);
      }
      invariant(same(history.at(-1), current), "Current routine differs from its exact latest definition");
    }
    const occurrences = Object.values(document.occurrences);
    unique(occurrences.map((entry) => entry.occurrence_key), "Routine occurrence slots");
    unique(occurrences.map((entry) => entry.budget.subject_id), "Routine budget subjects");
    unique(occurrences.map((entry) => entry.budget.reservation_id), "Routine budget reservations");
    unique(occurrences.map((entry) => entry.budget.intent_id), "Routine budget intents");
    unique(occurrences.flatMap((entry) => entry.owner === null ? [] : [entry.owner.run_id]), "Routine run identities");
    unique(occurrences.flatMap((entry) => entry.receipt?.proposals.map((proposal) => proposal.key) ?? []), "Global routine proposal keys");
    unique(occurrences.flatMap((entry) => entry.receipt?.proposals.flatMap((proposal) => proposal.issue_id === null ? [] : [proposal.issue_id]) ?? []),
      "Global routine created issue identities");
    invariant(occurrences.filter((entry) => entry.status === "running").length <= 1, "More than one routine is running");
    for (const [id, occurrence] of Object.entries(document.occurrences)) {
      invariant(id === occurrence.id, "Occurrence map key differs from identity"); occurrenceValid(occurrence); ordered(occurrence.updated_at, document.updated_at);
      const original = document.definitions[routineRevisionKey(occurrence.routine_id, occurrence.routine_revision)];
      invariant(!!original && same(original, occurrence.definition), "Occurrence rewrites or omits its immutable historical definition");
    }
    for (const [key, cursor] of Object.entries(document.cursors)) {
      const definition = document.definitions[key];
      invariant(!!definition && key === routineRevisionKey(cursor.routine_id, cursor.routine_revision), "Orphaned or aliased routine cursor");
      cursorValid(cursor, definition, document.updated_at);
      if (cursor.pending_slot !== null) invariant(!occurrences.some((entry) => entry.occurrence_key === routineSlotKey(cursor.routine_id, cursor.routine_revision, cursor.pending_slot)), "Pending slot already has a durable occurrence");
    }
  } catch (error) { if (error instanceof RoutineContractError) throw error; throw new RoutineContractError("Invalid routine document binding"); }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export function createRoutineDraft(input: { id: string; action: RoutineAction; scope: RoutineScope; policy: RoutinePolicyReference; at: string }): Readonly<RoutineRecord> {
  const encoded = inspectJson(input), detached = JSON.parse(encoded) as typeof input;
  invariant(detached !== null && typeof detached === "object" && !Array.isArray(detached)
    && Object.keys(detached).length === 5 && ["id", "action", "scope", "policy", "at"].every((key) => Object.hasOwn(detached, key)), "Invalid routine draft fields");
  const record: RoutineRecord = { schema_version: 1, id: detached.id, revision: 1, action: detached.action, scope: detached.scope,
    enabled: false, schedule: null, schedule_anchor_at: null, concurrency: "skip", catch_up: "skip-missed", policy: detached.policy,
    limits: { max_projects: ROUTINE_LIMITS.projects, max_attempts: 1, max_runtime_ms: ROUTINE_LIMITS.runtimeMs, max_concurrent_occurrences: 1 },
    created_at: detached.at, updated_at: detached.at };
  assertRoutineRecord(record); return freeze(record);
}
