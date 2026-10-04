import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import type { AgentRoleRegistry } from "../lib/context/types";
import type { WorkflowBudget, WorkflowRoleOutput } from "../lib/workflows/types";
import type { AgentExecutor } from "./agent-executor";
import { listTasks, readTask, updateTask } from "../lib/state/store";
import { readIssueDocument } from "../lib/state/issues";
import { mutateWorkflowDocument, readWorkflowDocument } from "../lib/state/workflows";
import { createIssueService } from "../dashboard/src/server/issue-service";
import { WorkflowOrchestrator, workflowExecutionOwner } from "./workflow-orchestrator";
import { TaskOrchestrator } from "./task-orchestrator";
import { runTask } from "./run-task";
import { createWorkflowService } from "../dashboard/src/server/workflow-service";
import { createWorkflowTask } from "../dashboard/src/server/dispatch";
import { createContextService } from "../dashboard/src/server/context-service";
import { createTestingEvidence, sealTestingEvidence } from "../lib/context/testing-evidence";
import { managedGitArgs } from "../lib/security/managed-git.mjs";
import { localGitEnvironment } from "../lib/security/environment";
import { createWorktree, commitAndDiff } from "./worktree";
import { captureVerification } from "./verify";

let root: string, state: string, issueId: string, worker: TaskOrchestrator | undefined;
const roles = { "portfolio-analyst": "product-manager", planner: "tech-lead", "software-engineer": "backend-engineer", reviewer: "reality-checker", "qa-evaluator": "qa-reviewer", "operations-observer": "devops-engineer" };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-workflow-worker-")); state = join(root, "state");
  mkdirSync(join(root, "projects/alpha/.git"), { recursive: true }); mkdirSync(join(root, "registry"));
  for (const name of ["agents.yml", "agent-roles.yml", "context-policy.yml", "workflow-policy.yml"]) cpSync(`registry/${name}`, join(root, "registry", name));
  const registry = parse(readFileSync("registry/agent-roles.yml", "utf8")) as AgentRoleRegistry;
  for (const path of new Set(registry.roles.flatMap((role) => role.required_evaluation_ids))) { mkdirSync(join(root, ...path.split("/").slice(0, -1)), { recursive: true }); cpSync(path, join(root, path)); }
  writeFileSync(join(root, "registry/projects.yml"), `projects:\n  alpha:\n    allowed_agents: [${Object.values(roles).join(", ")}]\n    sandbox: { default: workspace-write }\n    verify: ['node verify.mjs']\n`);
  writeFileSync(join(root, "projects/alpha/AGENTS.md"), "Synthetic bounded project rules; no authority.");
  vi.stubEnv("SURTEC_STATE_DIR", state); vi.stubEnv("SURTEC_PROJECTS_ROOT", join(root, "projects"));
  const issues = createIssueService(root, { projectIds: () => ["alpha"] });
  const proposed = issues.create({ project_id: "alpha", title: "Synthetic workflow", expected_outcome: "Observable synthetic result", acceptance_criteria: ["Observable acceptance"], assigned_role_id: "backend-engineer", plan: ["Existing plan"],
    authorized_scope: { expected_outcome: "Observable synthetic result", acceptance_criteria: ["Observable acceptance"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["implementation"], explicit_exclusions: [] } });
  issueId = proposed.id; issues.authorize(issueId, proposed.revision, "synthetic-scope-human");
});
afterEach(async () => { await worker?.stop(); worker = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false); });
function output(kind: "analysis" | "plan" | "operations" = "analysis"): WorkflowRoleOutput {
  const base = { schema_version: 1 as const, status: "completed" as const, summary: "Bounded synthetic output", evidence_ids: [], unresolved_questions: [], risks: [], recommended_next_action: "Human inspection", requested_decision: null };
  return kind === "plan" ? { ...base, kind, plan: ["Only authorized paths"], scope_change_required: false } : kind === "operations" ? { ...base, kind, proposed_issue: null } : { ...base, kind, recommendations: ["Inspect evidence"] };
}
function fixture(template: "analysis" | "implementation" | "trivial-change" | "operations-investigation" = "analysis", value: unknown = output(), usage = true, budget?: WorkflowBudget) {
  const controller = new WorkflowOrchestrator(root), executor: AgentExecutor = { run: vi.fn(async () => ({ finalText: "Never copy this raw fallback", structuredOutput: value, threadId: "synthetic-thread", turnId: "synthetic-turn",
    usage: usage ? { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 3 } : null })) };
  worker = new TaskOrchestrator({ repoRoot: root, workflows: controller, executor, maxConcurrent: 1 });
  const selected = template === "analysis" ? ["portfolio-analyst"] : template === "operations-investigation" ? ["operations-observer"] : template === "implementation" ? ["planner", "software-engineer", "reviewer"] : ["software-engineer", "reviewer"];
  const request = { template_id: template, template_version: 1, project_id: "alpha", issue_id: issueId, expected_revision: readIssueDocument().issues[issueId]!.revision,
    selected_agents: Object.fromEntries(selected.map((role) => [role, roles[role as keyof typeof roles]])), ...(budget ? { budget } : {}) };
  const preview = controller.service.preview(request); expect(preview.allowed).toBe(true);
  const started = controller.service.start({ request, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-root-human" });
  return { controller, executor, taskId: started.stages[0]!.task_id!, id: started.workflow.id, stageId: started.stages[0]!.id, request };
}
async function complete(taskId: string) { expect(await worker!.runOnce()).toBe(1); await vi.waitFor(() => expect(readTask(taskId)?.lifecycle).toBe("finished"), { timeout: 5000 }); }
function claim(f: ReturnType<typeof fixture>) {
  const runId = "synthetic-owned-run", at = new Date().toISOString();
  updateTask(f.taskId, (task) => {
    task.lifecycle = "running"; task.orchestration!.attempts = 1;
    task.orchestration!.lease = { run_id: runId, worker_id: worker!.workerId, acquired_at: at, heartbeat_at: at, expires_at: new Date(Date.now() + 60000).toISOString() };
  });
  return { proof: f.controller.claimRun(f.taskId, runId), runId };
}
describe("finite workflow controller integration", () => {
  it.each([["analysis", "analysis"], ["implementation", "plan"], ["operations-investigation", "operations"]] as const)("runs only the exact first read-only %s stage and retains a human gate", async (template, kind) => {
    const f = fixture(template, output(kind)), issueBefore = readIssueDocument(); await complete(f.taskId);
    expect(readTask(f.taskId)?.outcome).toBe("completed");
    const detail = f.controller.service.detail(f.id); expect(detail.workflow.status).toBe("waiting-human"); expect(detail.stages[0]!.status).toBe("completed");
    expect(detail.workflow.counters).toMatchObject({ tasks: 1, attempts: 1, total_tokens: 3, accounting_complete: true }); expect(detail.accounting[0]!.usage_complete).toBe(true);
    expect(detail.decisions[0]!.kind).toBe(kind === "plan" ? "plan-approval" : "proposal-acknowledgement");
    expect(f.executor.run).toHaveBeenCalledOnce(); const [run] = vi.mocked(f.executor.run).mock.calls[0]!;
    expect(run.mode).toBe("read-only"); expect(run.verifyCommands).toEqual([]); expect(run.threadId).toBeUndefined(); expect(JSON.stringify(run.outputSchema)).toContain(`"${kind}"`);
    expect(readIssueDocument()).toEqual(issueBefore); expect(detail.handoffs).toEqual([]); expect(detail.review_receipts).toEqual([]);
    expect(existsSync(join(root, "projects/surtec-worktrees"))).toBe(false);
    const bytes = readFileSync(join(state, "workflows/workflows.json"));
    f.controller.reconcile(); await worker!.runOnce(); new WorkflowOrchestrator(root).reconcile();
    expect(readFileSync(join(state, "workflows/workflows.json"))).toEqual(bytes); expect(listTasks()).toHaveLength(1);
  });
  it("admits only the exact consented Engineer stage while leaving correction disabled", () => {
    const f = fixture("trivial-change"), document = readWorkflowDocument(), task = readTask(f.taskId)!;
    expect(document.stages[f.stageId]!.kind).toBe("implementation");
    expect(document.grants[document.workflows[f.id]!.current_grant_id]!.correction.enabled).toBe(false);
    expect(f.controller.canClaim(task)).toBe(true); expect(task.orchestration?.attempts).toBe(0); expect(f.executor.run).not.toHaveBeenCalled();
  });
  it("plan approval admits only the exact Engineer successor with a sealed handoff", async () => {
    const f = fixture("implementation", output("plan")); await complete(f.taskId);
    const detail = f.controller.service.detail(f.id), decision = detail.decisions[0]!;
    f.controller.service.decide(f.id, { expected_revision: detail.workflow.revision, expected_issue_revision: decision.expected_issue_revision, decision_id: decision.id,
      resource_fingerprint: decision.resource_fingerprint, decision: "approve", approval_id: "synthetic-plan-human", rationale: "Exact bounded plan", confirm: true });
    f.controller.reconcile();
    const admitted = f.controller.service.detail(f.id);
    expect(admitted.workflow.status).toBe("running"); expect(admitted.stages.at(-1)).toMatchObject({ kind: "implementation", status: "queued", predecessor_stage_id: f.stageId });
    expect(admitted.handoffs).toHaveLength(1); expect(admitted.handoffs[0]!.from_role_id).toBe("planner");
    expect(listTasks()).toHaveLength(2); expect(readTask(admitted.stages.at(-1)!.task_id!)?.orchestration?.attempts).toBe(0); expect(f.executor.run).toHaveBeenCalledOnce();
  }, 15_000);
  it.each([null, { schema_version: 99 }, { ...output(), evidence_ids: ["unowned"] }, { ...output(), kind: "operations", proposed_issue: null }])("rejects malformed/unowned output without promoting raw fallback %#", async (value) => {
    const f = fixture("analysis", value); await complete(f.taskId); expect(readTask(f.taskId)?.outcome).toBe("needs-review");
    expect(f.controller.service.detail(f.id).workflow.status).toBe("needs-decision"); expect(JSON.stringify(readTask(f.taskId))).not.toContain("raw fallback");
  });
  it("missing final usage is unknown and cannot be recovered as zero or retried", async () => {
    const f = fixture("analysis", output(), false); await complete(f.taskId); const detail = f.controller.service.detail(f.id);
    expect(detail.workflow.counters.accounting_complete).toBe(false); expect(detail.workflow.status).toBe("needs-decision");
    expect(readTask(f.taskId)?.outcome).toBe("needs-review");
    expect(() => worker!.retry(f.taskId)).toThrow(/controller/); expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).toHaveBeenCalledOnce();
    expect(() => f.controller.service.recover(f.id, { expected_revision: detail.workflow.revision, expected_issue_revision: readIssueDocument().issues[issueId]!.revision })).toThrow(/provable/);
  });
  it("an interrupted provider cannot persist raw exceptions or trigger a generic automatic retry", async () => {
    const f = fixture(); vi.mocked(f.executor.run).mockRejectedValue(new Error("Synthetic private exception C:\\private\\auth.json"));
    await complete(f.taskId); const task = readTask(f.taskId)!;
    expect(task.outcome).toBe("needs-review"); expect(task.orchestration?.retry_at).toBeNull();
    expect(f.controller.service.detail(f.id).workflow.counters.accounting_complete).toBe(false);
    expect(JSON.stringify(task)).not.toContain("Synthetic private exception"); expect(readFileSync(join(root, task.logs_path!), "utf8")).not.toContain("Synthetic private exception");
    expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).toHaveBeenCalledOnce();
  });
  it("source drift during the turn retains usage but cannot capture output or create a human approval", async () => {
    const f = fixture(); vi.mocked(f.executor.run).mockImplementation(async () => {
      writeFileSync(join(root, "projects/alpha/AGENTS.md"), "Changed during the synthetic turn");
      return { finalText: "", structuredOutput: output(), threadId: "synthetic-thread", turnId: "synthetic-turn", usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 3 } };
    });
    await complete(f.taskId); const detail = f.controller.service.detail(f.id);
    expect(readTask(f.taskId)?.outcome).toBe("needs-review"); expect(detail.stages[0]!.output).toBeNull(); expect(detail.decisions).toEqual([]);
    expect(detail.workflow.counters).toMatchObject({ total_tokens: 3, accounting_complete: true }); expect(detail.workflow.status).toBe("needs-decision");
  });
  it("source drift and an uncommitted intent never reach the model", async () => {
    const f = fixture(); writeFileSync(join(root, "projects/alpha/AGENTS.md"), "Changed rules require new authority");
    expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).not.toHaveBeenCalled(); expect(readTask(f.taskId)?.orchestration?.attempts).toBe(0);
    expect(f.controller.service.detail(f.id).workflow.status).toBe("needs-decision");
  });
  it("caller-shaped proof cannot turn a standalone task lease into controller authority", async () => {
    const f = fixture(); expect(workflowExecutionOwner({}, f.taskId, "forged")).toBeNull();
    await runTask(f.taskId, root, f.executor, { workflowExecution: {} }); expect(f.executor.run).not.toHaveBeenCalled(); expect(readTask(f.taskId)?.outcome).toBe("needs-review");
    expect(readWorkflowDocument().accounting).toEqual({});
  });
  it("durable stop precedes queued cancellation and survives a new controller", async () => {
    const f = fixture(), detail = f.controller.service.detail(f.id), issueBefore = readIssueDocument();
    f.controller.service.cancel(f.id, { expected_revision: detail.workflow.revision, expected_issue_revision: readIssueDocument().issues[issueId]!.revision });
    expect(readTask(f.taskId)?.outcome).toBe("cancelled"); expect(f.controller.service.detail(f.id).workflow.stop_requested_at).not.toBeNull();
    new WorkflowOrchestrator(root).reconcile(); expect(f.controller.service.detail(f.id).workflow.status).toBe("cancelled");
    expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).not.toHaveBeenCalled(); expect(readIssueDocument()).toEqual(issueBefore);
  });
  it("durable stop precedes an in-flight abort and retains interrupted accounting on restart", async () => {
    const f = fixture(), issueBytes = readFileSync(join(state, "issues/issues.json"));
    let abortSawDurableStop = false;
    vi.mocked(f.executor.run).mockImplementation(async (_input, _events, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => {
        abortSawDurableStop = !!f.controller.service.detail(f.id).workflow.stop_requested_at;
        const error = new Error("synthetic interrupted provider"); error.name = "AbortError"; reject(error);
      }, { once: true });
    }));
    expect(await worker!.runOnce()).toBe(1); await vi.waitFor(() => expect(f.executor.run).toHaveBeenCalledOnce());
    const detail = f.controller.service.detail(f.id);
    f.controller.service.cancel(f.id, { expected_revision: detail.workflow.revision, expected_issue_revision: readIssueDocument().issues[issueId]!.revision });
    await vi.waitFor(() => expect(readTask(f.taskId)?.lifecycle).toBe("finished"));
    new WorkflowOrchestrator(root).reconcile();
    const stopped = f.controller.service.detail(f.id);
    expect(abortSawDurableStop).toBe(true); expect(stopped.workflow.status).toBe("cancelled"); expect(stopped.stages[0]!.status).toBe("cancelled");
    expect(stopped.workflow.counters).toMatchObject({ tasks: 1, attempts: 1, accounting_complete: false }); expect(stopped.accounting[0]!.usage_complete).toBe(false);
    expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).toHaveBeenCalledOnce(); expect(readFileSync(join(state, "issues/issues.json"))).toEqual(issueBytes);
  });
  it("deduplicates per-run observations, keeps maxima and never rewrites final usage", () => {
    const f = fixture(), { proof, runId } = claim(f);
    f.controller.observe(proof, 3, 100); f.controller.observe(proof, 3, 100); f.controller.observe(proof, 1, 90);
    expect(f.controller.service.detail(f.id).workflow.counters).toMatchObject({ tasks: 1, attempts: 1, total_tokens: 3, runtime_ms: 100 });
    f.controller.settle(proof, 3, 150, true);
    const bytes = readFileSync(join(state, "workflows/workflows.json")); f.controller.observe(proof, 10, 500, true);
    expect(readFileSync(join(state, "workflows/workflows.json"))).toEqual(bytes); expect(readWorkflowDocument().accounting[runId]!.usage_complete).toBe(true);
    expect(() => f.controller.claimRun(f.taskId, runId)).toThrow(/already charged/);
    expect(Object.keys(readWorkflowDocument().accounting)).toEqual([runId]);
  });
  it.each(["tokens", "runtime"] as const)("retains aggregate %s exhaustion without admitting another attempt or successor", (kind) => {
    const f = fixture("analysis", output(), true, { max_tasks: 1, max_attempts: 1, max_runtime_ms: 1000, max_total_tokens: 10 }), { proof } = claim(f);
    expect(f.controller.observe(proof, kind === "tokens" ? 10 : 3, kind === "runtime" ? 1000 : 100)).toBe(true);
    const detail = f.controller.service.detail(f.id); expect(detail.workflow.status).toBe("needs-decision"); expect(detail.workflow.blocked_reason).toContain("budget");
    expect(detail.workflow.counters.attempts).toBe(1); expect(f.controller.canClaim(readTask(f.taskId)!)).toBe(false); expect(f.executor.run).not.toHaveBeenCalled();
  });
  it("actual usage events and final usage charge the same run once", async () => {
    const f = fixture();
    vi.mocked(f.executor.run).mockImplementation(async (_input, events) => {
      const usage = { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 3 };
      const event = { type: "usage" as const, at: new Date().toISOString(), threadId: "synthetic-thread", turnId: "synthetic-turn", usage };
      await events(event); await events(event);
      return { finalText: "", structuredOutput: output(), threadId: "synthetic-thread", turnId: "synthetic-turn", usage };
    });
    await complete(f.taskId); expect(f.controller.service.detail(f.id).workflow.counters.total_tokens).toBe(3); expect(readTask(f.taskId)?.orchestration?.cumulative_tokens).toBe(3);
  });
  it("an actual turn reaching its root token cap cannot publish a completed proposal or successor", async () => {
    const f = fixture("analysis", output(), true, { max_tasks: 1, max_attempts: 1, max_runtime_ms: 60000, max_total_tokens: 3 }); await complete(f.taskId);
    const detail = f.controller.service.detail(f.id);
    expect(detail.workflow.status).toBe("needs-decision"); expect(detail.workflow.counters).toMatchObject({ tasks: 1, attempts: 1, total_tokens: 3, accounting_complete: true });
    expect(detail.stages[0]!.output).toBeNull(); expect(detail.decisions).toEqual([]); expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).toHaveBeenCalledOnce();
  });
  it("reconstructs completed owned facts after a lost terminal callback exactly once", async () => {
    const f = fixture(), callback = vi.spyOn(f.controller, "reconcile").mockImplementation(() => {}); await complete(f.taskId);
    expect(f.controller.service.detail(f.id).workflow.status).toBe("running"); callback.mockRestore();
    const restarted = new WorkflowOrchestrator(root); restarted.reconcile();
    const bytes = readFileSync(join(state, "workflows/workflows.json")); restarted.reconcile();
    expect(restarted.service.detail(f.id).workflow.status).toBe("waiting-human"); expect(restarted.service.detail(f.id).decisions).toHaveLength(1);
    expect(readFileSync(join(state, "workflows/workflows.json"))).toEqual(bytes); expect(listTasks()).toHaveLength(1); expect(f.executor.run).toHaveBeenCalledOnce();
  });
  it("two workers share existing scheduler capacity and cannot charge or execute one stage twice", async () => {
    const f = fixture(), other = new TaskOrchestrator({ repoRoot: root, workflows: new WorkflowOrchestrator(root), executor: f.executor, maxConcurrent: 1 });
    let resolveRun!: (value: Awaited<ReturnType<AgentExecutor["run"]>>) => void;
    vi.mocked(f.executor.run).mockImplementation(async () => new Promise((resolve) => { resolveRun = resolve; }));
    try {
      expect(await worker!.runOnce()).toBe(1); await vi.waitFor(() => expect(f.executor.run).toHaveBeenCalledOnce());
      expect(await other.runOnce()).toBe(0); expect(f.controller.service.detail(f.id).accounting).toHaveLength(1);
      resolveRun({ finalText: "", structuredOutput: output(), threadId: "synthetic-thread", turnId: "synthetic-turn", usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 3 } });
      await vi.waitFor(() => expect(readTask(f.taskId)?.lifecycle).toBe("finished")); expect(await other.runOnce()).toBe(0);
      expect(f.controller.service.detail(f.id).workflow.counters.attempts).toBe(1); expect(f.executor.run).toHaveBeenCalledOnce();
    } finally { await other.stop(); }
  });
  it("stale proof cannot observe usage or publish role output after lease replacement", () => {
    const f = fixture(), { proof } = claim(f), prepared = f.controller.prepare(proof);
    updateTask(f.taskId, (task) => { task.orchestration!.lease!.run_id = "synthetic-replacement"; });
    const bytes = readFileSync(join(state, "workflows/workflows.json"));
    expect(() => f.controller.observe(proof, 3, 100)).toThrow(/lease/); expect(() => f.controller.captureOutput(proof, prepared, output(), "reports/synthetic")).toThrow(/lease/);
    expect(readFileSync(join(state, "workflows/workflows.json"))).toEqual(bytes); expect(f.executor.run).not.toHaveBeenCalled();
  });
  it("explicit recovery commits only an existing unstarted task/link gap without redispatch or refund", () => {
    const notify = vi.fn(), makeTask = vi.fn((...args: Parameters<typeof createWorkflowTask>) => { createWorkflowTask(...args); throw new Error("synthetic crash after task persistence"); });
    const service = createWorkflowService(root, { createTask: makeTask, execution: { available: () => true, notify, cancelTask: vi.fn() } });
    const request = { template_id: "analysis", template_version: 1, project_id: "alpha", issue_id: issueId, expected_revision: readIssueDocument().issues[issueId]!.revision, selected_agents: { "portfolio-analyst": "product-manager" } };
    const preview = service.preview(request); expect(() => service.start({ request, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-root-human" })).toThrow(/incomplete/);
    const document = readWorkflowDocument(), owner = Object.values(document.workflows)[0]!, task = listTasks()[0]!, issueBefore = readIssueDocument();
    const recovered = service.recover(owner.id, { expected_revision: owner.revision, expected_issue_revision: issueBefore.issues[issueId]!.revision });
    expect(recovered.admission_intents[0]!.status).toBe("committed"); expect(recovered.stages[0]!.task_id).toBe(task.envelope.id); expect(recovered.workflow.counters).toEqual(owner.counters);
    expect(readTask(task.envelope.id)).toEqual(task); expect(readIssueDocument()).toEqual(issueBefore); expect(makeTask).toHaveBeenCalledOnce(); expect(notify).toHaveBeenCalledExactlyOnceWith(task.envelope.id);
    const bytes = readFileSync(join(state, "workflows/workflows.json")); expect(() => service.recover(owner.id, { expected_revision: recovered.workflow.revision, expected_issue_revision: issueBefore.issues[issueId]!.revision })).toThrow(/provable/);
    expect(readFileSync(join(state, "workflows/workflows.json"))).toEqual(bytes);
  });
  it("missing reserved task and source drift stay unrecoverable with retained bytes", () => {
    const service = createWorkflowService(root, { createTask: () => { throw new Error("synthetic crash before task persistence"); }, execution: { available: () => true, notify: vi.fn(), cancelTask: vi.fn() } });
    const request = { template_id: "analysis", template_version: 1, project_id: "alpha", issue_id: issueId, expected_revision: readIssueDocument().issues[issueId]!.revision, selected_agents: { "portfolio-analyst": "product-manager" } };
    const preview = service.preview(request); expect(() => service.start({ request, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-root-human" })).toThrow(/incomplete/);
    const owner = Object.values(readWorkflowDocument().workflows)[0]!, path = join(state, "workflows/workflows.json"), bytes = readFileSync(path);
    writeFileSync(join(root, "projects/alpha/AGENTS.md"), "Changed synthetic source");
    expect(() => service.recover(owner.id, { expected_revision: owner.revision, expected_issue_revision: readIssueDocument().issues[issueId]!.revision })).toThrow(/missing/);
    expect(readFileSync(path)).toEqual(bytes); expect(listTasks()).toEqual([]);
  });
  it("changed sources prevent recovery even when the reserved task and link survived", () => {
    const notify = vi.fn(), service = createWorkflowService(root, { createTask: (...args) => { createWorkflowTask(...args); throw new Error("synthetic task-persistence gap"); }, execution: { available: () => true, notify, cancelTask: vi.fn() } });
    const request = { template_id: "analysis", template_version: 1, project_id: "alpha", issue_id: issueId, expected_revision: readIssueDocument().issues[issueId]!.revision, selected_agents: { "portfolio-analyst": "product-manager" } };
    const preview = service.preview(request); expect(() => service.start({ request, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-root-human" })).toThrow(/incomplete/);
    writeFileSync(join(root, "projects/alpha/AGENTS.md"), "Changed after the persisted reservation");
    const owner = Object.values(readWorkflowDocument().workflows)[0]!, bytes = readFileSync(join(state, "workflows/workflows.json")), task = listTasks()[0]!;
    expect(() => service.recover(owner.id, { expected_revision: owner.revision, expected_issue_revision: readIssueDocument().issues[issueId]!.revision })).toThrow();
    expect(readFileSync(join(state, "workflows/workflows.json"))).toEqual(bytes); expect(readTask(task.envelope.id)).toEqual(task); expect(notify).not.toHaveBeenCalled();
  });
  it.each([false, true])("runs Reviewer on an exact real candidate, blocking seals/QA or tree drift mutate=%s", async (mutate) => {
    const repo = join(root, "projects/alpha"), git = (...args: string[]) => execFileSync("git", managedGitArgs(["-C", repo, ...args], root), { env: localGitEnvironment(), windowsHide: true, stdio: "pipe" }).toString();
    git("init", "-b", "main"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Synthetic fixture");
    mkdirSync(join(repo, "src")); writeFileSync(join(repo, "src/value.txt"), "base\n"); writeFileSync(join(repo, "verify.mjs"), "process.exit(0)\n"); git("add", "-A"); git("commit", "-m", "synthetic base");
    const context = createContextService(root), issues = createIssueService(root, { context }), issue = issues.get(issueId).issue;
    const input = { kind: "issue" as const, project: "alpha", issue_id: issueId, expected_revision: issue.revision, role_id: "software-engineer", agent: "backend-engineer" }, preview = context.preview(input);
    const engineerTaskId = issues.dispatch(issueId, issue.revision, "backend-engineer", { role_id: "software-engineer", preview_fingerprint: preview.fingerprint }).taskId, runId = "synthetic-engineer-run", at = new Date().toISOString();
    updateTask(engineerTaskId, (task) => { task.lifecycle = "running"; task.orchestration!.attempts = 1; task.orchestration!.lease = { run_id: runId, worker_id: "fixture", acquired_at: at, heartbeat_at: at, expires_at: new Date(Date.now() + 60000).toISOString() }; });
    const tree = createWorktree(repo, engineerTaskId, "backend-engineer"); writeFileSync(join(tree.worktreePath, "src/value.txt"), "candidate\n"); const committed = commitAndDiff(tree.worktreePath, "synthetic candidate");
    const candidate = issues.recordCandidate({ issueId, taskId: engineerTaskId, executionId: runId, repositoryId: "alpha", scopeRevision: issue.scope_revision, baseRevision: committed.baseRevision!, candidateRevision: committed.candidateRevision!, changedPaths: committed.filesChanged });
    const plan = { mode: "functional" as const, runners: [{ stage: "functional" as const, command: "node verify.mjs" }] }, receipt = createTestingEvidence(readTask(engineerTaskId)!, runId, plan);
    receipt.candidate = { id: candidate.id, base_revision: candidate.base_revision, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint };
    receipt.implementation = { started_at: at, finished_at: at, thread_id: "synthetic-engineer-thread", turn_id: "synthetic-engineer-turn" };
    const captured = await captureVerification(tree.worktreePath, plan.runners, { controlPlaneRoot: root, expectedRevision: candidate.candidate_revision, signal: new AbortController().signal, deadline: Date.now() + 10000,
      ownsAttempt: () => readTask(engineerTaskId)?.orchestration?.lease?.run_id === runId, authorizeCommand: (command) => command === "node verify.mjs" });
    expect(captured.report.status).toBe("passed"); receipt.observations = captured.observations; const { fingerprint: _fingerprint, ...unsigned } = receipt; updateTask(engineerTaskId, (task) => { task.testing_evidence = sealTestingEvidence(unsigned); });
    issues.recordVerification({ issueId, taskId: engineerTaskId, executionId: runId, candidateId: candidate.id, status: "passed", label: "Real fixture verification", reference: "One passing captured command" });
    mkdirSync(join(root, "reports")); const diffPath = `reports/${engineerTaskId}-${runId}.diff`; writeFileSync(join(root, diffPath), committed.patch);
    updateTask(engineerTaskId, (task) => { task.lifecycle = "finished"; task.outcome = "completed"; task.finished_at = new Date().toISOString(); task.orchestration!.lease = null;
      task.envelope.metadata.run = { branch: tree.branch, worktree_path: tree.worktreePath, committed: true, diff_path: diffPath, diff_truncated: false }; });
    const controller = new WorkflowOrchestrator(root), executor: AgentExecutor = { run: vi.fn(async (input) => {
      expect(input.cwd).toBe(tree.worktreePath); expect(input.mode).toBe("read-only"); expect(input.verifyCommands).toEqual([]); expect(input.threadId).toBeUndefined();
      if (mutate) writeFileSync(join(tree.worktreePath, "src/value.txt"), "Mutated during read-only review\n");
      const { recommendations: _recommendations, ...base } = output() as Extract<WorkflowRoleOutput, { kind: "analysis" }>;
      return { finalText: "", structuredOutput: { ...base, kind: "review", verdict: "approve", findings: [] }, threadId: "synthetic-review-thread", turnId: "synthetic-review-turn", usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 3 } };
    }) };
    worker = new TaskOrchestrator({ repoRoot: root, workflows: controller, executor });
    const request = { template_id: "quality-review", template_version: 1, project_id: "alpha", issue_id: issueId, expected_revision: issues.get(issueId).issue.revision, selected_agents: { reviewer: roles.reviewer, "qa-evaluator": roles["qa-evaluator"] }, candidate_id: candidate.id }, proposed = controller.service.preview(request);
    expect(proposed.allowed).toBe(true); const started = controller.service.start({ request, preview_fingerprint: proposed.fingerprint, confirm: true, approval_id: "synthetic-quality-human" });
    const issueBefore = readIssueDocument(); await complete(started.stages[0]!.task_id!); const detail = controller.service.detail(started.workflow.id);
    expect(detail.workflow.status).toBe(mutate ? "needs-decision" : "running"); expect(detail.stages[0]!.output?.kind ?? null).toBe(mutate ? null : "review");
    expect(detail.handoffs).toHaveLength(mutate ? 0 : 1); expect(detail.review_receipts).toHaveLength(mutate ? 0 : 1);
    expect(detail.workflow.counters).toMatchObject({ tasks: mutate ? 1 : 2, attempts: 1, total_tokens: 3, accounting_complete: true });
    if (mutate) expect(await worker.runOnce()).toBe(0); expect(executor.run).toHaveBeenCalledOnce();
    if (mutate) expect(readIssueDocument()).toEqual(issueBefore);
    else {
      const reviewTask = readTask(detail.stages.at(-1)!.task_id!)!;
      expect(detail.stages.at(-1)!.kind).toBe("qa"); expect(reviewTask.lifecycle).toBe("queued");
      expect(issues.get(issueId).issue.evidence_ids.map((id) => readIssueDocument().evidence[id]!.kind)).toContain("review");
    }
    expect(issues.get(issueId).issue.status).toBe("ready-for-review"); expect(git("rev-parse", "HEAD").trim()).toBe(candidate.base_revision); expect(existsSync(tree.worktreePath)).toBe(true);
  }, 20000);
  it("expired/replaced lease retains unknown usage and never replays the role", async () => {
    const f = fixture(); let now = new Date(); const leaseId = "synthetic-lost-run";
    updateTask(f.taskId, (task) => { task.lifecycle = "running"; task.orchestration!.attempts = 1; task.orchestration!.lease = { run_id: leaseId, worker_id: worker!.workerId, acquired_at: now.toISOString(), heartbeat_at: now.toISOString(), expires_at: new Date(now.getTime() + 60000).toISOString() }; });
    f.controller.claimRun(f.taskId, leaseId); now = new Date(now.getTime() - 1000);
    updateTask(f.taskId, (task) => { task.orchestration!.lease!.expires_at = now.toISOString(); });
    expect(worker!.recoverExpiredLeases()).toBe(1); expect(readTask(f.taskId)?.outcome).toBe("needs-review");
    expect(f.controller.service.detail(f.id).workflow.counters.accounting_complete).toBe(false); expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).not.toHaveBeenCalled();
  });
  it("a stale recovery snapshot cannot terminalize or block the renewed owning lease", () => {
    const f = fixture(); claim(f);
    updateTask(f.taskId, (task) => { task.orchestration!.lease!.expires_at = new Date(Date.now() - 1000).toISOString(); }); const expired = readTask(f.taskId)!;
    updateTask(f.taskId, (task) => { task.orchestration!.lease!.expires_at = new Date(Date.now() + 60000).toISOString(); });
    const taskBytes = readFileSync(join(state, `tasks/${f.taskId}.json`)), workflowBytes = readFileSync(join(state, "workflows/workflows.json"));
    expect(f.controller.recoverExpired(expired)).toBe(false); expect(readFileSync(join(state, `tasks/${f.taskId}.json`))).toEqual(taskBytes); expect(readFileSync(join(state, "workflows/workflows.json"))).toEqual(workflowBytes);
  });
  it("corrupt workflow bytes fail closed without repair or effects", async () => {
    const f = fixture(), path = join(state, "workflows/workflows.json"), corrupt = '{"schema_version":99}'; writeFileSync(path, corrupt);
    await expect(worker!.runOnce()).rejects.toThrow(); expect(readFileSync(path, "utf8")).toBe(corrupt); expect(f.executor.run).not.toHaveBeenCalled();
  });
});

async function correctionFixture(options: { enabled?: boolean; findingPath?: string; repeatFinding?: boolean; protectedEdit?: boolean; failedVerification?: boolean; correctionTokenCap?: number; qaFinding?: boolean } = {}) {
  const repo = join(root, "projects/alpha"), git = (...args: string[]) => execFileSync("git", managedGitArgs(["-C", repo, ...args], root), { env: localGitEnvironment(), windowsHide: true, stdio: "pipe" }).toString().trim();
  git("init", "-b", "main"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Synthetic fixture");
  mkdirSync(join(repo, "src")); writeFileSync(join(repo, "src/value.txt"), "base\n");
  writeFileSync(join(repo, "verify.mjs"), "import {readFileSync} from 'node:fs'; process.exit(readFileSync('src/value.txt','utf8').includes('broken') ? 1 : 0)\n");
  git("add", "-A"); git("commit", "-m", "synthetic correction base");
  if (options.correctionTokenCap) {
    const path = join(root, "registry/workflow-policy.yml"), policy = parse(readFileSync(path, "utf8"));
    policy.correction_budget.max_total_tokens = options.correctionTokenCap; writeFileSync(path, JSON.stringify(policy));
  }
  const issues = createIssueService(root), proposed = issues.create({ project_id: "alpha", title: "Synthetic correction workflow", expected_outcome: "Observable synthetic result",
    acceptance_criteria: ["Observable acceptance", "Retain the exact authorized scope"], assigned_role_id: "backend-engineer", plan: ["Change only authorized paths"], next_action: "Review the exact candidate", criticality: "high", classification_inputs: { requires_migration: true },
    authorized_scope: { expected_outcome: "Observable synthetic result", acceptance_criteria: ["Observable acceptance", "Retain the exact authorized scope"], allowed_path_patterns: ["**"], excluded_path_patterns: ["outside/**"], allowed_change_categories: ["implementation", "migration"], explicit_exclusions: [] } });
  issueId = proposed.id; issues.authorize(issueId, proposed.revision, "synthetic-correction-scope-human");
  let workflowId = "";
  const controller = new WorkflowOrchestrator(root), executor: AgentExecutor = { run: vi.fn(async (input) => {
    const document = readWorkflowDocument(), owner = document.workflows[workflowId]!, stage = document.stages[owner.current_stage_id!]!;
    const base = { schema_version: 1 as const, status: "completed" as const, summary: `Synthetic ${stage.kind}`, evidence_ids: [] as string[], unresolved_questions: [], risks: [], recommended_next_action: "Inspect the exact next gate", requested_decision: null };
    let structuredOutput: unknown;
    expect(input.threadId).toBeUndefined();
    if (stage.kind === "planning") structuredOutput = { ...base, kind: "plan", plan: ["Change the bounded value"], scope_change_required: false };
    else if (stage.kind === "implementation" || stage.kind === "correction") {
      if (stage.kind === "correction") {
        expect(readFileSync(join(input.cwd, "src/value.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("candidate\n");
        expect(existsSync(join(input.cwd, "source-only.txt"))).toBe(false);
        expect(owner.candidate).toEqual(stage.candidate); expect(document.lineages[owner.lineage_id!]!.corrections_consumed).toBe(1);
        const issueBytes = readFileSync(join(state, "issues/issues.json"));
        expect(() => issues.recordCandidate({ issueId, taskId: stage.task_id!, executionId: stage.execution_id!, repositoryId: "alpha", scopeRevision: 1,
          baseRevision: "f".repeat(40), candidateRevision: "e".repeat(40), changedPaths: ["src/value.txt"] })).toThrow(/exact prior candidate/);
        expect(readFileSync(join(state, "issues/issues.json"))).toEqual(issueBytes);
      }
      writeFileSync(join(input.cwd, "src/value.txt"), stage.kind === "implementation" ? "candidate\n" : options.failedVerification ? "broken\n" : "corrected\n");
      if (stage.kind === "correction" && options.protectedEdit) { mkdirSync(join(input.cwd, "schemas")); writeFileSync(join(input.cwd, "schemas/changed.json"), "{}\n"); }
      structuredOutput = { status: "completed", summary: "Synthetic bounded writer", commands_run: [], tests_run: [], risks: [], blockers: [], next_steps: [], artifacts: [] };
    } else {
      const facts = readIssueDocument(), evidence = facts.issues[issueId]!.evidence_ids.map((id) => facts.evidence[id]!)
        .find((entry) => entry.kind === "verification" && entry.status === "passed" && entry.candidate_id === owner.candidate!.candidate_id)!;
      expect(evidence).toBeDefined(); expect(input.mode).toBe("read-only"); expect(input.verifyCommands).toEqual([]);
      const correct = (stage.kind === "review" && !options.qaFinding || stage.kind === "qa" && options.qaFinding) && (stage.ordinal <= 4 || options.repeatFinding);
      const findings = correct ? [{ id: `finding-${stage.ordinal}`, severity: "blocking", summary: "Correct the exact bounded behavior", path: options.findingPath ?? "src/value.txt", evidence_ids: [evidence.id], scope_change_required: false }] : [];
      structuredOutput = { ...base, kind: stage.kind, evidence_ids: [evidence.id], verdict: correct ? "correction-required" : "approve", findings,
        ...(stage.kind === "qa" ? { criteria: facts.issues[issueId]!.acceptance_criteria.map((criterion) => ({ criterion, status: correct ? "contradictory" : "supported", evidence_ids: [evidence.id] })) } : {}) };
    }
    return { finalText: "Never promote raw fallback", structuredOutput, threadId: `synthetic-${stage.id}`, turnId: `synthetic-${stage.id}-turn`,
      usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 3 } };
  }) };
  worker = new TaskOrchestrator({ repoRoot: root, workflows: controller, executor, maxConcurrent: 1 });
  const request = { template_id: "implementation", template_version: 1, project_id: "alpha", issue_id: issueId, expected_revision: readIssueDocument().issues[issueId]!.revision,
    selected_agents: { planner: "tech-lead", "software-engineer": "backend-engineer", reviewer: "reality-checker", "qa-evaluator": "qa-reviewer" }, correction_enabled: options.enabled ?? true };
  const preview = controller.service.preview(request); expect(preview.allowed, preview.blocked_reasons.join("; ")).toBe(true);
  const started = controller.service.start({ request, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-correction-human" }); workflowId = started.workflow.id;
  const detail = () => controller.service.detail(workflowId);
  const advance = async (kind: string) => {
    const stage = detail().stages.at(-1)!; expect(stage.kind).toBe(kind); expect(stage.status).toBe("queued");
    expect(await worker!.runOnce()).toBe(1);
    await vi.waitFor(() => expect(readTask(stage.task_id!)?.lifecycle).toBe("finished"), { timeout: 15000 }); controller.reconcile(); return detail();
  };
  await advance("planning");
  const plan = detail().decisions[0]!;
  controller.service.decide(workflowId, { expected_revision: detail().workflow.revision, expected_issue_revision: plan.expected_issue_revision, decision_id: plan.id,
    resource_fingerprint: plan.resource_fingerprint, decision: "approve", approval_id: "synthetic-plan-human", rationale: "Exact unchanged bounded plan", confirm: true }); controller.reconcile();
  await advance("implementation"); expect(detail().workflow.status, detail().workflow.blocked_reason ?? "").toBe("running");
  const original = detail().workflow.candidate!;
  await advance("review"); expect(detail().stages.at(-1)!.kind).toBe("qa"); expect(detail().lineage!.corrections_consumed).toBe(0);
  return { controller, executor, workflowId, original, detail, advance, git, repo };
}

describe("T010 one bounded correction under existing authority", () => {
  it.each([false, true])("consumes once before queueing, uses the prior candidate and requires fresh verification and both reviews QA-request=%s", async (qaFinding) => {
    const f = await correctionFixture({ qaFinding }); await f.advance("qa");
    const reserved = f.detail(), stage = reserved.stages.at(-1)!;
    expect(reserved.workflow.status, reserved.workflow.blocked_reason ?? "").toBe("running"); expect(stage.kind).toBe("correction");
    expect(reserved.lineage).toMatchObject({ corrections_consumed: 1, consumed_stage_id: stage.id });
    expect(readIssueDocument().issues[issueId]!.status).toBe("working"); expect(readIssueDocument().candidates[f.original.candidate_id]!.invalidated_at).toBeNull();
    const bytes = readFileSync(join(state, "workflows/workflows.json")); f.controller.reconcile(); new WorkflowOrchestrator(root).reconcile();
    expect(readFileSync(join(state, "workflows/workflows.json"))).toEqual(bytes); expect(listTasks()).toHaveLength(5);
    writeFileSync(join(f.repo, "source-only.txt"), "unrelated HEAD\n"); f.git("add", "-A"); f.git("commit", "-m", "synthetic source HEAD drift");
    await f.advance("correction"); expect(f.detail().workflow.status, f.detail().workflow.blocked_reason ?? "").toBe("running"); const corrected = f.detail().workflow.candidate!;
    expect(corrected.base_revision).toBe(f.original.candidate_revision); expect(corrected.task_id).not.toBe(f.original.task_id);
    expect(corrected.candidate_id).not.toBe(f.original.candidate_id); expect(corrected.testing_evidence_fingerprint).not.toBe(f.original.testing_evidence_fingerprint);
    expect(readIssueDocument().candidates[f.original.candidate_id]!.invalidated_at).not.toBeNull();
    expect(f.detail().lineage!.candidate_ids).toEqual([f.original.candidate_id, corrected.candidate_id]);
    expect(f.detail().review_receipts.every((receipt) => receipt.candidate.candidate_id === f.original.candidate_id)).toBe(true);
    await f.advance("review"); await f.advance("qa");
    const reviewed = f.detail(); expect(reviewed.workflow.status, reviewed.workflow.blocked_reason ?? "").toBe("waiting-human");
    expect(reviewed.review_receipts.filter((receipt) => receipt.candidate.candidate_id === corrected.candidate_id).map((receipt) => receipt.role_id)).toEqual(["reviewer", "qa-evaluator"]);
    expect(readIssueDocument().issues[issueId]!.status).toBe("ready-for-review"); expect(reviewed.decisions.at(-1)!.kind).toBe("candidate-acceptance");
    expect(reviewed.workflow.counters).toMatchObject({ tasks: 7, attempts: 7, total_tokens: 21, accounting_complete: true });
    expect(f.executor.run).toHaveBeenCalledTimes(7); expect(listTasks()).toHaveLength(7);
    const finalBytes = readFileSync(join(state, "workflows/workflows.json")); new WorkflowOrchestrator(root).reconcile();
    expect(readFileSync(join(state, "workflows/workflows.json"))).toEqual(finalBytes); expect(await worker!.runOnce()).toBe(0);
    const decision = reviewed.decisions.at(-1)!;
    f.controller.service.decide(f.workflowId, { expected_revision: reviewed.workflow.revision, expected_issue_revision: decision.expected_issue_revision, decision_id: decision.id,
      resource_fingerprint: decision.resource_fingerprint, decision: "approve", approval_id: "synthetic-final-human", rationale: "All exact current criteria reviewed", confirmed_criteria: ["Observable acceptance", "Retain the exact authorized scope"], confirm: true });
    expect(f.detail().workflow.status).toBe("completed"); expect(f.detail().lineage!.corrections_consumed).toBe(1);
  }, 90000);

  it.each([{ enabled: false }, { findingPath: "schemas/authority.json" }, { findingPath: "outside/value.txt" }])("denies unavailable correction authority without a new task %#", async (options) => {
    const f = await correctionFixture(options); await f.advance("qa");
    expect(f.detail().workflow.status).toBe("needs-decision"); expect(f.detail().lineage!.corrections_consumed).toBe(0);
    expect(f.detail().workflow.candidate).toEqual(f.original); expect(readIssueDocument().issues[issueId]!.status).toBe("checking");
    expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).toHaveBeenCalledTimes(4); expect(listTasks()).toHaveLength(4);
  }, 90000);

  it.each([{ protectedEdit: true }, { failedVerification: true }, { repeatFinding: true }, { correctionTokenCap: 3 }])("retains consumption and stops after unsuccessful correction %#", async (options) => {
    const f = await correctionFixture(options); await f.advance("qa"); await f.advance("correction");
    if (options.repeatFinding) await f.advance("review");
    const detail = f.detail(); expect(detail.workflow.status).toBe("needs-decision"); expect(detail.lineage!.corrections_consumed).toBe(1);
    if (options.correctionTokenCap) {
      expect(detail.workflow.counters.total_tokens).toBeLessThan(detail.workflow.budget.max_total_tokens);
      expect(detail.workflow.blocked_reason).toContain("budget");
      expect(detail.workflow.candidate).toEqual(f.original);
    }
    expect(detail.workflow.counters.tasks).toBe(options.repeatFinding ? 6 : 5); expect(await worker!.runOnce()).toBe(0);
    expect(() => worker!.retry(detail.stages.at(-1)!.task_id!)).toThrow(/controller/);
    const bytes = readFileSync(join(state, "workflows/workflows.json"));
    expect(() => mutateWorkflowDocument((document) => { document.lineages[detail.workflow.lineage_id!]!.corrections_consumed = 0; })).toThrow();
    expect(readFileSync(join(state, "workflows/workflows.json"))).toEqual(bytes); new WorkflowOrchestrator(root).reconcile();
    expect(f.detail().lineage!.corrections_consumed).toBe(1);
  }, 90000);

  it("retains consumption through partial admission, durable cancellation and reconstruction", async () => {
    const f = await correctionFixture();
    const notify = vi.fn(), makeTask = vi.fn(() => { throw new Error("synthetic failure before task persistence"); });
    const service = createWorkflowService(root, { createTask: makeTask, execution: { available: () => true, notify, cancelTask: vi.fn() } });
    vi.spyOn(f.controller.service, "admitCorrection").mockImplementation(service.admitCorrection);
    await f.advance("qa");
    const detail = f.detail(); expect(detail.workflow.status).toBe("needs-decision"); expect(detail.lineage!.corrections_consumed).toBe(1);
    expect(detail.stages.at(-1)!.status).toBe("reserved"); expect(listTasks()).toHaveLength(4); expect(makeTask).toHaveBeenCalledOnce(); expect(notify).not.toHaveBeenCalled();
    service.cancel(f.workflowId, { expected_revision: detail.workflow.revision, expected_issue_revision: readIssueDocument().issues[issueId]!.revision });
    new WorkflowOrchestrator(root).reconcile(); expect(f.detail().workflow.status).toBe("cancelled"); expect(f.detail().lineage!.corrections_consumed).toBe(1);
    expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).toHaveBeenCalledTimes(4);
  }, 90000);
});
