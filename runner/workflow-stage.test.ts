import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { execFileSync } from "node:child_process";
import { managedGitArgs } from "../lib/security/managed-git.mjs";
import { localGitEnvironment } from "../lib/security/environment";
import type { AgentRoleRegistry } from "../lib/context/types";
import { createIssueService } from "../dashboard/src/server/issue-service";
import { createWorkflowService } from "../dashboard/src/server/workflow-service";
import { createWorkflowContextService } from "../dashboard/src/server/workflow-context-service";
import { readTask, updateTask } from "../lib/state/store";
import { readIssueDocument, mutateIssueDocument } from "../lib/state/issues";
import { readWorkflowDocument, mutateWorkflowDocument } from "../lib/state/workflows";
import { prepareWorkflowStage, rejectStandaloneWorkflowStage, validateWorkflowStageOutput } from "./workflow-stage";
import { assertAgentResult } from "./result";
import { createContextService } from "../dashboard/src/server/context-service";
import { createTestingEvidence, sealTestingEvidence } from "../lib/context/testing-evidence";
import { captureVerification } from "./verify";
import { createWorktree, commitAndDiff } from "./worktree";

let root: string, taskId: string, workflowId: string, stageId: string, issueId: string;
const runId = "synthetic-analysis-run";
const agents = { "portfolio-analyst": "product-manager", planner: "tech-lead", "software-engineer": "backend-engineer", reviewer: "reality-checker", "qa-evaluator": "qa-reviewer", "operations-observer": "devops-engineer" };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-workflow-stage-"));
  mkdirSync(join(root, "projects/alpha/.git"), { recursive: true }); mkdirSync(join(root, "registry"));
  for (const name of ["agents.yml", "agent-roles.yml", "context-policy.yml", "workflow-policy.yml"]) cpSync(`registry/${name}`, join(root, "registry", name));
  const roles = parse(readFileSync("registry/agent-roles.yml", "utf8")) as AgentRoleRegistry;
  for (const path of new Set(roles.roles.flatMap((role) => role.required_evaluation_ids))) { mkdirSync(join(root, ...path.split("/").slice(0, -1)), { recursive: true }); cpSync(path, join(root, path)); }
  writeFileSync(join(root, "registry/projects.yml"), `projects:\n  alpha:\n    allowed_agents: [${Object.values(agents).join(", ")}]\n    sandbox: { default: workspace-write }\n    verify: ['node verify.mjs']\n`);
  writeFileSync(join(root, "projects/alpha/AGENTS.md"), "Synthetic project rule; no publication.");
  vi.stubEnv("SURTEC_STATE_DIR", join(root, "state")); vi.stubEnv("SURTEC_PROJECTS_ROOT", join(root, "projects"));
  const issues = createIssueService(root, { projectIds: () => ["alpha"] });
  const proposed = issues.create({ project_id: "alpha", title: "Analyze synthetic work", expected_outcome: "Observe behavior", acceptance_criteria: ["Observed behavior"],
    authorized_scope: { expected_outcome: "Observe behavior", acceptance_criteria: ["Observed behavior"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["implementation"], explicit_exclusions: [] } });
  issueId = proposed.id;
  const service = createWorkflowService(root), request = { template_id: "analysis", template_version: 1, project_id: "alpha", issue_id: issueId,
    expected_revision: proposed.revision, selected_agents: { "portfolio-analyst": "product-manager" }, client_context_categories: {}, correction_enabled: false };
  const preview = service.preview(request); expect(preview.allowed).toBe(true);
  const started = service.start({ request, preview_fingerprint: preview.fingerprint, approval_id: "synthetic-root", confirm: true });
  workflowId = started.workflow.id; stageId = started.stages[0]!.id; taskId = started.stages[0]!.task_id!;
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
function claim() {
  const at = new Date().toISOString();
  updateTask(taskId, (task) => { task.lifecycle = "running"; task.started_at = at; task.orchestration!.attempts = 1;
    task.orchestration!.lease = { run_id: runId, worker_id: "fixture", acquired_at: at, heartbeat_at: at, expires_at: new Date(Date.now() + 60_000).toISOString() }; });
  mutateWorkflowDocument((document) => {
    const workflow = document.workflows[workflowId]!, stage = document.stages[stageId]!;
    workflow.revision++; workflow.updated_at = at; workflow.counters.attempts++;
    stage.status = "running"; stage.execution_id = runId; stage.updated_at = at;
    document.accounting[runId] = { schema_version: 1, id: runId, workflow_id: workflowId, stage_id: stageId, task_id: taskId, execution_id: runId,
      attempt: 1, attempt_charged: true, active_runtime_ms: 0, observed_tokens: 0, usage_complete: false, captured_at: at };
  });
}
const output = { schema_version: 1, kind: "analysis", status: "completed", summary: "Safe bounded observation", evidence_ids: [], unresolved_questions: [], risks: [],
  recommendations: ["Human decides further work"], recommended_next_action: "Review the observation", requested_decision: null };

describe("workflow stage current authority preflight", () => {
  it("assembles actual reserved authority only after an exact durably charged controller claim", () => {
    expect(() => prepareWorkflowStage(taskId, runId, root)).toThrow(/lease/);
    claim(); const beforeTask = readTask(taskId), beforeWorkflow = readWorkflowDocument(), beforeIssue = readIssueDocument();
    const prepared = prepareWorkflowStage(taskId, runId, root);
    expect(prepared).toMatchObject({ mode: "read-only", cwd: join(root, "projects/alpha"), verifyCommands: [], candidateView: null, thread: { threadId: undefined } });
    expect(prepared.outputSchema.type).toBe("object"); expect(prepared.context.binding).toEqual(beforeTask!.envelope.context_admission);
    expect(readTask(taskId)).toEqual(beforeTask); expect(readWorkflowDocument()).toEqual(beforeWorkflow); expect(readIssueDocument()).toEqual(beforeIssue);
    const normalized = validateWorkflowStageOutput(prepared, output, "reports/fixture.jsonl", root);
    expect(normalized.output).toEqual(output); expect(assertAgentResult(normalized.result).status).toBe("completed");
    expect(() => rejectStandaloneWorkflowStage()).toThrow(/standalone execution is disabled/);
  });
  it("does not confuse a claimed task lease with workflow controller authority", () => {
    updateTask(taskId, (task) => { const at = new Date().toISOString(); task.lifecycle = "running"; task.orchestration!.attempts = 1;
      task.orchestration!.lease = { run_id: runId, worker_id: "fixture", acquired_at: at, heartbeat_at: at, expires_at: new Date(Date.now() + 60_000).toISOString() }; });
    const context = vi.fn();
    expect(() => prepareWorkflowStage(taskId, runId, root, { context: { revalidateTask: context } })).toThrow(/controller claim/);
    expect(context).not.toHaveBeenCalled();
  });
  it.each(["wrong-run", "expired", "cancelled", "stopped", "unknown-usage", "issue-revision", "source", "thread"])("fails closed on %s before output acceptance", (mutation) => {
    claim(); const prepared = prepareWorkflowStage(taskId, runId, root);
    if (mutation === "wrong-run") expect(() => prepareWorkflowStage(taskId, "other-run", root)).toThrow(/lease/);
    if (mutation === "expired") updateTask(taskId, (task) => { task.orchestration!.lease!.expires_at = "2026-01-01T00:00:00Z"; });
    if (mutation === "cancelled") updateTask(taskId, (task) => { task.orchestration!.cancel_requested_at = new Date().toISOString(); });
    if (mutation === "stopped" || mutation === "unknown-usage") mutateWorkflowDocument((document) => {
      const workflow = document.workflows[workflowId]!; workflow.revision++; workflow.updated_at = new Date().toISOString();
      if (mutation === "stopped") workflow.stop_requested_at = workflow.updated_at;
      else { workflow.counters.accounting_complete = false; workflow.status = "needs-decision"; workflow.recovery_state = "awaiting-human";
        workflow.blocked_reason = "Interrupted usage is unknown"; workflow.next_action = "Human accounting decision"; }
    });
    if (mutation === "issue-revision") mutateIssueDocument((document) => { document.issues[issueId]!.revision++; });
    if (mutation === "source") writeFileSync(join(root, "projects/alpha/AGENTS.md"), "Changed trusted project source.");
    if (mutation === "thread") updateTask(taskId, (task) => { task.envelope.metadata.run = { thread_id: "engineer-predecessor-thread", context_fingerprint: prepared.thread.fingerprint }; });
    if (mutation !== "wrong-run") expect(() => validateWorkflowStageOutput(prepared, output, "fixture", root)).toThrow();
  });
  it("detects concurrent authority drift during real context assembly without accepting output", () => {
    claim(); const context = createWorkflowContextService(root);
    const revalidateTask = vi.fn((task: Parameters<typeof context.revalidateTask>[0]) => {
      const admitted = context.revalidateTask(task);
      updateTask(taskId, (current) => { current.orchestration!.cancel_requested_at = new Date().toISOString(); });
      return admitted;
    });
    expect(() => prepareWorkflowStage(taskId, runId, root, { context: { revalidateTask } })).toThrow(/during preflight/);
  });
  it("fails closed on corrupt workflow bytes and never replaces them", () => {
    claim(); const path = join(root, "state/workflows/workflows.json"); writeFileSync(path, "{corrupt");
    expect(() => prepareWorkflowStage(taskId, runId, root)).toThrow(); expect(readFileSync(path, "utf8")).toBe("{corrupt");
  });
  it.each(["planning", "operations", "planner-analysis", "implementation"] as const)("builds the exact first %s role contract without invoking a model or creating a tree", (kind) => {
    const issues = createIssueService(root, { projectIds: () => ["alpha"] });
    const issue = issues.create({ project_id: "alpha", title: "Scoped role fixture", expected_outcome: "Expected behavior", acceptance_criteria: ["Expected behavior"], assigned_role_id: "backend-engineer",
      authorized_scope: { expected_outcome: "Expected behavior", acceptance_criteria: ["Expected behavior"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["implementation"], explicit_exclusions: [] } });
    issueId = issue.id;
    if (kind === "implementation" || kind === "planning") issues.authorize(issueId, issue.revision, "synthetic-scope");
    const roles = kind === "planning" ? ["planner", "software-engineer", "reviewer"] : kind === "operations" ? ["operations-observer"] : kind === "implementation" ? ["software-engineer", "reviewer"] : ["planner"];
    const request = { template_id: kind === "planning" ? "implementation" : kind === "operations" ? "operations-investigation" : kind === "implementation" ? "trivial-change" : "analysis",
      template_version: 1, project_id: "alpha", issue_id: issueId, expected_revision: readIssueDocument().issues[issueId]!.revision,
      selected_agents: Object.fromEntries(roles.map((role) => [role, agents[role as keyof typeof agents]])), ...(kind === "planner-analysis" ? { analysis_role: "planner" } : {}) };
    const service = createWorkflowService(root), preview = service.preview(request); expect(preview.allowed).toBe(true);
    const started = service.start({ request, preview_fingerprint: preview.fingerprint, approval_id: "synthetic-role-root", confirm: true });
    workflowId = started.workflow.id; stageId = started.stages[0]!.id; taskId = started.stages[0]!.task_id!; claim();
    const prepared = prepareWorkflowStage(taskId, runId, root);
    expect(prepared.stage.kind).toBe(kind === "planner-analysis" ? "analysis" : kind);
    expect(prepared.mode).toBe(kind === "implementation" ? "workspace-write-verify" : "read-only");
    expect(prepared.thread.threadId).toBeUndefined();
    expect(prepared.verifyCommands).toEqual(kind === "implementation" ? ["node verify.mjs"] : []);
    expect(prepared.outputSchema.properties).toHaveProperty(kind === "implementation" ? "commands_run" : "kind");
  });
  it("reviews an actual owned candidate tree and rejects mutation after the preflight", async () => {
    const repo = join(root, "projects/alpha");
    const git = (...args: string[]) => execFileSync("git", managedGitArgs(["-C", repo, ...args], root), { env: localGitEnvironment(), windowsHide: true, stdio: "pipe" }).toString();
    git("init", "-b", "main"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Synthetic fixture");
    mkdirSync(join(repo, "src")); writeFileSync(join(repo, "src/value.txt"), "base\n"); writeFileSync(join(repo, "verify.mjs"), "process.exit(0)\n");
    git("add", "-A"); git("commit", "-m", "synthetic base");
    const context = createContextService(root), issues = createIssueService(root, { context });
    const issue = issues.create({ project_id: "alpha", title: "Review candidate fixture", expected_outcome: "Expected behavior", acceptance_criteria: ["Expected behavior"], assigned_role_id: "backend-engineer",
      authorized_scope: { expected_outcome: "Expected behavior", acceptance_criteria: ["Expected behavior"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["implementation"], explicit_exclusions: [] } });
    issueId = issue.id; issues.authorize(issueId, issue.revision, "synthetic-scope");
    const authorized = issues.get(issueId).issue, request = { kind: "issue" as const, project: "alpha", issue_id: issueId, expected_revision: authorized.revision, role_id: "software-engineer", agent: "backend-engineer" };
    const preview = context.preview(request), dispatched = issues.dispatch(issueId, authorized.revision, "backend-engineer", { role_id: "software-engineer", preview_fingerprint: preview.fingerprint });
    const engineerTaskId = dispatched.taskId, at = new Date().toISOString(), engineerRun = "synthetic-engineer-run";
    updateTask(engineerTaskId, (task) => { task.lifecycle = "running"; task.orchestration!.attempts = 1; task.orchestration!.lease = { run_id: engineerRun, worker_id: "fixture", acquired_at: at, heartbeat_at: at, expires_at: new Date(Date.now() + 60_000).toISOString() }; });
    const tree = createWorktree(repo, engineerTaskId, "backend-engineer"); writeFileSync(join(tree.worktreePath, "src/value.txt"), "candidate\n");
    const committed = commitAndDiff(tree.worktreePath, "synthetic candidate"), candidate = issues.recordCandidate({ issueId, taskId: engineerTaskId, executionId: engineerRun, repositoryId: "alpha", scopeRevision: 1,
      baseRevision: committed.baseRevision!, candidateRevision: committed.candidateRevision!, changedPaths: committed.filesChanged });
    const plan = { mode: "functional" as const, runners: [{ stage: "functional" as const, command: "node verify.mjs" }] };
    const receipt = createTestingEvidence(readTask(engineerTaskId)!, engineerRun, plan);
    receipt.candidate = { id: candidate.id, base_revision: candidate.base_revision, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint };
    receipt.implementation = { started_at: at, finished_at: at, thread_id: "engineer-thread", turn_id: "engineer-turn" };
    const captured = await captureVerification(tree.worktreePath, plan.runners, { controlPlaneRoot: root, expectedRevision: candidate.candidate_revision,
      signal: new AbortController().signal, deadline: Date.now() + 10000, ownsAttempt: () => readTask(engineerTaskId)?.orchestration?.lease?.run_id === engineerRun,
      authorizeCommand: (command) => command === "node verify.mjs" });
    expect(captured.report.status).toBe("passed"); receipt.observations = captured.observations;
    const { fingerprint: _fingerprint, ...unsigned } = receipt;
    updateTask(engineerTaskId, (task) => { task.testing_evidence = sealTestingEvidence(unsigned); });
    issues.recordVerification({ issueId, taskId: engineerTaskId, executionId: engineerRun, candidateId: candidate.id, status: "passed", label: "Captured real fixture check", reference: "1 passing configured command" });
    mkdirSync(join(root, "reports")); const diffPath = `reports/${engineerTaskId}-${engineerRun}.diff`; writeFileSync(join(root, diffPath), committed.patch);
    updateTask(engineerTaskId, (task) => { task.lifecycle = "finished"; task.outcome = "completed"; task.finished_at = new Date().toISOString(); task.orchestration!.lease = null;
      task.envelope.metadata.run = { branch: tree.branch, worktree_path: tree.worktreePath, committed: true, diff_path: diffPath, diff_truncated: false }; });
    const service = createWorkflowService(root), qualityRequest = { template_id: "quality-review", template_version: 1, project_id: "alpha", issue_id: issueId, expected_revision: issues.get(issueId).issue.revision,
      selected_agents: { reviewer: agents.reviewer, "qa-evaluator": agents["qa-evaluator"] }, candidate_id: candidate.id };
    const qualityPreview = service.preview(qualityRequest); expect(qualityPreview.allowed).toBe(true);
    const started = service.start({ request: qualityRequest, preview_fingerprint: qualityPreview.fingerprint, approval_id: "synthetic-quality-root", confirm: true });
    workflowId = started.workflow.id; stageId = started.stages[0]!.id; taskId = started.stages[0]!.task_id!; claim();
    const prepared = prepareWorkflowStage(taskId, runId, root);
    expect(prepared.cwd).toBe(tree.worktreePath); expect(prepared.mode).toBe("read-only"); expect(prepared.verifyCommands).toEqual([]); expect(prepared.thread.threadId).toBeUndefined();
    const review = { ...output, kind: "review", verdict: "approve", findings: [] }; delete (review as any).recommendations;
    expect(validateWorkflowStageOutput(prepared, review, "fixture", root).result.status).toBe("completed");
    writeFileSync(join(tree.worktreePath, "src/value.txt"), "mutated during readonly review\n");
    expect(() => validateWorkflowStageOutput(prepared, review, "fixture", root)).toThrow(/candidate tree.*changed/);
    expect(issues.get(issueId).issue.status).toBe("ready-for-review"); expect(git("rev-parse", "HEAD").trim()).toBe(candidate.base_revision);
  }, 15000);
});
