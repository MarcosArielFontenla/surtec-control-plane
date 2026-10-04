import Ajv2020 from "ajv/dist/2020.js";
import rolesSchema from "../../schemas/agent-role-registry.schema.json";
import configSchema from "../../schemas/context-config.schema.json";
import manifestSchema from "../../schemas/context-manifest.schema.json";
import { CONTEXT_LAYERS, type AgentRoleRegistry, type ContextConfig, type ContextManifest } from "./types";

export class ContextContractError extends Error {
  constructor(message: string) { super(message); this.name = "ContextContractError"; }
}
const ajv = new Ajv2020({ strict: true, allErrors: true });
const roles = ajv.compile(rolesSchema);
const config = ajv.compile(configSchema);
const manifest = ajv.compile(manifestSchema);
function invariant(ok: boolean, message: string): void { if (!ok) throw new ContextContractError(message); }
function unique(values: string[], label: string): void { invariant(new Set(values).size === values.length, `${label} contains duplicate identities`); }
export function safeContextPath(path: string): boolean {
  return path.length > 0 && path.length <= 240 && !/[\\:\x00-\x1f]/.test(path)
    && !path.startsWith("/") && path.split("/").every((part) => !!part && part !== "." && part !== "..")
    && !/(^|\/)(?:\.git|\.codex|\.aws|state|node_modules|\.env(?:\.[^/]*)?|credentials?|auth(?:\.[^/]*)?|secrets?|[^/]*\.pem)(\/|$)/i.test(path);
}
export function assertRoleRegistry(value: unknown): asserts value is AgentRoleRegistry {
  invariant(roles(value), "Invalid or unsupported role registry");
  const document = value as AgentRoleRegistry;
  unique(document.roles.map((role) => role.id), "roles");
  for (const role of document.roles) {
    invariant(role.allowed_tool_capabilities.includes("inspect"), "Role requires inspection capability");
    invariant(role.sandbox_ceiling !== "read-only" || role.allowed_tool_capabilities.every((tool) => tool === "inspect"), "Read-only role cannot grant write or command capability");
    invariant(!role.allowed_tool_capabilities.includes("verify-configured") || role.allowed_tool_capabilities.includes("edit-authorized-scope"), "Verification requires the supported write/verify mode");
    invariant(role.sandbox_ceiling !== "workspace-write" || role.allowed_tool_capabilities.includes("edit-authorized-scope"), "Write ceiling requires supported edit capability");
    invariant(role.required_evaluation_ids.every((path) => safeContextPath(path) && /^evals\/v[12]\/cases\/[A-Za-z0-9._-]+\.json$/.test(path)), "Invalid evaluation reference");
  }
}
export function assertContextConfig(value: unknown): asserts value is ContextConfig {
  invariant(config(value), "Invalid or unsupported context configuration");
  const document = value as ContextConfig;
  invariant(Object.keys(document.budgets).length > 0, "At least one budget is required");
  unique(document.routes.map((route) => route.id), "routes");
  invariant(document.routes.every((route) => route.paths.every(safeContextPath)), "Unsafe configured context path");
  for (const runner of Object.values(document.runners)) {
    if (runner.probe) {
      invariant(runner.probe.sources.every((entry) => safeContextPath(entry.path)), "Unsafe assertion probe path");
      unique(runner.probe.sources.map((entry) => entry.path), "probe sources");
    }
  }
  if (document.testing.no_refactor_justification !== undefined) invariant(document.testing.no_refactor_justification.trim().length > 0, "Empty no-refactor justification");
  for (const constraint of [document.testing.global, ...Object.values(document.testing.archetypes), ...Object.values(document.testing.projects), ...Object.values(document.testing.issues), ...Object.values(document.testing.roles)]) {
    invariant(constraint.runner_ids.every((id) => Object.hasOwn(document.runners, id)), "Unknown testing runner");
    if (constraint.mode === "strict-tdd") {
      const stages = constraint.runner_ids.map((id) => document.runners[id]!.stage);
      invariant(stages.includes("red") && stages.includes("green"), "Strict TDD requires configured RED and GREEN runners");
    }
  }
}
export function assertContextManifest(value: unknown): asserts value is ContextManifest {
  invariant(manifest(value), "Invalid or unsupported context manifest");
  const document = value as ContextManifest;
  unique(document.sources.map((source) => source.id), "sources");
  invariant(document.sources.length <= document.limits.max_sources && document.total_bytes <= document.limits.max_bytes && document.total_lines <= document.limits.max_lines, "Context budget exceeded");
  invariant(document.sources.reduce((sum, source) => sum + source.bytes, 0) <= document.total_bytes && document.sources.reduce((sum, source) => sum + source.lines, 0) <= document.total_lines, "Invalid context accounting");
  invariant(document.selected_categories.every((category) => !document.excluded_categories.includes(category)), "Contradictory context consent");
  invariant(document.sources.every((source, index) => index === 0 || CONTEXT_LAYERS.indexOf(source.layer) >= CONTEXT_LAYERS.indexOf(document.sources[index - 1]!.layer)), "Invalid context precedence");
  invariant(document.sandbox !== "read-only" || document.tools.every((tool) => tool === "inspect"), "Manifest exceeds read-only capability");
  invariant(document.testing.requires_red_evidence === (document.testing.mode === "strict-tdd"), "Testing evidence policy mismatch");
}
