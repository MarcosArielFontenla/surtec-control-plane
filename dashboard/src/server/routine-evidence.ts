import { createHash } from "node:crypto";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PolicyService, type PolicyProject } from "../../../lib/policy/service";
import type { OrganizationDocument, OrganizationSnapshot } from "../../../lib/organization";
import type { IssueDocument } from "../../../lib/issues/types";
import type { WorkSession } from "../../../lib/state/types";
import { validateOrganizationDocument, validateObjective, validateIssueDocument, validateWorkSessionsDocument } from "../../../lib/state/validation";
import { assertProfiles } from "../../../lib/harness/validation";
import { isSafeIdentifier } from "../../../lib/security/identifiers";
import { readProjectProfilesSnapshot } from "../../../lib/state/portfolio-profiles";
import { harnessProfilesPath, issueStatePath, organizationStatePath, portfolioProfilesPath, stateDir, workSessionsPath } from "../../../lib/state/paths";
import { assertRoutineOccurrence } from "../../../lib/routines/validation";
import { RoutineActionError, routineSignalFingerprint, type RoutineActionEvidence } from "../../../lib/routines/actions";
import type { RoutineEvidenceFact, RoutineOccurrence } from "../../../lib/routines/types";
import { generateSignals } from "../../../lib/signals/engine";
import { assertProjectIntegrationsSnapshot } from "../../../lib/integrations/validation";
import type { ProjectIntegrationsSnapshot } from "../../../lib/integrations/types";
import { createRoutineProjectIntegrationsService, type RoutineIntegrationOptions } from "./project-integrations";

export class RoutineEvidenceError extends RoutineActionError {
  constructor(readonly code: "state-invalid" | "scope-too-large" | "cancelled" | "deadline-exceeded") {
    super(code); this.name = "RoutineEvidenceError";
  }
}
export interface RoutineEvidenceDependencies {
  /** Application-selected local root, never a field from the routine/request. */
  stateRoot?: string;
  policy?: { listProjects(): PolicyProject[]; project(id: string): PolicyProject };
  integrations?: { read(id: string, options: RoutineIntegrationOptions): Promise<ProjectIntegrationsSnapshot> };
  clock?: () => Date;
}
const STATE_BYTES = 16 * 1024 * 1024;
const REVIEW_MS = 30 * 24 * 60 * 60 * 1000;
const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function safeAncestors(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new RoutineEvidenceError("state-invalid");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new RoutineEvidenceError("state-invalid"); }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}

/** Bound the exact named bytes around existing complete store validation; never invoke migrations. */
async function boundedBytes(handle: FileHandle, size: number): Promise<Buffer> {
  if (!Number.isSafeInteger(size) || size < 0 || size > STATE_BYTES) throw new RoutineEvidenceError("state-invalid");
  const buffer = Buffer.alloc(size + 1); let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (result.bytesRead === 0) break; offset += result.bytesRead;
  }
  if (offset !== size) throw new RoutineEvidenceError("state-invalid");
  return buffer.subarray(0, size);
}
async function snapshot<T>(filePath: string, read: (value: unknown) => T, check: () => void, maximumBytes = STATE_BYTES): Promise<T | null> {
  check(); await safeAncestors(dirname(filePath)); check();
  let named;
  try { named = await lstat(filePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new RoutineEvidenceError("state-invalid"); }
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > maximumBytes) throw new RoutineEvidenceError("state-invalid");
  let handle;
  try {
    check(); handle = await open(filePath, "r"); const opened = await handle.stat();
    if (opened.ino !== named.ino || opened.dev !== named.dev || opened.size !== named.size) throw new RoutineEvidenceError("state-invalid");
    const bytes = await boundedBytes(handle, opened.size); check();
    if (bytes.byteLength > STATE_BYTES || Buffer.from(new TextDecoder("utf-8", { fatal: true }).decode(bytes), "utf8").compare(bytes) !== 0) {
      throw new RoutineEvidenceError("state-invalid");
    }
    const value = read(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); check();
    // Validate complete schemas/cross-record invariants from the bounded bytes, not lossy lists.
    // Refuse changes during validation without claiming a multi-store transaction.
    const after = await lstat(filePath); const verify = await open(filePath, "r");
    try {
      const verifyStats = await verify.stat();
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.size > STATE_BYTES
        || after.ino !== opened.ino || after.dev !== opened.dev || verifyStats.nlink !== 1 || verifyStats.ino !== opened.ino || verifyStats.dev !== opened.dev || verifyStats.size !== bytes.length
        || verifyStats.mtimeMs !== opened.mtimeMs || verifyStats.ctimeMs !== opened.ctimeMs
        || !(await boundedBytes(verify, bytes.length)).equals(bytes)) throw new RoutineEvidenceError("state-invalid");
    } finally { await verify.close(); }
    check(); return value;
  } catch (error) {
    if (error instanceof RoutineActionError) throw error;
    // Error details/schema excerpts may contain private source material.
    throw new RoutineEvidenceError("state-invalid");
  } finally { await handle?.close(); }
}

