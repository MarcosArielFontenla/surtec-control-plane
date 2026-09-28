import type { EvaluationCheck, EvaluationHardFailure, EvaluationResult } from "./types";
import type { EvaluationCandidate } from "./types";

export const OUTCOME_GOLDEN_SUITE_ID = "surtec-outcome-golden-v2";
export const REQUIRED_OUTCOME_CASE_IDS = [
  "architecture-review",
  "implementation-plan",
  "frontend-change",
  "backend-change",
  "bug-diagnosis",
  "security-review",
  "qa-review",
  "documentation-update",
] as const;

export type OutcomeSection = "summary" | "risks" | "next_steps" | "evidence";

export interface OutcomeGoldenCase {
  schema_version: 2;
  id: string;
  description: string;
  data_classification: "synthetic";
  scenario: string;
  role: string;
  task_type: string;
  candidate: EvaluationCandidate;
  expectations: {
    required_sections: OutcomeSection[];
    evidence_references_minimum: number;
    files_changed_minimum: number;
    files_changed_maximum: number;
    allowed_changed_files: string[];
    require_tests: boolean;
    require_passed_verification: boolean;
    require_risks: boolean;
    minimum_next_steps: number;
    prohibit_side_effects: boolean;
  };
}

export interface OutcomeSuiteManifest {
  schema_version: 2;
  suite_id: string;
  minimum_score: number;
  fixtures: string[];
}

export interface OutcomeCaseEvaluation {
  evaluation: EvaluationResult;
  matched_expectation: boolean;
  expectation_errors: string[];
}

export interface OutcomeSuiteResult {
  suite_id: string;
  schema_version: 2;
  passed: boolean;
  evaluated: number;
  matched: number;
  cases: OutcomeCaseEvaluation[];
  errors: string[];
}

export interface OutcomeEvaluationInput {
  candidate: EvaluationCandidate;
  role: string;
  task_type: string;
  id: string;
  description: string;
  expectations: OutcomeGoldenCase["expectations"];
}

export interface OutcomeEvaluation {
  evaluation: EvaluationResult;
  checks: EvaluationCheck[];
  hard_failures: EvaluationHardFailure[];
}
