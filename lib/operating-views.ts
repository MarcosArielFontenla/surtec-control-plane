import Ajv2020 from "ajv/dist/2020.js";
import schema from "../schemas/operating-view.schema.json";
import { isSafeIdentifier } from "./security/identifiers";
import { redactText } from "./security/redaction";

export const OPERATING_SECTIONS = ["company", "objectives", "projects", "issues", "executions", "workflows", "signals", "commitments", "harness", "sessions", "budgets"] as const;
export type OperatingSectionKind = typeof OPERATING_SECTIONS[number];
export type OperatingViewKind = "overview" | "objective" | "project" | "issue";
export type OperatingState = "working" | "checking" | "needs-decision" | "ready-for-review" | "done" | "blocked";
export type OperatingDecisionReason = "scope-changed" | "policy-changed" | "conflicting-evidence" | "budget-exhausted" | "correction-exhausted" | "required-harness" | "external-action" | "dependency-blocked" | "evidence-gap";
type Availability = "available" | "absent" | "unavailable" | "not-enabled";
type Reason = "observed" | "coverage-incomplete" | "optional-absent" | "missing-source" | "read-failed" | "invalid-source" | "not-configured" | "phase-p-deferred" | "not-required";
type Origin = "saved" | "live-local" | "manual";
type WorkflowTemplate = "analysis" | "implementation" | "quality-review" | "operations-investigation" | "trivial-change";
type ProjectKind = "personal" | "internal-tool" | "surtec-product" | "client-product" | "experiment" | "template";
type LineageGap = "project-unavailable" | "objective-unavailable" | "issue-unavailable" | "cross-project" | "objective-not-linked" | "objective-cycle" | "objective-depth" | "incomplete-source";

/** Normalized public facts, not raw store/task/provider objects. Adapters arrive in T002. */
export interface OperatingFact {
  readonly id: string;
  readonly label: string;
  readonly state: string | null;
  readonly summary?: string | null;
  readonly criteria?: readonly string[];
  readonly principles?: readonly string[];
  readonly project_id?: string | null;
  readonly objective_id?: string | null;
  readonly parent_objective_id?: string | null;
  readonly objective_ids?: readonly string[];
  readonly primary_objective_id?: string | null;
  readonly issue_id?: string | null;
  readonly role_id?: string | null;
  readonly workflow_template_id?: WorkflowTemplate | null;
  readonly project_kind?: ProjectKind | null;
  readonly target_date?: string | null;
  readonly reviewed_on?: string | null;
  readonly decision_reason?: OperatingDecisionReason | null;
  readonly validation_status?: "passed" | "failed" | "unknown";
  readonly candidate_validity?: "current" | "stale" | "unknown";
  readonly evidence_ids?: readonly string[];
  readonly result_status?: "completed" | "partial" | "blocked" | "failed" | "needs-review" | "cancelled" | null;
  readonly stage_kind?: "analysis" | "planning" | "implementation" | "review" | "qa" | "operations" | "correction" | null;
}
export interface OperatingSourceInput {
  readonly availability: Availability;
  readonly reason: Reason;
  readonly origin: Origin | null;
  readonly observed_at: string | null;
  readonly fresh_until: string | null;
  readonly complete: boolean;
  readonly items: readonly OperatingFact[];
}
export interface OperatingViewInput {
  readonly schema_version: 1;
  readonly as_of: string;
  readonly sources: Partial<Record<OperatingSectionKind, unknown>>;
}
export interface OperatingViewRequest {
  readonly kind: OperatingViewKind;
  readonly id?: string;
  readonly page_size?: number;
  readonly cursors?: Partial<Record<OperatingSectionKind, string>>;
}
export interface OperatingSourceMeta extends Omit<OperatingSourceInput, "items"> {
  readonly freshness: "fresh" | "stale" | "unknown" | "not-applicable";
}
export interface OperatingLineage {
  alignment: "aligned" | "intentionally-unaligned" | "unaligned" | "unavailable";
  objective_ids: string[];
  project_id: string | null;
  issue_id: string | null;
  role_id: string | null;
  workflow_template_id: WorkflowTemplate | null;
  gaps: LineageGap[];
  requires_authorization: true;
}
export interface OperatingRow extends Required<OperatingFact> {
  kind: OperatingSectionKind;
  operating_state: OperatingState | null;
  secondary_state: string | null;
  lineage: OperatingLineage;
  suggested_action: "open-detail" | "inspect-evidence" | "preview-context";
  execution_authority: "none";
}
export interface OperatingSection {
  kind: OperatingSectionKind;
  source: OperatingSourceMeta;
  coverage: "complete" | "partial" | "unavailable";
  total: number | null;
  rows: OperatingRow[];
  has_more: boolean | null;
  next_cursor: string | null;
}
export interface OperatingView {
  schema_version: 1;
  view: OperatingViewKind;
  focus_id: string | null;
  focus_status: "available" | "not-found" | "unavailable";
  generated_at: string;
  execution_authority: "none";
  phase_p: { budget_cutover: "not-enabled"; continuity: "deferred" };
  sections: OperatingSection[];
}

