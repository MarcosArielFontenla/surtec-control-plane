import type { HarnessFinding, ProjectHarnessProfile } from "./types";

export function finding(id: string, observed: string, evidence: string[], why: string, action: string, severity: HarnessFinding["severity"] = "warning"): HarnessFinding {
  return { id, severity, observed, evidence: evidence.slice(0, 8), why, recommended_action: action, safely_automatable: false };
}
export function doctorStatus(profile: Pick<ProjectHarnessProfile, "findings" | "status" | "comparison">): ProjectHarnessProfile["doctor_status"] {
  if (profile.status === "invalid") return "invalid";
  if (profile.findings.some((entry) => entry.severity !== "info")) return "warning";
  if (profile.status === "unknown" || profile.comparison === "unknown") return "unknown";
  return "healthy";
}
