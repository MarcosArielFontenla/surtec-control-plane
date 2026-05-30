import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { ProjectConfig } from "../../../lib/portfolio";

interface RegistryDoc {
  projects?: Record<string, {
    repo?: string;
    status?: string;
    allowed_agents?: string[];
    default_branch?: string;
  }>;
}

// Indexes registry/projects.yml entries by id as ProjectConfig overlays. Never throws.
export function loadProjectConfig(repoRoot: string): Map<string, ProjectConfig> {
  let doc: RegistryDoc;
  try {
    doc = (parse(readFileSync(join(repoRoot, "registry", "projects.yml"), "utf8")) ?? {}) as RegistryDoc;
  } catch {
    return new Map();
  }
  const out = new Map<string, ProjectConfig>();
  for (const [id, v] of Object.entries(doc.projects ?? {})) {
    out.set(id, {
      id,
      status: v?.status,
      repo: v?.repo ?? null,
      allowed_agents: v?.allowed_agents ?? [],
      default_branch: v?.default_branch ?? null,
    });
  }
  return out;
}
