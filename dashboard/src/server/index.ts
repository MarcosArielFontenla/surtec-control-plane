import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { dirname } from "node:path";
import { listTasks, listProjectOverrides, readTask, StateLockConflictError } from "../../../lib/state/store";
import { listWorkSessions } from "../../../lib/state/work-sessions";
import { readSignalHumanState } from "../../../lib/state/signals";
import { buildFeedbackMetrics } from "../../../lib/feedback-metrics";
import { readTaskEvents } from "../../../lib/state/events";
import { buildOverview } from "../../../lib/state/derive";
import { buildTaskDetail, buildToday } from "../../../lib/state/observability";
import { loadRegistryProjects } from "./registry";
import { discoverProjects, DEFAULT_IGNORE } from "../../../lib/discover";
import { createGitStatusCache } from "../../../lib/git-status-cache";
import { assemblePortfolio } from "../../../lib/portfolio";
import { loadProjectConfig } from "./portfolio-config";
import { createTask, ValidationError } from "./dispatch";
import { approveTask, rejectTask, ReviewError, TaskNotFoundError } from "./review";
import { openProject, OpenError } from "./open-project";
import { runGitSync, GitSyncError } from "./git-sync";
import { validateBranchName, listBranches, switchBranch, createBranch, BranchError } from "./git-branch";
import { readGithubCounts, readCiStatus, resolveRepoRef, createGithubCache, GithubError } from "./github-read";
import { readDepsStatus, resolveDepsPath, createDepsCache, DepsError } from "./deps-read";
import { createInboxCache, readInbox } from "./github-inbox";
import { createActivityCache, buildActivityFeed } from "./activity-read";
import { createDeployCache, readDeployHealth, resolveDeployUrl, DeployError } from "./deploy-read";
import { createRailwayCache, readRailwayDeploy, resolveRailway, RailwayError } from "./railway-read";
import { isSafeId, listNotes, addNote, toggleNote, deleteNote } from "../../../lib/state/notes";
import { listProjectProfilesWithMigration, upsertProjectProfile, UnsupportedPortfolioSchemaVersionError } from "../../../lib/state/portfolio-profiles";
import type { ProjectProfile } from "../../../lib/portfolio-profile";
import { validateProjectProfile, describeValidation, validateWorkSessionAction, validateWorkSessionStart } from "../../../lib/state/validation";
import { TaskControlError, type TaskControl } from "../../../runner/task-orchestrator";
import { loadProjectCommands } from "../../../runner/project-commands";
import { processManager, SlotBusyError, type ProcessManager } from "../../../runner/process-manager";
import { createHttpSecurity, type HttpSecurity } from "./http-security";
import { PolicyError, PolicyService } from "../../../lib/policy/service";
import type { ProjectIntegrationsReader } from "../../../lib/integrations/types";
import { createProjectIntegrationsService } from "./project-integrations";
import { createSignalEvidenceReader } from "./signal-evidence";
import { createSignalService, SignalNotFoundError, type SignalService } from "./signal-service";
import { validateSignalAction } from "../../../lib/state/validation";
import { InvalidSignalActionError, UnsupportedSignalStateVersionError } from "../../../lib/state/signals";
import type { SignalFeed } from "../../../lib/signals/types";
import { createWorkSessionService, WorkSessionConflictError, WorkSessionNotFoundError, WorkSessionProjectNotFoundError, WorkSessionTransitionError, WorkSessionValidationError, type WorkSessionActionInput, type WorkSessionService } from "./work-session-service";
import { UnsupportedWorkSessionSchemaVersionError } from "../../../lib/state/work-sessions";
import { createClientPortfolioService, ClientPortfolioConflictError, ClientPortfolioNotFoundError, ClientPortfolioValidationError, type ClientPortfolioService } from "./client-portfolio-service";
import { ClientPortfolioStoreError, UnsupportedClientPortfolioVersionError } from "../../../lib/state/client-portfolio";
import type { ClientTaskContext } from "./client-portfolio-service";
import { createOrganizationService, OrganizationNotFoundError, OrganizationValidationError, type OrganizationService } from "./organization-service";
import { UnsupportedOrganizationVersionError } from "../../../lib/state/organization";
import { validateCompanyProfile, validateObjective } from "../../../lib/state/validation";
import type { Objective } from "../../../lib/organization";

