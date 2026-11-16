import Ajv2020 from "ajv/dist/2020.js";
import { lstatSync, readdirSync, type Stats } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import schema from "../../../schemas/operating-view.schema.json";
import { OPERATING_SECTIONS, OperatingViewError, projectOperatingView, type OperatingFact, type OperatingSectionKind,
  type OperatingSourceInput, type OperatingView, type OperatingViewRequest } from "../../../lib/operating-views";
import { isSafeIdentifier } from "../../../lib/security/identifiers";
import { readOrganizationDocument } from "../../../lib/state/organization";
import { readProjectProfilesSnapshot } from "../../../lib/state/portfolio-profiles";
import { readIssueDocument } from "../../../lib/state/issues";
import { readTask } from "../../../lib/state/store";
import { readWorkflowDocument } from "../../../lib/state/workflows";
import { readClientPortfolio } from "../../../lib/state/client-portfolio";
import { readHarnessProfiles } from "../../../lib/state/harness-profiles";
import { listWorkSessions } from "../../../lib/state/work-sessions";
import { clientPortfolioPath, harnessProfilesPath, issueStatePath, organizationStatePath, portfolioProfilesPath,
  stateDir, tasksDir, workflowStatePath, workSessionsPath } from "../../../lib/state/paths";

export interface OperatingViewService { read(request: unknown): Promise<OperatingView> }
export interface OperatingViewDependencies {
  stateRoot?: string;
  projectsRoot?: string;
  clock?: () => Date;
  /** Trusted, read-only observation adapters; never request-supplied callbacks. */
  readers?: Partial<Record<OperatingSectionKind, () => unknown | Promise<unknown>>>;
}
export class OperatingRequestError extends Error {
  constructor() { super("Invalid operating view query or cursor."); }
}
class SourceFailure extends Error {}

const requestAjv = new Ajv2020({ strict: true, ownProperties: true });
const validRequest = requestAjv.compile<OperatingViewRequest>({ ...schema.$defs.request, $defs: { id: schema.$defs.id } });
const MAX_BYTES = 16 * 1024 * 1024;
const unavailable = (reason: "missing-source" | "read-failed" | "invalid-source" = "invalid-source"): OperatingSourceInput => ({
  availability: "unavailable", reason, origin: null, observed_at: null, fresh_until: null, complete: false, items: [],
});
const absent = (): OperatingSourceInput => ({ availability: "absent", reason: "optional-absent", origin: null,
  observed_at: null, fresh_until: null, complete: false, items: [] });
const previewBudget = (): OperatingSourceInput => ({ availability: "not-enabled", reason: "phase-p-deferred", origin: null,
  observed_at: null, fresh_until: null, complete: false, items: [] });
const label = (value: string, length = 240) => [...value].slice(0, length).join("");

