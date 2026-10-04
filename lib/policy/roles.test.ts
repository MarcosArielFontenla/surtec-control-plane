import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { PolicyService } from "./service";
import { authorizeRoleSelection, readContextConfig, readRoles, restrictBudget, ROLE_HANDOFF_CONTRACT_ID } from "./roles";
import type { AgentRoleRegistry, ContextConfig } from "../context/types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): { root: string; policy: PolicyService } {
  const root = mkdtempSync(join(tmpdir(), "surtec-context-roles-")); roots.push(root);
  mkdirSync(join(root, "registry"));
  for (const file of ["agents.yml", "agent-roles.yml", "context-policy.yml"]) copyFileSync(join("registry", file), join(root, "registry", file));
  const registry = parse(readFileSync("registry/agent-roles.yml", "utf8")) as AgentRoleRegistry;
  for (const path of new Set(registry.roles.flatMap((role) => role.required_evaluation_ids))) {
    mkdirSync(join(root, ...path.split("/").slice(0, -1)), { recursive: true }); copyFileSync(path, join(root, path));
  }
  mkdirSync(join(root, "projects", "synthetic", ".git"), { recursive: true });
  writeFileSync(join(root, "registry/projects.yml"), "projects:\n  synthetic:\n    allowed_agents: [tech-lead, backend-engineer, product-manager]\n    sandbox: { default: workspace-write }\n    verify: [node verify.mjs]\n");
  return { root, policy: new PolicyService(root, { environment: { SURTEC_PROJECTS_ROOT: join(root, "projects") } }) };
}
describe("logical role restrictions", () => {
  it("declares only the supported data handoff without adding adapters, tools or execution authority", () => {
    const { root, policy } = fixture();
    const current = policy.listRoles();
    expect(current.every((role) => role.handoff_contract_ids.length === 1 && role.handoff_contract_ids[0] === ROLE_HANDOFF_CONTRACT_ID)).toBe(true);
    expect(current.every((role) => role.minimum_review_depth === "focused")).toBe(true);
    const registry = parse(readFileSync(join(root, "registry/agent-roles.yml"), "utf8")) as AgentRoleRegistry;
    for (const role of registry.roles) role.handoff_contract_ids = [];
    writeFileSync(join(root, "registry/agent-roles.yml"), JSON.stringify(registry));
    expect(policy.listRoles()).toEqual(current.map((role) => ({ ...role, handoff_contract_ids: [] })));
    expect(policy.authorizeRole({ project: "synthetic", agent: "tech-lead", roleId: "planner", taskKind: "analysis", sandbox: "read-only", selfVerify: false }).tools).toEqual(["inspect"]);
  });
  it.each(["role-handoff-v2", "constructor", "auto-dispatch", "publish"])("denies unsupported handoff reference %s without repairing registry bytes", (reference) => {
    const { root, policy } = fixture();
    const registry = parse(readFileSync(join(root, "registry/agent-roles.yml"), "utf8")) as AgentRoleRegistry;
    registry.roles[0]!.handoff_contract_ids = [reference];
    const path = join(root, "registry/agent-roles.yml"), bytes = JSON.stringify(registry);
    writeFileSync(path, bytes);
    expect(() => policy.listRoles()).toThrow(/unsupported handoff/); expect(readFileSync(path, "utf8")).toBe(bytes);
  });
  it("loads six actual evaluation-backed profiles without changing existing agent policy", () => {
    const { policy } = fixture();
    const before = policy.listAgents(); expect(policy.listRoles()).toHaveLength(6); expect(policy.listAgents()).toEqual(before);
    expect(policy.listRoles().every((role) => role.display_name.endsWith("(Codex profile)"))).toBe(true);
  });
  it("intersects role write ceiling with a write-capable registered agent", () => {
    const { policy } = fixture();
    expect(() => policy.authorizeRole({ project: "synthetic", agent: "tech-lead", roleId: "planner", taskKind: "implementation", sandbox: "workspace-write", selfVerify: false })).toThrow();
    expect(policy.authorizeRole({ project: "synthetic", agent: "tech-lead", roleId: "planner", taskKind: "analysis", sandbox: "read-only", selfVerify: false }).tools).toEqual(["inspect"]);
    expect(policy.authorizeRole({ project: "synthetic", agent: "backend-engineer", roleId: "software-engineer", taskKind: "implementation", sandbox: "workspace-write", selfVerify: true }).tools).toEqual(["inspect", "edit-authorized-scope", "verify-configured"]);
  });
  it("does not grant candidate adapter availability or tool authority through the profile", () => {
    const { policy } = fixture();
    expect(() => policy.authorizeRole({ project: "synthetic", agent: "frontend-engineer", roleId: "software-engineer", taskKind: "implementation", sandbox: "workspace-write", selfVerify: false })).toThrow(/not allowed/);
    expect(() => policy.authorizeRole({ project: "synthetic", agent: "backend-engineer", roleId: "software-engineer", taskKind: "frontend-implementation", sandbox: "workspace-write", selfVerify: false })).toThrow(/registered agent/);
  });
  it("denies a write even when the logical role permits it if project policy does not", () => {
    const { root, policy } = fixture();
    writeFileSync(join(root, "registry/projects.yml"), "projects:\n  synthetic:\n    allowed_agents: [backend-engineer]\n    sandbox: { default: read-only }\n");
    expect(() => policy.authorizeRole({ project: "synthetic", agent: "backend-engineer", roleId: "software-engineer", taskKind: "implementation", sandbox: "workspace-write", selfVerify: false })).toThrow(/project/);
  });
  it("does not interpret inherited role or budget identities as real entries", () => {
    const { root, policy } = fixture();
    expect(() => policy.authorizeRole({ project: "synthetic", agent: "backend-engineer", roleId: "constructor", taskKind: "analysis", sandbox: "read-only", selfVerify: false })).toThrow(/Unknown/);
    const registry = parse(readFileSync(join(root, "registry/agent-roles.yml"), "utf8")) as AgentRoleRegistry;
    registry.roles[0]!.default_budget_policy_id = "constructor";
    writeFileSync(join(root, "registry/agent-roles.yml"), JSON.stringify(registry));
    expect(() => readRoles(root, policy.listAgents())).toThrow(/budget/);
  });
  it("fails closed on missing or invalid required evaluation and unknown agents", () => {
    const { root, policy } = fixture();
    writeFileSync(join(root, "evals/v2/cases/implementation-plan.json"), JSON.stringify({ id: "wrong", schema_version: 2 }));
    expect(() => policy.listRoles()).toThrow(/evaluation/);
    const registry = parse(readFileSync(join(root, "registry/agent-roles.yml"), "utf8")) as AgentRoleRegistry;
    registry.roles[0]!.agent_ids = ["not-registered"];
    writeFileSync(join(root, "registry/agent-roles.yml"), JSON.stringify(registry));
    expect(() => policy.listRoles()).toThrow(/unknown registered/);
  });
  it("rejects malformed or oversized config instead of permissive defaults", () => {
    const { root } = fixture();
    writeFileSync(join(root, "registry/context-policy.yml"), "not: [valid");
    expect(() => readContextConfig(root)).toThrow();
    writeFileSync(join(root, "registry/context-policy.yml"), "x".repeat(256 * 1024 + 1));
    expect(() => readContextConfig(root)).toThrow(/unsafe/);
  });
  it("only tightens existing persisted execution budget ceilings", () => {
    expect(restrictBudget({ max_attempts: 1, max_runtime_ms: 100, max_total_tokens: 90 }, { max_attempts: 3, max_runtime_ms: 50, max_total_tokens: 100 })).toEqual({ max_attempts: 1, max_runtime_ms: 50, max_total_tokens: 90 });
  });
  it("rejects verification tools for read-only selections even with a write-capable profile", () => {
    const { policy } = fixture(); const role = policy.listRoles().find((entry) => entry.id === "software-engineer")!;
    expect(() => authorizeRoleSelection(role, { agent: policy.agent("backend-engineer"), taskKind: "analysis", sandbox: "read-only", selfVerify: true })).toThrow(/verification/);
  });
  it("validates configured role references even before routing execution", () => {
    const { root, policy } = fixture();
    const config = readContextConfig(root) as ContextConfig;
    config.routes.push({ id: "missing-role", role_ids: ["not-a-role"], task_kinds: [], affected_domains: [], paths: ["docs/guide.md"], required: true });
    writeFileSync(join(root, "registry/context-policy.yml"), JSON.stringify(config));
    expect(() => policy.listRoles()).toThrow(/unknown role/);
  });
});
