import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, join, parse as parsePath, resolve } from "node:path";
import { types as nodeTypes } from "node:util";
import { parseAllDocuments } from "yaml";
import type { WorkIssue } from "../issues/types";
import { MAX_OBJECTIVE_DEPTH, type OrganizationSnapshot } from "../organization";
import { validateCompanyProfile, validateObjective } from "../state/validation";
import type { WorkflowCandidateLineage } from "../workflows/types";
import { BUDGET_DIMENSIONS, BUDGET_LIMITS, type BudgetAmounts, type BudgetAttribution, type BudgetDimension, type BudgetLedger, type BudgetLimits, type BudgetPeriod, type BudgetPolicy, type BudgetPolicyBinding, type BudgetScope, type BudgetSubject } from "./types";
import { assertBudgetLedger, assertBudgetPolicy, BudgetContractError } from "./validation";

/** Trusted configuration/data resolution only; no admission, reservation or execution authority. */
export interface BudgetPolicySource { policy: BudgetPolicy; fingerprint: string }
/** Application-read identities only; historical correction labels cannot invent a new allowance. */
export type BudgetCorrectionLineage = Pick<WorkflowCandidateLineage, "id" | "project_id" | "issue_id" | "workflow_ids">;
export interface ExistingBudgetConstraint {
  id: string; kind: "worker" | "project" | "role" | "workflow" | "correction" | "execution" | "routine";
  revision: number; fingerprint: string; limits: BudgetLimits;
  /** Already-resolved code-owned availability, not another copy of ledger consumption. */
  availability?: Record<BudgetDimension, { status: "known"; remaining: number } | { status: "unavailable" }>;
}
export interface BudgetDimensionView {
  status: "configured" | "unconfigured"; cap: number | null;
  proven_consumed: number; consumed: number | null; reserved: number;
  remaining: number | null; warning: boolean;
}
export interface BudgetSourceView {
  id: string; kind: "policy" | "existing"; scope?: BudgetScope;
  period: BudgetPeriod; bucket: string; revision: number; fingerprint: string;
  dimensions: Record<BudgetDimension, BudgetDimensionView>;
}
export interface ResolvedBudgetPolicy {
  policy_bindings: BudgetPolicyBinding[]; cap_fingerprint: string; ceilings: BudgetAmounts;
  dimensions: Record<BudgetDimension, { ceiling: number; remaining: number | null; status: "available" | "exhausted" | "unavailable"; warning: boolean; limiting_sources: string[] }>;
  sources: BudgetSourceView[]; pricing: BudgetPolicy["pricing"];
  denials: Array<{ code: "budget-exhausted" | "budget-accounting-unavailable" | "pricing-unavailable"; dimension?: BudgetDimension; source_ids: string[] }>;
  can_admit: boolean;
}
function check(ok: boolean, message: string): asserts ok { if (!ok) throw new BudgetContractError(message); }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function id(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)
    && !value.includes("..") && !["constructor", "prototype", "__proto__"].includes(value);
}
function fingerprint(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function keys(value: unknown, expected: string[]): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(); return JSON.stringify(actual) === JSON.stringify([...expected].sort());
}
// Inspect descriptors before accessing values. Neither hooks nor proxies are instruction sources.
function plain(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  check(depth <= 32, "Budget resolver JSON nesting exceeds limit");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { check(Buffer.byteLength(value) <= BUDGET_LIMITS.documentBytes, "Budget resolver string exceeds limit"); return; }
  if (typeof value === "number") { check(Number.isSafeInteger(value), "Budget resolver number must be a safe integer"); return; }
  check(typeof value === "object" && !nodeTypes.isProxy(value), "Budget resolver requires plain JSON");
  check(!ancestors.has(value), "Budget resolver JSON cycle");
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  check(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null, "Budget resolver prototype is unsafe");
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
  check(names.every((key) => typeof key === "string"), "Budget resolver symbol property");
  check(names.length <= BUDGET_LIMITS.records + (array ? 1 : 0), "Budget resolver collection exceeds limit");
  if (array) {
    check(value.length <= BUDGET_LIMITS.records && names.length === value.length + 1, "Budget resolver array is sparse or decorated");
    for (let index = 0; index < value.length; index++) check(Object.hasOwn(descriptors, String(index)), "Budget resolver array contains a missing element");
  }
  ancestors.add(value);
  try {
    for (const key of names as string[]) {
      if (array && key === "length") continue;
      const descriptor = descriptors[key]!;
      check(!["constructor", "prototype", "__proto__"].includes(key) && descriptor.enumerable === true && Object.hasOwn(descriptor, "value"), "Budget resolver property is unsafe");
      plain(descriptor.value, ancestors, depth + 1);
    }
  } finally { ancestors.delete(value); }
}
function json(value: unknown): void { plain(value); check(Buffer.byteLength(JSON.stringify(value)) <= BUDGET_LIMITS.documentBytes, "Budget resolver document exceeds limit"); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
function stable(value: unknown): string {
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash("sha256").update(stable(value)).digest("hex"); }
function zero(): BudgetAmounts { return Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => [dimension, 0])) as BudgetAmounts; }
function add(left: number, right: number): number {
  check(count(right) && Number.isSafeInteger(left + right), "Budget accounting exceeds safe integer capacity"); return left + right;
}

