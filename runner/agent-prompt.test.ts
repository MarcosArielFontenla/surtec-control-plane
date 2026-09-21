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
  it("includes role, read-only constraint, AGENTS.md, and structured-report instruction", () => {
    const p = buildSystemPrompt(agent, "RULE: do not deploy.");
    expect(p).toContain("Backend Engineer");
    expect(p).toContain("Implements backend services.");
    expect(p).toContain("READ-ONLY");
    expect(p).toContain("RULE: do not deploy.");
    expect(p).toContain("structured report");
    expect(p).toContain("Allowed task types");
    expect(p).toContain("bugfix");
  });

  it("uses read-only wording by default", () => {
    const p = buildSystemPrompt(agent, "RULE: do not deploy.");
    expect(p).toContain("READ-ONLY");
    expect(p).not.toContain("WORKSPACE-WRITE");
  });

  it("grants edit tools and forbids commands in workspace-write mode", () => {
    const p = buildSystemPrompt(agent, "RULE: do not deploy.", "workspace-write");
    expect(p).toContain("WORKSPACE-WRITE");
    expect(p).not.toContain("READ-ONLY");
    expect(p).toContain("edit files");
    expect(p).toContain("must NOT run");
    expect(p).toContain("output schema");
  });
});

describe("buildSystemPrompt (workspace-write-verify)", () => {
  it("verify mode lists the exact allowed commands and the ONLY-these instruction", () => {
    const agent = { id: "be", name: "Backend", description: "impl", allowed_task_types: ["bugfix"] };
    const p = buildSystemPrompt(agent as any, "RULES", "workspace-write-verify", ["pnpm install", "pnpm test"]);
    expect(p).toContain("WORKSPACE-WRITE mode with VERIFICATION");
    expect(p).toMatch(/ONLY these exact commands/i);
    expect(p).toContain("pnpm install");
    expect(p).toContain("pnpm test");
  });

  it("workspace-write (non-verify) prompt does not mention VERIFICATION", () => {
    const agent = { id: "be", name: "Backend", description: "impl", allowed_task_types: ["bugfix"] };
    const p = buildSystemPrompt(agent as any, "RULES", "workspace-write");
    expect(p).not.toMatch(/VERIFICATION/);
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
