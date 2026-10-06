import { describe, expect, it, vi } from "vitest";
import { parseRoutineSchedule, planRoutineSchedule, routineRevisionKey, routineSlotKey, routineTimestampEpoch,
  RoutineScheduleError, type RoutineScheduleInput, type RoutineScheduleOccurrence } from "./schedule";
import { ROUTINE_LIMITS, type RoutineScheduleCursor } from "./types";

const anchor = "2026-10-06T10:00:00Z";
const slot15 = "2026-10-06T10:15:00.000Z", slot30 = "2026-10-06T10:30:00.000Z", slot45 = "2026-10-06T10:45:00.000Z";
function fixture(): RoutineScheduleInput {
  return { routine: { id: "routine-1", revision: 1, enabled: true, schedule: "every:15m", schedule_anchor_at: anchor,
    concurrency: "skip", catch_up: "skip-missed" }, now: "2026-10-06T10:31:00Z", cursor: null, occurrences: [], occupancy: "idle", trigger: "tick" };
}
function cursor(last: string | null, pending: string | null = null, evaluated = "2026-10-06T10:31:00Z"): RoutineScheduleCursor {
  return { schema_version: 1, routine_id: "routine-1", routine_revision: 1, evaluated_at: evaluated, last_slot: last, pending_slot: pending };
}
function occurrence(status: RoutineScheduleOccurrence["status"], slot = slot30, revision = 1, id = "routine-1"): RoutineScheduleOccurrence {
  return { routine_id: id, routine_revision: revision, slot, status };
}
function rejectsWithoutMutation(value: RoutineScheduleInput): void {
  const before = structuredClone(value); expect(() => planRoutineSchedule(value)).toThrow(RoutineScheduleError); expect(value).toEqual(before);
}

describe("parseRoutineSchedule", () => {
  it("recognizes explicit manual without defaults, side effects or mutable output", () => {
    expect(parseRoutineSchedule(null)).toEqual({ kind: "manual" }); expect(Object.isFrozen(parseRoutineSchedule(null))).toBe(true);
  });
  it.each([15, 16, 60, 1440, 10079, 10080])("accepts bounded integer interval %s", (minutes) => {
    const result = parseRoutineSchedule(`every:${minutes}m`);
    expect(result).toEqual({ kind: "interval", minutes, interval_ms: minutes * 60000 }); expect(Object.isFrozen(result)).toBe(true);
  });
  it.each([undefined, true, false, 15, 0, NaN, Infinity, {}, [], new String("every:15m"), "", "manual", "null", "every:0m",
    "every:1m", "every:14m", "every:10081m", "every:9007199254740991m", "every:015m", "every:00015m", "every:+15m", "every:-15m",
    "every:15.0m", "every:15.5m", "every:1e2m", "every:0xfm", "every:15M", "EVERY:15m", "every:15h", "every:15s",
    " every:15m", "every:15m ", "every: 15m", "every:15 m", "every:15m\n", "every:15m\r\n", "every:15m\0", "every:１５m",
    "* * * * *", "every:15m;node evil.mjs", "every:15m&&push", "every:15m|whoami", "every:15m\t", "\nevery:15m"])("refuses grammar/coercion %#", (value) => {
    expect(() => parseRoutineSchedule(value)).toThrow(RoutineScheduleError);
  });
  it("does not invoke object coercion or accessors", () => {
    const coercion = vi.fn(() => "every:15m"), value = { toString: coercion, valueOf: coercion };
    expect(() => parseRoutineSchedule(value)).toThrow(RoutineScheduleError); expect(coercion).not.toHaveBeenCalled();
  });
});