function organizationSnapshot(value: unknown): OrganizationSnapshot {
  if (!validateOrganizationDocument(value)) throw new RoutineEvidenceError("state-invalid");
  const document: OrganizationDocument = value; const objectives = Object.values(document.objectives);
  if (objectives.length > 500) throw new RoutineEvidenceError("state-invalid");
  for (const [id, objective] of Object.entries(document.objectives)) {
    if (!isSafeIdentifier(id) || objective.id !== id) throw new RoutineEvidenceError("state-invalid");
    const seen = new Set([id]); let parent = objective.parent_objective_id;
    while (parent) {
      if (seen.has(parent) || !Object.hasOwn(document.objectives, parent) || seen.size >= 8) throw new RoutineEvidenceError("state-invalid");
      seen.add(parent); parent = document.objectives[parent].parent_objective_id;
    }
  }
  const active = objectives.filter((entry) => entry.status === "active").sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)).map((entry) => entry.id);
  if (active.length > 100 || sha(active) !== sha(document.company.active_objective_ids)) throw new RoutineEvidenceError("state-invalid");
  for (const [id, links] of Object.entries(document.project_objectives)) {
    if (!isSafeIdentifier(id) || links.objective_ids.some((objective) => !Object.hasOwn(document.objectives, objective))
      || links.primary_objective_id && !links.objective_ids.includes(links.primary_objective_id)) throw new RoutineEvidenceError("state-invalid");
  }
  const fullObjectives = objectives.map((objective) => ({ ...objective, project_ids: Object.entries(document.project_objectives)
    .filter(([, links]) => links.objective_ids.includes(objective.id)).map(([id]) => id).sort() }));
  if (fullObjectives.some((objective) => !validateObjective(objective))) throw new RoutineEvidenceError("state-invalid");
  return { company: document.company, project_objectives: document.project_objectives, objectives: fullObjectives };
}
function issueSnapshot(value: unknown): IssueDocument {
  if (!validateIssueDocument(value)) throw new RoutineEvidenceError("state-invalid");
  for (const [id, issue] of Object.entries(value.issues)) {
    if (id !== issue.id || issue.parent_issue_id && !Object.hasOwn(value.issues, issue.parent_issue_id)
      || issue.blocked_by_issue_ids.some((blocker) => !Object.hasOwn(value.issues, blocker))
      || issue.evidence_ids.some((key) => value.evidence[key]?.issue_id !== id)
      || issue.candidate_ids.some((key) => value.candidates[key]?.issue_id !== id)) throw new RoutineEvidenceError("state-invalid");
    const seen = new Set([id]); let parent = issue.parent_issue_id;
    while (parent) {
      if (seen.has(parent) || seen.size >= 6) throw new RoutineEvidenceError("state-invalid");
      seen.add(parent); parent = value.issues[parent].parent_issue_id;
    }
  }
  for (const [id, candidate] of Object.entries(value.candidates)) {
    if (id !== candidate.id || !value.issues[candidate.issue_id]?.candidate_ids.includes(id)) throw new RoutineEvidenceError("state-invalid");
  }
  for (const [id, evidence] of Object.entries(value.evidence)) {
    if (id !== evidence.id || !value.issues[evidence.issue_id]?.evidence_ids.includes(id)) throw new RoutineEvidenceError("state-invalid");
  }
  const visited = new Set<string>(); const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new RoutineEvidenceError("state-invalid");
    if (visited.has(id)) return;
    visiting.add(id); for (const blocker of value.issues[id].blocked_by_issue_ids) visit(blocker);
    visiting.delete(id); visited.add(id);
  };
  for (const id of Object.keys(value.issues)) visit(id);
  return value;
}
function sessionSnapshot(value: unknown): WorkSession[] {
  if (!validateWorkSessionsDocument(value)) throw new RoutineEvidenceError("state-invalid");
  const sessions = (value as { sessions: WorkSession[] }).sessions;
  if (sessions.filter((entry) => entry.status === "active").length > 1 || new Set(sessions.map((entry) => entry.id)).size !== sessions.length
    || sessions.some((entry) => !isSafeIdentifier(entry.id) || !isSafeIdentifier(entry.project_id))) throw new RoutineEvidenceError("state-invalid");
  return sessions;
}

