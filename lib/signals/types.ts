export type SignalSeverity = "info" | "warning" | "critical";
export type SignalState = "open" | "acknowledged" | "snoozed" | "resolved";
export type SignalSource = "git" | "github" | "ci" | "deployment" | "issue" | "task" | "profile" | "note" | "session";

export type SignalRankingTier =
  | "production-failure"
  | "client-commitment"
  | "blocked-work"
  | "imminent-deadline"
  | "unfinished-work"
  | "maintenance"
  | "hygiene";

export interface Signal {
  schema_version: 1;
  id: string;
  project_id: string;
  project_kind: "personal" | "client" | null;
  source: SignalSource;
  type: string;
  severity: SignalSeverity;
  title: string;
  reason: string;
  evidence_at: string;
  observed_at: string;
  suggested_action: string;
  action_kind: string;
  ranking: { tier: SignalRankingTier; order: number };
  state: SignalState;
  snoozed_until: string | null;
  evidence: Record<string, unknown>;
}

export interface SignalFeed {
  schema_version: 1;
  observed_at: string;
  signals: Signal[];
  pinned_signal_ids: string[];
  warnings: string[];
}

export interface SignalHumanRecord {
  state: SignalState;
  snoozed_until: string | null;
  pinned_for: string | null;
  dismissed: boolean;
  updated_at: string;
}

export interface SignalHumanStateDocument {
  schema_version: 1;
  records: Record<string, SignalHumanRecord>;
}

export type SignalAction =
  | { action: "acknowledge" }
  | { action: "snooze"; until: string }
  | { action: "pin-for-today" }
  | { action: "dismiss" }
  | { action: "resolve" };
