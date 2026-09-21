import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import fixtureSchema from "../../schemas/evaluation-fixture.schema.json";
import suiteSchema from "../../schemas/evaluation-suite.schema.json";
import agentResultSchema from "../../schemas/agent-result.schema.json";
import { PolicyService } from "../policy/service";
import { assertPathWithin } from "../security/paths";
import { evaluateFixture } from "./evaluator";
import type {
  EvaluationCaseResult, EvaluationFixture, EvaluationSuiteManifest, EvaluationSuiteResult,
} from "./types";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(agentResultSchema);
const validateManifest = ajv.compile(suiteSchema) as ValidateFunction<EvaluationSuiteManifest>;
const validateFixture = ajv.compile(fixtureSchema) as ValidateFunction<EvaluationFixture>;

function validationMessage(label: string, validate: ValidateFunction): string {
  const detail = validate.errors?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ") ?? "invalid document";
  return `${label} is invalid: ${detail}`;
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} could not be read: ${(error as Error).message}`);
  }
}

function exactCodes(left: string[], right: string[]): boolean {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

export function runEvaluationSuite(
  repoRoot: string = process.cwd(),
  manifestPath: string = join(repoRoot, "evals", "v1", "suite.json"),
): EvaluationSuiteResult {
  const evalsRoot = join(repoRoot, "evals");
  const safeManifestPath = assertPathWithin(evalsRoot, manifestPath, "evaluation manifest path");
  const suiteRoot = dirname(safeManifestPath);
  const manifestValue = readJson(safeManifestPath, "evaluation manifest");
  if (!validateManifest(manifestValue)) throw new Error(validationMessage("evaluation manifest", validateManifest));
  const manifest = manifestValue;
  if (manifest.schema_version !== 1) throw new Error(`unsupported evaluation schema version: ${manifest.schema_version}`);

  const policyAgents = new PolicyService(repoRoot).listAgents();
  const agents = new Map(policyAgents.map((agent) => [agent.id, agent]));
  const fixtureIds = new Set<string>();
  const positiveCoverage = new Set<string>();
  const cases: EvaluationCaseResult[] = [];

  for (const relativePath of manifest.fixtures) {
    const fixturePath = assertPathWithin(suiteRoot, join(suiteRoot, relativePath), "evaluation fixture path");
    if (extname(fixturePath).toLowerCase() !== ".json") throw new Error(`evaluation fixture must be JSON: ${relativePath}`);
    const fixtureValue = readJson(fixturePath, `evaluation fixture '${relativePath}'`);
    if (!validateFixture(fixtureValue)) throw new Error(validationMessage(`evaluation fixture '${relativePath}'`, validateFixture));
    const fixture = fixtureValue;
    if (fixtureIds.has(fixture.id)) throw new Error(`duplicate evaluation fixture id: ${fixture.id}`);
    fixtureIds.add(fixture.id);
    const agent = agents.get(fixture.role) ?? null;

    for (const taskType of fixture.task_types) {
      const evaluation = evaluateFixture(fixture, agent, taskType, manifest.minimum_score);
      const actualCodes = evaluation.hard_failures.map((failure) => failure.code);
      const expectationErrors: string[] = [];
      if (evaluation.verdict !== fixture.expected.verdict) {
        expectationErrors.push(`expected verdict ${fixture.expected.verdict}, received ${evaluation.verdict}`);
      }
      if (!exactCodes(actualCodes, fixture.expected.hard_failure_codes)) {
        expectationErrors.push(`expected hard failures [${fixture.expected.hard_failure_codes.join(", ")}], received [${actualCodes.join(", ")}]`);
      }
      const matched = expectationErrors.length === 0;
      cases.push({ evaluation, matched_expectation: matched, expectation_errors: expectationErrors });
      if (fixture.expected.verdict === "pass" && matched) positiveCoverage.add(`${fixture.role}:${taskType}`);
    }
  }

  const expectedCoverage = policyAgents.flatMap((agent) => agent.allowed_task_types.map((taskType) => `${agent.id}:${taskType}`)).sort();
  const missing = expectedCoverage.filter((key) => !positiveCoverage.has(key));
  const errors = cases.flatMap((item) => item.expectation_errors.map((error) => `${item.evaluation.fixture_id}/${item.evaluation.task_type}: ${error}`));
  if (missing.length > 0) errors.push(`missing positive role/task-type coverage: ${missing.join(", ")}`);
  const matched = cases.filter((item) => item.matched_expectation).length;

  return {
    suite_id: manifest.suite_id,
    schema_version: manifest.schema_version,
    passed: errors.length === 0,
    evaluated: cases.length,
    matched,
    coverage: { expected: expectedCoverage.length, covered: expectedCoverage.length - missing.length, missing },
    cases,
    errors,
  };
}
