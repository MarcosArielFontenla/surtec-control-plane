import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import outcomeCaseSchema from "../../schemas/outcome-golden-case.schema.json";
import outcomeSuiteSchema from "../../schemas/outcome-evaluation-suite.schema.json";
import agentResultSchema from "../../schemas/agent-result.schema.json";
import { PolicyService } from "../policy/service";
import { assertPathWithin } from "../security/paths";
import { evaluateOutcomeCase } from "./outcome-evaluator";
import {
  OUTCOME_GOLDEN_SUITE_ID,
  REQUIRED_OUTCOME_CASE_IDS,
  type OutcomeGoldenCase,
  type OutcomeSuiteManifest,
  type OutcomeSuiteResult,
} from "./outcome-types";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(agentResultSchema);
const validateManifest = ajv.compile(outcomeSuiteSchema) as ValidateFunction<OutcomeSuiteManifest>;
const validateCase = ajv.compile(outcomeCaseSchema) as ValidateFunction<OutcomeGoldenCase>;

function validationMessage(label: string, validate: ValidateFunction): string {
  const detail = validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ") ?? "invalid document";
  return `${label} is invalid: ${detail}`;
}

function readJson(path: string, label: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`${label} could not be read: ${(error as Error).message}`); }
}

export function loadOutcomeGoldenSuite(
  repoRoot: string = process.cwd(),
  manifestPath: string = join(repoRoot, "evals", "v2", "suite.json"),
): { manifest: OutcomeSuiteManifest; cases: OutcomeGoldenCase[] } {
  const evalsRoot = join(repoRoot, "evals");
  const safeManifestPath = assertPathWithin(evalsRoot, manifestPath, "outcome evaluation manifest path");
  const suiteRoot = dirname(safeManifestPath);
  const manifestValue = readJson(safeManifestPath, "outcome evaluation manifest");
  if (!validateManifest(manifestValue)) throw new Error(validationMessage("outcome evaluation manifest", validateManifest));
  const manifest = manifestValue;
  if (manifest.schema_version !== 2) throw new Error(`unsupported outcome evaluation schema version: ${manifest.schema_version}`);
  if (manifest.suite_id !== OUTCOME_GOLDEN_SUITE_ID) throw new Error(`outcome evaluation suite must pin ${OUTCOME_GOLDEN_SUITE_ID}`);

  const ids = new Set<string>();
  const cases: OutcomeGoldenCase[] = [];
  for (const relativePath of manifest.fixtures) {
    const fixturePath = assertPathWithin(suiteRoot, join(suiteRoot, relativePath), "outcome evaluation fixture path");
    if (extname(fixturePath).toLowerCase() !== ".json") throw new Error(`outcome fixture must be JSON: ${relativePath}`);
    const fixtureValue = readJson(fixturePath, `outcome fixture '${relativePath}'`);
    if (!validateCase(fixtureValue)) throw new Error(validationMessage(`outcome fixture '${relativePath}'`, validateCase));
    if (ids.has(fixtureValue.id)) throw new Error(`duplicate outcome fixture id: ${fixtureValue.id}`);
    ids.add(fixtureValue.id);
    cases.push(fixtureValue);
  }
  const missing = REQUIRED_OUTCOME_CASE_IDS.filter((id) => !ids.has(id));
  const unexpected = [...ids].filter((id) => !(REQUIRED_OUTCOME_CASE_IDS as readonly string[]).includes(id));
  if (missing.length || unexpected.length || ids.size !== REQUIRED_OUTCOME_CASE_IDS.length) {
    throw new Error(`outcome golden coverage mismatch; missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}]`);
  }
  return { manifest, cases };
}

export function runOutcomeEvaluationSuite(
  repoRoot: string = process.cwd(),
  manifestPath: string = join(repoRoot, "evals", "v2", "suite.json"),
): OutcomeSuiteResult {
  const { manifest, cases: fixtures } = loadOutcomeGoldenSuite(repoRoot, manifestPath);
  const policyAgents = new Map(new PolicyService(repoRoot).listAgents().map((agent) => [agent.id, agent]));
  const cases = fixtures.map((fixture) => {
    const outcome = evaluateOutcomeCase({
      id: fixture.id,
      description: fixture.description,
      role: fixture.role,
      task_type: fixture.task_type,
      candidate: fixture.candidate,
      expectations: fixture.expectations,
    }, policyAgents.get(fixture.role) ?? null, manifest.minimum_score);
    const expectationErrors = outcome.evaluation.verdict === "pass"
      ? []
      : [`expected pass, received ${outcome.evaluation.verdict}`,
        ...outcome.checks.filter((check) => check.required && !check.passed).map((check) => `required check failed: ${check.id}`),
        ...outcome.hard_failures.map((failure) => `hard failure: ${failure.code}`)];
    return {
      evaluation: { ...outcome.evaluation, checks: outcome.checks, hard_failures: outcome.hard_failures },
      matched_expectation: expectationErrors.length === 0,
      expectation_errors: [...new Set(expectationErrors)],
    };
  });
  const errors = cases.flatMap((item) => item.expectation_errors.map((error) => `${item.evaluation.fixture_id}/${item.evaluation.task_type}: ${error}`));
  return {
    suite_id: manifest.suite_id,
    schema_version: manifest.schema_version,
    passed: errors.length === 0,
    evaluated: cases.length,
    matched: cases.filter((item) => item.matched_expectation).length,
    cases,
    errors,
  };
}