export class OperatingViewError extends Error {
  constructor() { super("Operating view input, query or response is invalid."); }
}
function date(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function timestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(value) && date(value.slice(0, 10));
}
const ajv = new Ajv2020({ strict: true, allErrors: false, ownProperties: true });
ajv.addFormat("date", date); ajv.addFormat("date-time", timestamp); ajv.addSchema(schema);
const inputValid = ajv.compile<OperatingViewInput>({ $ref: `${schema.$id}#/$defs/input` });
const sourceValid = ajv.compile<OperatingSourceInput>({ $ref: `${schema.$id}#/$defs/sourceInput` });
const requestValid = ajv.compile<OperatingViewRequest>({ $ref: `${schema.$id}#/$defs/request` });
const viewValid = ajv.compile<OperatingView>({ $ref: schema.$id });
const states = new Map<string, readonly (string | null)[]>(schema.$defs.row.allOf.map((rule) => [rule.if.properties.kind.const, rule.then.properties.state.enum] as const));
interface Source { meta: OperatingSourceMeta; items: readonly OperatingFact[]; index: Map<string, OperatingFact> }
type Sources = Record<OperatingSectionKind, Source>;
const SOURCE_REASONS: Record<Availability, readonly Reason[]> = {
  available: ["observed", "coverage-incomplete"], absent: ["optional-absent"],
  unavailable: ["missing-source", "read-failed", "invalid-source"],
  "not-enabled": ["phase-p-deferred", "not-configured", "not-required"],
};

