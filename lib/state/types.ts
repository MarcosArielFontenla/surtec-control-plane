// Canonical TS mirror of schemas/task-envelope.schema.json
export type SandboxMode = "read-only" | "workspace-write";

export interface TaskEnvelope {
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
}

// Canonical TS mirror of schemas/agent-result.schema.json
export type AgentOutcome = "completed" | "partial" | "blocked" | "failed" | "needs-review";

export interface AgentResult {
  task_id: string;
  agent: string;
  status: AgentOutcome;
  summary: string;
  files_changed: string[];
  commands_run: string[];
  tests_run: string[];
  risks: string[];
  blockers: string[];
  next_steps: string[];
  artifacts: string[];
  logs_path: string;
}

export interface ReviewDecision {
  status: "approved" | "rejected";
  at: string;
  branch?: string;
  pushed?: boolean;
  pr_url?: string;
  error?: string;
}

export type Lifecycle = "queued" | "running" | "finished";

export interface TaskRecord {
  envelope: TaskEnvelope;
  lifecycle: Lifecycle;
  outcome: AgentOutcome | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
  result: AgentResult | null;
  logs_path: string | null;
  decision?: ReviewDecision | null;
}

export interface ProjectStatusOverride {
  id: string;
  health?: "ok" | "at-risk" | "blocked";
  note?: string;
}

export interface ProjectView {
  id: string;
  status: string;
  health: "ok" | "at-risk" | "blocked" | null;
  note: string | null;
  repo: string | null;
  last_activity: string | null;
  task_counts: { inProgress: number; finished: number };
}

export interface TaskView {
  id: string;
  project: string;
  agent: string;
  title: string;
  lifecycle: Lifecycle;
  outcome: AgentOutcome | null;
  updated_at: string;
  finished_at: string | null;
  requires_human_approval: boolean;
}

export interface AttentionItem {
  kind: "needs-review" | "awaiting-approval" | "risk" | "blocker";
  task_id: string;
  project: string;
  title: string;
}

export interface OverviewModel {
  projects: ProjectView[];
  inProgress: TaskView[];
  history: TaskView[];
  attention: AttentionItem[];
}
