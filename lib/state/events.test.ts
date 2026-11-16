import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { appendTaskEvent, readTaskEvents } from "./events";
import { acquireMaintenanceExclusive, releaseMaintenanceExclusive, setMaintenanceHold, MaintenanceConflictError, MaintenanceStateError, withMaintenanceMutation } from "./maintenance";

describe("task events", () => {
  let root: string;
  let events: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "surtec-events-"));
    events = join(root, "events");
  });

  afterEach(() => {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
    expect(root.split(/[\\/]/).at(-1)).toMatch(/^surtec-events-/);
    expect(lstatSync(root).isSymbolicLink()).toBe(false);
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  });

  it("appends validated events in order", () => {
    appendTaskEvent({ task_id: "T-1", type: "queued", revision: 1, payload: { source: "dashboard" }, at: "2026-09-21T10:00:00Z" }, events);
    appendTaskEvent({ task_id: "T-1", type: "claimed", revision: 2, run_id: "run-1", attempt: 1, payload: { worker_id: "worker-1" }, at: "2026-09-21T10:00:01Z" }, events);

    expect(readTaskEvents("T-1", events).map((event) => event.type)).toEqual(["queued", "claimed"]);
  });

  it("reads an absent history without creating it", () => {
    expect(readTaskEvents("ABSENT", events)).toEqual([]);
    expect(existsSync(events)).toBe(false);
  });

  it.each(['{"truncated":', '{"revision":2}'])("refuses a damaged history rather than returning its valid prefix (%s)", (tail) => {
    appendTaskEvent({ task_id: "DAMAGED", type: "queued", revision: 1 }, events);
    const path = join(events, "DAMAGED.jsonl"), bytes = readFileSync(path, "utf8") + tail;
    writeFileSync(path, bytes);
    expect(() => readTaskEvents("DAMAGED", events)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  it("preserves repeated and sparse revisions without inventing intermediate events", () => {
    for (const revision of [1, 3, 3]) appendTaskEvent({ task_id: "SPARSE", type: "warning", revision }, events);
    const path = join(events, "SPARSE.jsonl"), before = readFileSync(path);
    expect(readTaskEvents("SPARSE", events).map((event) => event.revision)).toEqual([1, 3, 3]);
    expect(readFileSync(path)).toEqual(before);
  });

  it("redacts credentials before writing the append-only line", () => {
    appendTaskEvent({ task_id: "T-1", type: "warning", revision: 1, payload: { message: "api_key=top-secret-value" } }, events);

    const raw = readFileSync(join(events, "T-1.jsonl"), "utf8");
    expect(raw).not.toContain("top-secret-value");
    expect(raw).toContain("[REDACTED]");
  });

  it("rejects unsafe identifiers and invalid revisions", () => {
    expect(() => appendTaskEvent({ task_id: "../escape", type: "queued", revision: 1 }, events)).toThrow(/invalid task id/);
    expect(() => appendTaskEvent({ task_id: "T-1", type: "queued", revision: 0 }, events)).toThrow(/invalid task event/);
  });

  it("refuses event construction, serialization, directory creation and append before unknown/exclusive ownership", () => {
    const proof = acquireMaintenanceExclusive(root);
    let effects = 0;
    const input = { task_id: "HELD", type: "queued" as const, revision: 1, get payload() { effects++; return {}; } };
    try {
      expect(() => appendTaskEvent(input, events)).toThrow(MaintenanceConflictError);
      expect(effects).toBe(0); expect(existsSync(events)).toBe(false);
    } finally { releaseMaintenanceExclusive(proof); }
  });

  it.each(["restore", "rollback", "ownership-review"] as const)("preserves raw append-only legacy lines during a persistent %s hold while allowing pure reads", (kind) => {
    const original = appendTaskEvent({ task_id: "HISTORY", type: "queued", revision: 1 }, events);
    const path = join(events, "HISTORY.jsonl"), bytes = ` ${JSON.stringify(original)}\r\n`;
    writeFileSync(path, bytes);
    const proof = acquireMaintenanceExclusive(root);
    try { setMaintenanceHold(proof, { operation_id: "events-held", kind }); }
    finally { releaseMaintenanceExclusive(proof); }
    expect(() => appendTaskEvent({ task_id: "HISTORY", type: "started", revision: 2 }, events)).toThrow(MaintenanceStateError);
    expect(readTaskEvents("HISTORY", events)).toEqual([original]); expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(existsSync(join(events, ".locks", "event-HISTORY.lock"))).toBe(false);
  });

  it("fences an event append in an arbitrary flat directory and permits it only after its exclusive owner releases", () => {
    const flat = join(root, "flat-events"); mkdirSync(flat);
    const proof = acquireMaintenanceExclusive(flat);
    try { expect(() => appendTaskEvent({ task_id: "FLAT", type: "queued", revision: 1 }, flat)).toThrow(MaintenanceConflictError); }
    finally { releaseMaintenanceExclusive(proof); }
    withMaintenanceMutation(flat, () => appendTaskEvent({ task_id: "FLAT", type: "queued", revision: 1 }, flat));
    expect(readTaskEvents("FLAT", flat)).toHaveLength(1);
    expect(existsSync(join(flat, ".locks", "event-FLAT.lock"))).toBe(false);
  });

  it("keeps complete append ownership before the event store lock and releases it after successful history persistence", () => {
    withMaintenanceMutation(root, () => {
      expect(() => acquireMaintenanceExclusive(root)).toThrow(MaintenanceConflictError);
      appendTaskEvent({ task_id: "OWNED", type: "queued", revision: 1 }, events);
      appendTaskEvent({ task_id: "OWNED", type: "started", revision: 2 }, events);
    });
    expect(readTaskEvents("OWNED", events).map((event) => event.revision)).toEqual([1, 2]);
    const proof = acquireMaintenanceExclusive(root);
    releaseMaintenanceExclusive(proof);
  });
});
