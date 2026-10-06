import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { AgentRoleRegistry } from "../../../lib/context/types";
import { contextHash } from "../../../lib/context/assemble";
import { readIssueDocument, mutateIssueDocument } from "../../../lib/state/issues";
import * as issueStore from "../../../lib/state/issues";
import { listTasks, readTask, updateTask, writeTask } from "../../../lib/state/store";
import { readTaskEvents } from "../../../lib/state/events";
import { readWorkflowDocument, mutateWorkflowDocument } from "../../../lib/state/workflows";
import type { WorkflowCandidateBinding, WorkflowRoleOutput } from "../../../lib/workflows/types";
import { assertWorkflowDocument } from "../../../lib/workflows/validation";
import { createIssueService, parseIndependentWorkflowBudgetStopSummary, workflowBudgetStopSummary } from "./issue-service";
import { createWorkflowContextService, type WorkflowPreviewRequest } from "./workflow-context-service";
import { createWorkflowService, type WorkflowServiceOptions } from "./workflow-service";
import { createTask, createWorkflowTask, prepareTaskBudgetAdmission } from "./dispatch";
import { createContextService } from "./context-service";
import { createTestingEvidence, sealTestingEvidence } from "../../../lib/context/testing-evidence";
import { runTask } from "../../../runner/run-task";
import { BUDGET_DIMENSIONS, type BudgetLimits } from "../../../lib/budgets/types";
import { readBudgetPolicy, type BudgetPolicySource } from "../../../lib/budgets/policy";
import { evaluateWorkflowBudgetStop, independentWorkflowBudgetStopSummary, projectWorkflowConsumption } from "../../../lib/workflows/policy";
import { readBudgetLedger, mutateBudgetLedger } from "../../../lib/state/budgets";
import { reserveTaskBudget, commitTaskBudget } from "../../../lib/budgets/reservations";
import { BudgetExecutionScaffold } from "../../../runner/task-orchestrator";
import { WorkflowOrchestrator } from "../../../runner/workflow-orchestrator";

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
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false); });
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
function plannerGate(exhaustTokens = false) {
  const started = start({}, request("implementation")), stageId = started.result.workflow.current_stage_id!, taskId = started.result.stages[0]!.task_id!;
  const output: WorkflowRoleOutput = { schema_version: 1, kind: "plan", status: "completed", summary: "Exact synthetic proposal", plan: ["Implement only the authorized change"], scope_change_required: false, evidence_ids: [], unresolved_questions: [], risks: [], recommended_next_action: "Wait for human approval", requested_decision: "Approve the current plan" };
  updateTask(taskId, (task) => { task.lifecycle = "finished"; task.outcome = "completed"; task.finished_at = new Date().toISOString(); task.orchestration!.attempts = 1; });
  const at = new Date().toISOString(), runId = "synthetic-planner-run", decisionId = "synthetic-plan-decision";
  mutateWorkflowDocument((document) => {
    const workflow = document.workflows[started.result.workflow.id]!; workflow.revision++; workflow.updated_at = at;
    const stage = document.stages[stageId]!; stage.status = "running"; stage.execution_id = runId; stage.updated_at = at;
    const totalTokens = exhaustTokens ? workflow.budget.max_total_tokens : 50;
    workflow.counters = { tasks: 1, attempts: 1, runtime_ms: 100, total_tokens: totalTokens, accounting_complete: true };
    document.accounting[runId] = { schema_version: 1, id: runId, workflow_id: workflow.id, stage_id: stage.id, task_id: taskId, execution_id: runId, attempt: 1, attempt_charged: true, active_runtime_ms: 100, observed_tokens: totalTokens, usage_complete: true, captured_at: at };
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

function budgetExhaustionFixture(status: "authorized" | "working" | "checking" = "working") {
  const started = start({}, request(status === "authorized" ? "analysis" : "trivial-change"));
  const stageId = started.result.workflow.current_stage_id!, taskId = started.result.stages[0]!.task_id!, runId = "synthetic-budget-run", at = new Date().toISOString();
  updateTask(taskId, (task) => {
    task.lifecycle = "running"; task.started_at = at; task.orchestration!.attempts = 1;
    task.orchestration!.lease = { run_id: runId, worker_id: "synthetic-budget-worker", acquired_at: at, heartbeat_at: at, expires_at: new Date(Date.now() + 120_000).toISOString() };
  });
  mutateWorkflowDocument((document) => {
    const workflow = document.workflows[started.result.workflow.id]!, stage = document.stages[stageId]!;
    workflow.revision++; workflow.updated_at = at; workflow.counters.attempts = 1;
    workflow.counters.runtime_ms = 100; workflow.counters.total_tokens = workflow.budget.max_total_tokens;
    stage.status = "running"; stage.execution_id = runId; stage.updated_at = at;
    document.accounting[runId] = { schema_version: 1, id: runId, workflow_id: workflow.id, stage_id: stage.id, task_id: taskId, execution_id: runId,
      attempt: 1, attempt_charged: true, active_runtime_ms: 100, observed_tokens: workflow.budget.max_total_tokens, usage_complete: false, captured_at: at };
  });
  let candidate: WorkflowCandidateBinding | null = null;
  if (status === "checking") {
    const recorded = createIssueService(root).recordCandidate({ issueId, taskId, executionId: runId, repositoryId: "alpha", scopeRevision: 1,
      baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40), changedPaths: ["src/fixture.ts"] });
    candidate = { candidate_id: recorded.id, issue_id: issueId, repository_id: "alpha", task_id: taskId, execution_id: runId, scope_revision: 1,
      base_revision: recorded.base_revision, candidate_revision: recorded.candidate_revision, changed_paths: recorded.changed_paths,
      diff_fingerprint: recorded.diff_fingerprint, content_fingerprint: "c".repeat(64), testing_evidence_fingerprint: "d".repeat(64) };
    mutateWorkflowDocument((document) => {
      const workflow = document.workflows[started.result.workflow.id]!;
      workflow.revision++; workflow.updated_at = new Date().toISOString();
      workflow.candidate = candidate; document.lineages[workflow.lineage_id!]!.candidate_ids.push(recorded.id);
    });
  }
  return { ...started, stageId, taskId, runId, candidate };
}

function correctionReplacementBudgetFixture() {
  const started = start({}, { ...request("trivial-change"), correction_enabled: true,
    budget: { max_tasks: 4, max_attempts: 4, max_runtime_ms: 400_000, max_total_tokens: 50_000 } });
  const ownerId = started.result.workflow.id, original = started.result.stages[0]!, originalRun = "synthetic-original-correction-base", at = new Date().toISOString();
  updateTask(original.task_id!, (task) => {
    task.lifecycle = "running"; task.started_at = at; task.orchestration!.attempts = 1;
    task.orchestration!.lease = { run_id: originalRun, worker_id: "synthetic-original-worker", acquired_at: at, heartbeat_at: at, expires_at: new Date(Date.now() + 120_000).toISOString() };
  });
  mutateWorkflowDocument((document) => {
    const owner = document.workflows[ownerId]!, stage = document.stages[original.id]!; owner.revision++; owner.updated_at = at;
    owner.counters.attempts = 1; owner.counters.total_tokens = 2; stage.status = "running"; stage.execution_id = originalRun; stage.updated_at = at;
    document.accounting[originalRun] = { schema_version: 1, id: originalRun, workflow_id: ownerId, stage_id: stage.id, task_id: stage.task_id!, execution_id: originalRun,
      attempt: 1, attempt_charged: true, active_runtime_ms: 0, observed_tokens: 2, usage_complete: true, captured_at: at };
  });
  const issues = createIssueService(root), recorded = issues.recordCandidate({ issueId, taskId: original.task_id!, executionId: originalRun,
    repositoryId: "alpha", scopeRevision: 1, baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40), changedPaths: ["src/fixture.ts"] });
  const candidate: WorkflowCandidateBinding = { candidate_id: recorded.id, issue_id: issueId, repository_id: "alpha", task_id: original.task_id!, execution_id: originalRun,
    scope_revision: 1, base_revision: recorded.base_revision, candidate_revision: recorded.candidate_revision, changed_paths: recorded.changed_paths,
    diff_fingerprint: recorded.diff_fingerprint, content_fingerprint: "c".repeat(64), testing_evidence_fingerprint: "d".repeat(64) };
  updateTask(original.task_id!, (task) => { task.lifecycle = "finished"; task.finished_at = at; task.outcome = "completed"; task.orchestration!.lease = null; });
  const correctionId = "synthetic-current-correction-stage", taskId = "synthetic-current-correction-task", reviewId = "synthetic-prior-review-stage", runId = "synthetic-current-correction-run";
  const output: Extract<WorkflowRoleOutput, { kind: "review" }> = { schema_version: 1, kind: "review", status: "completed", summary: "Synthetic exact correction finding",
    verdict: "correction-required", findings: [{ id: "synthetic-correction-finding", severity: "blocking", summary: "Correct the exact scoped fixture", path: "src/fixture.ts",
      evidence_ids: [readIssueDocument().issues[issueId]!.evidence_ids.at(-1)!], scope_change_required: false }], evidence_ids: [], unresolved_questions: [], risks: [], recommended_next_action: "Apply the single bounded correction", requested_decision: null };
  // Synthetic sealed review state; the regression starts after its admitted
  // correction and exercises the real recordCandidate ordering, not its gate.
  mutateWorkflowDocument((document) => {
    const owner = document.workflows[ownerId]!, previous = document.stages[original.id]!, lineage = document.lineages[owner.lineage_id!]!;
    owner.revision++; owner.updated_at = at; owner.candidate = candidate; owner.current_stage_id = correctionId; owner.stage_ids.push(reviewId, correctionId); owner.counters.tasks = 3; owner.counters.attempts = 2; owner.counters.total_tokens = 3;
    previous.status = "completed"; previous.output_fingerprint = contextHash(JSON.stringify(candidate)); previous.candidate = candidate;
    document.stages[reviewId] = { ...previous, id: reviewId, ordinal: 2, kind: "review", role_id: "reviewer", agent_id: "reality-checker", sandbox: "read-only",
      task_id: "synthetic-sealed-review-task", execution_id: "synthetic-sealed-review-run", predecessor_stage_id: previous.id, output, output_fingerprint: contextHash(JSON.stringify(output)), candidate };
    document.stages[correctionId] = { ...previous, id: correctionId, ordinal: 3, kind: "correction", status: "reserved", task_id: taskId, execution_id: null,
      predecessor_stage_id: reviewId, handoff_id: "synthetic-correction-handoff", output: null, output_fingerprint: null, candidate };
    document.handoffs["synthetic-correction-handoff"] = { schema_version: 1, id: "synthetic-correction-handoff", issue_id: issueId,
      from_role_id: "reviewer", to_role_id: "software-engineer", execution_id: "synthetic-sealed-review-run", outcome_summary: output.summary,
      evidence_ids: output.findings[0]!.evidence_ids, unresolved_questions: [], risks: [], recommended_next_action: output.recommended_next_action, requested_decision: null, created_at: at };
    document.accounting["synthetic-sealed-review-run"] = { ...document.accounting[originalRun]!, id: "synthetic-sealed-review-run", stage_id: reviewId,
      task_id: "synthetic-sealed-review-task", execution_id: "synthetic-sealed-review-run", observed_tokens: 1 };
    lineage.candidate_ids.push(candidate.candidate_id); lineage.corrections_consumed = 1; lineage.consumed_stage_id = correctionId; lineage.consumed_at = at;
    document.admission_intents["synthetic-correction-intent"] = { ...Object.values(document.admission_intents)[0]!, id: "synthetic-correction-intent", stage_id: correctionId,
      task_id: taskId, status: "reserved", expected_issue_revision: readIssueDocument().issues[issueId]!.revision + 1, expected_workflow_revision: owner.revision };
  });
  const linked = issues.linkWorkflowTask(correctionId), task = structuredClone(readTask(original.task_id!)!);
  task.envelope.id = taskId; task.lifecycle = "running"; task.outcome = null; task.finished_at = null;
  task.orchestration!.lease = { run_id: runId, worker_id: "synthetic-correction-worker", acquired_at: at, heartbeat_at: at, expires_at: new Date(Date.now() + 120_000).toISOString() };
  if (task.envelope.context_admission?.schema_version !== 2) throw new Error("Synthetic correction needs v2");
  Object.assign(task.envelope.context_admission, { task_id: taskId, stage_id: correctionId, stage_kind: "correction", issue_revision: linked.revision,
    predecessor_stage_id: reviewId, handoff_id: "synthetic-correction-handoff", candidate });
  writeTask(task);
  mutateWorkflowDocument((document) => {
    const owner = document.workflows[ownerId]!; owner.revision++; owner.updated_at = at;
    document.stages[correctionId]!.status = "queued"; document.admission_intents["synthetic-correction-intent"]!.status = "committed";
  });
  mutateWorkflowDocument((document) => {
    const owner = document.workflows[ownerId]!, current = document.stages[correctionId]!; owner.revision++; owner.updated_at = at;
    current.status = "running"; current.execution_id = runId; current.updated_at = at;
    owner.counters.attempts = 3; document.accounting[runId] = { ...document.accounting[originalRun]!, id: runId, stage_id: correctionId, task_id: taskId, execution_id: runId, observed_tokens: 1, usage_complete: false };
    owner.counters.total_tokens = 4;
  });
  const replacement = issues.recordCandidate({ issueId, taskId, executionId: runId, repositoryId: "alpha", scopeRevision: 1,
    baseRevision: candidate.candidate_revision, candidateRevision: "e".repeat(40), changedPaths: ["src/fixture.ts"] });
  mutateWorkflowDocument((document) => {
    const owner = document.workflows[ownerId]!, cap = document.grants[owner.current_grant_id]!.correction.budget!.max_total_tokens;
    owner.revision++; owner.updated_at = new Date().toISOString(); document.accounting[runId]!.observed_tokens = cap; document.accounting[runId]!.usage_complete = false;
    owner.counters.total_tokens = 3 + cap;
  });
  return { ...started, ownerId, taskId, runId, correctionId, candidate, replacement };
}

describe("canonical workflow budget exhaustion", () => {
  it("uses the exact unsealed correction replacement after real recordCandidate without fabricating its verification or resetting the retained base", () => {
    const fixture = correctionReplacementBudgetFixture(), task = readFileSync(join(state, `tasks/${fixture.taskId}.json`)), before = readWorkflowDocument();
    expect(readTask(fixture.taskId)!.testing_evidence).toBeUndefined(); expect(before.workflows[fixture.ownerId]!.candidate).toEqual(fixture.candidate);
    expect(createIssueService(root).get(issueId).issue.status).toBe("checking");
    expect(fixture.service.stopForBudget(fixture.ownerId, "observe")).toBe(true);
    const after = readIssueDocument(), event = after.events.at(-1)!;
    expect(event).toMatchObject({ type: "verification-needs-decision", payload: { candidate_id: fixture.replacement.id, retained_candidate: fixture.candidate,
      replacement_candidate: fixture.replacement, budget_exhaustion: { binding: { candidate: fixture.candidate }, denials: expect.arrayContaining([
        expect.objectContaining({ scope: "correction", dimension: "total_tokens", code: "budget-exhausted" })]) } } });
    expect(after.evidence[after.issues[issueId]!.evidence_ids.at(-1)!]).toMatchObject({ candidate_id: fixture.replacement.id, candidate_revision: fixture.replacement.candidate_revision });
    expect(readWorkflowDocument().workflows[fixture.ownerId]!.candidate).toEqual(fixture.candidate);
    expect(readWorkflowDocument().lineages[fixture.result.workflow.lineage_id!]!.candidate_ids).toEqual([fixture.candidate.candidate_id]);
    expect(readFileSync(join(state, `tasks/${fixture.taskId}.json`))).toEqual(task); expect(after.issues[issueId]!.candidate_ids).toEqual([fixture.candidate.candidate_id, fixture.replacement.id]);
  });
  it.each(["base", "run", "event", "lineage"])("refuses an unsealed correction replacement with stale %s without rewriting retained authority", (change) => {
    const fixture = correctionReplacementBudgetFixture();
    if (change === "base") mutateIssueDocument((document) => { document.candidates[fixture.replacement.id]!.base_revision = "f".repeat(40); });
    if (change === "run") mutateIssueDocument((document) => { document.candidates[fixture.replacement.id]!.execution_id = "foreign-correction-run"; });
    if (change === "event") mutateIssueDocument((document) => { document.events.find((entry) => entry.type === "candidate-produced" && entry.payload.candidate_id === fixture.replacement.id)!.payload.diff_fingerprint = "f".repeat(64); });
    if (change === "lineage") { const document = readWorkflowDocument(); document.lineages[fixture.result.workflow.lineage_id!]!.candidate_ids = []; expect(() => assertWorkflowDocument(document)).toThrow(); }
    const beforeWorkflow = workflowBytes(), beforeIssue = readFileSync(join(state, "issues/issues.json")), task = readFileSync(join(state, `tasks/${fixture.taskId}.json`));
    if (change === "lineage") {
      // A malformed/future aggregate is never silently repaired by a read.
      writeFileSync(join(state, "workflows/workflows.json"), '{"schema_version":99}');
      const invalid = workflowBytes(); expect(() => fixture.service.stopForBudget(fixture.ownerId, "observe")).toThrow(); expect(workflowBytes()).toBe(invalid);
    } else { expect(() => fixture.service.stopForBudget(fixture.ownerId, "observe")).toThrow(/stale|progress/); expect(workflowBytes()).toBe(beforeWorkflow); }
    expect(readFileSync(join(state, "issues/issues.json"))).toEqual(beforeIssue); expect(readFileSync(join(state, `tasks/${fixture.taskId}.json`))).toEqual(task);
  });
  it.each(["authorized", "working", "checking"] as const)("takes only the existing %s needs-decision edge with exact retained evidence", (status) => {
    const fixture = budgetExhaustionFixture(status), beforeTask = readFileSync(join(state, `tasks/${fixture.taskId}.json`));
    const before = readIssueDocument().issues[issueId]!, stop = evaluateWorkflowBudgetStop(readWorkflowDocument(), fixture.result.workflow.id, "observe")!;
    expect(fixture.service.stopForBudget(fixture.result.workflow.id, "observe")).toBe(true);
    const document = readIssueDocument(), issue = document.issues[issueId]!, event = document.events.at(-1)!;
    expect(issue).toMatchObject({ status: "needs-decision", scope_revision: before.scope_revision, revision: before.revision + 1 });
    expect(issue.authorized_scope).toEqual(before.authorized_scope); expect(issue.task_ids).toEqual(before.task_ids); expect(issue.candidate_ids).toEqual(before.candidate_ids);
    expect(event.type).toBe(status === "authorized" ? "authorization-stale" : status === "working" ? "decision-required" : "verification-needs-decision");
    expect(event.payload).toMatchObject({ workflow_id: fixture.result.workflow.id, stage_id: fixture.stageId, task_id: fixture.taskId,
      execution_id: fixture.runId, candidate_id: fixture.candidate?.candidate_id ?? null, budget_stop_key: workflowBudgetStopSummary(stop),
      budget_exhaustion: { operation: "observe", binding: { grant_id: fixture.result.grant.id, authority_revision: 1, scope_revision: 1,
        policy_fingerprint: fixture.result.grant.policy_fingerprint, testing_policy_fingerprint: fixture.result.grant.testing_policy_fingerprint },
      denials: [{ code: "budget-exhausted", scope: "root", dimension: "total_tokens", cap: fixture.result.workflow.budget.max_total_tokens, remaining: 0 }] } });
    expect(document.evidence[issue.evidence_ids.at(-1)!]).toMatchObject({ task_id: fixture.taskId, execution_id: fixture.runId, status: "gap", candidate_id: fixture.candidate?.candidate_id ?? null });
    expect(readWorkflowDocument().events.at(-1)).toMatchObject({ type: "budget-stopped", stage_id: fixture.stageId, execution_id: fixture.runId, summary: workflowBudgetStopSummary(stop) });
    expect(readFileSync(join(state, `tasks/${fixture.taskId}.json`))).toEqual(beforeTask); expect(listTasks()).toHaveLength(1); expect(existsSync(join(state, "budgets"))).toBe(false);
  });
  it("retains the one issue transition across repeated calls, later high-water, restart and explicit human resume", () => {
    const fixture = budgetExhaustionFixture(); fixture.service.stopForBudget(fixture.result.workflow.id, "observe");
    const beforeIssue = readFileSync(join(state, "issues/issues.json")), beforeWorkflow = workflowBytes();
    expect(fixture.service.stopForBudget(fixture.result.workflow.id, "observe")).toBe(true);
    expect(createIssueService(root).recordWorkflowBudgetExhaustion(fixture.result.workflow.id, "observe")).toBe(false);
    expect(readFileSync(join(state, "issues/issues.json"))).toEqual(beforeIssue); expect(workflowBytes()).toBe(beforeWorkflow);
    mutateWorkflowDocument((document) => {
      const owner = document.workflows[fixture.result.workflow.id]!; owner.revision++; owner.updated_at = new Date().toISOString();
      document.accounting[fixture.runId]!.active_runtime_ms = 150; owner.counters.runtime_ms = 150;
    });
    const afterHighWater = workflowBytes();
    expect(createWorkflowService(root).stopForBudget(fixture.result.workflow.id, "observe")).toBe(true);
    expect(readFileSync(join(state, "issues/issues.json"))).toEqual(beforeIssue); expect(workflowBytes()).toBe(afterHighWater);
    const issue = readIssueDocument().issues[issueId]!; createIssueService(root).resolveDecision(issueId, issue.revision, "synthetic-human-resume", "Inspect retained consumption before any fresh admission.");
    const resumed = readFileSync(join(state, "issues/issues.json"));
    expect(createIssueService(root).recordWorkflowBudgetExhaustion(fixture.result.workflow.id, "observe")).toBe(false);
    expect(readFileSync(join(state, "issues/issues.json"))).toEqual(resumed); expect(readIssueDocument().issues[issueId]!.status).toBe("authorized");
  });
  it.each(["expired-lease", "replaced-run", "generation", "scope", "unrelated-progress", "candidate"])("refuses %s stale budget ownership without task, issue or workflow effects", (change) => {
    const fixture = budgetExhaustionFixture(change === "candidate" ? "checking" : "working");
    if (change === "expired-lease") updateTask(fixture.taskId, (task) => { task.orchestration!.lease!.expires_at = task.orchestration!.lease!.acquired_at; });
    if (change === "replaced-run") updateTask(fixture.taskId, (task) => { task.orchestration!.lease!.run_id = "foreign-budget-run"; });
    if (change === "generation") updateTask(fixture.taskId, (task) => { if (task.envelope.context_admission?.schema_version === 2) task.envelope.context_admission.stage_generation++; });
    if (change === "scope") mutateIssueDocument((document) => { document.issues[issueId]!.authorized_scope.allowed_path_patterns.push("other/**"); });
    if (change === "unrelated-progress") mutateIssueDocument((document) => {
      const issue = document.issues[issueId]!; issue.revision++; document.events.push({ id: "synthetic-unrelated-progress", issue_id: issue.id, type: "synthetic-unrelated", at: new Date().toISOString(), scope_revision: 1, payload: {} });
    });
    if (change === "candidate") mutateIssueDocument((document) => { document.candidates[fixture.candidate!.candidate_id]!.invalidated_at = new Date().toISOString(); });
    const beforeIssue = readFileSync(join(state, "issues/issues.json")), beforeWorkflow = workflowBytes(), beforeTask = readFileSync(join(state, `tasks/${fixture.taskId}.json`));
    expect(() => fixture.service.stopForBudget(fixture.result.workflow.id, "observe")).toThrow(/stale|lease|scope|progress/);
    expect(readFileSync(join(state, "issues/issues.json"))).toEqual(beforeIssue); expect(workflowBytes()).toBe(beforeWorkflow);
    expect(readFileSync(join(state, `tasks/${fixture.taskId}.json`))).toEqual(beforeTask); expect(listTasks()).toHaveLength(1);
  });
  it.each(["ready-for-review", "done", "cancelled", "blocked", "needs-decision"] as const)("preserves protected %s issue state instead of rewriting it through exhaustion", (status) => {
    const fixture = budgetExhaustionFixture(); mutateIssueDocument((document) => { document.issues[issueId]!.status = status; });
    const beforeIssue = readFileSync(join(state, "issues/issues.json")), beforeWorkflow = workflowBytes();
    expect(fixture.service.stopForBudget(fixture.result.workflow.id, "observe")).toBe(false);
    expect(readFileSync(join(state, "issues/issues.json"))).toEqual(beforeIssue); expect(workflowBytes()).toBe(beforeWorkflow);
  });
  it("does not turn a human Planner gate or a correction opt-out into budget exhaustion", () => {
    const gate = plannerGate(), before = workflowBytes(), issue = readFileSync(join(state, "issues/issues.json"));
    expect(gate.service.stopForBudget(gate.workflow.id, "correction")).toBe(false);
    expect(workflowBytes()).toBe(before); expect(readFileSync(join(state, "issues/issues.json"))).toEqual(issue);
  });
  it("stops an exact exhausted read-only quality review without rewinding the protected ready-for-review issue", () => {
    const candidate = verifiedLegacyCandidate(), { service, result } = start({}, { ...request("quality-review"),
      selected_agents: { reviewer: "reality-checker", "qa-evaluator": "qa-reviewer" }, candidate_id: candidate.id });
    const stage = result.stages[0]!, runId = "synthetic-quality-budget-run", at = new Date().toISOString();
    updateTask(stage.task_id!, (task) => {
      task.lifecycle = "running"; task.started_at = at; task.orchestration!.attempts = 1;
      task.orchestration!.lease = { run_id: runId, worker_id: "synthetic-quality-worker", acquired_at: at, heartbeat_at: at, expires_at: new Date(Date.now() + 60_000).toISOString() };
    });
    mutateWorkflowDocument((document) => {
      const owner = document.workflows[result.workflow.id]!, current = document.stages[stage.id]!;
      owner.revision++; owner.updated_at = at; owner.counters.attempts = 1; owner.counters.total_tokens = owner.budget.max_total_tokens;
      current.status = "running"; current.execution_id = runId; current.updated_at = at;
      document.accounting[runId] = { schema_version: 1, id: runId, workflow_id: owner.id, stage_id: current.id, task_id: stage.task_id!, execution_id: runId,
        attempt: 1, attempt_charged: true, active_runtime_ms: 0, observed_tokens: owner.budget.max_total_tokens, usage_complete: false, captured_at: at };
    });
    const before = readFileSync(join(state, "issues/issues.json")), task = readFileSync(join(state, `tasks/${stage.task_id}.json`));
    expect(service.stopForBudget(result.workflow.id, "observe")).toBe(true);
    expect(readWorkflowDocument().workflows[result.workflow.id]).toMatchObject({ status: "needs-decision", recovery_state: "awaiting-human" });
    expect(readWorkflowDocument().events.at(-1)).toMatchObject({ type: "budget-stopped", execution_id: runId });
    expect(readFileSync(join(state, "issues/issues.json"))).toEqual(before); expect(readIssueDocument().issues[issueId]!.status).toBe("ready-for-review");
    expect(readFileSync(join(state, `tasks/${stage.task_id}.json`))).toEqual(task); expect(listTasks()).toHaveLength(2);
  });
  it("records authorization-stale before an exhausted successor even after legitimate human Planner approval", () => {
    const gate = plannerGate(true); gate.service.decide(gate.workflow.id, gate.payload);
    const task = readFileSync(join(state, `tasks/${gate.taskId}.json`));
    expect(() => gate.service.admitSuccessor(gate.workflow.id)).toThrow(/budget exhaustion/);
    expect(readIssueDocument().issues[issueId]!.status).toBe("needs-decision");
    expect(readIssueDocument().events.at(-1)).toMatchObject({ type: "authorization-stale", payload: { stage_id: gate.stageId, task_id: gate.taskId } });
    expect(readWorkflowDocument().workflows[gate.workflow.id]!.approved_plan).not.toBeNull(); expect(listTasks()).toHaveLength(1);
    expect(readFileSync(join(state, `tasks/${gate.taskId}.json`))).toEqual(task);
  });
  it("requires the exact retained budget-stopped event before an issue recorder may mutate", () => {
    const fixture = budgetExhaustionFixture();
    mutateWorkflowDocument((document) => {
      const owner = document.workflows[fixture.result.workflow.id]!; owner.revision++; owner.updated_at = new Date().toISOString();
      owner.status = "needs-decision"; owner.blocked_reason = "Human decision already required for another reason.";
    });
    const before = readFileSync(join(state, "issues/issues.json"));
    expect(createIssueService(root).recordWorkflowBudgetExhaustion(fixture.result.workflow.id, "observe")).toBe(false);
    expect(readFileSync(join(state, "issues/issues.json"))).toEqual(before); expect(fixture.service.stopForBudget(fixture.result.workflow.id, "observe")).toBe(false);
  });
  it("retains a durable stop through an issue persistence gap and retries only its exact canonical transition", () => {
    const fixture = budgetExhaustionFixture(), beforeIssue = readFileSync(join(state, "issues/issues.json")), beforeTask = readFileSync(join(state, `tasks/${fixture.taskId}.json`));
    const mutation = vi.spyOn(issueStore, "mutateIssueDocument").mockImplementationOnce(() => { throw new Error("Synthetic issue persistence failure"); });
    expect(() => fixture.service.stopForBudget(fixture.result.workflow.id, "observe")).toThrow(/persistence failure/);
    const stopped = readWorkflowDocument(); expect(stopped.workflows[fixture.result.workflow.id]).toMatchObject({ status: "needs-decision", recovery_state: "awaiting-human" });
    expect(stopped.events.at(-1)).toMatchObject({ type: "budget-stopped", execution_id: fixture.runId });
    expect(readFileSync(join(state, "issues/issues.json"))).toEqual(beforeIssue); expect(readFileSync(join(state, `tasks/${fixture.taskId}.json`))).toEqual(beforeTask);
    const stoppedBytes = workflowBytes(); mutation.mockRestore();
    expect(createWorkflowService(root).stopForBudget(fixture.result.workflow.id, "observe")).toBe(true);
    expect(workflowBytes()).toBe(stoppedBytes); expect(readIssueDocument().issues[issueId]!.status).toBe("needs-decision");
    expect(readIssueDocument().events.filter((entry) => entry.payload.budget_stop_key)).toHaveLength(1); expect(listTasks()).toHaveLength(1);
  });
  it("rejects a stale expected workflow snapshot before either stop or issue evidence", () => {
    const fixture = budgetExhaustionFixture(), snapshot = readWorkflowDocument();
    mutateWorkflowDocument((document) => { const owner = document.workflows[fixture.result.workflow.id]!; owner.revision++; owner.updated_at = new Date().toISOString(); owner.next_action = "Current synthetic inspection differs."; });
    const before = workflowBytes(), issue = readFileSync(join(state, "issues/issues.json"));
    expect(() => fixture.service.stopForBudget(fixture.result.workflow.id, "observe", snapshot)).toThrow(/snapshot is stale/);
    expect(workflowBytes()).toBe(before); expect(readFileSync(join(state, "issues/issues.json"))).toEqual(issue);
  });
  it("retains proven usage and unavailable totals when exact interrupted accounting requires a decision", () => {
    const fixture = budgetExhaustionFixture(), at = new Date().toISOString();
    updateTask(fixture.taskId, (task) => {
      task.lifecycle = "finished"; task.outcome = "needs-review"; task.finished_at = at; task.orchestration!.lease = null;
      task.orchestration!.last_failure = { kind: "terminal", message: "Synthetic interrupted usage", at, run_id: fixture.runId };
    });
    mutateWorkflowDocument((document) => {
      const owner = document.workflows[fixture.result.workflow.id]!, stage = document.stages[fixture.stageId]!;
      owner.revision++; owner.updated_at = at; owner.status = "needs-decision"; owner.recovery_state = "awaiting-human";
      owner.blocked_reason = "Interrupted accounting remains unknown."; owner.counters.accounting_complete = false;
      // The initial fixture is a proven ceiling sample; retained usage cannot
      // regress. Unknown final usage keeps that high-water, never known zero.
      stage.status = "needs-review"; stage.updated_at = at;
      const stop = evaluateWorkflowBudgetStop(document, owner.id, "admit")!;
      document.events.push({ schema_version: 1, id: "WE-synthetic-unknown-budget", workflow_id: owner.id, stage_id: stage.id, execution_id: fixture.runId,
        revision: owner.revision, type: "budget-stopped", summary: workflowBudgetStopSummary(stop), at });
    });
    const bytes = workflowBytes(), task = readFileSync(join(state, `tasks/${fixture.taskId}.json`));
    expect(fixture.service.stopForBudget(fixture.result.workflow.id, "admit")).toBe(true);
    const payload = readIssueDocument().events.at(-1)!.payload;
    expect(payload.budget_exhaustion).toMatchObject({ denials: expect.arrayContaining([{ code: "budget-accounting-unavailable", scope: "root", dimension: "accounting", cap: null,
      proven_consumed: fixture.result.workflow.budget.max_total_tokens, remaining: null, required: 1 }]) });
    expect(payload.budget_consumption).toMatchObject({ root: { canonical: { total_tokens: fixture.result.workflow.budget.max_total_tokens, accounting_complete: false }, runtime_ms: null, total_tokens: null } });
    expect(workflowBytes()).toBe(bytes); expect(readFileSync(join(state, `tasks/${fixture.taskId}.json`))).toEqual(task); expect(listTasks()).toHaveLength(1);
  });
  it("reports canonical and independent consumption read-only while an active final total remains unknown", () => {
    const fixture = budgetExhaustionFixture(), before = workflowBytes(), issue = readFileSync(join(state, "issues/issues.json")), task = readFileSync(join(state, `tasks/${fixture.taskId}.json`));
    const detail = fixture.service.detail(fixture.result.workflow.id), lineage = createIssueService(root).get(issueId);
    expect(detail.budget_consumption).toMatchObject({ root: { canonical: { attempts: 1, runtime_ms: 100, total_tokens: fixture.result.workflow.budget.max_total_tokens }, runtime_ms: null, total_tokens: null },
      review: { counters: { tasks: 0, attempts: 0, runtime_ms: 0, total_tokens: 0 } }, correction: { enabled: false, consumed: 0, remaining: 0 } });
    expect(lineage.budget_consumption).toEqual({ availability: "available", workflows: [detail.budget_consumption] });
    expect(workflowBytes()).toBe(before); expect(readFileSync(join(state, "issues/issues.json"))).toEqual(issue); expect(readFileSync(join(state, `tasks/${fixture.taskId}.json`))).toEqual(task);
  });
});

async function independentStopFixture(unknown = false) {
  const started = start(), stage = started.result.stages[0]!, taskId = stage.task_id!, runId = "synthetic-independent-stop-run";
  writeFileSync(join(root, "registry/budget-policy.yml"), JSON.stringify({ schema_version: 1, revision: 1, pricing: { status: "unavailable", reason: "no-versioned-source" },
    rules: [{ id: "synthetic-static-company", revision: 1, scope: { kind: "company", id: "surtec" }, period: "none", warning_percent: 80,
      limits: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: "unconfigured" }])) }] }));
  const source = readBudgetPolicy(root), draft = structuredClone(readTask(taskId)!); draft.orchestration!.max_total_tokens = 20;
  const prepared = prepareTaskBudgetAdmission(draft, { source, attribution: { company_id: "surtec", objective_ids: [], project_ids: ["alpha"], issue_id: issueId,
    role_id: stage.role_id, execution_id: taskId } });
  mutateBudgetLedger((tx) => reserveTaskBudget(tx, { admission: prepared.admission, source }), undefined, prepared.admission.created_at);
  writeTask(prepared.task); mutateBudgetLedger((tx) => commitTaskBudget(tx, { admission: prepared.admission, persisted_admission: prepared.admission }), undefined, prepared.admission.created_at);
  const budgets = new BudgetExecutionScaffold({ resolve: () => ({ source }) }), proof = budgets.prepareClaim(taskId, runId, "synthetic-independent-worker"), at = new Date().toISOString();
  updateTask(taskId, (task) => {
    task.lifecycle = "running"; task.started_at = at; task.orchestration!.attempts = 1;
    task.orchestration!.lease = { run_id: runId, worker_id: "synthetic-independent-worker", acquired_at: at, heartbeat_at: at, expires_at: new Date(Date.now() + 120_000).toISOString() };
  });
  budgets.bindClaim(proof); await budgets.observe(proof, unknown ? null : 20, 1);
  const receipt = budgets.stopReceipt(taskId, proof); expect(receipt).not.toBeNull();
  return { ...started, taskId, runId, budgets, proof, receipt: receipt!, controller: new WorkflowOrchestrator(root) };
}

