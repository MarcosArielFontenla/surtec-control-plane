// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
    expect(screen.getByText(/Tarea histórica sin manifiesto registrado/)).toBeInTheDocument();
  });

  it("renders the recorded manifest as requirements, without private source bodies or invented verification", async () => {
    const admitted = structuredClone(detail);
    admitted.task.envelope.context_manifest = {
      schema_version: 1, fingerprint: "a".repeat(64), project_id: "alpha", role_id: "software-engineer", agent_id: "engineer", task_kind: "implementation", sandbox: "workspace-write", tools: ["inspect", "edit-authorized-scope"], approval_rules: ["publication"],
      budget: { max_attempts: 1, max_runtime_ms: 60000, max_total_tokens: 10000 }, limits: { max_lines: 500, max_bytes: 60000, max_sources: 64 }, sources: [], selected_categories: [], excluded_categories: ["confidential-notes"], omitted_sources: [], total_bytes: 0, total_lines: 0,
      routing: { action: "direct", work_scale: "trivial", review_depth: "full", qa_required: false, reasons: [], delegation: { admitted: false, executable: false, reasons: [] } },
      testing: { mode: "strict-tdd", minimum_review_depth: "full", runner_ids: [], commands: [], reasons: [], requires_red_evidence: true },
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => admitted })) as unknown as typeof fetch);
    render(<TaskDetailView taskId="T-1" onBack={() => {}} />);
    const evidence = within(await screen.findByRole("region", { name: "Manifiesto de contexto" }));
    expect(evidence.getByText("software-engineer")).toBeInTheDocument();
    expect(evidence.getByText("a".repeat(64))).toBeInTheDocument();
    expect(evidence.getByText(/strict-tdd · RED requerido/)).toBeInTheDocument();
    expect(evidence.getByText(/no demuestra que los checks/)).toBeInTheDocument();
    expect(evidence.queryByText("passed")).toBeNull();
    expect(evidence.queryByText("Do it")).toBeNull();
    expect(evidence.queryByText(/Tarea histórica/)).toBeNull();
  });

  it("clears evidence when navigating tasks and ignores the former task's late response", async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("T-1")
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : Promise.resolve({ ok: true, json: async () => ({ ...detail, task: { ...detail.task, envelope: { ...detail.task.envelope, id: "T-2", title: "Second task" } } }) } as Response)));
    const view = render(<TaskDetailView taskId="T-1" onBack={() => {}} />);
    view.rerender(<TaskDetailView taskId="T-2" onBack={() => {}} />);
    await screen.findByText("Second task");
    finish({ ok: true, json: async () => detail } as Response);
    await waitFor(() => expect(screen.queryByText("Ship evidence")).toBeNull());
    expect(screen.getByText("Second task")).toBeInTheDocument();
  });
});