function freshness(meta: Omit<OperatingSourceInput, "items">, asOf: string): OperatingSourceMeta["freshness"] {
  if (meta.availability === "absent" || meta.availability === "not-enabled") return "not-applicable";
  if (meta.availability !== "available" || !meta.observed_at || !meta.fresh_until) return "unknown";
  return Date.parse(meta.fresh_until) < Date.parse(asOf) ? "stale" : "fresh";
}
function unavailable(reason: Reason): Source {
  return { meta: { availability: "unavailable", reason, origin: null, observed_at: null, fresh_until: null, complete: false, freshness: "unknown" }, items: [], index: new Map() };
}
function normalizeSource(raw: unknown, kind: OperatingSectionKind, asOf: string): Source {
  if (raw === undefined) return unavailable("missing-source");
  try {
    if (!sourceValid(raw)) return unavailable("invalid-source");
    if (raw.observed_at && Date.parse(raw.observed_at) > Date.parse(asOf)
      || raw.fresh_until && (!raw.observed_at || Date.parse(raw.fresh_until) < Date.parse(raw.observed_at))) return unavailable("invalid-source");
    if (raw.availability !== "available" && (raw.items.length !== 0 || raw.complete)) return unavailable("invalid-source");
    if (!SOURCE_REASONS[raw.availability].includes(raw.reason)) return unavailable("invalid-source");
    if (raw.availability === "available" && raw.complete && raw.reason !== "observed") return unavailable("invalid-source");
    const index = new Map<string, OperatingFact>();
    for (const fact of raw.items) {
      if (!states.get(kind)!.includes(fact.state) || index.has(fact.id)
        || kind === "company" && fact.id !== "surtec"
        || kind === "projects" && fact.project_id != null && fact.project_id !== fact.id
        || kind === "projects" && fact.primary_objective_id != null && !fact.objective_ids?.includes(fact.primary_objective_id)
        || ["issues", "executions", "workflows", "signals", "commitments", "harness", "sessions"].includes(kind) && !fact.project_id) return unavailable("invalid-source");
      index.set(fact.id, fact);
    }
    if (kind === "company" && raw.items.length > 1) return unavailable("invalid-source");
    const budgetPreview = kind === "budgets" && raw.availability === "available";
    const metadata: Omit<OperatingSourceInput, "items"> = {
      availability: budgetPreview ? "not-enabled" : raw.availability,
      reason: budgetPreview ? "phase-p-deferred" : raw.availability === "available" && !raw.complete ? "coverage-incomplete" : raw.reason,
      origin: raw.origin, observed_at: raw.observed_at, fresh_until: raw.fresh_until, complete: !budgetPreview && raw.complete,
    };
    const meta: OperatingSourceMeta = { ...metadata, freshness: freshness(metadata, asOf) };
    return { meta, items: raw.items, index };
  } catch { return unavailable("invalid-source"); }
}

