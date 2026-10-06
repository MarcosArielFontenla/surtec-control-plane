import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { ROUTINE_LIMITS, type RoutineRecord, type RoutineScheduleCursor, type RoutineOccurrence, type RoutineOccurrenceStatus } from "./types";

/** Invalid data is not a schedule, a persisted owner, or permission to execute. */
export class RoutineScheduleError extends Error {
  constructor(message: string) { super(message); this.name = "RoutineScheduleError"; }
}
function invariant(value: boolean, message: string): asserts value {
  if (!value) throw new RoutineScheduleError(message);
}
export type ParsedRoutineSchedule = Readonly<{ kind: "manual" }> | Readonly<{ kind: "interval"; minutes: number; interval_ms: number }>;
export function parseRoutineSchedule(value: unknown): ParsedRoutineSchedule {
  if (value === null) return Object.freeze({ kind: "manual" });
  invariant(typeof value === "string" && value.length <= 12, "Invalid routine schedule grammar");
  const match = /^every:([1-9][0-9]*)m$/.exec(value);
  invariant(!!match && match[0] === value, "Invalid routine schedule grammar");
  const minutes = Number(match[1]);
  invariant(Number.isSafeInteger(minutes) && minutes >= ROUTINE_LIMITS.minimumMinutes && minutes <= ROUTINE_LIMITS.maximumMinutes,
    "Routine interval is outside approved bounds");
  return Object.freeze({ kind: "interval", minutes, interval_ms: minutes * 60000 });
}
/** UTC only; calendar rollover, local offsets, coercion and leap seconds are refused. */
export function routineTimestampEpoch(value: unknown): number {
  invariant(typeof value === "string", "Invalid routine UTC timestamp");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/.exec(value);
  invariant(!!match && match[0] === value, "Invalid routine UTC timestamp");
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  invariant(year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!
    && hour <= 23 && minute <= 59 && second <= 59, "Invalid routine UTC calendar date");
  const epoch = Date.parse(value);
  invariant(Number.isSafeInteger(epoch), "Invalid routine UTC timestamp");
  return epoch;
}
function identifier(value: unknown): asserts value is string {
  invariant(typeof value === "string" && !value.includes("..") && !["constructor", "prototype", "__proto__"].includes(value), "Invalid routine identifier");
  const match = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.exec(value);
  invariant(!!match && match[0] === value, "Invalid routine identifier");
}
function revision(value: unknown): asserts value is number {
  invariant(typeof value === "number" && Number.isSafeInteger(value) && value >= 1, "Invalid routine revision");
}
export function routineRevisionKey(id: unknown, value: unknown): string {
  identifier(id); revision(value);
  // The validated identifier is unescaped ASCII; scalar tuple encoding cannot
  // invoke an inherited Object/Array.toJSON or change the existing JSON digest.
  return createHash("sha256").update(`["${id}",${value}]`).digest("hex");
}
export function routineSlotKey(id: unknown, value: unknown, slot: unknown): string {
  identifier(id); revision(value);
  return createHash("sha256").update(`["${id}",${value},${routineTimestampEpoch(slot)}]`).digest("hex");
}
function timestamp(epoch: number): string {
  invariant(Number.isSafeInteger(epoch), "Routine schedule arithmetic overflow");
  const value = new Date(epoch).toISOString();
  routineTimestampEpoch(value);
  return value;
}
function addBytes(budget: { bytes: number }, bytes: number): void {
  budget.bytes += bytes;
  invariant(budget.bytes <= ROUTINE_LIMITS.documentBytes, "Routine schedule input exceeds byte bounds");
}
/** Count JSON escaped UTF8 directly, without encoding an oversized string. */
function countStringBytes(value: string, budget: { bytes: number }): void {
  addBytes(budget, 2);
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0x22 || unit === 0x5c) addBytes(budget, 2);
    else if (unit < 0x20) addBytes(budget, [8, 9, 10, 12, 13].includes(unit) ? 2 : 6);
    else if (unit < 0x80) addBytes(budget, 1);
    else if (unit < 0x800) addBytes(budget, 2);
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (following >= 0xdc00 && following <= 0xdfff) { addBytes(budget, 4); index++; }
      else addBytes(budget, 6);
    } else addBytes(budget, unit >= 0xdc00 && unit <= 0xdfff ? 6 : 3);
  }
}
// Inspect descriptors and count the expanded aggregate before allocation. Shared
// references are counted each time, exactly as JSON would serialize them.
function plainJson(value: unknown, parents = new Set<object>(), depth = 0, budget = { bytes: 0 }): void {
  invariant(depth <= ROUTINE_LIMITS.nesting, "Routine schedule input is too deeply nested");
  if (value === null || typeof value === "boolean") { addBytes(budget, value === false ? 5 : 4); return; }
  if (typeof value === "string") { countStringBytes(value, budget); return; }
  if (typeof value === "number") {
    invariant(Number.isSafeInteger(value), "Routine schedule number is not a safe integer"); addBytes(budget, `${value}`.length); return;
  }
  invariant(typeof value === "object" && !nodeTypes.isProxy(value), "Routine schedule requires inert JSON data");
  invariant(!parents.has(value), "Routine schedule input contains a cycle");
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  invariant(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null, "Unsupported routine schedule prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  invariant(keys.every((key) => typeof key === "string"), "Routine schedule input contains symbols");
  if (array) {
    invariant(value.length <= ROUTINE_LIMITS.records && keys.length === value.length + 1, "Routine schedule array is oversized, decorated or sparse");
    for (let index = 0; index < value.length; index++) invariant(Object.hasOwn(descriptors, String(index)), "Routine schedule array is sparse");
  } else invariant(keys.length <= ROUTINE_LIMITS.records, "Routine schedule input exceeds record bounds");
  parents.add(value);
  try {
    addBytes(budget, 1); let first = true;
    for (const key of keys as string[]) {
      if (array && key === "length") continue;
      invariant(key !== "__proto__" && key !== "prototype" && key !== "constructor", "Routine schedule input has an unsafe property");
      const descriptor = descriptors[key]!;
      invariant(descriptor.enumerable === true && Object.hasOwn(descriptor, "value"), "Routine schedule input has hooks or hidden data");
      if (!first) addBytes(budget, 1); first = false;
      if (!array) { countStringBytes(key, budget); addBytes(budget, 1); }
      plainJson(descriptor.value, parents, depth + 1, budget);
    }
    addBytes(budget, 1);
  } finally { parents.delete(value); }
}
function exactKeys(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), "Invalid routine schedule projection");
  invariant(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)), "Invalid routine schedule projection fields");
}
export type RoutineScheduleDefinition = Pick<RoutineRecord, "id" | "revision" | "enabled" | "schedule" | "schedule_anchor_at" | "concurrency" | "catch_up">;
export type RoutineScheduleOccurrence = Pick<RoutineOccurrence, "routine_id" | "routine_revision" | "slot" | "status">;
export interface RoutineScheduleInput {
  routine: RoutineScheduleDefinition; now: string; cursor: RoutineScheduleCursor | null;
  occurrences: readonly RoutineScheduleOccurrence[]; occupancy: "idle" | "busy" | "ambiguous"; trigger: "tick" | "restart" | "manual";
}
interface ScheduleResultBase { readonly cursor: Readonly<RoutineScheduleCursor>; readonly next_slot: string | null }
export type RoutineSchedulePlan =
  | Readonly<ScheduleResultBase & { kind: "none"; reason: "disabled" | "manual-only" | "not-due" | "already-considered" | "already-recorded" | "busy-skipped" | "restart-skipped" }>
  | Readonly<ScheduleResultBase & { kind: "admit" | "coalesce"; slot: string; occurrence_key: string; trigger: RoutineOccurrence["trigger"] }>
  | Readonly<ScheduleResultBase & { kind: "needs-review"; reason: "ownership-unavailable" | "unresolved-occurrence" }>;
