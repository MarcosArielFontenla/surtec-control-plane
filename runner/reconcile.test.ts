import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "../lib/state/types";
import { reconcileOrphanWorktrees } from "./reconcile";
import { assembleContext, contextHash } from "../lib/context/assemble";
import { defaultTaskOrchestration } from "../lib/state/orchestration";
import { prepareTaskBudgetAdmission } from "../dashboard/src/server/dispatch";
import { BUDGET_DIMENSIONS, type BudgetLimits } from "../lib/budgets/types";
import type { BudgetPolicySource } from "../lib/budgets/policy";
import { mutateBudgetLedger } from "../lib/state/budgets";
import { reserveTaskBudget, commitTaskBudget, markBudgetUnknown } from "../lib/budgets/reservations";
import { readTask, writeTask } from "../lib/state/store";

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

const budgetAt = "2026-10-05T12:00:00.000Z";
function budgetSource(): BudgetPolicySource {
  return { fingerprint: "a".repeat(64), policy: { schema_version: 1, revision: 1, pricing: { status: "unavailable", reason: "no-versioned-source" },
    rules: [{ id: "synthetic-policy", revision: 1, scope: { kind: "company", id: "surtec" }, period: "none", warning_percent: 80,
      limits: Object.fromEntries(BUDGET_DIMENSIONS.map((key) => [key, { status: "unconfigured" }])) as BudgetLimits }] } };
}
function budgetRecord(id = "R-BOUND"): TaskRecord {
  const draft = record(id, "queued"), caps = { max_attempts: 2, max_runtime_ms: 2000, max_total_tokens: 100 };
  const manifest = assembleContext({ schema_version: 1, project_id: "p", agent_id: "a", role_id: "portfolio-analyst", task_kind: "analysis", sandbox: "read-only", tools: ["inspect"], approval_rules: [], budget: caps,
    limits: { max_lines: 500, max_bytes: 60000, max_sources: 64 }, selected_categories: [], excluded_categories: [], omitted_sources: [],
    routing: { work_scale: "bounded", action: "direct", review_depth: "focused", qa_required: false, reasons: ["Synthetic"], delegation: { admitted: false, executable: false, reasons: ["No execution"] } },
    testing: { mode: "functional", minimum_review_depth: "focused", runner_ids: [], commands: [], reasons: ["Synthetic"], requires_red_evidence: false } },
  [{ id: "runtime/safety", layer: "runtime-safety", source_type: "policy", text: "Synthetic", reason: "Fixture", sensitivity: "public" }]).manifest;
  draft.envelope.context_manifest = manifest;
  draft.envelope.context_admission = { schema_version: 1, kind: "analysis", manifest_fingerprint: manifest.fingerprint,
    instructions_hash: contextHash(draft.envelope.instructions), instructions_length: draft.envelope.instructions.length };
  Object.assign(draft, { created_at: budgetAt, updated_at: budgetAt, revision: 1, orchestration: { ...defaultTaskOrchestration(), ...caps } });
  return structuredClone(prepareTaskBudgetAdmission(draft, { source: budgetSource(), attribution: { company_id: "surtec", project_ids: ["p"], objective_ids: [],
    issue_id: null, role_id: "portfolio-analyst", execution_id: id } }).task);
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-reconcile-"));
  process.env.SURTEC_STATE_DIR = join(root, "state");
});
afterEach(() => {
  delete process.env.SURTEC_STATE_DIR;
  rmSync(root, { recursive: true, force: true });
  expect(existsSync(root)).toBe(false);
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

  it("retains a budget-bound managed path as known and reports scaffold unavailability without recovery effects", () => {
    const task = budgetRecord(); task.envelope.metadata.run = { worktree_path: join(root, "known") }; writeTask(task);
    const taskPath = join(root, "state/tasks/R-BOUND.json"), before = readFileSync(taskPath);
    const report = reconcileOrphanWorktrees(root, { tasks: () => [task], projects: () => [{ id: "p", repo_path: join(root, "repo") }],
      worktrees: () => [{ branch: "agent/known", worktreePath: join(root, "known") }], reportPath: join(root, "report.json") });
    expect(report.orphans).toEqual([]); expect(report.errors).toEqual(["Budget-bound task remains scaffold-only; inventory does not grant recovery, execution, publication or cleanup authority."]);
    expect(readFileSync(taskPath).equals(before)).toBe(true); expect(readTask("R-BOUND")!.lifecycle).toBe("queued");
    expect(existsSync(join(root, "state/events"))).toBe(false); expect(existsSync(join(root, "state/budgets"))).toBe(false);
  });
  it.each([null, {}, { schema_version: 2 }])("does not turn invalid supplied budget facts into an orphan or authority: %j", (value) => {
    const task = record("R-BOUND", "running"); task.envelope.metadata.run = { worktree_path: join(root, "known") };
    Object.defineProperty(task.envelope, "budget_admission", { value, enumerable: true });
    const before = JSON.stringify(task);
    const report = reconcileOrphanWorktrees(root, { tasks: () => [task], projects: () => [{ id: "p", repo_path: join(root, "repo") }],
      worktrees: () => [{ branch: "agent/known", worktreePath: join(root, "known") }], reportPath: join(root, "report.json") });
    expect(report.orphans).toEqual([]); expect(report.errors).toEqual(["Task budget facts are invalid or unavailable; retained bytes and managed paths require inspection."]);
    expect(JSON.stringify(task)).toBe(before); expect(existsSync(join(root, "state/tasks"))).toBe(false); expect(existsSync(join(root, "state/budgets"))).toBe(false);
  });
  it("does not invoke accessor or proxy hooks while inspecting invalid supplied facts", () => {
    const task = record("R-BOUND", "running"), hook = vi.fn(() => { throw new Error("private source must not execute"); });
    Object.defineProperty(task.envelope, "budget_admission", { get: hook, enumerable: true });
    const run = {}; Object.defineProperty(run, "worktree_path", { get: hook, enumerable: true }); task.envelope.metadata.run = run;
    const proxied = record("R-PROXY", "running"); proxied.envelope = new Proxy(proxied.envelope, { get: hook, getOwnPropertyDescriptor: hook });
    const report = reconcileOrphanWorktrees(root, { tasks: () => [task, proxied], projects: () => [], reportPath: join(root, "report.json") });
    expect(report.orphans).toEqual([]); expect(report.errors).toHaveLength(2); expect(report.errors.join(" ")).not.toContain("private source"); expect(hook).not.toHaveBeenCalled();
  });
  it.each(["pending", "committed", "unknown"] as const)("inventory preserves %s budget holds exactly and never certifies automatic recovery", (status) => {
    const task = budgetRecord(), admission = task.envelope.budget_admission!, path = join(root, "state/budgets/budgets.json"); writeTask(task);
    mutateBudgetLedger((tx) => {
      reserveTaskBudget(tx, { admission, source: budgetSource() });
      if (status !== "pending") commitTaskBudget(tx, { admission, persisted_admission: readTask(task.envelope.id)!.envelope.budget_admission });
      if (status === "unknown") markBudgetUnknown(tx, { reservation_id: admission.reservation_id });
    }, path, budgetAt);
    const before = readFileSync(path);
    const report = reconcileOrphanWorktrees(root, { tasks: () => [task], projects: () => [], reportPath: join(root, "report.json") });
    expect(report.errors).toHaveLength(1); expect(readFileSync(path).equals(before)).toBe(true); expect(existsSync(join(root, "state/events"))).toBe(false);
  });
});
