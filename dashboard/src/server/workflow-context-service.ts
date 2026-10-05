import { isDeepStrictEqual } from "node:util";
import { PolicyService } from "../../../lib/policy/service";
import { contextHash, contextSourceFingerprint, redactContextText, type ContextTextSource } from "../../../lib/context/assemble";
import { assertTestingEvidenceBinding, evidenceHash, testingEvidenceStatus, testingRequirement } from "../../../lib/context/testing-evidence";
import type { ContextAdmissionV2, ContextManifest, ExecutionBudget } from "../../../lib/context/types";
import { readContained } from "../../../lib/harness/source";
import { readIssueDocument } from "../../../lib/state/issues";
import { readTask } from "../../../lib/state/store";
import { readWorkflowDocument } from "../../../lib/state/workflows";
import { validateIssueDocument, validateTaskRecord } from "../../../lib/state/validation";
import type { TaskRecord } from "../../../lib/state/types";
import type { IssueDocument, WorkIssue } from "../../../lib/issues/types";
import { isSafeIdentifier } from "../../../lib/security/identifiers";
import { readWorkflowPolicy, resolveWorkflowBudget, resolveWorkflowCorrection, resolveWorkflowStageBudget } from "../../../lib/workflows/policy";
import { resolveWorkflowReviewPolicy } from "../../../lib/workflows/review-policy";
import { resolveWorkflowAssignments, resolveWorkflowTemplate, type TemplateSelection } from "../../../lib/workflows/templates";
import { assertWorkflowDocument, assertWorkflowPolicy } from "../../../lib/workflows/validation";
import { WORKFLOW_ROLES, WORKFLOW_TEMPLATES, type WorkflowBudget, type WorkflowCandidateBinding, type WorkflowDocument, type WorkflowPolicy, type WorkflowRoleId, type WorkflowStageKind } from "../../../lib/workflows/types";
import { createContextService, ContextPreviewError, type AdmittedContext, type ContextServiceDependencies } from "./context-service";
import { pathsOutsideScope } from "./issue-service";