/** No mkdir/locks, symlink/junction traversal, hard-linked files or fallback on access errors. */
function checkedPath(path: string, file: boolean): Stats | null {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root, stat: Stats | undefined;
  const parts = absolute.slice(root.length).split(/[\\/]/).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try { stat = lstatSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const leaf = file && index === parts.length - 1;
    if (stat.isSymbolicLink() || (leaf ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw new SourceFailure();
  }
  if (!stat) throw new SourceFailure();
  return stat;
}
function sameFile(before: Stats, after: Stats | null): boolean {
  return !!after && before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}
function snapshot<T>(path: string, read: (path: string) => T, maxBytes = MAX_BYTES): { present: boolean; value: T | null } {
  const before = checkedPath(path, true);
  if (!before) return { present: false, value: null };
  if (before.size > maxBytes) throw new SourceFailure();
  const value = read(path);
  if (!sameFile(before, checkedPath(path, true))) throw new SourceFailure();
  return { present: true, value };
}
function oldest(values: readonly (string | null | undefined)[]): string | null {
  // Date-only review fields do not contain an observation instant. Never
  // backfill midnight or replace unknown historical time with request time.
  if (!values.length || values.some((value) => !value
    || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10))) return null;
  return new Date(Math.min(...values.map((value) => Date.parse(value!)))).toISOString();
}
function saved(items: readonly OperatingFact[], times: readonly (string | null | undefined)[], complete = true): OperatingSourceInput {
  return { availability: "available", reason: complete ? "observed" : "coverage-incomplete", origin: "saved",
    observed_at: oldest(times), fresh_until: null, complete, items };
}

// Per-request memoization shares validated aggregates, not stale cross-request state.
function defaultReaders(root: string, projectsRoot: string): Partial<Record<OperatingSectionKind, () => unknown>> {
  function memo<T>(read: () => T): () => T {
    let result: { value: T } | { error: unknown } | undefined;
    return () => { result ??= (() => { try { return { value: read() }; } catch (error) { return { error }; } })();
      if ("error" in result) throw result.error; return result.value; };
  }
  const organization = memo(() => snapshot(organizationStatePath(root), readOrganizationDocument));
  const issues = memo(() => snapshot(issueStatePath(root), readIssueDocument));
  return {
    company: () => {
      const document = organization().value;
      if (!document) return absent();
      const company = document.company;
      return saved([{ id: company.id, label: label(company.display_name), state: null,
        summary: company.mission === null ? null : label(company.mission, 800), principles: company.operating_principles.map((value) => label(value, 500)), reviewed_on: company.last_reviewed_at }], [company.last_reviewed_at]);
    },
    objectives: () => {
      const document = organization().value;
      if (!document) return absent();
      const objectives = Object.values(document.objectives);
      return saved(objectives.map((item) => ({ id: item.id, label: label(item.title), state: item.status,
        summary: label(item.desired_outcome, 800), criteria: item.success_criteria.map((value) => label(value, 500)),
        parent_objective_id: item.parent_objective_id, target_date: item.target_date, reviewed_on: item.last_reviewed_at })), objectives.map((item) => item.last_reviewed_at));
    },
    projects: () => {
      const before = checkedPath(projectsRoot, false);
      if (!before) return unavailable("missing-source");
      const ignore = new Set(["node_modules", ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((item) => item.trim()).filter(Boolean)]);
      const entries = readdirSync(projectsRoot, { withFileTypes: true });
      if (entries.length > 10_000) throw new SourceFailure();
      const ids: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || ignore.has(entry.name)) continue;
        const path = join(projectsRoot, entry.name);
        if (!checkedPath(path, false)) throw new SourceFailure();
        let git: Stats;
        try { git = lstatSync(join(path, ".git")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        if (!isSafeIdentifier(entry.name) || git.isSymbolicLink() || !git.isDirectory() && !git.isFile()) throw new SourceFailure();
        ids.push(entry.name);
      }
      if (!sameFile(before, checkedPath(projectsRoot, false))) throw new SourceFailure();
      const profiles = readProjectProfilesSnapshot(portfolioProfilesPath(root));
      if (profiles.status === "migration-required") return unavailable("invalid-source");
      let org: ReturnType<typeof organization>["value"] = null, linksAvailable = true;
      try { org = organization().value; } catch { linksAvailable = false; }
      const index = new Map(profiles.profiles.map((item) => [item.project_id, item]));
      const complete = linksAvailable && ids.every((id) => index.has(id));
      const facts = ids.map((id): OperatingFact => {
        const profile = index.get(id), links = org?.project_objectives[id];
        return { id, label: id, state: profile?.lifecycle ?? "active", project_kind: profile?.kind ?? "personal",
          project_id: id, objective_ids: links?.objective_ids ?? [], primary_objective_id: links?.primary_objective_id ?? null,
          target_date: profile?.deadline ?? null, reviewed_on: profile?.last_reviewed_at ?? null };
      });
      // Unconfigured repositories use the existing personal/active presentation
      // defaults, explicitly partial; neither discovery nor defaults prove readiness.
      return { ...saved(facts, ids.map((id) => index.get(id)?.last_reviewed_at), complete), origin: "live-local" };
    },
    issues: () => {
      const document = issues().value;
      if (!document) return absent();
      const values = Object.values(document.issues);
      return saved(values.map((item) => {
        const candidate = document.candidates[item.candidate_ids.at(-1) ?? ""];
        return { id: item.id, label: label(item.title), state: item.status, project_id: item.project_id, objective_id: item.objective_id,
          evidence_ids: item.evidence_ids.slice(0, 100), candidate_validity: candidate && (candidate.invalidated_at !== null || candidate.scope_revision !== item.scope_revision) ? "stale" as const : "unknown" as const,
          decision_reason: item.scope_change_proposal ? "scope-changed" as const : item.blocked_by_issue_ids.some((id) => !["done", "cancelled"].includes(document.issues[id].status)) ? "dependency-blocked" as const : null };
      }), values.map((item) => item.updated_at));
    },
    executions: () => {
      const directory = tasksDir(root), before = checkedPath(directory, false);
      if (!before) return absent();
      const names = readdirSync(directory).filter((name) => name.endsWith(".json"));
      if (names.length > 10_000) throw new SourceFailure();
      let remaining = MAX_BYTES;
      const tasks = names.map((name) => {
        const id = name.slice(0, -5);
        if (!isSafeIdentifier(id)) throw new SourceFailure();
        const path = join(directory, name), stat = checkedPath(path, true);
        if (!stat || (remaining -= stat.size) < 0) throw new SourceFailure();
        const record = snapshot(path, () => readTask(id, directory), stat.size).value;
        if (!record || record.envelope.id !== id) throw new SourceFailure();
        return record;
      });
      if (!sameFile(before, checkedPath(directory, false))) throw new SourceFailure();
      const document = issues().value;
      const taskIssues = new Map<string, string[]>();
      for (const issue of Object.values(document?.issues ?? {})) for (const id of issue.task_ids) taskIssues.set(id, [...(taskIssues.get(id) ?? []), issue.id]);
      return saved(tasks.map((task): OperatingFact => {
        const metadataId = task.envelope.context_admission?.schema_version === 2 ? task.envelope.context_admission.issue_id : task.envelope.metadata.issue_id;
        const linked = taskIssues.get(task.envelope.id) ?? [];
        if (linked.length > 1 || metadataId !== undefined && !isSafeIdentifier(metadataId)) throw new SourceFailure();
        const issueId = metadataId as string | undefined ?? linked[0] ?? null;
        const issue = issueId ? document?.issues[issueId] : null;
        if (issueId && (!issue || !issue.task_ids.includes(task.envelope.id) || issue.project_id !== task.envelope.project)) throw new SourceFailure();
        return { id: task.envelope.id, label: label(task.envelope.title), state: task.lifecycle, project_id: task.envelope.project,
          issue_id: issueId, role_id: task.envelope.context_manifest?.role_id ?? null, result_status: task.outcome };
      }), tasks.map((task) => task.updated_at));
    },
    workflows: () => {
      const document = snapshot(workflowStatePath(root), readWorkflowDocument).value;
      if (!document) return absent();
      const values = Object.values(document.workflows);
      return saved(values.map((workflow) => {
        const stage = workflow.current_stage_id ? document.stages[workflow.current_stage_id] : null;
        return { id: workflow.id, label: `${workflow.template_id} workflow`, state: workflow.status, project_id: workflow.project_id,
          issue_id: workflow.issue_id, workflow_template_id: workflow.template_id, role_id: stage?.role_id ?? null, stage_kind: stage?.kind ?? null };
      }), values.map((workflow) => workflow.updated_at));
    },
    commitments: () => {
      const document = snapshot(clientPortfolioPath(root), readClientPortfolio, 10 * 1024 * 1024).value;
      if (!document) return absent();
      const values = Object.values(document.commitments);
      return saved(values.map((item) => ({ id: item.id, label: label(item.title), state: item.state, project_id: item.project_id, target_date: item.due_date })), values.map((item) => item.updated_at));
    },
    harness: () => {
      const document = snapshot(harnessProfilesPath(root), readHarnessProfiles, 10 * 1024 * 1024).value;
      if (!document) return absent();
      const values = Object.values(document.profiles);
      return saved(values.map((item) => ({ id: item.project_id, project_id: item.project_id, label: `Harness ${item.project_id}`,
        state: item.status, validation_status: item.validation.status })), values.map((item) => item.observed_at));
    },
    sessions: () => {
      const values = snapshot(workSessionsPath(root), listWorkSessions, 10 * 1024 * 1024).value;
      if (!values) return absent();
      return saved(values.map((item) => ({ id: item.id, project_id: item.project_id, label: label(item.objective), state: item.status })),
        values.map((item) => item.completed_at ?? item.paused_at ?? item.started_at));
    },
    // No saved signal-feed adapter exists. Never call signals.read(), providers,
    // Harness inspection, routine reconciliation or budget admission from a GET.
    signals: () => unavailable("missing-source"), budgets: previewBudget,
  };
}

export function createOperatingViewService(repoRoot: string, dependencies: OperatingViewDependencies = {}): OperatingViewService {
  const root = resolve(dependencies.stateRoot ?? stateDir());
  const projectsRoot = resolve(dependencies.projectsRoot ?? process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot));
  const clock = dependencies.clock ?? (() => new Date());
  return { async read(request: unknown): Promise<OperatingView> {
    if (!validRequest(request) || (request.kind === "overview" ? request.id !== undefined : request.id === undefined)) throw new OperatingRequestError();
    const asOf = clock().toISOString();
    const defaults = defaultReaders(root, projectsRoot);
    const sources = Object.fromEntries(await Promise.all(OPERATING_SECTIONS.map(async (kind) => {
      try { return [kind, await (dependencies.readers?.[kind] ?? defaults[kind])!()] as const; }
      catch (error) { return [kind, unavailable(error instanceof SourceFailure ? "invalid-source" : "read-failed")] as const; }
    })));
    try { return projectOperatingView({ schema_version: 1, as_of: asOf, sources }, request); }
    catch (error) { if (error instanceof OperatingViewError) throw new OperatingRequestError(); throw error; }
  } };
}
