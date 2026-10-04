import { randomUUID } from "node:crypto";
import type { TaskEnvelope, TaskRecord } from "../../../lib/state/types";
import { readTask, writeTask, withStateLock } from "../../../lib/state/store";
import { PolicyError, PolicyService } from "../../../lib/policy/service";
import { defaultTaskOrchestration } from "../../../lib/state/orchestration";
import { appendTaskEvent } from "../../../lib/state/events";
import type { ClientContextShareAudit } from "../../../lib/client-portfolio";
import { createContextService, ContextPreviewError, type ContextService } from "./context-service";
import { contextHash } from "../../../lib/context/assemble";
import { readWorkflowDocument } from "../../../lib/state/workflows";
import { readIssueDocument } from "../../../lib/state/issues";
import { isDeepStrictEqual } from "node:util";
import { isSafeIdentifier } from "../../../lib/security/identifiers";
import type { WorkflowContextService } from "./workflow-context-service";

export class ValidationError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) { super(message); }
}

export interface CreateTaskInput {
  project: string;
  agent: string;
  instructions: string;
  sandbox?: string;
  self_verify?: boolean;
  role_id?: string;
  preview_fingerprint?: string;
  client_context_categories?: unknown;
}

export interface TrustedIssueTaskContext {
  taskId: string;
  issueId: string;
  scopeRevision: number;
  expectedRevision?: number;
  authorizedScope: import("../../../lib/issues/types").AuthorizedScope;
}