function fact(kind: RoutineEvidenceFact["kind"], projectId: string | null, observedAt: string | null,
  projection: unknown, at: string, staleMs = REVIEW_MS): RoutineEvidenceFact {
  if (observedAt === null) return { kind, project_id: projectId, state: "unavailable", observed_at: null, fingerprint: null };
  const epoch = Date.parse(observedAt);
  if (!Number.isFinite(epoch) || epoch > Date.parse(at)) throw new RoutineEvidenceError("state-invalid");
  return { kind, project_id: projectId, state: Date.parse(at) - epoch >= staleMs ? "stale" : "fresh",
    observed_at: new Date(epoch).toISOString(), fingerprint: sha(projection) };
}
function unavailable(kind: RoutineEvidenceFact["kind"], projectId: string | null): RoutineEvidenceFact {
  return { kind, project_id: projectId, state: "unavailable", observed_at: null, fingerprint: null };
}

/** Validated local metadata + constrained asynchronous adapters. No worker or API is activated here. */
export function createRoutineEvidenceReader(repoRoot: string, dependencies: RoutineEvidenceDependencies = {}):
  (occurrence: RoutineOccurrence, options: RoutineIntegrationOptions) => Promise<RoutineActionEvidence> {
  const root = resolve(dependencies.stateRoot ?? stateDir());
  if (/^(?:\\\\|\/\/)/.test(dependencies.stateRoot ?? stateDir())) throw new RoutineEvidenceError("state-invalid");
  const policy = dependencies.policy ?? new PolicyService(repoRoot);
  const integrations = dependencies.integrations ?? createRoutineProjectIntegrationsService(repoRoot, { policy });
  const clock = dependencies.clock ?? (() => new Date());
  return async (occurrence, options) => {
    assertRoutineOccurrence(occurrence);
    const deadline = Date.parse(options.deadline_at);
    const check = (): void => {
      if (options.signal.aborted) throw new RoutineEvidenceError("cancelled");
      if (!Number.isFinite(deadline) || clock().getTime() >= deadline) throw new RoutineEvidenceError("deadline-exceeded");
      options.check();
    };
    check(); await safeAncestors(root); check();
    try { if (await realpath(root) !== root) throw new RoutineEvidenceError("state-invalid"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new RoutineEvidenceError("state-invalid"); }
    const organization = await snapshot(organizationStatePath(root), organizationSnapshot, check);
    check();
    const projects = policy.listProjects();
    const projectIds = projects.map((project) => project.id).sort();
    if (new Set(projectIds).size !== projectIds.length) throw new RoutineEvidenceError("state-invalid");
    let selected: string[];
    if (occurrence.definition.scope.kind === "company") selected = projectIds;
    else if (occurrence.definition.scope.kind === "project") selected = [occurrence.definition.scope.id];
    else {
      const objective = organization?.objectives.find((entry) => entry.id === occurrence.definition.scope.id);
      if (!objective) throw new RoutineEvidenceError("state-invalid");
      selected = [...objective.project_ids].sort();
    }
    if (selected.length > occurrence.definition.limits.max_projects || selected.length > 25) throw new RoutineEvidenceError("scope-too-large");
    if (selected.some((id) => !projectIds.includes(id)) || sha(selected) !== sha([...occurrence.project_ids].sort())) {
      throw new RoutineEvidenceError("state-invalid");
    }
    // Pin the complete trusted provider configuration; metadata is not an authorization grant.
    const projectBinding = sha(projects.filter((project) => selected.includes(project.id)).map((project) => [
      project.id, project.status, project.repo_path, project.repo, project.default_branch, project.deploy_url, project.railway,
    ]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    const current = (): void => {
      check();
      const currentProjects = policy.listProjects();
      if (occurrence.definition.scope.kind === "company" && sha(currentProjects.map((project) => project.id).sort()) !== sha(selected)) {
        throw new RoutineEvidenceError("state-invalid");
      }
      const latest = currentProjects.filter((project) => selected.includes(project.id)).map((project) => [
        project.id, project.status, project.repo_path, project.repo, project.default_branch, project.deploy_url, project.railway,
      ]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      if (sha(latest) !== projectBinding) throw new RoutineEvidenceError("state-invalid");
    };
    current(); let profiles: ReturnType<typeof readProjectProfilesSnapshot>;
    try { profiles = readProjectProfilesSnapshot(portfolioProfilesPath(root)); }
    catch { throw new RoutineEvidenceError("state-invalid"); }
    current();
    const issueDocument = await snapshot(issueStatePath(root), issueSnapshot, current);
    const sessions = await snapshot(workSessionsPath(root), sessionSnapshot, current, 10 * 1024 * 1024);
    const harness = await snapshot(harnessProfilesPath(root), (value) => { assertProfiles(value); return value; }, current, 10 * 1024 * 1024);
    const at = clock().toISOString(); current();
    const sources: RoutineEvidenceFact[] = [];
    const relevantObjectives = organization?.objectives
      .filter((objective) => occurrence.definition.scope.kind === "company" || occurrence.definition.scope.kind === "objective"
        && objective.id === occurrence.definition.scope.id || objective.project_ids.some((id) => selected.includes(id))) ?? [];
    const strategicReviews = organization ? [organization.company.last_reviewed_at, ...relevantObjectives.map((objective) => objective.last_reviewed_at)] : [];
    const strategicAt = strategicReviews.some((value) => value === null) ? null : strategicReviews.filter((value): value is string => value !== null).sort()[0] ?? null;
    sources.push(organization ? fact("organization", null, strategicAt,
      [organization.company.id, organization.company.active_objective_ids, organization.company.last_reviewed_at,
        relevantObjectives.map((objective) => [objective.id, objective.status, objective.parent_objective_id, objective.project_ids,
          objective.priority, objective.target_date, objective.last_reviewed_at])], at) : unavailable("organization", null));
    const projectEvidence = [];
    for (const id of selected) {
      current();
      const project = projects.find((entry) => entry.id === id)!;
      let integration: ProjectIntegrationsSnapshot | null = null;
      try {
        integration = await integrations.read(id, { ...options, check: current });
        current(); assertProjectIntegrationsSnapshot(integration);
        if (integration.project_id !== id || Date.parse(integration.observed_at) > clock().getTime()) throw new RoutineEvidenceError("state-invalid");
      } catch (error) {
        current();
        if (error instanceof RoutineActionError) throw error;
        integration = null;
      }
      const readAt = clock().toISOString();
      const git = integration?.source_control;
      sources.push(git?.health === "ok" ? fact("git", id, integration!.observed_at,
        [git.dirty, git.uncommitted, git.ahead, git.behind], readAt, 60_000) : unavailable("git", id));
      const ci = integration?.ci;
      sources.push(ci?.configured && ci.health !== "unknown" && ci.health !== "unconfigured" ? fact("ci", id, integration!.observed_at,
        [ci.status, ci.run_id ?? null, ci.run_updated_at ?? null], readAt, 60_000) : unavailable("ci", id));
      for (const [kind, provider] of [["health", "http-health"], ["deployment", "railway"]] as const) {
        const deployment = integration?.deployments.find((entry) => entry.provider === provider);
        sources.push(deployment?.configured && deployment.health !== "unknown" && deployment.health !== "unconfigured"
          ? fact(kind, id, deployment.observed_at, [deployment.provider, deployment.health, deployment.http_status, deployment.deployed_at], readAt, 60_000)
          : unavailable(kind, id));
      }
      const deps = integration?.dependencies;
      sources.push(deps?.configured && deps.health !== "unknown" && deps.outdated !== null
        ? fact("dependencies", id, deps.observed_at, [deps.outdated], readAt, 300_000) : unavailable("dependencies", id));
      const profile = profiles?.status === "current" ? profiles.profiles.find((entry) => entry.project_id === id) ?? null : null;
      sources.push(profile ? fact("organization", id, profile.last_reviewed_at,
        [profile.project_id, profile.kind, profile.lifecycle, profile.priority, profile.criticality, profile.deadline,
          profile.last_reviewed_at, organization?.project_objectives[id]?.objective_ids ?? []], readAt) : unavailable("organization", id));
      const issues = issueDocument ? Object.values(issueDocument.issues).filter((entry) => entry.project_id === id) : null;
      const issueAt = issues?.length ? issues.map((entry) => entry.updated_at).sort()[0]! : readAt;
      sources.push(issues ? fact("issues", id, issueAt,
        issues.map((entry) => [entry.id, entry.status, entry.objective_id, entry.priority, entry.criticality, entry.revision, entry.updated_at]), readAt)
        : unavailable("issues", id));
      const projectSessions = sessions?.filter((entry) => entry.project_id === id) ?? null;
      const sessionAt = projectSessions?.length ? projectSessions.map((entry) => entry.completed_at ?? entry.paused_at ?? entry.started_at).sort()[0]! : readAt;
      sources.push(projectSessions ? fact("sessions", id, sessionAt,
        projectSessions.map((entry) => [entry.id, entry.status, entry.completed_at ?? entry.paused_at ?? entry.started_at,
          entry.related_task_ids, entry.related_run_ids]), readAt) : unavailable("sessions", id));
      const harnessProfile = harness?.profiles[id] ?? null;
      sources.push(harnessProfile ? fact("harness", id, harnessProfile.observed_at,
        [harnessProfile.status, harnessProfile.doctor_status, harnessProfile.comparison, harnessProfile.validation.status,
          harnessProfile.findings.map((finding) => [finding.id, finding.severity])], readAt) : unavailable("harness", id));
      projectEvidence.push({ id, status: project.status, git: null, profile, profile_available: profiles?.status === "current",
        integrations: integration, last_activity_at: null, notes: [], harness: harnessProfile });
    }
    current();
    const observedAt = clock().toISOString();
    const signals = occurrence.definition.action === "refresh-evidence" ? [] : generateSignals({
      projects: projectEvidence, tasks: [], issues: [], organization: organization ? { ...organization, objectives: relevantObjectives } : undefined,
      sessions: (sessions ?? []).filter((entry) => selected.includes(entry.project_id)).map((entry) => ({
        id: entry.id, project_id: entry.project_id, status: entry.status === "completed" ? "closed" as const : entry.status,
        next_action: entry.next_action, updated_at: entry.completed_at ?? entry.paused_at ?? entry.started_at,
      })),
    }, new Date(observedAt)).filter((signal) => selected.includes(signal.project_id) && signal.type !== "active-project-stale").map((signal) => {
      const compact = { id: signal.id, project_id: signal.project_id, source: signal.source,
        severity: signal.severity, observed_at: signal.evidence_at };
      return { ...compact, fingerprint: routineSignalFingerprint(compact) };
    }).sort((left, right) => left.id.localeCompare(right.id));
    if (occurrence.definition.action !== "refresh-evidence") for (const id of selected) sources.push(fact("signals", id, observedAt,
      signals.filter((signal) => signal.project_id === id).map((signal) => [signal.id, signal.source, signal.severity, signal.observed_at]), observedAt));
    // Re-read strategic links after provider awaits; a changed scope must not silently broaden/relabel facts.
    const afterOrganization = await snapshot(organizationStatePath(root), organizationSnapshot, current);
    if (sha(afterOrganization) !== sha(organization)) throw new RoutineEvidenceError("state-invalid");
    current();
    return { sources: sources.sort((a, b) => `${a.project_id ?? ""}:${a.kind}`.localeCompare(`${b.project_id ?? ""}:${b.kind}`)), signals };
  };
}
