import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { parse } from "yaml";
import agentsRegistrySchema from "../../schemas/agents-registry.schema.json";
import projectsRegistrySchema from "../../schemas/projects-registry.schema.json";
import type { ProjectCommands, SandboxMode } from "../state/types";
import { DEFAULT_IGNORE, discoverProjects, type DiscoveredProject } from "../discover";
import { expandHome } from "../expand-home";
import { assertSafeIdentifier } from "../security/identifiers";
import { isPathWithin } from "../security/paths";

export interface PolicyAgent {
  id: string;
  name: string;
  type: string;
  description: string;
  default_sandbox: SandboxMode;
  allowed_task_types: string[];
  requires_human_approval_for: string[];
}

export interface ProjectApprovalPolicy {
  before_merge: boolean;
  before_deploy: boolean;
}

export interface PolicyProject {
  id: string;
  status: string;
  repo: string | null;
  repo_path: string | null;
  default_branch: string | null;
  allowed_agents: string[];
  sandbox: SandboxMode;
  commands: ProjectCommands;
  verify_commands: string[];
  approval: ProjectApprovalPolicy;
  deploy_url: string | null;
  railway: { project_id: string; service_id: string; environment_id: string } | null;
}

interface AgentRegistryDocument { agents: PolicyAgent[] }
interface RawProject {
  repo?: string;
  local_path?: string;
  default_branch?: string;
  status?: string;
  allowed_agents?: string[];
  sandbox?: { default: SandboxMode };
  commands?: ProjectCommands;
  verify?: string[];
  approval?: { before_merge?: boolean; before_deploy?: boolean };
  deploy_url?: string;
  railway?: { project_id: string; service_id: string; environment_id: string };
}
interface ProjectRegistryDocument { projects: Record<string, RawProject> }

export interface PolicyDependencies {
  environment?: NodeJS.ProcessEnv;
  discover?: (root: string, ignore?: string[]) => DiscoveredProject[];
}

