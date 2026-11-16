import { describe, expect, it } from "vitest";
import type { WorkflowRoleOutput } from "./types";
import { assertPlannerDispositions, assertPlannerRecoveryPlainData, plannerRecoveryFingerprint, plannerRecoveryHash } from "./planner-recovery";

describe("planner-recovery pure safety", () => {
  const output: WorkflowRoleOutput = { schema_version: 1, kind: "plan", status: "needs-review", summary: "Retained proposal", evidence_ids: [],
    unresolved_questions: ["Approve this exact plan?"], risks: ["Verification cost is unmeasured"], recommended_next_action: "Human review", requested_decision: "Approve", plan: ["Keep existing scope"], scope_change_required: false };
  const dispositions = () => ({ questions: [{ index: 0, fingerprint: plannerRecoveryHash(output.unresolved_questions[0]), kind: "plan-approval-gate" as const, answer: "Defer approval to the separate exact-plan gate" }], risks: [{ index: 0, fingerprint: plannerRecoveryHash(output.risks[0]) }] });
  it("requires each exact question and risk without altering the original output", () => {
    const before = JSON.stringify(output); expect(() => assertPlannerDispositions(output, dispositions())).not.toThrow(); expect(JSON.stringify(output)).toBe(before);
  });
  it.each(["question", "risk", "index", "answer", "kind", "duplicate"])("refuses incomplete or substituted %s acknowledgement", (change) => {
    const value = dispositions();
    if (change === "question") value.questions[0]!.fingerprint = "a".repeat(64);
    if (change === "risk") value.risks = [];
    if (change === "index") value.questions[0]!.index = 1;
    if (change === "answer") value.questions[0]!.answer = " ";
    if (change === "kind") Object.assign(value.questions[0]!, { kind: "waive-verification" });
    if (change === "duplicate") value.questions.push(value.questions[0]!);
    expect(() => assertPlannerDispositions(output, value)).toThrow();
  });
  it.each([undefined, () => true, Infinity, new Date(), new Proxy({}, {}), Object.create({ claim: true })])("refuses non-JSON recovery data %#", (value) => {
    expect(() => assertPlannerRecoveryPlainData(value)).toThrow();
  });
  it("rejects accessors without evaluating them and rejects cycles", () => {
    let evaluated = false; const value = Object.defineProperty({}, "approval", { enumerable: true, get() { evaluated = true; return true; } });
    expect(() => assertPlannerRecoveryPlainData(value)).toThrow(); expect(evaluated).toBe(false);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle; expect(() => assertPlannerRecoveryPlainData(cycle)).toThrow();
  });
  it("accepts detached plain JSON and hashes its exact data", () => {
    const value = dispositions(); expect(() => assertPlannerRecoveryPlainData(value)).not.toThrow();
    expect(plannerRecoveryHash(value)).toMatch(/^[a-f0-9]{64}$/); expect(plannerRecoveryHash(value)).not.toBe(plannerRecoveryHash({ ...value, questions: [] }));
    expect(typeof plannerRecoveryFingerprint).toBe("function");
  });
});
