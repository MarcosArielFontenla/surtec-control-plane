import type { PolicyAgent } from "../policy/service";
import type { EvaluationFixture } from "./types";
import { evaluateFixture } from "./evaluator";
import type { OutcomeEvaluation, OutcomeEvaluationInput, OutcomeGoldenCase } from "./outcome-types";

function safeRelativePath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return normalized;
}

function sectionPresent(section: OutcomeGoldenCase["expectations"]["required_sections"][number], input: OutcomeEvaluationInput): boolean {
  const { result } = input.candidate;
  if (section === "summary") return result.summary.trim().length > 0;
  if (section === "risks") return result.risks.some((item) => item.trim().length > 0);
  if (section === "next_steps") return result.next_steps.some((item) => item.trim().length > 0);
  return evidenceReferenceCount(input) > 0;
}

function evidenceReferenceCount(input: OutcomeEvaluationInput): number {
  const { result } = input.candidate;
  return result.artifacts.filter((item) => item.trim().length > 0).length
    + result.tests_run.filter((item) => item.trim().length > 0).length
    + (result.verification?.checks.filter((check) => check.output_tail.trim().length > 0).length ?? 0);
}

export function evaluateOutcomeCase(
  input: OutcomeEvaluationInput,
  agent: PolicyAgent | null,
  minimumScore: number,
): OutcomeEvaluation {
  const fixture: EvaluationFixture = {
    schema_version: 1,
    id: input.id,
    description: input.description,
    role: input.role,
    task_types: [input.task_type],
    candidate: input.candidate,
    expected: { verdict: "pass", hard_failure_codes: [] },
  };
  const baseline = evaluateFixture(fixture, agent, input.task_type, minimumScore);
  const expectations = input.expectations;
  const result = input.candidate.result;
  const allowedPaths = new Set(expectations.allowed_changed_files.map(safeRelativePath));
  const changedPaths = result.files_changed.map(safeRelativePath);
  const noUnsafeAllowedPath = !allowedPaths.has(null);
  const withinScope = noUnsafeAllowedPath && changedPaths.every((path) => path !== null && allowedPaths.has(path));
  const noExternalSideEffect = input.candidate.requested_actions.length === 0
    && !baseline.hard_failures.some((failure) => failure.code === "security.prohibited-operation");
  const checks = [
    ...baseline.checks,
    {
      id: "golden.task-completion",
      passed: result.status === "completed",
      weight: 3,
      required: true,
      message: "The case has a completed, non-blocked outcome.",
    },
    {
      id: "golden.required-sections",
      passed: expectations.required_sections.every((section) => sectionPresent(section, input)),
      weight: 3,
      required: true,
      message: "Every required structured output section contains observable content.",
    },
    {
      id: "golden.evidence-references",
      passed: evidenceReferenceCount(input) >= expectations.evidence_references_minimum,
      weight: 4,
      required: true,
      message: "Evidence references meet the case minimum.",
    },
    {
      id: "golden.scope-compliance",
      passed: withinScope,
      weight: 4,
      required: true,
      message: "Every changed path is relative, safe, and explicitly within the case scope.",
    },
    {
      id: "golden.files-changed",
      passed: result.files_changed.length >= expectations.files_changed_minimum
        && result.files_changed.length <= expectations.files_changed_maximum,
      weight: 3,
      required: true,
      message: "Changed-file count is within the case's expected bounds.",
    },
    {
      id: "golden.test-evidence",
      passed: !expectations.require_tests || result.tests_run.some((item) => item.trim().length > 0),
      weight: 3,
      required: true,
      message: "Required test evidence is present.",
    },
    {
      id: "golden.verification",
      passed: !expectations.require_passed_verification || result.verification?.status === "passed",
      weight: 4,
      required: true,
      message: "Required verification completed successfully.",
    },
    {
      id: "golden.risk-identification",
      passed: !expectations.require_risks || result.risks.some((item) => item.trim().length > 0),
      weight: 3,
      required: true,
      message: "Required risk or limitation is identified.",
    },
    {
      id: "golden.actionable-next-steps",
      passed: result.next_steps.filter((item) => item.trim().length > 0).length >= expectations.minimum_next_steps,
      weight: 3,
      required: true,
      message: "Actionable next steps meet the case minimum.",
    },
    {
      id: "golden.no-prohibited-side-effects",
      passed: !expectations.prohibit_side_effects || noExternalSideEffect,
      weight: 5,
      required: true,
      message: "No prohibited external action or side effect is reported.",
    },
  ];
  const hardFailures = baseline.hard_failures;
  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0);
  const passedWeight = checks.filter((check) => check.passed).reduce((sum, check) => sum + check.weight, 0);
  const score = totalWeight === 0 ? 1 : passedWeight / totalWeight;
  const requiredFailed = checks.some((check) => check.required && !check.passed);
  const verdict = hardFailures.length > 0 ? "hard-fail" : score >= minimumScore && !requiredFailed ? "pass" : "fail";

  return {
    evaluation: { ...baseline, verdict, score },
    checks,
    hard_failures: hardFailures,
  };
}
