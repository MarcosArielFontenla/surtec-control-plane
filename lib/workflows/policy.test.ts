import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceHash, sealTestingEvidence, testingEvidenceStatus, testingRequirement } from "../context/testing-evidence";
import type { ExecutionBudget, TestingPlan } from "../context/types";
import { pathsOutsideScope } from "../../dashboard/src/server/issue-service";
import { resolveWorkflowReviewPolicy } from "./review-policy";
import { CORRECTION_BUDGET_CEILINGS, CORRECTION_PROTECTED_PATTERNS, correctionPathReasons, evaluateCorrectionEligibility, hasConcreteCorrectionFinding, readWorkflowPolicy, remainingWorkflowBudget,
  resolveWorkflowBudget, resolveWorkflowCorrection, resolveWorkflowStageBudget, WORKFLOW_BUDGET_CEILINGS, type CorrectionEligibilityInput } from "./policy";
import type { WorkflowBudget, WorkflowCounters, WorkflowPolicy } from "./types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const rootBudget = (): WorkflowBudget => ({ max_tasks: 7, max_attempts: 10, max_runtime_ms: 900000, max_total_tokens: 100000 });
const counters = (): WorkflowCounters => ({ tasks: 0, attempts: 0, runtime_ms: 0, total_tokens: 0, accounting_complete: true });
const policy = (): WorkflowPolicy => ({ schema_version: 1, default_budget: rootBudget(), correction_budget: { ...CORRECTION_BUDGET_CEILINGS },
  automated_correction_default: false, minimum_review_depth: "focused", qa_on_full: true, protected_path_patterns: [...CORRECTION_PROTECTED_PATTERNS] });
