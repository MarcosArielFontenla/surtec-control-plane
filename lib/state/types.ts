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
  self_verify?: boolean;
}

// Canonical TS mirror of schemas/agent-result.schema.json
export type AgentOutcome = "completed" | "partial" | "blocked" | "failed" | "needs-review" | "cancelled";

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
  verification?: VerificationReport | null;
}

export interface VerificationCheck {
  command: string;
  ok: boolean;
  output_tail: string; // last ~4000 chars of combined stdout+stderr (full output goes to the jsonl log)
}

export interface VerificationReport {
  status: "passed" | "failed" | "skipped";
  checks: VerificationCheck[];
}

export interface ReviewDecision {
  status: "approving" | "approved" | "rejecting" | "rejected";
  at: string;
  attempts?: number;
  branch?: string;
  pushed?: boolean;
  pr_url?: string;
  cleanup_completed?: boolean;
  error?: string;
}

export type Lifecycle = "queued" | "running" | "finished";

export interface TaskLease {
  run_id: string;
  worker_id: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

export type TaskFailureKind = "transient" | "terminal" | "cancelled" | "budget";

export interface TaskFailure {
  kind: TaskFailureKind;
  message: string;
  at: string;
  run_id: string;
}

export interface TaskOrchestration {
  attempts: number;
  max_attempts: number;
  max_runtime_ms: number;
  max_total_tokens: number;
  cumulative_tokens: number;
  retry_at: string | null;
  cancel_requested_at: string | null;
  lease: TaskLease | null;
  last_failure: TaskFailure | null;
}

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
  revision?: number;
  orchestration?: TaskOrchestration;
}

export type TaskEventType =
  | "queued"
  | "claimed"
  | "started"
  | "thread-started"
  | "turn-started"
  | "usage"
  | "cancel-requested"
  | "cancelled"
  | "retry-scheduled"
  | "lease-recovered"
  | "completed"
  | "failed"
  | "needs-review"
  | "warning";

export interface TaskEvent {
  event_id: string;
  task_id: string;
  type: TaskEventType;
  at: string;
  revision: number;
  run_id: string | null;
  attempt: number | null;
  payload: Record<string, unknown>;
}

export interface ProjectStatusOverride {
  id: string;
  health?: "ok" | "at-risk" | "blocked";
  note?: string;
}

export interface GitStatus {
  branch: string | null;
  dirty: boolean;
  uncommitted: number;
  ahead: number;
  behind: number;
  last_commit: { hash: string; subject: string; at: string } | null;
  ok: boolean;
}

export interface ProjectView {
  id: string;
  status: string;
  health: "ok" | "at-risk" | "blocked" | null;
  note: string | null;
  repo: string | null;
  path: string | null;
  configured: boolean;
  git: GitStatus | null;
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
  verification?: VerificationReport["status"] | null;
}

export interface OverviewModel {
  projects: ProjectView[];
  inProgress: TaskView[];
  history: TaskView[];
  attention: AttentionItem[];
}

// --- Process runs (B.2 "Procesos") ---
export type RunKind = "dev" | "oneshot";
export type RunStatus = "running" | "exited" | "failed" | "stopped";

export interface RunRecord {
  runId: string;
  projectId: string;
  kind: RunKind;
  command: string;
  status: RunStatus;
  pid: number | null;
  startedAt: string; // ISO
  endedAt: string | null;
  exitCode: number | null;
}

export type RunEvent =
  | { type: "snapshot"; record: RunRecord; log: string }
  | { type: "chunk"; data: string }
  | { type: "status"; record: RunRecord };

export interface ProjectCommands {
  dev?: string;
  build?: string;
  test?: string;
  lint?: string;
  install?: string;
}

// --- D.2 cross-project GitHub-issue inbox ---
export interface IssueItem {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  labels: string[];
  author: string | null;
}
export interface RepoStatus { id: string; slug: string; ok: boolean; error?: string }
export type InboxItem = IssueItem & { projectId: string; slug: string };
export interface Inbox { items: InboxItem[]; repos: RepoStatus[] }

// --- D.3 cross-project activity feed ---
export interface CommitActivity { kind: "commit"; at: string; project: string; hash: string; subject: string; author: string }
export interface TaskActivity { kind: "task"; at: string; project: string; taskId: string; agent: string; title: string; state: string }
export type ActivityItem = CommitActivity | TaskActivity;
export interface ActivityFeed { items: ActivityItem[] }

// --- C.1 deploy health-check ---
export type DeployState = "up" | "degraded" | "down";
export interface DeployHealth {
  configured: boolean;
  url: string | null;
  state: DeployState | null;
  status: number | null;
  ms: number | null;
  error?: string;
}

// --- C.2 Railway deploy status ---
export type RailwayState = "success" | "building" | "deploying" | "failed" | "crashed" | "removed" | "sleeping" | "skipped" | "waiting" | "queued" | "unknown";
export interface RailwayStatus {
  configured: boolean;
  ok: boolean;
  state: RailwayState | null;
  at: string | null;
  url: string | null;
  error?: string;
}