describe("routine UTC and identity helpers", () => {
  it.each(["0001-01-01T00:00:00Z", "0400-02-29T23:59:59Z", "2000-02-29T00:00:00.1Z", "2024-02-29T12:00:00.12Z",
    "2026-10-06T10:00:00.000Z", "9999-12-31T23:59:59.999Z"])("accepts exact real UTC calendar %s", (value) => {
    expect(routineTimestampEpoch(value)).toBe(Date.parse(value));
  });
  it.each([null, undefined, {}, new Date(anchor), 0, "", "0000-01-01T00:00:00Z", "0100-02-29T00:00:00Z", "1900-02-29T00:00:00Z",
    "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-00-01T00:00:00Z", "2026-13-01T00:00:00Z", "2026-10-00T00:00:00Z",
    "2026-10-32T00:00:00Z", "2026-10-06T24:00:00Z", "2026-10-06T10:60:00Z", "2026-10-06T10:00:60Z", "2026-10-06T10:00:00",
    "2026-10-06T10:00:00+00:00", "2026-10-06T07:00:00-03:00", "2026-10-06t10:00:00z", "2026-10-06T10:00:00.Z",
    "2026-10-06T10:00:00.0000Z", "2026-10-06T10:00:00Z\n", "2026-10-06T10:00:00Z ", "+010000-01-01T00:00:00Z"])("rejects ambiguous/invalid UTC %#", (value) => {
    expect(() => routineTimestampEpoch(value)).toThrow(RoutineScheduleError);
  });
  it("has stable detached SHA256 identities and canonical equivalent instants", () => {
    const key = routineSlotKey("routine-1", 1, anchor);
    expect(key).toMatch(/^[a-f0-9]{64}$/); expect(routineSlotKey("routine-1", 1, "2026-10-06T10:00:00.000Z")).toBe(key);
    expect(routineSlotKey("routine-1", 1, "2026-10-06T10:00:00.0Z")).toBe(key);
    expect(routineRevisionKey("routine-1", 1)).toMatch(/^[a-f0-9]{64}$/); expect(routineRevisionKey("routine-1", 1)).toBe(routineRevisionKey("routine-1", 1));
    expect(routineSlotKey("routine-2", 1, anchor)).not.toBe(key); expect(routineSlotKey("routine-1", 2, anchor)).not.toBe(key);
    expect(routineSlotKey("routine-1", 1, slot15)).not.toBe(key); expect(routineRevisionKey("routine-1", 2)).not.toBe(routineRevisionKey("routine-1", 1));
  });
  it("accepts the same bounded 160-character identifier as the strict contract", () => {
    expect(routineRevisionKey("x".repeat(160), 1)).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(["", "../routine", "routine..x", "routine/x", "routine\\x", "routine\n", "routine ", ".routine", "x".repeat(161), "constructor", "prototype", "__proto__"])("rejects unsafe identity %s", (id) => {
    expect(() => routineRevisionKey(id, 1)).toThrow(RoutineScheduleError); expect(() => routineSlotKey(id, 1, anchor)).toThrow(RoutineScheduleError);
  });
  it.each([undefined, null, 0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", {}])("rejects revision coercion/overflow %#", (value) => {
    expect(() => routineRevisionKey("routine-1", value)).toThrow(RoutineScheduleError);
    expect(() => routineSlotKey("routine-1", value, anchor)).toThrow(RoutineScheduleError);
  });
});

describe("planRoutineSchedule", () => {
  it("starts only at anchor plus interval, never the configuration instant", () => {
    for (const now of [anchor, "2026-10-06T10:14:59.999Z"]) {
      expect(planRoutineSchedule({ ...fixture(), now })).toMatchObject({ kind: "none", reason: "not-due", next_slot: slot15, cursor: { last_slot: null } });
    }
    expect(planRoutineSchedule({ ...fixture(), now: slot15 })).toMatchObject({ kind: "admit", slot: slot15, trigger: "scheduled", next_slot: slot30 });
  });
  it("selects the latest slot once and returns a detached frozen cursor", () => {
    const input = fixture(), before = structuredClone(input), result = planRoutineSchedule(input);
    expect(result).toMatchObject({ kind: "admit", slot: slot30, occurrence_key: routineSlotKey("routine-1", 1, slot30), next_slot: slot45,
      cursor: { last_slot: slot30, pending_slot: null } });
    expect(input).toEqual(before); expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.cursor)).toBe(true);
    expect(planRoutineSchedule({ ...input, cursor: { ...result.cursor } })).toMatchObject({ kind: "none", reason: "already-considered", cursor: { last_slot: slot30 } });
  });
  it("handles millisecond anchors without assuming UTC day/hour boundaries", () => {
    const input = fixture(); input.routine.schedule_anchor_at = "2026-10-06T23:57:00.123Z"; input.now = "2026-10-07T00:12:00.123Z";
    expect(planRoutineSchedule(input)).toMatchObject({ kind: "admit", slot: "2026-10-07T00:12:00.123Z", next_slot: "2026-10-07T00:27:00.123Z" });
  });
  it("computes one slot after thousands of years without iterating a backlog", () => {
    const input = fixture(); input.routine.schedule_anchor_at = "0001-01-01T00:00:00Z"; input.now = "9000-01-01T00:00:00Z"; input.trigger = "restart";
    input.routine.catch_up = "run-once";
    const result = planRoutineSchedule(input); expect(result).toMatchObject({ kind: "admit", slot: "9000-01-01T00:00:00.000Z", trigger: "catch-up" });
    expect(Array.isArray(result)).toBe(false); expect(result.cursor.last_slot).toBe("9000-01-01T00:00:00.000Z");
    expect(planRoutineSchedule({ ...input, cursor: { ...result.cursor } }).kind).toBe("none");
  });
  it("restart skip-missed advances high-water, clears catch-up and does not replay", () => {
    const input = fixture(); input.trigger = "restart"; input.routine.concurrency = "coalesce"; input.cursor = cursor(slot15, slot15, slot15);
    const result = planRoutineSchedule(input);
    expect(result).toMatchObject({ kind: "none", reason: "restart-skipped", cursor: { last_slot: slot30, pending_slot: null } });
    expect(planRoutineSchedule({ ...input, trigger: "tick", cursor: { ...result.cursor } })).toMatchObject({ kind: "none", reason: "already-considered" });
  });
  it("restart run-once permits exactly one latest catch-up, not a list", () => {
    const input = fixture(); input.trigger = "restart"; input.routine.catch_up = "run-once"; input.now = "2026-10-07T10:31:00Z";
    const result = planRoutineSchedule(input); expect(result).toMatchObject({ kind: "admit", slot: "2026-10-07T10:30:00.000Z", trigger: "catch-up" });
    expect(result.cursor.pending_slot).toBe(null);
    expect(planRoutineSchedule({ ...input, cursor: { ...result.cursor } })).toMatchObject({ kind: "none", reason: "already-considered" });
  });
  it("skip concurrency consumes the considered slot without pending or later replay", () => {
    const input = fixture(); input.occupancy = "busy";
    const result = planRoutineSchedule(input); expect(result).toMatchObject({ kind: "none", reason: "busy-skipped", cursor: { last_slot: slot30, pending_slot: null } });
    expect(planRoutineSchedule({ ...input, occupancy: "idle", cursor: { ...result.cursor } }).kind).toBe("none");
  });
  it("coalesces to at most one latest pending and clears it after one admission", () => {
    const input = fixture(); input.occupancy = "busy"; input.routine.concurrency = "coalesce";
    const first = planRoutineSchedule(input); expect(first).toMatchObject({ kind: "coalesce", slot: slot30, cursor: { last_slot: slot30, pending_slot: slot30 } });
    const later = planRoutineSchedule({ ...input, now: "2026-10-06T10:46:00Z", cursor: { ...first.cursor } });
    expect(later).toMatchObject({ kind: "coalesce", slot: slot45, cursor: { last_slot: slot45, pending_slot: slot45 } });
    const free = planRoutineSchedule({ ...input, occupancy: "idle", now: "2026-10-06T10:46:00Z", cursor: { ...later.cursor } });
    expect(free).toMatchObject({ kind: "admit", slot: slot45, trigger: "coalesced", cursor: { last_slot: slot45, pending_slot: null } });
    expect(planRoutineSchedule({ ...input, occupancy: "idle", now: "2026-10-06T10:46:00Z", cursor: { ...free.cursor } }).kind).toBe("none");
  });
  it("coalesces around a live busy observation without pretending its inventory proves ownership", () => {
    const input = fixture(); input.occupancy = "busy"; input.routine.concurrency = "coalesce"; input.occurrences = [occurrence("running", slot15)];
    expect(planRoutineSchedule(input)).toMatchObject({ kind: "coalesce", slot: slot30 });
    expect(planRoutineSchedule({ ...input, occupancy: "idle" })).toMatchObject({ kind: "needs-review", reason: "ownership-unavailable" });
  });
  it.each(["completed", "partial", "failed", "cancelled"] as const)("never repeats a retained %s slot even after cursor loss/restart", (status) => {
    const input = fixture(); input.trigger = "restart"; input.routine.catch_up = "run-once"; input.occurrences = [occurrence(status, "2026-10-06T10:30:00Z")];
    expect(planRoutineSchedule(input)).toMatchObject({ kind: "none", reason: "already-recorded", cursor: { last_slot: slot30, pending_slot: null } });
  });
  it("drops pending when that exact slot is already in inventory", () => {
    const input = fixture(); input.routine.concurrency = "coalesce"; input.cursor = cursor(slot30, slot30); input.occurrences = [occurrence("completed")];
    expect(planRoutineSchedule(input)).toMatchObject({ kind: "none", reason: "already-recorded", cursor: { pending_slot: null } });
  });
  it.each(["reserved", "running"] as const)("restarted %s never gains ownership from persisted fields", (status) => {
    const input = fixture(); input.trigger = "restart"; input.routine.catch_up = "run-once"; input.occupancy = "busy"; input.occurrences = [occurrence(status, slot15)];
    expect(planRoutineSchedule(input)).toMatchObject({ kind: "needs-review", reason: "ownership-unavailable", cursor: { last_slot: null } });
  });
  it.each([1, 2])("unknown revision %s blocks the same routine without replay or refund", (revision) => {
    const input = fixture(); input.routine.revision = 2; input.occurrences = [occurrence("needs-review", slot15, revision)];
    expect(planRoutineSchedule(input)).toMatchObject({ kind: "needs-review", reason: "unresolved-occurrence", cursor: { last_slot: null } });
  });
  it("unowned active older revisions cannot be forgotten by a new definition", () => {
    const input = fixture(); input.routine.revision = 2; input.occurrences = [occurrence("running", slot15, 1)];
    expect(planRoutineSchedule(input)).toMatchObject({ kind: "needs-review", reason: "ownership-unavailable" });
  });
  it("refuses a global active inventory that contradicts an idle observation", () => {
    const input = fixture(); input.occurrences = [occurrence("running", slot15, 1, "routine-other")];
    expect(planRoutineSchedule(input)).toMatchObject({ kind: "needs-review", reason: "ownership-unavailable" });
    expect(planRoutineSchedule({ ...input, occupancy: "busy" })).toMatchObject({ kind: "none", reason: "busy-skipped" });
  });
  it("does not invent uncertainty for unrelated records but respects supplied global occupancy", () => {
    const input = fixture(); input.occurrences = [occurrence("needs-review", slot15, 1, "routine-other")];
    expect(planRoutineSchedule(input).kind).toBe("admit");
    expect(planRoutineSchedule({ ...input, occupancy: "ambiguous" })).toMatchObject({ kind: "needs-review", reason: "ownership-unavailable" });
  });
  it("disabled definitions retain cursor/history without any new slot", () => {
    const input = fixture(); input.routine.enabled = false; input.cursor = cursor(slot15, null, slot15); const before = structuredClone(input);
    expect(planRoutineSchedule(input)).toMatchObject({ kind: "none", reason: "disabled", cursor: { last_slot: slot15, pending_slot: null } }); expect(input).toEqual(before);
    expect(planRoutineSchedule({ ...input, trigger: "manual" }).kind).toBe("none");
  });
  it("manual schedules cannot create automatic/catch-up work", () => {
    const input = fixture(); input.routine.schedule = null; input.routine.schedule_anchor_at = null;
    for (const trigger of ["tick", "restart"] as const) expect(planRoutineSchedule({ ...input, trigger })).toMatchObject({ kind: "none", reason: "manual-only", next_slot: null });
    expect(planRoutineSchedule({ ...input, trigger: "manual" })).toMatchObject({ kind: "admit", slot: "2026-10-06T10:31:00.000Z", trigger: "manual", next_slot: null,
      cursor: { last_slot: null, pending_slot: null } });
  });
  it("explicit interval manual work may be off-grid without altering automatic high-water", () => {
    const input = fixture(); input.trigger = "manual"; input.cursor = cursor(slot15, null, slot15);
    expect(planRoutineSchedule(input)).toMatchObject({ kind: "admit", slot: "2026-10-06T10:31:00.000Z", trigger: "manual", cursor: { last_slot: slot15 } });
    input.occurrences = [occurrence("completed", input.now)]; expect(planRoutineSchedule(input)).toMatchObject({ kind: "none", reason: "already-recorded" });
    input.trigger = "tick"; expect(planRoutineSchedule(input)).toMatchObject({ kind: "admit", slot: slot30, trigger: "scheduled" });
  });
  it("busy manual cannot create pending even with coalesce and run-once configured", () => {
    const input = fixture(); input.trigger = "manual"; input.occupancy = "busy"; input.routine.concurrency = "coalesce"; input.routine.catch_up = "run-once";
    expect(planRoutineSchedule(input)).toMatchObject({ kind: "none", reason: "busy-skipped", cursor: { last_slot: null, pending_slot: null } });
    expect(planRoutineSchedule({ ...input, occupancy: "ambiguous" }).kind).toBe("needs-review");
  });
  it("revision changes have distinct identities/anchors and cannot borrow old cursors", () => {
    const input = fixture(); input.routine.revision = 2; input.routine.schedule_anchor_at = "2026-10-06T10:16:00Z";
    expect(planRoutineSchedule(input)).toMatchObject({ kind: "admit", slot: "2026-10-06T10:31:00.000Z", occurrence_key: routineSlotKey("routine-1", 2, input.now) });
    input.cursor = cursor(slot30); rejectsWithoutMutation(input);
  });
  it.each(["future-observation", "observation-before-anchor", "future-last", "last-after-observation", "off-grid-last", "anchor-as-slot", "pending-without-last", "old-pending", "skip-pending", "manual-cursor", "future-anchor",
    "missing-anchor", "manual-anchor", "duplicate-slot", "future-occurrence", "invalid-status", "invalid-policy", "invalid-trigger", "invalid-occupancy"])("rejects inconsistent input %s without changes", (change) => {
    const input = fixture(); input.cursor = cursor(slot15, null, slot15);
    if (change === "future-observation") input.cursor.evaluated_at = slot45;
    if (change === "observation-before-anchor") { input.cursor.last_slot = null; input.cursor.evaluated_at = "2026-10-06T09:59:00Z"; }
    if (change === "future-last") { input.cursor.last_slot = slot45; input.cursor.evaluated_at = slot45; }
    if (change === "last-after-observation") input.cursor.last_slot = slot30;
    if (change === "off-grid-last") input.cursor.last_slot = "2026-10-06T10:14:00Z";
    if (change === "anchor-as-slot") input.cursor.last_slot = anchor;
    if (change === "pending-without-last") { input.cursor.last_slot = null; input.cursor.pending_slot = slot15; }
    if (change === "old-pending") { input.cursor = cursor(slot30, slot15); }
    if (change === "skip-pending") input.cursor = cursor(slot30, slot30);
    if (change === "manual-cursor") { input.routine.schedule = null; input.routine.schedule_anchor_at = null; }
    if (change === "future-anchor") input.routine.schedule_anchor_at = slot45;
    if (change === "missing-anchor") input.routine.schedule_anchor_at = null;
    if (change === "manual-anchor") input.routine.schedule = null;
    if (change === "duplicate-slot") input.occurrences = [occurrence("completed"), occurrence("failed", "2026-10-06T10:30:00Z")];
    if (change === "future-occurrence") input.occurrences = [occurrence("completed", slot45)];
    if (change === "invalid-status") input.occurrences = [occurrence("invalid" as RoutineScheduleOccurrence["status"])];
    if (change === "invalid-policy") input.routine.concurrency = "queue" as "skip";
    if (change === "invalid-trigger") input.trigger = "auto" as "tick";
    if (change === "invalid-occupancy") input.occupancy = "owned" as "idle";
    rejectsWithoutMutation(input);
  });
  it("refuses timestamp overflow rather than inventing a next slot beyond the contract", () => {
    const input = fixture(); input.routine.schedule_anchor_at = "9999-12-31T23:00:00Z"; input.now = "9999-12-31T23:59:59Z";
    rejectsWithoutMutation(input);
  });
  it("accepts the bounded inventory without any effect and rejects one extra record", () => {
    const input = fixture(); input.occurrences = Array.from({ length: ROUTINE_LIMITS.records }, (_, index) => occurrence("completed", slot15, 1, `other-${index}`));
    expect(planRoutineSchedule(input).kind).toBe("admit");
    input.occurrences = [...input.occurrences, occurrence("completed", slot15, 1, "overflow")]; rejectsWithoutMutation(input);
  });
  it.each(["accessor", "toJSON", "proxy", "cycle", "sparse", "decorated-array", "symbol", "hidden", "prototype", "extra-field", "extra-routine-field"])("rejects non-inert/unknown projection %s before hooks", (change) => {
    const input = fixture(), hook = vi.fn(() => anchor);
    if (change === "accessor") Object.defineProperty(input, "now", { get: hook, enumerable: true });
    if (change === "toJSON") Object.assign(input, { toJSON: hook });
    if (change === "proxy") input.routine = new Proxy(input.routine, { get: hook });
    if (change === "cycle") Object.assign(input, { cycle: input });
    if (change === "sparse") input.occurrences = new Array(1);
    if (change === "decorated-array") Object.assign(input.occurrences, { extra: true });
    if (change === "symbol") Object.assign(input, { [Symbol("hidden")]: true });
    if (change === "hidden") Object.defineProperty(input, "secret", { value: true, enumerable: false });
    if (change === "prototype") Object.setPrototypeOf(input.routine, { now: anchor });
    if (change === "extra-field") Object.assign(input, { owner: "invented" });
    if (change === "extra-routine-field") Object.assign(input.routine, { command: "pnpm publish" });
    expect(() => planRoutineSchedule(input)).toThrow(RoutineScheduleError); expect(hook).not.toHaveBeenCalled();
  });
  it("accepts frozen/null-prototype inert projections without modifying them", () => {
    const input = fixture(), prototypeFree = Object.assign(Object.create(null), input.routine); input.routine = prototypeFree;
    Object.freeze(input.routine); Object.freeze(input.occurrences); Object.freeze(input);
    expect(planRoutineSchedule(input)).toMatchObject({ kind: "admit", slot: slot30 });
  });
  it("refuses expanded aggregate bytes before serializing the untrusted object", () => {
    const input = fixture(), shared = Object.assign(occurrence("completed", slot15, 1, "other"), { extra: "x".repeat(4096) });
    input.occurrences = Array.from({ length: ROUTINE_LIMITS.records }, () => shared);
    const original = JSON.stringify, objectSerialization = vi.fn(); let caught: unknown;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation(((value: unknown) => {
      if (value !== null && typeof value === "object") { objectSerialization(); throw new Error("untrusted-object-serialization"); }
      return original(value);
    }) as typeof JSON.stringify);
    try { planRoutineSchedule(input); } catch (error) { caught = error; } finally { spy.mockRestore(); }
    expect(caught).toBeInstanceOf(RoutineScheduleError); expect((caught as Error).message).toMatch(/byte bounds/);
    expect(objectSerialization).not.toHaveBeenCalled();
  });
  it("counts escaped bytes before aggregate serialization instead of only raw UTF8 bytes", () => {
    const input = fixture(), shared = Object.assign(occurrence("completed", slot15, 1, "other"), { extra: "\0".repeat(512) });
    input.occurrences = Array.from({ length: ROUTINE_LIMITS.records }, () => shared);
    const original = JSON.stringify, objectSerialization = vi.fn(); let caught: unknown;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation(((value: unknown) => {
      if (value !== null && typeof value === "object") { objectSerialization(); throw new Error("untrusted-object-serialization"); }
      return original(value);
    }) as typeof JSON.stringify);
    try { planRoutineSchedule(input); } catch (error) { caught = error; } finally { spy.mockRestore(); }
    expect(caught).toBeInstanceOf(RoutineScheduleError); expect((caught as Error).message).toMatch(/byte bounds/);
    expect(objectSerialization).not.toHaveBeenCalled();
  });
  it.each([Object.prototype, Array.prototype])("does not invoke inherited serialization hooks in plans or identity tuples %#", (prototype) => {
    const input = fixture(), expectedRevision = routineRevisionKey("routine-1", 1), expectedSlot = routineSlotKey("routine-1", 1, slot30);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "toJSON"), hook = vi.fn(() => null);
    let result: ReturnType<typeof planRoutineSchedule> | undefined, actualRevision: string | undefined, actualSlot: string | undefined;
    try {
      Object.defineProperty(prototype, "toJSON", { configurable: true, value: hook });
      result = planRoutineSchedule(input); actualRevision = routineRevisionKey("routine-1", 1); actualSlot = routineSlotKey("routine-1", 1, slot30);
    } finally {
      if (descriptor) Object.defineProperty(prototype, "toJSON", descriptor); else Reflect.deleteProperty(prototype, "toJSON");
    }
    expect(hook).not.toHaveBeenCalled(); expect(result).toMatchObject({ kind: "admit", slot: slot30, occurrence_key: expectedSlot });
    expect(actualRevision).toBe(expectedRevision); expect(actualSlot).toBe(expectedSlot);
  });
});
