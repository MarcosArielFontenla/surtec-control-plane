import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTaskEvent, readTaskEvents } from "./events";

describe("task events", () => {
  let root: string;
  let events: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "surtec-events-"));
    events = join(root, "events");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("appends validated events in order", () => {
    appendTaskEvent({ task_id: "T-1", type: "queued", revision: 1, payload: { source: "dashboard" }, at: "2026-09-21T10:00:00Z" }, events);
    appendTaskEvent({ task_id: "T-1", type: "claimed", revision: 2, run_id: "run-1", attempt: 1, payload: { worker_id: "worker-1" }, at: "2026-09-21T10:00:01Z" }, events);

    expect(readTaskEvents("T-1", events).map((event) => event.type)).toEqual(["queued", "claimed"]);
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
});
