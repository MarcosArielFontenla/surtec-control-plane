import { describe, it, expect } from "vitest";
import { buildPrBody } from "./github";
import type { AgentResult, TaskEnvelope } from "../lib/state/types";

const envelope: TaskEnvelope = {
  id: "T-1", source: "dashboard", project: "stock-control", task_type: "implementation",
  agent: "backend-engineer", title: "Add alert", instructions: "do it", repo_path: "~/dev/x",
  branch: "agent/T-1", sandbox: "workspace-write", expected_outputs: [],
  requires_human_approval: true, metadata: {},
};

function result(over: Partial<AgentResult> = {}): AgentResult {
  return {
    task_id: "T-1", agent: "backend-engineer", status: "completed",
    summary: "Added the alert endpoint.",
    files_changed: ["src/a.ts"], commands_run: [], tests_run: [],
    risks: ["no rate limit"], blockers: [], next_steps: ["add tests"], artifacts: [],
    logs_path: "reports/T-1.jsonl",
    ...over,
  };
}

describe("buildPrBody", () => {
  it("includes summary, risks, next steps, and a footer with the task id + agent", () => {
    const body = buildPrBody(envelope, result());
    expect(body).toContain("## Summary");
    expect(body).toContain("Added the alert endpoint.");
    expect(body).toContain("## Risks");
    expect(body).toContain("- no rate limit");
    expect(body).toContain("## Next steps");
    expect(body).toContain("- add tests");
    expect(body).toContain("task T-1");
    expect(body).toContain("agent backend-engineer");
  });

  it("omits empty risk/next-step sections", () => {
    const body = buildPrBody(envelope, result({ risks: [], next_steps: [] }));
    expect(body).not.toContain("## Risks");
    expect(body).not.toContain("## Next steps");
    expect(body).toContain("## Summary");
  });

  it("handles a null result with a placeholder summary", () => {
    const body = buildPrBody(envelope, null);
    expect(body).toContain("(no summary)");
    expect(body).toContain("task T-1");
  });
});
