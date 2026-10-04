import { useCallback, useEffect, useState } from "react";
import type { OverviewModel, RunRecord, ProjectCommands, RunEvent, Inbox, ActivityFeed, DeployHealth, RailwayStatus, TaskDetailModel, TodayModel, WorkSession } from "../../../lib/state/types";
import type { Note } from "../../../lib/state/notes";
import type { ProjectProfile } from "../../../lib/portfolio-profile";
import type { SignalAction, SignalFeed } from "../../../lib/signals/types";
import type { ProjectIntegrationsSnapshot } from "../../../lib/integrations/types";
import type { ClientCommitment, ClientContextCategory, ClientContextOptions, ClientRecord, ClientSummary } from "../../../lib/client-portfolio";
import type { FeedbackMetrics } from "../../../lib/feedback-metrics";
import type { CompanyProfile, Objective, OrganizationSnapshot, ProjectObjectiveLinks } from "../../../lib/organization";
import type { PortfolioProfileMigrationReport } from "../../../lib/state/portfolio-profiles";
import type { IssueCreateInput, IssueLineage, ReviewCandidate, WorkIssue } from "../../../lib/issues/types";
import type { ProjectHarnessProfile } from "../../../lib/harness/types";
import type { AgentRole } from "../../../lib/context/types";
import type { ContextPreview, ContextPreviewRequest } from "../server/context-service";
import type { WorkflowContextService, WorkflowPreviewRequest } from "../server/workflow-context-service";
import type { WorkflowService } from "../server/workflow-service";
import { WORKFLOW_TEMPLATES, type GovernedWorkflow } from "../../../lib/workflows/types";

export type { ContextPreview, ContextPreviewRequest };
export type { WorkflowPreviewRequest };
export type WorkflowPreview = ReturnType<WorkflowContextService["preview"]>;
export type WorkflowDetail = ReturnType<WorkflowService["detail"]>;
export type ContextRole = Pick<AgentRole, "id" | "display_name" | "responsibility" | "sandbox_ceiling"> & { agents: string[] };

