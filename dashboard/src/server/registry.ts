import type { RegistryProject } from "../../../lib/state/derive";
import { PolicyService } from "../../../lib/policy/service";

export function loadRegistryProjects(repoRoot: string = process.cwd()): RegistryProject[] {
  return new PolicyService(repoRoot).listProjects().map((project) => ({
    id: project.id,
    status: project.status,
    repo: project.repo,
    allowed_agents: project.allowed_agents,
    repo_path: project.repo_path,
    default_branch: project.default_branch,
    deploy_url: project.deploy_url,
    railway: project.railway,
  }));
}