describe("independent canonical budget evidence", () => {
  it.each(["invented-required", "invented-unknown"])("rejects %s retained summary values without any canonical issue write", async (change) => {
    const fixture = await independentStopFixture(change === "invented-unknown"), fault = vi.spyOn(issueStore, "mutateIssueDocument").mockImplementationOnce(() => { throw new Error("Synthetic independent issue gap"); });
    expect(() => fixture.controller.stopForIndependentBudget(fixture.taskId, fixture.receipt)).toThrow(/issue gap/); fault.mockRestore();
    const workflows = readWorkflowDocument(), binding = projectWorkflowConsumption(workflows, fixture.result.workflow.id).binding, event = workflows.events.at(-1)!;
    const data = parseIndependentWorkflowBudgetStopSummary(event.summary, binding)!;
    if (change === "invented-required") {
      // An untrusted persisted fixture may claim a larger requirement, but it
      // cannot transform a below-cap canonical charge into a run exhaustion.
      const ledger = structuredClone(readBudgetLedger()!); Object.values(ledger.charges)[0]!.observed_total_tokens = 1;
      writeFileSync(join(state, "budgets/budgets.json"), JSON.stringify(ledger));
      data.denials[0]!.proven_consumed = 1; data.denials[0]!.required = 100;
    } else data.denials[0]!.proven_consumed = 999;
    event.summary = independentWorkflowBudgetStopSummary(binding, data); assertWorkflowDocument(workflows);
    writeFileSync(join(state, "workflows/workflows.json"), JSON.stringify(workflows));
    const issue = readFileSync(join(state, "issues/issues.json")), task = readFileSync(join(state, `tasks/${fixture.taskId}.json`)), ledger = readFileSync(join(state, "budgets/budgets.json")), workflow = workflowBytes();
    expect(() => createIssueService(root).recordIndependentWorkflowBudgetExhaustion(fixture.result.workflow.id)).toThrow(/cannot be reconstructed|no longer exact/);
    expect(readFileSync(join(state, "issues/issues.json"))).toEqual(issue); expect(readFileSync(join(state, `tasks/${fixture.taskId}.json`))).toEqual(task);
    expect(readFileSync(join(state, "budgets/budgets.json"))).toEqual(ledger); expect(workflowBytes()).toBe(workflow); expect(listTasks()).toHaveLength(1);
  });
  it.each([false, true])("recovers exact static %s evidence after a workflow-to-issue persistence gap without O charges, authority or refunds", async (unknown) => {
    const fixture = await independentStopFixture(unknown), task = readFileSync(join(state, `tasks/${fixture.taskId}.json`)), ledger = readFileSync(join(state, "budgets/budgets.json"));
    const issue = readFileSync(join(state, "issues/issues.json")), fault = vi.spyOn(issueStore, "mutateIssueDocument").mockImplementationOnce(() => { throw new Error("Synthetic independent issue gap"); });
    expect(() => fixture.controller.stopForIndependentBudget(fixture.taskId, fixture.receipt)).toThrow(/issue gap/); fault.mockRestore();
    const workflow = workflowBytes(), retained = readWorkflowDocument().events.at(-1)!;
    expect(retained).toMatchObject({ type: "budget-stopped", execution_id: null });
    expect(readFileSync(join(state, "issues/issues.json"))).toEqual(issue); expect(readWorkflowDocument().accounting).toEqual({});
    expect(createIssueService(root).recordIndependentWorkflowBudgetExhaustion(fixture.result.workflow.id)).toBe(true);
    expect(readIssueDocument().events.at(-1)).toMatchObject({ type: "authorization-stale", payload: { task_id: fixture.taskId, execution_id: fixture.runId,
      independent_budget_exhaustion: { denials: expect.arrayContaining([expect.objectContaining(unknown ? { code: "budget-accounting-unavailable", dimension: "accounting", cap: null } : { code: "budget-exhausted", dimension: "total_tokens", cap: 20 })]) } } });
    expect(workflowBytes()).toBe(workflow); expect(readFileSync(join(state, `tasks/${fixture.taskId}.json`))).toEqual(task); expect(readFileSync(join(state, "budgets/budgets.json"))).toEqual(ledger);
    const final = readFileSync(join(state, "issues/issues.json")); expect(createIssueService(root).recordIndependentWorkflowBudgetExhaustion(fixture.result.workflow.id)).toBe(false);
    expect(readFileSync(join(state, "issues/issues.json"))).toEqual(final); expect(Object.values(readBudgetLedger()!.charges)).toHaveLength(1);
  });
  it("strictly parses retained evidence and rejects changed bindings, malformed tuples and caller receipt copies", async () => {
    const fixture = await independentStopFixture(); fixture.controller.stopForIndependentBudget(fixture.taskId, fixture.receipt);
    const document = readWorkflowDocument(), binding = projectWorkflowConsumption(document, fixture.result.workflow.id).binding, summary = document.events.at(-1)!.summary;
    expect(parseIndependentWorkflowBudgetStopSummary(summary, binding)).toMatchObject({ phase: "run", run_id: fixture.runId, denials: [expect.objectContaining({ required: 0 })] });
    expect(parseIndependentWorkflowBudgetStopSummary(summary, { ...binding, grant_id: "foreign-grant" })).toBeNull();
    expect(parseIndependentWorkflowBudgetStopSummary(summary.replace('"total_tokens",20,20,0', '"total_tokens",20,20,-1'), binding)).toBeNull();
    expect(parseIndependentWorkflowBudgetStopSummary(summary + " ", binding)).toBeNull();
    const before = workflowBytes(); expect(() => fixture.controller.stopForIndependentBudget(fixture.taskId, {})).toThrow(/receipt/); expect(workflowBytes()).toBe(before);
    const issue = readIssueDocument().issues[issueId]!; createIssueService(root).resolveDecision(issueId, issue.revision, "synthetic-independent-human", "Inspect exact consumption before any future admission.");
    await fixture.budgets.observe(fixture.proof, 25, 2);
    const resumed = readFileSync(join(state, "issues/issues.json")); expect(createIssueService(root).recordIndependentWorkflowBudgetExhaustion(fixture.result.workflow.id)).toBe(false);
    expect(readFileSync(join(state, "issues/issues.json"))).toEqual(resumed); expect(readIssueDocument().issues[issueId]!.status).toBe("authorized");
  });
});

