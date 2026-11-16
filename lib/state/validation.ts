import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import agentResultSchema from "../../schemas/agent-result.schema.json";
import projectOverrideSchema from "../../schemas/project-status-override.schema.json";
import taskEnvelopeSchema from "../../schemas/task-envelope.schema.json";
import taskRecordSchema from "../../schemas/task-record.schema.json";
import taskEventSchema from "../../schemas/task-event.schema.json";
import contextManifestSchema from "../../schemas/context-manifest.schema.json";
import contextAdmissionSchema from "../../schemas/context-admission.schema.json";
import contextAdmissionV2Schema from "../../schemas/context-admission-v2.schema.json";
import budgetPolicySchema from "../../schemas/budget-policy.schema.json";
import budgetAdmissionSchema from "../../schemas/budget-admission.schema.json";
import workflowRecordSchema from "../../schemas/workflow-record.schema.json";
import workflowOutputSchema from "../../schemas/workflow-role-output.schema.json";
import testingEvidenceSchema from "../../schemas/testing-evidence.schema.json";
import { assertTestingEvidenceBinding } from "../context/testing-evidence";
import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { assertBudgetAdmission, BudgetContractError } from "../budgets/validation";
import { budgetTaskIntentId } from "../budgets/reservations";
import { assertContextManifest } from "../context/validation";
import projectProfileSchema from "../../schemas/project-profile.schema.json";
import portfolioProfilesSchema from "../../schemas/portfolio-profiles.schema.json";
import projectProfileV1Schema from "../../schemas/project-profile-v1.schema.json";
import portfolioProfilesV1Schema from "../../schemas/portfolio-profiles-v1.schema.json";
import signalSchema from "../../schemas/signal.schema.json";
import signalFeedSchema from "../../schemas/signal-feed.schema.json";
import signalHumanStateSchema from "../../schemas/signal-human-state.schema.json";
import signalActionSchema from "../../schemas/signal-action.schema.json";
import workSessionSchema from "../../schemas/work-session.schema.json";
import workSessionsSchema from "../../schemas/work-sessions.schema.json";
import workSessionStartSchema from "../../schemas/work-session-start.schema.json";
import workSessionActionSchema from "../../schemas/work-session-action.schema.json";
import clientRecordSchema from "../../schemas/client-record.schema.json";
import clientCommitmentSchema from "../../schemas/client-commitment.schema.json";
import clientPortfolioSchema from "../../schemas/client-portfolio.schema.json";
import clientInputSchema from "../../schemas/client-input.schema.json";
import commitmentInputSchema from "../../schemas/commitment-input.schema.json";
import companyProfileSchema from "../../schemas/company-profile.schema.json";
import objectiveSchema from "../../schemas/objective.schema.json";
import organizationStateSchema from "../../schemas/organization-state.schema.json";
import issueDocumentSchema from "../../schemas/issue-document.schema.json";
import workIssueSchema from "../../schemas/work-issue.schema.json";
import reviewCandidateSchema from "../../schemas/review-candidate.schema.json";
import issueEvidenceSchema from "../../schemas/issue-evidence.schema.json";
import type { PortfolioProfilesDocument, ProjectProfile } from "../portfolio-profile";
import type { ClientCommitment, ClientPortfolioDocument, ClientRecord } from "../client-portfolio";
import type { CompanyProfile, Objective, OrganizationDocument } from "../organization";
import type { Signal, SignalAction, SignalFeed, SignalHumanStateDocument } from "../signals/types";
import type { ProjectStatusOverride, TaskEvent, TaskRecord, WorkSession } from "./types";
import type { DeliveryObservation, IssueDocument, IssueEvidenceReference, IssueIntakeReceipt, ReviewCandidate, WorkIssue } from "../issues/types";
import type { ContextAdmissionV2, ContextManifest } from "../context/types";
import type { WorkflowStageKind } from "../workflows/types";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("date", {
  type: "string",
  validate: (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12) return false;
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    return day >= 1 && day <= daysInMonth;
  },
});
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth
      && Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59
      && Number.isFinite(Date.parse(value));
  },
});
ajv.addSchema(contextManifestSchema);
ajv.addSchema(contextAdmissionSchema);
ajv.addSchema(workflowRecordSchema);
ajv.addSchema(workflowOutputSchema);
ajv.addSchema(contextAdmissionV2Schema);
ajv.addSchema(testingEvidenceSchema);
ajv.addSchema(budgetPolicySchema);
ajv.addSchema(budgetAdmissionSchema);
ajv.addSchema(taskEnvelopeSchema);
ajv.addSchema(agentResultSchema);
ajv.addSchema(projectProfileSchema);
ajv.addSchema(projectProfileV1Schema);
ajv.addSchema(signalSchema);
ajv.addSchema(clientRecordSchema);
ajv.addSchema(clientCommitmentSchema);
ajv.addSchema(companyProfileSchema);
ajv.addSchema(objectiveSchema);
ajv.addSchema(workIssueSchema);
ajv.addSchema(reviewCandidateSchema);
ajv.addSchema(issueEvidenceSchema);