export async function getContextRoles(project: string): Promise<{ roles: ContextRole[] }> {
  const response = await fetch(`/api/projects/${encodeURIComponent(project)}/context/roles`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Context profiles unavailable (${response.status})`);
  return response.json() as Promise<{ roles: ContextRole[] }>;
}

export async function previewContext(request: ContextPreviewRequest): Promise<ContextPreview> {
  return issueMutation("/api/context/preview", request);
}

export interface HarnessResponse { observation: ProjectHarnessProfile; saved: ProjectHarnessProfile | null }
export async function getProjectHarness(id: string, refresh = false): Promise<HarnessResponse> {
  const path = `/api/projects/${encodeURIComponent(id)}/harness${refresh ? "/refresh" : ""}`;
  const response = refresh ? await mutate(path) : await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`Harness unavailable (${response.status})`);
  return response.json() as Promise<HarnessResponse>;
}

let sessionTokenPromise: Promise<string> | null = null;
let sessionFetch: typeof fetch | null = null;
const projectIntegrationRequests = new Map<string, Promise<ProjectIntegrationsSnapshot>>();
let feedbackMetricsRequest: Promise<FeedbackMetrics> | null = null;

async function sessionToken(): Promise<string> {
  if (sessionFetch !== fetch) {
    sessionFetch = fetch;
    sessionTokenPromise = null;
  }
  sessionTokenPromise ??= fetch("/api/session", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`session failed: ${response.status}`);
      const body = (await response.json()) as { token?: unknown };
      if (typeof body.token !== "string" || body.token.length < 16) throw new Error("session returned an invalid token");
      return body.token;
    })
    .catch((error) => {
      sessionTokenPromise = null;
      throw error;
    });
  return sessionTokenPromise;
}

async function mutate(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await sessionToken();
  const headers = new Headers(init.headers);
  headers.set("X-Surtec-Session", token);
  return fetch(path, { ...init, method: init.method ?? "POST", headers });
}

export async function fetchOverview(): Promise<OverviewModel> {
  const res = await fetch("/api/overview");
  if (!res.ok) throw new Error(`overview failed: ${res.status}`);
  return (await res.json()) as OverviewModel;
}

export function useOverview(intervalMs = 3000): { data: OverviewModel | null; error: string | null } {
  const [data, setData] = useState<OverviewModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const next = await fetchOverview();
        if (active) { setData(next); setError(null); }
      } catch (err) {
        if (active) setError((err as Error).message); // keep last good data
      }
    };
    void tick();
    const h = setInterval(tick, intervalMs);
    return () => { active = false; clearInterval(h); };
  }, [intervalMs]);

  return { data, error };
}

export async function fetchToday(): Promise<TodayModel> {
  const res = await fetch("/api/today");
  if (!res.ok) throw new Error(`today failed: ${res.status}`);
  return (await res.json()) as TodayModel;
}

export function getFeedbackMetrics(): Promise<FeedbackMetrics> {
  if (feedbackMetricsRequest) return feedbackMetricsRequest;
  const request = fetch("/api/feedback/metrics", { cache: "no-store" })
    .then(async (res) => {
      if (!res.ok) {
        const error = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(error.error ?? `feedback metrics failed: ${res.status}`);
      }
      return await res.json() as FeedbackMetrics;
    });
  feedbackMetricsRequest = request;
  void request.then(
    () => { if (feedbackMetricsRequest === request) feedbackMetricsRequest = null; },
    () => { if (feedbackMetricsRequest === request) feedbackMetricsRequest = null; },
  );
  return request;
}

export async function getPortfolioProfiles(): Promise<{ profiles: ProjectProfile[]; migration?: PortfolioProfileMigrationReport | null }> {
  const res = await fetch("/api/portfolio/profiles", { cache: "no-store" });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `portfolio profiles failed: ${res.status}`);
  }
  return (await res.json()) as { profiles: ProjectProfile[] };
}

export async function getOrganization(): Promise<OrganizationSnapshot> {
  const res = await fetch("/api/organization", { cache: "no-store" });
  if (!res.ok) throw new Error(`organization failed: ${res.status}`);
  return await res.json() as OrganizationSnapshot;
}

export async function saveCompanyProfile(profile: CompanyProfile): Promise<{ company: CompanyProfile }> {
  const res = await mutate("/api/organization/company", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profile),
  });
  if (!res.ok) throw new Error("company profile save failed: " + res.status);
  return await res.json() as { company: CompanyProfile };
}

export async function createObjective(input: Omit<Objective, "schema_version" | "id" | "company_id" | "project_ids" | "owner" | "last_reviewed_at">): Promise<{ objective: Objective }> {
  const res = await mutate("/api/organization/objectives", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error ?? `objective create failed: ${res.status}`);
  }
  return await res.json() as { objective: Objective };
}

export async function saveObjective(objective: Objective): Promise<{ objective: Objective }> {
  const res = await mutate(`/api/organization/objectives/${encodeURIComponent(objective.id)}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(objective),
  });
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error ?? `objective save failed: ${res.status}`);
  }
  return await res.json() as { objective: Objective };
}

export async function saveProjectObjectiveLinks(projectId: string, links: ProjectObjectiveLinks): Promise<{ links: ProjectObjectiveLinks; organization: OrganizationSnapshot }> {
  const res = await mutate(`/api/organization/projects/${encodeURIComponent(projectId)}/objectives`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(links),
  });
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error ?? `objective links save failed: ${res.status}`);
  }
  return await res.json() as { links: ProjectObjectiveLinks; organization: OrganizationSnapshot };
}

