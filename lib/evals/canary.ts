import type { AgentEvent, AgentExecutor, AgentRunInput, AgentUsage } from "../../runner/agent-executor";
import { AGENT_REPORT_SCHEMA, validateAgentReport, type AgentReport } from "../../runner/agent-report";
import type { PolicyAgent } from "../policy/service";
import { evaluateOutcomeCase } from "./outcome-evaluator";
import { OUTCOME_GOLDEN_SUITE_ID } from "./outcome-types";
import type { OutcomeGoldenCase } from "./outcome-types";

export const LIVE_CANARY_CASE_IDS = ["architecture-review", "security-review"] as const;
export const LIVE_CANARY_LIMITS = {
  max_requests: 2,
  max_tokens_per_request: 3000,
  max_turn_runtime_ms: 120_000,
  max_total_runtime_ms: 300_000,
} as const;

export interface CanaryAuthorization {
  kind: "run" | "skip" | "deny";
  message: string;
}

export function authorizeLiveCanaries(args: string[], env: NodeJS.ProcessEnv): CanaryAuthorization {
  const confirmed = args.length === 1 && args[0] === "--confirm-live-canaries";
  const optedIn = env.SURTEC_LIVE_CANARIES === "1";
  const inCi = Boolean(env.CI && env.CI !== "0" && env.CI.toLowerCase() !== "false");
  if (inCi) return { kind: "deny", message: "Live canaries are disabled in CI." };
  if (args.length > 0 && !confirmed) return { kind: "deny", message: "Only --confirm-live-canaries is accepted; prompts and counts are fixed." };
  if (!optedIn && !confirmed) return { kind: "skip", message: "Live canaries skipped; no opt-in was provided." };
  if (!optedIn || !confirmed) return { kind: "deny", message: "To run live canaries, set SURTEC_LIVE_CANARIES=1 and pass --confirm-live-canaries." };
  return { kind: "run", message: "Explicit live canary opt-in accepted." };
}

export interface LiveCanaryCaseResult {
  id: string;
  verdict: "pass" | "fail" | "hard-fail";
  score: number;
  runtime_ms: number;
  tokens: number | null;
}

export interface LiveCanarySummary {
  suite_id: typeof OUTCOME_GOLDEN_SUITE_ID;
  request_count: number;
  total_runtime_ms: number;
  total_tokens: number | null;
  cases: LiveCanaryCaseResult[];
}

export interface LiveCanaryOptions {
  executor: AgentExecutor;
  cases: OutcomeGoldenCase[];
  fixtureDirectory: string;
  minimumScore: number;
  policyAgents: Map<string, PolicyAgent>;
  snapshot: () => Record<string, string>;
  now?: () => number;
  model?: string;
  reasoningEffort?: AgentRunInput["reasoningEffort"];
}

function isUsage(value: unknown): value is AgentUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  return ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"]
    .every((key) => typeof usage[key] === "number" && Number.isFinite(usage[key]) && (usage[key] as number) >= 0);
}

function exactSnapshot(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left).sort();
  return JSON.stringify(keys.map((key) => [key, left[key]]))
    === JSON.stringify(Object.keys(right).sort().map((key) => [key, right[key]]));
}

