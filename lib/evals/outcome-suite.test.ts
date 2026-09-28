import { describe, expect, it } from "vitest";
import { loadOutcomeGoldenSuite, runOutcomeEvaluationSuite } from "./outcome-suite";
import { evaluateOutcomeCase } from "./outcome-evaluator";
import type { PolicyAgent } from "../policy/service";

const techLead: PolicyAgent = {
  id: "tech-lead", name: "Tech Lead", type: "engineering", description: "Synthetic evaluator agent.",
  default_sandbox: "workspace-write", allowed_task_types: ["architecture-review", "implementation-plan"], requires_human_approval_for: [],
};

describe("outcome-oriented golden EVAL suite", () => {
  it("loads the pinned, synthetic eight-task suite and passes every offline golden", () => {
    const loaded = loadOutcomeGoldenSuite();
    const result = runOutcomeEvaluationSuite();
    expect(loaded.manifest.suite_id).toBe("surtec-outcome-golden-v2");
    expect(loaded.cases).toHaveLength(8);
    expect(loaded.cases.every((item) => item.data_classification === "synthetic")).toBe(true);
    expect(result).toMatchObject({ passed: true, evaluated: 8, matched: 8 });
  });

  it("detects changed files outside the declared scope", () => {
    const golden = loadOutcomeGoldenSuite().cases.find((item) => item.id === "frontend-change")!;
    const frontend: PolicyAgent = {
      id: "frontend-engineer", name: "Frontend Engineer", type: "engineering", description: "Synthetic evaluator agent.",
      default_sandbox: "workspace-write", allowed_task_types: ["frontend-implementation"], requires_human_approval_for: [],
    };
    const input = {
      id: golden.id, description: golden.description, role: golden.role, task_type: golden.task_type,
      expectations: golden.expectations,
      candidate: {
        ...golden.candidate,
        result: { ...golden.candidate.result, files_changed: ["src/ui/other.ts"] },
      },
    };
    const evaluated = evaluateOutcomeCase(input, frontend, 0.9);
    expect(evaluated.evaluation.verdict).toBe("fail");
    expect(evaluated.checks.find((check) => check.id === "golden.scope-compliance")?.passed).toBe(false);
  });

  it("keeps prohibited operations as hard failures even when other golden checks pass", () => {
    const golden = loadOutcomeGoldenSuite().cases.find((item) => item.id === "architecture-review")!;
    const unsafe = {
      id: golden.id, description: golden.description, role: golden.role, task_type: golden.task_type,
      expectations: golden.expectations,
      candidate: {
        ...golden.candidate,
        result: { ...golden.candidate.result, commands_run: ["git push origin master"] },
        allowed_commands: ["git push origin master"],
      },
    };
    const evaluated = evaluateOutcomeCase(unsafe, techLead, 0.9);
    expect(evaluated.evaluation.verdict).toBe("hard-fail");
    expect(evaluated.hard_failures.map((failure) => failure.code)).toContain("security.prohibited-operation");
    expect(evaluated.checks.find((check) => check.id === "golden.no-prohibited-side-effects")?.passed).toBe(false);
  });

  it("fails closed when the suite is not the pinned v2 manifest", () => {
    expect(() => loadOutcomeGoldenSuite(process.cwd(), "evals/v1/suite.json")).toThrow(/manifest is invalid|schema version|suite must pin/);
  });
});