export async function saveProjectProfile(profile: ProjectProfile): Promise<{ profile: ProjectProfile }> {
  const res = await mutate(`/api/projects/${encodeURIComponent(profile.project_id)}/profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `project profile save failed: ${res.status}`);
  }
  return (await res.json()) as { profile: ProjectProfile };
}

export async function getClients(): Promise<{ clients: ClientSummary[] }> {
  const res = await fetch("/api/clients", { cache: "no-store" });
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error ?? "clients failed: " + res.status);
  }
  return (await res.json()) as { clients: ClientSummary[] };
}

export async function getClient(id: string): Promise<{ client: ClientRecord }> {
  const res = await fetch("/api/clients/" + encodeURIComponent(id), { cache: "no-store" });
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error ?? "client failed: " + res.status);
  }
  return (await res.json()) as { client: ClientRecord };
}

export async function saveClient(input: Omit<ClientRecord, "id" | "created_at" | "updated_at">, id?: string): Promise<{ client: ClientRecord }> {
  const path = id ? "/api/clients/" + encodeURIComponent(id) : "/api/clients";
  const res = await mutate(path, {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error ?? "client save failed: " + res.status);
  }
  return (await res.json()) as { client: ClientRecord };
}

export async function getCommitments(): Promise<{ commitments: ClientCommitment[] }> {
  const res = await fetch("/api/commitments", { cache: "no-store" });
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error ?? "commitments failed: " + res.status);
  }
  return (await res.json()) as { commitments: ClientCommitment[] };
}

export async function saveCommitment(
  input: Omit<ClientCommitment, "id" | "created_at" | "updated_at">,
  id?: string,
): Promise<{ commitment: ClientCommitment }> {
  const path = id ? "/api/commitments/" + encodeURIComponent(id) : "/api/commitments";
  const res = await mutate(path, {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error ?? "commitment save failed: " + res.status);
  }
  return (await res.json()) as { commitment: ClientCommitment };
}

export async function getClientContextOptions(projectId: string): Promise<ClientContextOptions> {
  const res = await fetch("/api/projects/" + encodeURIComponent(projectId) + "/client-context-options", { cache: "no-store" });
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error ?? "client context options failed: " + res.status);
  }
  return (await res.json()) as ClientContextOptions;
}

async function workSessionMutation(path: string, body: unknown): Promise<WorkSession> {
  const res = await mutate(path, { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error ?? `work session action failed: ${res.status}`);
  }
  const result = (await res.json()) as { session: WorkSession };
  return result.session;
}

export function startWorkSession(input: {
  project_id: string;
  objective: string;
  related_task_ids?: string[];
  related_run_ids?: string[];
}): Promise<WorkSession> {
  return workSessionMutation("/api/sessions", input);
}

export function actOnWorkSession(id: string, action:
  | { action: "add-note"; note: string }
  | { action: "associate"; task_ids?: string[]; run_ids?: string[] }
  | { action: "pause"; next_action: string }
  | { action: "resume" }
  | { action: "complete"; result_summary: string; next_action: string }): Promise<WorkSession> {
  return workSessionMutation(`/api/sessions/${encodeURIComponent(id)}/action`, action);
}

export function useToday(intervalMs = 3000): { data: TodayModel | null; error: string | null; refresh: () => Promise<TodayModel> } {
  const [data, setData] = useState<TodayModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const next = await fetchToday();
      setData(next);
      setError(null);
      return next;
    } catch (reason) {
      setError((reason as Error).message);
      throw reason;
    }
  }, []);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const next = await fetchToday();
        if (active) { setData(next); setError(null); }
      } catch (reason) { if (active) setError((reason as Error).message); }
    };
    void tick();
    const handle = setInterval(tick, intervalMs);
    return () => { active = false; clearInterval(handle); };
  }, [intervalMs]);

  return { data, error, refresh };
}

export async function postSignalAction(signalId: string, action: SignalAction): Promise<SignalFeed> {
  const res = await mutate(`/api/signals/${encodeURIComponent(signalId)}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `signal action failed: ${res.status}`);
  }
  return (await res.json()) as SignalFeed;
}

