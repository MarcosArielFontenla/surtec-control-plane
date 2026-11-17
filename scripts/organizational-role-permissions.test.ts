import { throws } from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { PolicyError, PolicyService } from "../lib/policy/service";
import { createRolePolicyFixture, roleFixtureAgent, roleFixtureProject, roleFixtureRole } from "./testing/role-policy-fixture";

type Fixture = ReturnType<typeof createRolePolicyFixture>;
type Selection = Parameters<PolicyService["authorizeRole"]>[0];
const verificationCommand = "node verify-fixture.mjs";
const writeSelection: Selection = {
  project: roleFixtureProject,
  agent: roleFixtureAgent,
  roleId: roleFixtureRole,
  taskKind: "implementation",
  sandbox: "workspace-write",
  selfVerify: true,
};

function withFixture(check: (fixture: Fixture, policy: PolicyService) => void) {
  const fixture = createRolePolicyFixture({ sandbox: "workspace-write", verify: [verificationCommand] });
  try {
    const policy = new PolicyService(fixture.root, { environment: fixture.environment });
    expect(policy.project(roleFixtureProject)).toMatchObject({
      repo_path: fixture.checkout, allowed_agents: [roleFixtureAgent],
      sandbox: "workspace-write", verify_commands: [verificationCommand],
    });
    expect(policy.agent(roleFixtureAgent).default_sandbox).toBe("workspace-write");
    expect(policy.listRoles().find((role) => role.id === roleFixtureRole)).toMatchObject({
      agent_ids: expect.arrayContaining([roleFixtureAgent]),
      allowed_task_kinds: expect.arrayContaining(["analysis", "implementation"]),
      sandbox_ceiling: "workspace-write",
      allowed_tool_capabilities: ["inspect", "edit-authorized-scope", "verify-configured"],
    });
    check(fixture, policy);
  } finally {
    fixture.dispose();
  }
}

function observeDecision(fixture: Fixture, check: () => void) {
  const registry = join(fixture.root, "registry");
  const bytes = new Map(readdirSync(registry).map((name) => {
    const path = join(registry, name);
    return [path, readFileSync(path)] as const;
  }));
  const inventory = readdirSync(fixture.root, { recursive: true }).sort();
  expect(existsSync(fixture.state)).toBe(false);
  try {
    check();
  } finally {
    expect(readdirSync(fixture.root, { recursive: true }).sort()).toEqual(inventory);
    for (const [path, before] of bytes) expect(readFileSync(path)).toEqual(before);
    expect(existsSync(fixture.state)).toBe(false);
  }
}

function expectDenial(
  fixture: Fixture, policy: PolicyService, selection: Selection, reason: string, code: "denied" | "configuration" = "denied",
) {
  observeDecision(fixture, () => {
    throws(() => policy.authorizeRole(selection),
      (error: unknown) => error instanceof PolicyError && error.code === code && error.message === reason);
  });
}

describe("org.role.permission-ceilings", () => {
  it("grants the exact write and verification tools where the project and agent allow them", () => {
    withFixture((fixture, policy) => {
      observeDecision(fixture, () => {
        expect(policy.authorizeRole(writeSelection)).toMatchObject({
          project: { id: roleFixtureProject, verify_commands: [verificationCommand] },
          agent: { id: roleFixtureAgent },
          role: { id: roleFixtureRole },
          tools: ["inspect", "edit-authorized-scope", "verify-configured"],
        });
      });
    });
  });

  it("limits a write-capable role to inspection for a read-only request", () => {
    withFixture((fixture, policy) => {
      observeDecision(fixture, () => {
        expect(policy.authorizeRole({
          ...writeSelection, taskKind: "analysis", sandbox: "read-only", selfVerify: false,
        })).toMatchObject({ role: { id: roleFixtureRole }, tools: ["inspect"] });
      });
    });
  });

  it("denies workspace-write when the project is read-only", () => {
    withFixture((fixture, policy) => {
      fixture.writeProjectPolicy("read-only", [verificationCommand]);
      expectDenial(fixture, policy, writeSelection, `project '${roleFixtureProject}' does not allow workspace-write`);
    });
  });

  it("denies self-verification when the project has no verification commands", () => {
    withFixture((fixture, policy) => {
      fixture.writeProjectPolicy("workspace-write");
      expectDenial(fixture, policy, writeSelection, `project '${roleFixtureProject}' has no verification commands`);
    });
  });

  it("denies workspace-write when the global agent policy is read-only", () => {
    withFixture((fixture, policy) => {
      const agents = policy.listAgents().map((agent) => agent.id === roleFixtureAgent
        ? { ...agent, default_sandbox: "read-only" } : agent);
      writeFileSync(fixture.agentsPath, stringify({ agents }));
      expectDenial(fixture, policy, writeSelection, `agent '${roleFixtureAgent}' does not allow workspace-write`);
    });
  });

  it("denies a task kind permitted by the role that exceeds the global agent policy", () => {
    withFixture((fixture, policy) => {
      const taskKind = "frontend-implementation";
      expect(policy.listRoles().find((role) => role.id === roleFixtureRole)?.allowed_task_kinds).toContain(taskKind);
      expect(policy.agent(roleFixtureAgent).allowed_task_types).not.toContain(taskKind);
      expectDenial(fixture, policy, { ...writeSelection, taskKind }, "Task kind exceeds registered agent policy");
    });
  });

  it("rejects a role registry that declares an unsupported full-access sandbox", () => {
    withFixture((fixture, policy) => {
      const registry = fixture.readRoles();
      const roles = registry.roles.map((role) => role.id === roleFixtureRole
        ? { ...role, sandbox_ceiling: "full-access" } : role);
      writeFileSync(fixture.rolesPath, stringify({ ...registry, roles }));
      expectDenial(fixture, policy, writeSelection, "Invalid or unsupported role registry", "configuration");
    });
  });
});
