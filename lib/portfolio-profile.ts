export type ProjectKind = "personal" | "client";
export type ProjectLifecycle = "idea" | "discovery" | "active" | "maintenance" | "paused" | "archived";
export type Criticality = "low" | "medium" | "high";

export interface ProjectProfile {
  schema_version: 1;
  project_id: string;
  kind: ProjectKind;
  lifecycle: ProjectLifecycle;
  priority: number;
  criticality: Criticality;
  current_goal: string | null;
  next_action: string | null;
  deadline: string | null;
  client_id: string | null;
  last_reviewed_at: string | null;
  tags: string[];
}

export interface PortfolioProfilesDocument {
  schema_version: 1;
  projects: Record<string, ProjectProfile>;
}

export function emptyProjectProfile(projectId: string): ProjectProfile {
  return {
    schema_version: 1,
    project_id: projectId,
    kind: "personal",
    lifecycle: "active",
    priority: 3,
    criticality: "medium",
    current_goal: null,
    next_action: null,
    deadline: null,
    client_id: null,
    last_reviewed_at: null,
    tags: [],
  };
}
