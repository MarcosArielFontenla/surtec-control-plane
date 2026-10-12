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
import type { BudgetReadQuery, BudgetReadView, RoutineConfigureInput, RoutineCreateInput, RoutineDetail, RoutineList,
  RoutineOccurrenceSummary, RoutineRevisionInput, RoutineRunResult, RoutineSummary } from "../server/routine-service";
import { WORKFLOW_TEMPLATES, type GovernedWorkflow } from "../../../lib/workflows/types";
import { ROUTINE_ACTIONS, ROUTINE_EVIDENCE_KINDS } from "../../../lib/routines/types";

export type { ContextPreview, ContextPreviewRequest };
export type { WorkflowPreviewRequest };
export type { BudgetReadQuery, BudgetReadView, RoutineConfigureInput, RoutineCreateInput, RoutineDetail, RoutineList,
  RoutineOccurrenceSummary, RoutineRevisionInput, RoutineRunResult, RoutineSummary };
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

async function routineResponse<T>(path: string, mutation?: { method: "POST" | "PUT"; body: unknown }): Promise<T> {
  const response = mutation === undefined ? await fetch(path, { cache: "no-store" })
    : await mutate(path, { method: mutation.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(mutation.body) });
  // A stale session needs a new explicit action; never replay configuration or execution.
  if (response.status === 403) sessionTokenPromise = null;
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(error.error ?? `Operational resource unavailable (${response.status})`);
  }
  return response.json() as Promise<T>;
}

// Browser-side compatibility/receipt guards only. These do not grant consent,
// reserve capacity or establish private worker ownership.
function routineFields(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === keys.length && keys.every((key) => {
    const entry = descriptors[key]; return entry?.enumerable === true && Object.hasOwn(entry, "value");
  });
}
function routineArray(value: unknown, limit: number, check: (entry: any) => boolean): value is any[] {
  if (!Array.isArray(value) || value.length > limit || Reflect.ownKeys(value).length !== value.length + 1) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index++) {
    const entry = descriptors[String(index)];
    if (!entry?.enumerable || !Object.hasOwn(entry, "value") || !check(entry.value)) return false;
  }
  return true;
}
const routineInteger = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const routineId = (value: unknown): value is string => typeof value === "string"
  && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$(?![\s\S])/.test(value) && !value.includes("..")
  && !["constructor", "prototype", "__proto__"].includes(value);
