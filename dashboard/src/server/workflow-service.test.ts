import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { AgentRoleRegistry } from "../../../lib/context/types";
import { contextHash } from "../../../lib/context/assemble";
import { readIssueDocument, mutateIssueDocument } from "../../../lib/state/issues";
import { listTasks, readTask, updateTask } from "../../../lib/state/store";
import { readTaskEvents } from "../../../lib/state/events";
import { readWorkflowDocument, mutateWorkflowDocument } from "../../../lib/state/workflows";
import type { WorkflowRoleOutput } from "../../../lib/workflows/types";
import { assertWorkflowDocument } from "../../../lib/workflows/validation";
import { createIssueService } from "./issue-service";
import { createWorkflowContextService, type WorkflowPreviewRequest } from "./workflow-context-service";
import { createWorkflowService, type WorkflowServiceOptions } from "./workflow-service";
import { createTask, createWorkflowTask } from "./dispatch";
import { createContextService } from "./context-service";
import { createTestingEvidence, sealTestingEvidence } from "../../../lib/context/testing-evidence";
import { runTask } from "../../../runner/run-task";

let root: string, state: string, issueId: string;
const agents = { "portfolio-analyst": "product-manager", planner: "tech-lead", "software-engineer": "backend-engineer", reviewer: "reality-checker", "qa-evaluator": "qa-reviewer", "operations-observer": "devops-engineer" };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-workflow-service-")); state = join(root, "state");
  mkdirSync(join(root, "projects/alpha/.git"), { recursive: true }); mkdirSync(join(root, "registry"));
  for (const name of ["agents.yml", "agent-roles.yml", "context-policy.yml", "workflow-policy.yml"]) cpSync(`registry/${name}`, join(root, "registry", name));
  const roles = parse(readFileSync("registry/agent-roles.yml", "utf8")) as AgentRoleRegistry;
  for (const path of new Set(roles.roles.flatMap((role) => role.required_evaluation_ids))) { mkdirSync(join(root, ...path.split("/").slice(0, -1)), { recursive: true }); cpSync(path, join(root, path)); }
  writeFileSync(join(root, "registry/projects.yml"), `projects:\n  alpha:\n    allowed_agents: [${Object.values(agents).join(", ")}]\n    sandbox: { default: workspace-write }\n    verify: ['node verify.mjs']\n`);
  writeFileSync(join(root, "projects/alpha/AGENTS.md"), "Synthetic private source body; never permission.");
  vi.stubEnv("SURTEC_STATE_DIR", state); vi.stubEnv("SURTEC_PROJECTS_ROOT", join(root, "projects"));
  const issues = createIssueService(root, { projectIds: () => ["alpha"] });
  const proposed = issues.create({ project_id: "alpha", title: "Synthetic scoped change", expected_outcome: "Synthetic observable outcome", acceptance_criteria: ["Observable acceptance"], assigned_role_id: "backend-engineer", plan: ["Existing issue plan stays unchanged"], authorized_scope: { expected_outcome: "Synthetic observable outcome", acceptance_criteria: ["Observable acceptance"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["implementation"], explicit_exclusions: [] } });
  issueId = proposed.id; issues.authorize(issueId, proposed.revision, "synthetic-scope-approval");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
function request(template: WorkflowPreviewRequest["template_id"] = "analysis"): WorkflowPreviewRequest {
  const roles = template === "analysis" ? ["portfolio-analyst"] : template === "operations-investigation" ? ["operations-observer"] : template === "implementation" ? ["planner", "software-engineer", "reviewer"] : ["software-engineer", "reviewer"];
  return { template_id: template, template_version: 1, project_id: "alpha", issue_id: issueId, expected_revision: readIssueDocument().issues[issueId]!.revision,
    selected_agents: Object.fromEntries(roles.map((role) => [role, agents[role as keyof typeof agents]])), client_context_categories: {}, correction_enabled: false };
}
function start(options: WorkflowServiceOptions = {}, input = request()) {
  const service = createWorkflowService(root, options), preview = service.preview(input);
  expect(preview.allowed).toBe(true);
  return { service, input, preview, result: service.start({ request: input, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-root-approval" }) };
}
const workflowBytes = () => readFileSync(join(state, "workflows/workflows.json"), "utf8");
function verifiedLegacyCandidate() {
  const context = createContextService(root), issues = createIssueService(root, { context }), issue = readIssueDocument().issues[issueId]!;
  const preview = context.preview({ kind: "issue", project: "alpha", issue_id: issueId, expected_revision: issue.revision, role_id: "software-engineer", agent: "backend-engineer" });
  const { taskId } = issues.dispatch(issueId, issue.revision, "backend-engineer", { role_id: "software-engineer", preview_fingerprint: preview.fingerprint });
  const at = new Date().toISOString(), runId = "synthetic-legacy-run";
  updateTask(taskId, (task) => { task.lifecycle = "running"; task.started_at = at; task.orchestration!.attempts = 1; task.orchestration!.lease = { run_id: runId, worker_id: "synthetic-worker", acquired_at: at, heartbeat_at: at, expires_at: new Date(Date.now() + 60_000).toISOString() }; });
  const candidate = issues.recordCandidate({ issueId, taskId, executionId: runId, repositoryId: "alpha", scopeRevision: 1, baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40), changedPaths: ["src/fixture.ts"] });
  const receipt = createTestingEvidence(readTask(taskId)!, runId, { mode: "functional", runners: [{ stage: "functional", command: "node verify.mjs" }] });
  receipt.candidate = { id: candidate.id, base_revision: candidate.base_revision, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint };
  receipt.implementation = { started_at: at, finished_at: at, thread_id: "synthetic-thread", turn_id: "synthetic-turn" };
  receipt.observations = [{ stage: "functional", command_fingerprint: receipt.requirements[0]!.command_fingerprint, probe_fingerprint: null, assertions: [], outcome: "passed", exit_code: 0, started_at: at, finished_at: at, revision: candidate.candidate_revision, before_fingerprint: "c".repeat(64), after_fingerprint: "c".repeat(64) }];
  const { fingerprint: _fingerprint, ...unsigned } = receipt; updateTask(taskId, (task) => { task.testing_evidence = sealTestingEvidence(unsigned); });
  issues.recordVerification({ issueId, taskId, executionId: runId, candidateId: candidate.id, status: "passed", label: "Synthetic captured check", reference: "Synthetic receipt" });
  const path = `reports/${taskId}-${runId}.diff`; mkdirSync(join(root, "reports")); writeFileSync(join(root, path), "Synthetic complete candidate patch");
  updateTask(taskId, (task) => { task.lifecycle = "finished"; task.outcome = "completed"; task.finished_at = at; task.orchestration!.lease = null; task.envelope.metadata.run = { committed: true, diff_path: path, diff_truncated: false }; });
  return candidate;
}
function plannerGate() {
  const started = start({}, request("implementation")), stageId = started.result.workflow.current_stage_id!, taskId = started.result.stages[0]!.task_id!;
  const output: WorkflowRoleOutput = { schema_version: 1, kind: "plan", status: "completed", summary: "Exact synthetic proposal", plan: ["Implement only the authorized change"], scope_change_required: false, evidence_ids: [], unresolved_questions: [], risks: [], recommended_next_action: "Wait for human approval", requested_decision: "Approve the current plan" };
  updateTask(taskId, (task) => { task.lifecycle = "finished"; task.outcome = "completed"; task.finished_at = new Date().toISOString(); task.orchestration!.attempts = 1; });
  const at = new Date().toISOString(), runId = "synthetic-planner-run", decisionId = "synthetic-plan-decision";
  mutateWorkflowDocument((document) => {
    const workflow = document.workflows[started.result.workflow.id]!; workflow.revision++; workflow.updated_at = at;
    const stage = document.stages[stageId]!; stage.status = "running"; stage.execution_id = runId; stage.updated_at = at;
    workflow.counters = { tasks: 1, attempts: 1, runtime_ms: 100, total_tokens: 50, accounting_complete: true };
    document.accounting[runId] = { schema_version: 1, id: runId, workflow_id: workflow.id, stage_id: stage.id, task_id: taskId, execution_id: runId, attempt: 1, attempt_charged: true, active_runtime_ms: 100, observed_tokens: 50, usage_complete: true, captured_at: at };
  });
  mutateWorkflowDocument((document) => {
    const workflow = document.workflows[started.result.workflow.id]!; workflow.revision++; workflow.updated_at = at; workflow.status = "waiting-human"; workflow.pending_decision_id = decisionId;
    const stage = document.stages[stageId]!; stage.status = "completed"; stage.output = output; stage.output_fingerprint = contextHash(JSON.stringify(output)); stage.updated_at = at;
    document.decisions[decisionId] = { schema_version: 1, id: decisionId, workflow_id: workflow.id, kind: "plan-approval", status: "pending", expected_workflow_revision: workflow.revision,
      expected_issue_revision: readIssueDocument().issues[issueId]!.revision, resource_fingerprint: stage.output_fingerprint, candidate_id: null, review_receipt_ids: [], summary: "Approve this exact plan", approval_id: null, decided_by: null, rationale: null, created_at: at, decided_at: null };
  });
  const workflow = readWorkflowDocument().workflows[started.result.workflow.id]!, decision = readWorkflowDocument().decisions[decisionId]!;
  return { ...started, workflow, decision, stageId, taskId, payload: { expected_revision: workflow.revision, expected_issue_revision: decision.expected_issue_revision, decision_id: decision.id,
    resource_fingerprint: decision.resource_fingerprint, decision: "approve", approval_id: "synthetic-plan-approval", rationale: "Synthetic current exact plan approval", confirm: true } };
}

describe("durable explicit workflow admission", () => {
  it("denies opt-in correction at the root if the complete finite path cannot fit its budget", () => {
    const service = createWorkflowService(root), input = { ...request("implementation"), correction_enabled: true,
      budget: { max_tasks: 4, max_attempts: 10, max_runtime_ms: 900000, max_total_tokens: 100000 } };
    const preview = service.preview(input); expect(preview.allowed).toBe(false); expect(preview.blocked_reasons).toContain("Root budget cannot cover the finite selected sequence");
    expect(() => service.start({ request: input, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-human" })).toThrow();
    expect(listTasks()).toEqual([]); expect(existsSync(join(state, "workflows/workflows.json"))).toBe(false);
  });
  it("cannot infer correction authority from an unrelated queued root", () => {
    const { service, result } = start(), workflowBytes = readFileSync(join(state, "workflows/workflows.json")), issueBytes = readFileSync(join(state, "issues/issues.json"));
    expect(() => service.admitCorrection(result.workflow.id)).toThrow(/Correction review gate/);
    expect(readFileSync(join(state, "workflows/workflows.json"))).toEqual(workflowBytes); expect(readFileSync(join(state, "issues/issues.json"))).toEqual(issueBytes);
    expect(listTasks()).toHaveLength(1); expect(readTask(result.stages[0]!.task_id!)!.orchestration!.attempts).toBe(0);
  });
  it("notifies the shared worker only after the exact intent is committed", () => {
    const notify = vi.fn((taskId: string) => {
      const intent = Object.values(readWorkflowDocument().admission_intents).find((entry) => entry.task_id === taskId);
      expect(intent?.status).toBe("committed"); expect(readTask(taskId)?.lifecycle).toBe("queued"); expect(readTask(taskId)?.orchestration?.attempts).toBe(0);
    });
    const { result } = start({ execution: { available: () => true, notify, cancelTask: vi.fn() } });
    expect(notify).toHaveBeenCalledExactlyOnceWith(result.stages[0]!.task_id); expect(result.execution_enabled).toBe(true); expect(result.workflow.next_action).toContain("bounded stage");
  });
  it("rejects stale or injected stop/recovery without control effects, then retains stop before cancellation", () => {
    const cancelTask = vi.fn(() => { expect(Object.values(readWorkflowDocument().workflows)[0]!.stop_requested_at).not.toBeNull(); throw new Error("synthetic unavailable worker"); });
    const { service, result } = start({ execution: { available: () => true, notify: vi.fn(), cancelTask } }), issueBefore = readIssueDocument();
    const body = { expected_revision: result.workflow.revision, expected_issue_revision: issueBefore.issues[issueId]!.revision }, before = workflowBytes();
    for (const action of ["cancel", "recover"] as const) for (const input of [{ ...body, expected_revision: 1 }, { ...body, expected_issue_revision: body.expected_issue_revision - 1 }, { ...body, scope: {} }, Object.create(body)]) expect(() => service[action](result.workflow.id, input)).toThrow();
    expect(workflowBytes()).toBe(before); expect(cancelTask).not.toHaveBeenCalled();
    const stopped = service.cancel(result.workflow.id, body); expect(stopped.workflow.stop_requested_at).not.toBeNull(); expect(stopped.workflow.status).toBe("needs-decision");
    expect(cancelTask).toHaveBeenCalledOnce(); expect(readIssueDocument()).toEqual(issueBefore); expect(listTasks()).toHaveLength(1);
  });
  it("preview and absent list do not create workflow state or tasks", () => {
    const service = createWorkflowService(root); expect(service.list()).toEqual([]); expect(service.preview(request()).allowed).toBe(true);
    expect(existsSync(join(state, "workflows"))).toBe(false); expect(listTasks()).toEqual([]);
  });
  it.each(["analysis", "implementation", "trivial-change", "operations-investigation"] as const)("reserves and commits the exact first %s stage without execution", (template) => {
    const initial = readIssueDocument().issues[issueId]!, { result } = start({}, request(template)), stage = result.stages[0]!, intent = result.admission_intents[0]!, task = readTask(stage.task_id!)!;
    expect(result.execution_enabled).toBe(false); expect(result.workflow.revision).toBe(2); expect(result.workflow.counters.tasks).toBe(1);
    expect(stage.status).toBe("queued"); expect(intent).toMatchObject({ status: "committed", task_id: task.envelope.id, expected_issue_revision: initial.revision + 1, expected_workflow_revision: 1 });
    expect(task.envelope.context_admission).toMatchObject({ schema_version: 2, workflow_id: result.workflow.id, stage_id: stage.id, issue_revision: initial.revision + 1 });
    expect(task.envelope.metadata).not.toHaveProperty("issue_id"); expect(task.envelope.instructions).not.toContain("Synthetic private source body");
    expect(createWorkflowContextService(root).revalidateTask(task).binding).toEqual(task.envelope.context_admission);
    const linked = readIssueDocument().issues[issueId]!; expect(linked.task_ids).toEqual([task.envelope.id]); expect(linked.plan).toEqual(initial.plan); expect(linked.authorized_scope).toEqual(initial.authorized_scope);
    expect(linked.status).toBe(template === "trivial-change" ? "working" : "authorized");
    expect(task.orchestration!.attempts).toBe(0); expect(existsSync(join(root, "projects/surtec-worktrees"))).toBe(false);
    expect(createIssueService(root).get(issueId).tasks[0]!.task.envelope.id).toBe(task.envelope.id);
    if (template === "implementation") expect(result.stages.map((entry) => entry.kind)).toEqual(["planning"]);
  });
  it("retains a separate Planner analysis role without inventing plan authority", () => {
    const input = { ...request(), analysis_role: "planner" as const, selected_agents: { planner: "tech-lead" } };
    const { result } = start({}, input); expect(result.stages[0]).toMatchObject({ kind: "analysis", role_id: "planner", sandbox: "read-only" }); expect(result.workflow.approved_plan).toBeNull();
  });
  it("does not authorize a proposed issue through an advisory workflow", () => {
    mutateIssueDocument((document) => { document.issues[issueId]!.status = "proposed"; document.issues[issueId]!.revision++; });
    start(); expect(readIssueDocument().issues[issueId]!.status).toBe("proposed");
  });
  it("quality-review reserves read-only review over the exact verified candidate without a backward issue edge", () => {
    const candidate = verifiedLegacyCandidate(), initial = readIssueDocument().issues[issueId]!;
    const input = { ...request("quality-review"), selected_agents: { reviewer: "reality-checker", "qa-evaluator": "qa-reviewer" }, candidate_id: candidate.id };
    const { result } = start({}, input);
    expect(result.stages[0]).toMatchObject({ kind: "review", sandbox: "read-only", candidate: { candidate_id: candidate.id } });
    expect(result.grant.role_assignments.map((entry) => entry.role_id)).toEqual(["reviewer", "qa-evaluator"]); expect(result.workflow.review_policy!.qa_required).toBe(true);
    expect(readIssueDocument().issues[issueId]!.status).toBe("ready-for-review"); expect(readIssueDocument().issues[issueId]!.revision).toBe(initial.revision + 1);
    expect(result.workflow.candidate!.testing_evidence_fingerprint).toBe(readTask(candidate.task_id)!.testing_evidence!.fingerprint); expect(listTasks()).toHaveLength(2);
    expect(createWorkflowContextService(root).revalidateTask(readTask(result.stages[0]!.task_id!)!).binding.candidate).toEqual(result.workflow.candidate);
  });
  it("opt-in correction retains one unconsumed lineage allowance and tightened root budget", () => {
    const input = { ...request("trivial-change"), correction_enabled: true, budget: { max_tasks: 4, max_attempts: 4, max_runtime_ms: 400_000, max_total_tokens: 50_000 } };
    const { result } = start({}, input); expect(result.grant.correction.max_corrections).toBe(1); expect(result.lineage).toMatchObject({ corrections_consumed: 0, correction_limit: 1, origin_task_id: result.stages[0]!.task_id });
    expect(result.workflow.budget).toEqual(input.budget); expect(result.stages).toHaveLength(1); expect(listTasks()).toHaveLength(1);
  });
  it("per-role client consent persists only bounded audit and hashes, never a private body", () => {
    const contextDependencies = { buildClientContext: () => ({ instructions: "Synthetic confidential client body", audit: { client_id: "synthetic-client", categories: ["confidential-notes" as const], shared_at: new Date().toISOString() } }) };
    const input = { ...request(), client_context_categories: { "portfolio-analyst": ["confidential-notes"] } };
    const { result } = start({ contextDependencies }, input), task = readTask(result.stages[0]!.task_id!)!;
    expect(result.grant.role_assignments[0]!.client_context_categories).toEqual(["confidential-notes"]); expect(task.envelope.metadata.client_context_share).toMatchObject({ client_id: "synthetic-client", categories: ["confidential-notes"] });
    expect(workflowBytes()).not.toContain("Synthetic confidential client body"); expect(JSON.stringify(task)).not.toContain("Synthetic confidential client body");
    expect(createWorkflowContextService(root, contextDependencies).revalidateTask(task).binding).toEqual(task.envelope.context_admission);
  });
  it("generic manual issue dispatch is blocked while owned even without an active task", () => {
    const { result } = start(); updateTask(result.stages[0]!.task_id!, (task) => { task.lifecycle = "finished"; task.outcome = "needs-review"; task.finished_at = new Date().toISOString(); });
    const issue = readIssueDocument().issues[issueId]!, before = readFileSync(join(state, "issues/issues.json"));
    expect(() => createIssueService(root).dispatch(issueId, issue.revision, "backend-engineer")).toThrow(/active workflow/);
    expect(readFileSync(join(state, "issues/issues.json"))).toEqual(before); expect(listTasks()).toHaveLength(1);
  });
  it("the trusted v1 dispatch helper cannot bypass ownership with a valid current issue preview", () => {
    const { result } = start(); updateTask(result.stages[0]!.task_id!, (task) => { task.lifecycle = "finished"; task.outcome = "needs-review"; task.finished_at = new Date().toISOString(); });
    const issue = readIssueDocument().issues[issueId]!, context = createContextService(root);
    const preview = context.preview({ kind: "issue", project: "alpha", agent: "backend-engineer", role_id: "software-engineer", issue_id: issueId, expected_revision: issue.revision }); expect(preview.allowed).toBe(true);
    expect(() => createTask({ project: "alpha", agent: "backend-engineer", role_id: "software-engineer", instructions: "Synthetic current scope", sandbox: "workspace-write", preview_fingerprint: preview.fingerprint }, root,
      { taskId: "bypass-attempt", issueId, expectedRevision: issue.revision, scopeRevision: issue.scope_revision, authorizedScope: issue.authorized_scope }, { context })).toThrow(/workflow ownership/);
    expect(listTasks()).toHaveLength(1);
  });
  it("duplicate linkage before task creation preserves issue bytes and exact task identity", () => {
    start({ issues: { linkWorkflowTask: (stageId) => { const issues = createIssueService(root), first = issues.linkWorkflowTask(stageId), bytes = readFileSync(join(state, "issues/issues.json")); expect(issues.linkWorkflowTask(stageId)).toEqual(first); expect(readFileSync(join(state, "issues/issues.json"))).toEqual(bytes); return first; } } });
    expect(listTasks()).toHaveLength(1); expect(readIssueDocument().issues[issueId]!.task_ids).toHaveLength(1);
  });
  it("duplicate root approval cannot change or replace an owned identity", () => {
    const { service, input, preview } = start(), before = workflowBytes(), issue = readFileSync(join(state, "issues/issues.json"));
    expect(() => service.start({ request: input, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "second-approval" })).toThrow(/changed|workflow/);
    expect(workflowBytes()).toBe(before); expect(readFileSync(join(state, "issues/issues.json"))).toEqual(issue); expect(listTasks()).toHaveLength(1);
  });
  it.each([null, [], { confirm: true }, { confirm: false }, { confirm: "true" }, { approval_id: "" }, { approval_id: "x".repeat(101) }, { approval_id: "C:\\private\\auth.json" }, { grant: {} }, { task_id: "caller-task" }, { context_manifest: {} }, { instructions: "Injected permission" }])("rejects unconfirmed/injected root fields %# before writes", (delta) => {
    const service = createWorkflowService(root), input = request(), preview = service.preview(input), before = readFileSync(join(state, "issues/issues.json"));
    const payload = delta === null || Array.isArray(delta) ? delta : { request: input, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-root", ...delta };
    // An empty delta is not tested here: every valid-looking case is a denial.
    if (delta && !Array.isArray(delta) && Object.keys(delta).length === 1 && delta.confirm === true) (payload as Record<string, unknown>).request = undefined;
    expect(() => service.start(payload)).toThrow(); expect(listTasks()).toEqual([]); expect(existsSync(join(state, "workflows"))).toBe(false); expect(readFileSync(join(state, "issues/issues.json"))).toEqual(before);
  });
  it.each(["source", "issue", "scope", "policy"])("rejects %s drift between preview and confirmation without authority", (kind) => {
    const service = createWorkflowService(root), input = request(), preview = service.preview(input);
    if (kind === "source") writeFileSync(join(root, "projects/alpha/AGENTS.md"), "Changed required source");
    if (kind === "policy") writeFileSync(join(root, "registry/workflow-policy.yml"), readFileSync(join(root, "registry/workflow-policy.yml"), "utf8").replace("100000", "90000"));
    if (kind === "issue") mutateIssueDocument((document) => { document.issues[issueId]!.revision++; });
    if (kind === "scope") mutateIssueDocument((document) => { document.issues[issueId]!.authorized_scope.allowed_path_patterns.push("lib/**"); });
    expect(() => service.start({ request: input, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-root" })).toThrow(); expect(listTasks()).toEqual([]); expect(existsSync(join(state, "workflows"))).toBe(false);
  });
  it("restart invalidates preview issuance but preserves stored authority and task references", () => {
    const input = request(), original = createWorkflowService(root), preview = original.preview(input);
    expect(() => createWorkflowService(root).start({ request: input, preview_fingerprint: preview.fingerprint, approval_id: "synthetic-root", confirm: true })).toThrow(/issued/);
    const { result } = start(); expect(createWorkflowService(root).detail(result.workflow.id)).toEqual(result);
  });
  it("repeated trusted task persistence uses the reserved id and never rewrites bytes/events", () => {
    start({ createTask: (input, repo, options) => {
      const first = createWorkflowTask(input, repo, options), bytes = readFileSync(join(state, `tasks/${first.id}.json`)), events = readTaskEvents(first.id);
      expect(createWorkflowTask(input, repo, options)).toEqual(first); expect(readFileSync(join(state, `tasks/${first.id}.json`))).toEqual(bytes); expect(readTaskEvents(first.id)).toEqual(events); return first;
    } }); expect(listTasks()).toHaveLength(1);
  });
  it.each(["before-task", "after-task", "issue-drift", "commit-drift"])("retains exact identities and denies continuation at %s failure", (point) => {
    const service = createWorkflowService(root, {
      issues: point === "issue-drift" ? { linkWorkflowTask: (stageId) => { mutateIssueDocument((document) => { document.issues[issueId]!.revision++; }); return createIssueService(root).linkWorkflowTask(stageId); } } : undefined,
      createTask: (input, repo, options) => {
        if (point === "before-task") throw new Error("Synthetic private failure C:\\private\\auth.json");
        const result = createWorkflowTask(input, repo, options);
        if (point === "after-task") throw new Error("Synthetic lost callback");
        if (point === "commit-drift") mutateIssueDocument((document) => { document.issues[issueId]!.revision++; });
        return result;
      },
    }); const input = request(), preview = service.preview(input);
    expect(() => service.start({ request: input, preview_fingerprint: preview.fingerprint, approval_id: "synthetic-root", confirm: true })).toThrow(/incomplete/);
    const document = readWorkflowDocument(), workflow = Object.values(document.workflows)[0]!, intent = Object.values(document.admission_intents)[0]!, stage = Object.values(document.stages)[0]!;
    expect(workflow).toMatchObject({ status: "needs-decision", recovery_state: "awaiting-human", counters: { tasks: 1, attempts: 0 } }); expect(intent.status).toBe("reserved"); expect(intent.task_id).toBe(stage.task_id);
    expect(listTasks()).toHaveLength(["after-task", "commit-drift"].includes(point) ? 1 : 0);
    expect(JSON.stringify(document)).not.toContain("Synthetic private failure");
    expect(() => createWorkflowTask({ workflow_id: workflow.id, stage_id: stage.id, expected_workflow_revision: workflow.revision, expected_issue_revision: intent.expected_issue_revision }, root, { context: createWorkflowContextService(root) })).toThrow(/reserved/);
    expect(readWorkflowDocument()).toEqual(document);
  });
  it("valid server-created v2 still stops before executor/worktree effects", async () => {
    const { result } = start(), taskId = result.stages[0]!.task_id!, run = vi.fn(); const before = workflowBytes();
    await runTask(taskId, root, { run }); expect(run).not.toHaveBeenCalled(); expect(readTask(taskId)!.outcome).toBe("needs-review"); expect(workflowBytes()).toBe(before); expect(existsSync(join(root, "projects/surtec-worktrees"))).toBe(false);
  });
  it("malformed/future workflow state retains bytes and denies reads and mutations", () => {
    const service = createWorkflowService(root), input = request(), preview = service.preview(input);
    mkdirSync(join(state, "workflows")); const bytes = '{"schema_version":99,"private":"synthetic"}'; writeFileSync(join(state, "workflows/workflows.json"), bytes);
    expect(() => service.list()).toThrow(); expect(() => service.start({ request: input, preview_fingerprint: preview.fingerprint, approval_id: "synthetic-root", confirm: true })).toThrow(); expect(workflowBytes()).toBe(bytes); expect(listTasks()).toEqual([]);
  });
});

describe("exact human plan decisions and body-free projections", () => {
  it.each(["approve", "reject"])("records %s once without changing the issue plan/scope or admitting a writer", (decision) => {
    const gate = plannerGate(), before = readFileSync(join(state, "issues/issues.json")), count = listTasks().length;
    const result = gate.service.decide(gate.workflow.id, { ...gate.payload, decision });
    expect(result.decisions[0]).toMatchObject({ status: decision === "approve" ? "approved" : "rejected", decided_by: "human" });
    expect(result.workflow.status).toBe(decision === "approve" ? "running" : "needs-decision"); expect(result.workflow.approved_plan !== null).toBe(decision === "approve");
    expect(readFileSync(join(state, "issues/issues.json"))).toEqual(before); expect(listTasks()).toHaveLength(count);
    const bytes = workflowBytes(); expect(() => gate.service.decide(gate.workflow.id, gate.payload)).toThrow(/resolved|stale/); expect(workflowBytes()).toBe(bytes);
  });
  it.each(["source", "scope", "issue-revision", "workflow-revision", "output", "task", "usage", "decision-kind"])("rejects %s drift/replay without successor effects", (kind) => {
    const gate = plannerGate();
    if (kind === "source") writeFileSync(join(root, "projects/alpha/AGENTS.md"), "Required source changed");
    if (kind === "scope") mutateIssueDocument((document) => { document.issues[issueId]!.authorized_scope.allowed_path_patterns.push("lib/**"); });
    if (kind === "issue-revision") gate.payload.expected_issue_revision++;
    if (kind === "workflow-revision") gate.payload.expected_revision++;
    if (kind === "task") updateTask(gate.taskId, (task) => { task.outcome = "needs-review"; });
    if (["output", "usage", "decision-kind"].includes(kind)) {
      const document = readWorkflowDocument();
      if (kind === "output") (document.stages[gate.stageId]!.output as Extract<WorkflowRoleOutput, { kind: "plan" }>).plan.push("Different plan");
      if (kind === "usage") { document.accounting["synthetic-planner-run"]!.usage_complete = false; document.workflows[gate.workflow.id]!.counters.accounting_complete = false; document.workflows[gate.workflow.id]!.status = "needs-decision"; document.workflows[gate.workflow.id]!.blocked_reason = "Unknown usage"; }
      if (kind === "decision-kind") document.decisions[gate.decision.id]!.kind = "proposal-acknowledgement";
      assertWorkflowDocument(document); writeFileSync(join(state, "workflows/workflows.json"), JSON.stringify(document));
    }
    const before = workflowBytes(); expect(() => gate.service.decide(gate.workflow.id, gate.payload)).toThrow(); expect(workflowBytes()).toBe(before); expect(listTasks()).toHaveLength(1);
  });
  it("read projections omit source/context bodies, private paths and authority injection", () => {
    const gate = plannerGate(), projection = gate.service.detail(gate.workflow.id), encoded = JSON.stringify(projection);
    expect(encoded).not.toContain(root); expect(encoded).not.toContain("Synthetic private source body"); expect(projection.grant).not.toHaveProperty("authorized_scope"); expect(projection).not.toHaveProperty("instructions");
    expect(projection.stages[0]!.output).toMatchObject({ kind: "plan", plan: ["Implement only the authorized change"] });
  });
  it.each(["cancel", "recover", "candidate-acceptance", "replacement", "correction"])("keeps unsupported %s mutations denied", () => {
    const { service, result } = start(), bytes = workflowBytes(), issue = readFileSync(join(state, "issues/issues.json"));
    expect(() => service.unsupported(result.workflow.id, { expected_revision: result.workflow.revision, expected_issue_revision: readIssueDocument().issues[issueId]!.revision })).toThrow(/not implemented/);
    expect(workflowBytes()).toBe(bytes); expect(readFileSync(join(state, "issues/issues.json"))).toEqual(issue); expect(listTasks()).toHaveLength(1);
  });
  it("rejects inherited, oversized and unknown decision authority fields", () => {
    const gate = plannerGate(), before = workflowBytes();
    for (const input of [Object.create(gate.payload), { ...gate.payload, scope: {} }, { ...gate.payload, rationale: "x".repeat(1001) }, { ...gate.payload, confirm: false }, { ...gate.payload, candidate_id: "caller-candidate" }]) expect(() => gate.service.decide(gate.workflow.id, input)).toThrow();
    expect(workflowBytes()).toBe(before);
  });
  it("cannot approve hidden private output or unrelated evidence even with matching output/decision hashes", () => {
    const gate = plannerGate(), document = readWorkflowDocument(), stage = document.stages[gate.stageId]!;
    (stage.output as Extract<WorkflowRoleOutput, { kind: "plan" }>).plan.push("Inspect C:\\private\\auth.json"); stage.output_fingerprint = contextHash(JSON.stringify(stage.output));
    document.decisions[gate.decision.id]!.resource_fingerprint = stage.output_fingerprint; assertWorkflowDocument(document); writeFileSync(join(state, "workflows/workflows.json"), JSON.stringify(document));
    const before = workflowBytes(); expect(() => gate.service.decide(gate.workflow.id, { ...gate.payload, resource_fingerprint: stage.output_fingerprint })).toThrow(/Planner proposal/); expect(workflowBytes()).toBe(before);
    expect(JSON.stringify(gate.service.detail(gate.workflow.id))).not.toContain("C:\\\\private");
  });
  it("rejects substituted Planner task generation and cannot grant a successor", () => {
    const gate = plannerGate(), before = workflowBytes();
    updateTask(gate.taskId, (task) => { if (task.envelope.context_admission?.schema_version === 2) task.envelope.context_admission.stage_generation++; });
    expect(() => gate.service.decide(gate.workflow.id, gate.payload)).toThrow(/Planner proposal/); expect(workflowBytes()).toBe(before); expect(listTasks()).toHaveLength(1);
  });
  it("strict filters and safe not-found lookup do not become path parameters", () => {
    const { service, result } = start(); expect(service.list({ issue_id: issueId })).toEqual([result.workflow]); expect(service.list({ project_id: "other" })).toEqual([]);
    expect(() => service.list({ path: "private" })).toThrow(); expect(() => service.detail("../private")).toThrow(); expect(() => service.detail("missing")).toThrow(/not found/);
  });
});
