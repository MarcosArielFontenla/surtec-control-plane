import type { RegistryAgent } from "./registry-agents";
import type { TaskEnvelope } from "../lib/state/types";
import type { RunMode } from "./agent-executor";

export function buildSystemPrompt(agent: RegistryAgent, agentsMd: string, mode: RunMode = "read-only", verifyCommands: string[] = []): string {
  const modeLines =
    mode === "workspace-write-verify" && verifyCommands.length > 0
      ? [
          "You are running in WORKSPACE-WRITE mode with VERIFICATION. You MAY use Read, Grep, and Glob",
          "to inspect the repository AND edit files with Edit, Write, and MultiEdit. You MAY ALSO run",
          "ONLY these exact commands via Bash to verify your work:",
          ...verifyCommands.map((c) => `  - ${c}`),
          "Run them; if they fail, fix your edits and re-run until they pass. Any other shell command is",
          "denied. You must NOT merge, deploy, or push. The control plane commits your edits to a branch",
          "for human review.",
        ]
      : mode === "workspace-write"
        ? [
            "You are running in WORKSPACE-WRITE mode. You MAY use Read, Grep, and Glob to inspect",
            "the repository AND edit files with Edit, Write, and MultiEdit. You must NOT run shell",
            "commands, execute scripts, merge, deploy, or push. The control plane commits your edits",
            "to a branch for human review.",
          ]
        : [
            "You are running in READ-ONLY mode. You MAY use the Read, Grep, and Glob tools to",
            "inspect the repository. You must NOT modify files, run shell commands, execute",
            "scripts, merge, deploy, or push.",
          ];
  return [
    `You are the Surtec "${agent.name}" agent (id: ${agent.id}).`,
    `Role: ${agent.description}`,
    `Allowed task types: ${agent.allowed_task_types.join(", ") || "(unspecified)"}.`,
    "",
    ...modeLines,
    "",
    "Repository rules (AGENTS.md):",
    agentsMd.trim(),
    "",
    "Return only the structured report required by the provided output schema.",
    "Use real values. Never claim completion when work is unverified or the report is invalid.",
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
