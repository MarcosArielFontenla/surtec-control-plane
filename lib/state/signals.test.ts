import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Signal } from "../signals/types";
import { applySignalAction, readSignalHumanState, projectSignalHumanState, UnsupportedSignalStateVersionError } from "./signals";
import { validateSignalAction, validateSignalHumanStateDocument } from "./validation";

let root: string;
let filePath: string;
const now = new Date("2026-09-27T12:00:00.000Z");
const signal = (id: string): Signal => ({
  schema_version: 1, id: `sig_${id.padStart(24, "0")}`, project_id: "alpha", project_kind: "personal", source: "profile", type: "missing-next-action",
  severity: "info", title: "No next action", reason: "The project profile has no next action.", evidence_at: now.toISOString(),
  observed_at: now.toISOString(), suggested_action: "Set a next action.", action_kind: "edit-project-profile",
  ranking: { tier: "hygiene", order: 7 }, state: "open", snoozed_until: null, evidence: { field: "next_action", profile_exists: false },
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-signals-state-"));
  filePath = join(root, "signals", "human-state.json");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("signal human-state store", () => {
  it("persists acknowledge, snooze, pin, dismiss, and resolve separately from computed signals", () => {
    const snoozedUntil = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    applySignalAction(signal("1").id, { action: "acknowledge" }, { filePath, now });
    applySignalAction(signal("2").id, { action: "snooze", until: snoozedUntil }, { filePath, now });
    applySignalAction(signal("3").id, { action: "pin-for-today" }, { filePath, now });
    applySignalAction(signal("4").id, { action: "dismiss" }, { filePath, now });
    applySignalAction(signal("5").id, { action: "resolve" }, { filePath, now });

    const reloaded = readSignalHumanState(filePath);
    expect(validateSignalHumanStateDocument(reloaded)).toBe(true);
    expect(reloaded.records[signal("1").id].state).toBe("acknowledged");
    expect(reloaded.records[signal("2").id]).toMatchObject({ state: "snoozed", snoozed_until: snoozedUntil });
    expect(reloaded.records[signal("3").id].pinned_for).toBe(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`);
    expect(reloaded.records[signal("4").id].dismissed).toBe(true);
    expect(reloaded.records[signal("5").id].state).toBe("resolved");

    const projected = projectSignalHumanState([signal("1"), signal("2"), signal("3"), signal("4"), signal("5")], reloaded, now);
    expect(projected.signals.find((item) => item.id === signal("1").id)?.state).toBe("acknowledged");
    expect(projected.signals.find((item) => item.id === signal("2").id)?.snoozed_until).toBe(snoozedUntil);
    expect(projected.signals.find((item) => item.id === signal("5").id)?.state).toBe("resolved");
    expect(projected.signals.map((item) => item.id)).not.toContain(signal("4").id);
    expect(projected.pinned_signal_ids).toEqual([signal("3").id]);
  });

  it("reopens expired snoozes and automatically clears pins after the local date changes", () => {
    const until = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    applySignalAction(signal("1").id, { action: "snooze", until }, { filePath, now });
    applySignalAction(signal("2").id, { action: "pin-for-today" }, { filePath, now });
    const later = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const doc = readSignalHumanState(filePath);
    const sameDay = projectSignalHumanState([signal("1"), signal("2")], doc, later);
    expect(sameDay.signals.find((item) => item.id === signal("1").id)).toMatchObject({ state: "open", snoozed_until: null });
    expect(sameDay.pinned_signal_ids).toEqual([signal("2").id]);
    const nextDay = new Date(later.getTime() + 24 * 60 * 60 * 1000);
    expect(projectSignalHumanState([signal("2")], doc, nextDay).pinned_signal_ids).toEqual([]);
  });

  it("records only the first recommendation action with the evidence time supplied by the signal engine", () => {
    const evidenceAt = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const id = signal("6").id;
    applySignalAction(id, { action: "acknowledge" }, { filePath, now, evidenceAt });
    applySignalAction(id, { action: "resolve" }, { filePath, now: new Date(now.getTime() + 60_000), evidenceAt: now.toISOString() });

    const record = readSignalHumanState(filePath).records[id];
    expect(record).toMatchObject({
      state: "resolved",
      first_action: "acknowledge",
      first_action_at: now.toISOString(),
      signal_evidence_at: evidenceAt,
    });
    expect(validateSignalHumanStateDocument(readSignalHumanState(filePath))).toBe(true);
  });

  it("validates action bodies and rejects invalid/future snooze times without modifying the file", () => {
    expect(validateSignalAction({ action: "acknowledge" })).toBe(true);
    expect(validateSignalAction({ action: "snooze", until: "2026-09-27T13:00:00.000Z" })).toBe(true);
    expect(validateSignalAction({ action: "acknowledge", extra: "no" })).toBe(false);
    expect(validateSignalAction({ action: "snooze", until: "tomorrow" })).toBe(false);
    expect(() => applySignalAction(signal("1").id, { action: "snooze", until: now.toISOString() }, { filePath, now })).toThrow(/future/);
    expect(() => applySignalAction("../../escape", { action: "acknowledge" }, { filePath, now })).toThrow(/invalid signal id/);
    expect(existsSync(filePath)).toBe(false);
  });

  it("preserves malformed and unsupported-version state rather than repairing or overwriting it", () => {
    mkdirSync(join(root, "signals"), { recursive: true });
    writeFileSync(filePath, "{broken", "utf8");
    expect(() => readSignalHumanState(filePath)).toThrow(/invalid JSON/);
    expect(() => applySignalAction(signal("1").id, { action: "acknowledge" }, { filePath, now })).toThrow(/invalid JSON/);
    expect(readFileSync(filePath, "utf8")).toBe("{broken");

    const future = JSON.stringify({ schema_version: 2, records: {} });
    writeFileSync(filePath, future, "utf8");
    expect(() => readSignalHumanState(filePath)).toThrow(UnsupportedSignalStateVersionError);
    expect(() => applySignalAction(signal("1").id, { action: "acknowledge" }, { filePath, now })).toThrow(UnsupportedSignalStateVersionError);
    expect(readFileSync(filePath, "utf8")).toBe(future);
  });
});
