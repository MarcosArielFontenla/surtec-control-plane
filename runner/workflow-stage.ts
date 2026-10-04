import { isDeepStrictEqual } from "node:util";
import { createWorkflowContextService, type WorkflowContextService } from "../dashboard/src/server/workflow-context-service";
import { readWorkflowDocument } from "../lib/state/workflows";
import { readIssueDocument } from "../lib/state/issues";
import { readTask } from "../lib/state/store";
import { validateTaskRecord } from "../lib/state/validation";
import type { ContextAdmissionV2 } from "../lib/context/types";
import { contextHash } from "../lib/context/assemble";
import { ContextContractError } from "../lib/context/validation";
import { PolicyService } from "../lib/policy/service";
import { workflowRoleOutputSchema, roleOutputResult } from "../lib/workflows/role-output";
import { AGENT_REPORT_SCHEMA } from "./agent-report";
import { inspectCandidateTree, managedWorktreeIdentity, type CandidateTreeView } from "./worktree";
import { workflowThreadContract } from "./agent-prompt";

export const WORKFLOW_CONTROLLER_REQUIRED = "Workflow-stage execution requires the trusted workflow controller and current authority guards; standalone execution is disabled";

/** Intermediate T007 guard: no caller flag or context-shaped object enables v2. */
export function rejectStandaloneWorkflowStage(): never { throw new ContextContractError(WORKFLOW_CONTROLLER_REQUIRED); }

export interface WorkflowStageDependencies {
  context?: Pick<WorkflowContextService, "revalidateTask">;
  now?: () => number;
}

