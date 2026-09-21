import { describe, expect, it } from "vitest";
import { assertAgentResult, toAgentResult, failureResult } from "./result";
import type { TaskEnvelope } from "../lib/state/types";

const envelope: TaskEnvelope = {
  id: "T-1", source: "dashboard", project: "stock-control", task_type: "analysis",
  agent: "backend-engineer", title: "t", instructions: "i", repo_path: "~/x",
  branch: "agent/T-1", sandbox: "read-only", expected_outputs: [],
  requires_human_approval: true, metadata: {},
};

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: "looks ok",
    status: "completed",
    commands_run: [],
    tests_run: [],
    risks: [],
    blockers: [],
    next_steps: [],
    artifacts: [],
    ...overrides,
  };
}

describe("toAgentResult", () => {
  it("maps a valid structured report into the canonical AgentResult", () => {
    const r = toAgentResult(
      envelope,
      report({ risks: ["no rate limit"], next_steps: ["add tests"], status: "needs-review" }),
      "raw",
      "reports/T-1.jsonl",
    );
    expect(r.status).toBe("needs-review");
    expect(r.summary).toBe("looks ok");
    expect(r.risks).toEqual(["no rate limit"]);
    expect(r.next_steps).toEqual(["add tests"]);
    expect(r.files_changed).toEqual([]);
    expect(r.logs_path).toBe("reports/T-1.jsonl");
  });

  it.each([
    ["missing output", undefined],
    ["invalid status", report({ status: "weird" })],
    ["extra field", report({ surprise: true })],
    ["wrong array", report({ risks: [1] })],
  ])("routes %s to needs-review", (_label, output) => {
    const r = toAgentResult(envelope, output, "raw response", "log.jsonl");
    expect(r.status).toBe("needs-review");
    expect(r.summary).toBe("raw response");
    expect(r.risks[0]).toContain("Invalid agent report");
  });

  it("uses the provided files and verification report", () => {
    const verification = { status: "passed" as const, checks: [{ command: "pnpm test", ok: true, output_tail: "" }] };
    const r = toAgentResult(envelope, report(), "raw", "log.jsonl", ["src/a.ts"], verification);
    expect(r.files_changed).toEqual(["src/a.ts"]);
    expect(r.verification).toEqual(verification);
  });
});

describe("failureResult", () => {
  it("produces a failed result with the reason as a blocker", () => {
    const r = failureResult(envelope, "timeout (5m)", "reports/T-1.jsonl");
    expect(r.status).toBe("failed");
    expect(r.blockers).toEqual(["timeout (5m)"]);
    expect(r.summary).toContain("timeout (5m)");
    expect(r.verification).toBeNull();
  });
});

describe("assertAgentResult", () => {
  it("rejects a result that violates the canonical schema", () => {
    expect(() => assertAgentResult({ status: "completed" })).toThrow("AgentResult schema validation failed");
  });
});
