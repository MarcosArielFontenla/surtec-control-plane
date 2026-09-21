// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { TaskDetailModel } from "../../../../lib/state/types";
import { TaskDetailView } from "./TaskDetailView";

const detail: TaskDetailModel = {
  task: {
    envelope: {
      id: "T-1", source: "dashboard", project: "alpha", task_type: "implementation", agent: "engineer",
      title: "Ship evidence", instructions: "Do it", repo_path: "/repo", branch: "agent/T-1", sandbox: "workspace-write",
      expected_outputs: [], requires_human_approval: true, metadata: {},
    },
    lifecycle: "finished", outcome: "completed", created_at: "2026-09-21T10:00:00Z", started_at: "2026-09-21T10:00:00Z",
    updated_at: "2026-09-21T10:00:05Z", finished_at: "2026-09-21T10:00:05Z", logs_path: null,
    result: {
      task_id: "T-1", agent: "engineer", status: "completed", summary: "Evidence shipped", files_changed: ["src/x.ts"],
      commands_run: ["npm test"], tests_run: ["unit"], risks: [], blockers: [], next_steps: ["Review"], artifacts: [], logs_path: "",
      verification: { status: "passed", checks: [{ command: "npm test", ok: true, output_tail: "12 passed" }] },
    },
  },
  events: [], duration_ms: 5_000,
  execution: { mode: "workspace-write-verify", thread_id: "thread-1", turn_id: "turn-1", trace_id: null, span_id: null, branch: "agent/T-1", worktree_path: "/wt", committed: true, diffstat: "1 file changed" },
  diff: { status: "available", path: "reports/T-1.diff", content: "+evidence", truncated: false },
  policy_decisions: [], approvals: [], usage: [], retries: [], review_history: [], cleanup: { status: "retained", at: null },
};

afterEach(() => vi.unstubAllGlobals());

describe("TaskDetailView", () => {
  it("renders result, diff, commands, verification, budgets, and cleanup", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => detail })) as unknown as typeof fetch);
    render(<TaskDetailView taskId="T-1" onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText("Evidence shipped")).toBeInTheDocument());
    expect(screen.getByText("+evidence")).toBeInTheDocument();
    expect(screen.getAllByText("npm test").length).toBeGreaterThan(0);
    expect(screen.getAllByText("retained").length).toBeGreaterThan(0);
    expect(screen.getByText("passed")).toBeInTheDocument();
  });
});
