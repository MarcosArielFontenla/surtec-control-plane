import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile, unlink, readdir, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "playwright";
import { parse, stringify } from "yaml";
import type { HarnessResponse } from "../dashboard/src/ui/api";
import type { ContextPreview, ContextPreviewRequest } from "../dashboard/src/server/context-service";
import type { TaskRecord } from "../lib/state/types";

// Both promises acquire rejection handlers before the action begins. Closing
// the page after a failed click cannot leak an unhandled pending response.
export async function observeResponse(page: Pick<Page, "waitForResponse">, path: string, method: string, action: () => Promise<unknown>) {
  const [response] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === method, { timeout: 10_000 }),
    Promise.resolve().then(action),
  ]);
  return response;
}

export async function cleanupSmoke(resources: { browser?: () => Promise<unknown>; vite?: () => Promise<unknown>; api?: () => Promise<boolean>; root: string | null }) {
  const result = { browser_closed: true, vite_closed: true, api_stopped: true, workspace_removed: false, failures: [] as string[] };
  for (const resource of ["browser", "vite", "api"] as const) {
    try {
      const closed = await resources[resource]?.();
      if (resource === "api" && closed === false) result.api_stopped = false;
    } catch {
      result.failures.push(resource);
      if (resource === "browser") result.browser_closed = false;
      if (resource === "vite") result.vite_closed = false;
      if (resource === "api") result.api_stopped = false;
    }
  }
  if (resources.root && result.api_stopped && result.browser_closed && result.vite_closed) {
    try {
      const root = resolve(resources.root);
      assert.ok(isInside(await realpath(tmpdir()), await realpath(root)) && basename(root).startsWith("surtec-local-dashboard-"));
      assert.equal((await lstat(root)).isSymbolicLink(), false, "cleanup refuses a linked fixture root");
      const dependencyLink = join(root, "runtime/node_modules");
      const dependency = await lstat(dependencyLink).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
      if (dependency) {
        assert.ok(dependency.isSymbolicLink(), "cleanup refuses an unexpected dependency directory");
        await unlink(dependencyLink);
      }
      await rm(root, { recursive: true, force: true });
      result.workspace_removed = true;
    } catch { result.failures.push("workspace"); }
  }
  return result;
}

export async function harnessTreeHash(root: string, excluded: readonly string[] = []): Promise<string> {
  const records: string[] = [];
  async function walk(path: string) {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (excluded.includes(child)) continue;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) records.push(`${child}:${createHash("sha256").update(await readFile(join(root, child))).digest("hex")}`);
      else throw new Error("Synthetic project hash refuses links");
    }
  }
  await walk("");
  return createHash("sha256").update(records.sort().join("\n")).digest("hex");
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profileProjectId = "harness-smoke-project";
const profileClientId = "harness-smoke-client";
const issueProjectId = "appointment-manager";
const syntheticClientId = "client-synthetic";

interface ApiProcess {
  child: ChildProcess;
  output: string;
  exited: Promise<void>;
}

interface MigrationReport {
  migration: string;
  project_count: number;
  client_categories_migrated: number;
  personal_categories_preserved: number;
  source_sha256: string;
  backup_id: string;
}

interface MigratedProfile {
  schema_version: number;
  project_id: string;
  kind: string;
  client_id: string | null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isInside(parent: string, target: string): boolean {
  const path = relative(resolve(parent), resolve(target));
  return path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "temporary listener has a TCP address");
  const port = (address as AddressInfo).port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

function isolatedApiEnvironment(port: number, stateRoot: string, projectsRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const pathValue = process.env.PATH ?? process.env.Path;
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (pathValue) environment.PATH = pathValue;
  if (systemRoot) environment.SystemRoot = systemRoot;
  for (const key of ["TEMP", "TMP", "WINDIR", "windir"] as const) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  environment.NODE_ENV = "test";
  environment.PORT = String(port);
  environment.SURTEC_STATE_DIR = stateRoot;
  environment.SURTEC_PROJECTS_ROOT = projectsRoot;
  environment.SURTEC_PROJECTS_IGNORE = "";
  environment.SURTEC_SMOKE_DISABLE_EXTERNAL_READS = "1";
  environment.SURTEC_SMOKE_FIXTURE_ROOT = dirname(stateRoot);
  // Defense in depth: even an accidental default-executor fallback cannot
  // launch an installed paid runtime from this fixture.
  environment.SURTEC_CODEX_BIN = join(dirname(stateRoot), "forbidden-paid-runtime");
  return environment;
}

function startApi(port: number, stateRoot: string, projectsRoot: string): ApiProcess {
  const runtimeRoot = join(dirname(stateRoot), "runtime");
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/fixtures/local-issue-api.ts"], {
    cwd: runtimeRoot,
    env: isolatedApiEnvironment(port, stateRoot, projectsRoot),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const handle: ApiProcess = {
    child,
    output: "",
    exited: new Promise<void>((resolveExit) => {
      child.once("exit", () => resolveExit());
      child.once("error", (error) => {
        handle.output = `${handle.output}\n${error.message}`.slice(-8_000);
        resolveExit();
      });
    }),
  };
  const collect = (chunk: Buffer | string) => { handle.output = `${handle.output}${chunk.toString()}`.slice(-8_000); };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  return handle;
}

async function waitForApi(api: ApiProcess, baseUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastStatus = "not yet reachable";
  while (Date.now() < deadline) {
    if (api.child.exitCode !== null) throw new Error(`isolated API exited before readiness (${api.child.exitCode}): ${api.output}`);
    try {
      const response = await fetch(`${baseUrl}/api/session`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastStatus = `HTTP ${response.status}`;
    } catch (error) {
      lastStatus = (error as Error).message;
    }
    await delay(200);
  }
  throw new Error(`isolated API did not become ready (${lastStatus}): ${api.output}`);
}

async function stopApi(api: ApiProcess): Promise<boolean> {
  if (api.child.exitCode !== null) return true;
  api.child.kill("SIGTERM");
  const stoppedGracefully = await Promise.race([api.exited.then(() => true), delay(8_000).then(() => false)]);
  if (stoppedGracefully) return true;
  api.child.kill("SIGKILL");
  return Promise.race([api.exited.then(() => true), delay(3_000).then(() => false)]);
}

async function launchBrowser(): Promise<Browser> {
  try { return await chromium.launch({ headless: true }); }
  catch (error) {
    if (process.platform !== "win32") throw error;
    return chromium.launch({ headless: true, channel: "msedge" });
  }
}

function v1Profile(projectId: string, kind: "personal" | "client") {
  return {
    schema_version: 1,
    project_id: projectId,
    kind,
    lifecycle: "active",
    priority: 2,
    criticality: "medium",
    current_goal: "Validate isolated dashboard acceptance.",
    next_action: "Confirm local persistence after restart.",
    deadline: null,
    client_id: kind === "client" ? syntheticClientId : null,
    last_reviewed_at: null,
    tags: ["synthetic", "phase-k"],
  };
}

async function createSyntheticGitProject(projectsRoot: string, projectId: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const projectPath = join(projectsRoot, projectId);
  await mkdir(projectPath, { recursive: true });
  execFileSync("git", ["init", "--quiet", projectPath], { cwd: repoRoot, env: environment, windowsHide: true });
}

async function createObjective(page: Page, input: { title: string; status: "active" | "paused" | "achieved"; date: string | null }): Promise<Record<string, unknown>> {
  const form = page.locator(".organization-objective-form");
  await form.locator("label").filter({ hasText: "Título" }).locator("input").fill(input.title);
  await form.locator("label").filter({ hasText: "Resultado deseado" }).locator("input").fill(`Synthetic outcome for ${input.title}.`);
  await form.locator("label").filter({ hasText: "Criterios de éxito" }).locator("textarea").fill(`Synthetic success criterion for ${input.title}.`);
  await form.locator("label").filter({ hasText: "Estado" }).locator("select").selectOption(input.status);
  await form.locator("label").filter({ hasText: "Horizonte" }).locator("select").selectOption("quarter");
  await form.locator("label").filter({ hasText: "Prioridad" }).locator("select").selectOption("2");
  if (input.date) await form.locator("label").filter({ hasText: "Fecha objetivo" }).locator("input").fill(input.date);
  const response = await observeResponse(page, "/api/organization/objectives", "POST", () => page.getByRole("button", { name: "Crear objetivo", exact: true }).click());
  assert.equal(response.status(), 201, `objective creation returns 201 (${input.status})`);
  const body = await response.json() as { objective?: Record<string, unknown> };
  assert.ok(body.objective && typeof body.objective.id === "string", "created objective has a generated ID");
  await page.getByText("Objetivo guardado en el estado local.", { exact: true }).waitFor();
  return body.objective;
}

async function readApiJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200, `GET ${new URL(url).pathname} returns 200`);
  return await response.json() as T;
}