/** Original admission time owns its UTC bucket; malformed/local timestamps never roll silently. */
export function budgetBucket(period: BudgetPeriod, at: string): string {
  check(["none", "utc-day", "utc-month"].includes(period), "Unsupported budget period");
  check(typeof at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(at) && !at.startsWith("0000"), "Budget time must be explicit UTC");
  const epoch = Date.parse(at);
  check(Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 19) === at.slice(0, 19), "Invalid budget UTC calendar");
  return period === "none" ? "none" : at.slice(0, period === "utc-day" ? 10 : 7);
}

/** Fixed trusted registry path. Missing/corrupt/linked configuration never becomes neutral policy. */
export function readBudgetPolicy(root: string): BudgetPolicySource {
  let descriptor: number | undefined;
  try {
    const absolute = resolve(root), ancestors: string[] = [];
    for (let current = absolute; current !== parsePath(current).root; current = dirname(current)) ancestors.unshift(current);
    for (const path of ancestors) check(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), "Linked budget configuration ancestor");
    const registry = join(absolute, "registry"), path = join(registry, "budget-policy.yml");
    check(lstatSync(registry).isDirectory() && !lstatSync(registry).isSymbolicLink(), "Unsafe budget registry");
    const before = lstatSync(path);
    check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= BUDGET_LIMITS.documentBytes, "Unsafe budget policy file");
    descriptor = openSync(path, "r");
    const opened = fstatSync(descriptor);
    check(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.nlink === 1 && opened.size === before.size, "Budget policy changed while opening");
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    const bytes = buffer.subarray(0, length), after = fstatSync(descriptor), named = lstatSync(path);
    check(bytes.length === before.size && after.size === before.size && after.nlink === 1 && named.nlink === 1 && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && named.dev === before.dev && named.ino === before.ino && !named.isSymbolicLink(), "Budget policy changed while reading");
    for (const ancestor of [...ancestors, registry]) check(lstatSync(ancestor).isDirectory() && !lstatSync(ancestor).isSymbolicLink(), "Budget configuration ancestor changed while reading");
    const source = bytes.toString("utf8");
    check(Buffer.from(source).equals(bytes), "Budget policy is not UTF-8");
    // Parsing must not print source excerpts through YAML warnings/errors.
    const documents = parseAllDocuments(source, { logLevel: "silent", prettyErrors: false, strict: true, stringKeys: true, uniqueKeys: true, merge: false, resolveKnownTags: false });
    check(documents.length === 1 && documents[0]!.errors.length === 0 && documents[0]!.warnings.length === 0, "Budget policy YAML is ambiguous or unsupported");
    const policy: unknown = documents[0]!.toJS({ maxAliasCount: 0 });
    assertBudgetPolicy(policy);
    return frozen({ policy: clone(policy), fingerprint: createHash("sha256").update(bytes).digest("hex") });
  } catch (error) {
    if (error instanceof BudgetContractError) throw error;
    throw new BudgetContractError("Budget policy is missing, unsafe, invalid or unreadable");
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function organizationValid(organization: OrganizationSnapshot): Map<string, OrganizationSnapshot["objectives"][number]> {
  json(organization);
  check(keys(organization, ["company", "objectives", "project_objectives"]) && validateCompanyProfile(organization.company) && organization.company.id === "surtec" && Array.isArray(organization.objectives) && organization.objectives.length <= 500, "Invalid budget organization");
  for (const objective of organization.objectives) check(validateObjective(objective) && id(objective.id) && objective.company_id === "surtec", "Invalid budget objective");
  const objectives = new Map(organization.objectives.map((objective) => [objective.id, objective]));
  check(objectives.size === organization.objectives.length, "Duplicate budget objective");
  for (const objective of organization.objectives) {
    check(validateObjective(objective) && id(objective.id) && objective.company_id === "surtec", "Invalid budget objective");
    const seen = new Set<string>(); let next: string | null = objective.id;
    while (next !== null) {
      check(!seen.has(next) && seen.size < MAX_OBJECTIVE_DEPTH && objectives.has(next), "Invalid budget objective ancestry");
      seen.add(next); next = objectives.get(next)!.parent_objective_id;
    }
  }
  check(organization.project_objectives !== null && typeof organization.project_objectives === "object" && !Array.isArray(organization.project_objectives), "Invalid budget project links");
  const reverse = new Map<string, string[]>();
  for (const [project, link] of Object.entries(organization.project_objectives)) {
    check(id(project) && link !== null && typeof link === "object" && keys(link, ["objective_ids", "primary_objective_id"]) && Array.isArray(link.objective_ids) && link.objective_ids.length <= 100 && new Set(link.objective_ids).size === link.objective_ids.length && link.objective_ids.every((objective) => objectives.has(objective)) && (link.primary_objective_id === null || link.objective_ids.includes(link.primary_objective_id)), "Invalid budget project objective links");
    for (const objective of link.objective_ids) reverse.set(objective, [...(reverse.get(objective) ?? []), project]);
  }
  for (const objective of objectives.values()) check(JSON.stringify([...objective.project_ids].sort()) === JSON.stringify((reverse.get(objective.id) ?? []).sort()), "Inconsistent budget objective project index");
  const active = [...objectives.values()].filter((objective) => objective.status === "active").sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)).map((objective) => objective.id);
  check(JSON.stringify(active) === JSON.stringify(organization.company.active_objective_ids), "Inconsistent budget active objective index");
  return objectives;
}
function ancestry(objectives: ReturnType<typeof organizationValid>, selected: string | null): string[] {
  const ids: string[] = [];
  while (selected !== null) {
    check(objectives.has(selected) && ids.length < BUDGET_LIMITS.objectiveDepth && !ids.includes(selected), "Unknown or invalid budget objective attribution");
    ids.push(selected); selected = objectives.get(selected)!.parent_objective_id;
  }
  return ids;
}
export function resolveTaskBudgetAttribution(input: {
  organization: OrganizationSnapshot; project_id: string;
  issue: Pick<WorkIssue, "id" | "project_id" | "objective_id"> | null; role_id: string; execution_id: string;
}): BudgetAttribution {
  json(input);
  check(keys(input, ["organization", "project_id", "issue", "role_id", "execution_id"]) && id(input.project_id) && id(input.role_id) && id(input.execution_id), "Invalid task budget identity");
  const objectives = organizationValid(input.organization), issue = input.issue;
  check(issue === null || (keys(issue, ["id", "project_id", "objective_id"]) && id(issue.id) && issue.project_id === input.project_id && (issue.objective_id === null || id(issue.objective_id))), "Invalid budget issue binding");
  const selected = issue?.objective_id ?? input.organization.project_objectives[input.project_id]?.primary_objective_id ?? null;
  return frozen({ company_id: "surtec", objective_ids: ancestry(objectives, selected), project_ids: [input.project_id], issue_id: issue?.id ?? null, role_id: input.role_id, execution_id: input.execution_id });
}
export function resolveOccurrenceBudgetAttribution(input: {
  organization: OrganizationSnapshot; project_ids: string[]; objective_id: string | null; execution_id: string;
}): BudgetAttribution {
  json(input);
  check(keys(input, ["organization", "project_ids", "objective_id", "execution_id"]) && Array.isArray(input.project_ids) && input.project_ids.length <= BUDGET_LIMITS.projects && input.project_ids.every(id) && new Set(input.project_ids).size === input.project_ids.length && id(input.execution_id) && (input.objective_id === null || id(input.objective_id)), "Invalid occurrence budget identity");
  const objectives = organizationValid(input.organization);
  return frozen({ company_id: "surtec", objective_ids: ancestry(objectives, input.objective_id), project_ids: [...input.project_ids].sort(), issue_id: null, role_id: null, execution_id: input.execution_id });
}
function attributionValid(value: BudgetAttribution): void {
  check(keys(value, ["company_id", "objective_ids", "project_ids", "issue_id", "role_id", "execution_id"]) && value.company_id === "surtec" && id(value.execution_id) && (value.issue_id === null || id(value.issue_id)) && (value.role_id === null || id(value.role_id)), "Invalid frozen budget attribution");
  for (const [values, maximum] of [[value.objective_ids, BUDGET_LIMITS.objectiveDepth], [value.project_ids, BUDGET_LIMITS.projects]] as const) check(Array.isArray(values) && values.length <= maximum && values.every(id) && new Set(values).size === values.length, "Invalid frozen budget attribution members");
}
function applies(scope: BudgetScope, attribution: BudgetAttribution): boolean {
  switch (scope.kind) {
    case "company": return scope.id === attribution.company_id;
    case "objective": return attribution.objective_ids.includes(scope.id);
    case "project": return attribution.project_ids.includes(scope.id);
    case "issue": return scope.id === attribution.issue_id;
    case "role": return scope.id === attribution.role_id;
    case "execution": return scope.id === attribution.execution_id;
  }
}
function amountsValid(value: BudgetAmounts): void { check(value !== null && typeof value === "object" && keys(value, [...BUDGET_DIMENSIONS]) && Object.values(value).every(count), "Invalid finite existing budget caps"); }
function limitsValid(limits: BudgetLimits): void {
  check(limits !== null && typeof limits === "object" && keys(limits, [...BUDGET_DIMENSIONS]), "Invalid existing budget dimensions");
  for (const limit of Object.values(limits)) check(limit !== null && typeof limit === "object" && ((limit.status === "unconfigured" && keys(limit, ["status"])) || (limit.status === "configured" && keys(limit, ["status", "hard_cap"]) && count(limit.hard_cap))), "Invalid existing budget limit");
}
function constraintValid(value: ExistingBudgetConstraint): void {
  check(keys(value, value.availability === undefined ? ["id", "kind", "revision", "fingerprint", "limits"] : ["id", "kind", "revision", "fingerprint", "limits", "availability"]) && id(value.id) && value.id !== "base" && ["worker", "project", "role", "workflow", "correction", "execution", "routine"].includes(value.kind) && count(value.revision) && value.revision > 0 && fingerprint(value.fingerprint), "Invalid existing budget provenance");
  limitsValid(value.limits);
  if (value.availability !== undefined) {
    check(keys(value.availability, [...BUDGET_DIMENSIONS]), "Incomplete existing budget availability");
    for (const dimension of BUDGET_DIMENSIONS) {
      const available = value.availability[dimension], limit = value.limits[dimension];
      check(available !== null && typeof available === "object" && ((available.status === "unavailable" && keys(available, ["status"])) || (available.status === "known" && keys(available, ["status", "remaining"]) && count(available.remaining) && (limit.status === "unconfigured" || available.remaining <= limit.hard_cap))), "Invalid existing budget availability");
    }
  }
}