export async function fetchTaskDetail(id: string): Promise<TaskDetailModel> {
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}/detail`);
  if (!res.ok) throw new Error(`task detail failed: ${res.status}`);
  return (await res.json()) as TaskDetailModel;
}

export async function getInbox(): Promise<Inbox> {
  const res = await fetch("/api/inbox");
  if (!res.ok) throw new Error(`inbox failed: ${res.status}`);
  return (await res.json()) as Inbox;
}

export async function getActivity(): Promise<ActivityFeed> {
  const res = await fetch("/api/activity");
  if (!res.ok) throw new Error(`activity failed: ${res.status}`);
  return (await res.json()) as ActivityFeed;
}

export async function getProjectIntegrations(id: string, refresh = false): Promise<ProjectIntegrationsSnapshot> {
  const requestKey = `${id}:${refresh ? "refresh" : "cached"}`;
  const existing = projectIntegrationRequests.get(requestKey);
  if (existing) return existing;
  const query = refresh ? "?refresh=true" : "";
  const request = fetch(`/api/projects/${encodeURIComponent(id)}/integrations${query}`, { cache: "no-store" })
    .then(async (res) => {
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? `project integrations failed: ${res.status}`);
      }
      return (await res.json()) as ProjectIntegrationsSnapshot;
    });
  projectIntegrationRequests.set(requestKey, request);
  try { return await request; }
  finally { if (projectIntegrationRequests.get(requestKey) === request) projectIntegrationRequests.delete(requestKey); }
}

export async function getSignals(): Promise<SignalFeed> {
  const res = await fetch("/api/signals", { cache: "no-store" });
  if (!res.ok) throw new Error(`signals failed: ${res.status}`);
  return (await res.json()) as SignalFeed;
}

export async function getDeploy(id: string): Promise<DeployHealth> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/deploy`);
  if (!res.ok) throw new Error(`deploy failed: ${res.status}`);
  return (await res.json()) as DeployHealth;
}