export function createTask(input: CreateTaskInput, repoRoot: string = process.cwd(), trustedIssue?: TrustedIssueTaskContext, options: { context?: ContextService; source?: "dashboard" | "cli" } = {}): { id: string } {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["project", "agent", "instructions", "sandbox", "self_verify", "role_id", "preview_fingerprint", "client_context_categories"].includes(key))) throw new ValidationError("Invalid task admission fields");
  if (typeof input.project !== "string" || typeof input.agent !== "string" || typeof input.instructions !== "string" || (input.self_verify !== undefined && typeof input.self_verify !== "boolean")) throw new ValidationError("Invalid task admission field types");
  const project = String(input?.project ?? "");
  const agent = String(input?.agent ?? "");
  const baseInstructions = String(input?.instructions ?? "").trim();

  if (!baseInstructions) throw new ValidationError("instructions are required");
  if (baseInstructions.length > 20_000) throw new ValidationError("instructions are too long");

  const sandbox = String(input?.sandbox ?? "read-only");
  if (sandbox !== "read-only" && sandbox !== "workspace-write") {
    throw new ValidationError(`invalid sandbox: ${sandbox} (use read-only or workspace-write)`);
  }
  if (sandbox === "workspace-write" && !trustedIssue) {
    throw new ValidationError("workspace-write tasks require a trusted, authorized local issue");
  }

  let selfVerify = input?.self_verify === true;
  if (selfVerify && sandbox !== "workspace-write") {
    throw new ValidationError("self_verify requires sandbox workspace-write");
  }

  let admitted: ReturnType<ContextService["admit"]>;
  try {
    admitted = (options.context ?? createContextService(repoRoot)).admit({
      kind: trustedIssue ? "issue" : "analysis", project, agent, role_id: input.role_id,
      ...(trustedIssue ? { issue_id: trustedIssue.issueId, expected_revision: trustedIssue.expectedRevision } : { instructions: baseInstructions }),
      ...(input.client_context_categories !== undefined ? { client_context_categories: input.client_context_categories } : {}),
    }, input.preview_fingerprint);
  } catch (error) {
    if (error instanceof ContextPreviewError) throw new ValidationError(error.message, error.status);
    throw new ValidationError("Context policy or sources are unavailable; no task was created", 409);
  }
  const manifest = admitted.preview.manifest;
  if (manifest.sandbox !== sandbox) throw new ValidationError("Task mode differs from the admitted context", 409);
  if (trustedIssue && (!admitted.issue || admitted.issue.scope_revision !== trustedIssue.scopeRevision || JSON.stringify(admitted.issue.authorized_scope) !== JSON.stringify(trustedIssue.authorizedScope))) throw new ValidationError("Issue scope changed; regenerate context preview", 409);
  selfVerify = manifest.tools.includes("verify-configured");
  const clientContext: { instructions: string; audit: ClientContextShareAudit } | null = admitted.clientContext;
  const instructions = clientContext ? baseInstructions + "\n\n---\n" + clientContext.instructions : baseInstructions;
  if (instructions.length > 20_000) throw new ValidationError("instructions and explicitly selected client context are too long");

  let repoPath: string;
  try {
    const allowed = new PolicyService(repoRoot).authorizeDispatch({ project, agent, sandbox, selfVerify });
    repoPath = allowed.project.repo_path!;
  } catch (error) {
    if (error instanceof PolicyError) throw new ValidationError(error.message);
    throw error;
  }

  const id = trustedIssue?.taskId ?? `T-${randomUUID().slice(0, 8)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id)) throw new ValidationError("invalid task id");
  const envelope: TaskEnvelope = {
    id,
    source: options.source ?? "dashboard",
    project,
    task_type: sandbox === "workspace-write" ? "implementation" : "analysis",
    agent,
    // Keep task-list labels derived from the user's task request, not appended client context.
    title: baseInstructions.slice(0, 80),
    instructions,
    repo_path: repoPath,
    branch: `agent/${id}-${agent}`,
    sandbox: sandbox as "read-only" | "workspace-write",
    expected_outputs: ["summary", "risks", "next_steps"],
    requires_human_approval: true,
    metadata: {
      created_by: options.source ?? "dashboard",
      ...(trustedIssue ? {
        issue_id: trustedIssue.issueId,
        issue_scope_revision: trustedIssue.scopeRevision,
        issue_authorized_scope: trustedIssue.authorizedScope,
      } : {}),
      ...(clientContext ? { client_context_share: clientContext.audit } : {}),
    },
    context_manifest: manifest,
    context_admission: {
      schema_version: 1, kind: admitted.request.kind, manifest_fingerprint: manifest.fingerprint,
      instructions_length: baseInstructions.length, instructions_hash: contextHash(baseInstructions),
      ...(admitted.issue ? { issue_id: admitted.issue.id, issue_revision: admitted.issue.revision, issue_status: admitted.issue.status as "authorized" | "working" } : {}),
    },
    self_verify: selfVerify && sandbox === "workspace-write",
  };

  const ts = new Date().toISOString();
  const record: TaskRecord = {
    envelope,
    lifecycle: "queued",
    outcome: null,
    created_at: ts,
    started_at: null,
    updated_at: ts,
    finished_at: null,
    result: null,
    logs_path: null,
    revision: 1,
    orchestration: { ...defaultTaskOrchestration(), ...manifest.budget },
  };
  withStateLock(id, () => {
    if (trustedIssue && Object.values(readWorkflowDocument().workflows).some((owner) => owner.issue_id === trustedIssue.issueId && !["completed", "cancelled"].includes(owner.status))) throw new ValidationError("Active workflow ownership denies manual issue dispatch", 409);
    if (readTask(id)) throw new ValidationError("Task id already exists; no task was replaced", 409);
    writeTask(record);
    appendTaskEvent({
      task_id: id,
      type: "policy-evaluated",
      revision: 1,
      payload: { boundary: "dispatch", allowed: true, project, agent, sandbox, self_verify: envelope.self_verify === true },
      at: ts,
    });
    appendTaskEvent({ task_id: id, type: "queued", revision: 1, payload: { source: envelope.source }, at: ts });
  });
  return { id };
}

export interface TrustedWorkflowTaskInput {
  workflow_id: string;
  stage_id: string;
  expected_workflow_revision: number;
  expected_issue_revision: number;
}

// Not reachable through generic API/CLI task input. References are resolved
// from a durable reserved intent, never a caller envelope, grant or manifest.
// Creating a queued snapshot grants no execution: T004 still denies all v2
// attempts and T008 must separately fence scheduler claims on committed intent.
export function createWorkflowTask(input: TrustedWorkflowTaskInput, repoRoot: string, options: { context: WorkflowContextService }): { id: string } {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Reflect.ownKeys(input).length !== 4 || Reflect.ownKeys(input).some((key) => typeof key !== "string" || !["workflow_id", "stage_id", "expected_workflow_revision", "expected_issue_revision"].includes(key))
    || !isSafeIdentifier(input.workflow_id) || !isSafeIdentifier(input.stage_id) || !Number.isSafeInteger(input.expected_workflow_revision) || input.expected_workflow_revision < 1
    || !Number.isSafeInteger(input.expected_issue_revision) || input.expected_issue_revision < 1) throw new ValidationError("Invalid trusted workflow task references");
  const document = readWorkflowDocument(), workflow = document.workflows[input.workflow_id], stage = document.stages[input.stage_id];
  const intent = Object.values(document.admission_intents).find((entry) => entry.stage_id === input.stage_id);
  if (!workflow || !stage || !intent || workflow.revision !== input.expected_workflow_revision || workflow.status !== "running" || workflow.stop_requested_at || workflow.pending_decision_id
    || workflow.recovery_state !== "none" || workflow.current_stage_id !== stage.id || stage.workflow_id !== workflow.id || stage.status !== "reserved" || intent.status !== "reserved"
    || intent.task_id !== stage.task_id || intent.expected_workflow_revision !== workflow.revision || intent.expected_issue_revision !== input.expected_issue_revision) throw new ValidationError("Workflow task has no exact current reserved intent", 409);
  const issues = readIssueDocument(), issue = issues.issues[workflow.issue_id];
  const link = issues.events.filter((event) => event.issue_id === workflow.issue_id).at(-1);
  if (!issue || issue.revision !== intent.expected_issue_revision || !issue.task_ids.includes(intent.task_id) || link?.payload.workflow_id !== workflow.id || link.payload.stage_id !== stage.id || link.payload.task_id !== intent.task_id) throw new ValidationError("Workflow issue linkage is uncommitted or changed", 409);
  const assembled = options.context.assembleStage({ workflow_id: workflow.id, stage_id: stage.id, expected_issue_revision: intent.expected_issue_revision });
  if (assembled.binding.task_id !== intent.task_id || assembled.binding.manifest_fingerprint !== intent.context_fingerprint) throw new ValidationError("Reserved workflow context differs", 409);
  const manifest = assembled.preview.manifest;
  const allowed = new PolicyService(repoRoot).authorizeRole({ project: workflow.project_id, agent: stage.agent_id, roleId: stage.role_id, taskKind: manifest.task_kind, sandbox: stage.sandbox, selfVerify: manifest.tools.includes("verify-configured") });
  const envelope: TaskEnvelope = {
    id: intent.task_id, source: "dashboard", project: workflow.project_id, task_type: manifest.task_kind, agent: stage.agent_id,
    title: assembled.instructions.slice(0, 80), instructions: assembled.instructions, repo_path: allowed.project.repo_path!, branch: `agent/${intent.task_id}-${stage.agent_id}`,
    sandbox: stage.sandbox, expected_outputs: ["summary", "risks", "next_steps"], requires_human_approval: true,
    metadata: { created_by: "dashboard", ...(assembled.clientContext ? { client_context_share: assembled.clientContext.audit } : {}) },
    context_manifest: manifest, context_admission: assembled.binding, self_verify: manifest.tools.includes("verify-configured"),
  };
  const at = new Date().toISOString();
  const record: TaskRecord = { envelope, lifecycle: "queued", outcome: null, created_at: at, updated_at: at, started_at: null, finished_at: null, result: null, logs_path: null,
    revision: 1, orchestration: { ...defaultTaskOrchestration(), ...manifest.budget } };
  withStateLock(intent.task_id, () => {
    if (!isDeepStrictEqual(readWorkflowDocument(), document) || !isDeepStrictEqual(readIssueDocument(), issues)) throw new ValidationError("Workflow or issue changed before task persistence", 409);
    const existing = readTask(intent.task_id);
    if (existing) {
      const previous = existing.envelope;
      const audit = (value: TaskEnvelope) => { const share = value.metadata.client_context_share as ClientContextShareAudit | undefined; return share ? { client_id: share.client_id, categories: share.categories } : null; };
      if (existing.lifecycle !== "queued" || existing.outcome !== null || existing.orchestration?.attempts !== 0 || existing.orchestration.lease || existing.orchestration.cancel_requested_at
        || Object.keys(previous.metadata).some((key) => !["created_by", "client_context_share"].includes(key))
        || !isDeepStrictEqual({ ...previous, metadata: { created_by: previous.metadata.created_by, client_context_share: audit(previous) } }, { ...envelope, metadata: { created_by: envelope.metadata.created_by, client_context_share: audit(envelope) } })
        || Object.keys(manifest.budget).some((key) => existing.orchestration![key as keyof typeof manifest.budget] !== manifest.budget[key as keyof typeof manifest.budget])) throw new ValidationError("Reserved task identity already has different facts", 409);
      return;
    }
    writeTask(record);
    appendTaskEvent({ task_id: envelope.id, type: "policy-evaluated", revision: 1, at, payload: { boundary: "workflow-dispatch", allowed: true, workflow_id: workflow.id, stage_id: stage.id, role_id: stage.role_id } });
    appendTaskEvent({ task_id: envelope.id, type: "queued", revision: 1, at, payload: { source: "dashboard", workflow_id: workflow.id, intent_id: intent.id } });
  });
  return { id: envelope.id };
}
