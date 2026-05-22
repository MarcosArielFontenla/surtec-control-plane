export type SandboxMode = "read-only" | "workspace-write";

export type PaperclipTask = {
  id: string;
  projectId: string;
  title: string;
  body: string;
  labels?: string[];
  assignee?: string;
  repoPath?: string;
  branch?: string;
  priority?: "low" | "medium" | "high";
  metadata?: Record<string, unknown>;
};

export type TaskEnvelope = {
  id: string;
  source: string;
  project: string;
  task_type: string;
  agent: string;
  title: string;
  instructions: string;
  repo_path: string;
  branch: string;
  sandbox: SandboxMode;
  expected_outputs: string[];
  requires_human_approval: boolean;
  metadata: Record<string, unknown>;
};

export type AgentResult = {
  task_id: string;
  agent: string;
  status: "completed" | "partial" | "blocked" | "failed" | "needs-review";
  summary: string;
  files_changed: string[];
  commands_run: string[];
  tests_run: string[];
  risks: string[];
  blockers: string[];
  next_steps: string[];
  artifacts: string[];
  logs_path: string;
};