function reportToResult(id: string, role: string, report: AgentReport) {
  return {
    task_id: id,
    agent: role,
    status: report.status,
    summary: report.summary,
    files_changed: [],
    commands_run: report.commands_run,
    tests_run: report.tests_run,
    risks: report.risks,
    blockers: report.blockers,
    next_steps: report.next_steps,
    artifacts: report.artifacts,
    logs_path: "canary/redacted",
  };
}
export async function runLiveCanaries(options: LiveCanaryOptions): Promise<LiveCanarySummary> {
  const ids = options.cases.map((item) => item.id);
  if (ids.length !== LIVE_CANARY_LIMITS.max_requests || LIVE_CANARY_CASE_IDS.some((id, index) => ids[index] !== id)) {
    throw new Error("live canary case list does not match the fixed two-case allowlist");
  }
  for (const item of options.cases) {
    if (item.candidate.sandbox !== "read-only" || item.candidate.result.files_changed.length > 0
      || item.candidate.result.commands_run.length > 0 || item.candidate.requested_actions.length > 0) {
      throw new Error("live canary definitions must be read-only and side-effect free");
    }
  }

  const now = options.now ?? Date.now;
  const suiteStarted = now();
  const before = options.snapshot();
  const caseResults: LiveCanaryCaseResult[] = [];
  let totalTokens = 0;
  let activeController: AbortController | null = null;
  let suiteLimitExceeded = false;
  let fixtureUnchanged = false;
  const suiteTimer = setTimeout(() => {
    suiteLimitExceeded = true;
    activeController?.abort();
  }, LIVE_CANARY_LIMITS.max_total_runtime_ms);

  try {
    for (const item of options.cases) {
      const turnStarted = now();
      const controller = new AbortController();
      activeController = controller;
      let abortReason: "token-budget" | "turn-runtime" | null = null;
      let terminalStatus = "";
      let observedUsage: AgentUsage | null = null;
      const turnTimer = setTimeout(() => {
        abortReason = "turn-runtime";
        controller.abort();
      }, LIVE_CANARY_LIMITS.max_turn_runtime_ms);
      const input: AgentRunInput = {
        cwd: options.fixtureDirectory,
        developerInstructions: "This is an explicitly opted-in read-only evaluation canary. Inspect only the supplied synthetic fixture. Do not modify files, run commands, contact external services, or expose private data. Return a concise structured review with source references in artifacts.",
        prompt: `${item.scenario}\n\nUse only the synthetic files in the supplied fixture. This canary is read-only; do not use shell commands. Include concrete fixture paths in artifacts, a concise risk, and an actionable next step.`,
        mode: "read-only",
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        outputSchema: AGENT_REPORT_SCHEMA as unknown as Record<string, unknown>,
      };
      let runResult: Awaited<ReturnType<AgentExecutor["run"]>>;
      try {
        runResult = await options.executor.run(input, (event: AgentEvent) => {
          if (event.type === "turn-completed") terminalStatus = event.status;
          if (event.type === "usage") {
            observedUsage = event.usage;
            if (event.usage.totalTokens > LIVE_CANARY_LIMITS.max_tokens_per_request) {
              abortReason = "token-budget";
              controller.abort();
            }
          }
        }, controller.signal);
      } catch {
        if (abortReason === "token-budget") throw new Error(`live canary ${item.id} exceeded the token budget`);
        if (abortReason === "turn-runtime" || suiteLimitExceeded) throw new Error(`live canary ${item.id} exceeded the runtime budget`);
        throw new Error(`live canary ${item.id} failed; model output and runtime details are withheld`);
      } finally {
        clearTimeout(turnTimer);
        activeController = null;
      }
      if (suiteLimitExceeded) throw new Error("live canary suite exceeded the total runtime budget");
      if (abortReason) throw new Error(`live canary ${item.id} exceeded the ${abortReason === "token-budget" ? "token" : "runtime"} budget`);
      if (terminalStatus !== "completed") throw new Error(`live canary ${item.id} did not complete a successful read-only turn`);
      if (!runResult.threadId.trim() || !runResult.turnId.trim()) throw new Error(`live canary ${item.id} returned invalid runtime identifiers`);

      const validated = validateAgentReport(runResult.structuredOutput);
      if (!validated.ok) throw new Error(`live canary ${item.id} returned an invalid structured report`);
      const usage = runResult.usage ?? observedUsage;
      if (runResult.usage !== null && !isUsage(runResult.usage)) throw new Error(`live canary ${item.id} returned invalid usage data`);
      if (!usage) throw new Error(`live canary ${item.id} did not report token usage; budget could not be verified`);
      if (usage.totalTokens > LIVE_CANARY_LIMITS.max_tokens_per_request) {
        throw new Error(`live canary ${item.id} exceeded the token budget`);
      }
      totalTokens += usage.totalTokens;

      const candidate = {
        ...item.candidate,
        sandbox: "read-only" as const,
        allowed_commands: [],
        requested_actions: [],
        result: reportToResult(item.id, item.role, validated.report),
      };
      const evaluation = evaluateOutcomeCase({
        id: item.id,
        role: item.role,
        task_type: item.task_type,
        description: item.description,
        candidate,
        expectations: item.expectations,
      }, options.policyAgents.get(item.role) ?? null, options.minimumScore);
      if (evaluation.evaluation.verdict !== "pass") {
        throw new Error(`live canary ${item.id} did not meet the pinned suite's deterministic expectations`);
      }
      caseResults.push({
        id: item.id,
        verdict: evaluation.evaluation.verdict,
        score: evaluation.evaluation.score,
        runtime_ms: Math.max(0, Math.round(now() - turnStarted)),
        tokens: usage.totalTokens,
      });
    }
  } finally {
    clearTimeout(suiteTimer);
    activeController?.abort();
    try { fixtureUnchanged = exactSnapshot(before, options.snapshot()); }
    catch { fixtureUnchanged = false; }
  }

  if (suiteLimitExceeded) throw new Error("live canary suite exceeded the total runtime budget");
  if (!fixtureUnchanged) throw new Error("live canary fixture changed or could not be verified; no report was accepted");
  return {
    suite_id: OUTCOME_GOLDEN_SUITE_ID,
    request_count: caseResults.length,
    total_runtime_ms: Math.max(0, Math.round(now() - suiteStarted)),
    total_tokens: totalTokens,
    cases: caseResults,
  };
}
