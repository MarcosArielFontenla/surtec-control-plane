import { describe, expect, it } from "vitest";
import { assertResolvedWorkflowReviewPolicy, resolveWorkflowReviewPolicy, type WorkflowReviewInput } from "./review-policy";

const fixture = (): WorkflowReviewInput => ({ template_id: "implementation", work_scale: "bounded", criticality: "low",
  classification: { affected_domains: ["backend"], requires_migration: false, security_impact: false }, change_categories: ["code"], behavior_change: true, critical_client_operations: false,
  floors: { roles: [{ role_id: "software-engineer", depth: "focused" }, { role_id: "reviewer", depth: "focused" }], testing: "focused", routing: "focused", project: null, harness: null, workflow: "focused" }, trusted_qa_required: false });

describe("deterministic workflow review requirements", () => {
  it("keeps bounded behavioral work focused and stable without copying private input labels", () => {
    const input = fixture(), before = structuredClone(input);
    const policy = resolveWorkflowReviewPolicy(input);
    expect(policy).toMatchObject({ intrinsic_depth: "focused", minimum_depth: "focused", effective_depth: "focused", qa_required: false });
    expect(policy.fingerprint).toMatch(/^[a-f0-9]{64}$/); expect(resolveWorkflowReviewPolicy(input)).toEqual(policy);
    expect(() => assertResolvedWorkflowReviewPolicy(policy)).not.toThrow(); expect(input).toEqual(before);
    input.classification.affected_domains = ["synthetic-private-domain"];
    expect(JSON.stringify(resolveWorkflowReviewPolicy(input))).not.toContain("synthetic-private-domain");
  });
  it("shows intrinsic passive only for trivial non-behavioral documentation while retaining focused acceptance", () => {
    const input = fixture(); input.work_scale = "trivial"; input.behavior_change = false; input.change_categories = ["documentation", "runbook"];
    expect(resolveWorkflowReviewPolicy(input)).toMatchObject({ intrinsic_depth: "passive", minimum_depth: "focused", effective_depth: "focused", qa_required: false });
    input.behavior_change = true; expect(resolveWorkflowReviewPolicy(input).intrinsic_depth).toBe("focused");
    input.behavior_change = false; input.change_categories.push("code"); expect(resolveWorkflowReviewPolicy(input).intrinsic_depth).toBe("focused");
    input.change_categories = []; expect(resolveWorkflowReviewPolicy(input).intrinsic_depth).toBe("focused");
  });
  it.each(["security", "authentication", "authorization", "authn", "authz", "persistence", "data-model", "database", "migration", "payments", "billing", "infrastructure", "deployment", "ci-cd"])("requires full review and QA for trusted %s domain/category", (category) => {
    const input = fixture(); input.change_categories = [category];
    expect(resolveWorkflowReviewPolicy(input)).toMatchObject({ intrinsic_depth: "full", effective_depth: "full", qa_required: true });
    input.change_categories = ["code"]; input.classification.affected_domains = [category]; expect(resolveWorkflowReviewPolicy(input).intrinsic_depth).toBe("full");
  });
  it.each(["security", "migration", "criticality", "client", "broad"])("retains intrinsic full risk from %s classification", (risk) => {
    const input = fixture(); input.work_scale = "trivial"; input.behavior_change = false; input.change_categories = ["documentation"];
    if (risk === "security") input.classification.security_impact = true;
    if (risk === "migration") input.classification.requires_migration = true;
    if (risk === "criticality") input.criticality = "high";
    if (risk === "client") input.critical_client_operations = true;
    if (risk === "broad") input.classification.affected_domains = ["ui", "api", "workflow"];
    expect(resolveWorkflowReviewPolicy(input)).toMatchObject({ intrinsic_depth: "full", effective_depth: "full", qa_required: true });
  });
  it.each(["role", "testing", "routing", "project", "harness", "workflow"])("cannot downgrade the current %s floor", (layer) => {
    const input = fixture();
    if (layer === "role") input.floors.roles[0]!.depth = "full";
    else input.floors[layer as "testing" | "routing" | "project" | "harness" | "workflow"] = "full";
    const policy = resolveWorkflowReviewPolicy(input);
    expect(policy).toMatchObject({ intrinsic_depth: "focused", minimum_depth: "full", effective_depth: "full", qa_required: true });
    expect(policy.reasons).toContain(`${layer} minimum: full`);
  });
  it("preserves full Phase N routing for substantial work and explicit QA independent of depth", () => {
    const input = fixture(); input.work_scale = "substantial"; input.floors.routing = "full";
    expect(resolveWorkflowReviewPolicy(input).effective_depth).toBe("full");
    input.work_scale = "bounded"; input.floors.routing = "focused"; input.trusted_qa_required = true;
    expect(resolveWorkflowReviewPolicy(input)).toMatchObject({ effective_depth: "focused", qa_required: true });
    input.trusted_qa_required = false; input.template_id = "quality-review"; expect(resolveWorkflowReviewPolicy(input).qa_required).toBe(true);
  });
  it("normalizes duplicate domain labels for broad-risk count without erasing required layers", () => {
    const input = fixture(); input.classification.affected_domains = ["API", "api", " api "];
    expect(resolveWorkflowReviewPolicy(input).intrinsic_depth).toBe("focused");
    input.floors.roles.reverse(); expect(resolveWorkflowReviewPolicy(input)).toEqual(resolveWorkflowReviewPolicy(fixture()));
  });
  it.each(["floor", "missing-role", "unknown-role", "duplicate-role", "risk-flag", "unknown-template", "unknown-scale", "unknown-criticality", "oversize-label"])("fails closed on invalid trusted inputs %s", (failure) => {
    const input = fixture();
    if (failure === "floor") input.floors.testing = "passive" as never;
    if (failure === "missing-role") input.floors.roles = [];
    if (failure === "unknown-role") input.floors.roles[0]!.role_id = "model-owner" as never;
    if (failure === "duplicate-role") input.floors.roles.push(input.floors.roles[0]!);
    if (failure === "risk-flag") input.classification.security_impact = "false" as never;
    if (failure === "unknown-template") input.template_id = "graph" as never;
    if (failure === "unknown-scale") input.work_scale = "minimal" as never;
    if (failure === "unknown-criticality") input.criticality = "none" as never;
    if (failure === "oversize-label") input.change_categories = ["x".repeat(101)];
    expect(() => resolveWorkflowReviewPolicy(input)).toThrow(/Invalid/);
  });
  it("rejects unsealed or contradictory review policy and changes its fingerprint on effective requirements", () => {
    const policy = resolveWorkflowReviewPolicy(fixture());
    expect(() => assertResolvedWorkflowReviewPolicy({ ...policy, qa_required: true })).toThrow();
    expect(() => assertResolvedWorkflowReviewPolicy({ ...policy, intrinsic_depth: "full" })).toThrow();
    expect(() => assertResolvedWorkflowReviewPolicy({ ...policy, effective_depth: "passive" as never })).toThrow();
    expect(() => assertResolvedWorkflowReviewPolicy({ ...policy, reasons: [] })).toThrow();
    const input = fixture(); input.trusted_qa_required = true; expect(resolveWorkflowReviewPolicy(input).fingerprint).not.toBe(policy.fingerprint);
  });
});
