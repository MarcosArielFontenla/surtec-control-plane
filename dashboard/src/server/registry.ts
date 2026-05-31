import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { RegistryProject } from "../../../lib/state/derive";

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
  return Object.entries(projects).map(([id, v]) => ({
    id,
    status: v?.status ?? "unknown",
    repo: v?.repo ?? null,
    allowed_agents: v?.allowed_agents ?? [],
    repo_path: v?.local_path ?? null,
    default_branch: v?.default_branch ?? null,
    deploy_url: v?.deploy_url ?? null,
    railway: v?.railway?.project_id && v?.railway?.service_id && v?.railway?.environment_id
      ? { project_id: v.railway.project_id, service_id: v.railway.service_id, environment_id: v.railway.environment_id }
      : null,
  }));
}
