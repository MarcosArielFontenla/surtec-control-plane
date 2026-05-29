import { describe, it, expect } from "vitest";
import { buildOverview, type RegistryProject } from "./derive";
import type { TaskRecord } from "./types";

const registry: RegistryProject[] = [
  { id: "stock-control", status: "active", repo: "git@github.com:surtec/stock-control.git" },
  { id: "portfolio-site", status: "planned", repo: null },
];

function rec(partial: Partial<TaskRecord> & { id: string; project: string }): TaskRecord {
  return {
    envelope: {
      id: partial.id, source: "cli", project: partial.project, task_type: "bugfix",
      agent: "backend-engineer", title: `Task ${partial.id}`, instructions: "x",
      repo_path: "~/dev", branch: `agent/${partial.id}`, sandbox: "workspace-write",
      expected_outputs: [], requires_human_approval: partial.envelope?.requires_human_approval ?? false,
      metadata: {},
    },
    lifecycle: partial.lifecycle ?? "queued",
    outcome: partial.outcome ?? null,
    created_at: "2026-05-28T10:00:00Z",
    started_at: partial.started_at ?? null,
    updated_at: partial.updated_at ?? "2026-05-28T10:00:00Z",
    finished_at: partial.finished_at ?? null,
    result: partial.result ?? null,
    logs_path: null,
  };
}

describe("buildOverview", () => {
  it("returns empty views when there are no tasks", () => {
    const o = buildOverview(registry, [], []);
    expect(o.inProgress).toEqual([]);
    expect(o.history).toEqual([]);
    expect(o.attention).toEqual([]);
    expect(o.projects.map((p) => p.id)).toEqual(["stock-control", "portfolio-site"]);
    expect(o.projects[0].task_counts).toEqual({ inProgress: 0, finished: 0 });
  });

  it("splits in-progress vs finished and sorts history by finished_at desc", () => {
    const tasks = [
      rec({ id: "A", project: "stock-control", lifecycle: "running", updated_at: "2026-05-28T11:00:00Z" }),
      rec({ id: "B", project: "stock-control", lifecycle: "finished", outcome: "completed", finished_at: "2026-05-28T09:00:00Z", updated_at: "2026-05-28T09:00:00Z" }),
      rec({ id: "C", project: "stock-control", lifecycle: "finished", outcome: "completed", finished_at: "2026-05-28T12:00:00Z", updated_at: "2026-05-28T12:00:00Z" }),
    ];
    const o = buildOverview(registry, tasks, []);
    expect(o.inProgress.map((t) => t.id)).toEqual(["A"]);
    expect(o.history.map((t) => t.id)).toEqual(["C", "B"]);
  });

  it("computes project last_activity as max updated_at and applies overrides", () => {
    const tasks = [
      rec({ id: "A", project: "stock-control", updated_at: "2026-05-28T11:00:00Z" }),
      rec({ id: "B", project: "stock-control", updated_at: "2026-05-28T13:00:00Z" }),
    ];
    const o = buildOverview(registry, tasks, [{ id: "stock-control", health: "at-risk", note: "watch it" }]);
    const sc = o.projects.find((p) => p.id === "stock-control")!;
    expect(sc.last_activity).toBe("2026-05-28T13:00:00Z");
    expect(sc.health).toBe("at-risk");
    expect(sc.note).toBe("watch it");
    expect(sc.task_counts).toEqual({ inProgress: 2, finished: 0 });
  });

  it("a decided task contributes no attention items", () => {
    const base = rec({
      id: "A", project: "stock-control", lifecycle: "finished", outcome: "needs-review",
      finished_at: "2026-05-29T12:00:00Z",
    });
    // pending → it IS in attention
    expect(buildOverview(registry, [base], []).attention.some((a) => a.task_id === "A")).toBe(true);
    // decided → it is NOT in attention
    const decided = { ...base, decision: { status: "approved" as const, at: "2026-05-29T13:00:00Z" } };
    expect(buildOverview(registry, [decided], []).attention).toEqual([]);
  });

  it("surfaces verification status on the awaiting-approval attention item", () => {
    const task = rec({
      id: "V", project: "stock-control", lifecycle: "finished", outcome: "completed",
      finished_at: "2026-05-29T12:00:00Z",
      envelope: { requires_human_approval: true } as TaskRecord["envelope"],
      result: {
        task_id: "V", agent: "backend-engineer", status: "completed", summary: "ok",
        files_changed: [], commands_run: [], tests_run: [],
        risks: [], blockers: [], next_steps: [], artifacts: [], logs_path: "reports/V.jsonl",
        verification: { status: "failed", checks: [{ command: "pnpm test", ok: false, output_tail: "" }] },
      },
    });
    const o = buildOverview(registry, [task], []);
    const item = o.attention.find((a) => a.task_id === "V" && a.kind === "awaiting-approval");
    expect(item?.verification).toBe("failed");
  });

  it("leaves attention-item verification null when the result has none", () => {
    const task = rec({
      id: "W", project: "stock-control", lifecycle: "finished", outcome: "completed",
      finished_at: "2026-05-29T12:00:00Z",
      envelope: { requires_human_approval: true } as TaskRecord["envelope"],
      result: {
        task_id: "W", agent: "backend-engineer", status: "completed", summary: "ok",
        files_changed: [], commands_run: [], tests_run: [],
        risks: [], blockers: [], next_steps: [], artifacts: [], logs_path: "reports/W.jsonl",
      },
    });
    const o = buildOverview(registry, [task], []);
    const item = o.attention.find((a) => a.kind === "awaiting-approval");
    expect(item?.verification ?? null).toBeNull();
  });

  it("builds attention from needs-review, awaiting-approval, risks and blockers", () => {
    const tasks = [
      rec({ id: "A", project: "stock-control", lifecycle: "finished", outcome: "needs-review", finished_at: "2026-05-28T12:00:00Z" }),
      rec({
        id: "B", project: "stock-control", lifecycle: "finished", outcome: "completed",
        finished_at: "2026-05-28T12:00:00Z",
        envelope: { requires_human_approval: true } as TaskRecord["envelope"],
        result: {
          task_id: "B", agent: "backend-engineer", status: "completed", summary: "ok",
          files_changed: [], commands_run: [], tests_run: [],
          risks: ["migration without rollback"], blockers: ["needs prod creds"],
          next_steps: [], artifacts: [], logs_path: "reports/B.jsonl",
        },
      }),
    ];
    const o = buildOverview(registry, tasks, []);
    const kinds = o.attention.map((a) => `${a.kind}:${a.task_id}:${a.title}`);
    expect(kinds).toContain("needs-review:A:Task A");
    expect(kinds).toContain("awaiting-approval:B:Task B");
    expect(kinds).toContain("risk:B:migration without rollback");
    expect(kinds).toContain("blocker:B:needs prod creds");
  });
});