const CATEGORIES = ["client-identity", "project-outcome", "active-commitments", "service-context", "confidential-notes"] as const;
const ROLE_KIND: Record<WorkflowRoleId, WorkflowStageKind> = { "portfolio-analyst": "analysis", planner: "planning", "software-engineer": "implementation", reviewer: "review", "qa-evaluator": "qa", "operations-observer": "operations" };
const hash = (value: unknown): string => contextHash(JSON.stringify(value));
const requireCurrent = (ok: boolean, message: string): void => { if (!ok) throw new ContextPreviewError(message); };
function object(value: unknown, keys: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) throw new ContextPreviewError("Invalid workflow context request", 400);
  return value as Record<string, unknown>;
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !isSafeIdentifier(value)) throw new ContextPreviewError("Invalid workflow context identity", 400);
}
export interface WorkflowPreviewRequest {
  template_id: typeof WORKFLOW_TEMPLATES[number];
  template_version: 1;
  project_id: string;
  issue_id: string;
  expected_revision: number;
  selected_agents: Partial<Record<WorkflowRoleId, string>>;
  client_context_categories: Partial<Record<WorkflowRoleId, string[]>>;
  correction_enabled: boolean;
  analysis_role?: "portfolio-analyst" | "planner";
  budget?: WorkflowBudget;
  candidate_id?: string;
}
function parseRequest(value: unknown): WorkflowPreviewRequest {
  const input = object(value, ["template_id", "template_version", "project_id", "issue_id", "expected_revision", "selected_agents", "client_context_categories", "correction_enabled", "analysis_role", "budget", "candidate_id"], ["template_id", "template_version", "project_id", "issue_id", "expected_revision", "selected_agents"]);
  identifier(input.project_id); identifier(input.issue_id);
  if (!WORKFLOW_TEMPLATES.includes(input.template_id as WorkflowPreviewRequest["template_id"]) || input.template_version !== 1
    || !Number.isSafeInteger(input.expected_revision) || (input.expected_revision as number) < 1
    || Object.hasOwn(input, "correction_enabled") && typeof input.correction_enabled !== "boolean") throw new ContextPreviewError("Invalid workflow template, revision or correction selection", 400);
  const agents = object(input.selected_agents, WORKFLOW_ROLES, []);
  const consent = object(Object.hasOwn(input, "client_context_categories") ? input.client_context_categories : {}, Object.keys(agents), []);
  const selected: WorkflowPreviewRequest["selected_agents"] = {}, categories: WorkflowPreviewRequest["client_context_categories"] = {};
  for (const role of [...Object.keys(agents)].sort() as WorkflowRoleId[]) {
    identifier(agents[role]); selected[role] = agents[role] as string;
    const values = consent[role] ?? [];
    if (!Array.isArray(values) || values.length > 5 || values.some((item) => !CATEGORIES.includes(item)) || new Set(values).size !== values.length) throw new ContextPreviewError("Invalid per-role client consent", 400);
    categories[role] = [...values].sort();
  }
  if (Object.hasOwn(input, "analysis_role") && (input.template_id !== "analysis" || !["planner", "portfolio-analyst"].includes(String(input.analysis_role)))) throw new ContextPreviewError("Invalid analysis role", 400);
  if (Object.hasOwn(input, "candidate_id")) { identifier(input.candidate_id); if (input.template_id !== "quality-review") throw new ContextPreviewError("Only quality-review selects an existing candidate", 400); }
  if (input.template_id === "quality-review" && !input.candidate_id) throw new ContextPreviewError("Quality-review requires an exact current candidate", 400);
  if (Object.hasOwn(input, "budget")) object(input.budget, ["max_tasks", "max_attempts", "max_runtime_ms", "max_total_tokens"], ["max_tasks", "max_attempts", "max_runtime_ms", "max_total_tokens"]);
  return { template_id: input.template_id as WorkflowPreviewRequest["template_id"], template_version: 1, project_id: input.project_id, issue_id: input.issue_id,
    expected_revision: input.expected_revision as number, selected_agents: selected, client_context_categories: categories, correction_enabled: input.correction_enabled === true,
    ...(input.analysis_role ? { analysis_role: input.analysis_role as "planner" | "portfolio-analyst" } : {}), ...(input.budget ? { budget: structuredClone(input.budget) as WorkflowBudget } : {}), ...(input.candidate_id ? { candidate_id: input.candidate_id as string } : {}) };
}
function publicManifest(manifest: ContextManifest): ContextManifest {
  return { ...manifest, testing: { ...manifest.testing, commands: manifest.testing.commands.map(redactContextText), reasons: manifest.testing.reasons.map(redactContextText) },
    routing: { ...manifest.routing, reasons: manifest.routing.reasons.map(redactContextText), delegation: { ...manifest.routing.delegation, reasons: manifest.routing.delegation.reasons.map(redactContextText) } } };
}
export interface WorkflowContextDependencies extends ContextServiceDependencies {
  readWorkflows?: () => WorkflowDocument;
  readWorkflowPolicy?: () => WorkflowPolicy;
  readTask?: (id: string) => TaskRecord | null;
}
export function createWorkflowContextService(repoRoot: string, dependencies: WorkflowContextDependencies = {}) {
  const policy = dependencies.policy ?? new PolicyService(repoRoot);
  const readIssues = dependencies.readIssues ?? readIssueDocument;
  const readWorkflows = dependencies.readWorkflows ?? readWorkflowDocument;
  const taskReader = dependencies.readTask ?? readTask;
  const clock = () => (dependencies.clock?.() ?? new Date()).getTime();
  const issued = new Map<string, number>();
  function snapshots() {
    const issues = structuredClone(readIssues()), workflows = structuredClone(readWorkflows());
    requireCurrent(validateIssueDocument(issues), "Issue state is invalid; no preview or repair was performed"); assertWorkflowDocument(workflows);
    requireCurrent([issues.issues, issues.candidates, issues.evidence].every((records) => Object.entries(records).every(([id, entry]) => id === entry.id)), "Issue state contains inconsistent record identities");
    return { issues, workflows };
  }
  // Captured reference only: no Git, worktree, verification, provider or model
  // effects here. T007 must separately prove the actual managed candidate tree.
  function candidateReference(document: IssueDocument, issue: WorkIssue, id: string): WorkflowCandidateBinding {
    const candidate = Object.hasOwn(document.candidates, id) ? document.candidates[id] : undefined;
    requireCurrent(!!candidate && issue.candidate_ids.at(-1) === id && candidate.issue_id === issue.id && candidate.repository_id === issue.project_id
      && candidate.scope_revision === issue.scope_revision && candidate.invalidated_at === null, "Candidate reference is missing, replaced or stale");
    identifier(candidate!.task_id); identifier(candidate!.execution_id);
    requireCurrent(candidate!.diff_fingerprint === contextHash(`${candidate!.repository_id}\0${candidate!.base_revision}\0${candidate!.candidate_revision}\0${candidate!.changed_paths.join("\0")}`), "Candidate diff identity fingerprint differs");
    requireCurrent(candidate!.changed_paths.every((path) => path.length <= 300 && !/[\\:\x00-\x1f\x7f]/.test(path) && !path.startsWith("/") && path.split("/").every((part) => !!part && part !== "." && part !== "..") && redactContextText(path) === path)
      && pathsOutsideScope(candidate!.changed_paths, issue.authorized_scope).length === 0, "Candidate paths are unsafe or outside the current authorized scope");
    const task = taskReader(candidate!.task_id);
    requireCurrent(!!task && validateTaskRecord(task) && task.lifecycle === "finished" && task.outcome === "completed" && !task.orchestration?.lease && !task.orchestration?.cancel_requested_at
      && issue.task_ids.includes(task.envelope.id), "Candidate task is not terminal, owned and inactive");
    const receipt = task!.testing_evidence;
    requireCurrent(!!receipt, "Candidate lacks a captured testing receipt; legacy evidence is not backfilled");
    // The v2 receipt guard remains disabled in T004. Do not fabricate a receipt
    // or reinterpret legacy metadata to get around that integration boundary.
    assertTestingEvidenceBinding(receipt!, task!, candidate!);
    requireCurrent(receipt!.scope_fingerprint === hash(issue.authorized_scope), "Candidate testing scope changed");
    requireCurrent(testingEvidenceStatus(receipt!) === "passed", "Candidate verification is failed or incomplete");
    requireCurrent(issue.evidence_ids.some((key) => {
      const entry = Object.hasOwn(document.evidence, key) ? document.evidence[key] : undefined;
      return entry?.kind === "verification" && entry.status === "passed" && entry.issue_id === issue.id && entry.task_id === candidate!.task_id
        && entry.execution_id === candidate!.execution_id && entry.candidate_id === id && entry.candidate_revision === candidate!.candidate_revision
        && entry.diff_fingerprint === candidate!.diff_fingerprint && entry.scope_revision === issue.scope_revision && entry.testing_evidence_fingerprint === receipt!.fingerprint;
    }), "Candidate verification reference is missing or differs");
    const run = task!.envelope.metadata.run as Record<string, unknown> | undefined;
    const expectedPath = `reports/${candidate!.task_id}-${candidate!.execution_id}.diff`;
    requireCurrent(!!run && run.committed === true && run.diff_truncated === false && run.diff_path === expectedPath, "Candidate diff artifact is not complete and owned");
    const patch = readContained(repoRoot, expectedPath, 512 * 1024);
    requireCurrent(!!patch?.length, "Candidate diff artifact is unavailable");
    return { candidate_id: id, issue_id: candidate!.issue_id, repository_id: candidate!.repository_id, task_id: candidate!.task_id, execution_id: candidate!.execution_id,
      scope_revision: candidate!.scope_revision, base_revision: candidate!.base_revision, candidate_revision: candidate!.candidate_revision, changed_paths: [...candidate!.changed_paths], diff_fingerprint: candidate!.diff_fingerprint,
      content_fingerprint: evidenceHash(patch!), testing_evidence_fingerprint: receipt!.fingerprint };
  }
  function requireCurrentTesting(candidate: WorkflowCandidateBinding, contexts: Partial<Record<WorkflowRoleId, AdmittedContext>>): void {
    const receipt = taskReader(candidate.task_id)!.testing_evidence!;
    for (const entry of Object.values(contexts)) {
      const required = entry!.requiredTestingPlan!;
      const satisfied = required.mode === "functional" && receipt.mode === "strict-tdd"
        // A passed pinned GREEN/REFACTOR run also supports a functional command
        // requirement. RED alone never does; the strict receipt remains intact.
        ? required.runners.every((runner) => receipt.requirements.some((captured) => ["green", "refactor"].includes(captured.stage) && captured.command_fingerprint === evidenceHash(runner.command)))
        : receipt.mode === required.mode && required.runners.every((runner) => receipt.requirements.some((captured) => isDeepStrictEqual(captured, testingRequirement(runner))));
      requireCurrent(satisfied && (required.mode !== "strict-tdd" || receipt.no_refactor_fingerprint === (required.noRefactorJustification ? evidenceHash(required.noRefactorJustification) : null)), "Candidate receipt does not satisfy current trusted testing requirements");
    }
  }
  function resolve(value: unknown, ownWorkflowId?: string, excludeTaskId?: string) {
    const request = parseRequest(value), { issues, workflows } = snapshots();
    const issue = Object.hasOwn(issues.issues, request.issue_id) ? issues.issues[request.issue_id] : undefined;
    requireCurrent(!!issue && issue.project_id === request.project_id, "Issue is unavailable for the selected project");
    requireCurrent(issue!.revision === request.expected_revision, "Issue changed; regenerate the workflow preview");
    const workflowPolicy = dependencies.readWorkflowPolicy?.() ?? readWorkflowPolicy(repoRoot); assertWorkflowPolicy(workflowPolicy);
    const budget = resolveWorkflowBudget(workflowPolicy, request.budget), correction = resolveWorkflowCorrection(workflowPolicy, budget, request.correction_enabled);
    const context = createContextService(repoRoot, { ...dependencies, policy, readIssues: () => issues });
    const contexts: Partial<Record<WorkflowRoleId, AdmittedContext>> = {};
    for (const role of Object.keys(request.selected_agents) as WorkflowRoleId[]) {
      const kind = request.template_id === "analysis" && role === "planner" ? "analysis" : ROLE_KIND[role];
      contexts[role] = context.assembleWorkflowRole({ kind: "issue", project: request.project_id, agent: request.selected_agents[role], role_id: role, issue_id: issue!.id,
        expected_revision: issue!.revision, client_context_categories: request.client_context_categories[role] }, kind, [], { max_attempts: budget.max_attempts, max_runtime_ms: budget.max_runtime_ms, max_total_tokens: budget.max_total_tokens }, excludeTaskId);
    }
    requireCurrent(Object.keys(contexts).length > 0, "Workflow requires explicit role assignments");
    const manifests = Object.entries(contexts).map(([role, result]) => ({ role: role as WorkflowRoleId, manifest: result!.preview.manifest }));
    const full = (values: string[]) => values.includes("full") ? "full" as const : "focused" as const;
    const review = resolveWorkflowReviewPolicy({ template_id: request.template_id, work_scale: issue!.work_scale, criticality: issue!.criticality,
      classification: issue!.classification_inputs, change_categories: issue!.authorized_scope.allowed_change_categories, behavior_change: !issue!.authorized_scope.allowed_change_categories.every((item) => ["documentation", "docs", "runbook", "changelog"].includes(item)), critical_client_operations: false,
      floors: { roles: manifests.map(({ role, manifest }) => ({ role_id: role, depth: manifest.testing.minimum_review_depth })), testing: full(manifests.map(({ manifest }) => manifest.testing.minimum_review_depth)), routing: full(manifests.map(({ manifest }) => manifest.routing.review_depth)),
        project: null, harness: null, workflow: workflowPolicy.minimum_review_depth }, trusted_qa_required: manifests.some(({ manifest }) => manifest.routing.qa_required) });
    const selection: TemplateSelection = { template_id: request.template_id, template_version: 1, work_scale: issue!.work_scale, correction_enabled: request.correction_enabled, review_policy: review, ...(request.analysis_role ? { analysis_role: request.analysis_role } : {}) };
    const plan = resolveWorkflowTemplate(selection);
    const assignments = resolveWorkflowAssignments(selection, { policy, project_id: request.project_id, selected_agents: request.selected_agents, authorized_engineer_id: issue!.assigned_role_id }).map((assignment) => ({ ...assignment, client_context_categories: request.client_context_categories[assignment.role_id]! as typeof assignment.client_context_categories }));
    const candidate = request.candidate_id ? candidateReference(issues, issue!, request.candidate_id) : null;
    if (candidate) requireCurrentTesting(candidate, contexts);
    const blocked = Object.values(contexts).flatMap((entry) => entry!.preview.blocked_reasons);
    if (Object.values(workflows.workflows).some((entry) => entry.id !== ownWorkflowId && entry.issue_id === issue!.id && !["completed", "cancelled"].includes(entry.status))) blocked.push("Issue already has a nonterminal workflow owner");
    if (!ownWorkflowId && ["implementation", "trivial-change"].includes(request.template_id) && issue!.status !== "authorized") blocked.push("Write workflow requires the current exact-scope issue authorization");
    if (["done", "cancelled", "blocked", "needs-decision"].includes(issue!.status)) blocked.push("Issue requires a human decision before workflow context admission");
    if (request.template_id === "quality-review" && !["checking", "ready-for-review"].includes(issue!.status)) blocked.push("Quality-review requires a current reviewable candidate");
    if (budget.max_tasks < plan.max_model_tasks || budget.max_attempts < plan.max_model_tasks) blocked.push("Root budget cannot cover the finite selected sequence");
    const source_fingerprints = assignments.map((entry) => ({ id: `role/${entry.role_id}`, fingerprint: contextSourceFingerprint(contexts[entry.role_id]!.preview.manifest) })).sort((a, b) => a.id.localeCompare(b.id));
    const testing_policy_fingerprint = hash(manifests.map(({ role, manifest }) => ({ role, testing: manifest.testing })));
    const policy_fingerprint = hash({ policy: workflowPolicy, review, plan, assignments, budget, correction });
    const grantContext = { source_fingerprints, policy_fingerprint, testing_policy_fingerprint, minimum_review_depth: review.minimum_depth, testing_mode: manifests.some(({ manifest }) => manifest.testing.mode === "strict-tdd") ? "strict-tdd" as const : "functional" as const };
    const unsigned = { schema_version: 1 as const, request, issue_revision: issue!.revision, issue_status: issue!.status, scope_revision: issue!.scope_revision, scope_fingerprint: hash(issue!.authorized_scope),
      plan, role_assignments: assignments, review_policy: review, budget, correction, candidate, ...grantContext,
      roles: assignments.map((entry) => ({ role_id: entry.role_id, manifest: publicManifest(contexts[entry.role_id]!.preview.manifest) })),
      allowed: blocked.length === 0, blocked_reasons: [...new Set(blocked)].map(redactContextText), runtime_read_limitation: Object.values(contexts)[0]!.preview.runtime_read_limitation,
      candidate_reference_limitation: "Captured candidate references are checked here; managed Git tree identity, cleanliness and lease guards remain a separate runtime requirement." };
    // Bind the unredacted internal policy as well as the body-free projection.
    const fingerprint = hash({ preview: unsigned, manifests: manifests.map((entry) => entry.manifest.fingerprint) });
    return { request, issue: issue!, contexts, preview: { ...unsigned, fingerprint }, grantContext, selection, context, issues, workflows };
  }
  function assembleStage(value: unknown, execution?: TaskRecord, preparationTaskId?: string) {
    const input = object(value, ["workflow_id", "stage_id", "expected_issue_revision"], ["workflow_id", "stage_id", "expected_issue_revision"]);
    identifier(input.workflow_id); identifier(input.stage_id);
    requireCurrent(Number.isSafeInteger(input.expected_issue_revision) && (input.expected_issue_revision as number) >= 1, "A current stage issue revision is required");
    const document = snapshots().workflows;
    const workflow = Object.hasOwn(document.workflows, input.workflow_id) ? document.workflows[input.workflow_id] : undefined;
    const storedStage = Object.hasOwn(document.stages, input.stage_id) ? document.stages[input.stage_id] : undefined;
    if (preparationTaskId !== undefined) {
      identifier(preparationTaskId);
      requireCurrent(storedStage?.status === "pending" && !storedStage.task_id && !storedStage.context_fingerprint && !taskReader(preparationTaskId)
        && !Object.values(document.stages).some((entry) => entry.task_id === preparationTaskId), "Stage preparation requires an unreserved stage and unused server task identity");
    }
    const stage = storedStage && preparationTaskId !== undefined ? { ...storedStage, status: "reserved" as const, task_id: preparationTaskId } : storedStage;
    requireCurrent(!!workflow && !!stage && stage.workflow_id === workflow.id && workflow.current_stage_id === stage.id && workflow.stage_ids.includes(stage.id)
      && workflow.status === "running" && !workflow.stop_requested_at && workflow.recovery_state === "none" && !workflow.pending_decision_id
      && ["reserved", "queued", "running"].includes(stage.status) && !!stage.task_id, "Stage is not the current reserved, unstopped workflow owner");
    const grant = document.grants[workflow!.current_grant_id]!;
    requireCurrent(stage!.grant_id === grant.id && stage!.authority_revision === workflow!.authority_revision && grant.authority_revision === workflow!.authority_revision, "Stage grant authority is no longer current");
    const current = resolve({ template_id: grant.template_id, template_version: grant.template_version, project_id: grant.project_id, issue_id: grant.issue_id,
      expected_revision: input.expected_issue_revision, selected_agents: Object.fromEntries(grant.role_assignments.map((entry) => [entry.role_id, entry.agent_id])), client_context_categories: Object.fromEntries(grant.role_assignments.map((entry) => [entry.role_id, entry.client_context_categories])),
      correction_enabled: grant.correction.enabled, budget: grant.budget, ...(grant.template_id === "analysis" ? { analysis_role: grant.role_assignments[0]!.role_id } : {}), ...(grant.template_id === "quality-review" ? { candidate_id: workflow!.candidate?.candidate_id } : {}) }, workflow!.id, stage!.task_id!);
    requireCurrent(isDeepStrictEqual(document, current.workflows), "Workflow changed while assembling stage context");
    requireCurrent(current.preview.allowed && current.issue.scope_revision === grant.scope_revision && isDeepStrictEqual(current.issue.authorized_scope, grant.authorized_scope)
      && isDeepStrictEqual(current.preview.role_assignments, grant.role_assignments) && isDeepStrictEqual(current.grantContext.source_fingerprints, grant.source_fingerprints)
      && current.grantContext.policy_fingerprint === grant.policy_fingerprint && current.grantContext.testing_policy_fingerprint === grant.testing_policy_fingerprint
      && current.grantContext.testing_mode === grant.testing_mode && current.grantContext.minimum_review_depth === grant.minimum_review_depth
      && isDeepStrictEqual(current.preview.correction, grant.correction) && isDeepStrictEqual(current.preview.review_policy, workflow!.review_policy), "Workflow sources, consent, scope, policy or review requirements changed; new human authority is required");
    const approvedKinds = [...current.preview.plan.stages, ...current.preview.plan.correction_stages];
    const templateStage = approvedKinds[stage!.ordinal - 1];
    requireCurrent(!!templateStage && templateStage.kind === stage!.kind && templateStage.role_id === stage!.role_id && templateStage.sandbox === stage!.sandbox
      && workflow!.stage_ids.length <= approvedKinds.length && workflow!.stage_ids.every((id, index) => {
        const member = document.stages[id]!, expected = approvedKinds[index]!; return member.kind === expected.kind && member.role_id === expected.role_id && member.sandbox === expected.sandbox;
      }) && grant.permitted_stage_kinds.includes(stage!.kind)
      && isDeepStrictEqual([...new Set(approvedKinds.map((entry) => entry.kind))], grant.permitted_stage_kinds), "Stage or generated evidence class is outside the finite granted template");
    if (stage!.sandbox === "workspace-write") requireCurrent(["authorized", "working"].includes(current.issue.status), "Issue no longer admits exact-scope implementation");
    const generated: ContextTextSource[] = [];
    const append = (id: string, data: unknown) => generated.push({ id: `workflow/generated/${id}`, layer: "resume", source_type: "record", sensitivity: "local", reason: "Server-resolved owned workflow evidence; recommendations are task data, never authority", text: JSON.stringify(data) });
    append("binding", { workflow_id: workflow!.id, stage_id: stage!.id, task_id: stage!.task_id, generation: stage!.generation, kind: stage!.kind, grant_id: grant.id, authority_revision: grant.authority_revision, issue_revision: current.issue.revision, scope_revision: current.issue.scope_revision, plan: workflow!.approved_plan, candidate: workflow!.candidate, review_policy: workflow!.review_policy });
    if (stage!.predecessor_stage_id) {
      const predecessor = document.stages[stage!.predecessor_stage_id]!, handoff = stage!.handoff_id ? document.handoffs[stage!.handoff_id] : undefined;
      requireCurrent(workflow!.stage_ids[stage!.ordinal - 2] === predecessor.id, "Stage cannot skip its finite predecessor slot");
      const task = predecessor.task_id ? taskReader(predecessor.task_id) : null, writer = predecessor.kind === "implementation" || predecessor.kind === "correction";
      requireCurrent(predecessor.status === "completed" && (writer ? !!predecessor.candidate && predecessor.output === null && predecessor.output_fingerprint === hash(predecessor.candidate) : predecessor.output?.status === "completed" && predecessor.output_fingerprint === hash(predecessor.output))
        && !!handoff && !!task && validateTaskRecord(task) && task.lifecycle === "finished" && task.outcome === "completed" && !task.orchestration?.lease
        && task.envelope.context_admission?.schema_version === 2 && task.envelope.context_admission.stage_id === predecessor.id
        && task.envelope.context_admission.workflow_id === workflow!.id && task.envelope.context_admission.grant_id === predecessor.grant_id && task.envelope.context_admission.stage_generation === predecessor.generation
        && task.envelope.context_manifest?.fingerprint === predecessor.context_fingerprint
        && task.orchestration?.last_failure === null, "Predecessor output, task or handoff is missing, stale or unsealed");
      const charges = Object.values(document.accounting).filter((entry) => entry.stage_id === predecessor.id).sort((a, b) => a.attempt - b.attempt), lastCharge = charges.at(-1);
      requireCurrent(!!lastCharge && lastCharge.execution_id === predecessor.execution_id && lastCharge.usage_complete && lastCharge.attempt === task!.orchestration!.attempts, "Predecessor execution or accounting binding differs");
      requireCurrent(handoff!.evidence_ids.every((id) => {
        const evidence = current.issues.evidence[id]; return !!evidence && evidence.issue_id === current.issue.id && evidence.task_id === predecessor.task_id && evidence.execution_id === predecessor.execution_id;
      }), "Handoff contains unrelated evidence references");
      append("handoff", handoff); append("predecessor-output", writer ? { candidate: predecessor.candidate, output_fingerprint: predecessor.output_fingerprint } : predecessor.output);
    } else requireCurrent(!stage!.handoff_id && stage!.ordinal === 1, "Noninitial stage requires an owned predecessor handoff");
    if (templateStage!.before_human_gates.includes("plan-approval")) {
      const ref = workflow!.approved_plan, planner = ref ? document.stages[ref.stage_id] : undefined, decision = ref ? document.decisions[ref.decision_id] : undefined;
      requireCurrent(!!ref && planner?.kind === "planning" && planner.output?.kind === "plan" && !planner.output.scope_change_required
        && planner.output_fingerprint === hash(planner.output) && ref.output_fingerprint === planner.output_fingerprint && decision?.status === "approved"
        && decision.resource_fingerprint === ref.output_fingerprint, "Current exact Planner proposal has not been approved");
      append("approved-plan", { reference: ref, output: planner!.output });
    }
    if (templateStage!.requires_candidate) {
      requireCurrent(!!workflow!.candidate && isDeepStrictEqual(stage!.candidate, workflow!.candidate), "Stage candidate differs from the current workflow candidate");
      const candidate = candidateReference(current.issues, current.issue, workflow!.candidate!.candidate_id);
      requireCurrent(isDeepStrictEqual(candidate, workflow!.candidate), "Candidate content or testing reference changed"); requireCurrentTesting(candidate, current.contexts); append("candidate", candidate);
    } else requireCurrent(stage!.candidate === null, "Advisory or first implementation stage cannot inject candidate context");
    if (stage!.kind === "correction") {
      const lineage = workflow!.lineage_id ? document.lineages[workflow!.lineage_id] : null;
      requireCurrent(grant.correction.enabled && !!lineage && lineage.corrections_consumed === 1 && lineage.consumed_stage_id === stage!.id, "Correction allowance has not been durably consumed for this stage");
    }
    const stageCharges = Object.values(document.accounting).filter((entry) => entry.stage_id === stage!.id);
    requireCurrent(workflow!.counters.runtime_ms < grant.budget.max_runtime_ms && workflow!.counters.total_tokens < grant.budget.max_total_tokens, "Workflow runtime or token budget is exhausted");
    // The already reserved task and its own charged attempts are not new
    // capacity. This does not reset persisted counters or refund another stage.
    const counters = { ...workflow!.counters, tasks: workflow!.counters.tasks - (preparationTaskId === undefined ? 1 : 0), attempts: workflow!.counters.attempts - stageCharges.length,
      runtime_ms: workflow!.counters.runtime_ms - stageCharges.reduce((sum, entry) => sum + entry.active_runtime_ms, 0), total_tokens: workflow!.counters.total_tokens - stageCharges.reduce((sum, entry) => sum + entry.observed_tokens, 0) };
    const base = current.contexts[stage!.role_id]!.preview.manifest.budget;
    const available = resolveWorkflowStageBudget({ root: grant.budget, counters, role: base, project: base, worker: base });
    requireCurrent(!!available.budget, "Workflow accounting is unknown or its stage budget is exhausted");
    let budget = available.budget!;
    if (grant.correction.enabled && stage!.ordinal > current.preview.plan.stages.length) {
      const cap = grant.correction.budget!;
      const branchTasks = Object.values(document.stages).filter((entry) => entry.workflow_id === workflow!.id && entry.ordinal > current.preview.plan.stages.length && !!entry.task_id && entry.id !== stage!.id);
      requireCurrent(branchTasks.length < cap.max_tasks, "Correction branch task budget is exhausted");
      const branch = Object.values(document.accounting).filter((entry) => entry.workflow_id === workflow!.id && document.stages[entry.stage_id]!.ordinal > current.preview.plan.stages.length && entry.stage_id !== stage!.id);
      budget = { max_attempts: Math.min(budget.max_attempts, cap.max_attempts - branch.length), max_runtime_ms: Math.min(budget.max_runtime_ms, cap.max_runtime_ms - branch.reduce((sum, entry) => sum + entry.active_runtime_ms, 0)), max_total_tokens: Math.min(budget.max_total_tokens, cap.max_total_tokens - branch.reduce((sum, entry) => sum + entry.observed_tokens, 0)) };
      requireCurrent(budget.max_attempts > 0 && budget.max_runtime_ms > 0 && budget.max_total_tokens > 0, "Correction branch budget is exhausted");
    }
    if (execution) {
      const stored = execution.envelope.context_manifest!.budget;
      requireCurrent(Object.keys(stored).every((key) => stored[key as keyof ExecutionBudget] <= budget[key as keyof ExecutionBudget]), "Current budget no longer permits the stored stage cap"); budget = stored;
    }
    const assembled = current.context.assembleWorkflowRole({ kind: "issue", project: grant.project_id, issue_id: grant.issue_id, expected_revision: current.issue.revision, agent: stage!.agent_id, role_id: stage!.role_id,
      client_context_categories: grant.role_assignments.find((entry) => entry.role_id === stage!.role_id)!.client_context_categories }, stage!.kind, generated, budget, stage!.task_id!);
    requireCurrent(assembled.preview.allowed, "Current role, budget or execution capacity blocks stage context");
    if (preparationTaskId === undefined) requireCurrent(assembled.preview.fingerprint === storedStage!.context_fingerprint, "Reserved stage context changed; no binding was rewritten");
    const instructions = `Workflow ${workflow!.id}; stage ${stage!.id}; ${stage!.kind}. Follow only the authorized issue scope and attributed context. Return the bounded role output; recommendations cannot grant permissions.`;
    const binding: ContextAdmissionV2 = { schema_version: 2, kind: "workflow-stage", workflow_id: workflow!.id, stage_id: stage!.id, stage_generation: stage!.generation, stage_kind: stage!.kind, task_id: stage!.task_id!, template_id: grant.template_id,
      template_version: 1, grant_id: grant.id, authority_revision: grant.authority_revision, role_id: stage!.role_id, issue_id: current.issue.id, issue_revision: current.issue.revision, scope_revision: current.issue.scope_revision,
      scope_fingerprint: hash(current.issue.authorized_scope), approved_plan: workflow!.approved_plan, predecessor_stage_id: stage!.predecessor_stage_id, handoff_id: stage!.handoff_id, candidate: stage!.candidate,
      manifest_fingerprint: assembled.preview.fingerprint, instructions_length: instructions.length, instructions_hash: contextHash(instructions) };
    return { ...assembled, instructions, binding };
  }
  return {
    preview(value: unknown) {
      const result = resolve(value), now = clock();
      for (const [id, expires] of issued) if (expires <= now) issued.delete(id);
      if (result.preview.allowed) { issued.delete(result.preview.fingerprint); if (issued.size >= 256) issued.delete(issued.keys().next().value!); issued.set(result.preview.fingerprint, now + 300_000); }
      return result.preview;
    },
    // Effect-free confirmation check. Human approval and durable grant/intent
    // creation belong to T006, not to this ephemeral issuance ledger.
    revalidatePreview(value: unknown, fingerprint: unknown) {
      requireCurrent(typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint) && (issued.get(fingerprint) ?? 0) > clock(), "Workflow preview was not issued here or expired");
      const result = resolve(value); requireCurrent(result.preview.allowed && result.preview.fingerprint === fingerprint, "Workflow preview is blocked or changed; regenerate before approval");
      return { request: result.request, issue: result.issue, preview: result.preview, grantContext: result.grantContext };
    },
    assembleStage: (value: unknown) => assembleStage(value),
    // Only trusted server composition supplies a fresh generated task id. The
    // pending snapshot is not mutated; T006 must atomically reserve the returned
    // binding/context and intent before creating or queueing that exact task.
    prepareStage: (value: unknown, taskId: string) => assembleStage(value, undefined, taskId),
    revalidateTask(record: TaskRecord) {
      requireCurrent(validateTaskRecord(record) && record.envelope.context_admission?.schema_version === 2, "A valid workflow-stage task binding is required");
      const admission = record.envelope.context_admission as ContextAdmissionV2;
      const live = taskReader(record.envelope.id);
      requireCurrent(!!live && validateTaskRecord(live) && ["queued", "running"].includes(live.lifecycle) && !live.orchestration?.cancel_requested_at
        && isDeepStrictEqual(live.envelope.context_admission, admission) && live.envelope.context_manifest?.fingerprint === record.envelope.context_manifest!.fingerprint
        && live.envelope.instructions === record.envelope.instructions, "Current stored stage task is unavailable, cancelled or changed");
      const result = assembleStage({ workflow_id: admission.workflow_id, stage_id: admission.stage_id, expected_issue_revision: admission.issue_revision }, record);
      const document = snapshots().workflows, stage = document.stages[admission.stage_id]!;
      const intent = Object.values(document.admission_intents).find((entry) => entry.stage_id === stage.id && entry.task_id === record.envelope.id && entry.status === "committed");
      requireCurrent(!!intent && intent.expected_issue_revision === admission.issue_revision && intent.context_fingerprint === result.binding.manifest_fingerprint && stage.context_fingerprint === result.binding.manifest_fingerprint
        && stage.task_id === record.envelope.id && ["queued", "running"].includes(stage.status) && isDeepStrictEqual(admission, result.binding)
        && record.envelope.context_manifest!.fingerprint === result.binding.manifest_fingerprint && record.envelope.instructions === result.instructions
        && record.envelope.title === result.instructions.slice(0, 80), "Workflow stage task, intent, instructions or manifest changed");
      const cap = record.orchestration!, maximum = record.envelope.context_manifest!.budget;
      requireCurrent(!!cap && !cap.cancel_requested_at && cap.attempts <= maximum.max_attempts && cap.cumulative_tokens < cap.max_total_tokens && cap.max_attempts <= maximum.max_attempts
        && cap.max_runtime_ms <= maximum.max_runtime_ms && cap.max_total_tokens <= maximum.max_total_tokens, "Stage task budget or cancellation blocks this attempt");
      const audit = record.envelope.metadata.client_context_share as { client_id?: string } | undefined;
      requireCurrent(!result.clientContext || audit?.client_id === result.clientContext.audit.client_id, "Stage confidential client identity changed");
      return result;
    },
  };
}
export type WorkflowContextService = ReturnType<typeof createWorkflowContextService>;
export type WorkflowContextPreview = ReturnType<WorkflowContextService["preview"]>;