const routineHash = (value: unknown): boolean => typeof value === "string" && /^[a-f0-9]{64}$(?![\s\S])/.test(value);
function routineTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$(?![\s\S])/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && Number(value.slice(0, 4)) > 0 && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19);
}
const routineNullableTime = (value: unknown): boolean => value === null || routineTime(value);
const routineEnum = (value: unknown, choices: readonly string[]): boolean => typeof value === "string" && choices.includes(value);
function routineScope(value: unknown): boolean {
  return routineFields(value, ["kind", "id"]) && routineId(value.id)
    && (value.kind === "company" ? value.id === "surtec" : routineEnum(value.kind, ["project", "objective"]));
}
function routineRecord(value: unknown): value is RoutineSummary["routine"] {
  if (!routineFields(value, ["schema_version", "id", "revision", "action", "scope", "enabled", "schedule", "schedule_anchor_at", "concurrency", "catch_up", "policy", "limits", "created_at", "updated_at"])) return false;
  const policy = value.policy, limits = value.limits;
  const interval = typeof value.schedule === "string" && /^every:([1-9][0-9]*)m$(?![\s\S])/.exec(value.schedule);
  return value.schema_version === 1 && routineId(value.id) && routineInteger(value.revision) && value.revision > 0
    && routineEnum(value.action, ROUTINE_ACTIONS) && routineScope(value.scope) && typeof value.enabled === "boolean"
    && (value.schedule === null ? value.schedule_anchor_at === null : !!interval && Number(interval[1]) >= 15 && Number(interval[1]) <= 10080
      && routineTime(value.schedule_anchor_at) && routineTime(value.updated_at) && Date.parse(value.schedule_anchor_at) === Date.parse(value.updated_at))
    && routineEnum(value.concurrency, ["skip", "coalesce"]) && routineEnum(value.catch_up, ["skip-missed", "run-once"])
    && routineFields(policy, ["revision", "fingerprint", "policy_ids"]) && routineInteger(policy.revision) && policy.revision > 0 && routineHash(policy.fingerprint)
    && routineArray(policy.policy_ids, 64, routineId) && policy.policy_ids.length > 0 && new Set(policy.policy_ids).size === policy.policy_ids.length
    && routineFields(limits, ["max_projects", "max_attempts", "max_runtime_ms", "max_concurrent_occurrences"])
    && routineInteger(limits.max_projects, 25) && limits.max_projects > 0 && limits.max_attempts === 1
    && routineInteger(limits.max_runtime_ms, 60000) && limits.max_runtime_ms > 0 && limits.max_concurrent_occurrences === 1
    && routineTime(value.created_at) && routineTime(value.updated_at) && Date.parse(value.created_at) <= Date.parse(value.updated_at);
}
function routineReceipt(value: unknown, occurrence: Record<string, unknown>): boolean {
  if (!routineFields(value, ["schema_version", "occurrence_id", "occurrence_key", "routine_id", "routine_revision", "slot", "action", "scope", "policy_fingerprint", "cap_fingerprint", "project_ids", "started_at", "finished_at", "captured_at", "freshness", "sources", "counts", "consumption", "budget_outcome", "proposals", "failure_code", "next_action"])) return false;
  const counts = value.counts, consumption = value.consumption;
  if (!routineFields(counts, ["projects_selected", "facts_total", "facts_fresh", "facts_unavailable", "signals_evaluated", "proposals_created", "reports_written"])
    || !routineFields(consumption, ["attempts", "runtime_ms", "runtime_state", "model_calls", "total_tokens", "workspace_writes"])) return false;
  return value.schema_version === 1 && value.occurrence_id === occurrence.id && routineHash(value.occurrence_key)
    && value.routine_id === occurrence.routine_id && value.routine_revision === occurrence.routine_revision
    && routineTime(value.slot) && Date.parse(value.slot) === Date.parse(occurrence.slot as string)
    && routineEnum(value.action, ROUTINE_ACTIONS) && routineScope(value.scope) && routineHash(value.policy_fingerprint) && routineHash(value.cap_fingerprint)
    && routineArray(value.project_ids, 25, routineId) && new Set(value.project_ids).size === value.project_ids.length
    && value.started_at === occurrence.started_at && value.finished_at === occurrence.finished_at && routineTime(value.captured_at)
    && routineEnum(value.freshness, ["fresh", "partial", "stale", "unavailable"])
    && routineArray(value.sources, 10000, (source) => routineFields(source, ["kind", "project_id", "state", "observed_at", "fingerprint"])
      && routineEnum(source.kind, ROUTINE_EVIDENCE_KINDS) && (source.project_id === null || routineId(source.project_id) && (value.project_ids as string[]).includes(source.project_id))
      && routineEnum(source.state, ["fresh", "stale", "unavailable"]) && routineNullableTime(source.observed_at)
      && (source.fingerprint === null || routineHash(source.fingerprint)) && (source.observed_at === null) === (source.fingerprint === null)
      && (source.state === "unavailable" || source.observed_at !== null) && (source.observed_at === null || Date.parse(source.observed_at as string) <= Date.parse(value.captured_at as string)))
    && new Set(value.sources.map((source: any) => JSON.stringify([source.kind, source.project_id]))).size === value.sources.length
    && Object.values(counts).every((count) => routineInteger(count, 10000)) && counts.projects_selected === value.project_ids.length
    && counts.facts_total === value.sources.length && counts.facts_fresh === value.sources.filter((source: any) => source.state === "fresh").length
    && counts.facts_unavailable === value.sources.filter((source: any) => source.state === "unavailable").length && routineInteger(counts.reports_written, 1)
    && (consumption.attempts === null || consumption.attempts === 0 || consumption.attempts === 1)
    && (consumption.runtime_ms === null || routineInteger(consumption.runtime_ms)) && routineEnum(consumption.runtime_state, ["complete", "unknown"])
    && (consumption.runtime_state !== "complete" || consumption.runtime_ms !== null && consumption.attempts !== null
      && (consumption.attempts === 0 || value.finished_at !== null))
    && (consumption.attempts !== 0 || value.started_at === null && consumption.runtime_ms === 0 && consumption.runtime_state === "complete"
      && counts.signals_evaluated === 0 && counts.proposals_created === 0 && counts.reports_written === 0)
    && (consumption.attempts !== 1 || value.started_at !== null)
    && consumption.model_calls === 0 && consumption.total_tokens === 0 && consumption.workspace_writes === 0
    && routineEnum(value.budget_outcome, ["within-limit", "exhausted", "denied", "unknown"])
    && routineArray(value.proposals, 10000, (proposal) => routineFields(proposal, ["key", "fingerprint", "issue_id"])
      && routineHash(proposal.key) && routineHash(proposal.fingerprint) && (proposal.issue_id === null || routineId(proposal.issue_id)))
    && (value.failure_code === null || routineEnum(value.failure_code, ["budget-denied", "budget-exhausted", "accounting-unavailable", "ownership-unavailable", "source-unavailable", "scope-too-large", "state-invalid", "action-failed", "cancelled", "deadline-exceeded"]))
    && routineEnum(value.next_action, ["none", "inspect-evidence", "review-proposals", "inspect-budget", "resolve-ownership", "run-new-occurrence"])
    && (value.started_at === null || Date.parse(value.started_at as string) <= Date.parse(value.captured_at as string))
    && (value.finished_at === null || Date.parse(value.finished_at as string) <= Date.parse(value.captured_at as string))
    && counts.proposals_created === value.proposals.filter((proposal: any) => proposal.issue_id !== null).length
    && new Set(value.proposals.map((proposal: any) => proposal.key)).size === value.proposals.length
    && new Set(value.proposals.filter((proposal: any) => proposal.issue_id !== null).map((proposal: any) => proposal.issue_id)).size === counts.proposals_created
    && (counts.proposals_created === 0 || value.next_action === "review-proposals")
    && (value.action === "propose-issues" || value.proposals.length === 0) && (value.action === "generate-local-report" || counts.reports_written === 0)
    && (value.failure_code === null || value.next_action !== "none")
    && (value.budget_outcome !== "denied" || consumption.attempts === 0 && value.failure_code !== null)
    && (consumption.runtime_state !== "unknown" || ["unknown", "exhausted"].includes(value.budget_outcome as string))
    && (!["unknown", "exhausted"].includes(value.budget_outcome as string) || value.freshness !== "fresh" && value.failure_code !== null)
    && (value.freshness !== "fresh" || value.sources.length > 0 && value.sources.every((source: any) => source.state === "fresh")
      && consumption.attempts === 1 && consumption.runtime_state === "complete" && value.finished_at !== null
      && value.budget_outcome === "within-limit" && value.failure_code === null && (value.action !== "generate-local-report" || counts.reports_written === 1));
}
function routineOccurrence(value: unknown, id: string, revision = Number.MAX_SAFE_INTEGER): value is NonNullable<RoutineSummary["last_occurrence"]> {
  return routineFields(value, ["id", "routine_id", "routine_revision", "slot", "trigger", "status", "started_at", "finished_at", "cancel_requested_at", "receipt"])
    && routineId(value.id) && value.routine_id === id && routineInteger(value.routine_revision, revision) && value.routine_revision > 0 && routineTime(value.slot)
    && routineEnum(value.trigger, ["scheduled", "manual", "catch-up", "coalesced"])
    && routineEnum(value.status, ["reserved", "running", "completed", "partial", "failed", "cancelled", "needs-review"])
    && routineNullableTime(value.started_at) && routineNullableTime(value.finished_at) && routineNullableTime(value.cancel_requested_at)
    && (value.started_at === null || value.finished_at === null || Date.parse(value.started_at as string) <= Date.parse(value.finished_at as string))
    && (["reserved", "running"].includes(value.status as string) ? value.receipt === null && value.finished_at === null
      && (value.status === "reserved" ? value.started_at === null : value.started_at !== null)
      : routineReceipt(value.receipt, value) && (value.status === "needs-review" || value.finished_at !== null)
        && (value.status === "completed" ? (value.receipt as any).freshness === "fresh" : (value.receipt as any).freshness !== "fresh")
        && (!["failed", "cancelled", "needs-review"].includes(value.status as string) || (value.receipt as any).failure_code !== null)
        && (value.status !== "cancelled" || value.cancel_requested_at !== null && (value.receipt as any).failure_code === "cancelled"));
}
function routineSummary(value: unknown, detail = false): value is RoutineSummary {
  return routineFields(value, ["routine", "last_occurrence", "next_slot", "occurrences_total", ...(detail ? ["occurrences", "execution"] : [])])
    && routineRecord(value.routine) && routineInteger(value.occurrences_total, 10000)
    && (value.occurrences_total === 0 ? value.last_occurrence === null : routineOccurrence(value.last_occurrence, value.routine.id, value.routine.revision))
    && routineNullableTime(value.next_slot) && (value.next_slot === null || value.routine.enabled && value.routine.schedule !== null
      && Date.parse(value.next_slot as string) > Date.parse(value.routine.schedule_anchor_at!)
      && (Date.parse(value.next_slot as string) - Date.parse(value.routine.schedule_anchor_at!)) % (Number(value.routine.schedule.slice(6, -1)) * 60000) === 0);
}
function routineDetail(value: unknown, id?: string): asserts value is RoutineDetail {
  if (!routineSummary(value, true)) throw new Error("Unsupported routine detail; reload before a new explicit action");
  const detail = value as RoutineDetail;
  if (id !== undefined && detail.routine.id !== id || !routineFields(detail.execution, ["state", "executable"])
    || !routineEnum(detail.execution.state, ["inactive", "fixture-enabled"]) || detail.execution.executable !== false
    || !routineArray(detail.occurrences, 20, (entry) => routineOccurrence(entry, detail.routine.id, detail.routine.revision))
    || detail.occurrences.length !== Math.min(20, detail.occurrences_total) || new Set(detail.occurrences.map((entry) => entry.id)).size !== detail.occurrences.length
    || detail.occurrences.length > 0 && JSON.stringify(detail.last_occurrence) !== JSON.stringify(detail.occurrences[0])) {
    throw new Error("Unsupported routine detail; reload before a new explicit action");
  }
}
export async function fetchRoutines(): Promise<RoutineList> {
  const value = await routineResponse<RoutineList>("/api/routines");
  if (!routineFields(value, ["schema_version", "state", "observed_at", "revision", "routines"]) || value.schema_version !== 1
    || !routineEnum(value.state, ["absent", "available", "unavailable"]) || !routineNullableTime(value.observed_at)
    || !routineArray(value.routines, 10000, (entry) => routineSummary(entry)) || new Set(value.routines.map((entry) => entry.routine.id)).size !== value.routines.length
    || (value.state === "available" ? !routineInteger(value.revision) || value.revision < 1 || value.observed_at === null
      : value.routines.length !== 0 || value.revision !== null || value.state === "absent" && value.observed_at === null || value.state === "unavailable" && value.observed_at !== null)) {
    throw new Error("Unsupported routine list; no empty or fresh state is inferred");
  }
  return value;
}
export async function fetchRoutine(id: string): Promise<RoutineDetail> {
  const value = await routineResponse<RoutineDetail>(`/api/routines/${encodeURIComponent(id)}`); routineDetail(value, id); return value;
}
export async function createRoutine(input: RoutineCreateInput): Promise<RoutineDetail> {
  const value = await routineResponse<RoutineDetail>("/api/routines", { method: "POST", body: input }); routineDetail(value);
  if (value.routine.revision !== 1 || value.routine.enabled || value.routine.schedule !== null || value.occurrences_total !== 0
    || value.routine.action !== input.action || value.routine.scope.kind !== input.scope.kind || value.routine.scope.id !== input.scope.id) {
    throw new Error("Unsupported routine creation receipt; inspect current evidence without replay");
  }
  return value;
}
export async function configureRoutine(id: string, input: RoutineConfigureInput): Promise<RoutineDetail> {
  const value = await routineResponse<RoutineDetail>(`/api/routines/${encodeURIComponent(id)}`, { method: "PUT", body: input }); routineDetail(value, id);
  if (value.routine.revision !== input.expected_revision + 1 || value.routine.action !== input.action
    || value.routine.scope.kind !== input.scope.kind || value.routine.scope.id !== input.scope.id || value.routine.enabled !== input.enabled
    || value.routine.schedule !== input.schedule || value.routine.concurrency !== input.concurrency || value.routine.catch_up !== input.catch_up) {
    throw new Error("Unsupported routine configuration receipt; inspect current evidence without replay");
  }
  return value;
}
export async function runRoutine(id: string, expectedRevision: number): Promise<RoutineRunResult> {
  const value = await routineResponse<RoutineRunResult>(`/api/routines/${encodeURIComponent(id)}/run`, { method: "POST", body: { expected_revision: expectedRevision } });
  if (!routineFields(value, ["status", "occurrence", "execution"]) || !routineEnum(value.status, ["admitted", "existing"])
    || !routineOccurrence(value.occurrence, id, expectedRevision) || value.occurrence.routine_revision !== expectedRevision
    || value.occurrence.trigger !== "manual" || value.status === "admitted" && value.occurrence.status !== "running"
    || !routineFields(value.execution, ["state", "executable"]) || value.execution.state !== "fixture-enabled" || value.execution.executable !== false) {
    throw new Error("Unsupported routine execution receipt; inspect current evidence without replay");
  }
  return value;
}
export async function disableRoutine(id: string, expectedRevision: number): Promise<RoutineDetail> {
  const value = await routineResponse<RoutineDetail>(`/api/routines/${encodeURIComponent(id)}/disable`, { method: "POST", body: { expected_revision: expectedRevision } }); routineDetail(value, id);
  if (value.routine.enabled || value.routine.revision !== expectedRevision + 1) {
    throw new Error("Unsupported routine disable receipt; inspect current evidence without replay");
  }
  return value;
}

export function fetchBudgets(query: BudgetReadQuery = {}): Promise<BudgetReadView> {
  const parameters = new URLSearchParams();
  if ("project_id" in query && query.project_id !== undefined) parameters.set("project_id", query.project_id);
  if ("objective_id" in query && query.objective_id !== undefined) parameters.set("objective_id", query.objective_id);
  const suffix = parameters.toString();
  return routineResponse(`/api/budgets${suffix ? `?${suffix}` : ""}`);
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