export async function getRailway(id: string): Promise<RailwayStatus> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/railway`);
  if (!res.ok) throw new Error(`railway failed: ${res.status}`);
  return (await res.json()) as RailwayStatus;
}

export type DispatchMode = "read-only" | "workspace-write" | "workspace-write-verify";

export interface DispatchModeCapability {
  mode: DispatchMode;
  allowed: boolean;
  reason: string | null;
}

export interface DispatchAgentCapability {
  agent: string;
  agent_sandbox_ceiling: "read-only" | "workspace-write";
  allowed_modes: DispatchMode[];
  default_mode: DispatchMode | null;
  modes: DispatchModeCapability[];
}

export interface DispatchProjectCapability {
  project: string;
  allowed_agents: string[];
  project_sandbox_ceiling: "read-only" | "workspace-write";
  has_local_checkout: boolean;
  has_verification_commands: boolean;
  agents: DispatchAgentCapability[];
}

export interface DispatchOptions {
  projects: DispatchProjectCapability[];
}

export async function fetchDispatchOptions(): Promise<DispatchOptions> {
  const res = await fetch("/api/dispatch-options");
  if (!res.ok) throw new Error(`dispatch-options failed: ${res.status}`);
  return (await res.json()) as DispatchOptions;
}

async function issueMutation<T>(path: string, body: unknown): Promise<T> {
  const res = await mutate(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const error = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error ?? `local issue operation failed: ${res.status}`);
  }
  return await res.json() as T;
}

async function workflowResponse<T>(path: string, body?: unknown): Promise<T> {
  const response = body === undefined ? await fetch(path, { cache: "no-store" })
    : await mutate(path, { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  // Rotate only for a later explicit action, never replay a confirmation.
  if (response.status === 403) sessionTokenPromise = null;
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(error.error ?? `Workflow unavailable (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function supportedWorkflow(value: GovernedWorkflow | null | undefined): boolean {
  return Boolean(value && value.schema_version === 1 && value.template_version === 1 && WORKFLOW_TEMPLATES.includes(value.template_id)
    && ["running", "waiting-human", "needs-decision", "completed", "cancelled"].includes(value.status)
    && [value.id, value.issue_id, value.project_id, value.current_grant_id].every((id) => typeof id === "string" && id.length > 0)
    && [value.revision, value.scope_revision, value.authority_revision].every((revision) => Number.isSafeInteger(revision) && revision > 0));
}

export async function getWorkflows(issueId?: string): Promise<{ workflows: GovernedWorkflow[] }> {
  const value = await workflowResponse<{ workflows: GovernedWorkflow[] }>(`/api/workflows${issueId ? `?issue_id=${encodeURIComponent(issueId)}` : ""}`);
  if (!Array.isArray(value?.workflows) || value.workflows.some((entry) => !supportedWorkflow(entry))
    || new Set(value.workflows.map((entry) => entry.id)).size !== value.workflows.length) {
    throw new Error("Unsupported workflow list; no empty ownership is inferred");
  }
  return value;
}

export async function getWorkflow(id: string): Promise<WorkflowDetail> {
  const value = await workflowResponse<WorkflowDetail>(`/api/workflows/${encodeURIComponent(id)}`);
  if (value?.schema_version !== 1 || !supportedWorkflow(value.workflow) || value.workflow.id !== id || value.grant?.schema_version !== 1
    || value.workflow.current_grant_id !== value.grant.id || value.grant.workflow_id !== id
    || value.grant.issue_id !== value.workflow.issue_id || value.grant.project_id !== value.workflow.project_id
    || value.grant.authority_revision !== value.workflow.authority_revision || typeof value.execution_enabled !== "boolean"
    || !Array.isArray(value.grant.role_assignments)
    || [value.stages, value.decisions, value.handoffs, value.review_receipts, value.admission_intents, value.accounting, value.events]
      .some((records) => !Array.isArray(records) || records.some((entry) => !entry || entry.schema_version !== 1 || typeof entry.id !== "string"))
    || value.lineage !== null && value.lineage?.schema_version !== 1) {
    throw new Error("Unsupported workflow detail; refresh its current authority");
  }
  return value;
}

export function previewWorkflow(request: WorkflowPreviewRequest): Promise<WorkflowPreview> {
  return workflowResponse("/api/workflows/preview", request);
}

export function startWorkflow(request: WorkflowPreviewRequest, fingerprint: string): Promise<WorkflowDetail> {
  return workflowResponse("/api/workflows/start", { request, preview_fingerprint: fingerprint, confirm: true, approval_id: `local-${crypto.randomUUID()}` });
}

export interface WorkflowDecisionInput {
  expected_revision: number; expected_issue_revision: number; decision_id: string; resource_fingerprint: string;
  decision: "approve" | "reject"; rationale: string; confirmed_criteria?: string[];
}
export function decideWorkflow(id: string, input: WorkflowDecisionInput): Promise<WorkflowDetail> {
  return workflowResponse(`/api/workflows/${encodeURIComponent(id)}/decision`, { ...input, confirm: true, approval_id: `local-${crypto.randomUUID()}` });
}

export function controlWorkflow(id: string, action: "cancel" | "recover", workflowRevision: number, issueRevision: number): Promise<WorkflowDetail> {
  return workflowResponse(`/api/workflows/${encodeURIComponent(id)}/${action}`, { expected_revision: workflowRevision, expected_issue_revision: issueRevision });
}

export async function getWorkIssues(): Promise<{ issues: WorkIssue[] }> {
  const res = await fetch("/api/work-issues", { cache: "no-store" });
  if (!res.ok) throw new Error(`local issues failed: ${res.status}`);
  return await res.json() as { issues: WorkIssue[] };
}

export async function getWorkIssue(id: string): Promise<IssueLineage> {
  const res = await fetch(`/api/work-issues/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`local issue detail failed: ${res.status}`);
  return await res.json() as IssueLineage;
}

export async function createWorkIssue(input: IssueCreateInput): Promise<{ issue: WorkIssue }> {
  return issueMutation("/api/work-issues", input);
}

export async function authorizeWorkIssue(id: string, expectedRevision: number): Promise<{ issue: WorkIssue }> {
  return issueMutation(`/api/work-issues/${encodeURIComponent(id)}/authorize`, { expected_revision: expectedRevision, approval_id: `local-${crypto.randomUUID()}` });
}

export async function dispatchWorkIssue(id: string, expectedRevision: number, agent: string, admission: {
  role_id: string; preview_fingerprint: string; client_context_categories: ClientContextCategory[];
}): Promise<{ issue: WorkIssue; task_id: string }> {
  return issueMutation(`/api/work-issues/${encodeURIComponent(id)}/dispatch`, { expected_revision: expectedRevision, agent, ...admission });
}

export async function approveWorkIssueScope(issue: WorkIssue): Promise<{ issue: WorkIssue }> {
  const proposal = issue.scope_change_proposal;
  if (!proposal) throw new Error("scope proposal is no longer available");
  return issueMutation(`/api/work-issues/${encodeURIComponent(issue.id)}/scope-decision`, {
    decision: "approve", expected_revision: issue.revision, proposal_id: proposal.id, approval_id: `local-${crypto.randomUUID()}`,
  });
}

export async function rejectWorkIssueScope(issue: WorkIssue): Promise<{ issue: WorkIssue }> {
  const proposal = issue.scope_change_proposal;
  if (!proposal) throw new Error("scope proposal is no longer available");
  return issueMutation(`/api/work-issues/${encodeURIComponent(issue.id)}/scope-decision`, {
    decision: "reject", expected_revision: issue.revision, proposal_id: proposal.id,
    rationale: "The proposed scope expansion was not approved; cancel this issue rather than silently widening it.",
  });
}

export async function resumeWorkIssue(issue: WorkIssue): Promise<{ issue: WorkIssue }> {
  return issueMutation(`/api/work-issues/${encodeURIComponent(issue.id)}/resume`, {
    expected_revision: issue.revision, rationale: "Blocker reviewed locally; resume authorized by the owner.",
  });
}

export async function resolveWorkIssueDecision(issue: WorkIssue): Promise<{ issue: WorkIssue }> {
  return issueMutation(`/api/work-issues/${encodeURIComponent(issue.id)}/resolve-decision`, {
    expected_revision: issue.revision, approval_id: `local-${crypto.randomUUID()}`,
    rationale: "Verification gap reviewed; authorize another attempt under the unchanged scope.",
  });
}

export async function acceptWorkIssueCandidate(issue: WorkIssue, candidate: ReviewCandidate, confirmedCriteria: string[], acknowledgeEvidenceGaps: boolean): Promise<{ issue: WorkIssue }> {
  return issueMutation(`/api/work-issues/${encodeURIComponent(issue.id)}/accept`, {
    expected_revision: issue.revision, candidate_id: candidate.id, fingerprint: candidate.diff_fingerprint,
    approval_id: `local-${crypto.randomUUID()}`, rationale: "Accepted locally after reviewing the exact candidate.",
    confirmed_criteria: confirmedCriteria, acknowledge_evidence_gaps: acknowledgeEvidenceGaps,
  });
}

export async function createTask(body: {
  project: string;
  agent: string;
  instructions: string;
  role_id: string;
  preview_fingerprint: string;
  sandbox?: string;
  self_verify?: boolean;
  client_context_categories?: ClientContextCategory[];
}): Promise<{ id: string }> {
  const res = await mutate("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `dispatch failed: ${res.status}`);
  }
  return (await res.json()) as { id: string };
}

async function decide(id: string, action: "approve" | "reject"): Promise<{ decision: unknown }> {
  const res = await mutate(`/api/tasks/${encodeURIComponent(id)}/${action}`);
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `${action} failed: ${res.status}`);
  }
  return (await res.json()) as { decision: unknown };
}

export function approveTask(id: string): Promise<{ decision: unknown }> {
  return decide(id, "approve");
}

export function rejectTask(id: string): Promise<{ decision: unknown }> {
  return decide(id, "reject");
}

async function controlTask(id: string, action: "cancel" | "retry"): Promise<void> {
  const res = await mutate(`/api/tasks/${encodeURIComponent(id)}/${action}`);
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `${action} failed: ${res.status}`);
  }
}

export function cancelTask(id: string): Promise<void> {
  return controlTask(id, "cancel");
}

export function retryTask(id: string): Promise<void> {
  return controlTask(id, "retry");
}

export async function openProject(id: string, target: "vscode" | "folder"): Promise<void> {
  const res = await mutate(`/api/projects/${encodeURIComponent(id)}/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `open failed: ${res.status}`);
  }
}

