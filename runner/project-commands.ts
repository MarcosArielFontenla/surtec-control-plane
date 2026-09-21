import type { ProjectCommands } from "../lib/state/types";
import { PolicyService } from "../lib/policy/service";

// Returns the trusted registry `commands` map for a project (keys: dev/build/test/lint/install),
// keeping only non-empty string values. Never throws — any error yields {}.
export function loadProjectCommands(repoRoot: string, projectId: string): ProjectCommands {
  try {
    return new PolicyService(repoRoot).project(projectId).commands;
  } catch {
    return {};
  }
}
