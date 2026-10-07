import type { GitStatus } from "../../../lib/state/types";
import { readGitStatus } from "../../../lib/git-status";
import { githubRepoSlug } from "../../../lib/github-url";
import { PolicyService, type PolicyProject } from "../../../lib/policy/service";
import { integrationError, safeHttpUrl } from "../../../lib/integrations/safety";
import { assertProjectIntegrationsSnapshot } from "../../../lib/integrations/validation";
import type {
  CiObservation,
  DependencyObservation,
  DeploymentObservation,
  DeploymentProvider,
  IntegrationHealth,
  ProjectIntegrationsReader,
  ProjectIntegrationsSnapshot,
  SourceControlObservation,
} from "../../../lib/integrations/types";
import { noOpTracer, type Tracer } from "../../../lib/observability/tracing";
import { readCiStatus, readGithubCounts, type CiState, type GithubCounts, type GithubPullRequestAction } from "./github-read";
import { createHttpHealthDeploymentProvider, createRailwayDeploymentProvider } from "./deployment-providers";
import { readDepsStatus, type DepsObservation } from "./deps-read";
import { execFile as nodeExecFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { githubCliEnvironment, localGitEnvironment } from "../../../lib/security/environment";
import { assertSafeIdentifier } from "../../../lib/security/identifiers";

interface ProjectPolicyReader {
  project(projectId: string): PolicyProject;
}

export interface ProjectIntegrationsDependencies {
  policy?: ProjectPolicyReader;
  readLocalGit?: (repoPath: string) => GitStatus;
  readGithub?: (slug: string) => GithubCounts;
  readCi?: (slug: string, branch: string) => { state: CiState; startedAt?: string | null; runId?: string | null; updatedAt?: string | null };
  readDependencies?: (repoPath: string) => DepsObservation;
  deploymentProviders?: DeploymentProvider[];
  tracer?: Tracer;
  clock?: () => Date;
  cacheNow?: () => number;
  ttlMs?: number;
  environment?: NodeJS.ProcessEnv;
}

const DEPLOYMENT_HEALTH = new Set<IntegrationHealth>(["ok", "degraded", "down", "unknown", "unconfigured"]);
const TRACE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function ciHealth(state: CiState): IntegrationHealth {
  switch (state) {
    case "passing": return "ok";
    case "failing": return "down";
    case "running": return "degraded";
    default: return "unknown";
  }
}

function sourceControl(
  project: PolicyProject,
  readLocalGit: (repoPath: string) => GitStatus,
  readGithub: (slug: string) => GithubCounts,
): { observation: SourceControlObservation; slug: string | null } {
  let local: SourceControlObservation;
  if (!project.repo_path) {
    local = {
      provider: "git",
      configured: false,
      health: "unconfigured",
      branch: null,
      dirty: null,
      uncommitted: null,
      ahead: null,
      behind: null,
      remote: {
        provider: "github",
        configured: false,
        health: "unconfigured",
        pull_requests: null,
        issues: null,
      },
    };
  } else {
    try {
      const status = readLocalGit(project.repo_path);
      local = {
        provider: "git",
        configured: true,
        health: status.ok ? "ok" : "unknown",
        branch: status.branch,
        dirty: status.dirty,
        uncommitted: status.uncommitted,
        ahead: status.ahead,
        behind: status.behind,
        remote: {
          provider: "github",
          configured: false,
          health: "unconfigured",
          pull_requests: null,
          issues: null,
        },
        ...(!status.ok ? { error: "local Git status is unavailable" } : {}),
      };
    } catch (error) {
      local = {
        provider: "git",
        configured: true,
        health: "unknown",
        branch: null,
        dirty: null,
        uncommitted: null,
        ahead: null,
        behind: null,
        remote: {
          provider: "github",
          configured: false,
          health: "unconfigured",
          pull_requests: null,
          issues: null,
        },
        error: integrationError(error),
      };
    }
  }

  const slug = githubRepoSlug(project.repo);
  if (!slug) return { observation: local, slug: null };
  try {
    const counts = readGithub(slug);
    local.remote = {
      provider: "github",
      configured: true,
      health: counts.ok ? "ok" : "unknown",
      pull_requests: counts.ok ? counts.prs : null,
      issues: counts.ok ? counts.issues : null,
          waiting_pull_requests: counts.ok ? (counts.waitingPullRequests ?? []).map((item: GithubPullRequestAction) => ({
            number: item.number,
            updated_at: item.updatedAt,
            review_decision: item.reviewDecision,
          })) : [],
      ...(counts.error ? { error: integrationError(counts.error) } : {}),
    };
  } catch (error) {
    local.remote = {
      provider: "github",
      configured: true,
      health: "unknown",
      pull_requests: null,
      issues: null,
      error: integrationError(error),
    };
  }
  return { observation: local, slug };
}

function continuousIntegration(
  project: PolicyProject,
  slug: string | null,
  readCi: (slug: string, branch: string) => { state: CiState; startedAt?: string | null; runId?: string | null; updatedAt?: string | null },
): CiObservation {
  if (!slug) {
    return {
      provider: "github-actions",
      configured: false,
      health: "unconfigured",
      status: null,
      branch: null,
    };
  }
  const branch = project.default_branch ?? "main";
  try {
    const { state, startedAt, runId, updatedAt } = readCi(slug, branch);
    return {
      provider: "github-actions",
      configured: true,
      health: ciHealth(state),
      status: state,
      branch,
      ...(state === "running" ? { run_started_at: startedAt ?? null } : {}),
      ...(runId ? { run_id: runId } : {}),
      ...(updatedAt ? { run_updated_at: updatedAt } : {}),
      ...(state === "unknown" ? { error: "CI status is unavailable" } : {}),
    };
  } catch (error) {
    return {
      provider: "github-actions",
      configured: true,
      health: "unknown",
      status: "unknown",
      branch,
      error: integrationError(error),
    };
  }
}

function dependencyHealth(
  project: PolicyProject,
  readDependencies: (repoPath: string) => DepsObservation,
  observedAt: string,
): DependencyObservation {
  if (!project.repo_path) {
    return { provider: "npm", configured: false, health: "unconfigured", outdated: null, observed_at: observedAt };
  }
  try {
    const result = readDependencies(project.repo_path);
    const configured = result.error !== "sin package.json";
    return {
      provider: "npm",
      configured,
      health: !configured ? "unconfigured" : result.ok ? (result.outdated > 0 ? "degraded" : "ok") : "unknown",
      outdated: configured ? result.outdated : null,
      observed_at: result.observed_at,
      ...(result.error ? { error: integrationError(result.error) } : {}),
    };
  } catch (error) {
    return {
      provider: "npm",
      configured: true,
      health: "unknown",
      outdated: null,
      observed_at: observedAt,
      error: integrationError(error),
    };
  }
}

function deferredDependencyHealth(project: PolicyProject, observedAt: string): DependencyObservation {
  return project.repo_path
    ? { provider: "npm", configured: true, health: "unknown", outdated: null, observed_at: observedAt, error: "Detailed dependency check was not requested." }
    : { provider: "npm", configured: false, health: "unconfigured", outdated: null, observed_at: observedAt };
}

function providerConfigured(provider: DeploymentProvider, project: PolicyProject): boolean {
  return provider.id === "http-health" ? Boolean(project.deploy_url) : Boolean(project.railway);
}

function failedDeployment(
  provider: DeploymentProvider,
  project: PolicyProject,
  observedAt: string,
  error: unknown,
): DeploymentObservation {
  const configured = providerConfigured(provider, project);
  return {
    provider: provider.id,
    configured,
    health: configured ? "unknown" : "unconfigured",
    status: null,
    observed_at: observedAt,
    url: null,
    http_status: null,
    latency_ms: null,
    deployed_at: null,
    error: integrationError(error),
  };
}

function normalizeDeployment(
  provider: DeploymentProvider,
  value: DeploymentObservation,
  observedAt: string,
): DeploymentObservation {
  if (value.provider !== provider.id) throw new Error(`deployment provider identity mismatch: ${provider.id}`);
  const health = DEPLOYMENT_HEALTH.has(value.health) ? value.health : "unknown";
  const url = safeHttpUrl(value.url);
  const unsafeUrl = Boolean(value.url && !url);
  return {
    provider: provider.id,
    configured: value.configured === true,
    health,
    status: typeof value.status === "string" ? integrationError(value.status).slice(0, 100) : null,
    observed_at: observedAt,
    url,
    http_status: Number.isInteger(value.http_status) ? value.http_status : null,
    latency_ms: typeof value.latency_ms === "number" && Number.isFinite(value.latency_ms) && value.latency_ms >= 0
      ? value.latency_ms
      : null,
    deployed_at: typeof value.deployed_at === "string" ? value.deployed_at.slice(0, 100) : null,
    ...(value.error ? { error: integrationError(value.error) } : {}),
    ...(unsafeUrl ? { error: "provider returned an unsafe URL" } : {}),
  };
}

function safeTraceId(value: string | undefined): string | null {
  return value && TRACE_ID.test(value) ? value : null;
}

export function createProjectIntegrationsService(
  repoRoot: string,
  dependencies: ProjectIntegrationsDependencies = {},
): ProjectIntegrationsReader {
  const policy = dependencies.policy ?? new PolicyService(repoRoot);
  const readLocalGit = dependencies.readLocalGit ?? readGitStatus;
  const readGithub = dependencies.readGithub ?? readGithubCounts;
  const readCi = dependencies.readCi ?? readCiStatus;
  const environment = dependencies.environment ?? process.env;
  const providers = dependencies.deploymentProviders ?? [
    createHttpHealthDeploymentProvider(),
    createRailwayDeploymentProvider({ token: environment.RAILWAY_TOKEN }),
  ];
  const tracer = dependencies.tracer ?? noOpTracer;
  const clock = dependencies.clock ?? (() => new Date());
  const readDependencies = dependencies.readDependencies ?? ((repoPath: string) => ({
    ...readDepsStatus(repoPath),
    observed_at: clock().toISOString(),
  }));
  const cacheNow = dependencies.cacheNow ?? Date.now;
  const ttlMs = dependencies.ttlMs ?? 60_000;
  const cache = new Map<string, { value: Promise<ProjectIntegrationsSnapshot>; at: number }>();

  const build = async (projectId: string, includeDependencies: boolean): Promise<ProjectIntegrationsSnapshot> => {
    const span = tracer.startSpan("project-integrations.read", { project_id: projectId });
    try {
      const project = policy.project(projectId);
      const observedAt = clock().toISOString();
      const source = sourceControl(project, readLocalGit, readGithub);
      const ci = continuousIntegration(project, source.slug, readCi);
      const dependency = includeDependencies
        ? dependencyHealth(project, readDependencies, observedAt)
        : deferredDependencyHealth(project, observedAt);
      span.addEvent("source-control.observed", { health: source.observation.health, remote_health: source.observation.remote.health });
      span.addEvent("ci.observed", { health: ci.health, status: ci.status });
      span.addEvent("dependencies.observed", { health: dependency.health, configured: dependency.configured });

      const deployments = await Promise.all(providers.map(async (provider) => {
        const providerSpan = tracer.startSpan("project-integrations.deployment", { project_id: project.id, provider: provider.id });
        try {
          const observation = normalizeDeployment(provider, await provider.observe(project, observedAt), observedAt);
          providerSpan.addEvent("observed", { health: observation.health, configured: observation.configured });
          providerSpan.end("ok");
          return observation;
        } catch (error) {
          const observation = failedDeployment(provider, project, observedAt, error);
          providerSpan.addEvent("failed", { configured: observation.configured });
          providerSpan.end("error");
          return observation;
        }
      }));

      const snapshot: ProjectIntegrationsSnapshot = {
        schema_version: 2,
        project_id: project.id,
        observed_at: observedAt,
        trace_id: safeTraceId(span.context?.traceId),
        source_control: source.observation,
        ci,
        dependencies: dependency,
        deployments,
      };
      assertProjectIntegrationsSnapshot(snapshot);
      span.end("ok");
      return snapshot;
    } catch (error) {
      span.end("error");
      throw error;
    }
  };

  return {
    read(projectId: string, options: { includeDependencies?: boolean } = {}): Promise<ProjectIntegrationsSnapshot> {
      const includeDependencies = options.includeDependencies === true;
      const cacheKey = `${projectId}\u0000${includeDependencies ? "detail" : "portfolio"}`;
      const at = cacheNow();
      const hit = cache.get(cacheKey);
      if (hit && at - hit.at < ttlMs) return hit.value;
      const value = build(projectId, includeDependencies);
      cache.set(cacheKey, { value, at });
      void value.catch(() => {
        if (cache.get(cacheKey)?.value === value) cache.delete(cacheKey);
      });
      return value;
    },
    invalidate(projectId: string): void {
      cache.delete(`${projectId}\u0000detail`);
      cache.delete(`${projectId}\u0000portfolio`);
    },
  };
}

/** Internal read composition only. These options are supplied by the owned occurrence controller. */
export interface RoutineIntegrationOptions {
  signal: AbortSignal;
  deadline_at: string;
  check: () => void;
}
export interface RoutineCommandResult { status: number | null; stdout: string }
export interface RoutineProjectIntegrationDependencies {
  policy?: ProjectPolicyReader;
  environment?: NodeJS.ProcessEnv;
  clock?: () => Date;
  cacheNow?: () => number;
  ttlMs?: number;
  sourceTimeoutMs?: number;
  /** Trusted application/test wiring, never request or routine metadata. */
  run?: (file: string, args: string[], options: {
    cwd?: string; env: NodeJS.ProcessEnv; signal: AbortSignal; shell: false; maxBuffer: number;
  }) => Promise<RoutineCommandResult>;
  fetch?: typeof fetch;
  readDependencies?: (project: Readonly<Pick<PolicyProject, "id" | "repo_path">>, signal: AbortSignal) => Promise<number | null>;
  providersEnabled?: boolean;
}

const ROUTINE_OUTPUT_BYTES = 256 * 1024;
const ROUTINE_RAILWAY_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const ROUTINE_RAILWAY_QUERY = "query latestDeployment($input: DeploymentListInput!) { deployments(input: $input, first: 1) { edges { node { status createdAt } } } }";

function routineCommand(file: string, args: string[], options: {
  cwd?: string; env: NodeJS.ProcessEnv; signal: AbortSignal; shell: false; maxBuffer: number;
}): Promise<RoutineCommandResult> {
  return new Promise((done) => {
    nodeExecFile(file, args, { ...options, encoding: "buffer", windowsHide: true }, (error, stdout) => {
      // Never retain stderr/error text: provider output can contain credentials or private paths.
      try { done({ status: error ? null : 0, stdout: error ? "" : new TextDecoder("utf-8", { fatal: true }).decode(stdout) }); }
      catch { done({ status: null, stdout: "" }); }
    });
  });
}

async function routineDirectory(path: string): Promise<string> {
  if (/^(?:\\\\|\/\/)/.test(path)) throw new Error("remote integration directory unavailable");
  const absolute = resolve(path);
  let current = absolute;
  while (true) {
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("unsafe integration directory");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (await realpath(absolute) !== absolute) throw new Error("aliased integration directory");
  return absolute;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function routineJson(text: string): unknown {
  if (Buffer.byteLength(text) > ROUTINE_OUTPUT_BYTES) throw new Error("bounded provider output exceeded");
  const value: unknown = JSON.parse(text);
  const pending = [{ value, depth: 0 }]; let entries = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (item.depth > 32 || ++entries > 10000) throw new Error("bounded provider structure exceeded");
    if (item.value && typeof item.value === "object") {
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  return value;
}
function routineGitCounts(text: string): { changed: number; ahead: number | null; behind: number | null } | null {
  const lines = text.trimEnd().split("\n").map((line) => line.replace(/\r$/, ""));
  const oid = lines.filter((line) => line.startsWith("# branch.oid "));
  const head = lines.filter((line) => line.startsWith("# branch.head "));
  const ab = lines.filter((line) => line.startsWith("# branch.ab "));
  if (oid.length !== 1 || !/^# branch\.oid (?:[a-f0-9]{40}|[a-f0-9]{64}|\(initial\))$/.test(oid[0]!)
    || head.length !== 1 || !/^# branch\.head \S+$/.test(head[0]!) || ab.length > 1) return null;
  const hash = "(?:[a-f0-9]{40}|[a-f0-9]{64})", mode = "[0-7]{6}", xy = "[.MADRCUT?!]{2}", sub = "(?:N\\.\\.\\.|S[.C][.M][.U])";
  const ordinary = new RegExp(`^1 ${xy} ${sub} ${mode} ${mode} ${mode} ${hash} ${hash} .+$`);
  const renamed = new RegExp(`^2 ${xy} ${sub} ${mode} ${mode} ${mode} ${hash} ${hash} [RC][0-9]{1,3} .+\\t.+$`);
  const unmerged = new RegExp(`^u ${xy} ${sub} ${mode} ${mode} ${mode} ${mode} ${hash} ${hash} ${hash} .+$`);
  let changed = 0;
  for (const line of lines) {
    if (/^# branch\.(?:oid|head|upstream|ab) /.test(line)) continue;
    if (!ordinary.test(line) && !renamed.test(line) && !unmerged.test(line) && !/^\? .+$/.test(line)) return null;
    changed++;
  }
  const counts = ab[0]?.match(/^# branch\.ab \+(\d+) -(\d+)$/);
  if (ab.length && !counts) return null;
  const ahead = counts ? Number(counts[1]) : null, behind = counts ? Number(counts[2]) : null;
  if (ahead !== null && !nonnegativeInteger(ahead) || behind !== null && !nonnegativeInteger(behind)) return null;
  return { changed, ahead, behind };
}

/** Separate async path: no legacy synchronous provider/helper is called by routines. */
export function createRoutineProjectIntegrationsService(
  repoRoot: string, dependencies: RoutineProjectIntegrationDependencies = {},
): { read(projectId: string, options: RoutineIntegrationOptions): Promise<ProjectIntegrationsSnapshot>; invalidate(projectId: string): void } {
  const policy = dependencies.policy ?? new PolicyService(repoRoot);
  const environment = dependencies.environment ?? process.env;
  const clock = dependencies.clock ?? (() => new Date());
  const now = dependencies.cacheNow ?? Date.now;
  const run = dependencies.run ?? routineCommand;
  const doFetch = dependencies.fetch ?? fetch;
  const enabled = dependencies.providersEnabled !== false;
  const ttl = dependencies.ttlMs ?? 60_000;
  const sourceTimeout = dependencies.sourceTimeoutMs ?? 6000;
  if (!Number.isSafeInteger(ttl) || ttl < 0 || ttl > 300_000 || !Number.isSafeInteger(sourceTimeout)
    || sourceTimeout < 1 || sourceTimeout > 6000) throw new Error("invalid routine integration bounds");
  type Consumer = { check: () => void; signal: AbortSignal };
  type Entry = { projectId: string; controller: AbortController; consumers: Set<Consumer>;
    promise: Promise<ProjectIntegrationsSnapshot>; value?: ProjectIntegrationsSnapshot; at: number };
  const cache = new Map<string, Entry>();
  const config = (project: PolicyProject): string => createHash("sha256").update(JSON.stringify([
    project.id, project.repo_path, project.repo, project.default_branch, project.deploy_url, project.railway,
    enabled, shaEnvironment(),
  ])).digest("hex");
  const shaEnvironment = (): string => createHash("sha256").update(JSON.stringify([
    githubCliEnvironment(environment), environment.RAILWAY_TOKEN ?? null,
  ])).digest("hex");
  const gate = (entry: Entry): void => {
    if (entry.controller.signal.aborted) throw new Error("routine integration stopped");
    for (const consumer of entry.consumers) {
      if (consumer.signal.aborted) continue;
      try { consumer.check(); return; } catch { /* Another independently owned consumer may remain. */ }
    }
    entry.controller.abort();
    throw new Error("routine integration ownership unavailable");
  };
  const build = async (project: PolicyProject, entry: Entry): Promise<ProjectIntegrationsSnapshot> => {
    const at = clock().toISOString();
    const snapshot: ProjectIntegrationsSnapshot = {
      schema_version: 2, project_id: project.id, observed_at: at, trace_id: null,
      source_control: { provider: "git", configured: Boolean(project.repo_path), health: project.repo_path ? "unknown" : "unconfigured",
        branch: null, dirty: null, uncommitted: null, ahead: null, behind: null,
        remote: { provider: "github", configured: false, health: "unconfigured", pull_requests: null, issues: null } },
      ci: { provider: "github-actions", configured: false, health: "unconfigured", status: null, branch: null },
      dependencies: { provider: "npm", configured: Boolean(project.repo_path), health: project.repo_path ? "unknown" : "unconfigured",
        outdated: null, observed_at: at },
      deployments: ["http-health", "railway"].map((provider) => ({ provider: provider as DeploymentObservation["provider"],
        configured: provider === "http-health" ? Boolean(project.deploy_url) : Boolean(project.railway),
        health: (provider === "http-health" ? project.deploy_url : project.railway) ? "unknown" : "unconfigured",
        status: null, observed_at: at, url: null, http_status: null, latency_ms: null, deployed_at: null })),
    };
    const isolated = async (read: (signal: AbortSignal) => Promise<void>): Promise<void> => {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      entry.controller.signal.addEventListener("abort", abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        gate(entry);
        await Promise.race([read(controller.signal), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("routine source deadline")); }, sourceTimeout);
        })]);
      } catch { /* Optional source failure remains explicitly unavailable. */ }
      finally { clearTimeout(timer); entry.controller.signal.removeEventListener("abort", abort); controller.abort(); }
    };
    const sourceGate = (signal: AbortSignal): void => { if (signal.aborted) throw new Error("routine source stopped"); gate(entry); };
    await Promise.all([
      isolated(async (signal) => {
        if (!project.repo_path) return;
        const path = await routineDirectory(project.repo_path); sourceGate(signal);
        const result = await run("git", ["-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
          "-c", "core.fsmonitor=false", "--no-optional-locks", "-C", path, "status", "--porcelain=v2", "--branch"],
        { env: localGitEnvironment(environment), signal, shell: false, maxBuffer: ROUTINE_OUTPUT_BYTES });
        sourceGate(signal);
        if (result.status !== 0 || Buffer.byteLength(result.stdout) > ROUTINE_OUTPUT_BYTES) return;
        const parsed = routineGitCounts(result.stdout); if (!parsed) return;
        const { changed, ahead, behind } = parsed;
        Object.assign(snapshot.source_control, { health: "ok", dirty: changed > 0, uncommitted: changed, ahead, behind });
      }),
      isolated(async (signal) => {
        const slug = githubRepoSlug(project.repo);
        if (!enabled || !slug || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(slug)
          || slug.includes("..") || environment.GH_HOST && environment.GH_HOST !== "github.com") return;
        const branch = project.default_branch ?? "main";
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch.includes("..")) return;
        snapshot.ci = { provider: "github-actions", configured: true, health: "unknown", status: "unknown", branch };
        const result = await run("gh", ["run", "list", "--branch", branch, "--limit", "1", "--json",
          "status,conclusion,startedAt,databaseId,updatedAt", "-R", slug],
        { env: githubCliEnvironment(environment), signal, shell: false, maxBuffer: ROUTINE_OUTPUT_BYTES });
        sourceGate(signal);
        if (result.status !== 0 || Buffer.byteLength(result.stdout) > ROUTINE_OUTPUT_BYTES) return;
        const data: unknown = routineJson(result.stdout);
        if (!Array.isArray(data) || data.length > 1) return;
        const first = data[0];
        if (!first) { Object.assign(snapshot.ci, { status: "none", health: "ok" }); return; }
        if (typeof first !== "object" || !["completed", "queued", "in_progress", "waiting", "requested", "pending"].includes(first.status)) return;
        if (first.status === "completed" && !["success", "failure", "cancelled", "timed_out", "action_required", "neutral", "skipped", "stale", "startup_failure"].includes(first.conclusion)) return;
        const state = first.status === "completed" ? (first.conclusion === "success" ? "passing" : "failing") : "running";
        Object.assign(snapshot.ci, { status: state, health: ciHealth(state) });
        for (const [source, target] of [["startedAt", "run_started_at"], ["updatedAt", "run_updated_at"]] as const) {
          if (typeof first[source] === "string" && Number.isFinite(Date.parse(first[source]))
            && Date.parse(first[source]) <= Date.parse(at)) snapshot.ci[target] = new Date(first[source]).toISOString();
        }
        if (Number.isSafeInteger(first.databaseId) && first.databaseId > 0) snapshot.ci.run_id = String(first.databaseId);
      }),
      isolated(async (signal) => {
        if (!enabled || !project.deploy_url) return;
        const url = safeHttpUrl(project.deploy_url);
        if (!url) return;
        const result = await doFetch(url, { method: "HEAD", signal, redirect: "error", credentials: "omit" });
        sourceGate(signal);
        if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599) return;
        Object.assign(snapshot.deployments[0], { health: result.status < 400 ? "ok" : "degraded", http_status: result.status });
      }),
      isolated(async (signal) => {
        if (!enabled || !project.railway || !environment.RAILWAY_TOKEN) return;
        if (Object.values(project.railway).some((id) => !/^[A-Za-z0-9_-]{1,160}$/.test(id))) return;
        const result = await doFetch(ROUTINE_RAILWAY_ENDPOINT, { method: "POST", redirect: "error", credentials: "omit", signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${environment.RAILWAY_TOKEN}` },
          body: JSON.stringify({ query: ROUTINE_RAILWAY_QUERY, variables: { input: {
            projectId: project.railway.project_id, serviceId: project.railway.service_id, environmentId: project.railway.environment_id,
          } } }) });
        sourceGate(signal);
        if (!result.ok) return;
        const length = Number(result.headers.get("content-length"));
        if (length > ROUTINE_OUTPUT_BYTES) return;
        if (!result.body) return;
        const reader = result.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
        try {
          while (true) {
            sourceGate(signal); const chunk = await reader.read(); sourceGate(signal);
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > ROUTINE_OUTPUT_BYTES) throw new Error("bounded provider response exceeded");
            chunks.push(chunk.value);
          }
        } finally { await reader.cancel().catch(() => undefined); }
        const body = routineJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as {
          errors?: unknown; data?: { deployments?: { edges?: { node?: { status?: unknown; createdAt?: unknown } }[] } };
        };
        const node = body?.data?.deployments?.edges?.[0]?.node;
        if (body.errors || !node || typeof node.status !== "string") return;
        const health: Record<string, IntegrationHealth> = { SUCCESS: "ok", FAILED: "down", CRASHED: "down",
          BUILDING: "degraded", DEPLOYING: "degraded", WAITING: "degraded", QUEUED: "degraded",
          REMOVED: "degraded", SLEEPING: "degraded", SKIPPED: "degraded" };
        if (!Object.hasOwn(health, node.status)) return;
        Object.assign(snapshot.deployments[1], { health: health[node.status] });
        if (typeof node.createdAt === "string" && Number.isFinite(Date.parse(node.createdAt))
          && Date.parse(node.createdAt) <= Date.parse(at)) snapshot.deployments[1].deployed_at = new Date(node.createdAt).toISOString();
      }),
      isolated(async (signal) => {
        if (!enabled || !project.repo_path || !dependencies.readDependencies) return;
        // The legacy npm helper invokes a shell and reads project npm configuration. Never reuse it.
        // Without an explicitly wired constrained async reader, the count is unavailable, not zero.
        await routineDirectory(project.repo_path); sourceGate(signal);
        const count = await dependencies.readDependencies(Object.freeze({ id: project.id, repo_path: project.repo_path }), signal); sourceGate(signal);
        if (!nonnegativeInteger(count)) return;
        Object.assign(snapshot.dependencies, { health: count > 0 ? "degraded" : "ok", outdated: count });
      }),
    ]);
    gate(entry); assertProjectIntegrationsSnapshot(snapshot);
    return snapshot;
  };
  return {
    async read(projectId, options) {
      assertSafeIdentifier(projectId, "project id"); options.check();
      const deadline = Date.parse(options.deadline_at);
      if (options.signal.aborted || !Number.isFinite(deadline) || deadline <= clock().getTime()) throw new Error("routine integration stopped");
      const project = policy.project(projectId);
      if (project.id !== projectId) throw new Error("routine project identity mismatch");
      const key = config(project); const consumer: Consumer = { check: options.check, signal: options.signal };
      for (const [prior, hit] of cache) if (prior !== key && (hit.projectId === projectId || hit.value && now() - hit.at >= ttl)) {
        cache.delete(prior); hit.controller.abort();
      }
      let entry = cache.get(key);
      if (entry && entry.value && now() - entry.at >= ttl) { cache.delete(key); entry = undefined; }
      if (!entry) {
        if (cache.size >= 256) throw new Error("routine integration cache unavailable");
        entry = { projectId, controller: new AbortController(), consumers: new Set(), promise: Promise.resolve(null as never), at: now() };
        cache.set(key, entry);
        entry.consumers.add(consumer);
        const owned = entry;
        // Defer until the first consumer is registered, then retain only successful live snapshots.
        owned.promise = Promise.resolve().then(() => build(project, owned)).then((value) => {
          gate(owned); owned.value = structuredClone(value); owned.at = now(); return value;
        }).finally(() => { if (!owned.value && cache.get(key) === owned) cache.delete(key); });
        void owned.promise.catch(() => undefined);
      } else entry.consumers.add(consumer);
      const owned = entry;
      return new Promise<ProjectIntegrationsSnapshot>((accept, reject) => {
        let finished = false;
        const cleanup = (): void => {
          clearTimeout(timer); options.signal.removeEventListener("abort", abort); owned.controller.signal.removeEventListener("abort", abort);
          owned.consumers.delete(consumer);
          if (!owned.value && owned.consumers.size === 0) { owned.controller.abort(); if (cache.get(key) === owned) cache.delete(key); }
        };
        const abort = (): void => { if (finished) return; finished = true; cleanup(); reject(new Error("routine integration stopped")); };
        const timer = setTimeout(abort, Math.min(60_000, Math.max(1, deadline - clock().getTime())));
        options.signal.addEventListener("abort", abort, { once: true }); owned.controller.signal.addEventListener("abort", abort, { once: true });
        owned.promise.then((value) => {
          if (finished) return;
          try {
            options.check();
            if (options.signal.aborted || clock().getTime() >= deadline || config(policy.project(projectId)) !== key) throw new Error("routine integration stopped");
            finished = true; cleanup(); accept(structuredClone(value));
          } catch { abort(); }
        }, () => abort());
        if (options.signal.aborted || owned.controller.signal.aborted) abort();
      });
    },
    invalidate(projectId) {
      for (const [key, entry] of cache) if (entry.projectId === projectId) { cache.delete(key); entry.controller.abort(); }
    },
  };
}