const statuses: readonly RoutineOccurrenceStatus[] = ["reserved", "running", "completed", "partial", "failed", "cancelled", "needs-review"];

/** An informational, finite plan only. The caller must separately prove and persist admission and live ownership. */
export function planRoutineSchedule(input: RoutineScheduleInput): RoutineSchedulePlan {
  plainJson(input);
  exactKeys(input, ["routine", "now", "cursor", "occurrences", "occupancy", "trigger"]);
  exactKeys(input.routine, ["id", "revision", "enabled", "schedule", "schedule_anchor_at", "concurrency", "catch_up"]);
  const routine = input.routine;
  identifier(routine.id); revision(routine.revision);
  invariant(typeof routine.enabled === "boolean" && ["skip", "coalesce"].includes(routine.concurrency)
    && ["skip-missed", "run-once"].includes(routine.catch_up), "Invalid routine schedule policies");
  invariant(["idle", "busy", "ambiguous"].includes(input.occupancy) && ["tick", "restart", "manual"].includes(input.trigger), "Invalid routine schedule observation");
  const schedule = parseRoutineSchedule(routine.schedule), now = routineTimestampEpoch(input.now);
  const anchor = schedule.kind === "interval" ? routineTimestampEpoch(routine.schedule_anchor_at) : null;
  invariant(schedule.kind !== "manual" || routine.schedule_anchor_at === null, "Manual routine cannot have an interval anchor");
  invariant(anchor === null || anchor <= now, "Routine anchor is in the future");
  const aligned = (slot: string): number => {
    const epoch = routineTimestampEpoch(slot);
    invariant(epoch <= now && schedule.kind === "interval" && anchor !== null && epoch > anchor
      && (epoch - anchor) % schedule.interval_ms === 0, "Routine cursor slot is future, off-grid or before its first interval");
    return epoch;
  };
  let last: number | null = null, pending: number | null = null;
  if (input.cursor !== null) {
    exactKeys(input.cursor, ["schema_version", "routine_id", "routine_revision", "evaluated_at", "last_slot", "pending_slot"]);
    invariant(input.cursor.schema_version === 1 && input.cursor.routine_id === routine.id && input.cursor.routine_revision === routine.revision,
      "Routine cursor differs from its configuration revision");
    const evaluated = routineTimestampEpoch(input.cursor.evaluated_at);
    invariant(evaluated <= now && (anchor === null || evaluated >= anchor), "Routine clock cannot move behind its cursor or configuration");
    if (input.cursor.last_slot !== null) last = aligned(input.cursor.last_slot);
    if (input.cursor.pending_slot !== null) pending = aligned(input.cursor.pending_slot);
    invariant(last === null || last <= evaluated, "Routine cursor slot exceeds its observation");
    invariant(pending === null || routine.concurrency === "coalesce" && pending === last, "Routine pending slot differs from its coalesced latest high-water");
  }
  invariant(Array.isArray(input.occurrences) && input.occurrences.length <= ROUTINE_LIMITS.records, "Routine occurrence inventory exceeds bounds");
  const seen = new Set<string>(); let unresolved = false, active = false;
  for (const occurrence of input.occurrences) {
    exactKeys(occurrence, ["routine_id", "routine_revision", "slot", "status"]);
    identifier(occurrence.routine_id); revision(occurrence.routine_revision);
    invariant(statuses.some((status) => status === occurrence.status), "Invalid routine occurrence status");
    const epoch = routineTimestampEpoch(occurrence.slot);
    invariant(epoch <= now, "Routine inventory has a future slot");
    const key = routineSlotKey(occurrence.routine_id, occurrence.routine_revision, occurrence.slot);
    invariant(!seen.has(key), "Routine inventory aliases a revision/slot"); seen.add(key);
    active ||= occurrence.status === "reserved" || occurrence.status === "running";
    if (occurrence.routine_id !== routine.id) continue;
    unresolved ||= occurrence.status === "needs-review";
  }
  const cursor = (): Readonly<RoutineScheduleCursor> => Object.freeze({ schema_version: 1, routine_id: routine.id,
    routine_revision: routine.revision, evaluated_at: timestamp(now), last_slot: last === null ? null : timestamp(last),
    pending_slot: pending === null ? null : timestamp(pending) });
  const next = schedule.kind === "interval" && anchor !== null
    ? timestamp(anchor + (Math.floor((now - anchor) / schedule.interval_ms) + 1) * schedule.interval_ms) : null;
  const none = (reason: Extract<RoutineSchedulePlan, { kind: "none" }>["reason"]): RoutineSchedulePlan => Object.freeze({ kind: "none", reason, cursor: cursor(), next_slot: next });
  const review = (reason: "ownership-unavailable" | "unresolved-occurrence"): RoutineSchedulePlan => Object.freeze({ kind: "needs-review", reason, cursor: cursor(), next_slot: next });
  const selected = (kind: "admit" | "coalesce", slot: number, trigger: RoutineOccurrence["trigger"]): RoutineSchedulePlan => Object.freeze({
    kind, slot: timestamp(slot), occurrence_key: routineSlotKey(routine.id, routine.revision, timestamp(slot)), trigger, cursor: cursor(), next_slot: next,
  });
  if (unresolved) return review("unresolved-occurrence");
  if (input.occupancy === "ambiguous" || active && (input.trigger === "restart" || input.occupancy === "idle")) return review("ownership-unavailable");
  if (!routine.enabled) return none("disabled");
  if (input.trigger === "manual") {
    if (seen.has(routineSlotKey(routine.id, routine.revision, input.now))) return none("already-recorded");
    if (input.occupancy === "busy") return none("busy-skipped");
    return selected("admit", now, "manual");
  }
  if (schedule.kind === "manual") return none("manual-only");
  const latest = anchor! + Math.floor((now - anchor!) / schedule.interval_ms) * schedule.interval_ms;
  const due = latest > anchor! && (last === null || latest > last);
  if (input.trigger === "restart" && routine.catch_up === "skip-missed") {
    if (latest > anchor! && (last === null || latest > last)) last = latest;
    pending = null;
    return none("restart-skipped");
  }
  if (due) last = latest;
  const slot = due ? latest : pending;
  if (slot === null) return none(latest <= anchor! ? "not-due" : "already-considered");
  if (seen.has(routineSlotKey(routine.id, routine.revision, timestamp(slot)))) {
    pending = null; return none("already-recorded");
  }
  if (input.occupancy === "busy") {
    if (routine.concurrency === "skip") { pending = null; return none("busy-skipped"); }
    pending = slot; return selected("coalesce", slot, "coalesced");
  }
  const wasPending = pending !== null; pending = null;
  return selected("admit", slot, input.trigger === "restart" ? "catch-up" : wasPending ? "coalesced" : "scheduled");
}