function lineageMap(values: BudgetCorrectionLineage[]): Map<string, BudgetCorrectionLineage> {
  json(values);
  check(Array.isArray(values) && values.length <= BUDGET_LIMITS.records && values.every((value) => value !== null && typeof value === "object") && new Set(values.map((value) => value.id)).size === values.length, "Invalid budget correction lineages");
  const map = new Map<string, BudgetCorrectionLineage>();
  for (const value of values) {
    check(keys(value, ["id", "project_id", "issue_id", "workflow_ids"]) && id(value.id) && id(value.project_id) && id(value.issue_id) && Array.isArray(value.workflow_ids) && value.workflow_ids.length > 0 && value.workflow_ids.length <= BUDGET_LIMITS.records && value.workflow_ids.every(id) && new Set(value.workflow_ids).size === value.workflow_ids.length, "Invalid budget correction lineage identity");
    for (const workflow of value.workflow_ids) { check(!map.has(workflow), "Ambiguous budget correction lineage"); map.set(workflow, value); }
  }
  return map;
}
function projection(ledger: BudgetLedger | undefined, lineages: Map<string, BudgetCorrectionLineage>, scope: BudgetScope, period: BudgetPeriod, bucket: string) {
  const consumed = zero(), reserved = zero(), uncertain = new Set<BudgetDimension>();
  const correctionCharges = new Set<string>(), correctionHolds = new Set<string>();
  if (!ledger) return { consumed, reserved, uncertain };
  const lineage = (subject: BudgetSubject): string | null => {
    if (subject.kind !== "task" || !subject.workflow) return null;
    const identity = lineages.get(subject.workflow.workflow_id);
    if (!identity) return null;
    check(identity.project_id === subject.project_id && identity.issue_id === subject.issue_id, "Budget correction lineage disagrees with subject binding");
    return identity.id;
  };
  const matching = (subject: BudgetSubject) => applies(scope, subject.attribution);
  for (const charge of Object.values(ledger.charges)) {
    const subject = ledger.subjects[charge.subject_id]!, reservation = ledger.reservations[charge.reservation_id]!;
    if (!matching(subject)) continue;
    const sameBucket = budgetBucket(period, reservation.created_at) === bucket;
    const unknownRuntime = charge.runtime_state === "unknown", unknownUsage = charge.usage_state === "unknown";
    const correctionIdentity = charge.correction ? lineage(subject) : null;
    if (charge.correction && correctionIdentity === null) uncertain.add("corrections");
    // Missing receipts retain uncertainty even when the original bucket is no longer current.
    if (unknownRuntime) { uncertain.add("runtime_ms"); if (charge.review) uncertain.add("review_runtime_ms"); }
    if (unknownUsage) { uncertain.add("total_tokens"); if (charge.review) uncertain.add("review_total_tokens"); }
    if (!sameBucket) continue;
    consumed.attempts = add(consumed.attempts, charge.attempts);
    consumed.runtime_ms = add(consumed.runtime_ms, charge.runtime_ms);
    consumed.total_tokens = add(consumed.total_tokens, charge.observed_total_tokens ?? 0);
    if (charge.review) {
      consumed.review_attempts = add(consumed.review_attempts, charge.attempts);
      consumed.review_runtime_ms = add(consumed.review_runtime_ms, charge.runtime_ms);
      consumed.review_total_tokens = add(consumed.review_total_tokens, charge.observed_total_tokens ?? 0);
    }
    if (correctionIdentity !== null) correctionCharges.add(correctionIdentity);
  }
  consumed.corrections = correctionCharges.size;
  for (const reservation of Object.values(ledger.reservations)) {
    const subject = ledger.subjects[reservation.subject_id]!;
    if (!matching(subject) || reservation.status === "settled") continue;
    for (const dimension of reservation.uncertain_dimensions) uncertain.add(dimension);
    // Outstanding holds are never released merely because the wall clock rolled over.
    for (const dimension of BUDGET_DIMENSIONS) {
      if (dimension === "corrections") continue;
      reserved[dimension] = add(reserved[dimension], reservation.held[dimension]);
    }
    if (reservation.held.corrections > 0) {
      const identity = lineage(subject);
      if (identity === null) uncertain.add("corrections"); else correctionHolds.add(identity);
    }
  }
  reserved.corrections = [...correctionHolds].filter((identity) => !correctionCharges.has(identity)).length;
  return { consumed, reserved, uncertain };
}
function dimensionViews(limits: BudgetLimits, usage: ReturnType<typeof projection>, warningPercent: number): Record<BudgetDimension, BudgetDimensionView> {
  return Object.fromEntries(BUDGET_DIMENSIONS.map((dimension) => {
    const limit = limits[dimension], cap = limit.status === "configured" ? limit.hard_cap : null;
    const proven = usage.consumed[dimension], reserved = usage.reserved[dimension];
    const total = add(proven, reserved), consumed = usage.uncertain.has(dimension) ? null : proven;
    return [dimension, { status: limit.status, cap, proven_consumed: proven, consumed, reserved,
      remaining: cap === null || consumed === null ? null : Math.max(0, cap - total),
      warning: cap !== null && (consumed === null || BigInt(total) * 100n >= BigInt(cap) * BigInt(warningPercent)) }];
  })) as Record<BudgetDimension, BudgetDimensionView>;
}

