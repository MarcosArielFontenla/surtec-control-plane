import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "../lib/state/types";
import { reconcileOrphanWorktrees } from "./reconcile";

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

describe("reconcileOrphanWorktrees", () => {
  it("reports unknown managed worktrees without deleting them", () => {
    const known = record("R-2", "finished");
    known.envelope.metadata = { run: { worktree_path: join(root, "known") } };
    const reportPath = join(root, "report.json");

    const report = reconcileOrphanWorktrees(root, {
      tasks: () => [known],
      projects: () => [{ id: "p", repo_path: join(root, "repo") }],
      worktrees: () => [
        { branch: "agent/known", worktreePath: join(root, "known") },
        { branch: "agent/orphan", worktreePath: join(root, "orphan") },
      ],
      reportPath,
      now: () => "2026-05-29T12:00:00Z",
    });

    expect(report).toEqual({
      at: "2026-05-29T12:00:00Z",
      orphans: [{
        project: "p",
        repo_path: join(root, "repo"),
        worktree_path: join(root, "orphan"),
        branch: "agent/orphan",
      }],
      errors: [],
    });
    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toEqual(report);
  });

  it("records registry failures instead of preventing startup", () => {
    const report = reconcileOrphanWorktrees(root, {
      tasks: () => [],
      projects: () => { throw new Error("invalid registry"); },
      reportPath: join(root, "error-report.json"),
    });
    expect(report.errors).toEqual(["registry: invalid registry"]);
  });
});
