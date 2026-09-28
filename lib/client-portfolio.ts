export type ClientStatus = "active" | "paused";
export type ClientCriticality = "low" | "medium" | "high";
export type CommitmentState = "planned" | "in-progress" | "blocked" | "completed" | "cancelled";

export interface ClientRecord {
  id: string;
  display_name: string;
  status: ClientStatus;
  criticality: ClientCriticality;
  sla_note: string | null;
  next_review_date: string | null;
  confidential_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientCommitment {
  id: string;
  project_id: string;
  client_id: string | null;
  title: string;
  expected_outcome: string;
  due_date: string | null;
  priority: number;
  criticality: ClientCriticality;
  state: CommitmentState;
  issue_numbers: number[];
  pull_request_numbers: number[];
  task_ids: string[];
  session_ids: string[];
  next_action: string;
  created_at: string;
  updated_at: string;
}

export interface ClientPortfolioDocument {
  schema_version: 1;
  clients: Record<string, ClientRecord>;
  commitments: Record<string, ClientCommitment>;
}

export interface ClientSummary {
  id: string;
  display_name: string;
  status: ClientStatus;
  criticality: ClientCriticality;
  project_ids: string[];
  next_review_date: string | null;
  active_commitment_count: number;
}

export type ClientInput = Omit<ClientRecord, "id" | "created_at" | "updated_at">;
export type ClientCommitmentInput = Omit<ClientCommitment, "id" | "created_at" | "updated_at">;

export type ClientContextCategory =
  | "client-identity"
  | "project-outcome"
  | "active-commitments"
  | "service-context"
  | "confidential-notes";

export interface ClientContextOptions {
  available: boolean;
  categories: ClientContextCategory[];
}

export interface ClientContextShareAudit {
  client_id: string;
  categories: ClientContextCategory[];
  shared_at: string;
}

export function emptyClientPortfolio(): ClientPortfolioDocument {
  return { schema_version: 1, clients: {}, commitments: {} };
}