/** Pure preview. Callers must revalidate/reserve under the future store's private ownership. */
export function resolveBudgetPolicy(input: {
  source: BudgetPolicySource; attribution: BudgetAttribution; at: string; base_caps: BudgetAmounts;
  constraints?: ExistingBudgetConstraint[]; ledger?: BudgetLedger; correction_lineages?: BudgetCorrectionLineage[]; require_currency?: boolean;
}): ResolvedBudgetPolicy {
  json(input);
  const required = ["source", "attribution", "at", "base_caps"];
  check(input !== null && typeof input === "object" && required.every((key) => Object.hasOwn(input, key)) && Object.keys(input).every((key) => [...required, "constraints", "ledger", "correction_lineages", "require_currency"].includes(key)), "Invalid budget resolution input");
  json(input.source); json(input.attribution); json(input.base_caps);
  check(keys(input.source, ["policy", "fingerprint"]) && fingerprint(input.source.fingerprint), "Invalid trusted budget source fingerprint");
  assertBudgetPolicy(input.source.policy); attributionValid(input.attribution); amountsValid(input.base_caps);
  budgetBucket("none", input.at);
  check(input.require_currency === undefined || typeof input.require_currency === "boolean", "Invalid mandatory currency requirement");
  const constraints = input.constraints === undefined ? [] : input.constraints;
  json(constraints); check(Array.isArray(constraints) && constraints.length <= BUDGET_LIMITS.bindings && constraints.every((value) => value !== null && typeof value === "object") && new Set(constraints.map((value) => value.id)).size === constraints.length, "Invalid existing budget sources");
  constraints.forEach(constraintValid);
  if (input.ledger !== undefined) assertBudgetLedger(input.ledger);
  const lineages = lineageMap(input.correction_lineages === undefined ? [] : input.correction_lineages);
  const rules = input.source.policy.rules.filter((rule) => applies(rule.scope, input.attribution)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  check(rules.length <= BUDGET_LIMITS.bindings, "Applicable budget policies exceed binding limit");
  const bindings: BudgetPolicyBinding[] = rules.map((rule) => ({ policy_id: rule.id, policy_revision: rule.revision, policy_fingerprint: input.source.fingerprint, scope: clone(rule.scope), period: rule.period, bucket: budgetBucket(rule.period, input.at), limits: clone(rule.limits) }));
  const sources: BudgetSourceView[] = rules.map((rule, index) => ({ id: `policy:${rule.id}`, kind: "policy", scope: clone(rule.scope), period: rule.period, bucket: bindings[index]!.bucket, revision: rule.revision, fingerprint: input.source.fingerprint, dimensions: dimensionViews(rule.limits, projection(input.ledger, lineages, rule.scope, rule.period, bindings[index]!.bucket), rule.warning_percent) }));
  const sortedConstraints = [...constraints].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const constraint of sortedConstraints) {
    const dimensions = dimensionViews(constraint.limits, { consumed: zero(), reserved: zero(), uncertain: new Set() }, 80);
    for (const dimension of BUDGET_DIMENSIONS) {
      const available = constraint.availability?.[dimension], view = dimensions[dimension];
      if (available && view.status === "configured") {
        view.remaining = available.status === "unavailable" ? null : available.remaining;
        // Existing counters may combine consumption/holds; never invent that breakdown.
        view.consumed = null;
        view.warning = available.status === "unavailable" || BigInt(view.cap! - available.remaining) * 100n >= BigInt(view.cap!) * 80n;
      }
    }
    sources.push({ id: `existing:${constraint.id}`, kind: "existing", period: "none", bucket: "none", revision: constraint.revision, fingerprint: constraint.fingerprint, dimensions });
  }
  const ceilings = clone(input.base_caps), dimensions = {} as ResolvedBudgetPolicy["dimensions"], denials: ResolvedBudgetPolicy["denials"] = [];
  for (const dimension of BUDGET_DIMENSIONS) {
    const configured = sources.filter((source) => source.dimensions[dimension].status === "configured");
    for (const source of configured) ceilings[dimension] = Math.min(ceilings[dimension], source.dimensions[dimension].cap!);
    const unavailable = configured.filter((source) => source.dimensions[dimension].remaining === null);
    const remaining = unavailable.length ? null : Math.min(ceilings[dimension], ...configured.map((source) => source.dimensions[dimension].remaining!));
    const limiting = unavailable.length ? unavailable.map((source) => source.id) : configured.filter((source) => source.dimensions[dimension].remaining === remaining).map((source) => source.id);
    if (!unavailable.length && remaining === input.base_caps[dimension]) limiting.push("existing:base");
    const status = remaining === null ? "unavailable" : remaining === 0 && input.base_caps[dimension] > 0 ? "exhausted" : "available";
    dimensions[dimension] = { ceiling: ceilings[dimension], remaining, status, warning: configured.some((source) => source.dimensions[dimension].warning), limiting_sources: limiting.sort() };
    if (status !== "available" && input.base_caps[dimension] > 0) denials.push({ code: status === "unavailable" ? "budget-accounting-unavailable" : "budget-exhausted", dimension, source_ids: limiting.sort() });
  }
  if (input.require_currency) denials.push({ code: "pricing-unavailable", source_ids: ["pricing:no-versioned-source"] });
  // Static ceiling binding only, not a final allocation or reservation proof.
  // No ledger, current balances, warnings or externally resolved availability enter this binding.
  const capFingerprint = hash({ source_fingerprint: input.source.fingerprint, attribution: { ...input.attribution, project_ids: [...input.attribution.project_ids].sort() }, base_caps: input.base_caps, policy_bindings: bindings, constraints: sortedConstraints.map(({ availability: _availability, ...constraint }) => constraint) });
  return frozen({ policy_bindings: bindings, cap_fingerprint: capFingerprint, ceilings, dimensions, sources, pricing: clone(input.source.policy.pricing), denials, can_admit: denials.length === 0 });
}