describe("durable explicit workflow admission", () => {
  it.each([false, true])("separates historical P scaffold readiness from current O controller availability %s", (available) => {
    vi.stubEnv("SURTEC_BUDGET_CUTOVER", "1"); vi.stubEnv("SURTEC_BUDGET_ENABLED", "true");
    const notify = vi.fn(), { service, result } = start({ execution: { available: () => available, notify, cancelTask: vi.fn() } });
    const stage = result.stages[0]!, taskPath = join(state, `tasks/${stage.task_id}.json`), bytes = readFileSync(taskPath), workflowBefore = workflowBytes(), issueBefore = readFileSync(join(state, "issues/issues.json")), inventory = readdirSync(state, { recursive: true });
    const expected = [{ stage_id: stage.id, task_id: stage.task_id, availability: "available", readiness: { phase: "scaffold", executable: false, status: "historical", reason: "budget-admission-required", next_action: expect.any(String) } }];
    expect(result.budget_readiness).toEqual(expected); expect(service.detail(result.workflow.id).budget_readiness).toEqual(expected);
    expect(result.execution_enabled).toBe(available); expect(notify).toHaveBeenCalledExactlyOnceWith(stage.task_id);
    expect(readTask(stage.task_id!)!.envelope).not.toHaveProperty("budget_admission"); expect(readFileSync(taskPath)).toEqual(bytes);
    expect(workflowBytes()).toBe(workflowBefore); expect(readFileSync(join(state, "issues/issues.json"))).toEqual(issueBefore);
    expect(readdirSync(state, { recursive: true })).toEqual(inventory); expect(existsSync(join(state, "budgets"))).toBe(false);
  });
  it("shows valid retained synthetic BudgetAdmission v1 on context v2 as blocked P data, not O controller proof", () => {
    const { service, result } = start(), stage = result.stages[0]!, task = readTask(stage.task_id!)!;
    const source: BudgetPolicySource = { fingerprint: "a".repeat(64), policy: { schema_version: 1, revision: 1, pricing: { status: "unavailable", reason: "no-versioned-source" }, rules: [{ id: "synthetic-company", revision: 1, scope: { kind: "company", id: "surtec" }, period: "none", warning_percent: 80, limits: Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, { status: "unconfigured" }])) as BudgetLimits }] } };
    // Test-owned persisted shape only. Production O admission does not call this scaffold.
    const prepared = prepareTaskBudgetAdmission(task, { source, attribution: { company_id: "surtec", objective_ids: [], project_ids: ["alpha"], issue_id: issueId, role_id: stage.role_id, execution_id: task.envelope.id } });
    writeTask(prepared.task); const bytes = readFileSync(join(state, `tasks/${task.envelope.id}.json`)), before = workflowBytes();
    const detail = service.detail(result.workflow.id); expect(detail.budget_readiness![0]!.readiness).toMatchObject({ phase: "scaffold", executable: false, status: "bound", reason: "budget-cutover-unavailable" });
    expect(detail.execution_enabled).toBe(false); expect(readFileSync(join(state, `tasks/${task.envelope.id}.json`))).toEqual(bytes);
    expect(workflowBytes()).toBe(before); expect(existsSync(join(state, "budgets"))).toBe(false);
  });
  it.each(["missing", "malformed", "future-budget"])("reports %s retained task readiness as unavailable without changing workflow/history", (kind) => {
    const { service, result } = start(), stage = result.stages[0]!, path = join(state, `tasks/${stage.task_id}.json`);
    if (kind === "missing") rmSync(path);
    else if (kind === "malformed") writeFileSync(path, "{");
    else { const task = JSON.parse(readFileSync(path, "utf8")); task.envelope.budget_admission = { schema_version: 99 }; writeFileSync(path, JSON.stringify(task)); }
    const bytes = existsSync(path) ? readFileSync(path) : null, before = workflowBytes(), issueBefore = readFileSync(join(state, "issues/issues.json"));
    expect(service.detail(result.workflow.id).budget_readiness).toEqual([{ stage_id: stage.id, task_id: stage.task_id, availability: "unavailable", readiness: null }]);
    expect(existsSync(path) ? readFileSync(path) : null).toEqual(bytes); expect(workflowBytes()).toBe(before);
    expect(readFileSync(join(state, "issues/issues.json"))).toEqual(issueBefore); expect(existsSync(join(state, "budgets"))).toBe(false);
  });
  it.each(["budget_admission", "reservation_id", "reservation", "intent_id", "budget_cutover", "cutover", "execution_enabled"])("rejects injected %s before workflow preview/revalidation/writes", (key) => {
    const context = createWorkflowContextService(root), previewCall = vi.spyOn(context, "preview"), revalidate = vi.spyOn(context, "revalidatePreview"), service = createWorkflowService(root, { context });
    const input = request(), bytes = readFileSync(join(state, "issues/issues.json")), inventory = readdirSync(state, { recursive: true });
    expect(() => service.preview({ ...input, [key]: {} })).toThrow(/request fields/);
    expect(() => service.start({ request: { ...input, [key]: {} }, preview_fingerprint: "a".repeat(64), confirm: true, approval_id: "synthetic-human" })).toThrow(/request fields/);
    expect(() => service.start({ request: input, preview_fingerprint: "a".repeat(64), confirm: true, approval_id: "synthetic-human", [key]: {} })).toThrow(/request fields/);
    expect(previewCall).not.toHaveBeenCalled(); expect(revalidate).not.toHaveBeenCalled(); expect(listTasks()).toEqual([]);
    expect(readFileSync(join(state, "issues/issues.json"))).toEqual(bytes); expect(readdirSync(state, { recursive: true })).toEqual(inventory);
  });
  it("rejects hooked/hidden root and preview fields without invoking accessors", () => {
    const context = createWorkflowContextService(root), previewCall = vi.spyOn(context, "preview"), revalidate = vi.spyOn(context, "revalidatePreview"), service = createWorkflowService(root, { context }), getter = vi.fn();
    const input = request(), body = { request: input, preview_fingerprint: "a".repeat(64), confirm: true, approval_id: "synthetic-human" };
    expect(() => service.preview(Object.defineProperty({ ...input }, "budget", { enumerable: true, get: getter }))).toThrow(/request fields/);
    expect(() => service.start(Object.defineProperty({ ...body }, "request", { enumerable: true, get: getter }))).toThrow(/request fields/);
    expect(() => service.start(Object.defineProperty({ ...body }, "budget_admission", { value: {} }))).toThrow(/request fields/);
    expect(() => service.preview(new Proxy(input, { getPrototypeOf: getter }))).toThrow(/request fields/);
    expect(getter).not.toHaveBeenCalled(); expect(previewCall).not.toHaveBeenCalled(); expect(revalidate).not.toHaveBeenCalled(); expect(existsSync(join(state, "workflows"))).toBe(false);
  });
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
