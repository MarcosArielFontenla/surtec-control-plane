import type { RegistryAgent } from "./registry-agents";
import type { TaskEnvelope } from "../lib/state/types";

export function buildSystemPrompt(agent: RegistryAgent, agentsMd: string): string {
  return [
    `You are the Surtec "${agent.name}" agent (id: ${agent.id}).`,
    `Role: ${agent.description}`,
    `Allowed task types: ${agent.allowed_task_types.join(", ") || "(unspecified)"}.`,
    "",
    "You are running in READ-ONLY mode. You may read and inspect the repository",
    "(Read, Grep, Glob). You must NOT modify files, run commands, merge, deploy, or push.",
    "",
    "Repository rules (AGENTS.md):",
    agentsMd.trim(),
    "",
    "When you finish, end your reply with a single fenced ```json block containing exactly:",
    '{ "summary": string, "risks": string[], "blockers": string[], "next_steps": string[], "status": "completed"|"partial"|"blocked"|"failed"|"needs-review" }',
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