const scope = () => ({ expected_outcome: "Improve synthetic behavior", acceptance_criteria: ["Behavior is verified"], allowed_path_patterns: ["src/**", "test/**"], excluded_path_patterns: ["src/private/**"], allowed_change_categories: ["code"], explicit_exclusions: [] });
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "surtec-workflow-policy-")); roots.push(root); mkdirSync(join(root, "registry"));
  copyFileSync("registry/workflow-policy.yml", join(root, "registry/workflow-policy.yml")); return root;
}
const at = (second: number) => `2026-10-02T12:00:0${second}.000Z`;
function correctionFixture(strict = false): CorrectionEligibilityInput {
  const probe = { sources: [{ path: "test/probe.mjs", sha256: evidenceHash("synthetic trusted probe") }], assertion_ids: ["behavior"] };
  const plan: TestingPlan = strict ? { mode: "strict-tdd", runners: [{ command: "node test/probe.mjs", stage: "red", probe }, { command: "node test/probe.mjs", stage: "green", probe }], noRefactorJustification: "Synthetic bounded change does not require refactor." }
    : { mode: "functional", runners: [{ command: "node test/verify.mjs", stage: "functional" }] };
  const requirements = plan.runners.map(testingRequirement), noRefactor = plan.noRefactorJustification ? evidenceHash(plan.noRefactorJustification) : null;
  const testingPolicy = evidenceHash(JSON.stringify({ mode: plan.mode, requirements, no_refactor_fingerprint: noRefactor }));
  const authorizedScope = scope(), hash = evidenceHash("synthetic context");
  const candidate = { candidate_id: "candidate-1", issue_id: "issue-1", repository_id: "synthetic", task_id: "writer-1", execution_id: "writer-run-1", scope_revision: 1,
    base_revision: "b".repeat(40), candidate_revision: "c".repeat(40), changed_paths: ["src/example.ts"], diff_fingerprint: evidenceHash("diff"), content_fingerprint: evidenceHash("content"), testing_evidence_fingerprint: "" };
  const testing = sealTestingEvidence({ schema_version: 1, task_id: candidate.task_id, execution_id: candidate.execution_id, project_id: "synthetic", issue_id: "issue-1", issue_revision: 3, scope_revision: 1,
    scope_fingerprint: evidenceHash(JSON.stringify(authorizedScope)), context_fingerprint: hash, mode: plan.mode, requirements, no_refactor_fingerprint: noRefactor, policy_fingerprint: testingPolicy,
    implementation: { started_at: at(2), finished_at: at(3), thread_id: "writer-thread", turn_id: "writer-turn" },
    candidate: { id: candidate.candidate_id, base_revision: candidate.base_revision, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint },
    observations: requirements.map((requirement) => ({ stage: requirement.stage, command_fingerprint: requirement.command_fingerprint, probe_fingerprint: requirement.probe_fingerprint,
      assertions: requirement.assertion_ids.map((id) => ({ id, status: requirement.stage === "red" ? "assertion-failed" as const : "passed" as const })),
      outcome: requirement.stage === "red" ? "assertion-failed" : "passed", exit_code: requirement.stage === "red" ? 1 : 0, started_at: at(requirement.stage === "red" ? 0 : 4), finished_at: at(requirement.stage === "red" ? 1 : 5),
      revision: requirement.stage === "red" ? candidate.base_revision : candidate.candidate_revision, before_fingerprint: evidenceHash("clean"), after_fingerprint: evidenceHash("clean") })) });
  candidate.testing_evidence_fingerprint = testing.fingerprint;
  const reviewPolicy = resolveWorkflowReviewPolicy({ template_id: "implementation", work_scale: "bounded", criticality: "low", classification: { affected_domains: ["backend"], requires_migration: false, security_impact: false },
    change_categories: ["code"], behavior_change: true, critical_client_operations: false, trusted_qa_required: true, floors: { roles: [{ role_id: "reviewer", depth: "focused" }], testing: "focused", routing: "focused", project: null, harness: null, workflow: "focused" } });
  const output = { schema_version: 1 as const, status: "completed" as const, kind: "review" as const, summary: "Synthetic bounded behavior differs", evidence_ids: ["evidence-1"], unresolved_questions: [], risks: [],
    recommended_next_action: "Apply the bounded correction", requested_decision: null, verdict: "correction-required" as const,
    findings: [{ id: "finding-1", severity: "blocking" as const, summary: "Correct the existing behavior", path: "src/example.ts", evidence_ids: ["evidence-1"], scope_change_required: false }] };
  return { policy: policy(), workflow: { schema_version: 1, id: "workflow-1", revision: 1, project_id: "synthetic", issue_id: "issue-1", scope_revision: 1, template_id: "implementation", template_version: 1, status: "running", work_scale: "bounded",
    current_grant_id: "grant-1", authority_revision: 1, stage_ids: ["writer-stage", "review-stage"], current_stage_id: "review-stage", pending_decision_id: null, lineage_id: "lineage-1", candidate, approved_plan: null,
    review_policy: reviewPolicy, budget: rootBudget(), counters: { tasks: 4, attempts: 4, runtime_ms: 2000, total_tokens: 1000, accounting_complete: true }, blocked_reason: null, recovery_state: "none", next_action: "Evaluate bounded correction", stop_requested_at: null, created_at: at(0), updated_at: at(6), completed_at: null },
    grant: { schema_version: 1, id: "grant-1", workflow_id: "workflow-1", project_id: "synthetic", issue_id: "issue-1", issue_revision: 1, scope_revision: 1, authority_revision: 1, template_id: "implementation", template_version: 1, authorized_scope: authorizedScope,
      role_assignments: [{ role_id: "planner", agent_id: "tech-lead", sandbox: "read-only", client_context_categories: [] }, { role_id: "software-engineer", agent_id: "backend-engineer", sandbox: "workspace-write", client_context_categories: [] },
        { role_id: "reviewer", agent_id: "reality-checker", sandbox: "read-only", client_context_categories: [] }, { role_id: "qa-evaluator", agent_id: "qa-reviewer", sandbox: "read-only", client_context_categories: [] }],
      permitted_stage_kinds: ["planning", "implementation", "review", "qa", "correction"], source_fingerprints: [{ id: "runtime/safety", fingerprint: hash }], policy_fingerprint: hash, preview_fingerprint: hash,
      testing_policy_fingerprint: testingPolicy, minimum_review_depth: "focused", testing_mode: plan.mode, budget: rootBudget(), correction: resolveWorkflowCorrection(policy(), rootBudget(), true), approved_by: "human", approval_id: "synthetic-approval", approved_at: at(0) },
    lineage: { schema_version: 1, id: "lineage-1", project_id: "synthetic", issue_id: "issue-1", scope_revision: 1, origin_task_id: "writer-1", workflow_ids: ["workflow-1"], candidate_ids: ["candidate-1"], correction_limit: 1, corrections_consumed: 0, consumed_stage_id: null, consumed_at: null },
    issue: { id: "issue-1", project_id: "synthetic", status: "checking", scope_revision: 1, authorized_scope: authorizedScope, assigned_role_id: "backend-engineer" }, candidate, testing_evidence: testing, current_testing_policy_fingerprint: testingPolicy, review_output: output,
    review_receipt: { schema_version: 1, id: "review-receipt", workflow_id: "workflow-1", stage_id: "review-stage", task_id: "review-task", execution_id: "review-run", role_id: "reviewer", agent_id: "reality-checker", issue_id: "issue-1", scope_revision: 1,
      candidate, grant_id: "grant-1", authority_revision: 1, context_fingerprint: hash, review_policy_fingerprint: reviewPolicy.fingerprint, output_fingerprint: evidenceHash(JSON.stringify(output)), verdict: "correction-required", findings: output.findings, created_at: at(6), fingerprint: hash },
    correction_counters: counters(), original_engineer_id: "backend-engineer", selected_engineer_id: "backend-engineer", grant_current: true, candidate_current: true, review_current: true, implementation_lease_active: false,
    trusted_source_paths: ["src/authority.ts"], verification_probe_paths: ["test/probe.mjs", "test/verify.mjs"], proposed_paths: ["src/example.ts"] };
}
function reseal(input: CorrectionEligibilityInput) {
  const { fingerprint: _fingerprint, ...unsigned } = input.testing_evidence!;
  input.testing_evidence = sealTestingEvidence(unsigned);
  input.candidate!.testing_evidence_fingerprint = input.testing_evidence.fingerprint;
}
function resyncReview(input: CorrectionEligibilityInput) {
  input.review_receipt.output_fingerprint = evidenceHash(JSON.stringify(input.review_output));
  if (input.review_output.kind === "review" || input.review_output.kind === "qa") { input.review_receipt.verdict = input.review_output.verdict; input.review_receipt.findings = input.review_output.findings; }
}

