import { runOutcomeEvaluationSuite } from "../lib/evals/outcome-suite";

try {
  const result = runOutcomeEvaluationSuite();
  for (const item of result.cases) {
    const evaluation = item.evaluation;
    const marker = item.matched_expectation ? "PASS" : "FAIL";
    console.log(`${marker} ${evaluation.fixture_id}/${evaluation.task_type} verdict=${evaluation.verdict} score=${evaluation.score.toFixed(3)}`);
    for (const error of item.expectation_errors) console.error(`  - ${error}`);
  }
  console.log(`Outcome suite ${result.suite_id}: expectations ${result.matched}/${result.evaluated}.`);
  if (!result.passed) {
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Outcome evaluation suite failed closed: ${(error as Error).message}`);
  process.exitCode = 1;
}