function publicText(value: string, limit: number): string {
  // Source DTOs omit private fields. This is an additional pattern-based guard, not a DLP claim.
  if (/[A-Za-z]:[\\/]|\\\\[^\s]|(?:^|\s)\/(?!api(?:\/|$))[^\s]+/.test(value)) return "[private path omitted]";
  return [...redactText(value).replace(/[\u0000-\u001f\u007f]/g, " ")].slice(0, limit).join("");
}
function lineage(kind: OperatingSectionKind, fact: OperatingFact, sources: Sources): { links: OperatingLineage; objectiveId: string | null } {
  const gaps = new Set<LineageGap>();
  const projectId = kind === "projects" ? fact.id : fact.project_id ?? null;
  const project = projectId ? sources.projects.index.get(projectId) : undefined;
  const issueId = kind === "issues" ? fact.id : fact.issue_id ?? null;
  let issue = kind === "issues" ? fact : issueId ? sources.issues.index.get(issueId) : undefined;
  if (projectId && !project) gaps.add("project-unavailable");
  if (issueId && !issue) gaps.add("issue-unavailable");
  if (issue && issue.project_id !== projectId) { gaps.add("cross-project"); issue = undefined; }
  // An issue's null/absent objective is not a project-primary assignment. Other
  // facts may inherit only their exact issue's link or explicit project context.
  const objectiveId = kind === "objectives" ? fact.id : kind === "issues" ? fact.objective_id ?? null
    : fact.objective_id !== undefined ? fact.objective_id : issueId ? issue?.objective_id ?? null : project?.primary_objective_id ?? null;
  if (issue && fact.objective_id !== undefined && fact.objective_id !== (issue.objective_id ?? null)) gaps.add("objective-not-linked");
  if (objectiveId && project && !project.objective_ids?.includes(objectiveId)) gaps.add("objective-not-linked");
  const chain: string[] = [], visited = new Set<string>();
  let cursor = objectiveId;
  while (cursor) {
    if (visited.has(cursor)) { gaps.add("objective-cycle"); break; }
    if (chain.length >= 8) { gaps.add("objective-depth"); break; }
    const objective = sources.objectives.index.get(cursor);
    if (!objective) { gaps.add("objective-unavailable"); break; }
    visited.add(cursor); chain.push(cursor); cursor = objective.parent_objective_id ?? null;
  }
  if (projectId && sources.projects.meta.availability === "available" && !sources.projects.meta.complete
    || objectiveId && sources.objectives.meta.availability === "available" && !sources.objectives.meta.complete
    || issueId && sources.issues.meta.availability === "available" && !sources.issues.meta.complete) gaps.add("incomplete-source");
  const personal = project?.project_kind === "personal" || project?.project_kind === "experiment";
  return { objectiveId, links: { alignment: gaps.size ? "unavailable" : objectiveId ? "aligned" : personal ? "intentionally-unaligned" : "unaligned",
    objective_ids: chain.reverse(), project_id: projectId, issue_id: issueId, role_id: fact.role_id ?? issue?.role_id ?? null,
    workflow_template_id: fact.workflow_template_id ?? null, gaps: [...gaps], requires_authorization: true } };
}
function presentation(kind: OperatingSectionKind, fact: OperatingFact): { state: OperatingState | null; reason: OperatingDecisionReason | null } {
  const primary: readonly string[] = ["working", "checking", "needs-decision", "ready-for-review", "done", "blocked"];
  let state: OperatingState | null = kind === "issues" && primary.includes(fact.state!) ? fact.state as OperatingState : null;
  if (kind === "executions") {
    if (fact.state === "running") state = "working";
    else if (fact.state === "finished" && fact.result_status === "blocked") state = "blocked";
    else if (fact.state === "finished" && ["failed", "partial", "needs-review"].includes(fact.result_status ?? "")) state = "needs-decision";
  }
  if (kind === "workflows") {
    if (fact.state === "running") state = fact.stage_kind === "review" || fact.stage_kind === "qa" ? "checking" : "working";
    else if (fact.state === "waiting-human" || fact.state === "needs-decision") state = "needs-decision";
  }
  const reason = state === "needs-decision" || state === "blocked" ? fact.decision_reason ?? "evidence-gap" : null;
  return { state, reason };
}
function row(kind: OperatingSectionKind, fact: OperatingFact, sources: Sources): OperatingRow {
  const display = presentation(kind, fact), { links, objectiveId } = lineage(kind, fact, sources);
  return {
    kind, id: fact.id, label: publicText(fact.label, 240), state: fact.state,
    summary: fact.summary == null ? null : publicText(fact.summary, 800),
    criteria: kind === "objectives" ? (fact.criteria ?? []).map((value) => publicText(value, 500)) : [],
    principles: kind === "company" ? (fact.principles ?? []).map((value) => publicText(value, 500)) : [],
    project_id: links.project_id, objective_id: objectiveId,
    parent_objective_id: kind === "objectives" ? fact.parent_objective_id ?? null : null,
    objective_ids: [...(fact.objective_ids ?? [])], primary_objective_id: fact.primary_objective_id ?? null,
    issue_id: links.issue_id, role_id: links.role_id, workflow_template_id: links.workflow_template_id,
    project_kind: fact.project_kind ?? null, target_date: fact.target_date ?? null, reviewed_on: fact.reviewed_on ?? null,
    decision_reason: display.reason, validation_status: fact.validation_status ?? "unknown", candidate_validity: fact.candidate_validity ?? "unknown",
    evidence_ids: [...(fact.evidence_ids ?? [])], result_status: fact.result_status ?? null, stage_kind: fact.stage_kind ?? null,
    operating_state: display.state, secondary_state: display.state === fact.state ? null : fact.state,
    lineage: links, suggested_action: display.reason || links.gaps.length ? "inspect-evidence" : kind === "projects" ? "preview-context" : "open-detail",
    execution_authority: "none",
  };
}
const focusSource = { objective: "objectives", project: "projects", issue: "issues" } as const;
function selected(item: OperatingRow, request: OperatingViewRequest, focus: OperatingFact | undefined, sources: Sources, objectiveScope: ReadonlySet<string>): boolean {
  if (request.kind === "overview") return true;
  if (!focus) return false;
  if (item.kind === "company") return true;
  if (request.kind === "objective") {
    if (item.kind === "objectives" && lineage("objectives", focus, sources).links.objective_ids.includes(item.id)) return true;
    return item.kind === "projects" ? item.objective_ids.some((id) => objectiveScope.has(id)) : item.lineage.objective_ids.includes(request.id!);
  }
  const projectId = request.kind === "project" ? focus.id : focus.project_id;
  if (item.kind === "objectives") {
    const ids = request.kind === "issue" ? [focus.objective_id].filter((id): id is string => !!id)
      : projectId ? sources.projects.index.get(projectId)?.objective_ids ?? [] : [];
    return ids.some((id) => {
      const objective = sources.objectives.index.get(id);
      return id === item.id || objective !== undefined && lineage("objectives", objective, sources).links.objective_ids.includes(item.id);
    });
  }
  if (request.kind === "issue" && ["issues", "executions", "workflows", "signals"].includes(item.kind)) return item.lineage.issue_id === focus.id && item.lineage.project_id === projectId;
  return item.lineage.project_id === projectId;
}
function cursorPrefix(view: OperatingViewKind, id: string | null, kind: OperatingSectionKind, observed: string | null): string {
  return `v1|${view}|${id ?? "surtec"}|${kind}|${observed ?? "-"}|`;
}

