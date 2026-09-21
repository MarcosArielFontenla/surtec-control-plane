import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyError, PolicyService } from "./service";

let root: string;
let projectsRoot: string;

function writeRegistries(projectExtra = "", agentExtra = ""): void {
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(join(root, "registry", "agents.yml"), `agents:\n  - id: backend-engineer\n    name: Backend Engineer\n    type: engineering\n    description: Implements code.\n    default_sandbox: workspace-write\n    allowed_task_types: [bugfix]\n    requires_human_approval_for: [merge]\n${agentExtra}`, "utf8");
  writeFileSync(join(root, "registry", "projects.yml"), `projects:\n  alpha:\n    status: active\n    allowed_agents: [backend-engineer]\n    sandbox:\n      default: workspace-write\n    commands:\n      test: pnpm test\n    approval:\n      before_merge: true\n      before_deploy: true\n${projectExtra}`, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-policy-"));
  projectsRoot = join(root, "projects");
  mkdirSync(join(projectsRoot, "alpha", ".git"), { recursive: true });
  writeRegistries();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("PolicyService", () => {
  it("returns a typed project and exact verification commands", () => {
    const policy = new PolicyService(root, { environment: { SURTEC_PROJECTS_ROOT: projectsRoot } });
    expect(policy.project("alpha")).toMatchObject({ repo_path: join(projectsRoot, "alpha"), verify_commands: ["pnpm test"], sandbox: "workspace-write" });
    expect(policy.authorizeDispatch({ project: "alpha", agent: "backend-engineer", sandbox: "workspace-write", selfVerify: true }).agent.id).toBe("backend-engineer");
  });

  it("rejects malformed registry values instead of coercing them", () => {
    writeFileSync(join(root, "registry", "projects.yml"), "projects:\n  ../escape:\n    allowed_agents: []\n", "utf8");
    expect(() => new PolicyService(root, { environment: { SURTEC_PROJECTS_ROOT: projectsRoot } }).listProjects()).toThrow(PolicyError);
  });

  it("rejects unknown agents referenced by a project", () => {
    writeRegistries("  beta:\n    allowed_agents: [ghost]\n");
    expect(() => new PolicyService(root, { environment: { SURTEC_PROJECTS_ROOT: projectsRoot } }).listProjects()).toThrow(/unknown agent/);
  });

  it("does not expose a configured checkout outside the portfolio root", () => {
    const outside = join(root, "outside");
    mkdirSync(join(outside, ".git"), { recursive: true });
    writeFileSync(join(root, "registry", "projects.yml"), `projects:\n  outside:\n    local_path: ${outside.replace(/\\/g, "/")}\n    allowed_agents: [backend-engineer]\n`, "utf8");
    const project = new PolicyService(root, { environment: { SURTEC_PROJECTS_ROOT: projectsRoot } }).project("outside");
    expect(project.repo_path).toBeNull();
    expect(() => new PolicyService(root, { environment: { SURTEC_PROJECTS_ROOT: projectsRoot } }).authorizeDispatch({ project: "outside", agent: "backend-engineer", sandbox: "read-only", selfVerify: false })).toThrow(/contained local git checkout/);
  });

  it("enforces project and agent write ceilings", () => {
    writeFileSync(join(root, "registry", "projects.yml"), "projects:\n  alpha:\n    allowed_agents: [backend-engineer]\n    sandbox:\n      default: read-only\n", "utf8");
    const policy = new PolicyService(root, { environment: { SURTEC_PROJECTS_ROOT: projectsRoot } });
    expect(() => policy.authorizeDispatch({ project: "alpha", agent: "backend-engineer", sandbox: "workspace-write", selfVerify: false })).toThrow(/does not allow workspace-write/);
  });
});
