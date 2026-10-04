import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { assertContextConfig, assertRoleRegistry, ContextContractError } from "../context/validation";
import type { AgentRole, ContextConfig, ExecutionBudget, ToolCapability } from "../context/types";
import type { PolicyAgent } from "./service";
import type { SandboxMode } from "../state/types";

export const ROLE_HANDOFF_CONTRACT_ID = "role-handoff-v1";

function readConfiguration(root: string, path: string): unknown {
  let current = root;
  try {
    if (lstatSync(root).isSymbolicLink()) throw new Error("linked root");
    for (const part of path.split("/")) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error("linked configuration");
    }
    const stat = lstatSync(current);
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("configuration size/type");
    return parse(readFileSync(current, "utf8"));
  } catch { throw new ContextContractError("Context configuration is missing, unsafe or unreadable"); }
}
export function readContextConfig(root: string): ContextConfig {
  const value = readConfiguration(root, "registry/context-policy.yml");
  assertContextConfig(value);
  return value;
}
export function readRoles(root: string, agents: PolicyAgent[]): AgentRole[] {
  const value = readConfiguration(root, "registry/agent-roles.yml");
  assertRoleRegistry(value);
  const config = readContextConfig(root);
  const known = new Set(agents.map((agent) => agent.id));
  for (const role of value.roles) {
    if (!role.agent_ids.every((id) => known.has(id))) throw new ContextContractError("Role references an unknown registered agent");
    if (!Object.hasOwn(config.budgets, role.default_budget_policy_id)) throw new ContextContractError("Role references an unknown budget policy");
    if (!role.handoff_contract_ids.every((id) => id === ROLE_HANDOFF_CONTRACT_ID)) throw new ContextContractError("Role references an unsupported handoff contract");
    for (const path of role.required_evaluation_ids) {
      const evidence = readConfiguration(root, path);
      const expectedId = path.split("/").at(-1)!.replace(/\.json$/, "");
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)
        || !Object.hasOwn(evidence, "schema_version") || !Object.hasOwn(evidence, "id")
        || (evidence as { id: unknown }).id !== expectedId
        || (evidence as { schema_version: unknown }).schema_version !== (path.startsWith("evals/v1/") ? 1 : 2)) {
        throw new ContextContractError("Required evaluation reference is invalid");
      }
    }
  }
  const ids = new Set(value.roles.map((role) => role.id));
  if (config.routes.some((route) => route.role_ids.some((id) => !ids.has(id))) || Object.keys(config.testing.roles).some((id) => !ids.has(id))) {
    throw new ContextContractError("Context policy references an unknown role");
  }
  return value.roles;
}
export function authorizeRoleSelection(role: AgentRole, input: {
  agent: PolicyAgent; sandbox: SandboxMode; taskKind: string; selfVerify: boolean;
}): ToolCapability[] {
  if (!role.agent_ids.includes(input.agent.id) || !role.allowed_task_kinds.includes(input.taskKind)) throw new ContextContractError("Role does not permit this agent or task kind");
  const generic = input.sandbox === "workspace-write" ? "implementation" : "analysis";
  if (input.taskKind !== generic && !input.agent.allowed_task_types.includes(input.taskKind)) throw new ContextContractError("Task kind exceeds registered agent policy");
  if (input.sandbox === "workspace-write" && role.sandbox_ceiling !== "workspace-write") throw new ContextContractError("Role does not permit workspace-write");
  if (input.selfVerify && (input.sandbox !== "workspace-write" || !role.allowed_tool_capabilities.includes("verify-configured"))) throw new ContextContractError("Role does not permit the requested verification mode");
  return input.sandbox === "read-only" ? ["inspect"] : role.allowed_tool_capabilities.filter((capability) => capability !== "verify-configured" || input.selfVerify);
}
export function restrictBudget(current: ExecutionBudget, role: ExecutionBudget): ExecutionBudget {
  return { max_attempts: Math.min(current.max_attempts, role.max_attempts), max_runtime_ms: Math.min(current.max_runtime_ms, role.max_runtime_ms), max_total_tokens: Math.min(current.max_total_tokens, role.max_total_tokens) };
}
