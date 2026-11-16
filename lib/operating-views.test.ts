import { describe, expect, it } from "vitest";
import {
  assertOperatingView, OPERATING_SECTIONS, OperatingViewError, projectOperatingView,
  type OperatingFact, type OperatingSectionKind, type OperatingSourceInput, type OperatingView, type OperatingViewInput,
} from "./operating-views";

const NOW = "2026-10-16T12:00:00.000Z";
const OBSERVED = "2026-10-16T11:00:00.000Z";
const FRESH = "2026-10-16T13:00:00.000Z";
function fact(id: string, state: string | null, fields: Partial<OperatingFact> = {}): OperatingFact {
  return { id, label: `Public ${id}`, state, ...fields };
}
function source(items: readonly OperatingFact[] = [], fields: Partial<OperatingSourceInput> = {}): OperatingSourceInput {
  return { availability: "available", reason: "observed", origin: "saved", observed_at: OBSERVED, fresh_until: FRESH, complete: true, items, ...fields };
}
function input(overrides: Partial<Record<OperatingSectionKind, unknown>> = {}): OperatingViewInput {
  return { schema_version: 1, as_of: NOW, sources: {
    company: source([fact("surtec", null, { summary: "Build useful tools", principles: ["Evidence before claims"] })]),
    objectives: source([
      fact("root", "active"), fact("obj-a", "active", { parent_objective_id: "root", summary: "Useful outcome", criteria: ["An observable result"], target_date: "2026-12-31", reviewed_on: "2026-10-15" }),
      fact("obj-b", "paused"),
    ]),
    projects: source([fact("alpha", "active", { project_kind: "surtec-product", objective_ids: ["obj-a", "obj-b"], primary_objective_id: "obj-a" })]),
    issues: source([fact("issue-a", "working", { project_id: "alpha", objective_id: "obj-a", role_id: "software-engineer" })]),
    executions: source([fact("task-a", "finished", { project_id: "alpha", issue_id: "issue-a", result_status: "completed", evidence_ids: ["evidence-a"] })]),
    workflows: source([fact("workflow-a", "running", { project_id: "alpha", issue_id: "issue-a", workflow_template_id: "implementation", stage_kind: "qa" })]),
    signals: source([fact("signal-a", "open", { project_id: "alpha", issue_id: "issue-a" })]),
    commitments: source([fact("commitment-a", "planned", { project_id: "alpha", objective_id: "obj-a" })]),
    harness: source([fact("harness-a", "healthy", { project_id: "alpha" })]),
    sessions: source([fact("session-a", "active", { project_id: "alpha" })]),
    budgets: source([fact("budget-a", "within-limits", { project_id: "alpha" })]),
    ...overrides,
  } };
}
function section(view: OperatingView, kind: OperatingSectionKind) { return view.sections.find((item) => item.kind === kind)!; }
function rows(view: OperatingView, kind: OperatingSectionKind) { return section(view, kind).rows; }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const item of Object.values(value)) deepFreeze(item); }
  return value;
}

