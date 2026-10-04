import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import type { WorkIssue, IssueEvidenceReference } from "../issues/types";
import type { TaskEnvelope } from "../state/types";
import type { WorkflowRoleOutput } from "./types";
import { roleOutputResult, validateRoleOutput, workflowRoleOutputSchema, type RoleOutputEvidence } from "./role-output";
import { assertAgentResult } from "../../runner/result";
import { AGENT_REPORT_SCHEMA, validateAgentReport } from "../../runner/agent-report";

const issue = { id: "I-1", scope_revision: 1, acceptance_criteria: ["Expected behavior"], task_ids: ["T-1"], evidence_ids: ["E-1"] } as WorkIssue;
const evidence = { "E-1": { id: "E-1", issue_id: "I-1", task_id: "T-1", execution_id: "run-1", candidate_id: null, candidate_revision: null,
  diff_fingerprint: null, scope_revision: 1, kind: "task", status: "informational" } as IssueEvidenceReference };
const envelope = { id: "T-role", agent: "test-adapter" } as TaskEnvelope;
const base = { schema_version: 1 as const, status: "completed" as const, summary: "Bounded synthetic observation", evidence_ids: ["E-1"], unresolved_questions: [], risks: [], recommended_next_action: "Human review", requested_decision: null };
const outputs: Record<RoleOutputEvidence["kind"], WorkflowRoleOutput> = {
  planning: { ...base, kind: "plan", plan: ["Exact current scoped work"], scope_change_required: false },
  analysis: { ...base, kind: "analysis", recommendations: ["A recommendation, not approval"] },
  operations: { ...base, kind: "operations", proposed_issue: null },
  review: { ...base, kind: "review", verdict: "approve", findings: [] },
  qa: { ...base, kind: "qa", verdict: "approve", findings: [], criteria: [{ criterion: "Expected behavior", status: "supported", evidence_ids: ["E-1"] }] },
};
function facts(kind: RoleOutputEvidence["kind"] = "analysis"): RoleOutputEvidence { return { kind, issue: structuredClone(issue), evidence: structuredClone(evidence), candidate: null }; }

describe("concrete workflow role output contracts", () => {
  it.each(Object.keys(outputs) as RoleOutputEvidence["kind"][])("provides a self-contained strict %s schema and normalizes without generic claims", (kind) => {
    const schema = workflowRoleOutputSchema(kind), before = JSON.stringify(schema);
    expect(schema.type).toBe("object"); expect(schema.additionalProperties).toBe(false);
    expect(before).not.toContain("$ref"); expect(before).not.toContain("oneOf");
    const validate = new Ajv2020({ strict: true }).compile(schema);
    expect(validate(outputs[kind])).toBe(true);
    expect(validate({ ...outputs[kind], permissions: ["write"] })).toBe(false);
    const normalized = roleOutputResult(envelope, outputs[kind], facts(kind), "reports/fixture.jsonl");
    expect(normalized.output).toEqual(outputs[kind]); expect(normalized.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(assertAgentResult(normalized.result)).toMatchObject({ status: "completed", files_changed: [], commands_run: [], tests_run: [], verification: null });
    (schema.properties as any).status = {};
    expect(JSON.stringify(workflowRoleOutputSchema(kind))).toBe(before);
    expect(validateAgentReport(outputs[kind]).ok).toBe(false);
  });
  it.each(["implementation", "correction"] as const)("retains the unchanged generic report for %s", (kind) => {
    expect(() => workflowRoleOutputSchema(kind)).toThrow(/generic agent-report/);
    expect(AGENT_REPORT_SCHEMA.properties).not.toHaveProperty("kind");
  });
  it.each([null, "raw answer", { ...outputs.analysis, schema_version: 2 }, { ...outputs.analysis, approved_by: "human" },
    { ...outputs.analysis, summary: " " }, { ...outputs.analysis, recommendations: Array(21).fill("too many") },
    { ...outputs.analysis, summary: "x".repeat(2001) }, { ...outputs.analysis, unresolved_questions: ["x".repeat(501)] },
    { ...outputs.analysis, evidence_ids: ["E-unavailable"] }, { ...outputs.analysis, kind: "plan" }])("rejects malformed or forged output without raw fallback %#", (value) => {
    const normalized = roleOutputResult(envelope, value, facts(), "reports/fixture.jsonl");
    expect(normalized.output).toBeNull(); expect(normalized.fingerprint).toBeNull(); expect(normalized.result.status).toBe("needs-review");
    expect(normalized.result.summary).toBe("Workflow role returned no valid bounded output.");
  });
  it.each(["unindexed", "other-issue", "other-task", "scope", "candidate"])("rejects %s evidence provenance", (caseName) => {
    const current = facts();
    if (caseName === "unindexed") current.issue.evidence_ids = [];
    if (caseName === "other-issue") current.evidence["E-1"]!.issue_id = "I-other";
    if (caseName === "other-task") current.evidence["E-1"]!.task_id = "T-other";
    if (caseName === "scope") current.evidence["E-1"]!.scope_revision = 2;
    if (caseName === "candidate") current.evidence["E-1"]!.candidate_id = "C-other";
    expect(() => validateRoleOutput(outputs.analysis, current)).toThrow(/evidence/);
  });
  it("validates nested finding/criterion references and every exact QA criterion", () => {
    const review = { ...outputs.review, verdict: "correction-required", findings: [{ id: "F-1", severity: "blocking", summary: "Concrete finding", path: "src/file.ts", evidence_ids: ["E-unavailable"], scope_change_required: false }] };
    expect(() => validateRoleOutput(review, facts("review"))).toThrow(/evidence/);
    expect(() => validateRoleOutput({ ...outputs.qa, criteria: [{ criterion: "Invented criterion", status: "supported", evidence_ids: ["E-1"] }] }, facts("qa"))).toThrow(/exact current/);
    expect(() => validateRoleOutput({ ...outputs.qa, criteria: [{ criterion: "Expected behavior", status: "supported", evidence_ids: [] }] }, facts("qa"))).toThrow(/evidence/);
    expect(() => validateRoleOutput({ ...outputs.review, verdict: "correction-required", findings: [] }, facts("review"))).toThrow(/concrete/);
  });
  it("never accepts inherited/accessor/cyclic output or leaks a sensitive body", () => {
    const getter = Object.defineProperty({ ...outputs.analysis }, "summary", { get: () => { throw new Error("getter must not run"); }, enumerable: true });
    for (const value of [Object.assign(Object.create(outputs.analysis), {}), getter, { ...outputs.analysis, summary: `token=ghp_${"a".repeat(32)}` }]) {
      const normalized = roleOutputResult(envelope, value, facts(), "fixture");
      expect(normalized.output).toBeNull(); expect(JSON.stringify(normalized)).not.toContain("ghp_");
    }
    const cyclic: any = { ...outputs.analysis }; cyclic.extra = cyclic;
    expect(roleOutputResult(envelope, cyclic, facts(), "fixture").result.status).toBe("needs-review");
  });
  it("bounds total serialized bytes independently of per-field limits", () => {
    const value = { ...outputs.analysis, recommendations: Array.from({ length: 20 }, (_, index) => `${index}${"界".repeat(1900)}`) };
    expect(() => validateRoleOutput(value, facts())).toThrow(/byte limit/);
  });
});
