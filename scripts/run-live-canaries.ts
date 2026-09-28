import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codexExecutor } from "../runner/codex-executor";
import { PolicyService } from "../lib/policy/service";
import { runEvaluationSuite } from "../lib/evals/suite";
import { loadOutcomeGoldenSuite, runOutcomeEvaluationSuite } from "../lib/evals/outcome-suite";
import { authorizeLiveCanaries, LIVE_CANARY_CASE_IDS, LIVE_CANARY_LIMITS, runLiveCanaries } from "../lib/evals/canary";
import { OUTCOME_GOLDEN_SUITE_ID } from "../lib/evals/outcome-types";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = resolve(root, "fixtures", "evals-canary");
const FIXTURE_README = "# Synthetic session review fixture\n\nThis repository-owned fixture contains only fictional session parsing and access-control examples. It exists for explicitly opted-in, read-only evaluation canaries; it is not application code or client data.\n";

function assertFixture(): void {
  const canonicalRoot = realpathSync.native(root);
  const canonicalFixture = realpathSync.native(fixture);
  if (canonicalFixture !== resolve(canonicalRoot, "fixtures", "evals-canary")) {
    throw new Error("canary fixture does not resolve to the repository-owned synthetic fixture");
  }
  const marker = join(canonicalFixture, "README.md");
  const markerStats = lstatSync(marker);
  if (!markerStats.isFile() || markerStats.isSymbolicLink()) throw new Error("canary fixture marker must be a regular file");
  const markerContents = readFileSync(marker, "utf8").replaceAll("\r\n", "\n");
  if (markerContents !== FIXTURE_README) {
    throw new Error("canary fixture marker is missing or unexpected");
  }
}

function snapshot(directory: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const visit = (current: string): void => {
    for (const name of readdirSync(current)) {
      const absolute = join(current, name);
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink()) throw new Error("canary fixture must not contain symbolic links");
      if (stats.isDirectory()) visit(absolute);
      else if (stats.isFile()) {
        entries[relative(directory, absolute).replaceAll("\\", "/")] = createHash("sha256").update(readFileSync(absolute)).digest("hex");
      } else throw new Error("canary fixture contains an unsupported filesystem entry");
    }
  };
  visit(directory);
  return entries;
}

async function main(): Promise<void> {
  const authorization = authorizeLiveCanaries(process.argv.slice(2), process.env);
  if (authorization.kind === "skip") {
    console.log(`${authorization.message} Set SURTEC_LIVE_CANARIES=1 and pass --confirm-live-canaries to make exactly two read-only model requests.`);
    return;
  }
  if (authorization.kind === "deny") throw new Error(authorization.message);

  assertFixture();
  const v1 = runEvaluationSuite(root);
  const outcome = runOutcomeEvaluationSuite(root);
  if (!v1.passed || !outcome.passed || outcome.suite_id !== OUTCOME_GOLDEN_SUITE_ID) {
    throw new Error("offline EVAL suites must pass and match the pinned suite before live canaries can run");
  }
  const { manifest, cases } = loadOutcomeGoldenSuite(root);
  const byId = new Map(cases.map((item) => [item.id, item]));
  const selected = LIVE_CANARY_CASE_IDS.map((id) => byId.get(id));
  if (selected.some((item) => !item)) throw new Error("pinned live canary cases are missing from the outcome suite");
  const caseList = selected as NonNullable<(typeof selected)[number]>[];
  const agents = new Map(new PolicyService(root).listAgents().map((agent) => [agent.id, agent]));
  console.warn("Starting exactly two read-only live canaries against the synthetic fixture; model quota may be consumed.");
  const result = await runLiveCanaries({
    executor: codexExecutor,
    cases: caseList,
    fixtureDirectory: fixture,
    minimumScore: manifest.minimum_score,
    policyAgents: agents,
    snapshot: () => snapshot(fixture),
    model: process.env.SURTEC_CODEX_MODEL?.trim() || undefined,
    reasoningEffort: process.env.SURTEC_CODEX_REASONING_EFFORT?.trim() || undefined,
  });
  if (result.request_count !== LIVE_CANARY_LIMITS.max_requests) throw new Error("live canary request count did not match its fixed limit");
  console.log(JSON.stringify({
    status: "passed",
    compared_with_suite: result.suite_id,
    request_count: result.request_count,
    request_limit: LIVE_CANARY_LIMITS.max_requests,
    token_limit_per_request: LIVE_CANARY_LIMITS.max_tokens_per_request,
    runtime_limit_ms: LIVE_CANARY_LIMITS.max_total_runtime_ms,
    total_runtime_ms: result.total_runtime_ms,
    usage: {
      total_tokens: result.total_tokens,
      by_case: result.cases.map(({ id, tokens, runtime_ms, verdict }) => ({ id, tokens, runtime_ms, verdict })),
      cost_estimate_usd: null,
      cost_estimate_note: "Not available: local token usage is reported, but account billing data is not read.",
    },
    fixture_unchanged: true,
  }));
}

try {
  await main();
} catch {
  console.error("Live canary suite failed or was denied. Raw model output and runtime diagnostics were withheld.");
  process.exitCode = 1;
}
