import type { IssueStatus, WorkScale } from "../organization/issue-lifecycle";

export type IssueCriticality = "low" | "medium" | "high";

export interface AuthorizedScope {
  expected_outcome: string;
  acceptance_criteria: string[];
  allowed_path_patterns: string[];
  excluded_path_patterns: string[];
  allowed_change_categories: string[];
  explicit_exclusions: string[];
}

export interface IssueClassificationInputs {
  affected_domains: string[];
  requires_migration: boolean;
  security_impact: boolean;
}

export interface ExternalIssueReference {
  provider: string;
  url: string;
  reference: string;
}

export interface ScopeChangeProposal {
  id: string;
  discovered_paths: string[];
  proposed_scope: AuthorizedScope;
  discovered_at: string;
  evidence_task_id: string;
}

export interface WorkIssue {
  schema_version: 1;
  id: string;
  project_id: string;
  objective_id: string | null;
  parent_issue_id: string | null;
  title: string;
  expected_outcome: string;
  acceptance_criteria: string[];
  status: IssueStatus;
  work_scale: WorkScale;
  classification_inputs: IssueClassificationInputs;
  classification_rationale: string[];
  plan: string[];
  authorized_scope: AuthorizedScope;
  scope_revision: number;
  scope_changed_at: string | null;
  scope_change_approval_id: string | null;
  scope_change_proposal: ScopeChangeProposal | null;
  priority: number;
  criticality: IssueCriticality;
  blocked_by_issue_ids: string[];
  assigned_role_id: string | null;
  related_commitment_ids: string[];
  external_references: ExternalIssueReference[];
  next_action: string | null;
  task_ids: string[];
  evidence_ids: string[];
  candidate_ids: string[];
  created_at: string;
  updated_at: string;
  revision: number;
}

export interface ReviewCandidate {
  schema_version: 1;
  id: string;
  issue_id: string;
  task_id: string;
  execution_id: string;
  repository_id: string;
  base_revision: string;
  candidate_revision: string;
  diff_fingerprint: string;
  changed_paths: string[];
  scope_revision: number;
  created_at: string;
  invalidated_at: string | null;
}

export type IssueEvidenceKind = "task" | "execution" | "commit" | "diff" | "verification" | "review" | "work-session" | "provider" | "usage" | "screenshot" | "work-product";

export interface IssueEvidenceReference {
  testing_evidence_fingerprint?: string;
  schema_version: 1;
  id: string;
  issue_id: string;
  task_id: string | null;
  execution_id: string | null;
  candidate_id: string | null;
  candidate_revision: string | null;
  diff_fingerprint: string | null;
  scope_revision: number | null;
  kind: IssueEvidenceKind;
  label: string;
  reference: string;
  status: "passed" | "failed" | "informational" | "gap";
  created_at: string;
}

export interface IssueAuditEvent {
  id: string;
  issue_id: string;
  type: string;
  at: string;
  scope_revision: number;
  payload: Record<string, unknown>;
}

export interface IssueDocument {
  schema_version: 1;
  issues: Record<string, WorkIssue>;
  candidates: Record<string, ReviewCandidate>;
  evidence: Record<string, IssueEvidenceReference>;
  events: IssueAuditEvent[];
}

export interface IssueCreateInput {
  project_id: string;
  objective_id?: string | null;
  parent_issue_id?: string | null;
  title: string;
  expected_outcome: string;
  acceptance_criteria: string[];
  authorized_scope: AuthorizedScope;
  classification_inputs?: Partial<IssueClassificationInputs>;
  plan?: string[];
  priority?: number;
  criticality?: IssueCriticality;
  blocked_by_issue_ids?: string[];
  assigned_role_id?: string | null;
  related_commitment_ids?: string[];
  external_references?: ExternalIssueReference[];
  next_action?: string | null;
}

export interface IssueLineage {
  issue: WorkIssue;
  tasks: Array<{
    task: import("../state/types").TaskRecord;
    executions: Array<{ run_id: string; attempt: number; events: import("../state/types").TaskEvent[] }>;
  }>;
  candidates: ReviewCandidate[];
  evidence: IssueEvidenceReference[];
  evidence_gaps: string[];
  sessions: import("../state/types").WorkSession[];
}
