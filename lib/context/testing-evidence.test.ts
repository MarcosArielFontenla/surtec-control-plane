import { describe, expect, it } from "vitest";
import type { TaskRecord } from "../state/types";
import type { ReviewCandidate } from "../issues/types";
import type { ContextAdmissionV2, TestingPlan } from "./types";
import { assertTestingEvidence, assertTestingEvidenceBinding, createTestingEvidence, evidenceHash, sealTestingEvidence, testingEvidenceStatus, type TestingEvidence, type TestingObservation } from "./testing-evidence";

const at = (second: number) => `2026-09-30T10:00:0${second}.000Z`;
function fixture(strict = false) {
  const probe = { sources: [{ path: "test/probe.mjs", sha256: evidenceHash("trusted") }], assertion_ids: ["behavior"] };
  const plan: TestingPlan = strict ? { mode: "strict-tdd", runners: [{ command: "node probe.mjs", stage: "red", probe }, { command: "node probe.mjs", stage: "green", probe }], noRefactorJustification: "No structural change in this bounded fixture." }
    : { mode: "functional", runners: [{ command: "node check.mjs", stage: "functional" }] };
  const task = { envelope: { id: "T-fixture", project: "alpha", metadata: { issue_id: "I-fixture", issue_scope_revision: 1, issue_authorized_scope: { allowed_path_patterns: ["src/**"] } },
    context_admission: { issue_id: "I-fixture", issue_revision: 2 }, context_manifest: { fingerprint: evidenceHash("context"), testing: { mode: plan.mode, commands: [...new Set(plan.runners.map((entry) => entry.command))] } } } } as unknown as TaskRecord;
  let receipt = createTestingEvidence(task, "run-fixture", plan);
  receipt.implementation = { started_at: at(2), finished_at: at(3), thread_id: "thread-fixture", turn_id: "turn-fixture" };
  receipt.candidate = { id: "C-fixture", base_revision: "a".repeat(40), candidate_revision: "b".repeat(40), diff_fingerprint: evidenceHash("diff") };
  receipt.observations = receipt.requirements.map((entry): TestingObservation => ({ stage: entry.stage, command_fingerprint: entry.command_fingerprint, probe_fingerprint: entry.probe_fingerprint,
    assertions: entry.assertion_ids.map((id) => ({ id, status: entry.stage === "red" ? "assertion-failed" : "passed" })), outcome: entry.stage === "red" ? "assertion-failed" : "passed", exit_code: entry.stage === "red" ? 1 : 0,
    started_at: at(entry.stage === "red" ? 0 : 4), finished_at: at(entry.stage === "red" ? 1 : 5), revision: (entry.stage === "red" ? "a" : "b").repeat(40), before_fingerprint: evidenceHash("clean"), after_fingerprint: evidenceHash("clean") }));
  receipt = reseal(receipt);
  const candidate = { id: "C-fixture", task_id: task.envelope.id, issue_id: "I-fixture", repository_id: "alpha", execution_id: "run-fixture", scope_revision: 1, base_revision: receipt.candidate!.base_revision, candidate_revision: receipt.candidate!.candidate_revision, diff_fingerprint: receipt.candidate!.diff_fingerprint } as ReviewCandidate;
  return { task, receipt, candidate, plan };
}
function reseal(value: TestingEvidence) { const { fingerprint: _fingerprint, ...unsigned } = value; return sealTestingEvidence(unsigned); }
describe("trusted captured testing evidence", () => {
  it.each([false, true])("binds v2 writer receipts to admitted scope without legacy metadata strict=%s", (strict) => {
    const { task, receipt, candidate, plan } = fixture(strict);
    const scope = { scope_revision: receipt.scope_revision!, scope_fingerprint: receipt.scope_fingerprint! };
    task.envelope.metadata = {}; task.envelope.task_type = "implementation"; task.envelope.sandbox = "workspace-write"; task.envelope.self_verify = true;
    task.envelope.context_manifest!.tools = ["inspect", "edit-authorized-scope", "verify-configured"];
    Object.assign(task.envelope.context_admission!, { schema_version: 2, stage_kind: "implementation", role_id: "software-engineer", ...scope });
    const captured = createTestingEvidence(task, receipt.execution_id, plan);
    const finished = reseal({ ...captured, implementation: receipt.implementation, candidate: receipt.candidate, observations: receipt.observations });
    expect(finished.schema_version).toBe(1); expect(testingEvidenceStatus(finished)).toBe("passed");
    expect(() => assertTestingEvidenceBinding(finished, task, candidate)).not.toThrow();
    for (const key of ["scope_revision", "scope_fingerprint", "issue_revision", "issue_id"] as const) {
      const changed = structuredClone(task);
      Object.assign(changed.envelope.context_admission!, { [key]: typeof (changed.envelope.context_admission as ContextAdmissionV2)[key] === "number" ? 99 : "other" });
      expect(() => assertTestingEvidenceBinding(finished, changed, candidate)).toThrow(/binding/);
    }
    task.envelope.metadata.issue_scope_revision = scope.scope_revision;
    expect(() => assertTestingEvidenceBinding(finished, task, candidate)).toThrow(/writers/);
  });
  it.each(["analysis", "planning", "review", "qa", "operations"])("cannot capture trusted testing through read-only workflow %s", (kind) => {
    const { task, plan } = fixture(); task.envelope.metadata = {};
    Object.assign(task.envelope.context_admission!, { schema_version: 2, stage_kind: kind, role_id: "reviewer" });
    expect(() => createTestingEvidence(task, "unowned-run", plan)).toThrow(/writers/);
  });
  it.each([false, true])("validates complete ordered infrastructure observations strict=%s", (strict) => {
    const { task, receipt, candidate } = fixture(strict);
    expect(testingEvidenceStatus(receipt)).toBe("passed"); expect(() => assertTestingEvidenceBinding(receipt, task, candidate)).not.toThrow();
    expect(JSON.stringify(receipt)).not.toContain("No structural change"); expect(JSON.stringify(receipt)).not.toContain("test/probe.mjs");
  });
  it("never promotes missing commands, candidates, implementation or observations", () => {
    for (const mutate of [(value: TestingEvidence) => { value.candidate = null; }, (value: TestingEvidence) => { value.implementation = null; }, (value: TestingEvidence) => { value.observations = []; }]) {
      const { receipt } = fixture(); mutate(receipt); expect(testingEvidenceStatus(reseal(receipt))).toBe("incomplete");
    }
  });
  it.each(["exit", "error", "timeout", "drift", "green-before-turn", "wrong-assertion", "changed-probe", "missing-refactor", "base"])("rejects invalid strict evidence %s", (failure) => {
    const { receipt } = fixture(true); const red = receipt.observations[0]!, green = receipt.observations[1]!;
    if (failure === "exit") red.exit_code = 2;
    if (failure === "error") red.outcome = "process-error";
    if (failure === "timeout") red.outcome = "timed-out";
    if (failure === "drift") green.after_fingerprint = evidenceHash("changed");
    if (failure === "green-before-turn") receipt.implementation!.finished_at = at(5);
    if (failure === "wrong-assertion") green.assertions[0]!.id = "wrong";
    if (failure === "changed-probe") green.probe_fingerprint = evidenceHash("changed");
    if (failure === "base") red.revision = "c".repeat(40);
    if (failure === "missing-refactor") { receipt.no_refactor_fingerprint = null; receipt.policy_fingerprint = evidenceHash(JSON.stringify({ mode: receipt.mode, requirements: receipt.requirements, no_refactor_fingerprint: null })); }
    expect(testingEvidenceStatus(reseal(receipt))).toBe("failed");
  });
  it.each(["task", "run", "scope", "candidate", "diff", "context", "commands"])("rejects cross-record binding changes %s", (failure) => {
    const { receipt, task, candidate } = fixture();
    if (failure === "task") candidate.task_id = "T-other";
    if (failure === "run") candidate.execution_id = "run-other";
    if (failure === "scope") candidate.scope_revision = 2;
    if (failure === "candidate") candidate.candidate_revision = "c".repeat(40);
    if (failure === "diff") candidate.diff_fingerprint = evidenceHash("different");
    if (failure === "context") task.envelope.context_manifest!.fingerprint = evidenceHash("other context");
    if (failure === "commands") task.envelope.context_manifest!.testing.commands = ["node other.mjs"];
    expect(() => assertTestingEvidenceBinding(receipt, task, candidate)).toThrow(/binding|commands/);
  });
  it("rejects malformed, future, tampered, duplicate and unordered receipts", () => {
    const { receipt } = fixture(true);
    expect(() => assertTestingEvidence({ ...receipt, schema_version: 2 })).toThrow(/unsupported/);
    expect(() => assertTestingEvidence({ ...receipt, output: "private" })).toThrow(/unsupported/);
    expect(() => assertTestingEvidence({ ...receipt, execution_id: "tampered" })).toThrow(/fingerprint/);
    receipt.observations.reverse(); expect(() => assertTestingEvidence(reseal(receipt))).toThrow(/order/);
  });
});
