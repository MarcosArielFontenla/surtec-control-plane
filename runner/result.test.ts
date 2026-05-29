import { describe, it, expect } from "vitest";
import { toAgentResult, failureResult } from "./result";
import type { TaskEnvelope } from "../lib/state/types";

const envelope: TaskEnvelope = {
  id: "T-1", source: "dashboard", project: "stock-control", task_type: "analysis",
  agent: "backend-engineer", title: "t", instructions: "i", repo_path: "~/x",
  branch: "agent/T-1", sandbox: "read-only", expected_outputs: [],
  requires_human_approval: true, metadata: {},
};

describe("toAgentResult", () => {
  it("parses a trailing json block into the AgentResult", () => {
    const text = [
      "Here is my analysis.",
      "```json",
      '{ "summary": "looks ok", "risks": ["no rate limit"], "blockers": [], "next_steps": ["add tests"], "status": "needs-review" }',
      "```",
    ].join("\n");
    const r = toAgentResult(envelope, text, "reports/T-1.jsonl");
    expect(r.status).toBe("needs-review");
    expect(r.summary).toBe("looks ok");
    expect(r.risks).toEqual(["no rate limit"]);
    expect(r.next_steps).toEqual(["add tests"]);
    expect(r.files_changed).toEqual([]);
    expect(r.commands_run).toEqual([]);
    expect(r.logs_path).toBe("reports/T-1.jsonl");
    expect(r.task_id).toBe("T-1");
    expect(r.agent).toBe("backend-engineer");
  });

  it("defaults an invalid status to completed", () => {
    const text = '```json\n{ "summary": "x", "status": "weird" }\n```';
    expect(toAgentResult(envelope, text, "l").status).toBe("completed");
  });

  it("falls back to summary=text with empty arrays when there is no json block", () => {
    const r = toAgentResult(envelope, "just prose, no json", "l");
    expect(r.status).toBe("completed");
    expect(r.summary).toBe("just prose, no json");
    expect(r.risks).toEqual([]);
    expect(r.blockers).toEqual([]);
    expect(r.next_steps).toEqual([]);
  });

  it("uses the provided filesChanged (workspace-write) instead of empty", () => {
    const r = toAgentResult(envelope, "ok", "l", ["src/a.ts", "src/b.ts"]);
    expect(r.files_changed).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("defaults files_changed to [] when none provided", () => {
    const r = toAgentResult(envelope, "ok", "l");
    expect(r.files_changed).toEqual([]);
  });
});

describe("failureResult", () => {
  it("produces a failed result with the reason as a blocker", () => {
    const r = failureResult(envelope, "timeout (5m)", "reports/T-1.jsonl");
    expect(r.status).toBe("failed");
    expect(r.blockers).toEqual(["timeout (5m)"]);
    expect(r.summary).toContain("timeout (5m)");
    expect(r.logs_path).toBe("reports/T-1.jsonl");
  });
});
