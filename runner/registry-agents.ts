import { PolicyService } from "../lib/policy/service";

export interface RegistryAgent {
  id: string;
  name: string;
  description: string;
  allowed_task_types: string[];
}

export function loadRegistryAgents(repoRoot: string = process.cwd()): RegistryAgent[] {
  return new PolicyService(repoRoot).listAgents().map((agent) => ({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    allowed_task_types: agent.allowed_task_types,
  }));
}
