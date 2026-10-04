export const CAPABILITIES = ["root_instructions", "registry", "routing", "skills", "specs", "decisions", "tasks", "workflows", "acceptance_checks", "done_gate", "evals", "handoffs", "policies", "telemetry", "validators", "doctor", "reconciliation", "ownership_manifest"] as const;
export type HarnessCapability = typeof CAPABILITIES[number];
export type HarnessStatus = "absent" | "healthy" | "partial" | "legacy" | "invalid" | "unknown";
export type Ownership = "scaffold-managed" | "surtec-generated" | "project-owned" | "user-owned" | "unknown";
export interface TestingPolicy {
  schema_version: 1;
  mode: "functional" | "strict-tdd";
  runner_id: string | null;
  requires_red_evidence: boolean;
  applicable_task_kinds: string[];
}
export interface HarnessExpectedEntry {
  path: string;
  capability: HarnessCapability;
  required: boolean;
  sha256: string;
}
export interface HarnessManifest {
  schema_version: 1;
  harness_version: string;
  source_id: string;
  format: "surtec-h1-h4";
  capabilities: Record<HarnessCapability, boolean>;
  expected_entries: HarnessExpectedEntry[];
}
export interface HarnessSourceRegistry {
  schema_version: 1;
  source: { id: string; root: string; manifest: string; manifest_sha256: string };
  runners: Record<string, { command: string }>;
  projects: Record<string, {
    ownership: { path: string; classification: Ownership; evidence: string }[];
    testing_policy: TestingPolicy;
    review_policy: "human-required" | "unknown";
    backup_ready: boolean;
    rollback_ready: boolean;
    validation: { fingerprint: string; status: "passed" | "failed"; observed_at: string } | null;
  }>;
}
export interface HarnessFinding {
  id: string;
  severity: "info" | "warning" | "critical";
  observed: string;
  why: string;
  evidence: string[];
  recommended_action: string;
  safely_automatable: boolean;
}
export interface ProjectHarnessProfile {
  schema_version: 1;
  project_id: string;
  status: HarnessStatus;
  detected_version: string | null;
  canonical_version: string | null;
  comparison: "compatible" | "drift" | "unknown";
  capability_results: { capability: HarnessCapability; expected: boolean; status: "present" | "missing" | "unknown"; evidence: string[] }[];
  drift_summary: string[];
  observed_at: string;
  source_fingerprint: string | null;
  project_fingerprint: string;
  doctor_status: "healthy" | "warning" | "invalid" | "unknown";
  findings: HarnessFinding[];
  entries: { path: string; status: "present" | "missing" | "unsafe"; ownership: Ownership; ownership_evidence: string | null }[];
  testing_policy: TestingPolicy;
  runner_command: string | null;
  review_policy: "human-required" | "unknown";
  backup_ready: boolean;
  rollback_ready: boolean;
  validation: { status: "passed" | "failed" | "unknown"; observed_at: string | null };
}
export interface HarnessProfilesDocument { schema_version: 1; profiles: Record<string, ProjectHarnessProfile> }
export interface HarnessSource {
  status: "trusted" | "unknown";
  manifest: HarnessManifest | null;
  registry: HarnessSourceRegistry | null;
  fingerprint: string | null;
  reason: string | null;
}