export class PolicyError extends Error {
  constructor(message: string, public readonly code: "configuration" | "invalid-input" | "denied" | "not-found" = "denied") {
    super(message);
    this.name = "PolicyError";
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateAgents = ajv.compile(agentsRegistrySchema) as ValidateFunction<AgentRegistryDocument>;
const validateProjects = ajv.compile(projectsRegistrySchema) as ValidateFunction<ProjectRegistryDocument>;

function validationMessage(label: string, errors: ErrorObject[] | null | undefined): string {
  const detail = errors?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ") ?? "invalid document";
  return `${label} is invalid: ${detail}`;
}

function readYaml<T>(path: string, label: string, validate: ValidateFunction<T>): T {
  let value: unknown;
  try {
    value = parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PolicyError(`${label} could not be read: ${(error as Error).message}`, "configuration");
  }
  if (!validate(value)) throw new PolicyError(validationMessage(label, validate.errors), "configuration");
  return value;
}

function verificationCommands(project: RawProject): string[] {
  if (project.verify) return [...project.verify];
  if (project.commands?.install && project.commands.test) return [project.commands.install, project.commands.test];
  return project.commands?.test ? [project.commands.test] : [];
}

export class PolicyService {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly discover: (root: string, ignore?: string[]) => DiscoveredProject[];

  constructor(private readonly repoRoot: string = process.cwd(), dependencies: PolicyDependencies = {}) {
    this.environment = dependencies.environment ?? process.env;
    this.discover = dependencies.discover ?? discoverProjects;
  }

  listAgents(): PolicyAgent[] {
    const document = readYaml(join(this.repoRoot, "registry", "agents.yml"), "agent registry", validateAgents);
    const seen = new Set<string>();
    for (const agent of document.agents) {
      assertSafeIdentifier(agent.id, "agent id");
      if (seen.has(agent.id)) throw new PolicyError(`agent registry contains duplicate id: ${agent.id}`, "configuration");
      seen.add(agent.id);
    }
    return document.agents.map((agent) => ({ ...agent, allowed_task_types: [...agent.allowed_task_types], requires_human_approval_for: [...agent.requires_human_approval_for] }));
  }

  listProjects(): PolicyProject[] {
    const document = readYaml(join(this.repoRoot, "registry", "projects.yml"), "project registry", validateProjects);
    const agents = new Set(this.listAgents().map((agent) => agent.id));
    const projectsRoot = this.projectsRoot();
    const discovered = new Map(this.discover(projectsRoot, this.ignore()).map((project) => [project.id, project.path]));
    return Object.entries(document.projects).map(([id, project]) => {
      assertSafeIdentifier(id, "project id");
      for (const agent of project.allowed_agents ?? []) {
        if (!agents.has(agent)) throw new PolicyError(`project '${id}' references unknown agent '${agent}'`, "configuration");
      }
      const configuredPath = project.local_path ? expandHome(project.local_path) : null;
      const candidate = discovered.get(id) ?? configuredPath;
      const repoPath = candidate && isPathWithin(projectsRoot, candidate) && existsSync(join(candidate, ".git"))
        ? candidate
        : null;
      return {
        id,
        status: project.status ?? "unknown",
        repo: project.repo ?? null,
        repo_path: repoPath,
        default_branch: project.default_branch ?? null,
        allowed_agents: [...(project.allowed_agents ?? [])],
        sandbox: project.sandbox?.default ?? "read-only",
        commands: { ...(project.commands ?? {}) },
        verify_commands: verificationCommands(project),
        approval: {
          before_merge: project.approval?.before_merge ?? true,
          before_deploy: project.approval?.before_deploy ?? true,
        },
        deploy_url: project.deploy_url ?? null,
        railway: project.railway ? { ...project.railway } : null,
      };
    });
  }

  project(projectId: string): PolicyProject {
    try { assertSafeIdentifier(projectId, "project id"); } catch { throw new PolicyError("invalid project id", "invalid-input"); }
    const project = this.listProjects().find((candidate) => candidate.id === projectId);
    if (!project) throw new PolicyError(`unknown project: ${projectId}`, "not-found");
    return project;
  }

  agent(agentId: string): PolicyAgent {
    try { assertSafeIdentifier(agentId, "agent id"); } catch { throw new PolicyError("invalid agent id", "invalid-input"); }
    const agent = this.listAgents().find((candidate) => candidate.id === agentId);
    if (!agent) throw new PolicyError(`unknown agent: ${agentId}`, "not-found");
    return agent;
  }

  authorizeDispatch(input: { project: string; agent: string; sandbox: SandboxMode; selfVerify: boolean }): { project: PolicyProject; agent: PolicyAgent } {
    const project = this.project(input.project);
    const agent = this.agent(input.agent);
    if (!project.repo_path) throw new PolicyError(`project '${project.id}' has no contained local git checkout`, "denied");
    if (!project.allowed_agents.includes(agent.id)) throw new PolicyError(`agent '${agent.id}' is not allowed for project '${project.id}'`, "denied");
    if (input.sandbox === "workspace-write" && project.sandbox !== "workspace-write") {
      throw new PolicyError(`project '${project.id}' does not allow workspace-write`, "denied");
    }
    if (input.sandbox === "workspace-write" && agent.default_sandbox !== "workspace-write") {
      throw new PolicyError(`agent '${agent.id}' does not allow workspace-write`, "denied");
    }
    if (input.selfVerify && project.verify_commands.length === 0) {
      throw new PolicyError(`project '${project.id}' has no verification commands`, "denied");
    }
    return { project, agent };
  }

  private projectsRoot(): string {
    return expandHome(this.environment.SURTEC_PROJECTS_ROOT ?? dirname(this.repoRoot));
  }

  private ignore(): string[] {
    return [...DEFAULT_IGNORE, ...(this.environment.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((value) => value.trim()).filter(Boolean)];
  }
}

