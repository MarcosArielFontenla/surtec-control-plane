import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { RegistryProject } from "../../../lib/state/derive";

interface RegistryDoc {
  projects?: Record<string, { repo?: string; status?: string }>;
}

export function loadRegistryProjects(repoRoot: string = process.cwd()): RegistryProject[] {
  const raw = readFileSync(join(repoRoot, "registry", "projects.yml"), "utf8");
  const doc = (parse(raw) ?? {}) as RegistryDoc;
  const projects = doc.projects ?? {};
  return Object.entries(projects).map(([id, v]) => ({
    id,
    status: v?.status ?? "unknown",
    repo: v?.repo ?? null,
  }));
}
