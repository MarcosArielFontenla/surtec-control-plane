import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { execFileSync } from "node:child_process";
import { managedGitArgs } from "../lib/security/managed-git.mjs";
import { localGitEnvironment } from "../lib/security/environment";
import { evidenceHash, testingEvidenceStatus } from "../lib/context/testing-evidence";
import type { AgentRoleRegistry, ContextAdmissionV2 } from "../lib/context/types";
import { createContextService } from "../dashboard/src/server/context-service";
import { createTask, prepareTaskBudgetAdmission } from "../dashboard/src/server/dispatch";
import { createIssueService } from "../dashboard/src/server/issue-service";
import * as issueModule from "../dashboard/src/server/issue-service";
import * as contextModule from "../dashboard/src/server/context-service";
import { PolicyService } from "../lib/policy/service";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "../lib/state/types";
import type { AgentExecutor, AgentRunResult } from "./agent-executor";
import type { Tracer } from "../lib/observability/tracing";

vi.mock("./worktree", () => ({ createWorktree: vi.fn(), commitAndDiff: vi.fn() }));
vi.mock("./verify", async (original) => {
  const actual = await original<typeof import("./verify")>();
  return { ...actual, runVerification: vi.fn(), captureVerification: vi.fn(actual.captureVerification) };
});
import { createWorktree, commitAndDiff } from "./worktree";
import { captureVerification, runVerification } from "./verify";
import { runTask } from "./run-task";
import { readTask, writeTask } from "../lib/state/store";
import { updateTask } from "../lib/state/store";
import * as taskStore from "../lib/state/store";
import { defaultTaskOrchestration } from "../lib/state/orchestration";
import { readTaskEvents } from "../lib/state/events";
import { assembleContext, contextHash } from "../lib/context/assemble";
import { BudgetExecutionScaffold, TaskOrchestrator } from "./task-orchestrator";
import { mutateBudgetLedger, readBudgetLedger } from "../lib/state/budgets";
import { budgetStatePath } from "../lib/state/paths";
import { reserveTaskBudget, commitTaskBudget } from "../lib/budgets/reservations";
import type { BudgetPolicySource } from "../lib/budgets/policy";
import { readIssueDocument } from "../lib/state/issues";
import * as issueState from "../lib/state/issues";
import { readWorkflowDocument } from "../lib/state/workflows";
import { WorkflowOrchestrator } from "./workflow-orchestrator";

let root: string;
let repo: string;
let run: ReturnType<typeof vi.fn<AgentExecutor["run"]>>;
let executor: AgentExecutor;

function structuredReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "completed",
    summary: "ok",
    commands_run: [],
    tests_run: [],
    risks: [],
    blockers: [],
    next_steps: [],
    artifacts: [],
    ...overrides,
  };
}

function agentRun(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  const structuredOutput = structuredReport();
  return {
    finalText: JSON.stringify(structuredOutput),
    structuredOutput,
    threadId: "thread-1",
    turnId: "turn-1",
    usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1, totalTokens: 15 },
    ...overrides,
  };
}

function queuedRecord(): TaskRecord {
  return {
    envelope: {
      id: "T-1", source: "dashboard", project: "stock-control", task_type: "analysis",
      agent: "backend-engineer", title: "Analyze", instructions: "Review auth.",
      repo_path: repo, branch: "agent/T-1", sandbox: "read-only",
      expected_outputs: [], requires_human_approval: true, metadata: {},
    },
    lifecycle: "queued", outcome: null,
    created_at: "2026-05-29T10:00:00Z", started_at: null,
    updated_at: "2026-05-29T10:00:00Z", finished_at: null, result: null, logs_path: null,
  };
}

