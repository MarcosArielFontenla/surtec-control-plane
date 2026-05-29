import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildUserPrompt } from "./agent-prompt";
import type { RegistryAgent } from "./registry-agents";
import type { TaskEnvelope } from "../lib/state/types";

const agent: RegistryAgent = {
  id: "backend-engineer",
  name: "Backend Engineer",
  description: "Implements backend services.",
  allowed_task_types: ["bugfix"],
};

const envelope: TaskEnvelope = {
  id: "T-1", source: "dashboard", project: "stock-control", task_type: "analysis",
  agent: "backend-engineer", title: "Analyze auth", instructions: "Review the auth module.",
  repo_path: "~/dev/x", branch: "agent/T-1", sandbox: "read-only",
  expected_outputs: [], requires_human_approval: true, metadata: {},
};

describe("buildSystemPrompt", () => {
  it("includes role, read-only constraint, AGENTS.md, and the json-report instruction", () => {
    const p = buildSystemPrompt(agent, "RULE: do not deploy.");
    expect(p).toContain("Backend Engineer");
    expect(p).toContain("Implements backend services.");
    expect(p).toContain("READ-ONLY");
    expect(p).toContain("RULE: do not deploy.");
    expect(p).toContain("```json");
    expect(p).toContain('"status"');
  });
});

describe("buildUserPrompt", () => {
  it("includes the task title, project and instructions", () => {
    const p = buildUserPrompt(envelope);
    expect(p).toContain("T-1");
    expect(p).toContain("Analyze auth");
    expect(p).toContain("stock-control");
    expect(p).toContain("Review the auth module.");
  });
});