export interface AppDependencies {
  integrations?: ProjectIntegrationsReader;
  signals?: SignalService;
  workSessions?: WorkSessionService;
  clientPortfolio?: ClientPortfolioService;
  organization?: OrganizationService;
}

type JsonBodyResult = { ok: true; value: unknown } | { ok: false; status: 400 | 413; error: string };

async function boundedJsonBody(c: Context, maxBytes = 32 * 1024): Promise<JsonBodyResult> {
  let raw: string;
  try { raw = await c.req.text(); }
  catch { return { ok: false, status: 400, error: "invalid JSON body" }; }
  if (Buffer.byteLength(raw, "utf8") > maxBytes) return { ok: false, status: 413, error: "request body is too large" };
  try { return { ok: true, value: JSON.parse(raw) as unknown }; }
  catch { return { ok: false, status: 400, error: "invalid JSON body" }; }
}

export function createApp(
  repoRoot: string = process.cwd(),
  taskDispatch: ((id: string) => void) | TaskControl = () => {},
  pm: ProcessManager = processManager,
  httpSecurity: HttpSecurity = createHttpSecurity(),
  dependencies: AppDependencies = {},
): Hono {
  const app = new Hono();
  const taskControl = typeof taskDispatch === "function" ? null : taskDispatch;
  const onTaskCreated = typeof taskDispatch === "function" ? taskDispatch : (id: string) => taskDispatch.enqueue(id);

  app.use("/api/*", httpSecurity.middleware);
  app.get("/api/session", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ token: httpSecurity.token });
  });

  const gitStatusCache = createGitStatusCache();
  const githubCache = createGithubCache();
  const depsCache = createDepsCache();
  const inboxCache = createInboxCache();
  const activityCache = createActivityCache();
  const deployCache = createDeployCache();
  const railwayCache = createRailwayCache();
  const integrations = dependencies.integrations ?? createProjectIntegrationsService(repoRoot, {
    readDependencies: (path) => depsCache.getObservation(path, () => readDepsStatus(path)),
  });
  const signals = dependencies.signals ?? createSignalService({
    reader: createSignalEvidenceReader(repoRoot, {
      integrations,
      inboxCache,
      readGit: (path) => gitStatusCache.get(path),
    }),
  });
  const workSessions = dependencies.workSessions ?? createWorkSessionService(repoRoot, {
    readRun: (runId) => pm.get(runId)?.record ?? null,
  });
  const clientPortfolio = dependencies.clientPortfolio ?? createClientPortfolioService(repoRoot);
  const organization = dependencies.organization ?? createOrganizationService();

  const workSessionErrorResponse = (c: Context, error: unknown) => {
    if (error instanceof WorkSessionValidationError) return c.json({ error: error.message }, 400);
    if (error instanceof WorkSessionProjectNotFoundError || error instanceof WorkSessionNotFoundError) return c.json({ error: error.message }, 404);
    if (error instanceof WorkSessionConflictError || error instanceof WorkSessionTransitionError || error instanceof StateLockConflictError || error instanceof UnsupportedWorkSessionSchemaVersionError) {
      return c.json({ error: error instanceof StateLockConflictError ? "work sessions are being updated; retry shortly" : error.message }, 409);
    }
    return c.json({ error: "work session state is unavailable" }, 500);
  };

  const clientPortfolioErrorResponse = (c: Context, error: unknown) => {
    if (error instanceof ClientPortfolioValidationError) return c.json({ error: error.message }, 400);
    if (error instanceof ClientPortfolioNotFoundError) return c.json({ error: error.message }, 404);
    if (error instanceof ClientPortfolioConflictError || error instanceof StateLockConflictError || error instanceof UnsupportedClientPortfolioVersionError) {
      return c.json({ error: error instanceof StateLockConflictError ? "client portfolio is being updated; retry shortly" : error.message }, 409);
    }
    if (error instanceof ClientPortfolioStoreError) return c.json({ error: "local client portfolio state is unavailable" }, 500);
    return c.json({ error: "local client portfolio state is unavailable" }, 500);
  };

  const organizationErrorResponse = (c: Context, error: unknown) => {
    if (error instanceof UnsupportedOrganizationVersionError) return c.json({ error: error.message }, 409);
    if (error instanceof OrganizationValidationError) return c.json({ error: error.message }, 400);
    if (error instanceof OrganizationNotFoundError) return c.json({ error: error.message }, 404);
    if (error instanceof StateLockConflictError) return c.json({ error: "organization state is being updated; retry shortly" }, 409);
    return c.json({ error: "local organization state is unavailable" }, 500);
  };

  app.get("/api/organization", (c) => {
    c.header("Cache-Control", "no-store");
    try { return c.json(organization.read()); }
    catch (error) { return organizationErrorResponse(c, error); }
  });

  app.put("/api/organization/company", async (c) => {
    c.header("Cache-Control", "no-store");
    const parsed = await boundedJsonBody(c, 16 * 1024);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    if (!validateCompanyProfile(parsed.value)) return c.json({ error: "invalid SURTEC company profile" }, 400);
    try { return c.json({ company: organization.saveCompany(parsed.value as never) }); }
    catch (error) { return organizationErrorResponse(c, error); }
  });

  app.post("/api/organization/objectives", async (c) => {
    c.header("Cache-Control", "no-store");
    const parsed = await boundedJsonBody(c, 16 * 1024);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) return c.json({ error: "invalid objective" }, 400);
    const input = parsed.value as Record<string, unknown>;
    const allowedKeys = new Set(["title", "desired_outcome", "success_criteria", "status", "horizon", "priority", "target_date", "parent_objective_id"]);
    if (Object.keys(input).some((key) => !allowedKeys.has(key))) return c.json({ error: "invalid objective" }, 400);
    const candidate = {
      ...input, schema_version: 1, id: "objective-validation", company_id: "surtec", project_ids: [], owner: "marcos", last_reviewed_at: null,
    };
    if (!validateObjective(candidate)) return c.json({ error: "invalid objective" }, 400);
    try {
      const objective = organization.createObjective(input as unknown as Parameters<OrganizationService["createObjective"]>[0]);
      return c.json({ objective }, 201);
    } catch (error) { return organizationErrorResponse(c, error); }
  });

  app.put("/api/organization/objectives/:id", async (c) => {
    c.header("Cache-Control", "no-store");
    const parsed = await boundedJsonBody(c, 16 * 1024);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    if (!validateObjective(parsed.value) || (parsed.value as Objective).id !== c.req.param("id")) return c.json({ error: "invalid objective" }, 400);
    try { return c.json({ objective: organization.saveObjective(parsed.value as Objective) }); }
    catch (error) { return organizationErrorResponse(c, error); }
  });

  app.put("/api/organization/projects/:id/objectives", async (c) => {
    c.header("Cache-Control", "no-store");
    const parsed = await boundedJsonBody(c, 8 * 1024);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) return c.json({ error: "invalid project objective links" }, 400);
    const body = parsed.value as { objective_ids?: unknown; primary_objective_id?: unknown };
    if (!Array.isArray(body.objective_ids) || body.objective_ids.some((id) => typeof id !== "string")
      || !(body.primary_objective_id === null || typeof body.primary_objective_id === "string")) return c.json({ error: "invalid project objective links" }, 400);
    try {
      const links = organization.setProjectObjectives(c.req.param("id"), body.objective_ids as string[], body.primary_objective_id as string | null);
      return c.json({ links, organization: organization.read() });
    } catch (error) { return organizationErrorResponse(c, error); }
  });

  app.get("/api/clients", (c) => {
    c.header("Cache-Control", "no-store");
    try { return c.json({ clients: clientPortfolio.listClients() }); }
    catch (error) { return clientPortfolioErrorResponse(c, error); }
  });

  app.get("/api/clients/:id", (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const client = clientPortfolio.getClient(c.req.param("id"));
      return client ? c.json({ client }) : c.json({ error: "client was not found" }, 404);
    } catch (error) { return clientPortfolioErrorResponse(c, error); }
  });

  app.post("/api/clients", async (c) => {
    c.header("Cache-Control", "no-store");
    const parsed = await boundedJsonBody(c, 8 * 1024);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    try { return c.json({ client: clientPortfolio.createClient(parsed.value) }, 201); }
    catch (error) { return clientPortfolioErrorResponse(c, error); }
  });

  app.put("/api/clients/:id", async (c) => {
    c.header("Cache-Control", "no-store");
    const parsed = await boundedJsonBody(c, 8 * 1024);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    try { return c.json({ client: clientPortfolio.updateClient(c.req.param("id"), parsed.value) }); }
    catch (error) { return clientPortfolioErrorResponse(c, error); }
  });

  app.get("/api/commitments", (c) => {
    c.header("Cache-Control", "no-store");
    try { return c.json({ commitments: clientPortfolio.listCommitments() }); }
    catch (error) { return clientPortfolioErrorResponse(c, error); }
  });

  app.post("/api/commitments", async (c) => {
    c.header("Cache-Control", "no-store");
    const parsed = await boundedJsonBody(c, 24 * 1024);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    try { return c.json({ commitment: clientPortfolio.createCommitment(parsed.value) }, 201); }
    catch (error) { return clientPortfolioErrorResponse(c, error); }
  });

  app.put("/api/commitments/:id", async (c) => {
    c.header("Cache-Control", "no-store");
    const parsed = await boundedJsonBody(c, 24 * 1024);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    try { return c.json({ commitment: clientPortfolio.updateCommitment(c.req.param("id"), parsed.value) }); }
    catch (error) { return clientPortfolioErrorResponse(c, error); }
  });

  app.get("/api/projects/:id/client-context-options", (c) => {
    c.header("Cache-Control", "no-store");
    try { return c.json(clientPortfolio.contextOptions(c.req.param("id"))); }
    catch (error) { return clientPortfolioErrorResponse(c, error); }
  });

  app.get("/api/sessions", (c) => {
    c.header("Cache-Control", "no-store");
    try { return c.json(workSessions.snapshot()); }
    catch (error) { return workSessionErrorResponse(c, error); }
  });

  app.post("/api/sessions", async (c) => {
    c.header("Cache-Control", "no-store");
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    if (!validateWorkSessionStart(body)) return c.json({ error: `invalid work session start: ${describeValidation(validateWorkSessionStart.errors)}` }, 400);
    try { return c.json({ session: workSessions.start(body as unknown as Parameters<WorkSessionService["start"]>[0]) }, 201); }
    catch (error) { return workSessionErrorResponse(c, error); }
  });

  app.post("/api/sessions/:id/action", async (c) => {
    c.header("Cache-Control", "no-store");
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    if (!validateWorkSessionAction(body)) return c.json({ error: `invalid work session action: ${describeValidation(validateWorkSessionAction.errors)}` }, 400);
    try {
      const input = body as WorkSessionActionInput;
      let session;
      switch (input.action) {
        case "add-note": session = workSessions.addNote(c.req.param("id"), input.note); break;
        case "associate": session = workSessions.associate(c.req.param("id"), input.task_ids, input.run_ids); break;
        case "pause": session = workSessions.pause(c.req.param("id"), input.next_action); break;
        case "resume": session = workSessions.resume(c.req.param("id")); break;
        case "complete": session = workSessions.complete(c.req.param("id"), input.result_summary, input.next_action); break;
      }
      return c.json({ session });
    } catch (error) { return workSessionErrorResponse(c, error); }
  });

  app.get("/api/overview", (c) => {
    try {
      const root = process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
      const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
      const discovered = discoverProjects(root, ignore);
      const statusByPath = new Map(discovered.map((d) => [d.path, gitStatusCache.get(d.path)]));
      const config = loadProjectConfig(repoRoot);
      const portfolio = assemblePortfolio(discovered, statusByPath, config);
      const overview = buildOverview(portfolio, listTasks(), listProjectOverrides());
      return c.json(overview);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get("/api/today", async (c) => {
    const date = c.req.query("date");
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: "date must use YYYY-MM-DD" }, 400);
    c.header("Cache-Control", "no-store");
    try {
      const tasks = listTasks();
      const warnings: string[] = [];
      const events = tasks.flatMap((task) => {
        try {
          return readTaskEvents(task.envelope.id);
        } catch {
          warnings.push(`Task ${task.envelope.id} has an unreadable event stream.`);
          return [];
        }
      });
      let signalFeed: SignalFeed | null = null;
      const signalWarnings: string[] = [];
      try {
        signalFeed = await signals.read();
      } catch {
        signalWarnings.push("Portfolio intelligence is temporarily unavailable; Codex task activity remains available.");
      }
      let sessionState;
      try { sessionState = workSessions.snapshot(); }
      catch { sessionState = { available: false, unavailable_reason: "Work sessions are temporarily unavailable; task activity remains available.", active: [], paused: [], completed: [] }; }
      return c.json(buildToday(tasks, events, { date, warnings, signalFeed, signalWarnings, sessions: sessionState }));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get("/api/tasks/:id", (c) => {
    const rec = readTask(c.req.param("id"));
    if (!rec) return c.json({ error: "not found" }, 404);
    return c.json(rec);
  });

  app.get("/api/tasks/:id/detail", (c) => {
    try {
      const id = c.req.param("id");
      const rec = readTask(id);
      if (!rec) return c.json({ error: "not found" }, 404);
      return c.json(buildTaskDetail(rec, readTaskEvents(id), repoRoot));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get("/api/tasks/:id/events", (c) => {
    try {
      const id = c.req.param("id");
      if (!readTask(id)) return c.json({ error: "not found" }, 404);
      return c.json({ events: readTaskEvents(id) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.get("/api/dispatch-options", (c) => {
    try {
      return c.json(new PolicyService(repoRoot).dispatchOptions());
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/tasks", async (c) => {
    const parsed = await boundedJsonBody(c, 32 * 1024);
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    const body = parsed.value;
    if (typeof body !== "object" || body === null || Array.isArray(body)) return c.json({ error: "invalid task body" }, 400);
    try {
      const taskInput = body as { project: string; agent: string; instructions: string; sandbox?: string; self_verify?: boolean; client_context_categories?: unknown };
      const clientContext: ClientTaskContext | null = Object.hasOwn(body as object, "client_context_categories")
        ? clientPortfolio.buildTaskContext(String(taskInput.project ?? ""), taskInput.client_context_categories)
        : null;
      const { id } = createTask(
        { ...taskInput, client_context: clientContext },
        repoRoot,
      );
      onTaskCreated(id);
      return c.json({ id }, 201);
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
      if (err instanceof ClientPortfolioValidationError || err instanceof ClientPortfolioNotFoundError
        || err instanceof ClientPortfolioConflictError || err instanceof ClientPortfolioStoreError) {
        return clientPortfolioErrorResponse(c, err);
      }
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/tasks/:id/cancel", (c) => {
    if (!taskControl) return c.json({ error: "task worker is unavailable" }, 503);
    try {
      return c.json({ task: taskControl.cancel(c.req.param("id")) });
    } catch (err) {
      if (err instanceof TaskControlError) return c.json({ error: err.message }, err.status);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/tasks/:id/retry", (c) => {
    if (!taskControl) return c.json({ error: "task worker is unavailable" }, 503);
    try {
      return c.json({ task: taskControl.retry(c.req.param("id")) });
    } catch (err) {
      if (err instanceof TaskControlError) return c.json({ error: err.message }, err.status);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/tasks/:id/approve", (c) => {
    try {
      return c.json({ decision: approveTask(c.req.param("id"), repoRoot) });
    } catch (err) {
      // TaskNotFoundError extends ReviewError — check the subclass first (404 vs 400).
      if (err instanceof TaskNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof ReviewError) return c.json({ error: err.message }, 400);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/tasks/:id/reject", (c) => {
    try {
      return c.json({ decision: rejectTask(c.req.param("id"), repoRoot) });
    } catch (err) {
      // TaskNotFoundError extends ReviewError — check the subclass first (404 vs 400).
      if (err instanceof TaskNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof ReviewError) return c.json({ error: err.message }, 400);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/projects/:id/open", async (c) => {
    let body: { target?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      return c.json(openProject(repoRoot, c.req.param("id"), String(body?.target ?? "")));
    } catch (err) {
      if (err instanceof OpenError) return c.json({ error: err.message }, err.status as 400 | 404 | 500);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/projects/:id/git", async (c) => {
    let body: { action?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const id = c.req.param("id");
    try {
      const result = runGitSync(repoRoot, id, String(body?.action ?? ""));
      if (result.ok) {
        // Bust the cached status for this repo so ahead/behind refreshes on the next overview poll.
        const root = process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
        const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
        const proj = discoverProjects(root, ignore).find((p) => p.id === id);
        if (proj) gitStatusCache.invalidate(proj.path);
        integrations.invalidate(id);
      }
      return c.json(result);
    } catch (err) {
      if (err instanceof GitSyncError) return c.json({ error: err.message }, err.status as 400 | 404);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get("/api/projects/:id/branches", (c) => {
    try {
      return c.json(listBranches(repoRoot, c.req.param("id")));
    } catch (err) {
      if (err instanceof BranchError) return c.json({ error: err.message }, err.status as 404);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/projects/:id/branch", async (c) => {
    let body: { op?: string; name?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const id = c.req.param("id");
    const op = String(body?.op ?? "");
    const name = String(body?.name ?? "");
    if (op !== "switch" && op !== "create") return c.json({ error: `invalid op: ${op}` }, 400);
    if (!validateBranchName(name)) return c.json({ error: `invalid branch name: ${name}` }, 400);
    try {
      const result = op === "switch"
        ? switchBranch(repoRoot, id, name)
        : createBranch(repoRoot, id, name);
      if (result.ok) {
        const root = process.env.SURTEC_PROJECTS_ROOT ?? dirname(repoRoot);
        const ignore = [...DEFAULT_IGNORE, ...(process.env.SURTEC_PROJECTS_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
        const proj = discoverProjects(root, ignore).find((p) => p.id === id);
        if (proj) gitStatusCache.invalidate(proj.path);
        integrations.invalidate(id);
      }
      return c.json(result);
    } catch (err) {
      if (err instanceof BranchError) return c.json({ error: err.message }, err.status as 400 | 404);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get("/api/projects/:id/github", (c) => {
    try {
      const ref = resolveRepoRef(repoRoot, c.req.param("id"));
      if (!ref) return c.json({ ok: false, prs: 0, issues: 0, ci: "unknown", error: "no es un repo de GitHub" });
      // Key by slug + branch so two projects sharing a GitHub slug but with different default branches
      // never serve each other's CI run.
      return c.json(githubCache.get(`${ref.slug}::${ref.branch}`, () => {
        const counts = readGithubCounts(ref.slug);
        const ci = readCiStatus(ref.slug, ref.branch);
        return { ...counts, ci: ci.state };
      }));
    } catch (err) {
      if (err instanceof GithubError) return c.json({ error: err.message }, err.status as 404);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get("/api/projects/:id/integrations", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const id = c.req.param("id");
      if (c.req.query("refresh") === "true") {
        const project = new PolicyService(repoRoot).project(id);
        if (project.repo_path) depsCache.invalidate(project.repo_path);
        integrations.invalidate(id);
      }
      return c.json(await integrations.read(id, { includeDependencies: true }));
    } catch (err) {
      if (err instanceof PolicyError) {
        const status = err.code === "invalid-input" ? 400 : err.code === "not-found" ? 404 : err.code === "denied" ? 403 : 500;
        return c.json({ error: err.message }, status);
      }
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get("/api/inbox", async (c) => {
    try {
      return c.json(await inboxCache.get("inbox", () => readInbox(repoRoot)));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get("/api/activity", (c) => {
    try {
      return c.json(activityCache.get("activity", () => buildActivityFeed(repoRoot)));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get("/api/projects/:id/deploy", async (c) => {
    try {
      const url = resolveDeployUrl(repoRoot, c.req.param("id"));
      if (!url) return c.json({ configured: false, url: null, state: null, status: null, ms: null });
      const h = await deployCache.get(url, () => readDeployHealth(url));
      return c.json({ configured: true, url, ...h });
    } catch (err) {
      if (err instanceof DeployError) return c.json({ error: err.message }, err.status as 404);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get("/api/projects/:id/railway", async (c) => {
    try {
      const ids = resolveRailway(repoRoot, c.req.param("id"));
      const token = process.env.RAILWAY_TOKEN;
      if (!ids || !token) return c.json({ configured: false, ok: false, state: null, at: null, url: null });
      const r = await railwayCache.get(ids.service_id, () => readRailwayDeploy(ids, token));
      return c.json({ configured: true, ...r });
    } catch (err) {
      if (err instanceof RailwayError) return c.json({ error: err.message }, err.status as 404);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get("/api/projects/:id/deps", (c) => {
    try {
      const path = resolveDepsPath(repoRoot, c.req.param("id"));
      return c.json(depsCache.get(path, () => readDepsStatus(path)));
    } catch (err) {
      if (err instanceof DepsError) return c.json({ error: err.message }, err.status as 404);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get("/api/projects/:id/notes", (c) => {
    const id = c.req.param("id");
    if (!isSafeId(id)) return c.json({ error: "invalid id" }, 400);
    return c.json({ notes: listNotes(id) });
  });

  app.post("/api/projects/:id/notes", async (c) => {
    const id = c.req.param("id");
    if (!isSafeId(id)) return c.json({ error: "invalid id" }, 400);
    let body: { text?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const text = String(body?.text ?? "").trim();
    if (!text || text.length > 500) return c.json({ error: "invalid text" }, 400);
    return c.json({ notes: addNote(id, text) });
  });

  app.post("/api/projects/:id/notes/:noteId", async (c) => {
    const id = c.req.param("id");
    const noteId = c.req.param("noteId");
    if (!isSafeId(id) || !isSafeId(noteId)) return c.json({ error: "invalid id" }, 400);
    let body: { action?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const action = String(body?.action ?? "");
    if (action === "toggle") return c.json({ notes: toggleNote(id, noteId) });
    if (action === "delete") return c.json({ notes: deleteNote(id, noteId) });
    return c.json({ error: `invalid action: ${action}` }, 400);
  });

  app.get("/api/portfolio/profiles", (c) => {
    c.header("Cache-Control", "no-store");
    try {
      return c.json(listProjectProfilesWithMigration());
    } catch (err) {
      const status = err instanceof UnsupportedPortfolioSchemaVersionError ? 409 : 500;
      return c.json({ error: (err as Error).message }, status);
    }
  });

  app.post("/api/projects/:id/profile", async (c) => {
    c.header("Cache-Control", "no-store");
    const id = c.req.param("id");
    if (!isSafeId(id)) return c.json({ error: "invalid id" }, 400);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    if (!validateProjectProfile(body)) {
      return c.json({ error: `invalid project profile: ${describeValidation(validateProjectProfile.errors)}` }, 400);
    }
    const profile = body as ProjectProfile;
    if (profile.project_id !== id) return c.json({ error: "profile project_id must match the route project ID" }, 400);
    try {
      upsertProjectProfile(profile);
      return c.json({ profile });
    } catch (err) {
      const status = err instanceof UnsupportedPortfolioSchemaVersionError ? 409 : 500;
      return c.json({ error: (err as Error).message }, status);
    }
  });

  app.get("/api/signals", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      return c.json(await signals.read());
    } catch (err) {
      if (err instanceof UnsupportedSignalStateVersionError) return c.json({ error: err.message }, 409);
      return c.json({ error: "signal feed is unavailable" }, 500);
    }
  });

  app.get("/api/feedback/metrics", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const feed = await signals.read();
      const humanState = readSignalHumanState();
      return c.json(buildFeedbackMetrics({
        signalActions: Object.values(humanState.records),
        signals: feed.signals,
        tasks: listTasks(),
        workSessions: listWorkSessions(),
        now: new Date(),
      }));
    } catch {
      return c.json({ error: "local feedback metrics are unavailable" }, 500);
    }
  });

  app.post("/api/signals/:id/action", async (c) => {
    c.header("Cache-Control", "no-store");
    const id = c.req.param("id");
    if (!/^sig_[a-f0-9]{24}$/.test(id)) return c.json({ error: "invalid signal id" }, 400);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    if (!validateSignalAction(body)) return c.json({ error: "invalid signal action" }, 400);
    try {
      return c.json(await signals.act(id, body));
    } catch (err) {
      if (err instanceof SignalNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof InvalidSignalActionError) return c.json({ error: err.message }, 400);
      if (err instanceof UnsupportedSignalStateVersionError) return c.json({ error: err.message }, 409);
      return c.json({ error: "signal state could not be updated" }, 500);
    }
  });

  // --- Procesos (B.2): run project commands from the dashboard ---
  app.get("/api/runs", (c) => c.json({ runs: pm.list() }));

  app.get("/api/projects/:id/commands", (c) => {
    const id = c.req.param("id");
    const commands = loadProjectCommands(repoRoot, id);
    const running = pm.list().filter((r) => r.projectId === id && r.status === "running");
    return c.json({
      commands,
      running: {
        dev: running.find((r) => r.kind === "dev")?.runId ?? null,
        oneshot: running.find((r) => r.kind === "oneshot")?.runId ?? null,
      },
    });
  });

  app.post("/api/projects/:id/run", async (c) => {
    const id = c.req.param("id");
    let body: { command?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    const key = String(body?.command ?? "");

    const project = loadRegistryProjects(repoRoot).find((p) => p.id === id);
    const cwd = project?.repo_path ?? null;
    if (!cwd) return c.json({ error: `unknown project: ${id}` }, 404);

    const command = (loadProjectCommands(repoRoot, id) as Record<string, string | undefined>)[key];
    if (!key || !command) return c.json({ error: `command not configured: ${key}` }, 400);

    const kind = key === "dev" ? "dev" : "oneshot";
    try {
      const rec = pm.start({ projectId: id, kind, command, cwd });
      return c.json({ runId: rec.runId }, 201);
    } catch (err) {
      if (err instanceof SlotBusyError) return c.json({ error: err.message }, 409);
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/api/runs/:runId/stop", (c) => {
    pm.stop(c.req.param("runId"));
    return c.json({ ok: true });
  });

  app.get("/api/runs/:runId", (c) => {
    const r = pm.get(c.req.param("runId"));
    return r ? c.json(r) : c.json({ error: "not found" }, 404);
  });

  app.get("/api/runs/:runId/stream", (c) =>
    streamSSE(c, async (stream) => {
      const runId = c.req.param("runId");
      const snap = pm.get(runId);
      if (!snap) { await stream.writeSSE({ event: "error", data: "not found" }); return; }
      await stream.writeSSE({ event: "snapshot", data: JSON.stringify({ type: "snapshot", ...snap }) });
      if (snap.record.status !== "running") return; // already terminal: snapshot is enough
      await new Promise<void>((resolve) => {
        const unsub = pm.subscribe(runId, (e) => {
          stream.writeSSE({ event: e.type, data: JSON.stringify(e) })
            .then(() => { if (e.type === "status") { unsub(); resolve(); } })
            .catch(() => { unsub(); resolve(); });
        });
        stream.onAbort(() => { unsub(); resolve(); });
        // Guard against a race: the run may have terminated between the get() above
        // and subscribe() here, in which case the terminal event already fired and we
        // would otherwise hang. Re-check and emit the final status ourselves.
        const after = pm.get(runId);
        if (after && after.record.status !== "running") {
          stream.writeSSE({ event: "status", data: JSON.stringify({ type: "status", record: after.record }) })
            .finally(() => { unsub(); resolve(); });
        }
      });
    }),
  );

  return app;
}

// Server bootstrap lives in ./serve.ts (so this module only exports createApp and
// imports cleanly in tests). `pnpm dev:api` / `pnpm start` run ./serve.ts.
