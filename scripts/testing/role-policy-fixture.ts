import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { assertRoleRegistry } from "../../lib/context/validation";
import type { SandboxMode } from "../../lib/state/types";

const prefix = "surtec-role-policy-";
const roleRegistry = "registry/agent-roles.yml";
export const roleFixtureProject = "role-fixture";
export const roleFixtureAgent = "backend-engineer";
export const roleFixtureRole = "software-engineer";

export function createRolePolicyFixture(options: { sandbox?: SandboxMode; verify?: readonly string[] } = {}) {
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, prefix));
  const identity = lstatSync(root, { bigint: true });
  const projects = join(root, "projects");
  const checkout = join(projects, roleFixtureProject);
  const state = join(root, "state");
  const agentsPath = join(root, "registry/agents.yml");
  const rolesPath = join(root, roleRegistry);
  const projectsPath = join(root, "registry/projects.yml");

  function dispose() {
    const current = lstatSync(root, { bigint: true });
    if (dirname(root) !== parent || !basename(root).startsWith(prefix)
      || !current.isDirectory() || current.isSymbolicLink() || realpathSync.native(root) !== root
      || current.ino === 0n || current.ino !== identity.ino || current.dev !== identity.dev) {
      throw new Error("Unable to verify the owned role EVAL directory for cleanup.");
    }
    rmSync(root, { recursive: true });
    if (lstatSync(root, { throwIfNoEntry: false })) throw new Error("The owned role fixture was not removed.");
  }

  function readRoles() {
    const roles: unknown = parse(readFileSync(rolesPath, "utf8"));
    assertRoleRegistry(roles);
    return roles;
  }

  function writeProjectPolicy(sandbox: SandboxMode, verify: readonly string[] = []) {
    writeFileSync(projectsPath, stringify({
      projects: {
        [roleFixtureProject]: {
          allowed_agents: [roleFixtureAgent],
          sandbox: { default: sandbox },
          ...(verify.length ? { verify } : {}),
        },
      },
    }));
  }

  try {
    mkdirSync(join(checkout, ".git"), { recursive: true });
    mkdirSync(join(root, "registry"));
    writeFileSync(join(root, "AGENTS.md"), "# Synthetic control plane instructions\n");
    writeFileSync(join(checkout, "AGENTS.md"), "# Synthetic project instructions\n");
    writeProjectPolicy(options.sandbox ?? "read-only", options.verify);
    for (const path of ["registry/agents.yml", roleRegistry, "registry/context-policy.yml"]) {
      copyFileSync(path, join(root, path));
    }
    const evaluationPaths = new Set(readRoles().roles.flatMap((role) => role.required_evaluation_ids));
    for (const path of evaluationPaths) {
      const destination = join(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(path, destination);
    }
    return {
      root, checkout, state, agentsPath, rolesPath, projectsPath, readRoles, writeProjectPolicy, dispose,
      environment: { SURTEC_STATE_DIR: state, SURTEC_PROJECTS_ROOT: projects },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
