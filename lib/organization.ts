export type ObjectiveStatus = "draft" | "active" | "paused" | "achieved" | "cancelled";
export type ObjectiveHorizon = "now" | "quarter" | "year" | "ongoing";

export interface CompanyProfile {
  schema_version: 1;
  id: "surtec";
  display_name: string;
  mission: string | null;
  operating_principles: string[];
  active_objective_ids: string[];
  last_reviewed_at: string | null;
}

export interface Objective {
  schema_version: 1;
  id: string;
  company_id: "surtec";
  title: string;
  desired_outcome: string;
  success_criteria: string[];
  status: ObjectiveStatus;
  horizon: ObjectiveHorizon;
  priority: number;
  target_date: string | null;
  parent_objective_id: string | null;
  project_ids: string[];
  owner: "marcos";
  last_reviewed_at: string | null;
}

export interface ProjectObjectiveLinks {
  objective_ids: string[];
  primary_objective_id: string | null;
}

export interface OrganizationDocument {
  schema_version: 1;
  company: CompanyProfile;
  objectives: Record<string, Omit<Objective, "project_ids">>;
  project_objectives: Record<string, ProjectObjectiveLinks>;
}

export interface OrganizationSnapshot {
  company: CompanyProfile;
  objectives: Objective[];
  project_objectives: Record<string, ProjectObjectiveLinks>;
}

export const MAX_OBJECTIVE_DEPTH = 8;