describe("reviewed workflow configuration and finite budgets", () => {
  it("reads only the reviewed defaults without granting correction or modifying bytes", () => {
    const root = fixtureRoot(), path = join(root, "registry/workflow-policy.yml"), before = readFileSync(path);
    expect(readWorkflowPolicy(root)).toEqual(policy()); expect(readFileSync(path)).toEqual(before);
    expect(resolveWorkflowBudget(policy())).toEqual(rootBudget()); expect(resolveWorkflowCorrection(policy(), rootBudget())).toEqual({ enabled: false, max_corrections: 0, budget: null });
  });
  it.each(["malformed", "future", "unknown-field", "graph", "correction-default", "qa-waiver", "passive", "missing-protection", "oversize"])("rejects invalid configuration %s and preserves source bytes", (failure) => {
    const root = fixtureRoot(), path = join(root, "registry/workflow-policy.yml"), value = policy();
    if (failure === "future") value.schema_version = 2 as never;
    if (failure === "unknown-field") Object.assign(value, { token: "synthetic private body" });
    if (failure === "graph") Object.assign(value, { roles: ["publisher"] });
    if (failure === "correction-default") value.automated_correction_default = true as never;
    if (failure === "qa-waiver") value.qa_on_full = false as never;
    if (failure === "passive") value.minimum_review_depth = "passive" as never;
    if (failure === "missing-protection") value.protected_path_patterns = ["test/probes/**"];
    const bytes = failure === "malformed" ? "policy: [broken" : failure === "oversize" ? "x".repeat(256 * 1024 + 1) : JSON.stringify(value);
    writeFileSync(path, bytes); expect(() => readWorkflowPolicy(root)).toThrow(); expect(readFileSync(path, "utf8")).toBe(bytes);
  });
  it("fails closed on absent, non-file and linked registry configuration without creating state", () => {
    const root = mkdtempSync(join(tmpdir(), "surtec-workflow-missing-")); roots.push(root);
    expect(() => readWorkflowPolicy(root)).toThrow(/missing/);
    mkdirSync(join(root, "registry/workflow-policy.yml"), { recursive: true }); expect(() => readWorkflowPolicy(root)).toThrow(/unsafe/);
    const linked = mkdtempSync(join(tmpdir(), "surtec-workflow-linked-")); roots.push(linked);
    symlinkSync(join(fixtureRoot(), "registry"), join(linked, "registry"), process.platform === "win32" ? "junction" : "dir");
    expect(() => readWorkflowPolicy(linked)).toThrow(/unsafe/);
  });
  it.each(Object.keys(WORKFLOW_BUDGET_CEILINGS) as (keyof WorkflowBudget)[])("enforces exact hard/default root and correction ceilings for %s", (key) => {
    const value = policy(); value.default_budget = { ...WORKFLOW_BUDGET_CEILINGS };
    expect(resolveWorkflowBudget(value)[key]).toBe(WORKFLOW_BUDGET_CEILINGS[key]);
    value.default_budget[key]++; expect(() => resolveWorkflowBudget(value)).toThrow();
    const correction = policy(); correction.correction_budget[key] = CORRECTION_BUDGET_CEILINGS[key] + 1;
    expect(() => resolveWorkflowCorrection(correction, rootBudget(), true)).toThrow();
    const requested = rootBudget(); requested[key]++;
    expect(() => resolveWorkflowBudget(policy(), requested)).toThrow(key === "max_tasks" ? /Invalid or excessive/ : /exceeds/);
  });
  it("allows only smaller explicit budgets and draws correction authority from the same root", () => {
    const small = { max_tasks: 2, max_attempts: 3, max_runtime_ms: 5000, max_total_tokens: 1000 };
    expect(resolveWorkflowBudget(policy(), small)).toEqual(small); expect(resolveWorkflowCorrection(policy(), small, true)).toEqual({ enabled: true, max_corrections: 1, budget: small });
    expect(() => resolveWorkflowCorrection(policy(), { ...rootBudget(), max_attempts: 11 }, true)).toThrow();
    const first = resolveWorkflowBudget(policy()); first.max_tasks = 1; expect(resolveWorkflowBudget(policy()).max_tasks).toBe(7);
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, "7"])("rejects malformed budget value %s", (value) => {
    expect(() => resolveWorkflowBudget(policy(), { ...rootBudget(), max_tasks: value as number })).toThrow();
  });
  it("never interprets missing/inherited accounting or authority fields as zero/default", () => {
    expect(() => resolveWorkflowBudget(policy(), Object.create(rootBudget()))).toThrow();
    expect(() => resolveWorkflowBudget(policy(), { ...rootBudget(), ignored: 0 } as WorkflowBudget)).toThrow();
    expect(() => remainingWorkflowBudget(rootBudget(), Object.create(counters()))).toThrow();
    expect(() => resolveWorkflowCorrection(policy(), rootBudget(), "false" as never)).toThrow();
    expect(remainingWorkflowBudget(rootBudget(), { ...counters(), accounting_complete: false })).toEqual({ can_admit: false, remaining: null, reasons: ["Interrupted or incomplete usage requires a human accounting decision"] });
  });
  it.each(["tasks", "attempts", "runtime_ms", "total_tokens"] as const)("stops successor admission at or beyond %s exhaustion", (key) => {
    const count = counters(), cap = { tasks: 7, attempts: 10, runtime_ms: 900000, total_tokens: 100000 };
    count[key] = cap[key]; expect(remainingWorkflowBudget(rootBudget(), count).can_admit).toBe(false);
    count[key]++; expect(remainingWorkflowBudget(rootBudget(), count).remaining).toMatchObject({ [`max_${key === "runtime_ms" ? "runtime_ms" : key === "total_tokens" ? "total_tokens" : key}`]: 0 });
  });
  it("intersects every role/project/worker/root/correction remainder without adding or multiplying capacity", () => {
    const constraint: ExecutionBudget = { max_attempts: 3, max_runtime_ms: 300000, max_total_tokens: 100000 };
    const input = { root: rootBudget(), counters: { ...counters(), attempts: 9, runtime_ms: 899000, total_tokens: 99900 }, role: constraint,
      project: { ...constraint, max_total_tokens: 80 }, worker: { ...constraint, max_runtime_ms: 500 }, correction: { budget: { ...CORRECTION_BUDGET_CEILINGS }, counters: { ...counters(), total_tokens: 39950 } } };
    expect(resolveWorkflowStageBudget(input)).toEqual({ budget: { max_attempts: 1, max_runtime_ms: 500, max_total_tokens: 50 }, reasons: [] });
    input.correction.counters.accounting_complete = false; expect(resolveWorkflowStageBudget(input).budget).toBeNull();
    input.correction.counters.accounting_complete = true; input.counters.tasks = 7; expect(resolveWorkflowStageBudget(input).budget).toBeNull();
    input.counters.tasks = 0; input.role.max_attempts = NaN; expect(() => resolveWorkflowStageBudget(input)).toThrow();
    expect(() => resolveWorkflowStageBudget({ ...input, role: constraint, project: undefined as never })).toThrow();
  });
});