/** No I/O, ambient clock, effects or caller-provided action callbacks. */
export function projectOperatingView(value: unknown, query: unknown = { kind: "overview" }): OperatingView {
  if (!inputValid(value) || !requestValid(query) || query.kind === "overview" && query.id !== undefined
    || query.kind !== "overview" && query.id === undefined) throw new OperatingViewError();
  const request = query, asOf = value.as_of;
  const sources = Object.fromEntries(OPERATING_SECTIONS.map((kind) => [kind, normalizeSource(value.sources[kind], kind, asOf)])) as Sources;
  const focusedSource = request.kind === "overview" ? undefined : sources[focusSource[request.kind]];
  const focus = focusedSource?.index.get(request.id!);
  const focusStatus = !focusedSource || focus ? "available" : focusedSource.meta.availability === "available" && focusedSource.meta.complete ? "not-found" : "unavailable";
  const objectiveScope = new Set(request.kind === "objective" ? sources.objectives.items
    .filter((item) => lineage("objectives", item, sources).links.objective_ids.includes(request.id!)).map((item) => item.id) : []);
  const sections = OPERATING_SECTIONS.map((kind): OperatingSection => {
    const source = sources[kind], size = request.page_size ?? 50;
    const sourceRows = source.items.map((item) => row(kind, item, sources));
    const rows = sourceRows.filter((item) => selected(item, request, focus, sources, objectiveScope))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const dependencies: OperatingSectionKind[] = request.kind === "overview" || kind === "company" ? []
      : request.kind === "objective" ? ["objectives", "projects", "issues"] : [focusSource[request.kind], ...(kind === "objectives" ? ["objectives" as const] : [])];
    const scopedComplete = dependencies.every((dependency) => sources[dependency].meta.availability === "available" && sources[dependency].meta.complete)
      && (request.kind !== "objective" || kind === "company" || sourceRows.every((item) => item.lineage.gaps.length === 0));
    const coverage = focusStatus !== "available" || source.meta.availability === "unavailable" || source.meta.availability === "absent" ? "unavailable"
      : source.meta.availability === "available" && source.meta.complete && scopedComplete ? "complete" : "partial";
    const prefix = cursorPrefix(request.kind, request.id ?? null, kind, source.meta.observed_at), cursor = request.cursors?.[kind];
    let start = 0;
    if (cursor !== undefined) {
      const id = cursor.startsWith(prefix) ? cursor.slice(prefix.length) : "";
      if (!isSafeIdentifier(id) || (start = rows.findIndex((item) => item.id === id) + 1) === 0) throw new OperatingViewError();
    }
    const page = rows.slice(start, start + size), more = start + page.length < rows.length;
    return { kind, source: { ...source.meta }, coverage, total: coverage === "complete" ? rows.length : null, rows: page,
      has_more: more ? true : coverage === "complete" ? false : null, next_cursor: more ? prefix + page.at(-1)!.id : null };
  });
  const result: OperatingView = { schema_version: 1, view: request.kind, focus_id: request.id ?? null, focus_status: focusStatus,
    generated_at: asOf, execution_authority: "none", phase_p: { budget_cutover: "not-enabled", continuity: "deferred" }, sections };
  assertOperatingView(result);
  return result;
}