function writeRecord(): TaskRecord {
  const record = queuedRecord();
  record.envelope.sandbox = "workspace-write";
  record.envelope.task_type = "implementation";
  return record;
}
function workflowFixture(kind: ContextAdmissionV2["stage_kind"] = "review"): TaskRecord {
  const writer = kind === "implementation" || kind === "correction";
  const record = writer ? writeRecord() : queuedRecord();
  const role: Record<ContextAdmissionV2["stage_kind"], ContextAdmissionV2["role_id"]> = { analysis: "portfolio-analyst", planning: "planner", implementation: "software-engineer", correction: "software-engineer", review: "reviewer", qa: "qa-evaluator", operations: "operations-observer" };
  const budget = { max_attempts: 2, max_runtime_ms: 60_000, max_total_tokens: 10_000 };
  record.orchestration = { ...defaultTaskOrchestration(), ...budget };
  record.envelope.context_manifest = assembleContext({ schema_version: 1, project_id: record.envelope.project, agent_id: record.envelope.agent, task_kind: record.envelope.task_type, role_id: role[kind], sandbox: record.envelope.sandbox,
    tools: writer ? ["inspect", "edit-authorized-scope"] : ["inspect"], approval_rules: ["publication"], budget, limits: { max_lines: 500, max_bytes: 60_000, max_sources: 64 }, selected_categories: [], excluded_categories: ["confidential-notes"], omitted_sources: [],
    routing: { work_scale: "bounded", action: "direct", review_depth: "focused", qa_required: false, reasons: ["Synthetic fixture"], delegation: { admitted: false, executable: false, reasons: ["No runtime delegation"] } },
    testing: { mode: "functional", minimum_review_depth: "focused", runner_ids: [], commands: [], reasons: ["Functional default"], requires_red_evidence: false } },
    [{ id: "runtime/safety-v1", layer: "runtime-safety", source_type: "policy", text: "Synthetic safety", reason: "Fixture", sensitivity: "public" }]).manifest;
  const candidate = ["review", "qa", "correction"].includes(kind);
  record.envelope.context_admission = {
    schema_version: 2, kind: "workflow-stage", workflow_id: "workflow-1", stage_id: "stage-1", stage_generation: 1, stage_kind: kind, task_id: record.envelope.id,
    template_id: kind === "operations" ? "operations-investigation" : kind === "analysis" ? "analysis" : "implementation", template_version: 1, grant_id: "grant-1", authority_revision: 1,
    role_id: role[kind], issue_id: "issue-1", issue_revision: 3, scope_revision: 2, scope_fingerprint: contextHash("Synthetic scope"),
    approved_plan: writer ? { stage_id: "planner-1", output_fingerprint: "a".repeat(64), decision_id: "decision-1" } : null,
    predecessor_stage_id: writer || candidate ? "predecessor-1" : null, handoff_id: writer || candidate ? "handoff-1" : null,
    candidate: candidate ? { candidate_id: "candidate-1", issue_id: "issue-1", repository_id: record.envelope.project, task_id: "engineer-task", execution_id: "engineer-run", scope_revision: 2, base_revision: "a".repeat(40), candidate_revision: "b".repeat(40), changed_paths: ["src/fixture.ts"], diff_fingerprint: "c".repeat(64), content_fingerprint: "d".repeat(64), testing_evidence_fingerprint: "e".repeat(64) } : null,
    manifest_fingerprint: record.envelope.context_manifest.fingerprint, instructions_length: record.envelope.instructions.length, instructions_hash: contextHash(record.envelope.instructions),
  };
  return record;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-runtask-"));
  repo = join(root, "stock-control");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(
    join(root, "registry", "agents.yml"),
    "agents:\n  - id: backend-engineer\n    name: Backend Engineer\n    type: engineering\n    description: Implements backend.\n    default_sandbox: workspace-write\n    allowed_task_types: [bugfix]\n    requires_human_approval_for: [merge]\n",
    "utf8",
  );
  writeFileSync(
    join(root, "registry", "projects.yml"),
    "projects:\n  stock-control:\n    allowed_agents: [backend-engineer]\n    sandbox:\n      default: workspace-write\n    commands:\n      test: pnpm test\n",
    "utf8",
  );
  writeFileSync(join(root, "AGENTS.md"), "ROOT RULE: do not deploy.\n", "utf8");
  process.env.SURTEC_STATE_DIR = join(root, "state");
  process.env.SURTEC_PROJECTS_ROOT = root;
  run = vi.fn<AgentExecutor["run"]>();
  run.mockResolvedValue(agentRun());
  executor = { run };
  vi.mocked(createWorktree).mockReset();
  vi.mocked(commitAndDiff).mockReset();
  vi.mocked(runVerification).mockReset();
  vi.mocked(captureVerification).mockClear();
  vi.mocked(runVerification).mockReturnValue({ status: "passed", checks: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.SURTEC_STATE_DIR;
  delete process.env.SURTEC_PROJECTS_ROOT;
  rmSync(root, { recursive: true, force: true });
  expect(existsSync(root)).toBe(false);
});

describe("runTask", () => {
  it.each(["analysis", "planning", "implementation", "review", "qa", "operations", "correction"] as const)("denies standalone v2 %s before context, issue, policy, worktree, commit, verification or model effects", async (kind) => {
    const context = vi.spyOn(contextModule, "createContextService"), issues = vi.spyOn(issueModule, "createIssueService"), policy = vi.spyOn(PolicyService.prototype, "authorizeTask");
    const record = workflowFixture(kind); writeTask(record);
    const completion = await runTask("T-1", root, executor);
    expect(completion).toMatchObject({ outcome: "needs-review", retryable: false, stale: false, reason: expect.stringContaining("trusted workflow controller") });
    for (const effect of [context, issues, policy, run, createWorktree, commitAndDiff, runVerification, captureVerification]) expect(effect).not.toHaveBeenCalled();
    const saved = readTask("T-1")!;
    expect(saved).toMatchObject({ lifecycle: "finished", outcome: "needs-review", orchestration: { lease: null, attempts: 1, cumulative_tokens: 0, last_failure: { kind: "terminal" } } });
    expect(saved.envelope.context_admission).toEqual(record.envelope.context_admission);
    expect(saved.envelope.context_manifest).toEqual(record.envelope.context_manifest);
    expect(saved.testing_evidence).toBeUndefined(); expect(saved.envelope.metadata.run ?? {}).not.toHaveProperty("worktree_path");
    expect(readTaskEvents("T-1").map((event) => event.type)).toEqual(["claimed", "started", "needs-review"]);
    expect(existsSync(join(root, "state/issues"))).toBe(false); expect(existsSync(join(root, "state/workflows"))).toBe(false);
  });
  it.each(["implementation", "correction"] as const)("does not turn ordinary retry of a held v2 %s stage into v1 or a resumed model thread", async (kind) => {
    const record = workflowFixture(kind); record.envelope.metadata.run = { thread_id: "legacy-engineer-thread" }; writeTask(record);
    await runTask("T-1", root, executor);
    const scheduler = new TaskOrchestrator({ repoRoot: root, executor });
    const before = readFileSync(join(root, "state/tasks/T-1.json"));
    expect(() => scheduler.retry("T-1")).toThrow(/current controller/);
    expect(await runTask("T-1", root, executor)).toBeNull();
    expect(readFileSync(join(root, "state/tasks/T-1.json"))).toEqual(before);
    expect(readTask("T-1")!.orchestration).toMatchObject({ attempts: 1, cumulative_tokens: 0 });
    expect(readTask("T-1")!.envelope.context_admission).toEqual(record.envelope.context_admission);
    expect(() => scheduler.retry("T-1")).toThrow(/current controller/);
    for (const effect of [run, createWorktree, commitAndDiff, runVerification, captureVerification]) expect(effect).not.toHaveBeenCalled();
  });
  it("also denies the valid Planner analysis variant without invoking legacy context assembly", async () => {
    const record = workflowFixture("analysis");
    const { fingerprint: _fingerprint, ...unsigned } = record.envelope.context_manifest!;
    const manifest = { ...unsigned, role_id: "planner" };
    record.envelope.context_manifest = { ...manifest, fingerprint: contextHash(JSON.stringify(manifest)) };
    const binding = record.envelope.context_admission as ContextAdmissionV2; binding.role_id = "planner"; binding.manifest_fingerprint = record.envelope.context_manifest.fingerprint;
    writeTask(record); const context = vi.spyOn(contextModule, "createContextService");
    expect(await runTask("T-1", root, executor)).toMatchObject({ outcome: "needs-review", retryable: false });
    expect(context).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(createWorktree).not.toHaveBeenCalled();
  });
  it("cannot enable a workflow stage with injected caller flags or controller-shaped metadata", async () => {
    const record = workflowFixture("review");
    record.envelope.metadata.run = { workflow_controller: true, workflow_task_id: record.envelope.id, workflow_stage_id: "stage-1", workflow_generation: 1 };
    writeTask(record);
    expect(await runTask("T-1", root, executor, { workflowExecution: { owner: true, taskId: "T-1", runId: "forged" }, workflowController: true, permit: { workflow_id: "workflow-1", stage_id: "stage-1" } } as any))
      .toMatchObject({ outcome: "needs-review", retryable: false, stale: false });
    for (const effect of [run, createWorktree, commitAndDiff, runVerification, captureVerification]) expect(effect).not.toHaveBeenCalled();
    expect(existsSync(join(root, "state/workflows"))).toBe(false); expect(readTask("T-1")!.testing_evidence).toBeUndefined();
  });
  it("retains the exact expired stage without a controller and rejects recovery, retry and stale execution without effects", async () => {
    const record = workflowFixture(); record.lifecycle = "running"; record.orchestration!.attempts = 1;
    record.orchestration!.lease = { run_id: "old-stage-run", worker_id: "fixture", acquired_at: "2026-01-01T00:00:00Z", heartbeat_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-01T00:00:01Z" }; writeTask(record);
    const scheduler = new TaskOrchestrator({ repoRoot: root, executor });
    const path = join(root, "state/tasks/T-1.json"), before = readFileSync(path);
    expect(scheduler.recoverExpiredLeases()).toBe(0); expect(await scheduler.runOnce()).toBe(0);
    expect(() => scheduler.retry("T-1")).toThrow(/current controller/);
    expect(await runTask("T-1", root, executor, { runId: "old-stage-run" })).toMatchObject({ stale: true, retryable: false });
    expect(await runTask("T-1", root, executor)).toBeNull(); expect(readFileSync(path)).toEqual(before);
    expect(readTask("T-1")!.envelope.context_admission).toEqual(record.envelope.context_admission);
    expect(readTaskEvents("T-1")).toEqual([]);
    for (const effect of [run, createWorktree, commitAndDiff, runVerification, captureVerification]) expect(effect).not.toHaveBeenCalled();
  });
  it("holds a scheduler-owned valid v2 lease and fences expired ownership without changing its bytes", async () => {
    const record = workflowFixture("correction"); record.lifecycle = "running"; record.orchestration!.attempts = 1;
    record.orchestration!.lease = { run_id: "stage-run", worker_id: "fixture", acquired_at: "2026-01-01T00:00:00Z", heartbeat_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-01T00:00:01Z" }; writeTask(record);
    const path = join(root, "state/tasks/T-1.json"), before = readFileSync(path);
    expect(await runTask("T-1", root, executor, { runId: "stage-run" })).toMatchObject({ stale: true }); expect(readFileSync(path)).toEqual(before);
    updateTask("T-1", (task) => { task.orchestration!.lease!.expires_at = new Date(Date.now() + 60_000).toISOString(); });
    expect(await runTask("T-1", root, executor, { runId: "stage-run" })).toMatchObject({ outcome: "needs-review", retryable: false });
    for (const effect of [run, createWorktree, commitAndDiff, runVerification, captureVerification]) expect(effect).not.toHaveBeenCalled();
  });
  it.each(["future", "missing", "legacy-metadata"])("rejects corrupt v2 %s before claim and preserves task bytes", async (invalid) => {
    const record = workflowFixture(); writeTask(record);
    if (invalid === "future") Object.assign(record.envelope.context_admission!, { schema_version: 99 });
    else if (invalid === "missing") delete (record.envelope.context_admission as unknown as Record<string, unknown>).grant_id;
    else record.envelope.metadata = { issue_id: "issue-1", issue_scope_revision: 2, issue_authorized_scope: {} };
    const path = join(root, "state/tasks/T-1.json"); writeFileSync(path, JSON.stringify(record)); const before = readFileSync(path);
    await expect(runTask("T-1", root, executor)).rejects.toThrow(/invalid task record/); expect(readFileSync(path)).toEqual(before);
    expect(readTaskEvents("T-1")).toEqual([]);
    for (const effect of [run, createWorktree, commitAndDiff, runVerification, captureVerification]) expect(effect).not.toHaveBeenCalled();
  });
  function contextFixture() {
    for (const name of ["agents.yml", "agent-roles.yml", "context-policy.yml"]) cpSync(`registry/${name}`, join(root, "registry", name));
    const roles = parse(readFileSync("registry/agent-roles.yml", "utf8")) as AgentRoleRegistry;
    for (const path of new Set(roles.roles.flatMap((role) => role.required_evaluation_ids))) {
      mkdirSync(join(root, ...path.split("/").slice(0, -1)), { recursive: true }); cpSync(path, join(root, path));
    }
    writeFileSync(join(repo, "AGENTS.md"), "SELECTED PROJECT RULE: do not publish.\n");
    return createContextService(root);
  }
  function analysisFixture() {
    const context = contextFixture();
    const preview = context.preview({ kind: "analysis", project: "stock-control", agent: "backend-engineer", role_id: "software-engineer", instructions: "Inspect fixture." });
    return createTask({ project: "stock-control", agent: "backend-engineer", role_id: "software-engineer", instructions: "Inspect fixture.", preview_fingerprint: preview.fingerprint }, root, undefined, { context }).id;
  }
  function budgetFixture(claim = true, id = analysisFixture()) {
    const record = readTask(id)!, context = record.envelope.context_admission!;
    const source: BudgetPolicySource = { policy: parse(readFileSync("registry/budget-policy.yml", "utf8")), fingerprint: contextHash("Synthetic neutral policy") };
    const attribution = { company_id: "surtec" as const, objective_ids: [], project_ids: [record.envelope.project], issue_id: context.schema_version === 2 ? context.issue_id : context.kind === "issue" ? context.issue_id! : null, role_id: record.envelope.context_manifest!.role_id, execution_id: id };
    const draft = prepareTaskBudgetAdmission(record, { source, attribution });
    mutateBudgetLedger((tx) => reserveTaskBudget(tx, { source, admission: draft.admission }), budgetStatePath(), draft.admission.created_at);
    writeTask(draft.task);
    mutateBudgetLedger((tx) => commitTaskBudget(tx, { admission: draft.admission, persisted_admission: readTask(id)!.envelope.budget_admission! }));
    const budgets = new BudgetExecutionScaffold({ resolve: () => ({ source }) }), runId = "budget-fixture-run";
    if (!claim) return { id, budgets, runId, proof: undefined };
    const proof = budgets.prepareClaim(id, runId, "budget-fixture-worker");
    updateTask(id, (task) => {
      const at = new Date().toISOString(); task.lifecycle = "running"; task.started_at = at; task.updated_at = at;
      task.orchestration!.attempts += 1;
      task.orchestration!.lease = { run_id: runId, worker_id: "budget-fixture-worker", acquired_at: at, heartbeat_at: at, expires_at: new Date(Date.now() + 600_000).toISOString() };
    });
    budgets.bindClaim(proof);
    return { id, budgets, runId, proof };
  }
  function governedBudgetFixture() {
    contextFixture(); cpSync("registry/workflow-policy.yml", join(root, "registry/workflow-policy.yml"));
    writeFileSync(join(root, "registry/projects.yml"), "projects:\n  stock-control:\n    allowed_agents: [backend-engineer, product-manager]\n    sandbox: { default: workspace-write }\n");
    const issues = createIssueService(root, { projectIds: () => ["stock-control"] });
    const proposed = issues.create({ project_id: "stock-control", title: "Synthetic budget evidence", expected_outcome: "Retain exact evidence", acceptance_criteria: ["No successor"],
      authorized_scope: { expected_outcome: "Retain exact evidence", acceptance_criteria: ["No successor"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["implementation"], explicit_exclusions: [] } });
    const issue = issues.authorize(proposed.id, proposed.revision, "synthetic-budget-scope-human");
    const controller = new WorkflowOrchestrator(root); controller.connect({ enqueue: vi.fn(), cancel: vi.fn() }, "budget-fixture-worker");
    const request = { template_id: "analysis", template_version: 1, project_id: "stock-control", issue_id: issue.id, expected_revision: issue.revision,
      selected_agents: { "portfolio-analyst": "product-manager" } };
    const preview = controller.service.preview(request); expect(preview.allowed, preview.blocked_reasons.join("; ")).toBe(true);
    const started = controller.service.start({ request, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-budget-workflow-human" });
    const bound = budgetFixture(true, started.stages[0]!.task_id!);
    const workflowProof = controller.claimRun(bound.id, bound.runId, bound.proof);
    return { ...bound, controller, workflowProof, workflowId: started.workflow.id, issueId: issue.id };
  }
  it.each(["tokens", "runtime", "unknown"] as const)("T007 relays independently proven %s stop before terminal task ownership is released", async (dimension) => {
    const f = governedBudgetFixture();
    if (dimension === "tokens") updateTask(f.id, (task) => { task.orchestration!.max_total_tokens = 5; });
    if (dimension === "runtime") { updateTask(f.id, (task) => { task.orchestration!.max_runtime_ms = 1000; }); vi.useFakeTimers({ toFake: ["Date"] }); }
    run.mockImplementation(async () => {
      if (dimension === "runtime") vi.setSystemTime(Date.now() + 1500);
      return agentRun({ structuredOutput: { schema_version: 1, kind: "analysis", status: "completed", summary: "Synthetic bounded analysis", recommendations: [],
        evidence_ids: [], unresolved_questions: [], risks: [], recommended_next_action: "Human inspection", requested_decision: null }, ...(dimension === "unknown" ? { usageComplete: false } : {}) });
    });
    const stop = vi.spyOn(f.controller, "stopForIndependentBudget");
    await runTask(f.id, root, executor, { runId: f.runId, budgetExecution: f.proof, workflowExecution: f.workflowProof });
    expect(stop).toHaveBeenCalled(); expect(f.controller.service.detail(f.workflowId).workflow.status).toBe("needs-decision");
    const document = readIssueDocument(); expect(document.issues[f.issueId]!.status).toBe("needs-decision");
    expect(document.events.at(-1)).toMatchObject({ type: "authorization-stale", payload: { workflow_id: f.workflowId, task_id: f.id, execution_id: f.runId,
      independent_budget_exhaustion: { run_id: f.runId } } });
    expect(readTask(f.id)!.lifecycle).toBe("finished"); expect(readTask(f.id)!.orchestration!.lease).toBeNull();
    expect(Object.values(readBudgetLedger()!.charges)).toHaveLength(1); expect(run).toHaveBeenCalledOnce();
    for (const effect of [createWorktree, commitAndDiff, runVerification, captureVerification]) expect(effect).not.toHaveBeenCalled();
    f.controller.release(f.workflowProof); f.budgets.release(f.proof!);
  });
  it("T007 retains the first independent stop across an issue-write fault and later global high-water", async () => {
    const f = governedBudgetFixture();
    updateTask(f.id, (task) => { task.orchestration!.max_total_tokens = 5; });
    await f.budgets.observe(f.proof!, 5, 10);
    const receipt = f.budgets.stopReceipt(f.id, f.proof!)!;
    const issueBefore = readFileSync(join(root, "state/issues/issues.json"));
    const fault = vi.spyOn(issueState, "mutateIssueDocument").mockImplementationOnce(() => { throw new Error("Synthetic independent issue-write fault"); });
    expect(() => f.controller.stopForIndependentBudget(f.id, receipt, f.workflowProof)).toThrow(/issue-write fault/);
    fault.mockRestore();
    const initial = readWorkflowDocument(), owner = initial.workflows[f.workflowId]!;
    const marker = initial.events.filter((entry) => entry.workflow_id === f.workflowId && entry.type === "budget-stopped").at(-1)!;
    expect(marker.summary).toMatch(/^Independent workflow budget stop v1:/);
    expect(readFileSync(join(root, "state/issues/issues.json"))).toEqual(issueBefore);
    expect(f.controller.observe(f.workflowProof, owner.budget.max_total_tokens, 20)).toBe(true);
    const later = readWorkflowDocument();
    expect(later.events.filter((entry) => entry.workflow_id === f.workflowId && entry.type === "budget-stopped")).toEqual([marker]);
    expect(later.workflows[f.workflowId]!.blocked_reason).toBe(owner.blocked_reason);
    expect(later.workflows[f.workflowId]!.counters.total_tokens).toBe(owner.budget.max_total_tokens);
    expect(readFileSync(join(root, "state/issues/issues.json"))).toEqual(issueBefore);
    expect(f.controller.stopForIndependentBudget(f.id, receipt, f.workflowProof)).toBe(true);
    const issues = readIssueDocument();
    expect(issues.issues[f.issueId]!.status).toBe("needs-decision");
    expect(issues.events.at(-1)).toMatchObject({ type: "authorization-stale", payload: { independent_budget_exhaustion: {
      denials: expect.arrayContaining([expect.objectContaining({ dimension: "total_tokens", cap: 5, proven_consumed: 5, required: 0 })]) } } });
    const issueBytes = readFileSync(join(root, "state/issues/issues.json")), workflowBytes = readFileSync(join(root, "state/workflows/workflows.json"));
    f.controller.reconcile(); new WorkflowOrchestrator(root).reconcile();
    expect(readFileSync(join(root, "state/issues/issues.json"))).toEqual(issueBytes);
    expect(readFileSync(join(root, "state/workflows/workflows.json"))).toEqual(workflowBytes);
    expect(Object.values(readBudgetLedger()!.charges)).toHaveLength(1); expect(run).not.toHaveBeenCalled();
    for (const effect of [createWorktree, commitAndDiff, runVerification, captureVerification]) expect(effect).not.toHaveBeenCalled();
    f.controller.release(f.workflowProof); f.budgets.release(f.proof!);
  });
  it.each(["absent", "forged", "copied", "wrong-run", "revoked"])("denies %s budget proof before any task/report/model effects", async (kind) => {
    const { id, budgets, runId, proof } = budgetFixture(kind !== "absent");
    const path = join(root, "state/tasks", `${id}.json`), before = readFileSync(path), ledgerBefore = readBudgetLedger(), eventsBefore = readTaskEvents(id);
    if (kind === "revoked") budgets.release(proof!);
    const supplied = kind === "forged" ? { owner: budgets, taskId: id, runId } : kind === "copied" ? { ...proof } : proof;
    expect(await runTask(id, root, executor, { runId: kind === "wrong-run" ? "foreign-run" : kind === "absent" ? undefined : runId, budgetExecution: supplied })).toBeNull();
    expect(readFileSync(path).equals(before)).toBe(true); expect(readBudgetLedger()).toEqual(ledgerBefore);
    expect(readTaskEvents(id)).toEqual(eventsBefore);
    expect(existsSync(join(root, "reports"))).toBe(false);
    for (const effect of [run, createWorktree, commitAndDiff, runVerification, captureVerification]) expect(effect).not.toHaveBeenCalled();
  });
  it("fences admission insertion between the preliminary read and locked direct claim", async () => {
    const { id } = budgetFixture(false), bound = readTask(id)!, path = join(root, "state/tasks", `${id}.json`);
    const boundBytes = readFileSync(path), unbound = structuredClone(bound), beforeEvents = readTaskEvents(id);
    delete unbound.envelope.budget_admission; writeTask(unbound);
    const realUpdate = taskStore.updateTask;
    vi.spyOn(taskStore, "updateTask").mockImplementationOnce((taskId, mutate, dir) => {
      writeTask(bound); return realUpdate(taskId, mutate, dir);
    });
    expect(await runTask(id, root, executor)).toBeNull();
    expect(readFileSync(path).equals(boundBytes)).toBe(true); expect(readTaskEvents(id)).toEqual(beforeEvents);
    expect(existsSync(join(root, "reports"))).toBe(false); expect(run).not.toHaveBeenCalled(); expect(createWorktree).not.toHaveBeenCalled();
  });
  it.each([null, { schema_version: 99 }, { schema_version: 1, private: "Synthetic future data" }])("preserves invalid/future budget bytes without legacy fallback %j", async (binding) => {
    const task = queuedRecord(); writeTask(task);
    const path = join(root, "state/tasks/T-1.json");
    Object.assign(task.envelope, { budget_admission: binding }); writeFileSync(path, JSON.stringify(task)); const before = readFileSync(path);
    await expect(runTask("T-1", root, executor)).rejects.toThrow(/invalid task record/);
    expect(readFileSync(path).equals(before)).toBe(true); expect(readTaskEvents("T-1")).toEqual([]);
    expect(existsSync(join(root, "reports"))).toBe(false); expect(run).not.toHaveBeenCalled();
  });
  it("settles complete known usage only after the owned terminal task snapshot", async () => {
    const { id, budgets, runId, proof } = budgetFixture();
    const settle = budgets.settle.bind(budgets);
    vi.spyOn(budgets, "settle").mockImplementation(async (...args) => {
      expect(readTask(id)).toMatchObject({ lifecycle: "finished", outcome: "completed", orchestration: { lease: null, cumulative_tokens: 15 } });
      const held = Object.values(readBudgetLedger()!.reservations)[0]!;
      expect(held.status).toBe("active"); expect(held.held.concurrent_reads).toBe(1);
      return settle(...args);
    });
    expect(await runTask(id, root, executor, { runId, budgetExecution: proof })).toMatchObject({ outcome: "completed", retryable: false, stale: false });
    expect(run).toHaveBeenCalledOnce();
    const ledger = readBudgetLedger()!;
    expect(Object.values(ledger.reservations)[0]).toMatchObject({ status: "settled", uncertain_dimensions: [] });
    expect(Object.values(ledger.charges)[0]).toMatchObject({ status: "terminal", observed_total_tokens: 15, usage_state: "complete" });
  });
  it.each(["missing", "incomplete", "invalid", "stream-invalid", "malformed-complete", "invalid-highwater"])("retains known charges and unknown holds on %s final accounting", async (kind) => {
    const { id, runId, proof } = budgetFixture();
    run.mockImplementation(async (_input, events) => {
      await events({ type: "usage", at: new Date().toISOString(), threadId: "thread-1", turnId: "turn-1", usage: agentRun().usage! });
      if (kind === "stream-invalid") await events({ type: "usage", at: new Date().toISOString(), threadId: "thread-1", turnId: "turn-1", usage: { totalTokens: -1 } as any });
      return agentRun(kind === "missing" ? { usage: null } : kind === "incomplete" ? { usageComplete: false } : kind === "invalid" ? { usage: { totalTokens: -1 } as any }
        : kind === "malformed-complete" ? { usageComplete: "true" as any } : kind === "invalid-highwater" ? { usageHighWater: { totalTokens: -1 } as any } : {});
    });
    expect(await runTask(id, root, executor, { runId, budgetExecution: proof })).toMatchObject({ outcome: "needs-review", retryable: false });
    const ledger = readBudgetLedger()!, reservation = Object.values(ledger.reservations)[0]!;
    expect(reservation.status).toBe("unknown"); expect(reservation.held.concurrent_reads).toBe(1);
    expect(reservation.uncertain_dimensions).toContain("total_tokens");
    expect(Object.values(ledger.charges)[0]).toMatchObject({ observed_total_tokens: 15, usage_state: "unknown" });
    expect(readTask(id)!.orchestration!.cumulative_tokens).toBe(15);
    expect(commitAndDiff).not.toHaveBeenCalled(); expect(captureVerification).not.toHaveBeenCalled();
  });
  it("distinguishes explicit complete zero from unavailable final usage", async () => {
    const { id, runId, proof } = budgetFixture();
    run.mockResolvedValue(agentRun({ usageComplete: true, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 } }));
    expect(await runTask(id, root, executor, { runId, budgetExecution: proof })).toMatchObject({ outcome: "completed" });
    expect(Object.values(readBudgetLedger()!.charges)[0]).toMatchObject({ observed_total_tokens: 0, usage_state: "complete" });
    expect(Object.values(readBudgetLedger()!.reservations)[0]!.status).toBe("settled");
  });
  it("never promotes known intermediate usage into certainty after executor interruption", async () => {
    const { id, runId, proof } = budgetFixture();
    run.mockImplementation(async (_input, events) => {
      await events({ type: "usage", at: new Date().toISOString(), threadId: "thread-1", turnId: "turn-1", usage: agentRun().usage! });
      throw new Error("Synthetic interrupted turn");
    });
    expect(await runTask(id, root, executor, { runId, budgetExecution: proof })).toMatchObject({ outcome: "needs-review", retryable: false });
    expect(Object.values(readBudgetLedger()!.charges)[0]).toMatchObject({ observed_total_tokens: 15, usage_state: "unknown" });
    expect(Object.values(readBudgetLedger()!.reservations)[0]!.held.concurrent_reads).toBe(1);
  });
  it("conserves holds and refuses retry when post-snapshot settlement fails", async () => {
    const { id, budgets, runId, proof } = budgetFixture();
    vi.spyOn(budgets, "settle").mockRejectedValue(new Error("Synthetic ledger I/O failure"));
    expect(await runTask(id, root, executor, { runId, budgetExecution: proof })).toMatchObject({ outcome: "needs-review", retryable: false, stale: false });
    expect(readTask(id)).toMatchObject({ lifecycle: "finished", outcome: "needs-review", orchestration: { lease: null, cumulative_tokens: 15, last_failure: { kind: "terminal" } } });
    expect(Object.values(readBudgetLedger()!.reservations)[0]).toMatchObject({ status: "unknown", held: { concurrent_reads: 1 } });
    expect(Object.values(readBudgetLedger()!.charges)[0]).toMatchObject({ observed_total_tokens: 15, status: "terminal" });
    expect(() => new TaskOrchestrator({ repoRoot: root, executor }).retry(id)).toThrow();
  });
  it("retains a late owned receipt without changing a foreign worker lease or its task progress", async () => {
    const { id, runId, proof } = budgetFixture(); let foreignBytes!: Buffer;
    run.mockImplementation(async () => {
      updateTask(id, (task) => { task.orchestration!.lease!.worker_id = "foreign-worker"; });
      foreignBytes = readFileSync(join(root, "state/tasks", `${id}.json`)); return agentRun({ usageComplete: true });
    });
    expect(await runTask(id, root, executor, { runId, budgetExecution: proof })).toMatchObject({ stale: true, retryable: false });
    expect(readFileSync(join(root, "state/tasks", `${id}.json`)).equals(foreignBytes)).toBe(true);
    expect(readTask(id)!.orchestration!.cumulative_tokens).toBe(0);
    expect(Object.values(readBudgetLedger()!.charges)[0]!.observed_total_tokens).toBe(15);
    expect(Object.values(readBudgetLedger()!.reservations)[0]).toMatchObject({ status: "unknown", held: { concurrent_reads: 1 } });
  });
  it("counts duplicate and decreasing samples once without refunding proven usage", async () => {
    const { id, runId, proof } = budgetFixture();
    run.mockImplementation(async (_input, events) => {
      for (const totalTokens of [15, 15, 12]) await events({ type: "usage", at: new Date().toISOString(), threadId: "thread-1", turnId: "turn-1", usage: { ...agentRun().usage!, totalTokens } });
      return agentRun({ usageComplete: true, usage: { ...agentRun().usage!, totalTokens: 5 } });
    });
    expect(await runTask(id, root, executor, { runId, budgetExecution: proof })).toMatchObject({ outcome: "completed" });
    expect(readTask(id)!.orchestration!.cumulative_tokens).toBe(15);
    expect(Object.values(readBudgetLedger()!.charges)).toHaveLength(1);
    expect(Object.values(readBudgetLedger()!.charges)[0]!.observed_total_tokens).toBe(15);
  });
  it("fences a tightened current runtime before any post-model effect", async () => {
    const { id, runId, proof } = budgetFixture(); vi.useFakeTimers();
    run.mockImplementation(async () => {
      updateTask(id, (task) => { task.orchestration!.max_runtime_ms = 1000; });
      vi.setSystemTime(Date.now() + 1500); return agentRun({ usageComplete: true });
    });
    expect(await runTask(id, root, executor, { runId, budgetExecution: proof })).toMatchObject({ outcome: "failed", retryable: false });
    expect(readTask(id)!.orchestration!.last_failure).toMatchObject({ kind: "budget", message: "runtime budget exhausted (1000ms)" });
    expect(Object.values(readBudgetLedger()!.charges)[0]!.runtime_ms).toBeGreaterThanOrEqual(1500);
    expect(commitAndDiff).not.toHaveBeenCalled(); expect(captureVerification).not.toHaveBeenCalled();
  });
  it.each([null, { totalTokens: -1 }, { totalTokens: 1.5 }, { totalTokens: Number.NaN }])("does not persist invalid custom usage %j as zero or corrupt counters", async (usage) => {
    writeTask(queuedRecord()); run.mockResolvedValue(agentRun({ usage: usage as any }));
    await runTask("T-1", root, executor);
    expect(readTask("T-1")!.orchestration!.cumulative_tokens).toBe(0);
    expect((readTask("T-1")!.envelope.metadata.run as any).usage).toBeNull();
  });
  async function testingFixture(strict = false, initialValue = 0, verify = true, refactor = false) {
    contextFixture();
    const source = `import {readFileSync} from 'node:fs'; const ok=JSON.parse(readFileSync('src/value.json','utf8')).value===1; console.log(JSON.stringify({schema_version:1,assertions:[{id:'behavior',status:ok?'passed':'assertion-failed'}]})); process.exit(ok?0:1);`;
    mkdirSync(join(repo, "src")); writeFileSync(join(repo, "src/value.json"), JSON.stringify({ value: initialValue })); writeFileSync(join(repo, "verify.mjs"), source);
    if (refactor) writeFileSync(join(repo, "refactor.mjs"), "process.exit(0)");
    writeFileSync(join(root, "registry/projects.yml"), `projects:\n  stock-control:\n    allowed_agents: [backend-engineer]\n    sandbox: { default: workspace-write }\n    verify: ['node ${verify ? "verify" : "missing"}.mjs'${refactor ? ", 'node refactor.mjs'" : ""}]\n`);
    if (strict) {
      const config = parse(readFileSync(join(root, "registry/context-policy.yml"), "utf8"));
      const probe = { sources: [{ path: "verify.mjs", sha256: evidenceHash(source) }], assertion_ids: ["behavior"] };
      config.runners = { red: { command: "node verify.mjs", stage: "red", probe }, green: { command: "node verify.mjs", stage: "green", probe } };
      config.testing.global = { mode: "strict-tdd", minimum_review_depth: "full", runner_ids: ["red", "green"] };
      if (refactor) { config.runners.refactor = { stage: "refactor", command: "node refactor.mjs" }; config.testing.global.runner_ids.push("refactor"); }
      else config.testing.no_refactor_justification = "Only a bounded behavior value changes; no structural refactoring is required.";
      writeFileSync(join(root, "registry/context-policy.yml"), stringify(config));
    }
    const git = (args: string[]) => execFileSync("git", managedGitArgs(["-C", repo, ...args], root), { env: localGitEnvironment(), windowsHide: true });
    git(["init", "--quiet"]); git(["config", "user.name", "Synthetic"]); git(["config", "user.email", "fixture@example.test"]); git(["add", "."]); git(["commit", "--quiet", "-m", "base"]);
    const real = await vi.importActual<typeof import("./worktree")>("./worktree");
    vi.mocked(createWorktree).mockImplementation(real.createWorktree); vi.mocked(commitAndDiff).mockImplementation(real.commitAndDiff);
    const context = createContextService(root), issues = createIssueService(root, { context, projectIds: () => ["stock-control"] });
    const proposed = issues.create({ project_id: "stock-control", title: "Fixture behavior fix", expected_outcome: "Behavior is 1", acceptance_criteria: ["Behavior assertion passes"], criticality: "low", assigned_role_id: "backend-engineer", authorized_scope: { expected_outcome: "Behavior is 1", acceptance_criteria: ["Behavior assertion passes"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["implementation"], explicit_exclusions: [] } });
    const issue = issues.authorize(proposed.id, proposed.revision, "Synthetic human scope approval");
    const preview = context.preview({ kind: "issue", project: "stock-control", agent: "backend-engineer", role_id: "software-engineer", issue_id: issue.id, expected_revision: issue.revision });
    const { taskId } = issues.dispatch(issue.id, issue.revision, "backend-engineer", { role_id: "software-engineer", preview_fingerprint: preview.fingerprint });
    return { taskId, issues, issue };
  }
  it.each([true, false])("runs an isolated budget writer and admits commit/verification only with complete usage=%s", async (complete) => {
    const { taskId } = await testingFixture(), { id, runId, proof } = budgetFixture(true, taskId);
    run.mockImplementation(async (input) => {
      writeFileSync(join(input.cwd, "src/value.json"), JSON.stringify({ value: 1 }));
      return agentRun({ usageComplete: complete });
    });
    expect(await runTask(id, root, executor, { runId, budgetExecution: proof })).toMatchObject({ outcome: complete ? "completed" : "needs-review", retryable: false });
    expect(createWorktree).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledOnce();
    if (complete) {
      expect(commitAndDiff).toHaveBeenCalledOnce(); expect(captureVerification).toHaveBeenCalledOnce();
      expect(testingEvidenceStatus(readTask(id)!.testing_evidence!)).toBe("passed");
      expect(Object.values(readBudgetLedger()!.reservations)[0]!.status).toBe("settled");
    } else {
      expect(commitAndDiff).not.toHaveBeenCalled(); expect(captureVerification).not.toHaveBeenCalled();
      expect(Object.values(readBudgetLedger()!.reservations)[0]).toMatchObject({ status: "unknown", held: { concurrent_writes: 1 } });
    }
  }, 20_000);
  it("denies the next verification command after runtime tightens past elapsed time, even with an earlier ledger sample", async () => {
    const { taskId } = await testingFixture(false, 0, true, true), { id, runId, proof } = budgetFixture(true, taskId);
    vi.useFakeTimers(); const admittedCommands: string[] = [];
    run.mockImplementation(async (input) => {
      writeFileSync(join(input.cwd, "src/value.json"), JSON.stringify({ value: 1 })); return agentRun({ usageComplete: true });
    });
    vi.mocked(captureVerification).mockImplementationOnce(async (_cwd, runners, options) => {
      expect(runners).toHaveLength(2); expect(options.ownsAttempt()).toBe(true);
      expect(options.authorizeCommand!(runners[0]!.command)).toBe(true); admittedCommands.push(runners[0]!.command);
      updateTask(id, (task) => { task.orchestration!.max_runtime_ms = 1000; });
      vi.setSystemTime(Date.now() + 1200);
      expect(Object.values(readBudgetLedger()!.charges)[0]!.runtime_ms).toBeLessThan(1000);
      expect(options.ownsAttempt()).toBe(false); expect(options.authorizeCommand!(runners[1]!.command)).toBe(false);
      return { observations: [], report: { status: "failed", checks: [{ command: runners[0]!.command, ok: false, output_tail: "Synthetic bounded command stopped" }] } };
    });
    expect(await runTask(id, root, executor, { runId, budgetExecution: proof })).toMatchObject({ outcome: "needs-review", retryable: false });
    expect(admittedCommands).toEqual(["node verify.mjs"]); expect(captureVerification).toHaveBeenCalledOnce();
    expect(Object.values(readBudgetLedger()!.charges)[0]!.runtime_ms).toBeGreaterThanOrEqual(1200);
  }, 20_000);
  it.each([{ strict: false, refactor: false }, { strict: true, refactor: false }, { strict: true, refactor: true }])("captures ordered evidence with real isolated Git and one fake turn strict=$strict refactor=$refactor", async ({ strict, refactor }) => {
    const { taskId, issues, issue } = await testingFixture(strict, 0, true, refactor);
    run.mockImplementation(async (input) => {
      if (strict) {
        const pre = readTask(taskId)!.testing_evidence!;
        expect(pre.observations.map((entry) => entry.outcome)).toEqual(["assertion-failed"]); expect(pre.implementation).toBeNull(); expect(pre.candidate).toBeNull();
      }
      writeFileSync(join(input.cwd, "src/value.json"), JSON.stringify({ value: 1 }));
      return agentRun({ structuredOutput: structuredReport({ tests_run: ["Narrative is not receipt evidence"] }) });
    });
    await runTask(taskId, root, executor);
    const task = readTask(taskId)!;
    expect(task.outcome).toBe("completed"); expect(run).toHaveBeenCalledOnce(); expect(runVerification).not.toHaveBeenCalled();
    expect(testingEvidenceStatus(task.testing_evidence!)).toBe("passed");
    if (refactor) expect(task.testing_evidence!.observations.map((entry) => entry.stage)).toEqual(["red", "green", "refactor"]);
    const lineage = issues.get(issue.id), candidate = lineage.candidates.at(-1)!;
    expect(lineage.issue.status).toBe("ready-for-review");
    expect(lineage.evidence.some((entry) => entry.kind === "verification" && entry.testing_evidence_fingerprint === task.testing_evidence!.fingerprint && entry.status === "passed")).toBe(true);
    expect(issues.acceptCandidate(issue.id, { expectedRevision: lineage.issue.revision, candidateId: candidate.id, fingerprint: candidate.diff_fingerprint, approvalId: "Synthetic acceptance", rationale: "Verified exact behavior and candidate", confirmedCriteria: issue.acceptance_criteria }).status).toBe("done");
  }, 20_000);
  it.each(["failed", "missing"])("does not promote an agent success claim over %s functional verification", async (failure) => {
    const { taskId, issues, issue } = await testingFixture(false, 0, failure !== "missing");
    run.mockImplementation(async (input) => { writeFileSync(join(input.cwd, "src/value.json"), JSON.stringify({ value: failure === "failed" ? 2 : 1 })); return agentRun({ structuredOutput: structuredReport({ tests_run: ["Everything passed according to the model"] }) }); });
    await runTask(taskId, root, executor);
    expect(readTask(taskId)!.outcome).toBe("needs-review"); expect(issues.get(issue.id).issue.status).toBe("needs-decision");
    expect(issues.get(issue.id).evidence.filter((entry) => entry.kind === "verification").every((entry) => entry.status !== "passed")).toBe(true);
  }, 20_000);
  it("blocks a non-failing RED before the implementation turn and preserves captured failure evidence", async () => {
    const { taskId, issues, issue } = await testingFixture(true, 1);
    await runTask(taskId, root, executor);
    expect(run).not.toHaveBeenCalled(); expect(commitAndDiff).not.toHaveBeenCalled();
    expect(readTask(taskId)!.outcome).toBe("needs-review"); expect(readTask(taskId)!.testing_evidence!.candidate).toBeNull();
    expect(issues.get(issue.id).issue.status).toBe("blocked");
  }, 20_000);
  it("rejects a changed pinned probe before any worktree or model effects", async () => {
    const { taskId } = await testingFixture(true);
    writeFileSync(join(repo, "verify.mjs"), "operator source drift");
    await runTask(taskId, root, executor);
    expect(run).not.toHaveBeenCalled(); expect(createWorktree).not.toHaveBeenCalled(); expect(readTask(taskId)!.outcome).toBe("needs-review");
  }, 20_000);
  it.each(["commands", "testing"])("does not verify or promote a candidate after current %s policy is revoked during the fake turn", async (change) => {
    const { taskId, issues, issue } = await testingFixture();
    run.mockImplementation(async (input) => {
      writeFileSync(join(input.cwd, "src/value.json"), JSON.stringify({ value: 1 }));
      if (change === "commands") writeFileSync(join(root, "registry/projects.yml"), "projects:\n  stock-control:\n    allowed_agents: [backend-engineer]\n    sandbox: { default: workspace-write }\n    verify: ['node revoked.mjs']\n");
      else {
        const config = parse(readFileSync(join(root, "registry/context-policy.yml"), "utf8")); config.testing.global.minimum_review_depth = "full";
        writeFileSync(join(root, "registry/context-policy.yml"), stringify(config));
      }
      return agentRun();
    });
    await runTask(taskId, root, executor);
    expect(readTask(taskId)!.outcome).toBe("needs-review"); expect(readTask(taskId)!.testing_evidence!.observations).toEqual([]);
    expect(issues.get(issue.id).issue.status).toBe("needs-decision");
  }, 20_000);
  it("routes recovery of an interrupted unverified candidate to the existing decision path without a new model turn", async () => {
    const { taskId, issues, issue } = await testingFixture();
    updateTask(taskId, (task) => {
      const at = new Date().toISOString(); task.lifecycle = "running"; task.orchestration!.attempts = 1;
      task.orchestration!.lease = { run_id: "interrupted-run", worker_id: "fixture", acquired_at: at, heartbeat_at: at, expires_at: new Date(Date.now() + 60_000).toISOString() };
    });
    const candidate = issues.recordCandidate({ issueId: issue.id, taskId, executionId: "interrupted-run", repositoryId: "stock-control", baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40), changedPaths: ["src/value.json"], scopeRevision: issue.scope_revision });
    updateTask(taskId, (task) => { task.lifecycle = "queued"; task.orchestration!.lease = null; });
    await runTask(taskId, root, executor);
    expect(run).not.toHaveBeenCalled(); expect(createWorktree).not.toHaveBeenCalled(); expect(commitAndDiff).not.toHaveBeenCalled();
    expect(readTask(taskId)!.outcome).toBe("needs-review"); expect(readTask(taskId)!.testing_evidence).toBeUndefined();
    const decision = issues.get(issue.id); expect(decision.issue.status).toBe("needs-decision");
    expect(decision.candidates.find((entry) => entry.id === candidate.id)?.invalidated_at).toBeNull();
    expect(issues.resolveDecision(issue.id, decision.issue.revision, "Synthetic recovery decision", "Explicitly regenerate preview and admit a new task").status).toBe("authorized");
  }, 20_000);
  it("executes current admitted project context rather than the control plane root primer", async () => {
    const id = analysisFixture();
    await runTask(id, root, executor);
    expect(readTask(id)?.outcome).toBe("completed"); expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0].developerInstructions).toContain("SELECTED PROJECT RULE");
    expect(run.mock.calls[0][0].developerInstructions).not.toContain("ROOT RULE");
    expect(run.mock.calls[0][0].contextFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(readTaskEvents(id).some((event) => event.payload.boundary === "execution-context")).toBe(true);
  });
  it("fences an expired governed lease before any model or worktree effect", async () => {
    const id = analysisFixture();
    updateTask(id, (task) => {
      task.lifecycle = "running"; task.orchestration!.attempts = 1;
      task.orchestration!.lease = { run_id: "expired-run", worker_id: "fixture", acquired_at: "2026-01-01T00:00:00.000Z", heartbeat_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-01T00:00:01.000Z" };
    });
    expect(await runTask(id, root, executor, { runId: "expired-run" })).toMatchObject({ stale: true });
    expect(run).not.toHaveBeenCalled(); expect(createWorktree).not.toHaveBeenCalled(); expect(readTask(id)!.lifecycle).toBe("running");
  });
  it("revalidates each attempt and resumes only its unchanged persisted contract", async () => {
    const id = analysisFixture(); await runTask(id, root, executor);
    updateTask(id, (record) => { record.lifecycle = "queued"; record.outcome = null; record.finished_at = null; });
    await runTask(id, root, executor);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0]).toMatchObject({ threadId: "thread-1", resumeContextFingerprint: run.mock.calls[0][0].contextFingerprint });
  });
  it.each(["source", "thread"])("holds changed governed %s contracts before any model or worktree effects", async (changed) => {
    const id = analysisFixture();
    if (changed === "source") writeFileSync(join(repo, "AGENTS.md"), "Changed required project source");
    else updateTask(id, (record) => { record.envelope.metadata.run = { thread_id: "unbound-thread" }; });
    await runTask(id, root, executor);
    expect(readTask(id)?.outcome).toBe("needs-review"); expect(run).not.toHaveBeenCalled(); expect(createWorktree).not.toHaveBeenCalled();
  });
  it.each([false, true])("executes current governed issues or exposes explicit blocked recovery when context changed=%s", async (changed) => {
    const context = contextFixture(); const issues = createIssueService(root, { context, projectIds: () => ["stock-control"] });
    const proposed = issues.create({ project_id: "stock-control", title: "Fixture fix", expected_outcome: "Fixture result", acceptance_criteria: ["Fixture passes"], criticality: "low", assigned_role_id: "backend-engineer", authorized_scope: { expected_outcome: "Fixture result", acceptance_criteria: ["Fixture passes"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["implementation"], explicit_exclusions: [] } });
    const issue = issues.authorize(proposed.id, proposed.revision, "Synthetic approval");
    const preview = context.preview({ kind: "issue", project: "stock-control", agent: "backend-engineer", role_id: "software-engineer", issue_id: issue.id, expected_revision: issue.revision });
    const { taskId } = issues.dispatch(issue.id, issue.revision, "backend-engineer", { role_id: "software-engineer", preview_fingerprint: preview.fingerprint });
    vi.mocked(createWorktree).mockReturnValue({ branch: "agent/fixture", worktreePath: repo });
    vi.mocked(commitAndDiff).mockReturnValue({ filesChanged: [], diffstat: "", committed: false, patch: "", patchTruncated: false });
    if (changed) writeFileSync(join(repo, "AGENTS.md"), "Changed required project context");
    await runTask(taskId, root, executor);
    if (changed) {
      expect(readTask(taskId)?.outcome).toBe("needs-review"); expect(run).not.toHaveBeenCalled(); expect(createWorktree).not.toHaveBeenCalled();
      const blocked = issues.get(issue.id).issue; expect(blocked.status).toBe("blocked");
      expect(issues.resumeBlocked(issue.id, blocked.revision, "Synthetic explicit decision to regenerate preview").status).toBe("authorized");
      return;
    }
    expect(readTask(taskId)?.outcome).toBe("needs-review"); expect(createWorktree).toHaveBeenCalledOnce();
    expect(testingEvidenceStatus(readTask(taskId)!.testing_evidence!)).toBe("incomplete");
    expect(run.mock.calls[0][0].mode).toBe("workspace-write-verify"); expect(run.mock.calls[0][0].developerInstructions).toContain("issue/authorized-work");
  });
  it.each(["read-only", "workspace-write"] as const)("holds governed %s tasks for review before model, worktree or verification effects", async (sandbox) => {
    const record = sandbox === "read-only" ? queuedRecord() : writeRecord();
    const budget = { max_attempts: 2, max_runtime_ms: 60_000, max_total_tokens: 10_000 };
    record.orchestration = { ...defaultTaskOrchestration(), ...budget };
    record.envelope.context_manifest = assembleContext({ schema_version: 1, project_id: record.envelope.project, agent_id: record.envelope.agent, task_kind: record.envelope.task_type, role_id: "software-engineer", sandbox,
      tools: sandbox === "read-only" ? ["inspect"] : ["inspect", "edit-authorized-scope"], approval_rules: ["publication"], budget, limits: { max_lines: 500, max_bytes: 60_000, max_sources: 64 }, selected_categories: [], excluded_categories: ["confidential-notes"], omitted_sources: [],
      routing: { work_scale: "bounded", action: "direct", review_depth: "focused", qa_required: false, reasons: ["Synthetic fixture"], delegation: { admitted: false, executable: false, reasons: ["Unavailable"] } },
      testing: { mode: "functional", minimum_review_depth: "focused", runner_ids: [], commands: [], reasons: ["Functional default"], requires_red_evidence: false } },
      [{ id: "runtime/safety-v1", layer: "runtime-safety", source_type: "policy", text: "Synthetic safety", reason: "Fixture", sensitivity: "public" }]).manifest;
    writeTask(record); const completion = await runTask("T-1", root, executor);
    expect(completion).toMatchObject({ outcome: "needs-review", retryable: false });
    expect(run).not.toHaveBeenCalled(); expect(createWorktree).not.toHaveBeenCalled(); expect(commitAndDiff).not.toHaveBeenCalled(); expect(runVerification).not.toHaveBeenCalled();
    const saved = readTask("T-1")!;
    expect(saved.lifecycle).toBe("finished"); expect(saved.outcome).toBe("needs-review"); expect(saved.orchestration!.lease).toBeNull();
    expect(saved.envelope.context_manifest).toEqual(record.envelope.context_manifest);
    expect(saved.envelope.metadata.run ?? {}).not.toHaveProperty("thread_id");
    expect(readTaskEvents("T-1").at(-1)?.type).toBe("needs-review");
  });
  it("transitions queued to finished and passes root instructions plus the output schema", async () => {
    writeTask(queuedRecord());

    await runTask("T-1", root, executor);

    const record = readTask("T-1")!;
    expect(record.lifecycle).toBe("finished");
    expect(record.outcome).toBe("completed");
    expect(record.result?.summary).toBe("ok");
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0].developerInstructions).toContain("ROOT RULE: do not deploy.");
    expect(run.mock.calls[0][0].outputSchema).toMatchObject({ title: "AgentReport", additionalProperties: false });
  });

  it("marks a runtime failure with a blocker", async () => {
    writeTask(queuedRecord());
    run.mockRejectedValue(new Error("runtime exploded"));

    await runTask("T-1", root, executor);

    expect(readTask("T-1")?.result?.blockers).toEqual(["runtime exploded"]);
  });

  it("routes invalid structured output to needs-review", async () => {
    writeTask(queuedRecord());
    run.mockResolvedValue(agentRun({ structuredOutput: { status: "completed" }, finalText: "raw report" }));

    await runTask("T-1", root, executor);

    const record = readTask("T-1")!;
    expect(record.outcome).toBe("needs-review");
    expect(record.result?.risks[0]).toContain("Invalid agent report");
  });

  it("fails before execution when the repository path does not exist", async () => {
    const record = queuedRecord();
    record.envelope.repo_path = join(root, "does-not-exist");
    writeTask(record);

    await runTask("T-1", root, executor);

    expect(readTask("T-1")?.result?.blockers[0]).toContain("repository path does not match");
    expect(run).not.toHaveBeenCalled();
  });

  it("fails before execution when the agent id is unknown", async () => {
    const record = queuedRecord();
    record.envelope.agent = "ghost-agent";
    writeTask(record);

    await runTask("T-1", root, executor);

    expect(readTask("T-1")?.result?.blockers[0]).toContain("unknown agent");
    expect(run).not.toHaveBeenCalled();
  });

  it("creates a worktree, executes there, commits, verifies, and records protocol metadata", async () => {
    const record = writeRecord();
    record.envelope.self_verify = true;
    writeTask(record);
    const worktreePath = join(root, "worktree");
    vi.mocked(createWorktree).mockReturnValue({ branch: "agent/T-1-backend-engineer", worktreePath });
    vi.mocked(commitAndDiff).mockReturnValue({
      filesChanged: ["src/x.ts"], diffstat: "1 file changed", committed: true,
      patch: "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n", patchTruncated: false,
    });

    await runTask("T-1", root, executor);

    expect(run.mock.calls[0][0]).toMatchObject({ cwd: worktreePath, mode: "workspace-write-verify", verifyCommands: ["pnpm test"] });
    expect(commitAndDiff).toHaveBeenCalledWith(worktreePath, expect.any(String), undefined);
    expect(runVerification).toHaveBeenCalledWith(worktreePath, ["pnpm test"]);
    const finished = readTask("T-1")!;
    expect(finished.result?.files_changed).toEqual(["src/x.ts"]);
    expect(finished.envelope.metadata.run).toMatchObject({
      thread_id: "thread-1", turn_id: "turn-1", diff_path: expect.stringMatching(/\.diff$/), diff_truncated: false,
    });
    expect(readFileSync(join(root, (finished.envelope.metadata.run as { diff_path: string }).diff_path), "utf8")).toContain("+export const x");
  });

  it("uses plain write mode when self verification is not requested", async () => {
    writeTask(writeRecord());
    vi.mocked(createWorktree).mockReturnValue({ branch: "branch", worktreePath: join(root, "worktree") });
    vi.mocked(commitAndDiff).mockReturnValue({ filesChanged: [], diffstat: "", committed: false, patch: "", patchTruncated: false });

    await runTask("T-1", root, executor);

    expect(run.mock.calls[0][0].mode).toBe("workspace-write");
    expect(runVerification).not.toHaveBeenCalled();
  });

  it("fails cleanly when a write target is not a git repository", async () => {
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    writeTask(writeRecord());

    await runTask("T-1", root, executor);

    expect(readTask("T-1")?.result?.blockers[0]).toContain("contained local git checkout");
    expect(run).not.toHaveBeenCalled();
  });

  it("turns the five-minute runtime budget into a terminal failed task", async () => {
    vi.useFakeTimers();
    writeTask(queuedRecord());
    run.mockImplementation((_input, _events, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("interrupted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }));

    const pending = runTask("T-1", root, executor);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await pending;

    const finished = readTask("T-1")!;
    expect(finished.result?.blockers).toEqual(["runtime budget exhausted (300000ms)"]);
    expect(finished.orchestration?.last_failure?.kind).toBe("budget");
  });

  it("persists thread, turn, usage, and append-only lifecycle events", async () => {
    writeTask(queuedRecord());
    run.mockImplementation(async (_input, events) => {
      await events({ type: "thread-started", at: "2026-09-21T10:00:00Z", threadId: "thread-durable" });
      await events({ type: "turn-started", at: "2026-09-21T10:00:01Z", threadId: "thread-durable", turnId: "turn-durable" });
      await events({
        type: "approval", at: "2026-09-21T10:00:01Z", threadId: "thread-durable", turnId: "turn-durable",
        approval: "command", allowed: true, command: "printenv PRIVATE_TOKEN",
      });
      await events({ type: "warning", at: "2026-09-21T10:00:01Z", threadId: "thread-durable", turnId: "turn-durable", message: "runtime warning" });
      await events({
        type: "usage",
        at: "2026-09-21T10:00:02Z",
        threadId: "thread-durable",
        turnId: "turn-durable",
        usage: { inputTokens: 8, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 13 },
      });
      return agentRun({ threadId: "thread-durable", turnId: "turn-durable" });
    });

    await runTask("T-1", root, executor);

    const finished = readTask("T-1")!;
    expect(finished.envelope.metadata.run).toMatchObject({ thread_id: "thread-durable", turn_id: "turn-durable" });
    expect(finished.orchestration?.cumulative_tokens).toBe(15);
    const events = readTaskEvents("T-1");
    expect(events.map((event) => event.type)).toEqual([
      "claimed", "started", "policy-evaluated", "thread-started", "turn-started", "approval-recorded", "warning", "usage", "usage", "completed",
    ]);
    expect(events.find((event) => event.type === "approval-recorded")?.payload).toEqual({
      approval: "command", allowed: true, thread_id: "thread-durable", turn_id: "turn-durable",
    });
  });

  it("refuses a persisted legacy thread without an admitted context binding", async () => {
    const record = queuedRecord();
    record.envelope.metadata.run = { thread_id: "thread-existing" };
    writeTask(record);

    await runTask("T-1", root, executor);

    expect(run).not.toHaveBeenCalled();
    expect(readTask("T-1")?.outcome).toBe("needs-review");
  });
  it("refuses legacy second attempts even without a persisted thread", async () => {
    const record = queuedRecord(); record.orchestration = { ...defaultTaskOrchestration(), attempts: 1 };
    writeTask(record); await runTask("T-1", root, executor);
    expect(run).not.toHaveBeenCalled(); expect(readTask("T-1")?.outcome).toBe("needs-review");
  });

  it("delivers durable cancellation through the external abort signal", async () => {
    writeTask(queuedRecord());
    const controller = new AbortController();
    run.mockImplementation((_input, _events, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("interrupted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }));

    const pending = runTask("T-1", root, executor, { signal: controller.signal });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    updateTask("T-1", (record) => {
      record.orchestration!.cancel_requested_at = new Date().toISOString();
    });
    controller.abort();
    const completion = await pending;

    expect(completion).toMatchObject({ outcome: "cancelled", retryable: false, stale: false });
    expect(readTask("T-1")).toMatchObject({ lifecycle: "finished", outcome: "cancelled", result: { status: "cancelled" } });
  });

  it("aborts when cumulative token usage exceeds the task budget", async () => {
    const record = queuedRecord();
    record.orchestration = { ...defaultTaskOrchestration(), max_total_tokens: 10 };
    record.revision = 1;
    writeTask(record);
    run.mockImplementation(async (_input, events, signal) => {
      await events({
        type: "usage",
        at: new Date().toISOString(),
        threadId: "thread-1",
        turnId: "turn-1",
        usage: { inputTokens: 11, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 11 },
      });
      expect(signal.aborted).toBe(true);
      const error = new Error("interrupted");
      error.name = "AbortError";
      throw error;
    });

    await runTask("T-1", root, executor);

    expect(readTask("T-1")?.orchestration).toMatchObject({ cumulative_tokens: 11, last_failure: { kind: "budget" } });
    expect(readTask("T-1")?.result?.blockers).toEqual(["token budget exhausted (10)"]);
  });

  it("does not let a stale attempt overwrite a replacement lease", async () => {
    writeTask(queuedRecord());
    let resolveRun!: (value: AgentRunResult) => void;
    run.mockImplementation(() => new Promise((resolve) => { resolveRun = resolve; }));

    const pending = runTask("T-1", root, executor);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    updateTask("T-1", (record) => {
      record.orchestration!.lease!.run_id = "replacement-run";
      record.orchestration!.lease!.worker_id = "replacement-worker";
    });
    resolveRun(agentRun());
    const completion = await pending;

    expect(completion).toMatchObject({ stale: true });
    expect(readTask("T-1")).toMatchObject({ lifecycle: "running", orchestration: { lease: { run_id: "replacement-run" } } });
  });

  it("redacts credentials from streamed logs", async () => {
    writeTask(queuedRecord());
    run.mockImplementation(async (_input, events) => {
      await events({ type: "warning", at: new Date().toISOString(), message: "api_key=top-secret-value" });
      return agentRun();
    });

    await runTask("T-1", root, executor);

    const record = readTask("T-1")!;
    const log = readFileSync(join(root, record.logs_path!), "utf8");
    expect(log).not.toContain("top-secret-value");
    expect(log).toContain("[REDACTED]");
  });

  it("records injected trace identifiers without requiring a tracing package", async () => {
    writeTask(queuedRecord());
    const addEvent = vi.fn();
    const end = vi.fn();
    const tracer: Tracer = {
      startSpan: vi.fn(() => ({ context: { traceId: "trace-1", spanId: "span-1" }, addEvent, end })),
    };

    await runTask("T-1", root, executor, { tracer });

    expect(readTask("T-1")?.envelope.metadata.run).toMatchObject({ trace_id: "trace-1", span_id: "span-1" });
    expect(addEvent).toHaveBeenCalledWith("task.finished", { outcome: "completed", retryable: false });
    expect(end).toHaveBeenCalledWith("ok");
  });
});
