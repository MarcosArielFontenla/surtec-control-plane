import type { DiscoveredProject } from "./discover";
import type { GitStatus } from "./state/types";

export interface ProjectConfig {
  id: string;
  status?: string;
  repo?: string | null;
  allowed_agents?: string[];
  default_branch?: string | null;
}

export interface PortfolioProject {
  id: string;
  path: string | null;
  status: string;
  repo: string | null;
  allowed_agents?: string[];
  default_branch?: string | null;
  configured: boolean;
  git: GitStatus | null;
}

// Discovery drives the list; the registry config overlays by id. Config entries
// with no discovered folder are dropped (v1). Sorted by id.
export function assemblePortfolio(
  discovered: DiscoveredProject[],
  statusByPath: Map<string, GitStatus>,
  config: Map<string, ProjectConfig>,
): PortfolioProject[] {
  return discovered
    .map((d) => {
      const cfg = config.get(d.id);
      const configured = !!(cfg?.allowed_agents && cfg.allowed_agents.length > 0);
      return {
        id: d.id,
        path: d.path,
        status: cfg?.status ?? "discovered",
        repo: cfg?.repo ?? null,
        allowed_agents: cfg?.allowed_agents,
        default_branch: cfg?.default_branch ?? null,
        configured,
        git: statusByPath.get(d.path) ?? null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