async function waitForTask(apiUrl: string, id: string): Promise<TaskRecord> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const task = await readApiJson<TaskRecord>(`${apiUrl}/api/tasks/${id}`);
    if (task.lifecycle === "finished") return task;
    await delay(200);
  }
  throw new Error("Synthetic task did not finish within its bounded acceptance deadline");
}

async function main(): Promise<void> {
  let stage = "allocate isolated workspace";
  let api: ApiProcess | null = null;
  let vite: ViteDevServer | null = null;
  let browser: Browser | null = null;
  let tempRoot: string | null = null;

  try {
    tempRoot = await mkdtemp(join(tmpdir(), "surtec-local-dashboard-"));
    assert.ok(isInside(tmpdir(), tempRoot), "test-owned workspace is a child of the OS temp directory");
    const stateRoot = join(tempRoot, "state");
    const projectsRoot = join(tempRoot, "projects");
    await mkdir(join(stateRoot, "portfolio"), { recursive: true });
    await mkdir(projectsRoot, { recursive: true });
    const port = await reserveLoopbackPort();
    const apiUrl = `http://127.0.0.1:${port}`;
    const environment = isolatedApiEnvironment(port, stateRoot, projectsRoot);

    stage = "create synthetic repositories and legacy profile document";
    await createSyntheticGitProject(projectsRoot, profileProjectId, environment);
    await createSyntheticGitProject(projectsRoot, profileClientId, environment);
    await createSyntheticGitProject(projectsRoot, issueProjectId, environment);
    // Privileged registry and Git identity belong only to this disposable fixture.
    await mkdir(join(tempRoot, "registry"), { recursive: true });
    for (const source of ["registry/agents.yml", "registry/agent-roles.yml", "registry/context-policy.yml", "evals"]) await cp(join(repoRoot, source), join(tempRoot, source), { recursive: true });
    const contextConfig = parse(await readFile(join(tempRoot, "registry/context-policy.yml"), "utf8"));
    contextConfig.routes = [{ id: "synthetic-required-source", role_ids: [], task_kinds: [], affected_domains: [], paths: ["docs/smoke-context.md"], required: true }];
    await writeFile(join(tempRoot, "registry/context-policy.yml"), stringify(contextConfig));
    await writeFile(join(tempRoot, "registry", "projects.yml"), `projects:\n  ${profileProjectId}:\n    status: active\n    allowed_agents: [tech-lead, frontend-engineer]\n  ${profileClientId}:\n    status: active\n    allowed_agents: [tech-lead, frontend-engineer]\n  ${issueProjectId}:\n    allowed_agents: [frontend-engineer, tech-lead]\n    sandbox:\n      default: workspace-write\n    commands:\n      test: node --version\n`);
    // Explicit synthetic canonical source and project scaffolds; only reviewed public files.
    const canonicalRoot = join(tempRoot, "canonical");
    for (const destination of [canonicalRoot, join(projectsRoot, profileProjectId), join(projectsRoot, profileClientId)]) {
      await mkdir(destination, { recursive: true });
      for (const source of ["AGENTS.md", ".agents", "docs"]) await cp(join(repoRoot, source), join(destination, source), { recursive: true });
    }
    await cp(join(repoRoot, "registry/harness-manifests"), join(tempRoot, "registry/harness-manifests"), { recursive: true });
    const harnessRegistry = parse(await readFile(join(repoRoot, "registry/harness-sources.yml"), "utf8"));
    harnessRegistry.source.root = "canonical";
    harnessRegistry.projects[profileProjectId] = { ownership: [{ path: "AGENTS.md", classification: "user-owned", evidence: "Synthetic human ownership confirmation" }], testing_policy: { schema_version: 1, mode: "functional", runner_id: null, requires_red_evidence: false, applicable_task_kinds: [] }, review_policy: "human-required", backup_ready: false, rollback_ready: false, validation: null };
    await writeFile(join(tempRoot, "registry/harness-sources.yml"), stringify(harnessRegistry));
    await unlink(join(projectsRoot, profileClientId, ".agents/scripts/validate-spec.ps1"));
    for (const id of [profileProjectId, profileClientId, issueProjectId]) {
      await mkdir(join(projectsRoot, id, "docs"), { recursive: true });
      await writeFile(join(projectsRoot, id, "docs/smoke-context.md"), "Synthetic private project source body.\n");
    }
    await writeFile(join(tempRoot, "AGENTS.md"), "Synthetic fixture: do not publish, deploy or invoke a paid runtime.\n");
    // Copy only public runtime source. The managed Git adapter derives its empty
    // hooks directory from its module location; this keeps even that directory
    // temporary. Never copy normal state, auth, logs or sibling repositories.
    const runtimeRoot = join(tempRoot, "runtime");
    for (const source of ["lib", "runner", "dashboard/src/server", "schemas", "scripts/fixtures/local-issue-api.ts", "package.json"]) {
      await cp(join(repoRoot, source), join(runtimeRoot, source), { recursive: true });
    }
    await symlink(join(repoRoot, "node_modules"), join(runtimeRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const syntheticRepo = join(projectsRoot, issueProjectId);
    await writeFile(join(syntheticRepo, "README.md"), "Synthetic acceptance repository.\n");
    for (const args of [["config", "user.name", "Synthetic Smoke"], ["config", "user.email", "synthetic@example.test"], ["add", "README.md", "docs/smoke-context.md"], ["commit", "--quiet", "-m", "Synthetic fixture baseline"]]) {
      execFileSync("git", ["-C", syntheticRepo, ...args], { env: environment, windowsHide: true });
    }
    const legacyProfiles = {
      schema_version: 1,
      projects: {
        [profileProjectId]: v1Profile(profileProjectId, "personal"),
        [profileClientId]: v1Profile(profileClientId, "client"),
      },
    };
    const legacyProfileBytes = Buffer.from(`${JSON.stringify(legacyProfiles, null, 2)}\n`, "utf8");
    const profilesPath = join(stateRoot, "portfolio", "projects.json");
    await writeFile(profilesPath, legacyProfileBytes, { flag: "wx", mode: 0o600 });
    const syntheticClient = { id: syntheticClientId, display_name: "Synthetic private client identity", status: "active", criticality: "low", sla_note: "Synthetic service policy", next_review_date: null, confidential_notes: "Synthetic confidential client body", created_at: "2026-10-01T12:00:00Z", updated_at: "2026-10-01T12:00:00Z" };
    await writeFile(join(stateRoot, "portfolio/clients.json"), JSON.stringify({ schema_version: 1, clients: { [syntheticClientId]: syntheticClient }, commitments: {} }));

    stage = "start real local API and Vite dashboard";
    api = startApi(port, stateRoot, projectsRoot);
    await waitForApi(api, apiUrl);
    const unauthorizedWrite = await fetch(`${apiUrl}/api/organization/company`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(unauthorizedWrite.status, 403, "local API rejects a write without its in-memory session token");

    stage = "migrate legacy portfolio profiles and verify the backup";
    const migrationResponse = await fetch(`${apiUrl}/api/portfolio/profiles`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(migrationResponse.status, 200, "legacy portfolio migration endpoint returns 200");
    const migrationPayload = await migrationResponse.json() as { profiles?: MigratedProfile[]; migration?: MigrationReport | null };
    assert.equal(migrationPayload.profiles?.length, 2, "both legacy profiles are returned after migration");
    assert.equal(migrationPayload.migration?.migration, "portfolio-profiles-v1-to-v2");
    assert.equal(migrationPayload.migration?.project_count, 2);
    assert.equal(migrationPayload.migration?.client_categories_migrated, 1);
    assert.equal(migrationPayload.migration?.personal_categories_preserved, 1);
    assert.equal(migrationPayload.migration?.source_sha256, createHash("sha256").update(legacyProfileBytes).digest("hex"));
    assert.match(migrationPayload.migration?.backup_id ?? "", /^[a-f0-9]{64}\.v1\.json$/);
    const backupPath = join(stateRoot, "backups", "phase-k-portfolio-profiles", migrationPayload.migration!.backup_id);
    assert.ok(isInside(tempRoot, backupPath), "migration backup remains inside test-owned temp state");
    assert.deepEqual(await readFile(backupPath), legacyProfileBytes, "migration backup preserves the exact source bytes");
    const migratedDiskDocument = JSON.parse(await readFile(profilesPath, "utf8")) as { schema_version?: number; projects?: Record<string, MigratedProfile> };
    assert.equal(migratedDiskDocument.schema_version, 2, "legacy portfolio document was migrated on disk");
    assert.equal(migratedDiskDocument.projects?.[profileProjectId]?.kind, "personal", "personal category is preserved");
    assert.equal(migratedDiskDocument.projects?.[profileClientId]?.kind, "client-product", "legacy client category maps to client-product");
    assert.equal(migratedDiskDocument.projects?.[profileClientId]?.client_id, syntheticClientId, "client association is preserved");

    const vitePort = await reserveLoopbackPort();
    vite = await createServer({
      configFile: join(repoRoot, "vite.config.ts"),
      server: {
        host: "127.0.0.1",
        port: vitePort,
        strictPort: true,
        proxy: { "/api": { target: apiUrl } },
      },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    assert.ok(address && typeof address !== "string", "Vite server has a loopback TCP address");
    assert.equal((address as AddressInfo).port, vitePort, "Vite is bound to its reserved temporary port, not the default UI port");
    const dashboardUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;

    stage = "migrate legacy portfolio profiles in the real browser flow";
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const browserErrors: string[] = [];
    const browserHttpErrors: string[] = [];
    const mutatingSessionHeaders: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") browserErrors.push(`${message.text()} (${message.location().url || "unknown source"})`); });
    page.on("response", (response) => {
      if (response.status() >= 400) browserHttpErrors.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      if ((url.pathname.startsWith("/api/organization/") || url.pathname.startsWith("/api/work-issues")) && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
        mutatingSessionHeaders.push(request.headers()["x-surtec-session"] ?? "");
      }
    });

    await page.goto(`${dashboardUrl}/`, { waitUntil: "domcontentloaded" });
    await page.getByText("Cockpit diario").waitFor();
    await page.getByText("En vivo", { exact: true }).waitFor();
    if (process.argv.includes("--fail-after-browser")) {
      stage = "injected rejected browser action";
      await observeResponse(page, "/api/synthetic-never-sent", "POST", async () => { throw new Error("Synthetic browser action failure"); });
    }

    stage = "save company profile and objectives from the dashboard";
    await page.getByRole("button", { name: "SURTEC", exact: true }).click();
    await page.getByRole("heading", { name: "Objetivos", exact: true }).waitFor();
    await page.getByLabel("Nombre visible").fill("SURTEC");
    await page.getByLabel("Misión").fill("Synthetic local acceptance mission.");
    await page.getByLabel("Principios operativos").fill("Keep local test data isolated.\nPreserve source records.");
    assert.equal(await page.locator(".organization-company-form").evaluate((element) => (element as HTMLFormElement).checkValidity()), true, "synthetic company form is valid before expecting its PUT request");
    const profileSave = await observeResponse(page, "/api/organization/company", "PUT", () => page.getByRole("button", { name: "Guardar perfil", exact: true }).click());
    assert.equal(profileSave.status(), 200, "company profile UI write returns 200");
    await page.getByText("Perfil SURTEC guardado localmente.", { exact: true }).waitFor();

    const futureDate = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const activeObjective = await createObjective(page, { title: "Synthetic active objective", status: "active", date: futureDate });
    const pausedObjective = await createObjective(page, { title: "Synthetic paused objective", status: "paused", date: null });
    const achievedObjective = await createObjective(page, { title: "Synthetic achieved objective", status: "achieved", date: null });
    assert.equal(typeof activeObjective.id, "string");
    assert.equal(typeof pausedObjective.id, "string");
    assert.equal(typeof achievedObjective.id, "string");
    const objectiveCard = (title: string) => page.locator(".organization-objective-card").filter({ hasText: title });
    assert.match(await objectiveCard("Synthetic paused objective").innerText(), /Pausada/);
    assert.match(await objectiveCard("Synthetic achieved objective").innerText(), /Lograda/);

    stage = "link a discovered repository to its primary objective";
    const clientProjectRow = page.locator(".organization-project-row").filter({ hasText: profileClientId });
    await clientProjectRow.getByRole("checkbox", { name: "Synthetic active objective · Activa", exact: true }).check();
    await clientProjectRow.getByLabel("Objetivo principal").selectOption(String(activeObjective.id));
    const linkResponse = await observeResponse(page, `/api/organization/projects/${profileClientId}/objectives`, "PUT", () => clientProjectRow.getByRole("button", { name: "Guardar vínculos", exact: true }).click());
    assert.equal(linkResponse.status(), 200, "project objective link UI write returns 200");
    const linksBody = await linkResponse.json() as { links?: { objective_ids?: string[]; primary_objective_id?: string | null } };
    assert.deepEqual(linksBody.links?.objective_ids, [String(activeObjective.id)]);
    assert.equal(linksBody.links?.primary_objective_id, activeObjective.id);
    await objectiveCard("Synthetic active objective").getByText(`Proyectos: ${profileClientId}`, { exact: true }).waitFor();
    const personalProjectRow = page.locator(".organization-project-row").filter({ hasText: profileProjectId });
    await personalProjectRow.getByText("Personal · no requiere objetivo", { exact: true }).waitFor();

    stage = "verify cycle rejection and relationship integrity";
    const firstSessionToken = mutatingSessionHeaders.find((token) => token.length > 0);
    assert.ok(firstSessionToken, "dashboard mutations include an in-memory session token");
    const apiPost = (path: string, body: unknown, token = firstSessionToken) => fetch(`${apiUrl}${path}`, {
      method: "POST", headers: { "content-type": "application/json", "x-surtec-session": token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
    });
    const previewRequest = async (input: ContextPreviewRequest): Promise<ContextPreview> => {
      const response = await apiPost("/api/context/preview", input);
      assert.equal(response.status, 200, `synthetic ${input.kind} preview is valid: ${await response.clone().text()}`);
      const preview = await response.json() as ContextPreview;
      assert.equal(preview.allowed, true, `synthetic preview is admitted: ${preview.blocked_reasons.join("; ")}`);
      return preview;
    };
    const hashOrAbsent = async (path: string) => (await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; })) ? harnessTreeHash(path) : "absent";
    // The idle worker continuously creates/removes this one scheduling lock.
    // Keep every persisted record, journal, observation and other lock in the comparison.
    const effects = async () => ({ state: await harnessTreeHash(stateRoot, ["locks/orchestrator-schedule.lock"]), worktrees: await hashOrAbsent(join(projectsRoot, "surtec-worktrees")), executor: await readFile(join(tempRoot!, "executor-effects.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return "absent"; }) });
    const childResponse = await fetch(`${apiUrl}/api/organization/objectives`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-surtec-session": firstSessionToken },
      body: JSON.stringify({
        title: "Synthetic child objective",
        desired_outcome: "Validate cycle protection through the real API.",
        success_criteria: ["The parent graph remains acyclic."],
        status: "draft",
        horizon: "quarter",
        priority: 3,
        target_date: null,
        parent_objective_id: activeObjective.id,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(childResponse.status, 201, "valid child objective is accepted");
    const child = (await childResponse.json() as { objective: { id: string } }).objective;
    const beforeCycle = await readApiJson<{ objectives: Array<Record<string, unknown>> }>(`${apiUrl}/api/organization`);
    const activeBeforeCycle = beforeCycle.objectives.find((objective) => objective.id === activeObjective.id);
    assert.ok(activeBeforeCycle, "parent objective remains present before cycle attempt");
    const cycleResponse = await fetch(`${apiUrl}/api/organization/objectives/${encodeURIComponent(String(activeObjective.id))}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-surtec-session": firstSessionToken },
      body: JSON.stringify({ ...activeBeforeCycle, parent_objective_id: child.id }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(cycleResponse.status, 400, "real API rejects a parent-child cycle");
    const afterCycle = await readApiJson<{ objectives: Array<Record<string, unknown>> }>(`${apiUrl}/api/organization`);
    const persistedParent = afterCycle.objectives.find((objective) => objective.id === activeObjective.id);
    const persistedChild = afterCycle.objectives.find((objective) => objective.id === child.id);
    assert.equal(persistedParent?.parent_objective_id, null, "rejected cycle leaves the original parent unchanged");
    assert.equal(persistedChild?.parent_objective_id, activeObjective.id, "rejected cycle leaves the valid child relationship intact");
    const issueObjectiveLink = await fetch(`${apiUrl}/api/organization/projects/${issueProjectId}/objectives`, {
      method: "PUT", headers: { "content-type": "application/json", "x-surtec-session": firstSessionToken },
      body: JSON.stringify({ objective_ids: [child.id], primary_objective_id: child.id }), signal: AbortSignal.timeout(5_000),
    });
    assert.equal(issueObjectiveLink.status, 200, "synthetic issue project links to its objective");

    stage = "Phase N no-effect preview, role/source guards and default privacy";
    const analysisRequest: ContextPreviewRequest = { kind: "analysis", project: issueProjectId, agent: "tech-lead", role_id: "planner", instructions: "Inspect the synthetic project without editing it.", client_context_categories: [] };
    const beforePreview = await effects();
    assert.equal((await fetch(`${apiUrl}/api/context/preview`, { method: "POST", body: JSON.stringify(analysisRequest) })).status, 403, "preview requires session protection");
    const projectRoles = await readApiJson<{ roles: Array<{ id: string; agents: string[] }> }>(`${apiUrl}/api/projects/${issueProjectId}/context/roles`);
    assert.ok(projectRoles.roles.every((role) => role.agents.every((id) => ["frontend-engineer", "tech-lead"].includes(id))), "role inventory intersects the project allowlist");
    assert.equal((await apiPost("/api/context/preview", { ...analysisRequest, agent: "frontend-engineer" })).status, 403, "incompatible role/adapter is denied");
    assert.equal((await apiPost("/api/context/preview", { ...analysisRequest, agent: "product-manager", role_id: "portfolio-analyst" })).status, 403, "registered but project-disallowed adapter is denied");
    const initialPreview = await previewRequest(analysisRequest);
    const publicPreview = JSON.stringify(initialPreview);
    assert.ok(!publicPreview.includes("Synthetic private project source body") && !publicPreview.includes(projectsRoot), "preview exposes attribution, not source copies or absolute paths");
    assert.deepEqual(initialPreview.manifest.selected_categories, []);
    assert.ok(initialPreview.manifest.sources.some((source) => source.id === "project/docs/smoke-context.md"));
    const analysisDispatch = { project: analysisRequest.project, agent: analysisRequest.agent, role_id: analysisRequest.role_id, instructions: analysisRequest.instructions, sandbox: "read-only", preview_fingerprint: initialPreview.fingerprint, client_context_categories: [] };
    assert.equal((await apiPost("/api/tasks", { ...analysisDispatch, instructions: "Changed analysis request" })).status, 409, "changed request cannot reuse preview");
    const selectedSource = join(syntheticRepo, "docs/smoke-context.md"), selectedBytes = await readFile(selectedSource);
    try {
      await writeFile(selectedSource, "Changed private project source.\n");
      assert.equal((await apiPost("/api/tasks", analysisDispatch)).status, 409, "changed required source cannot reuse preview");
      await writeFile(selectedSource, "x".repeat(60_001));
      assert.equal((await apiPost("/api/context/preview", analysisRequest)).status, 409, "oversized required source is rejected, not silently truncated");
      await unlink(selectedSource);
      assert.equal((await apiPost("/api/context/preview", analysisRequest)).status, 409, "missing required source blocks preview");
    } finally { await writeFile(selectedSource, selectedBytes); }
    assert.deepEqual(await effects(), beforePreview, "all previews and refusals leave state, worktrees and executor effects unchanged");

    await page.getByRole("button", { name: "Overview", exact: true }).click();
    const taskForm = page.locator(".task-panel");
    await taskForm.getByLabel("Proyecto", { exact: true }).selectOption(profileClientId);
    await taskForm.getByLabel("Perfil Codex", { exact: true }).selectOption("planner");
    assert.deepEqual(await taskForm.getByLabel("Agente", { exact: true }).locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)), ["tech-lead"], "analysis adapter choices intersect role and project policy");
    assert.ok(await taskForm.getByLabel("Modo", { exact: true }).locator("option").evaluateAll((options) => options.every((option) => (option as HTMLOptionElement).value === "read-only" || (option as HTMLOptionElement).disabled)), "analysis form never enables writes");
    await taskForm.getByLabel("Instrucciones", { exact: true }).fill("Inspect the synthetic client project without editing or sharing client data.");
    const consent = taskForm.locator(".task-client-context input[type=checkbox]");
    await consent.first().waitFor();
    assert.ok((await consent.evaluateAll((inputs) => inputs.every((input) => !(input as HTMLInputElement).checked))), "client categories start unchecked");
    assert.equal(await taskForm.getByRole("button", { name: "Despachar", exact: true }).isDisabled(), true, "analysis requires explicit preview");
    const previewButton = taskForm.getByRole("button", { name: "Previsualizar contexto", exact: true });
    const browserPreviewResponse = await observeResponse(page, "/api/context/preview", "POST", () => previewButton.click());
    assert.equal(browserPreviewResponse.status(), 200);
    const browserPreview = await browserPreviewResponse.json() as ContextPreview;
    assert.equal(browserPreview.allowed, true);
    assert.deepEqual(browserPreview.manifest.selected_categories, []);
    const previewPanel = taskForm.getByRole("region", { name: "Preview de contexto" });
    await previewPanel.getByText("Contexto habilitado para este pedido.", { exact: true }).waitFor();
    assert.ok(!(await previewPanel.innerText()).includes("Synthetic confidential client body"));
    await taskForm.getByLabel("Perfil Codex", { exact: true }).selectOption("software-engineer");
    assert.equal(await taskForm.getByLabel("Modo", { exact: true }).inputValue(), "read-only", "a write ceiling never changes the requested analysis mode");
    assert.equal(await taskForm.getByRole("button", { name: "Despachar", exact: true }).isDisabled(), true, "profile change discards preview");
    await taskForm.getByLabel("Perfil Codex", { exact: true }).selectOption("planner");
    assert.equal(await taskForm.getByRole("button", { name: "Despachar", exact: true }).isDisabled(), true, "switching back cannot restore the old preview");
    await taskForm.getByRole("checkbox", { name: "Notas confidenciales del cliente · confidencial", exact: true }).check();
    assert.equal(await taskForm.getByRole("button", { name: "Despachar", exact: true }).isDisabled(), true, "consent change invalidates preview");
    const selectedPreviewResponse = await observeResponse(page, "/api/context/preview", "POST", () => previewButton.click());
    const selectedPreview = await selectedPreviewResponse.json() as ContextPreview;
    assert.equal(selectedPreview.allowed, true); assert.deepEqual(selectedPreview.manifest.selected_categories, ["confidential-notes"]);
    assert.ok(selectedPreview.manifest.sources.some((source) => source.id === "client/explicit-consent"));
    assert.ok(!JSON.stringify(selectedPreview).includes(syntheticClient.confidential_notes) && !(await previewPanel.innerText()).includes(syntheticClient.confidential_notes), "selected confidential body stays out of preview and DOM");
    const browserRequest = browserPreviewResponse.request().postDataJSON() as ContextPreviewRequest;
    assert.equal((await apiPost("/api/tasks", { ...browserRequest, kind: undefined, sandbox: "read-only", preview_fingerprint: selectedPreview.fingerprint })).status, 409, "consent-mismatched dispatch has no effects");
    await taskForm.getByRole("checkbox", { name: "Notas confidenciales del cliente · confidencial", exact: true }).uncheck();
    await taskForm.getByLabel("Instrucciones", { exact: true }).fill("Edited synthetic analysis request");
    await taskForm.getByLabel("Instrucciones", { exact: true }).fill(browserRequest.instructions!);
    assert.equal(await taskForm.getByRole("button", { name: "Despachar", exact: true }).isDisabled(), true, "editing back to the original request cannot resurrect preview");
    const defaultPreviewResponse = await observeResponse(page, "/api/context/preview", "POST", () => previewButton.click());
    const defaultPreview = await defaultPreviewResponse.json() as ContextPreview;
    assert.equal(defaultPreview.allowed, true); assert.deepEqual(defaultPreview.manifest.selected_categories, []);
    assert.deepEqual(await effects(), beforePreview, "browser previews/consent mismatch do not persist state or invoke the executor");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "analysis preview has no mobile overflow");
    assert.ok(await previewButton.evaluate((element) => element.getBoundingClientRect().width < 280), "preview control stays compact");
    const profileTheme = await taskForm.getByLabel("Perfil Codex", { exact: true }).evaluate((element) => ({ scheme: getComputedStyle(element).colorScheme, options: [...element.querySelectorAll("option")].map((option) => ({ color: getComputedStyle(option).color, background: getComputedStyle(option).backgroundColor })) }));
    assert.equal(profileTheme.scheme, "dark"); assert.ok(profileTheme.options.every((option) => option.color !== option.background), "profile choices remain contrasting without hover");
    await page.setViewportSize({ width: 1440, height: 1000 });
    stage = "Phase N real read-only analysis and recorded manifest inspection";
    const beforeAnalysis = await harnessTreeHash(join(projectsRoot, profileClientId));
    const analysisResponse = await observeResponse(page, "/api/tasks", "POST", () => taskForm.getByRole("button", { name: "Despachar", exact: true }).click());
    assert.equal(analysisResponse.status(), 201);
    const analysisId = (await analysisResponse.json() as { id: string }).id;
    const analysisTask = await waitForTask(apiUrl, analysisId);
    assert.equal(analysisTask.outcome, "completed");
    assert.deepEqual(analysisTask.envelope.context_manifest, defaultPreview.manifest);
    assert.deepEqual(analysisTask.envelope.context_manifest!.selected_categories, []);
    assert.ok(!analysisTask.envelope.instructions.includes(syntheticClient.confidential_notes) && analysisTask.envelope.metadata.client_context_share === undefined, "default dispatch stores no client body or consent audit");
    assert.equal(await harnessTreeHash(join(projectsRoot, profileClientId)), beforeAnalysis, "read-only executor leaves synthetic project bytes unchanged");
    await page.locator(".hist-row").getByRole("button", { name: analysisId, exact: true }).click();
    const recordedManifest = page.getByRole("region", { name: "Manifiesto de contexto" });
    await recordedManifest.getByText(defaultPreview.fingerprint, { exact: true }).waitFor();
    await recordedManifest.getByText("planner", { exact: true }).waitFor();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.locator(".hist-row").getByRole("button", { name: analysisId, exact: true }).click();
    await recordedManifest.getByText(defaultPreview.fingerprint, { exact: true }).waitFor();
    await page.getByRole("button", { name: "Volver", exact: true }).click();

    stage = "create and explicitly authorize a local issue through the real dashboard";
    await page.getByRole("button", { name: "Issues", exact: true }).click();
    await page.getByText("Trabajo aprobado", { exact: true }).waitFor();
    await page.locator(".work-issue-create summary").click();
    await page.getByLabel("Repositorio local").selectOption(issueProjectId);
    await page.getByLabel("Agente habilitado", { exact: true }).selectOption("frontend-engineer");
    await page.getByLabel("Objetivo SURTEC", { exact: true }).selectOption(child.id);
    await page.locator(".work-issue-create label").filter({ hasText: "Título" }).locator("input").fill("Synthetic local issue proposal");
    await page.locator(".work-issue-create label").filter({ hasText: "Resultado esperado" }).locator("textarea").fill("A synthetic issue stays local and has a visible authorized scope.");
    await page.locator(".work-issue-create label").filter({ hasText: "Criterios de aceptación" }).locator("textarea").fill("The proposed path is displayed with its scope revision.");
    await page.locator(".work-issue-create label").filter({ hasText: "Paths permitidos" }).locator("textarea").fill("dashboard/src/**");
    await page.locator(".work-issue-create label").filter({ hasText: "Categorías de cambio" }).locator("input").fill("dashboard UI");
    const issueCreateResponse = await observeResponse(page, "/api/work-issues", "POST", () => page.getByRole("button", { name: "Crear propuesta local", exact: true }).click());
    assert.equal(issueCreateResponse.status(), 201, "local issue creation returns 201 through the real API");
    const issueCreateBody = await issueCreateResponse.json() as { issue?: { id: string; status: string; work_scale: string; revision: number } };
    assert.ok(issueCreateBody.issue && issueCreateBody.issue.status === "proposed", "new local issue starts proposed, not authorized");
    assert.equal(issueCreateBody.issue.work_scale, "trivial", "narrow synthetic issue is classified deterministically");
    const issueCard = page.locator(".work-issue-card").filter({ hasText: "Synthetic local issue proposal" });
    await issueCard.getByText("proposed", { exact: true }).waitFor();
    const issueInput = issueCreateResponse.request().postDataJSON();
    assert.equal((await apiPost(`/api/work-issues/${issueCreateBody.issue.id}/dispatch`, { expected_revision: issueCreateBody.issue.revision, agent: "frontend-engineer" })).status, 409, "proposal cannot dispatch before authorization");
    assert.equal((await apiPost("/api/tasks", { project: issueProjectId, agent: "frontend-engineer", sandbox: "workspace-write", instructions: "Synthetic direct write bypass", metadata: { issue_id: issueCreateBody.issue.id } })).status, 409, "generic task route cannot forge trusted issue write lineage");
    assert.equal((await apiPost("/api/work-issues", { ...issueInput, criticality: "high" })).status, 400, "substantial work cannot bypass its durable plan");
    const proposedPreviewResponse = await apiPost("/api/context/preview", { kind: "issue", project: issueProjectId, agent: "frontend-engineer", role_id: "software-engineer", issue_id: issueCreateBody.issue.id, expected_revision: issueCreateBody.issue.revision });
    assert.equal(proposedPreviewResponse.status, 200); assert.equal((await proposedPreviewResponse.json() as ContextPreview).allowed, false, "preview does not authorize proposed work");
    const authorizeIssueResponse = await observeResponse(page, `/api/work-issues/${issueCreateBody.issue.id}/authorize`, "POST", () => issueCard.getByRole("button", { name: "Autorizar scope exacto", exact: true }).click());
    assert.equal(authorizeIssueResponse.status(), 200, "exact-scope authorization is an authenticated human action");
    const authorizedIssue = (await authorizeIssueResponse.json() as { issue: { revision: number } }).issue;
    await issueCard.getByText("authorized", { exact: true }).waitFor();
    await issueCard.getByLabel("Agente autorizado de Synthetic local issue proposal", { exact: true }).locator('option[value="frontend-engineer"]').waitFor({ state: "attached" });
    assert.equal(await issueCard.getByLabel("Agente autorizado de Synthetic local issue proposal", { exact: true }).inputValue(), "frontend-engineer");
    assert.equal(await issueCard.getByLabel("Agente autorizado de Synthetic local issue proposal", { exact: true }).isDisabled(), true, "existing assignment cannot be silently replaced in the browser");
    stage = "dispatch a synthetic executor through the real API, runner and managed Git worktree";
    const beforeIssuePreview = await effects();
    assert.equal((await apiPost("/api/context/preview", { kind: "issue", project: issueProjectId, agent: "frontend-engineer", role_id: "software-engineer", issue_id: issueCreateBody.issue.id, expected_revision: issueCreateBody.issue.revision })).status, 409, "old issue revision needs a new preview");
    assert.equal(await issueCard.getByRole("button", { name: "Despachar tarea aprobada", exact: true }).isDisabled(), true);
    const issuePreviewResponse = await observeResponse(page, "/api/context/preview", "POST", () => issueCard.getByRole("button", { name: "Previsualizar contexto del issue", exact: true }).click());
    assert.equal(issuePreviewResponse.status(), 200);
    const issuePreview = await issuePreviewResponse.json() as ContextPreview;
    assert.equal(issuePreview.allowed, true); assert.equal(issuePreview.manifest.role_id, "software-engineer");
    assert.equal(issuePreview.manifest.sandbox, "workspace-write"); assert.deepEqual(issuePreview.manifest.selected_categories, []);
    assert.equal(issuePreviewResponse.request().postDataJSON().expected_revision, authorizedIssue.revision);
    assert.deepEqual(await effects(), beforeIssuePreview, "issue preview and stale revision refusal have no execution effects");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "issue profile/preview has no mobile overflow");
    await page.setViewportSize({ width: 1440, height: 1000 });
    const dispatchResponse = await observeResponse(page, `/api/work-issues/${issueCreateBody.issue.id}/dispatch`, "POST", () => issueCard.getByRole("button", { name: "Despachar tarea aprobada", exact: true }).click());
    assert.equal(dispatchResponse.status(), 201, "approved issue admits a linked task");
    let readyLineage: import("../lib/issues/types").IssueLineage | null = null;
    const executionDeadline = Date.now() + 30_000;
    while (Date.now() < executionDeadline) {
      readyLineage = await readApiJson(`${apiUrl}/api/work-issues/${issueCreateBody.issue!.id}`);
      if (["ready-for-review", "blocked", "needs-decision"].includes(readyLineage!.issue.status)) break;
      await delay(200);
    }
    assert.equal(readyLineage?.issue.status, "ready-for-review", `real runner produces a verified candidate with the injected fake executor (${readyLineage?.issue.next_action ?? "no blocker recorded"})`);
    assert.equal(readyLineage.tasks.length, 1);
    assert.equal(readyLineage.issue.objective_id, child.id, "objective -> project -> issue lineage remains queryable");
    assert.equal(readyLineage.tasks[0]!.executions.length, 1, "execution attempts are queryable");
    assert.deepEqual(readyLineage.tasks[0]!.task.envelope.context_manifest, issuePreview.manifest, "write task stores the admitted manifest");
    assert.equal(readyLineage.tasks[0]!.task.testing_evidence?.schema_version, 1, "real configured verification creates an infrastructure receipt");
    const candidate = readyLineage.candidates.find((entry) => entry.invalidated_at === null)!;
    assert.deepEqual(candidate.changed_paths, ["dashboard/src/fixture.txt"]);
    assert.match(candidate.diff_fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(readyLineage.evidence.some((entry) => entry.kind === "verification" && entry.status === "passed" && entry.candidate_id === candidate.id), "verification evidence binds the exact candidate");
    const acceptanceInput = { expected_revision: readyLineage.issue.revision, candidate_id: candidate.id, fingerprint: candidate.diff_fingerprint, approval_id: "synthetic-negative-review", rationale: "Synthetic review guard test", confirmed_criteria: readyLineage.issue.acceptance_criteria };
    assert.equal((await apiPost(`/api/work-issues/${issueCreateBody.issue.id}/accept`, { ...acceptanceInput, fingerprint: "0".repeat(64) })).status, 409, "stale fingerprint cannot complete an issue");
    assert.equal((await apiPost(`/api/work-issues/${issueCreateBody.issue.id}/accept`, { ...acceptanceInput, confirmed_criteria: [] })).status, 400, "empty acceptance criteria cannot complete an issue");
    assert.equal((await apiPost(`/api/work-issues/${issueCreateBody.issue.id}/dispatch`, { expected_revision: readyLineage.issue.revision, agent: "frontend-engineer" })).status, 409, "duplicate dispatch does not create a second task");
    assert.equal(execFileSync("git", ["-C", syntheticRepo, "log", "--format=%s", "-1"], { env: environment, encoding: "utf8", windowsHide: true }).trim(), "Synthetic fixture baseline", "source checkout remains unchanged");
    await page.getByRole("button", { name: "Actualizar", exact: true }).click();
    await issueCard.getByRole("button", { name: "Revisar candidato", exact: true }).click();
    const acceptButton = issueCard.getByRole("button", { name: "Aceptar este candidato local", exact: true });
    assert.equal(await acceptButton.isDisabled(), true, "acceptance needs explicit criteria confirmation");
    await issueCard.getByRole("checkbox", { name: "The proposed path is displayed with its scope revision.", exact: true }).check();
    const acceptResponse = await observeResponse(page, `/api/work-issues/${issueCreateBody.issue.id}/accept`, "POST", () => acceptButton.click());
    assert.equal(acceptResponse.status(), 200, "local acceptance runs through the authenticated API");
    await issueCard.getByText("done", { exact: true }).waitFor();
    const doneLineage = await readApiJson<import("../lib/issues/types").IssueLineage>(`${apiUrl}/api/work-issues/${issueCreateBody.issue!.id}`);
    assert.deepEqual(doneLineage.evidence_gaps, [], "completion has verification and human-review evidence");
    assert.ok(doneLineage.evidence.some((entry) => entry.kind === "review" && entry.candidate_revision === candidate.candidate_revision && entry.diff_fingerprint === candidate.diff_fingerprint));
    const reviewLineageStale = (await issueCard.locator(".work-issue-lineage").innerText()).includes("Human acceptance evidence is missing");
    const sessionResponse = await apiPost("/api/sessions", { project_id: issueProjectId, objective: "Synthetic issue verification session", related_task_ids: [doneLineage.tasks[0]!.task.envelope.id] });
    assert.equal(sessionResponse.status, 201);
    const session = (await sessionResponse.json() as { session: { id: string } }).session;
    assert.equal((await apiPost(`/api/sessions/${session.id}/action`, { action: "complete", result_summary: "Synthetic candidate reviewed", next_action: "No further fixture work" })).status, 200);
    const sessionLineage = await readApiJson<import("../lib/issues/types").IssueLineage>(`${apiUrl}/api/work-issues/${issueCreateBody.issue.id}`);
    assert.equal(sessionLineage.sessions[0]?.id, session.id, "work session is queryable through issue task lineage");
    stage = "verify out-of-scope work stops before commit and requires a browser decision";
    const scopeOutcomes: Array<{ id: string; status: string; scope_revision: number }> = [];
    for (const decision of ["approve", "reject"] as const) {
      const title = `Synthetic scope discovery ${decision}`;
      const createdResponse = await apiPost("/api/work-issues", { ...issueInput, title });
      assert.equal(createdResponse.status, 201);
      const proposed = (await createdResponse.json() as { issue: { id: string; revision: number } }).issue;
      const authorizedResponse = await apiPost(`/api/work-issues/${proposed.id}/authorize`, { expected_revision: proposed.revision, approval_id: "synthetic-scope-approval" });
      assert.equal(authorizedResponse.status, 200);
      const authorized = (await authorizedResponse.json() as { issue: { revision: number } }).issue;
      const scopePreview = await previewRequest({ kind: "issue", project: issueProjectId, agent: "frontend-engineer", role_id: "software-engineer", issue_id: proposed.id, expected_revision: authorized.revision, client_context_categories: [] });
      assert.equal((await apiPost(`/api/work-issues/${proposed.id}/dispatch`, { expected_revision: authorized.revision, agent: "frontend-engineer", role_id: "software-engineer", preview_fingerprint: scopePreview.fingerprint, client_context_categories: [] })).status, 201);
      let detail: import("../lib/issues/types").IssueLineage | null = null;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        detail = await readApiJson(`${apiUrl}/api/work-issues/${proposed.id}`);
        if (detail!.issue.status === "needs-decision" && detail!.tasks[0]?.task.lifecycle === "finished") break;
        await delay(200);
      }
      assert.equal(detail?.issue.status, "needs-decision");
      assert.equal(detail.issue.scope_revision, 1, "discovery alone grants no new scope");
      assert.deepEqual(detail.issue.authorized_scope.allowed_path_patterns, ["dashboard/src/**"]);
      assert.equal(detail.candidates.length, 0, "out-of-scope attempt creates no review candidate");
      const run = detail.tasks[0]!.task.envelope.metadata.run as { worktree_path: string };
      assert.ok(isInside(tempRoot, run.worktree_path), "scope fixture worktree stays temporary");
      assert.equal(execFileSync("git", ["-C", run.worktree_path, "log", "--format=%s", "-1"], { env: environment, encoding: "utf8", windowsHide: true }).trim(), "Synthetic fixture baseline", "scope violation stops before Git commit");
      await page.getByRole("button", { name: "Actualizar", exact: true }).click();
      const card = page.locator(".work-issue-card").filter({ hasText: title });
      await card.getByText("needs-decision", { exact: true }).waitFor();
      const decisionResponse = await observeResponse(page, `/api/work-issues/${proposed.id}/scope-decision`, "POST", () => card.getByRole("button", { name: decision === "approve" ? "Autorizar nueva revisión de scope" : "Rechazar y cancelar issue", exact: true }).click());
      assert.equal(decisionResponse.status(), 200);
      const changed = (await readApiJson<import("../lib/issues/types").IssueLineage>(`${apiUrl}/api/work-issues/${proposed.id}`)).issue;
      assert.equal(changed.status, decision === "approve" ? "authorized" : "cancelled");
      assert.equal(changed.scope_revision, decision === "approve" ? 2 : 1);
      scopeOutcomes.push({ id: changed.id, status: changed.status, scope_revision: changed.scope_revision });
    }
    const issueLayout = await issueCard.evaluate((element) => ({ width: element.getBoundingClientRect().width, scroll: element.scrollWidth }));
    assert.ok(issueLayout.scroll <= issueLayout.width + 1, `local issue card stays within its desktop width (${JSON.stringify(issueLayout)})`);
    await page.setViewportSize({ width: 390, height: 844 });
    const issueMobileLayout = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(issueMobileLayout.document <= issueMobileLayout.viewport + 1, `local issue view has no mobile horizontal overflow (${JSON.stringify(issueMobileLayout)})`);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "SURTEC", exact: true }).click();
    await page.getByRole("heading", { name: "Objetivos", exact: true }).waitFor();

    stage = "verify browser layout and reload persistence";
    const profileControls = await page.locator(".organization-company-form input").evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      buttonWidth: document.querySelector(".organization-company-form > .ibtn")?.getBoundingClientRect().width ?? 0,
    }));
    assert.equal(profileControls.background, "rgb(10, 20, 32)", "profile input uses the dark theme");
    assert.ok(profileControls.buttonWidth < 220, "profile save control stays compact");
    const projectControls = await clientProjectRow.evaluate((element) => ({
      buttonWidth: element.querySelector(".organization-project-links > .ibtn")?.getBoundingClientRect().width ?? 0,
      selectMaxWidth: element.querySelector(".organization-project-links select") ? getComputedStyle(element.querySelector(".organization-project-links select")!).maxWidth : "",
    }));
    assert.ok(projectControls.buttonWidth < 220, "project link save control stays compact");
    assert.equal(projectControls.selectMaxWidth, "460px", "project objective dropdown has a bounded width");
    const objectiveSelect = page.locator(".organization-objective-form select").first();
    const optionTheme = await objectiveSelect.evaluate((element) => ({
      scheme: getComputedStyle(element).colorScheme,
      options: Array.from(element.querySelectorAll("option"), (option) => ({ color: getComputedStyle(option).color, background: getComputedStyle(option).backgroundColor })),
    }));
    assert.equal(optionTheme.scheme, "dark", "native objective dropdown uses the dark color scheme");
    assert.ok(optionTheme.options.every((option) => ["rgb(243, 249, 252)", "rgb(255, 255, 255)"].includes(option.color)), "dropdown choices use readable text");
    assert.ok(optionTheme.options.every((option) => ["rgb(14, 27, 42)", "rgb(31, 78, 112)"].includes(option.background)), "dropdown choices use a contrasting background");
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileLayout = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      companyButton: document.querySelector(".organization-company-form > .ibtn")?.getBoundingClientRect().width ?? 0,
      linksButton: document.querySelector(".organization-project-links > .ibtn")?.getBoundingClientRect().width ?? 0,
    }));
    assert.ok(mobileLayout.document <= mobileLayout.viewport + 1, `mobile organization view has no horizontal overflow (${JSON.stringify(mobileLayout)})`);
    assert.ok(mobileLayout.companyButton < 220 && mobileLayout.linksButton < 220, "mobile save controls stay compact");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("Cockpit diario").waitFor();
    await page.getByRole("button", { name: "SURTEC", exact: true }).click();
    await page.getByRole("heading", { name: "Objetivos", exact: true }).waitFor();
    assert.equal(await page.getByLabel("Misión").inputValue(), "Synthetic local acceptance mission.", "company profile survives a browser reload");
    await objectiveCard("Synthetic active objective").waitFor();
    await objectiveCard("Synthetic paused objective").waitFor();
    await objectiveCard("Synthetic achieved objective").waitFor();
    await objectiveCard("Synthetic active objective").getByText(`Proyectos: ${profileClientId}`, { exact: true }).waitFor();
    assert.ok(browserErrors.length === 0 && browserHttpErrors.length === 0, `browser has no console, page, or HTTP errors (${[...browserErrors, ...browserHttpErrors].join(" | ")})`);

    stage = "Phase M real API/browser read-only inventory, Doctor and explicit observation refresh";
    const harnessProjectRoot = join(projectsRoot, profileProjectId);
    const beforeHarness = await harnessTreeHash(harnessProjectRoot);
    const healthyHarness = await readApiJson<HarnessResponse>(`${apiUrl}/api/projects/${profileProjectId}/harness/doctor`);
    assert.equal(healthyHarness.observation.status, "healthy");
    assert.equal(healthyHarness.observation.comparison, "compatible");
    assert.equal(healthyHarness.saved, null, "GET Doctor does not persist observations");
    assert.equal(healthyHarness.observation.validation.status, "unknown", "script presence is not execution evidence");
    assert.equal(healthyHarness.observation.entries.find((entry) => entry.path === "AGENTS.md")?.ownership, "user-owned");
    assert.equal(healthyHarness.observation.testing_policy.mode, "functional");
    const partialHarness = await readApiJson<HarnessResponse>(`${apiUrl}/api/projects/${profileClientId}/harness`);
    assert.equal(partialHarness.observation.status, "partial");
    const absentHarness = await readApiJson<HarnessResponse>(`${apiUrl}/api/projects/${issueProjectId}/harness`);
    assert.equal(absentHarness.observation.status, "absent");
    const unauthorizedHarness = await fetch(`${apiUrl}/api/projects/${profileProjectId}/harness/refresh`, { method: "POST" });
    assert.equal(unauthorizedHarness.status, 403);
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: `Detalle operativo de ${profileProjectId}`, exact: true }).click();
    const harnessPanel = page.getByRole("region", { name: "Harness del proyecto" });
    await harnessPanel.getByTestId("harness-status").getByText("healthy", { exact: true }).waitFor();
    const refreshHarnessResponse = await observeResponse(page, `/api/projects/${profileProjectId}/harness/refresh`, "POST", () => harnessPanel.getByRole("button", { name: "Actualizar Harness", exact: true }).click());
    assert.equal(refreshHarnessResponse.status(), 200);
    await harnessPanel.getByTestId("harness-saved").getByText(/Última observación guardada/).waitFor();
    assert.equal(await harnessTreeHash(harnessProjectRoot), beforeHarness, "read and refresh leave all project bytes unchanged");
    const savedHarness = (await readApiJson<HarnessResponse>(`${apiUrl}/api/projects/${profileProjectId}/harness`)).saved!;
    assert.equal(savedHarness.status, "healthy", "explicit refresh persists the healthy observation");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await harnessPanel.getByRole("button", { name: "Actualizar Harness" }).evaluate((element) => element.getBoundingClientRect().width < 220), "Harness refresh control remains compact");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "Harness detail has no mobile horizontal overflow");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: `Detalle operativo de ${profileProjectId}` }).click();
    await page.getByTestId("harness-saved").getByText(/Última observación guardada/).waitFor();
    // These mutations create explicit disposable invalid/drift fixtures; inspection must not repair them.
    const routingPath = join(harnessProjectRoot, ".agents/orchestration/ROUTING.md");
    const routingBytes = await readFile(routingPath);
    await writeFile(routingPath, "Synthetic invalid routing.\n");
    const invalidHarness = await readApiJson<HarnessResponse>(`${apiUrl}/api/projects/${profileProjectId}/harness`);
    assert.equal(invalidHarness.observation.status, "invalid");
    assert.deepEqual(await readFile(routingPath), Buffer.from("Synthetic invalid routing.\n"));
    const invalidRefresh = await fetch(`${apiUrl}/api/projects/${profileProjectId}/harness/refresh`, { method: "POST", headers: { "x-surtec-session": firstSessionToken } });
    assert.equal(invalidRefresh.status, 200, "saving an invalid observation does not repair its scaffold");
    await page.getByRole("button", { name: "Hoy", exact: true }).click();
    const harnessSignalCard = page.locator(".today-signal").filter({ hasText: "Harness: H1-H4 routing structure is missing or invalid." });
    await harnessSignalCard.getByRole("button", { name: "Ver Harness", exact: true }).click();
    await page.getByTestId("harness-status").getByText("invalid", { exact: true }).waitFor();
    assert.equal(await page.locator(".today-signal").count(), 0, "Harness evidence navigation opens dashboard detail, not the editor");
    await writeFile(routingPath, routingBytes);
    const restoredRefresh = await fetch(`${apiUrl}/api/projects/${profileProjectId}/harness/refresh`, { method: "POST", headers: { "x-surtec-session": firstSessionToken } });
    assert.equal(restoredRefresh.status, 200);
    const restoredSavedHarness = (await readApiJson<HarnessResponse>(`${apiUrl}/api/projects/${profileProjectId}/harness`)).saved!;
    const sourcePrimerPath = join(canonicalRoot, "AGENTS.md");
    const sourcePrimerBytes = await readFile(sourcePrimerPath);
    await writeFile(sourcePrimerPath, "Synthetic canonical drift.\n");
    const untrustedHarness = await readApiJson<HarnessResponse>(`${apiUrl}/api/projects/${profileProjectId}/harness`);
    assert.equal(untrustedHarness.observation.comparison, "unknown");
    assert.equal(untrustedHarness.observation.canonical_version, null);
    await writeFile(sourcePrimerPath, sourcePrimerBytes);
    assert.equal(await harnessTreeHash(harnessProjectRoot), beforeHarness);
    assert.deepEqual((await readApiJson<HarnessResponse>(`${apiUrl}/api/projects/${profileProjectId}/harness`)).saved, restoredSavedHarness, "GET unknown observations do not replace explicitly restored saved evidence");

    stage = "restart the real API and verify durable state and session rotation";
    const initialSessionResponse = await readApiJson<{ token: string }>(`${apiUrl}/api/session`);
    assert.equal(initialSessionResponse.token, firstSessionToken, "browser and API share the same initial session token");
    const preRestartPreview = await previewRequest(analysisRequest);
    await page.goto("about:blank");
    const stopped = await stopApi(api);
    assert.ok(stopped, `isolated API process stops before restart (${api.output})`);
    api = null;
    await delay(250);
    api = startApi(port, stateRoot, projectsRoot);
    await waitForApi(api, apiUrl);
    const restartedSession = await readApiJson<{ token: string }>(`${apiUrl}/api/session`);
    assert.notEqual(restartedSession.token, firstSessionToken, "API restart rotates the in-memory session token");
    const staleTokenWrite = await fetch(`${apiUrl}/api/organization/company`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-surtec-session": firstSessionToken },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(staleTokenWrite.status, 403, "old browser token cannot mutate after API restart");
    const restartEffects = await effects();
    assert.equal((await apiPost("/api/tasks", { ...analysisDispatch, preview_fingerprint: preRestartPreview.fingerprint }, restartedSession.token)).status, 409, "restart invalidates issuance even with a fresh session");
    assert.deepEqual(await effects(), restartEffects, "unissued preview after restart causes no effects");
    assert.deepEqual((await readApiJson<TaskRecord>(`${apiUrl}/api/tasks/${analysisId}`)).envelope.context_manifest, defaultPreview.manifest, "recorded analysis manifest survives API restart");
    assert.deepEqual((await readApiJson<HarnessResponse>(`${apiUrl}/api/projects/${profileProjectId}/harness`)).saved, restoredSavedHarness, "Harness observations survive API restart");
    const restartedOrganization = await readApiJson<{ company: { mission: string; operating_principles: string[] }; objectives: Array<Record<string, unknown>>; project_objectives: Record<string, { objective_ids: string[]; primary_objective_id: string | null }> }>(`${apiUrl}/api/organization`);
    assert.equal(restartedOrganization.company.mission, "Synthetic local acceptance mission.", "company profile survives API restart");
    assert.deepEqual(restartedOrganization.company.operating_principles, ["Keep local test data isolated.", "Preserve source records."]);
    assert.ok(restartedOrganization.objectives.some((objective) => objective.id === activeObjective.id), "objectives survive API restart");
    assert.deepEqual(restartedOrganization.project_objectives[profileClientId]?.objective_ids, [String(activeObjective.id)], "project links survive API restart");
    const stableProfiles = await readApiJson<{ profiles: MigratedProfile[]; migration: MigrationReport | null }>(`${apiUrl}/api/portfolio/profiles`);
    assert.equal(stableProfiles.migration, null, "already-migrated profiles do not migrate twice");
    assert.equal(stableProfiles.profiles.length, 2);
    const persistedIssues = await readApiJson<{ issues: Array<{ id: string; status: string; work_scale: string; scope_revision: number }> }>(`${apiUrl}/api/work-issues`);
    assert.deepEqual(persistedIssues.issues.map((issue) => ({ id: issue.id, status: issue.status, work_scale: issue.work_scale, scope_revision: issue.scope_revision })), [
      { id: issueCreateBody.issue.id, status: "done", work_scale: "trivial", scope_revision: 1 },
      ...scopeOutcomes.map((issue) => ({ ...issue, work_scale: "trivial" })),
    ], "local issue and authorization survive API restart without any provider write");
    const persistedOrganization = JSON.parse(await readFile(join(stateRoot, "organization", "organization.json"), "utf8")) as { schema_version?: number };
    assert.equal(persistedOrganization.schema_version, 1, "organization state remains in its supported versioned format");

    await page.goto(`${dashboardUrl}/`, { waitUntil: "domcontentloaded" });
    await page.getByText("Cockpit diario").waitFor();
    await page.getByRole("button", { name: "SURTEC", exact: true }).click();
    await page.getByRole("heading", { name: "Objetivos", exact: true }).waitFor();
    assert.equal(await page.getByLabel("Misión").inputValue(), "Synthetic local acceptance mission.", "dashboard reload after API restart shows persisted company data");
    await objectiveCard("Synthetic active objective").waitFor();
    await objectiveCard("Synthetic active objective").getByText(`Proyectos: ${profileClientId}`, { exact: true }).waitFor();
    await page.getByRole("button", { name: "Issues", exact: true }).click();
    await page.locator(".work-issue-card").filter({ hasText: "Synthetic local issue proposal" }).getByText("done", { exact: true }).waitFor();
    const restartedLineage = await readApiJson<import("../lib/issues/types").IssueLineage>(`${apiUrl}/api/work-issues/${issueCreateBody.issue.id}`);
    assert.deepEqual(restartedLineage.candidates, doneLineage.candidates, "immutable candidate survives API restart unchanged");
    assert.deepEqual(restartedLineage.evidence, doneLineage.evidence, "verification/review evidence survives API restart unchanged");
    assert.deepEqual(restartedLineage.evidence_gaps, []);
    assert.equal(restartedLineage.tasks[0]!.executions.length, 1);
    assert.deepEqual(restartedLineage.tasks[0]!.task.envelope.context_manifest, issuePreview.manifest);
    assert.deepEqual(restartedLineage.tasks[0]!.task.testing_evidence, doneLineage.tasks[0]!.task.testing_evidence, "infrastructure receipt survives restart unchanged");
    assert.equal(restartedLineage.sessions[0]?.id, session.id, "linked session survives API restart");
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.locator(".hist-row").getByRole("button", { name: analysisId, exact: true }).click();
    await recordedManifest.getByText(defaultPreview.fingerprint, { exact: true }).waitFor();
    assert.ok(!(await recordedManifest.innerText()).includes(syntheticClient.confidential_notes), "recorded public manifest remains body-free after restart");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "recorded task manifest has no mobile overflow");
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.ok(browserErrors.length === 0 && browserHttpErrors.length === 0, `browser remains free of errors after API restart (${[...browserErrors, ...browserHttpErrors].join(" | ")})`);

    stage = "verify immediate browser evidence consistency after local acceptance";
    assert.equal(reviewLineageStale, false, "after acceptance the open lineage must refresh; it must not retain a missing-human-review gap while the issue is done");
    const executorEffects = (await readFile(join(tempRoot, "executor-effects.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { mode: string; fingerprint: string });
    assert.deepEqual(executorEffects.map((effect) => effect.mode), ["read-only", "workspace-write-verify", "workspace-write-verify", "workspace-write-verify"], "exactly four synthetic turns; previews/refusals/restart never invoke an executor");
    assert.ok(executorEffects.every((effect) => /^[a-f0-9]{64}$/.test(effect.fingerprint)));
    assert.equal(execFileSync("git", ["-C", syntheticRepo, "status", "--porcelain"], { env: environment, encoding: "utf8", windowsHide: true }).trim(), "", "source Git checkout remains clean");
    console.log("PASS real local API + Playwright dashboard: Phase N role restrictions, no-effect preview, stale/missing/oversized sources, explicit consent/default privacy, read-only and issue dispatch, recorded manifests/verification receipts and restart issuance guards; prior Harness inventory/Doctor/refresh, migration/organization, real Git verification, candidate acceptance/lineage/scope guards, responsive controls, reload/restart and session rotation; four synthetic turns, no paid runtime or provider writes.");
  } catch (error) {
    console.error(`Local dashboard smoke failed during: ${stage}`);
    throw error;
  } finally {
    const cleanup = await cleanupSmoke({ browser: browser ? () => browser!.close() : undefined, vite: vite ? () => vite!.close() : undefined, api: api ? () => stopApi(api!) : undefined, root: tempRoot });
    console.log(`SMOKE_CLEANUP ${JSON.stringify({ fixture_id: tempRoot ? basename(tempRoot) : null, ...cleanup })}`);
    if (!cleanup.workspace_removed) {
      console.error(`Temporary smoke workspace preserved for safety: ${tempRoot ?? "not created"}; API stopped: ${cleanup.api_stopped}`);
      throw new Error("Synthetic smoke cleanup did not complete");
    } else {
      console.log("Temporary synthetic API state and repositories cleaned up.");
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
