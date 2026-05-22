import type { PaperclipTask, SandboxMode, TaskEnvelope } from "./types.js";

const defaultAgentByLabel: Record<string, string> = {
  product: "product-manager",
  backend: "backend-engineer",
  frontend: "frontend-engineer",
  qa: "qa-reviewer",
  security: "security-reviewer",
  devops: "devops-engineer",
  docs: "documentation-writer",
  legal: "legal-reviewer-ar",
};

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function inferAgent(labels: string[] = []): string {
  for (const label of labels) {
    const normalized = slugify(label);
    if (defaultAgentByLabel[normalized]) {
      return defaultAgentByLabel[normalized];
    }
  }

  return "tech-lead";
}

function inferTaskType(labels: string[] = []): string {
  const normalizedLabels = labels.map(slugify);
  return normalizedLabels.find((label) => label !== "") ?? "general";
}

function inferSandbox(agent: string): SandboxMode {
  if (agent.endsWith("reviewer") || agent === "product-manager" || agent === "reality-checker") {
    return "read-only";
  }

  return "workspace-write";
}

export function mapPaperclipTaskToTaskEnvelope(task: PaperclipTask): TaskEnvelope {
  const agent = task.assignee ?? inferAgent(task.labels);
  const taskSlug = slugify(task.title) || "task";

  return {
    id: task.id,
    source: "paperclip",
    project: task.projectId,
    task_type: inferTaskType(task.labels),
    agent,
    title: task.title,
    instructions: task.body,
    repo_path: task.repoPath ?? `~/dev/surtec/${task.projectId}`,
    branch: task.branch ?? `agent/${task.id}-${agent}`,
    sandbox: inferSandbox(agent),
    expected_outputs: [
      "summary",
      "files_changed",
      "commands_run",
      "tests_run",
      "risks",
      "next_steps",
    ],
    requires_human_approval: true,
    metadata: {
      paperclip_priority: task.priority ?? "medium",
      paperclip_labels: task.labels ?? [],
      paperclip_task_slug: taskSlug,
      ...task.metadata,
    },
  };
}

