import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentExecutor, AgentRunInput, AgentRunResult } from "../../runner/agent-executor";
import { PolicyService } from "../policy/service";
import { loadOutcomeGoldenSuite } from "./outcome-suite";
import { authorizeLiveCanaries, LIVE_CANARY_LIMITS, runLiveCanaries } from "./canary";

const agents = new Map(new PolicyService(process.cwd()).listAgents().map((agent) => [agent.id, agent]));
const cases = loadOutcomeGoldenSuite().cases.filter((item) => item.id === "architecture-review" || item.id === "security-review");

function report(role: string) {
  return {
    status: "completed",
    summary: `Reviewed the synthetic ${role} boundary and identified a concrete validation gap in the fixture.`,
    commands_run: [], tests_run: [],
    risks: ["The caller must not treat an unvalidated value as proof of access."], blockers: [],
    next_steps: ["Keep validation behind the shared boundary and add a malformed-input case."],
    artifacts: ["src/session.ts:parseSession", "src/page-access.ts:canAccess"],
  };
}

function executorFor(onRun?: (input: AgentRunInput, events: (event: AgentEvent) => void, signal: AbortSignal) => void): AgentExecutor & { calls: AgentRunInput[] } {
  const calls: AgentRunInput[] = [];
  return {
    calls,
    async run(input, events, signal): Promise<AgentRunResult> {
      calls.push(input);
      onRun?.(input, events, signal);
      const eventBase = { at: "2026-09-28T12:00:00.000Z", threadId: "fake-thread", turnId: "fake-turn" };
      events({ type: "usage", ...eventBase, usage: { inputTokens: 800, cachedInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 0, totalTokens: 1200 } });
      events({ type: "turn-completed", ...eventBase, status: "completed" });
      return { finalText: "withheld", structuredOutput: report("security"), threadId: "fake-thread", turnId: "fake-turn", usage: { inputTokens: 800, cachedInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 0, totalTokens: 1200 } };
    },
  };
}

describe("opt-in live canary safety", () => {
  it("skips by default, requires both explicit opt-ins, and blocks CI", () => {
    expect(authorizeLiveCanaries([], {} as NodeJS.ProcessEnv).kind).toBe("skip");
    expect(authorizeLiveCanaries(["--confirm-live-canaries"], {} as NodeJS.ProcessEnv).kind).toBe("deny");
    expect(authorizeLiveCanaries([], { SURTEC_LIVE_CANARIES: "1" } as NodeJS.ProcessEnv).kind).toBe("deny");
    expect(authorizeLiveCanaries(["--confirm-live-canaries"], { SURTEC_LIVE_CANARIES: "1", CI: "true" } as NodeJS.ProcessEnv).kind).toBe("deny");
    expect(authorizeLiveCanaries(["--confirm-live-canaries", "--count=99"], { SURTEC_LIVE_CANARIES: "1" } as NodeJS.ProcessEnv).kind).toBe("deny");
    expect(authorizeLiveCanaries(["--confirm-live-canaries"], { SURTEC_LIVE_CANARIES: "1" } as NodeJS.ProcessEnv).kind).toBe("run");
  });

  it("makes exactly two sequential read-only requests and returns only usage and evaluation summaries", async () => {
    const executor = executorFor();
    const result = await runLiveCanaries({
      executor, cases, fixtureDirectory: "synthetic-fixture", minimumScore: 0.9, policyAgents: agents,
      snapshot: () => ({ "README.md": "fixed-hash" }), now: () => 100,
    });
    expect(result).toMatchObject({ suite_id: "surtec-outcome-golden-v2", request_count: 2, total_runtime_ms: 0, total_tokens: 2400 });
    expect(result.cases.map((item) => item.verdict)).toEqual(["pass", "pass"]);
    expect(executor.calls).toHaveLength(LIVE_CANARY_LIMITS.max_requests);
    expect(executor.calls.every((input) => input.mode === "read-only" && input.cwd === "synthetic-fixture")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic-fixture");
    expect(JSON.stringify(result)).not.toContain("validation gap");
  });

  it("aborts at the token threshold and does not make the remaining request", async () => {
    const run = vi.fn(async (_input: AgentRunInput, events: (event: AgentEvent) => void, signal: AbortSignal) => {
      events({ type: "usage", at: "2026-09-28T12:00:00.000Z", threadId: "fake", turnId: "fake", usage: { inputTokens: 4000, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 4000 } });
      expect(signal.aborted).toBe(true);
      throw new Error("aborted");
    });
    const executor = { run } as unknown as AgentExecutor;
    await expect(runLiveCanaries({ executor, cases, fixtureDirectory: "synthetic", minimumScore: 0.9, policyAgents: agents, snapshot: () => ({}) }))
      .rejects.toThrow(/exceeded the token budget/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects a fixture snapshot that changed during the canary", async () => {
    const executor = executorFor();
    let snapshots = 0;
    await expect(runLiveCanaries({
      executor, cases, fixtureDirectory: "synthetic", minimumScore: 0.9, policyAgents: agents,
      snapshot: () => ({ "README.md": snapshots++ === 0 ? "before" : "after" }),
    })).rejects.toThrow(/fixture changed/);
  });
});
