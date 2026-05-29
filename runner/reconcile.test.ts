import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "../lib/state/types";
import { writeTask, readTask } from "../lib/state/store";
import { reconcileRunning } from "./reconcile";

function record(id: string, lifecycle: TaskRecord["lifecycle"]): TaskRecord {
  return {
    envelope: {
      id, source: "dashboard", project: "p", task_type: "analysis", agent: "a",
      title: "t", instructions: "i", repo_path: "~/x", branch: "b",
      sandbox: "read-only", expected_outputs: [], requires_human_approval: true, metadata: {},
    },
    lifecycle, outcome: null, created_at: "2026-05-29T10:00:00Z", started_at: null,
    updated_at: "2026-05-29T10:00:00Z", finished_at: null, result: null, logs_path: null,
  };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-reconcile-"));
  process.env.SURTEC_STATE_DIR = join(root, "state");
});
afterEach(() => {
  delete process.env.SURTEC_STATE_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("reconcileRunning", () => {
  it("marks orphaned running tasks as finished/failed and leaves others alone", () => {
    writeTask(record("R-1", "running"));
    writeTask(record("Q-1", "queued"));

    const n = reconcileRunning();

    expect(n).toBe(1);
    const r = readTask("R-1")!;
    expect(r.lifecycle).toBe("finished");
    expect(r.outcome).toBe("failed");
    expect(r.result?.blockers[0]).toContain("interrupted");
    expect(readTask("Q-1")!.lifecycle).toBe("queued");
  });
});
