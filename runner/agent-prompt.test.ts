import { describe, it, expect } from "vitest";
import { buildGovernedPrompts, buildSystemPrompt, buildUserPrompt, workflowThreadContract, WORKFLOW_PROMPT_VERSION } from "./agent-prompt";
import { physicalLines } from "../lib/context/assemble";
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

describe("governed execution prompts", () => {
  const limits = { max_lines: 500, max_bytes: 60000, max_sources: 64 };
  it("uses selected attributed context, caps redacted prior summaries and counts all transmitted text", () => {
    const result = buildGovernedPrompts("Selected project rules\nUnicode: á", envelope, limits, "summary ".repeat(400));
    expect(result.developerInstructions).toContain("Selected project rules");
    expect(result.developerInstructions).not.toContain("summary ".repeat(251));
    expect(result.prompt).toContain(envelope.instructions);
    expect(result.bytes).toBe(Buffer.byteLength(`${result.developerInstructions}\n\n${result.prompt}`, "utf8"));
    expect(result.lines).toBe(physicalLines(`${result.developerInstructions}\n\n${result.prompt}`));
  });
  it("rejects scaffolding-inclusive line and byte overflow without truncating mandatory context", () => {
    expect(() => buildGovernedPrompts("small source", envelope, { ...limits, max_lines: 1 })).toThrow(/budget/);
    expect(() => buildGovernedPrompts("small source", envelope, { ...limits, max_bytes: 20 })).toThrow(/budget/);
  });
});

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

describe("workflow stage thread contract", () => {
  function stage() {
    return { ...envelope, metadata: {}, context_manifest: { fingerprint: "a".repeat(64) }, context_admission: { schema_version: 2, workflow_id: "W-1", stage_id: "S-1",
      stage_generation: 1, task_id: envelope.id, role_id: "reviewer", grant_id: "G-1", authority_revision: 1 } } as unknown as TaskEnvelope;
  }
  const schema = { type: "object", additionalProperties: false };
  it("starts a fresh stage and resumes only its unchanged task/stage contract", () => {
    const task = stage(), contract = workflowThreadContract(task, "candidate", "read-only", [], schema);
    expect(contract.threadId).toBeUndefined();
    task.metadata.run = { thread_id: "review-thread", workflow_task_id: task.id, workflow_stage_id: "S-1", workflow_generation: 1, context_fingerprint: contract.fingerprint };
    expect(workflowThreadContract(task, "candidate", "read-only", [], schema)).toEqual({ ...contract, threadId: "review-thread" });
    expect(buildGovernedPrompts("Attributed context", task, { max_lines: 500, max_bytes: 60000, max_sources: 64 }).developerInstructions).toContain(WORKFLOW_PROMPT_VERSION);
  });
  it.each(["task", "stage", "generation", "role", "grant", "authority", "cwd", "schema", "mode", "commands", "manifest"])("rejects %s changes instead of resuming predecessor history", (change) => {
    const task = stage(), original = workflowThreadContract(task, "candidate", "read-only", [], schema);
    task.metadata.run = { thread_id: "review-thread", workflow_task_id: task.id, workflow_stage_id: "S-1", workflow_generation: 1, context_fingerprint: original.fingerprint };
    const admission = task.context_admission as any;
    if (change === "task") task.id = "T-other";
    if (change === "stage") admission.stage_id = "S-other";
    if (change === "generation") admission.stage_generation = 2;
    if (change === "role") admission.role_id = "qa-evaluator";
    if (change === "grant") admission.grant_id = "G-other";
    if (change === "authority") admission.authority_revision = 2;
    if (change === "manifest") task.context_manifest!.fingerprint = "b".repeat(64);
    expect(() => workflowThreadContract(task, change === "cwd" ? "source" : "candidate", change === "mode" ? "workspace-write" : "read-only",
      change === "commands" ? ["node verify.mjs"] : [], change === "schema" ? { type: "object" } : schema)).toThrow(/another or changed/);
  });
  it("rejects a copied engineer thread even when its hash matches the role contract", () => {
    const task = stage(), contract = workflowThreadContract(task, "candidate", "read-only", [], schema);
    task.metadata.run = { thread_id: "engineer-thread", context_fingerprint: contract.fingerprint };
    expect(() => workflowThreadContract(task, "candidate", "read-only", [], schema)).toThrow(/another or changed/);
    expect(() => workflowThreadContract(envelope, "candidate", "read-only", [], schema)).toThrow(/v2/);
  });
});
