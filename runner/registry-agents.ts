import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export interface RegistryAgent {
  id: string;
  name: string;
  description: string;
  allowed_task_types: string[];
}

interface AgentsDoc {
  agents?: Array<{
    id: string;
    name?: string;
    description?: string;
    allowed_task_types?: string[];
  }>;
}

export function loadRegistryAgents(repoRoot: string = process.cwd()): RegistryAgent[] {
  const raw = readFileSync(join(repoRoot, "registry", "agents.yml"), "utf8");
  const doc = (parse(raw) ?? {}) as AgentsDoc;
  return (doc.agents ?? []).map((a) => ({
    id: a.id,
    name: a.name ?? a.id,
    description: a.description ?? "",
    allowed_task_types: a.allowed_task_types ?? [],
  }));
}