/** Current durable authority plus the existing task lease, before any effects. */
export function prepareWorkflowStage(taskId: string, runId: string, repoRoot: string, dependencies: WorkflowStageDependencies = {}) {
  const requireCurrent = (ok: boolean, message: string) => { if (!ok) throw new ContextContractError(message); };
  const task = readTask(taskId);
  requireCurrent(!!task && validateTaskRecord(task) && task.envelope.context_admission?.schema_version === 2, "Workflow execution requires an actual valid v2 task");
  const current = task!, admission = current.envelope.context_admission as ContextAdmissionV2, lease = current.orchestration?.lease;
  requireCurrent(current.lifecycle === "running" && current.outcome === null && !!lease && lease.run_id === runId && !current.orchestration?.cancel_requested_at
    && Date.parse(lease.expires_at) > (dependencies.now ?? Date.now)(), "Workflow attempt lease is not current");
  const document = readWorkflowDocument(), workflow = document.workflows[admission.workflow_id], stage = document.stages[admission.stage_id];
  requireCurrent(!!workflow && !!stage && workflow.status === "running" && workflow.stop_requested_at === null && workflow.recovery_state === "none"
    && workflow.pending_decision_id === null && workflow.current_stage_id === stage.id && workflow.current_grant_id === admission.grant_id
    && workflow.authority_revision === admission.authority_revision && workflow.counters.accounting_complete, "Workflow current authority is stopped, incomplete or changed");
  requireCurrent(stage!.status === "running" && stage!.execution_id === runId && stage!.task_id === taskId && stage!.generation === admission.stage_generation
    && stage!.context_fingerprint === admission.manifest_fingerprint, "Workflow stage has no fenced controller claim");
  const intent = Object.values(document.admission_intents).find((entry) => entry.stage_id === stage!.id && entry.task_id === taskId);
  const charge = Object.values(document.accounting).find((entry) => entry.stage_id === stage!.id && entry.task_id === taskId && entry.execution_id === runId);
  requireCurrent(intent?.status === "committed" && intent.context_fingerprint === admission.manifest_fingerprint && intent.expected_issue_revision === admission.issue_revision
    && charge?.attempt_charged === true && charge.attempt === current.orchestration!.attempts && !charge.usage_complete, "Workflow admission or attempt accounting is uncommitted");
  const issueDocument = readIssueDocument(), issue = issueDocument.issues[admission.issue_id], grant = document.grants[admission.grant_id]!;
  requireCurrent(!!issue && issue.project_id === current.envelope.project && issue.scope_revision === admission.scope_revision && issue.revision === admission.issue_revision
    && issue.task_ids.includes(taskId) && isDeepStrictEqual(issue.authorized_scope, grant.authorized_scope)
    && contextHash(JSON.stringify(issue.authorized_scope)) === admission.scope_fingerprint, "Workflow issue authority or scope changed");
  const context = (dependencies.context ?? createWorkflowContextService(repoRoot)).revalidateTask(current);
  requireCurrent(isDeepStrictEqual(context.binding, admission), "Workflow reassembled admission differs");
  const policy = new PolicyService(repoRoot), allowed = policy.authorizeTask(current.envelope);
  policy.authorizeRole({ project: current.envelope.project, agent: current.envelope.agent, roleId: stage!.role_id,
    taskKind: current.envelope.task_type, sandbox: current.envelope.sandbox, selfVerify: current.envelope.self_verify === true });
  let candidateView: CandidateTreeView | null = null;
  let candidateOwner: ReturnType<typeof readTask> = null;
  if (stage!.kind === "review" || stage!.kind === "qa") {
    requireCurrent(!!stage!.candidate && isDeepStrictEqual(stage!.candidate, admission.candidate) && isDeepStrictEqual(workflow!.candidate, admission.candidate), "Workflow exact candidate binding differs");
    const candidate = issueDocument.candidates[admission.candidate!.candidate_id], owner = readTask(admission.candidate!.task_id);
    requireCurrent(!!candidate && candidate.invalidated_at === null && candidate.id === issue!.candidate_ids.at(-1)
      && candidate.execution_id === admission.candidate!.execution_id && !!owner, "Workflow candidate is missing, superseded or invalidated");
    try { candidateView = inspectCandidateTree(allowed.project.repo_path!, owner!, admission.candidate!, repoRoot); }
    catch { throw new ContextContractError("Workflow candidate tree is missing, changed or cannot be safely inspected"); }
    candidateOwner = owner;
  }
  const writer = stage!.kind === "implementation" || stage!.kind === "correction";
  const outputSchema = writer ? AGENT_REPORT_SCHEMA as Record<string, unknown> : workflowRoleOutputSchema(stage!.kind);
  const cwd = writer ? managedWorktreeIdentity(allowed.project.repo_path!, current.envelope.id, current.envelope.agent).worktreePath
    : candidateView?.worktreePath ?? allowed.project.repo_path!;
  const verifyCommands = writer && context.preview.manifest.tools.includes("verify-configured") ? context.testingPlan.runners.map((entry) => entry.command) : [];
  const mode = writer ? current.envelope.self_verify && verifyCommands.length ? "workspace-write-verify" : "workspace-write" : "read-only";
  const thread = workflowThreadContract(current.envelope, cwd, mode, verifyCommands, outputSchema);
  // Cross-store reads/Git cannot be atomic. Reject any observed drift before
  // handing back the preflight; callers must repeat this fence before effects.
  requireCurrent(isDeepStrictEqual(readTask(taskId), current) && isDeepStrictEqual(readWorkflowDocument(), document)
    && isDeepStrictEqual(readIssueDocument(), issueDocument) && (!candidateOwner || isDeepStrictEqual(readTask(candidateOwner.envelope.id), candidateOwner)), "Workflow authority changed during preflight");
  return { task: current, admission, workflow: workflow!, stage: stage!, grant, issue: issue!, context, candidateView, cwd, mode, verifyCommands, outputSchema, thread };
}

export function validateWorkflowStageOutput(prepared: ReturnType<typeof prepareWorkflowStage>, value: unknown, logsPath: string, repoRoot: string,
  dependencies: WorkflowStageDependencies = {}) {
  const live = prepareWorkflowStage(prepared.task.envelope.id, prepared.stage.execution_id!, repoRoot, dependencies);
  if (prepared.candidateView && !isDeepStrictEqual(prepared.candidateView, live.candidateView)) throw new ContextContractError("Candidate tree changed during read-only review");
  if (!isDeepStrictEqual(prepared.admission, live.admission) || prepared.thread.fingerprint !== live.thread.fingerprint) throw new ContextContractError("Workflow stage contract changed during execution");
  if (live.stage.kind === "implementation" || live.stage.kind === "correction") throw new ContextContractError("Engineer output retains the generic result validation path");
  const issues = readIssueDocument();
  return roleOutputResult(live.task.envelope, value, { kind: live.stage.kind, issue: live.issue, evidence: issues.evidence, candidate: live.admission.candidate }, logsPath);
}
