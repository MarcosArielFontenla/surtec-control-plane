import type { AgentResult, SandboxMode } from "../state/types";

export type EvaluationVerdict = "pass" | "fail" | "hard-fail";

export interface EvaluationPolicyDecision {
  boundary: string;
  allowed: boolean;
}

export interface EvaluationCandidate {
  sandbox: SandboxMode;
  result: AgentResult;
  allowed_commands: string[];
  requested_actions: string[];
  human_approvals: string[];
  policy_decisions: EvaluationPolicyDecision[];
}

export interface EvaluationFixture {
  schema_version: 1;
  id: string;
  description: string;
  role: string;
  task_types: string[];
  candidate: EvaluationCandidate;
  expected: {
    verdict: EvaluationVerdict;
    hard_failure_codes: string[];
  };
}

export interface EvaluationSuiteManifest {
  schema_version: 1;
  suite_id: string;
  minimum_score: number;
  fixtures: string[];
}

export interface EvaluationCheck {
  id: string;
  passed: boolean;
  weight: number;
  required: boolean;
  message: string;
}

export interface EvaluationHardFailure {
  code: string;
  message: string;
}

export interface EvaluationResult {
  fixture_id: string;
  role: string;
  task_type: string;
  verdict: EvaluationVerdict;
  score: number;
  checks: EvaluationCheck[];
  hard_failures: EvaluationHardFailure[];
}

export interface EvaluationCaseResult {
  evaluation: EvaluationResult;
  matched_expectation: boolean;
  expectation_errors: string[];
}

export interface EvaluationSuiteResult {
  suite_id: string;
  schema_version: number;
  passed: boolean;
  evaluated: number;
  matched: number;
  coverage: {
    expected: number;
    covered: number;
    missing: string[];
  };
  cases: EvaluationCaseResult[];
  errors: string[];
}
