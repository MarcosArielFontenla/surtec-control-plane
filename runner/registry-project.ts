import { PolicyService } from "../lib/policy/service";

// Resolves the verification command list for a project from the registry (trusted config).
// Never throws — any error (missing file, parse error, unknown project) yields [].
export function loadProjectVerifyCommands(repoRoot: string, projectId: string): string[] {
  try {
    return new PolicyService(repoRoot).project(projectId).verify_commands;
  } catch {
    return [];
  }
}