describe("protected correction paths", () => {
  it.each(CORRECTION_PROTECTED_PATTERNS)("protects code-owned authority path %s even under broad human scope", (pattern) => {
    const path = pattern.replace("**", "trusted/file.ts").replace("*", "-service");
    expect(correctionPathReasons({ paths: [path], scope: { ...scope(), allowed_path_patterns: ["**"] }, policy: policy(), trusted_source_paths: [], verification_probe_paths: [] })).toContain("Correction would change protected policy, Harness or approval sources");
  });
  it("honors exclusions, complete-glob semantics and canonical scope casing without broadening authority", () => {
    const input = { paths: ["src/example.ts", "src/nested/example.ts", "src/private/no.ts", "outside/no.ts", "SRC/example.ts"], scope: scope(), policy: policy(), trusted_source_paths: [], verification_probe_paths: [] };
    expect(pathsOutsideScope(input.paths, input.scope)).toEqual(["src/private/no.ts", "outside/no.ts", "SRC/example.ts"]);
    for (const path of input.paths) expect(correctionPathReasons({ ...input, paths: [path] }).some((reason) => reason.includes("scope"))).toBe(pathsOutsideScope([path], input.scope).length > 0);
    input.scope.allowed_path_patterns = ["src/**/file?.ts"];
    for (const path of ["src/file1.ts", "src/nested/file2.ts", "src/nested/file22.ts", "src/no.ts"]) expect(correctionPathReasons({ ...input, paths: [path] }).some((reason) => reason.includes("scope"))).toBe(pathsOutsideScope([path], input.scope).length > 0);
  });
  it("adds trusted source/probe protections and prevents case-variant bypass on Windows", () => {
    const input = { paths: ["src/authority.ts", "test/probe.mjs"], scope: scope(), policy: policy(), trusted_source_paths: ["src/authority.ts"], verification_probe_paths: ["test/probe.mjs"] };
    expect(correctionPathReasons(input)).toEqual(["Correction would change protected policy, Harness or approval sources", "Correction would change trusted verification probes"]);
    expect(correctionPathReasons({ ...input, paths: ["REGISTRY/AGENTS.YML"], scope: { ...scope(), allowed_path_patterns: ["**"] } })).toContain("Correction would change protected policy, Harness or approval sources");
  });
  it.each(["../outside.ts", "/absolute.ts", "D:/outside.ts", "src\\example.ts", "src//example.ts", "src/./example.ts", "src/a\u0000.ts"])("fails safely on unsafe proposed path %s", (path) => {
    expect(() => correctionPathReasons({ paths: [path], scope: scope(), policy: policy(), trusted_source_paths: [], verification_probe_paths: [] })).toThrow(/Invalid/);
  });
});