export async function listRuns(): Promise<{ runs: RunRecord[] }> {
  const res = await fetch("/api/runs");
  if (!res.ok) throw new Error(`runs failed: ${res.status}`);
  return (await res.json()) as { runs: RunRecord[] };
}

export async function getProjectCommands(
  id: string,
): Promise<{ commands: ProjectCommands; running: { dev: string | null; oneshot: string | null } }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/commands`);
  if (!res.ok) throw new Error(`commands failed: ${res.status}`);
  return (await res.json()) as { commands: ProjectCommands; running: { dev: string | null; oneshot: string | null } };
}

export async function runProject(id: string, command: string): Promise<{ runId: string }> {
  const res = await mutate(`/api/projects/${encodeURIComponent(id)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `run failed: ${res.status}`);
  }
  return (await res.json()) as { runId: string };
}

export async function stopRun(runId: string): Promise<void> {
  const res = await mutate(`/api/runs/${encodeURIComponent(runId)}/stop`);
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `stop failed: ${res.status}`);
  }
}

export async function getRun(runId: string): Promise<{ record: RunRecord; log: string }> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
  if (!res.ok) throw new Error(`run failed: ${res.status}`);
  return (await res.json()) as { record: RunRecord; log: string };
}

// Opens an SSE stream for a run. Calls the matching handler per event and returns a close() fn.
export function streamRun(
  runId: string,
  on: { snapshot?: (s: { record: RunRecord; log: string }) => void; chunk?: (data: string) => void; status?: (r: RunRecord) => void },
): () => void {
  const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);
  es.addEventListener("snapshot", (ev) => {
    const e = JSON.parse((ev as MessageEvent).data) as Extract<RunEvent, { type: "snapshot" }>;
    on.snapshot?.({ record: e.record, log: e.log });
  });
  es.addEventListener("chunk", (ev) => {
    const e = JSON.parse((ev as MessageEvent).data) as Extract<RunEvent, { type: "chunk" }>;
    on.chunk?.(e.data);
  });
  es.addEventListener("status", (ev) => {
    const e = JSON.parse((ev as MessageEvent).data) as Extract<RunEvent, { type: "status" }>;
    on.status?.(e.record);
    es.close();
  });
  es.addEventListener("error", () => es.close());
  return () => es.close();
}