// Own-property strictness at the admission boundary also applies to in-memory callers.
const admissionAjv = new Ajv2020({ allErrors: true, strict: true, ownProperties: true });
admissionAjv.addFormat("date-time", ajv.formats["date-time"]!);
admissionAjv.addSchema(workflowRecordSchema);
admissionAjv.addSchema(workflowOutputSchema);
const admissionV1 = admissionAjv.compile(contextAdmissionSchema);
const admissionV2 = admissionAjv.compile(contextAdmissionV2Schema);
export function contextAdmissionVersion(value: unknown): "legacy" | 1 | 2 {
  if (value === undefined) return "legacy";
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "schema_version")) throw new Error("Invalid context admission version");
  switch ((value as { schema_version: unknown }).schema_version) {
    case 1: if (admissionV1(value)) return 1; break;
    case 2: if (admissionV2(value)) return 2; break;
  }
  throw new Error("Invalid or unsupported context admission");
}

/** Independent version dispatch; only the envelope can establish actual absence. */
export function budgetAdmissionVersion(value: unknown): "legacy" | 1 {
  if (value === undefined) return "legacy";
  assertBudgetAdmission(value);
  return 1;
}
function budgetBindingInvariant(ok: boolean, message: string): asserts ok {
  if (!ok) throw new BudgetContractError(message);
}
// Never let AJV/serialization invoke accessors, proxies or toJSON on a newly bound
// task. Legacy absence does not adopt a new whole-task storage format.
function plainBudgetTask(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  budgetBindingInvariant(depth <= 32, "Budget task nesting exceeds limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { budgetBindingInvariant(Number.isFinite(value), "Budget task contains a non-finite number"); return; }
  budgetBindingInvariant(typeof value === "object" && !nodeTypes.isProxy(value), "Budget task must be plain JSON");
  budgetBindingInvariant(!ancestors.has(value), "Budget task contains a cycle");
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  budgetBindingInvariant(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null, "Budget task has an unsupported prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  budgetBindingInvariant(keys.length <= 10000 && keys.every((key) => typeof key === "string"), "Budget task has invalid properties");
  if (array) {
    budgetBindingInvariant(keys.length === value.length + 1, "Budget task has a sparse or decorated array");
    for (let index = 0; index < value.length; index++) budgetBindingInvariant(Object.hasOwn(descriptors, String(index)), "Budget task has a sparse array");
  }
  ancestors.add(value);
  try {
    for (const key of keys as string[]) {
      if (array && key === "length") continue;
      const descriptor = descriptors[key]!;
      budgetBindingInvariant(descriptor.enumerable === true && Object.hasOwn(descriptor, "value")
        && !["__proto__", "constructor", "prototype"].includes(key), "Budget task contains hidden properties or hooks");
      plainBudgetTask(descriptor.value, ancestors, depth + 1);
    }
  } finally { ancestors.delete(value); }
}

/** Pure immutable binding only: not current policy, reservation or live ownership. */
export function assertTaskBudgetAdmissionBinding(task: TaskRecord): void {
  budgetBindingInvariant(!!task && typeof task === "object" && !nodeTypes.isProxy(task), "Invalid budget task");
  const envelopeDescriptor = Object.getOwnPropertyDescriptor(task, "envelope");
  budgetBindingInvariant(!!envelopeDescriptor && Object.hasOwn(envelopeDescriptor, "value"), "Budget task requires an own envelope");
  const envelope = envelopeDescriptor.value as TaskRecord["envelope"];
  budgetBindingInvariant(!!envelope && typeof envelope === "object" && !nodeTypes.isProxy(envelope), "Invalid budget task envelope");
  budgetBindingInvariant(Object.getPrototypeOf(envelope) === Object.prototype || Object.getPrototypeOf(envelope) === null,
    "Budget task envelope has an unsupported prototype");
  const descriptor = Object.getOwnPropertyDescriptor(envelope, "budget_admission");
  if (!descriptor) {
    budgetBindingInvariant(!("budget_admission" in envelope), "Inherited budget admission is invalid");
    return;
  }
  budgetBindingInvariant(descriptor.enumerable === true && Object.hasOwn(descriptor, "value"), "Budget admission must be own plain data");
  assertBudgetAdmission(descriptor.value); // Undefined/null/future cannot take legacy fallback.
  budgetBindingInvariant(descriptor.value.intent_id === budgetTaskIntentId(descriptor.value), "Budget immutable intent fingerprint differs");
  plainBudgetTask(task);
  const budget = descriptor.value, manifest = envelope.context_manifest, context = envelope.context_admission;
  budgetBindingInvariant(!!manifest && !!context && contextAdmissionVersion(context) !== "legacy", "Budget admission requires governed context");
  assertContextManifest(manifest);
  const { fingerprint, ...unsignedManifest } = manifest;
  budgetBindingInvariant(createHash("sha256").update(JSON.stringify(unsignedManifest)).digest("hex") === fingerprint
    && envelope.project === manifest.project_id && envelope.agent === manifest.agent_id && envelope.task_type === manifest.task_kind
    && envelope.sandbox === manifest.sandbox, "Budget task manifest binding differs");
  const orchestration = task.orchestration;
  budgetBindingInvariant(budget.task_id === envelope.id && budget.project_id === envelope.project
    && budget.agent_id === envelope.agent && budget.role_id === manifest.role_id
    && budget.manifest_fingerprint === manifest.fingerprint && budget.manifest_fingerprint === context.manifest_fingerprint
    && budget.context_admission_version === context.schema_version
    && budget.execution_mode === (envelope.sandbox === "workspace-write" ? "write" : "read"), "Budget task/context identity differs");
  budgetBindingInvariant(!!orchestration && budget.caps.attempts <= manifest.budget.max_attempts
    && budget.caps.runtime_ms <= manifest.budget.max_runtime_ms && budget.caps.total_tokens <= manifest.budget.max_total_tokens
    && orchestration.max_attempts <= budget.caps.attempts && orchestration.max_runtime_ms <= budget.caps.runtime_ms
    && orchestration.max_total_tokens <= budget.caps.total_tokens, "Budget task caps differ from admitted ceilings");
  const review = manifest.role_id === "reviewer" || manifest.role_id === "qa-evaluator";
  budgetBindingInvariant(review ? budget.caps.review_attempts > 0 && budget.caps.review_runtime_ms > 0 && budget.caps.review_total_tokens > 0
    : budget.caps.review_attempts === 0 && budget.caps.review_runtime_ms === 0 && budget.caps.review_total_tokens === 0, "Budget review labels differ from task role");
  if (context.schema_version === 2) {
    const workflow = budget.workflow;
    budgetBindingInvariant(!!workflow && workflow.workflow_id === context.workflow_id && workflow.stage_id === context.stage_id
      && workflow.stage_generation === context.stage_generation && workflow.grant_id === context.grant_id
      && context.task_id === envelope.id && context.role_id === budget.role_id
      && budget.issue_id === context.issue_id && budget.scope_revision === context.scope_revision
      && budget.scope_fingerprint === context.scope_fingerprint
      && budget.caps.corrections === (context.stage_kind === "correction" ? 1 : 0), "Budget workflow/scope binding differs");
  } else {
    budgetBindingInvariant(budget.workflow === null && budget.caps.corrections === 0, "V1 budget cannot invent workflow correction authority");
    if (context.kind === "issue") {
      const scope = envelope.metadata.issue_authorized_scope;
      budgetBindingInvariant(manifest.task_kind === "implementation" && !!scope && typeof scope === "object" && !Array.isArray(scope)
        && budget.issue_id === context.issue_id && budget.issue_id === envelope.metadata.issue_id
        && budget.scope_revision === envelope.metadata.issue_scope_revision
        && budget.scope_fingerprint === createHash("sha256").update(JSON.stringify(scope)).digest("hex"), "Budget issue scope binding differs");
    } else budgetBindingInvariant(manifest.task_kind === "analysis" && budget.issue_id === null && budget.scope_revision === null && budget.scope_fingerprint === null
      && !["issue_id", "issue_scope_revision", "issue_authorized_scope"].some((key) => Object.hasOwn(envelope.metadata, key)), "Analysis budget cannot invent issue scope");
  }
}

/** P readiness only, never the still-independent historical O execution gate. */
export function taskBudgetReadiness(task: TaskRecord): {
  phase: "scaffold"; executable: false; status: "historical" | "bound";
  reason: "budget-admission-required" | "budget-cutover-unavailable"; next_action: string;
} {
  assertTaskBudgetAdmissionBinding(task);
  const bound = Object.hasOwn(task.envelope, "budget_admission");
  return Object.freeze({ phase: "scaffold", executable: false, status: bound ? "bound" : "historical",
    reason: bound ? "budget-cutover-unavailable" : "budget-admission-required",
    next_action: bound ? "Wait for the proven cooperative boundary and exact operator-confirmed P cutover."
      : "Keep historical bytes; obtain a fresh normal admission after the exact operator-confirmed P cutover." });
}
function assertWorkflowStageBinding(binding: ContextAdmissionV2, envelope: TaskRecord["envelope"], manifest: ContextManifest): void {
  const roles: Record<WorkflowStageKind, string[]> = { analysis: ["portfolio-analyst", "planner"], planning: ["planner"], implementation: ["software-engineer"], correction: ["software-engineer"], review: ["reviewer"], qa: ["qa-evaluator"], operations: ["operations-observer"] };
  const kinds: Record<ContextAdmissionV2["template_id"], WorkflowStageKind[]> = { analysis: ["analysis"], implementation: ["planning", "implementation", "review", "qa", "correction"], "quality-review": ["review", "qa"], "operations-investigation": ["operations"], "trivial-change": ["implementation", "review", "qa", "correction"] };
  const writer = binding.stage_kind === "implementation" || binding.stage_kind === "correction";
  if (binding.task_id !== envelope.id || binding.role_id !== manifest.role_id || !roles[binding.stage_kind].includes(binding.role_id)
    || !kinds[binding.template_id].includes(binding.stage_kind) || manifest.task_kind !== (writer ? "implementation" : "analysis")
    || manifest.sandbox !== (writer ? "workspace-write" : "read-only")
    || (writer && !manifest.tools.includes("edit-authorized-scope"))
    || ["issue_id", "issue_scope_revision", "issue_authorized_scope"].some((key) => Object.hasOwn(envelope.metadata, key))) throw new Error("Workflow stage task binding differs");
  if ((binding.predecessor_stage_id === null) !== (binding.handoff_id === null) || binding.predecessor_stage_id === binding.stage_id
    || binding.approved_plan?.stage_id === binding.stage_id) throw new Error("Workflow predecessor or plan binding differs");
  if (writer && binding.template_id === "implementation" && (!binding.approved_plan || !binding.handoff_id)) throw new Error("Implementation requires an approved plan and predecessor handoff");
  const needsCandidate = binding.template_id === "quality-review" || binding.stage_kind === "correction"
    || (["review", "qa"].includes(binding.stage_kind) && ["implementation", "trivial-change"].includes(binding.template_id));
  if (needsCandidate !== (binding.candidate !== null)) throw new Error("Workflow candidate requirement differs");
  if (binding.candidate && (binding.candidate.issue_id !== binding.issue_id || binding.candidate.repository_id !== envelope.project
    || binding.candidate.scope_revision !== binding.scope_revision || binding.candidate.task_id === envelope.id
    || binding.candidate.changed_paths.some((path) => /[\\:\x00-\x1f\x7f]/.test(path) || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")))) throw new Error("Workflow candidate binding differs");
}
const taskRecordShape = ajv.compile(taskRecordSchema) as ValidateFunction<TaskRecord>;
export const validateTaskRecord: ValidateFunction<TaskRecord> = Object.assign((value: unknown): value is TaskRecord => {
  try { assertTaskBudgetAdmissionBinding(value as TaskRecord); }
  catch {
    validateTaskRecord.errors = [{ instancePath: "/envelope/budget_admission", schemaPath: "#/properties/envelope/budget_admission", keyword: "budgetBinding", params: {}, message: "budget admission or its task/context/scope/cap binding is invalid" }];
    return false;
  }
  if (!taskRecordShape(value)) { validateTaskRecord.errors = taskRecordShape.errors; return false; }
  validateTaskRecord.errors = null;
  const envelope = value.envelope;
  const manifest = envelope.context_manifest;
  if (("context_admission" in envelope && !Object.hasOwn(envelope, "context_admission"))
    || (Object.hasOwn(envelope, "context_admission") && envelope.context_admission === undefined)) {
    validateTaskRecord.errors = [{ instancePath: "/envelope/context_admission", schemaPath: "#/properties/envelope/context_admission", keyword: "contextBinding", params: {}, message: "present admission must be an own supported versioned document" }];
    return false;
  }
  if (!manifest && !envelope.context_admission && !value.testing_evidence) return true; // Explicit supported legacy branch.
  try {
    contextAdmissionVersion(envelope.context_admission);
    // V2 writer receipts retain the v1 evidence format but bind to admitted
    // scope, never legacy metadata. Shape/binding is not execution authority.
    if (value.testing_evidence) assertTestingEvidenceBinding(value.testing_evidence, value);
    if (!manifest) throw new Error("Admission requires a manifest");
    assertContextManifest(manifest);
    const { fingerprint, ...unsigned } = manifest;
    const calculated = createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
    if (calculated !== fingerprint || envelope.project !== manifest.project_id || envelope.agent !== manifest.agent_id
      || envelope.task_type !== manifest.task_kind || envelope.sandbox !== manifest.sandbox || !envelope.requires_human_approval
      || (envelope.self_verify === true) !== manifest.tools.includes("verify-configured")) throw new Error("Context envelope binding differs");
    const audit = envelope.metadata.client_context_share;
    if (manifest.selected_categories.length) {
      if (!audit || typeof audit !== "object" || Array.isArray(audit) || !Object.hasOwn(audit, "categories")) throw new Error("Missing context consent audit");
      const categories = (audit as { categories: unknown }).categories;
      if (!Array.isArray(categories) || categories.some((item) => typeof item !== "string") || new Set(categories).size !== categories.length
        || [...categories].sort().join("\n") !== [...manifest.selected_categories].sort().join("\n")) throw new Error("Context consent binding differs");
    } else if (audit !== undefined) throw new Error("Unexpected context consent audit");
    const orchestration = value.orchestration;
    if (!orchestration || orchestration.max_attempts > manifest.budget.max_attempts || orchestration.max_runtime_ms > manifest.budget.max_runtime_ms
      || orchestration.max_total_tokens > manifest.budget.max_total_tokens) throw new Error("Context execution budget differs");
    const binding = envelope.context_admission;
    if (binding) {
      const original = envelope.instructions.slice(0, binding.instructions_length);
      if (binding.manifest_fingerprint !== manifest.fingerprint || binding.instructions_length > envelope.instructions.length
        || createHash("sha256").update(original).digest("hex") !== binding.instructions_hash
        || (manifest.selected_categories.length === 0 && original !== envelope.instructions)) throw new Error("Admission instruction binding differs");
      switch (binding.schema_version) {
        case 1:
          if (binding.kind === "issue" ? manifest.task_kind !== "implementation" || binding.issue_id !== envelope.metadata.issue_id
            : manifest.task_kind !== "analysis" || envelope.metadata.issue_id !== undefined) throw new Error("Admission task binding differs");
          break;
        case 2: assertWorkflowStageBinding(binding, envelope, manifest); break;
        default: throw new Error("Unsupported admission version");
      }
    }
    return true;
  } catch {
    validateTaskRecord.errors = [{ instancePath: "/envelope/context_manifest", schemaPath: "#/properties/envelope/context_manifest", keyword: "contextBinding", params: {}, message: "context manifest or its task/consent/budget binding is invalid" }];
    return false;
  }
}, { errors: null, schema: taskRecordShape.schema, schemaEnv: taskRecordShape.schemaEnv });
export const validateTaskEvent = ajv.compile(taskEventSchema) as ValidateFunction<TaskEvent>;
export const validateProjectOverride = ajv.compile(projectOverrideSchema) as ValidateFunction<ProjectStatusOverride>;
export const validateProjectProfile = ajv.compile(projectProfileSchema) as ValidateFunction<ProjectProfile>;
export const validatePortfolioProfilesDocument = ajv.compile(portfolioProfilesSchema) as ValidateFunction<PortfolioProfilesDocument>;
export const validatePortfolioProfilesDocumentV1 = ajv.compile(portfolioProfilesV1Schema);
export const validateSignal = ajv.compile(signalSchema) as ValidateFunction<Signal>;
export const validateSignalFeed = ajv.compile(signalFeedSchema) as ValidateFunction<SignalFeed>;
export const validateSignalHumanStateDocument = ajv.compile(signalHumanStateSchema) as ValidateFunction<SignalHumanStateDocument>;
export const validateSignalAction = ajv.compile(signalActionSchema) as ValidateFunction<SignalAction>;
export const validateWorkSession = ajv.compile(workSessionSchema) as ValidateFunction<WorkSession>;
export const validateWorkSessionsDocument = ajv.compile(workSessionsSchema);
export const validateWorkSessionStart = ajv.compile(workSessionStartSchema);
export const validateWorkSessionAction = ajv.compile(workSessionActionSchema);
export const validateClientRecord = ajv.compile(clientRecordSchema) as ValidateFunction<ClientRecord>;
export const validateClientCommitment = ajv.compile(clientCommitmentSchema) as ValidateFunction<ClientCommitment>;
export const validateClientPortfolioDocument = ajv.compile(clientPortfolioSchema) as ValidateFunction<ClientPortfolioDocument>;
export const validateClientInput = ajv.compile(clientInputSchema);
export const validateCommitmentInput = ajv.compile(commitmentInputSchema);
export const validateCompanyProfile = ajv.compile(companyProfileSchema) as ValidateFunction<CompanyProfile>;
export const validateObjective = ajv.compile(objectiveSchema) as ValidateFunction<Objective>;
export const validateOrganizationDocument = ajv.compile(organizationStateSchema) as ValidateFunction<OrganizationDocument>;
export const validateWorkIssue = ajv.compile(workIssueSchema) as ValidateFunction<WorkIssue>;
export const validateReviewCandidate = ajv.compile(reviewCandidateSchema) as ValidateFunction<ReviewCandidate>;
export const validateIssueEvidence = ajv.compile(issueEvidenceSchema) as ValidateFunction<IssueEvidenceReference>;
export const validateIssueDocument = ajv.compile(issueDocumentSchema) as ValidateFunction<IssueDocument>;

const issueIntakeReceiptShape = ajv.compile({ $ref: `${workIssueSchema.$id}#/$defs/intakeReceipt` });
export const validateIssueIntakeReceipt: ValidateFunction<IssueIntakeReceipt> = Object.assign((value: unknown): value is IssueIntakeReceipt => {
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    validateIssueIntakeReceipt.errors = [{ instancePath: "/intake_receipt", schemaPath: "#/$defs/intakeReceipt", keyword: "plainData", params: {}, message: "intake receipt must be own plain JSON data" }];
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 3 || keys.some((key) => typeof key !== "string" || !descriptors[key]!.enumerable || !("value" in descriptors[key]!)
    || !["string", "number"].includes(typeof descriptors[key]!.value))) {
    validateIssueIntakeReceipt.errors = [{ instancePath: "/intake_receipt", schemaPath: "#/$defs/intakeReceipt", keyword: "plainData", params: {}, message: "intake receipt must contain three own JSON fields" }];
    return false;
  }
  if (!issueIntakeReceiptShape(value)) { validateIssueIntakeReceipt.errors = issueIntakeReceiptShape.errors; return false; }
  validateIssueIntakeReceipt.errors = null;
  return true;
}, { errors: null, schema: issueIntakeReceiptShape.schema, schemaEnv: issueIntakeReceiptShape.schemaEnv });

/** Inert identifiers or deliberately simple HTTP(S) references, never paths/commands. */
export function isDeliverySourceReference(value: string): boolean {
  if (value.length > 300 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) return true;
  if (!/^https?:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !!parsed.hostname && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch { return false; }
}

const deliveryObservationShape = ajv.compile({ $ref: `${issueEvidenceSchema.$id}#/$defs/deliveryObservation` });
export const validateDeliveryObservation: ValidateFunction<DeliveryObservation> = Object.assign((value: unknown): value is DeliveryObservation => {
  // This facet also accepts in-memory writers: validation must not invoke code or
  // accept inherited fields which JSON serialization would silently discard.
  if (!value || typeof value !== "object" || nodeTypes.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    validateDeliveryObservation.errors = [{ instancePath: "/delivery_observation", schemaPath: "#/$defs/deliveryObservation", keyword: "plainData", params: {}, message: "delivery observation must be own plain JSON data" }];
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 8 || keys.some((key) => typeof key !== "string" || !descriptors[key]!.enumerable || !("value" in descriptors[key]!)
    || (descriptors[key]!.value !== null && !["string", "number"].includes(typeof descriptors[key]!.value)))) {
    validateDeliveryObservation.errors = [{ instancePath: "/delivery_observation", schemaPath: "#/$defs/deliveryObservation", keyword: "plainData", params: {}, message: "delivery observation must contain eight own JSON fields" }];
    return false;
  }
  if (!deliveryObservationShape(value)) { validateDeliveryObservation.errors = deliveryObservationShape.errors; return false; }
  const observation = value as DeliveryObservation;
  if (!isDeliverySourceReference(observation.source_reference)
    || [observation.summary, observation.next_action].some((text) => text !== text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))) {
    validateDeliveryObservation.errors = [{ instancePath: "/delivery_observation", schemaPath: "#/$defs/deliveryObservation", keyword: "deliveryObservation", params: {}, message: "delivery observation contains an invalid reference or text" }];
    return false;
  }
  validateDeliveryObservation.errors = null;
  return true;
}, { errors: null, schema: deliveryObservationShape.schema, schemaEnv: deliveryObservationShape.schemaEnv });

export function describeValidation(errors: ErrorObject[] | null | undefined): string {
  return errors?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ") ?? "invalid data";
}