describe("pure one-correction eligibility, not admission authority", () => {
  it("compares the current aggregate testing grant without confusing it with the per-writer receipt", () => {
    const input = correctionFixture(); input.grant.testing_policy_fingerprint = evidenceHash("current aggregate role testing");
    input.current_testing_policy_fingerprint = input.grant.testing_policy_fingerprint;
    expect(input.testing_evidence!.policy_fingerprint).not.toBe(input.grant.testing_policy_fingerprint);
    expect(evaluateCorrectionEligibility(input).eligible).toBe(true);
    input.current_testing_policy_fingerprint = evidenceHash("changed current testing");
    expect(evaluateCorrectionEligibility(input).eligible).toBe(false);
  });
  it("continues required review collection only for concrete correction findings without a human request", () => {
    const output = correctionFixture().review_output;
    if (output.kind !== "review") throw new Error("fixture differs");
    expect(hasConcreteCorrectionFinding(output)).toBe(true);
    expect(hasConcreteCorrectionFinding(null)).toBe(false);
    expect(hasConcreteCorrectionFinding({ ...output, requested_decision: "Human direction" })).toBe(false);
    expect(hasConcreteCorrectionFinding({ ...output, unresolved_questions: ["Ambiguous change"] })).toBe(false);
    for (const change of [{ path: null }, { evidence_ids: [] }, { scope_change_required: true }]) {
      expect(hasConcreteCorrectionFinding({ ...output, findings: [{ ...output.findings[0]!, ...change }] })).toBe(false);
    }
  });
  it("accepts current QA findings as evidence without granting QA verification or write capabilities", () => {
    const input = correctionFixture();
    if (input.review_output.kind !== "review") throw new Error("fixture role differs");
    input.review_output = { ...input.review_output, kind: "qa", criteria: [{ criterion: "Synthetic behavior", status: "contradictory", evidence_ids: ["evidence-1"] }] };
    input.review_receipt.role_id = "qa-evaluator"; input.review_receipt.agent_id = "qa-reviewer";
    resyncReview(input); expect(evaluateCorrectionEligibility(input).eligible).toBe(true);
  });
  it.each(["grant-floor", "policy-floor", "missing-role", "missing-stage"])("cannot admit a correction with downgraded or unavailable fresh review: %s", (failure) => {
    const input = correctionFixture();
    if (failure === "grant-floor") input.grant.minimum_review_depth = "full";
    if (failure === "policy-floor") input.policy.minimum_review_depth = "full";
    if (failure === "missing-role") input.grant.role_assignments = input.grant.role_assignments.filter((role) => role.role_id !== "qa-evaluator");
    if (failure === "missing-stage") input.grant.permitted_stage_kinds = input.grant.permitted_stage_kinds.filter((kind) => kind !== "qa");
    expect(evaluateCorrectionEligibility(input).eligible).toBe(false);
  });
  it.each([false, true])("accepts only a currently bound passed-verification checking candidate strict=%s without consuming/mutating anything", (strict) => {
    const input = correctionFixture(strict), before = structuredClone(input);
    expect(testingEvidenceStatus(input.testing_evidence!)).toBe("passed");
    expect(evaluateCorrectionEligibility(input)).toEqual({ eligible: true, reasons: [], remaining_budget: { ...CORRECTION_BUDGET_CEILINGS } }); expect(input).toEqual(before);
  });
  it.each(["ready-for-review", "working", "needs-decision", "done", "cancelled"] as const)("requires a human decision rather than automatic correction in issue %s", (status) => {
    const input = correctionFixture(); input.issue.status = status;
    expect(evaluateCorrectionEligibility(input)).toMatchObject({ eligible: false });
  });
  it.each(["opt-out", "consumed", "replacement", "lineage", "scope", "grant", "authority", "stop", "engineer", "assignment", "candidate", "tree", "lease", "review-current", "review-binding", "review-role", "policy"])("denies unsafe/stale correction %s", (failure) => {
    const input = correctionFixture();
    if (failure === "opt-out") { input.grant.correction = resolveWorkflowCorrection(policy(), rootBudget()); input.grant.permitted_stage_kinds = input.grant.permitted_stage_kinds.filter((kind) => kind !== "correction"); }
    if (failure === "consumed" || failure === "replacement") { input.lineage.corrections_consumed = 1; input.lineage.consumed_at = at(5); input.lineage.consumed_stage_id = "prior-correction"; }
    if (failure === "replacement") { input.workflow.id = "replacement"; input.grant.workflow_id = "replacement"; input.lineage.workflow_ids.push("replacement"); }
    if (failure === "lineage") input.lineage.origin_task_id = "other-writer";
    if (failure === "scope") input.issue.scope_revision = 2;
    if (failure === "grant") input.grant_current = false;
    if (failure === "authority") input.workflow.authority_revision = 2;
    if (failure === "stop") input.workflow.stop_requested_at = at(6);
    if (failure === "engineer") input.selected_engineer_id = "tech-lead";
    if (failure === "assignment") input.issue.assigned_role_id = "tech-lead";
    if (failure === "candidate") input.candidate = null;
    if (failure === "tree") input.candidate_current = false;
    if (failure === "lease") input.implementation_lease_active = true;
    if (failure === "review-current") input.review_current = false;
    if (failure === "review-binding") input.review_receipt.authority_revision = 2;
    if (failure === "review-role") input.review_receipt.role_id = "qa-evaluator";
    if (failure === "policy") input.review_receipt.review_policy_fingerprint = evidenceHash("changed policy");
    expect(evaluateCorrectionEligibility(input).eligible).toBe(false);
  });
  it.each(["missing", "failed", "incomplete", "tampered", "mode", "policy", "candidate", "scope", "red", "probe"])("never waives infrastructure verification: %s", (failure) => {
    const input = correctionFixture(failure === "red" || failure === "probe");
    if (failure === "missing") input.testing_evidence = null;
    if (failure === "failed") { input.testing_evidence!.observations[0]!.outcome = "process-error"; reseal(input); }
    if (failure === "incomplete") { input.testing_evidence!.observations = []; reseal(input); }
    if (failure === "tampered") input.testing_evidence!.execution_id = "wrong-run";
    if (failure === "mode") input.grant.testing_mode = "strict-tdd";
    if (failure === "policy") input.grant.testing_policy_fingerprint = evidenceHash("changed policy");
    if (failure === "candidate") { input.testing_evidence!.candidate!.candidate_revision = "d".repeat(40); reseal(input); }
    if (failure === "scope") { input.testing_evidence!.scope_fingerprint = evidenceHash("changed scope"); reseal(input); }
    if (failure === "red") { input.testing_evidence!.observations[0]!.exit_code = 2; reseal(input); }
    if (failure === "probe") { input.testing_evidence!.observations[1]!.probe_fingerprint = evidenceHash("changed probe"); reseal(input); }
    const result = evaluateCorrectionEligibility(input);
    expect(result.eligible).toBe(false); expect(result.reasons).toContain("Correction requires current passed infrastructure verification, never model claims");
  });
  it.each(["question", "decision", "scope-change", "pathless", "protected", "probe", "out-of-scope", "inconclusive", "failed-output"])("requires concrete bounded unambiguous findings, not %s", (failure) => {
    const input = correctionFixture();
    if (input.review_output.kind !== "review") throw new Error("fixture role differs");
    if (failure === "question") input.review_output.unresolved_questions = ["Choose a new scope"];
    if (failure === "decision") input.review_output.requested_decision = "Authorize another change";
    if (failure === "scope-change") input.review_output.findings[0]!.scope_change_required = true;
    if (failure === "pathless") input.review_output.findings[0]!.path = null;
    if (failure === "protected") { input.trusted_source_paths.push("src/example.ts"); }
    if (failure === "probe") input.proposed_paths.push("test/probe.mjs");
    if (failure === "out-of-scope") input.proposed_paths.push("src/private/secret.ts");
    if (failure === "inconclusive") input.review_output.verdict = "inconclusive";
    if (failure === "failed-output") input.review_output.status = "failed";
    resyncReview(input); expect(evaluateCorrectionEligibility(input).eligible).toBe(false);
  });
  it.each(["tasks", "attempts", "runtime_ms", "total_tokens", "accounting_complete"] as const)("blocks correction when aggregate %s cannot prove sufficient remaining authority", (key) => {
    const input = correctionFixture();
    if (key === "accounting_complete") { input.workflow.counters.accounting_complete = false; input.workflow.status = "needs-decision"; input.workflow.blocked_reason = "Unknown interrupted usage"; }
    else input.workflow.counters[key] = ({ tasks: 5, attempts: 8, runtime_ms: 900000, total_tokens: 100000 })[key];
    expect(evaluateCorrectionEligibility(input).eligible).toBe(false);
  });
  it("retains unknown correction accounting and never resets the allowance or adds sub-budget to root capacity", () => {
    const input = correctionFixture(); input.correction_counters.accounting_complete = false;
    expect(evaluateCorrectionEligibility(input)).toMatchObject({ eligible: false, remaining_budget: null });
    input.correction_counters = { ...counters(), total_tokens: 39999 }; input.workflow.counters.total_tokens = 99999;
    expect(evaluateCorrectionEligibility(input).remaining_budget?.max_total_tokens).toBe(1);
    input.correction_counters.tasks = 1; expect(evaluateCorrectionEligibility(input).eligible).toBe(false);
  });
});
