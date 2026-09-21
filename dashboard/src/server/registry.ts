import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import type { RegistryProject } from "../../../lib/state/derive";
import { discoverProjects, DEFAULT_IGNORE } from "../../../lib/discover";

interface RegistryDoc {
  projects?: Record<string, {
    repo?: string;
    status?: string;
    local_path?: string;
    allowed_agents?: string[];
    default_branch?: string;
    deploy_url?: string;
    railway?: { project_id?: string; service_id?: string; environment_id?: string };
  }>;
}

export function loadRegistryProjects(repoRoot: string = process.cwd()): RegistryProject[] {
  const raw = readFileSync(join(repoRoot, "registry", "projects.yml"), "utf8");
  const doc = (parse(raw) ?? {}) as RegistryDoc;
  const projects = doc.projects ?? {};
  const projectsRoot = process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
  const ignore = [
    ...DEFAULT_IGNORE,
    ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  ];
  const discoveredPaths = new Map(discoverProjects(projectsRoot, ignore).map((project) => [project.id, project.path]));
  return Object.entries(projects).map(([id, v]) => ({
    id,
    status: v?.status ?? "unknown",
    repo: v?.repo ?? null,
    allowed_agents: v?.allowed_agents ?? [],
    repo_path: discoveredPaths.get(id) ?? v?.local_path ?? null,
    default_branch: v?.default_branch ?? null,
    deploy_url: v?.deploy_url ?? null,
    railway: v?.railway?.project_id && v?.railway?.service_id && v?.railway?.environment_id
      ? { project_id: v.railway.project_id, service_id: v.railway.service_id, environment_id: v.railway.environment_id }
      : null,
  }));
}
