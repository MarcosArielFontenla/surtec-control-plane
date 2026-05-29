import type { RegistryAgent } from "./registry-agents";
import type { TaskEnvelope } from "../lib/state/types";

export function buildSystemPrompt(agent: RegistryAgent, agentsMd: string): string {
  return [
    `You are the Surtec "${agent.name}" agent (id: ${agent.id}).`,
    `Role: ${agent.description}`,
    `Allowed task types: ${agent.allowed_task_types.join(", ") || "(unspecified)"}.`,
    "",
    "You are running in READ-ONLY mode. You MAY use the Read, Grep, and Glob tools to",
    "inspect the repository. You must NOT modify files, run shell commands, execute",
    "scripts, merge, deploy, or push.",
    "",
    "Repository rules (AGENTS.md):",
    agentsMd.trim(),
    "",
    // Keep these report fields in sync with AgentResult in lib/state/types.ts.
    "When you finish, end your reply with a single fenced ```json block. Use real values",
    "(do not echo the placeholders). Example shape:",
    "```json",
    "{",
    '  "summary": "one-sentence summary of what you found",',
    '  "risks": ["a risk you identified, or omit for none"],',
    '  "blockers": [],',
    '  "next_steps": ["a suggested next step"],',
    '  "status": "completed"',
    "}",
    "```",
    'The "status" field must be exactly one of: completed, partial, blocked, failed, needs-review.',
  ].join("\n");
}

export function buildUserPrompt(envelope: TaskEnvelope): string {
  return [
    `Task ${envelope.id}: ${envelope.title}`,
    `Project: ${envelope.project}`,
    "",
    "Instructions:",
    envelope.instructions,
  ].join("\n");
}