/** Schema plus cross-field invariants; no validation error includes source content. */
export function assertOperatingView(value: unknown): asserts value is OperatingView {
  if (!viewValid(value)) throw new OperatingViewError();
  if (value.view === "overview" ? value.focus_id !== null || value.focus_status !== "available" : value.focus_id === null) throw new OperatingViewError();
  for (const [index, section] of value.sections.entries()) {
    const meta = section.source;
    if (section.kind !== OPERATING_SECTIONS[index] || section.rows.some((item) => item.kind !== section.kind)
      || new Set(section.rows.map((item) => item.id)).size !== section.rows.length
      || !SOURCE_REASONS[meta.availability].includes(meta.reason)
      || meta.availability !== "available" && meta.complete
      || meta.availability === "available" && meta.reason !== (meta.complete ? "observed" : "coverage-incomplete")
      || meta.freshness !== freshness(meta, value.generated_at)
      || meta.observed_at && Date.parse(meta.observed_at) > Date.parse(value.generated_at)
      || meta.fresh_until && (!meta.observed_at || Date.parse(meta.fresh_until) < Date.parse(meta.observed_at))
      || section.coverage === "complete" && (meta.availability !== "available" || !meta.complete || value.focus_status !== "available")) throw new OperatingViewError();
    if ((section.coverage === "complete") !== (section.total !== null) || section.total !== null && section.total < section.rows.length
      || (section.next_cursor !== null) !== (section.has_more === true)
      || section.next_cursor !== null && section.next_cursor !== cursorPrefix(value.view, value.focus_id, section.kind, meta.observed_at) + section.rows.at(-1)?.id
      || ["unavailable", "absent"].includes(meta.availability) && (section.rows.length !== 0 || section.coverage !== "unavailable")
      || value.focus_status !== "available" && (section.rows.length !== 0 || section.coverage !== "unavailable")
      || section.has_more === false && section.coverage !== "complete"
      || section.has_more === true && section.rows.length === 0
      || section.has_more === true && section.total !== null && section.total <= section.rows.length
      || section.coverage === "unavailable" && (section.rows.length !== 0 || section.has_more !== null)
      || section.rows.some((item, position) => position > 0 && section.rows[position - 1].id >= item.id)
      || meta.availability === "not-enabled" && section.kind !== "budgets" && section.rows.length !== 0
      || section.kind === "budgets" && meta.availability === "available"
      || section.kind !== "issues" && section.rows.some((item) => item.operating_state === "done")) throw new OperatingViewError();
    for (const item of section.rows) {
      const display = presentation(item.kind, item), links = item.lineage;
      if (display.state !== item.operating_state || (display.state === item.state ? null : item.state) !== item.secondary_state
        || display.reason !== item.decision_reason || item.project_id !== links.project_id || item.issue_id !== links.issue_id
        || item.role_id !== links.role_id || item.workflow_template_id !== links.workflow_template_id
        || (links.gaps.length > 0) !== (links.alignment === "unavailable")
        || links.alignment === "aligned" && (item.objective_id === null || links.objective_ids.at(-1) !== item.objective_id)
        || links.alignment !== "aligned" && links.alignment !== "unavailable" && (item.objective_id !== null || links.objective_ids.length !== 0)) throw new OperatingViewError();
    }
  }
}