export async function gitSync(
  id: string, action: "fetch" | "pull" | "push",
): Promise<{ ok: boolean; action: string; output: string }> {
  const res = await mutate(`/api/projects/${encodeURIComponent(id)}/git`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `git ${action} failed: ${res.status}`);
  }
  return (await res.json()) as { ok: boolean; action: string; output: string };
}

export async function getBranches(id: string): Promise<{ branches: string[]; current: string | null }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/branches`);
  if (!res.ok) throw new Error(`branches failed: ${res.status}`);
  return (await res.json()) as { branches: string[]; current: string | null };
}

export async function branchOp(
  id: string, op: "switch" | "create", name: string,
): Promise<{ ok: boolean; output: string }> {
  const res = await mutate(`/api/projects/${encodeURIComponent(id)}/branch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op, name }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `branch ${op} failed: ${res.status}`);
  }
  return (await res.json()) as { ok: boolean; output: string };
}

export async function getGithubCounts(
  id: string,
): Promise<{ ok: boolean; prs: number; issues: number; ci: "passing" | "failing" | "running" | "none" | "unknown"; error?: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/github`);
  if (!res.ok) throw new Error(`github failed: ${res.status}`);
  return (await res.json()) as { ok: boolean; prs: number; issues: number; ci: "passing" | "failing" | "running" | "none" | "unknown"; error?: string };
}

export async function getDeps(id: string): Promise<{ ok: boolean; outdated: number; error?: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/deps`);
  if (!res.ok) throw new Error(`deps failed: ${res.status}`);
  return (await res.json()) as { ok: boolean; outdated: number; error?: string };
}

export async function getNotes(id: string): Promise<{ notes: Note[] }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/notes`);
  if (!res.ok) throw new Error(`notes failed: ${res.status}`);
  return (await res.json()) as { notes: Note[] };
}

export async function addNote(id: string, text: string): Promise<{ notes: Note[] }> {
  const res = await mutate(`/api/projects/${encodeURIComponent(id)}/notes`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `add note failed: ${res.status}`);
  }
  return (await res.json()) as { notes: Note[] };
}

export async function mutateNote(id: string, noteId: string, action: "toggle" | "delete"): Promise<{ notes: Note[] }> {
  const res = await mutate(`/api/projects/${encodeURIComponent(id)}/notes/${encodeURIComponent(noteId)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error ?? `note ${action} failed: ${res.status}`);
  }
  return (await res.json()) as { notes: Note[] };
}