describe("pure operating views v1", () => {
  it("projects healthy public facts into eleven closed, independently sourced sections", () => {
    const view = projectOperatingView(input());
    expect(view.sections.map((item) => item.kind)).toEqual(OPERATING_SECTIONS);
    expect(view).toMatchObject({ schema_version: 1, view: "overview", focus_id: null, focus_status: "available", generated_at: NOW, execution_authority: "none" });
    expect(rows(view, "company")[0]).toMatchObject({ id: "surtec", summary: "Build useful tools", principles: ["Evidence before claims"] });
    expect(rows(view, "objectives").find((item) => item.id === "obj-a")).toMatchObject({ criteria: ["An observable result"], target_date: "2026-12-31", reviewed_on: "2026-10-15" });
    expect(section(view, "issues")).toMatchObject({ coverage: "complete", total: 1, has_more: false, next_cursor: null,
      source: { availability: "available", observed_at: OBSERVED, fresh_until: FRESH, origin: "saved", freshness: "fresh", complete: true } });
    expect(() => assertOperatingView(view)).not.toThrow();
  });

  it("does not turn missing observations into empty, current or authorized data", () => {
    const view = projectOperatingView({ schema_version: 1, as_of: NOW, sources: {} });
    for (const item of view.sections) expect(item).toMatchObject({ coverage: "unavailable", total: null, rows: [], has_more: null, next_cursor: null,
      source: { availability: "unavailable", reason: "missing-source", origin: null, observed_at: null, fresh_until: null, freshness: "unknown", complete: false } });
  });

  it("distinguishes a validated complete empty collection from optional absence and read failure", () => {
    const view = projectOperatingView(input({ issues: source(), harness: source([], { availability: "absent", reason: "optional-absent", complete: false }),
      signals: source([], { availability: "unavailable", reason: "read-failed", complete: false }) }));
    expect(section(view, "issues")).toMatchObject({ total: 0, coverage: "complete", has_more: false });
    expect(section(view, "harness")).toMatchObject({ total: null, coverage: "unavailable", source: { availability: "absent", freshness: "not-applicable" } });
    expect(section(view, "signals")).toMatchObject({ total: null, coverage: "unavailable", source: { reason: "read-failed", freshness: "unknown" } });
  });

  it.each([null, {}, { items: [] }, { ...source(), complete: "yes" }, { ...source(), raw_error: "private exception" },
    source([fact("same", "working", { project_id: "alpha" }), fact("same", "working", { project_id: "alpha" })]),
    source([fact("bad", "finished", { project_id: "alpha" })]), source([fact("bad", "working")]),
    source([fact("../outside", "working", { project_id: "alpha" })]), source([], { availability: "available", reason: "read-failed" }),
    source([], { availability: "absent", reason: "optional-absent" }),
    source([fact("bad", "working", { project_id: "alpha" })], { availability: "unavailable", reason: "read-failed", complete: false }),
  ])("isolates a corrupt source instead of retaining a filtered authoritative inventory (%#)", (invalid) => {
    const view = projectOperatingView(input({ issues: invalid }));
    expect(section(view, "issues")).toMatchObject({ rows: [], total: null, source: { availability: "unavailable", reason: "invalid-source", observed_at: null } });
    expect(section(view, "projects")).toMatchObject({ total: 1, coverage: "complete" });
  });

  it("refuses invalid company identity and inconsistent canonical project links per source", () => {
    const view = projectOperatingView(input({ company: source([fact("other", null)]),
      projects: source([fact("alpha", "active", { project_id: "beta", objective_ids: [], primary_objective_id: "missing" })]) }));
    expect(section(view, "company").source.reason).toBe("invalid-source");
    expect(section(view, "projects").source.reason).toBe("invalid-source");
    expect(section(view, "objectives").total).toBe(3);
  });

  it("enforces source and reference bounds without truncating corruption into a valid inventory", () => {
    for (const invalid of [
      source(Array.from({ length: 10_001 }, (_, index) => fact(`issue-${index}`, "proposed", { project_id: "alpha" }))),
      source([fact("issue-a", "proposed", { project_id: "alpha", evidence_ids: Array.from({ length: 101 }, (_, index) => `evidence-${index}`) })]),
      source([fact("issue-a", "proposed", { project_id: "alpha", criteria: Array(51).fill("A public criterion") })]),
    ]) {
      const view = projectOperatingView(input({ issues: invalid }));
      expect(section(view, "issues")).toMatchObject({ rows: [], total: null, source: { reason: "invalid-source" } });
      expect(section(view, "projects").total).toBe(1);
    }
  });

  it.each(["2026-02-30T11:00:00Z", "2026-10-16T25:00:00Z", "2026-10-16T12:01:00Z"])("rejects malformed or future source observation %s", (observed_at) => {
    expect(section(projectOperatingView(input({ signals: source([], { observed_at }) })), "signals").source.reason).toBe("invalid-source");
  });

  it("keeps observation time independent of generation time and classifies stale and unknown freshness", () => {
    const view = projectOperatingView(input({ company: source([], { fresh_until: "2026-10-16T11:59:59Z" }),
      objectives: source([], { fresh_until: NOW }), signals: source([], { fresh_until: null, origin: "live-local" }),
      commitments: source([], { observed_at: null, fresh_until: null, origin: "manual" }) }));
    expect(section(view, "company").source).toMatchObject({ observed_at: OBSERVED, freshness: "stale" });
    expect(section(view, "objectives").source.freshness).toBe("fresh");
    expect(section(view, "signals").source).toMatchObject({ freshness: "unknown", origin: "live-local" });
    expect(section(view, "commitments").source).toMatchObject({ freshness: "unknown", observed_at: null, origin: "manual" });
    expect(view.generated_at).toBe(NOW);
  });

  it.each([{ observed_at: null, fresh_until: FRESH }, { fresh_until: "2026-10-16T10:00:00Z" }])("refuses impossible freshness metadata (%#)", (fields) => {
    expect(section(projectOperatingView(input({ signals: source([], fields) })), "signals").source.reason).toBe("invalid-source");
  });

  it.each(["working", "checking", "needs-decision", "ready-for-review", "done", "blocked"] as const)("preserves authoritative issue state %s as a presentation label", (state) => {
    const [item] = rows(projectOperatingView(input({ issues: source([fact("issue-a", state, { project_id: "alpha" })]) })), "issues");
    expect(item).toMatchObject({ state, operating_state: state, secondary_state: null, execution_authority: "none" });
  });

  it.each(["proposed", "authorized", "cancelled"])("keeps %s as a secondary issue state without acceptance", (state) => {
    const [item] = rows(projectOperatingView(input({ issues: source([fact("issue-a", state, { project_id: "alpha" })]) })), "issues");
    expect(item).toMatchObject({ operating_state: null, secondary_state: state, decision_reason: null });
  });

  it.each([
    ["queued", null, null], ["running", null, "working"], ["finished", "completed", null],
    ["finished", "cancelled", null], ["finished", "blocked", "blocked"], ["finished", "failed", "needs-decision"],
    ["finished", "partial", "needs-decision"], ["finished", "needs-review", "needs-decision"],
  ])("projects execution %s/%s without treating completion as accepted work", (state, result, primary) => {
    const [item] = rows(projectOperatingView(input({ executions: source([fact("task-a", state, { project_id: "alpha", result_status: result as OperatingFact["result_status"] })]) })), "executions");
    expect(item.operating_state).toBe(primary);
    expect(item.operating_state).not.toBe("done");
  });

  it.each([
    ["running", "qa", "checking"], ["running", "review", "checking"], ["running", "implementation", "working"],
    ["waiting-human", null, "needs-decision"], ["needs-decision", null, "needs-decision"], ["completed", null, null], ["cancelled", null, null],
  ])("keeps workflow %s/%s distinct from issue acceptance", (state, stage, primary) => {
    const [item] = rows(projectOperatingView(input({ workflows: source([fact("workflow-a", state, { project_id: "alpha", stage_kind: stage as OperatingFact["stage_kind"] })]) })), "workflows");
    expect(item.operating_state).toBe(primary);
  });

  it.each(["scope-changed", "policy-changed", "conflicting-evidence", "budget-exhausted", "correction-exhausted", "required-harness", "external-action"] as const)("retains the exact known decision reason %s without an executable action", (decision_reason) => {
    const [item] = rows(projectOperatingView(input({ issues: source([fact("issue-a", "needs-decision", { project_id: "alpha", decision_reason })]) })), "issues");
    expect(item).toMatchObject({ decision_reason, suggested_action: "inspect-evidence", execution_authority: "none", lineage: { requires_authorization: true } });
  });

  it("reports an unclassified decision as evidence-gap, without guessing from a label or validation", () => {
    const [item] = rows(projectOperatingView(input({ issues: source([fact("issue-a", "needs-decision", { project_id: "alpha", label: "Maybe budget or scope", validation_status: "failed" })]) })), "issues");
    expect(item.decision_reason).toBe("evidence-gap");
  });

  it("does not invent a dependency blocker when its source only records blocked", () => {
    for (const decision_reason of [undefined, "dependency-blocked"] as const) {
      const [item] = rows(projectOperatingView(input({ issues: source([fact("issue-a", "blocked", { project_id: "alpha", decision_reason })]) })), "issues");
      expect(item.decision_reason).toBe(decision_reason ?? "evidence-gap");
    }
  });

  it("keeps candidate validity, verification, Harness presence and execution results independent", () => {
    const view = projectOperatingView(input({ issues: source([fact("issue-a", "checking", { project_id: "alpha", candidate_validity: "stale", validation_status: "passed" })]) }));
    expect(rows(view, "issues")[0]).toMatchObject({ operating_state: "checking", candidate_validity: "stale", validation_status: "passed" });
    expect(rows(view, "harness")[0]).toMatchObject({ state: "healthy", validation_status: "unknown", operating_state: null });
    expect(rows(view, "executions")[0]).toMatchObject({ result_status: "completed", operating_state: null });
    expect(rows(view, "commitments")[0]).not.toHaveProperty("delivery_observation");
  });

  it.each(["personal", "experiment"] as const)("supports intentionally unaligned %s work without client/objective/Harness ceremony", (project_kind) => {
    const view = projectOperatingView(input({ projects: source([fact("alpha", "active", { project_kind, objective_ids: [], primary_objective_id: null })]),
      objectives: source(), issues: source([fact("issue-a", "proposed", { project_id: "alpha", objective_id: null })]),
      harness: source([], { availability: "not-enabled", reason: "not-required", complete: false }) }), { kind: "project", id: "alpha" });
    expect(rows(view, "projects")[0].lineage).toMatchObject({ alignment: "intentionally-unaligned", objective_ids: [], gaps: [], requires_authorization: true });
    expect(rows(view, "issues")[0]).toMatchObject({ objective_id: null, operating_state: null, lineage: { alignment: "intentionally-unaligned" } });
    expect(section(view, "harness").source.reason).toBe("not-required");
    expect(rows(view, "projects")[0].suggested_action).toBe("preview-context");
  });

  it("follows exact issue ancestry and never duplicates its contribution across secondary project objectives", () => {
    const data = input({ issues: source([
      fact("issue-a", "working", { project_id: "alpha", objective_id: "obj-a", role_id: "software-engineer" }),
      fact("issue-b", "blocked", { project_id: "alpha", objective_id: "obj-b" }),
      fact("issue-none", "proposed", { project_id: "alpha", objective_id: null }),
    ]) });
    const a = projectOperatingView(data, { kind: "objective", id: "obj-a" });
    const b = projectOperatingView(data, { kind: "objective", id: "obj-b" });
    expect(rows(a, "issues").map((item) => item.id)).toEqual(["issue-a"]);
    expect(rows(b, "issues").map((item) => item.id)).toEqual(["issue-b"]);
    expect(rows(a, "projects").map((item) => item.id)).toEqual(["alpha"]);
    expect(rows(b, "projects").map((item) => item.id)).toEqual(["alpha"]);
    expect(rows(a, "objectives").map((item) => item.id)).toEqual(["obj-a", "root"]);
    expect(rows(a, "executions")[0].lineage).toMatchObject({ objective_ids: ["root", "obj-a"], project_id: "alpha", issue_id: "issue-a", role_id: "software-engineer" });
    expect(rows(b, "executions")).toEqual([]);
    expect(rows(projectOperatingView(data), "issues").find((item) => item.id === "issue-none")?.objective_id).toBeNull();
  });

  it("includes descendant links of secondary project objectives without attributing unrelated issues", () => {
    const data = input({ objectives: source([fact("parent", "active"), fact("child", "active", { parent_objective_id: "parent" }), fact("obj-a", "active")]),
      projects: source([fact("alpha", "active", { objective_ids: ["obj-a", "child"], primary_objective_id: "obj-a" })]) });
    const view = projectOperatingView(data, { kind: "objective", id: "parent" });
    expect(rows(view, "projects").map((item) => item.id)).toEqual(["alpha"]);
    expect(rows(view, "issues")).toEqual([]);
    expect(rows(view, "objectives").map((item) => item.id)).toEqual(["child", "parent"]);
  });

  it("scopes project and issue detail without falling back to unfiltered global lists", () => {
    const data = input({ projects: source([fact("alpha", "active", { objective_ids: ["obj-a", "obj-b"], primary_objective_id: "obj-a" }), fact("beta", "active")]),
      issues: source([fact("issue-a", "working", { project_id: "alpha", objective_id: "obj-a" }), fact("issue-b", "working", { project_id: "beta" })]),
      signals: source([fact("signal-a", "open", { project_id: "alpha", issue_id: "issue-a" }), fact("signal-other", "open", { project_id: "alpha" })]) });
    const project = projectOperatingView(data, { kind: "project", id: "alpha" });
    const issue = projectOperatingView(data, { kind: "issue", id: "issue-a" });
    expect(rows(project, "projects").map((item) => item.id)).toEqual(["alpha"]);
    expect(rows(project, "issues").map((item) => item.id)).toEqual(["issue-a"]);
    expect(rows(project, "objectives").map((item) => item.id)).toEqual(["obj-a", "obj-b", "root"]);
    expect(rows(issue, "objectives").map((item) => item.id)).toEqual(["obj-a", "root"]);
    expect(rows(issue, "signals").map((item) => item.id)).toEqual(["signal-a"]);
  });

  it("distinguishes not-found focus from an unavailable or partial focus inventory", () => {
    const missing = projectOperatingView(input(), { kind: "issue", id: "missing" });
    const unavailable = projectOperatingView(input({ issues: null }), { kind: "issue", id: "issue-a" });
    const partial = projectOperatingView(input({ issues: source([], { complete: false }) }), { kind: "issue", id: "missing" });
    expect(missing.focus_status).toBe("not-found");
    expect(unavailable.focus_status).toBe("unavailable");
    expect(partial.focus_status).toBe("unavailable");
    for (const view of [missing, unavailable, partial]) for (const item of view.sections) expect(item).toMatchObject({ rows: [], total: null, coverage: "unavailable" });
  });

  it("exposes missing graph references rather than inventing ancestry or ownership", () => {
    const view = projectOperatingView(input({ executions: source([fact("orphan", "running", { project_id: "missing", issue_id: "missing-issue", objective_id: "missing-objective" })]) }));
    expect(rows(view, "executions")[0]).toMatchObject({ objective_id: "missing-objective", lineage: { alignment: "unavailable", objective_ids: [],
      project_id: "missing", issue_id: "missing-issue", gaps: ["project-unavailable", "issue-unavailable", "objective-unavailable"] } });
  });

  it("does not inherit ancestry or a role from a foreign-project issue", () => {
    const data = input({ executions: source([fact("task-a", "running", { project_id: "beta", issue_id: "issue-a" })]) });
    const [item] = rows(projectOperatingView(data), "executions");
    expect(item.lineage).toMatchObject({ alignment: "unavailable", objective_ids: [], role_id: null, gaps: ["project-unavailable", "cross-project"] });
    expect(rows(projectOperatingView(data, { kind: "issue", id: "issue-a" }), "executions")).toEqual([]);
  });

  it("marks an explicit task/issue objective disagreement instead of silently picking an aligned link", () => {
    for (const objective_id of [null, "obj-b"]) {
      const [item] = rows(projectOperatingView(input({ executions: source([fact("task-a", "running", { project_id: "alpha", issue_id: "issue-a", objective_id })]) })), "executions");
      expect(item.lineage).toMatchObject({ alignment: "unavailable", gaps: ["objective-not-linked"] });
      expect(item.objective_id).toBe(objective_id);
    }
  });

  it("refuses contradictory complete/coverage-incomplete source metadata", () => {
    const view = projectOperatingView(input({ issues: source([], { reason: "coverage-incomplete", complete: true }) }));
    expect(section(view, "issues")).toMatchObject({ total: null, source: { reason: "invalid-source" } });
  });

  it("keeps invalid objective links and cyclic ancestry explicit and bounded", () => {
    const view = projectOperatingView(input({ objectives: source([fact("obj-a", "active", { parent_objective_id: "parent" }), fact("parent", "active", { parent_objective_id: "obj-a" })]),
      issues: source([fact("issue-a", "working", { project_id: "alpha", objective_id: "unlinked" })]) }));
    expect(rows(view, "objectives").find((item) => item.id === "obj-a")).toMatchObject({ objective_id: "obj-a", lineage: { alignment: "unavailable", gaps: ["objective-cycle"] } });
    expect(rows(view, "issues")[0].lineage.gaps).toEqual(["objective-not-linked", "objective-unavailable"]);
  });

  it("retains the actual leaf at the eight-objective depth bound", () => {
    const objectives = Array.from({ length: 9 }, (_, index) => fact(`obj-${index}`, "active", { parent_objective_id: index === 8 ? null : `obj-${index + 1}` }));
    const view = projectOperatingView(input({ objectives: source(objectives) }));
    const item = rows(view, "objectives").find((item) => item.id === "obj-0")!;
    expect(item.objective_id).toBe("obj-0");
    expect(item.lineage).toMatchObject({ objective_ids: ["obj-7", "obj-6", "obj-5", "obj-4", "obj-3", "obj-2", "obj-1", "obj-0"], gaps: ["objective-depth"], alignment: "unavailable" });
  });

  it("does not claim complete objective-scoped totals when a join source is unavailable or partial", () => {
    for (const issues of [null, source([], { complete: false })]) {
      const view = projectOperatingView(input({ issues }), { kind: "objective", id: "obj-a" });
      expect(section(view, "projects")).toMatchObject({ total: null, coverage: "partial", has_more: null });
      expect(section(view, "company")).toMatchObject({ total: 1, coverage: "complete" });
    }
  });

  it("keeps incomplete lineage visible without declaring a complete graph contribution", () => {
    const view = projectOperatingView(input({ objectives: source([fact("obj-a", "active", { parent_objective_id: "missing" })]) }), { kind: "objective", id: "obj-a" });
    expect(section(view, "issues")).toMatchObject({ total: null, coverage: "partial" });
    expect(rows(view, "issues")[0].lineage).toMatchObject({ alignment: "unavailable", objective_ids: ["obj-a"], gaps: ["objective-unavailable"] });
  });

  it("caps each page at fifty rows with stable ordering and observation-bound, scoped cursors", () => {
    const issues = Array.from({ length: 51 }, (_, index) => fact(`issue-${String(index).padStart(3, "0")}`, "proposed", { project_id: "alpha" })).reverse();
    const data = input({ issues: source(issues) });
    const first = projectOperatingView(data);
    expect(section(first, "issues")).toMatchObject({ total: 51, has_more: true });
    expect(rows(first, "issues")).toHaveLength(50);
    expect(rows(first, "issues")[0].id).toBe("issue-000");
    const cursor = section(first, "issues").next_cursor!;
    const second = projectOperatingView(data, { kind: "overview", cursors: { issues: cursor } });
    expect(section(second, "issues")).toMatchObject({ total: 51, has_more: false, next_cursor: null });
    expect(rows(second, "issues").map((item) => item.id)).toEqual(["issue-050"]);
    expect(() => projectOperatingView(data, { kind: "project", id: "alpha", cursors: { issues: cursor } })).toThrow(OperatingViewError);
    expect(() => projectOperatingView(input({ issues: source(issues, { observed_at: "2026-10-16T11:01:00Z" }) }), { kind: "overview", cursors: { issues: cursor } })).toThrow(OperatingViewError);
  });

  it("uses the requested smaller page size and refuses unknown row or cross-section cursors", () => {
    const data = input({ issues: source([fact("i-a", "working", { project_id: "alpha" }), fact("i-b", "working", { project_id: "alpha" })]) });
    const first = projectOperatingView(data, { kind: "project", id: "alpha", page_size: 1 });
    const cursor = section(first, "issues").next_cursor!;
    expect(rows(first, "issues")).toHaveLength(1);
    expect(rows(projectOperatingView(data, { kind: "project", id: "alpha", page_size: 1, cursors: { issues: cursor } }), "issues")[0].id).toBe("i-b");
    for (const forged of [cursor.replace("|issues|", "|projects|"), cursor.replace(/i-a$/, "missing"), cursor.replace(/i-a$/, "../outside")]) {
      expect(() => projectOperatingView(data, { kind: "project", id: "alpha", cursors: { issues: forged } })).toThrow(OperatingViewError);
    }
  });

  it("keeps partial source totals unknown even after exhausting the visible inventory", () => {
    const data = input({ issues: source([fact("i-a", "working", { project_id: "alpha" }), fact("i-b", "working", { project_id: "alpha" })], { complete: false }) });
    const first = projectOperatingView(data, { kind: "overview", page_size: 1 });
    expect(section(first, "issues")).toMatchObject({ total: null, coverage: "partial", has_more: true, source: { reason: "coverage-incomplete" } });
    const last = projectOperatingView(data, { kind: "overview", cursors: { issues: section(first, "issues").next_cursor! } });
    expect(section(last, "issues")).toMatchObject({ total: null, coverage: "partial", has_more: null, next_cursor: null });
  });

  it.each([
    { kind: "unknown" }, { kind: "overview", id: "alpha" }, { kind: "project" }, { kind: "project", id: "../outside" },
    { kind: "issue", id: "a/b" }, { kind: "overview", page_size: 0 }, { kind: "overview", page_size: 51 },
    { kind: "overview", page_size: 1.5 }, { kind: "overview", force: true }, { kind: "overview", cursors: { private: "cursor" } },
  ])("refuses an unsafe or unrecognized request without echoing it (%#)", (request) => {
    expect(() => projectOperatingView(input(), request)).toThrowError("Operating view input, query or response is invalid.");
  });

  it.each([null, {}, { ...input(), schema_version: 2 }, { ...input(), as_of: "2026-02-30T12:00:00Z" },
    { ...input(), sources: { unknown: source() } }, { ...input(), execute: true },
  ])("rejects an invalid projection envelope (%#)", (value) => {
    expect(() => projectOperatingView(value)).toThrow(OperatingViewError);
  });

  it("leaves P budgets preview-only and continuity deferred even when an observation claims healthy limits", () => {
    const view = projectOperatingView(input());
    expect(view.phase_p).toEqual({ budget_cutover: "not-enabled", continuity: "deferred" });
    expect(section(view, "budgets")).toMatchObject({ source: { availability: "not-enabled", reason: "phase-p-deferred", freshness: "not-applicable", complete: false }, total: null, coverage: "partial" });
    expect(rows(view, "budgets")[0]).toMatchObject({ state: "within-limits", execution_authority: "none", suggested_action: "open-detail" });
    expect(JSON.stringify(view)).not.toContain("remaining_balance");
  });

  it("omits raw private fields by refusing their source and never serializing the original exception", () => {
    const confidential = "fixture-confidential-feedback";
    const view = projectOperatingView(input({ issues: source([{ ...fact("issue-a", "working", { project_id: "alpha" }), notes: confidential, instructions: confidential } as OperatingFact]),
      signals: { ...source(), error: { message: confidential, stack: "C:\\private\\fixture.ts" } } }));
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(confidential);
    expect(serialized).not.toContain("fixture.ts");
    expect(section(view, "issues").source.reason).toBe("invalid-source");
    expect(section(view, "signals").source.reason).toBe("invalid-source");
  });

  it("applies pattern redaction to public text and suppresses absolute filesystem paths", () => {
    const view = projectOperatingView(input({ company: source([fact("surtec", null, { summary: "api_key=fixture-secret", principles: ["C:\\private\\project", "/private/fixture", "\\\\server\\share", "https://user:pass@example.test"] })]),
      objectives: source([fact("obj-a", "active", { label: "Bearer: fixture-token", criteria: ["api_key=fixture-secret", "Keep\ncontrols readable"] })]) }));
    const serialized = JSON.stringify(view);
    for (const privateValue of ["fixture-secret", "fixture-token", "private\\\\project", "/private/fixture", "server\\\\share", "user:pass"]) expect(serialized).not.toContain(privateValue);
    expect(rows(view, "company")[0].principles.slice(0, 3)).toEqual(Array(3).fill("[private path omitted]"));
    expect(rows(view, "objectives")[0].criteria).toEqual(["api_key=[REDACTED]", "Keep controls readable"]);
  });

  it("is deterministic, does not mutate frozen facts and returns detached public arrays", () => {
    const data = deepFreeze(input());
    const before = JSON.stringify(data), first = projectOperatingView(data), second = projectOperatingView(data);
    expect(first).toEqual(second);
    (rows(first, "projects")[0].objective_ids as string[]).push("not-an-input-link");
    (rows(first, "executions")[0].evidence_ids as string[]).push("not-input-evidence");
    rows(first, "objectives")[0].lineage.objective_ids.push("not-input-ancestry");
    expect(JSON.stringify(data)).toBe(before);
    expect(projectOperatingView(data)).toEqual(second);
  });

  it.each([
    ["version", (view: OperatingView) => Object.assign(view, { schema_version: 2 })],
    ["unknown root field", (view: OperatingView) => Object.assign(view, { private_context: "fixture" })],
    ["root authority", (view: OperatingView) => Object.assign(view, { execution_authority: "execute" })],
    ["row authority", (view: OperatingView) => Object.assign(rows(view, "issues")[0], { execution_authority: "execute" })],
    ["private row field", (view: OperatingView) => Object.assign(rows(view, "issues")[0], { feedback: "fixture" })],
    ["kind order", (view: OperatingView) => view.sections.reverse()],
    ["row kind", (view: OperatingView) => Object.assign(rows(view, "issues")[0], { kind: "projects", state: "active" })],
    ["duplicates", (view: OperatingView) => rows(view, "issues").push(rows(view, "issues")[0])],
    ["page overflow", (view: OperatingView) => Object.assign(section(view, "issues"), { rows: Array(51).fill(rows(view, "issues")[0]) })],
    ["unknown exact total", (view: OperatingView) => Object.assign(section(view, "issues"), { total: null })],
    ["false total", (view: OperatingView) => Object.assign(section(view, "issues"), { total: 0 })],
    ["false freshness", (view: OperatingView) => Object.assign(section(view, "issues").source, { freshness: "stale" })],
    ["future observation", (view: OperatingView) => Object.assign(section(view, "issues").source, { observed_at: FRESH })],
    ["source reason", (view: OperatingView) => Object.assign(section(view, "issues").source, { reason: "read-failed" })],
    ["cursor without next page", (view: OperatingView) => Object.assign(section(view, "issues"), { next_cursor: "forged" })],
    ["cursor scope", (view: OperatingView) => Object.assign(section(view, "issues"), { has_more: true, next_cursor: "forged" })],
    ["finished task acceptance", (view: OperatingView) => Object.assign(rows(view, "executions")[0], { operating_state: "done" })],
    ["issue label mismatch", (view: OperatingView) => Object.assign(rows(view, "issues")[0], { operating_state: "done" })],
    ["lineage authority", (view: OperatingView) => Object.assign(rows(view, "issues")[0].lineage, { requires_authorization: false })],
    ["lineage mismatch", (view: OperatingView) => Object.assign(rows(view, "issues")[0].lineage, { project_id: "foreign" })],
    ["false alignment", (view: OperatingView) => rows(view, "issues")[0].lineage.gaps.push("objective-unavailable")],
    ["P activation", (view: OperatingView) => Object.assign(view.phase_p, { budget_cutover: "enabled" })],
  ])("validates closed response semantics and refuses %s", (_name, mutate) => {
    const view = projectOperatingView(input());
    mutate(view);
    expect(() => assertOperatingView(view)).toThrow(OperatingViewError);
  });
});
