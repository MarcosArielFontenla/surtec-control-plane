import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer as createPortProbe } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import type { OperatingView } from "../lib/operating-views";
import type { IssueEvidenceReference, IssueLineage, RecordDeliveryObservationInput, WorkIssue } from "../lib/issues/types";
import { cleanupSmoke, harnessTreeHash, observeResponse, trackBrowserApiReads } from "./playwright-local-app-smoke";

const STAGES = ["setup", "start", "healthy", "incomplete", "blocked", "harness", "delivery", "privacy", "mobile", "degraded", "refusals", "reload", "restart", "cleanup"] as const;
type Stage = typeof STAGES[number];
const OS_ENV = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"] as const;
const NOW = "2026-10-16T12:00:00.000Z", OBSERVED = "2026-10-15T12:00:00.000Z";
const KINDS = ["readiness-reviewed", "environment-observed", "handoff-recorded", "client-response-recorded", "follow-up-recorded"] as const;
const CONFIRM = "Confirmo registrar este hecho manual sin aprobar entrega ni completar compromisos";
const OFFLINE_FONT_URL = "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Hanken+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Lexical admission is complemented by realpath/lstat in shared owned cleanup.
// No caller-supplied project, state, runtime, or environment override is accepted.
export function assertOperatingFixtureRoot(root: string): void {
  const path = relative(resolve(tmpdir()), resolve(root));
  assert.ok(isAbsolute(root) && path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
    && basename(resolve(root)).startsWith("surtec-local-dashboard-"), "Operating smoke requires an owned OS-temp fixture root");
}

export function operatingSmokeEnvironment(source: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  assertOperatingFixtureRoot(root);
  const environment: NodeJS.ProcessEnv = {};
  for (const name of OS_ENV) if (source[name]) environment[name] = source[name];
  return Object.assign(environment, { NODE_ENV: "test", SURTEC_OPERATING_VIEWS_SMOKE: "1", SURTEC_STATE_DIR: join(root, "state"), SURTEC_PROJECTS_ROOT: join(root, "projects"),
    SURTEC_CODEX_BIN: join(root, "forbidden-runtime"), SURTEC_FIXTURE_ROOT: root });
}

// Never persist exception messages, stack, browser body, child output or tokens.
export function operatingFailureSummary(stage: string, error: unknown) {
  return { status: "failed" as const, stage: (STAGES as readonly string[]).includes(stage) ? stage : "unknown",
    error_type: error instanceof Error ? error.name === "AssertionError" ? "assertion" : error.name === "TimeoutError" ? "timeout" : "error" : "unknown" };
}

// A numeric source location is useful for a repeatable assertion failure without
// copying exception text, the full stack, private paths or record values.
export function operatingFailureLocation(error: unknown): { line: number; column: number } | null {
  if (!(error instanceof Error) || typeof error.stack !== "string") return null;
  const match = error.stack.match(/playwright-operating-views-smoke\.ts:(\d{1,6}):(\d{1,5})\b/);
  return match ? { line: Number(match[1]), column: Number(match[2]) } : null;
}
export function operatingConsoleCategory(text: string, location: string): string {
  if (text.includes("WebSocket") || text.includes("[vite]")) return "vite-connection";
  try {
    const url = new URL(location);
    if (["127.0.0.1", "localhost"].includes(url.hostname)) {
      for (const path of ["budgets", "routines", "workflows", "today", "work-issues", "tasks", "organization", "operating"]) {
        if (url.pathname === `/api/${path}` || url.pathname.startsWith(`/api/${path}/`)) return `api-${path}`;
      }
    }
  } catch { /* Unknown locations never get reflected in diagnostics. */ }
  return "other";
}
// The one existing optional font stylesheet is replaced locally, never fetched.
// No API, provider, font binary, arbitrary URL or changed asset is intercepted.
export function isOperatingOfflineAsset(url: string): boolean { return url === OFFLINE_FONT_URL; }

export interface OperatingFixtureFacts {
  deliveryIssueId: string; personalIssueId: string; blockedIssueId: string; objectiveId: string; commitmentId: string; fixedNow: string;
  acceptedIssueId: string; acceptedCandidateId: string; taskId: string;
}
export function parseOperatingReady(value: unknown): { port: number; facts: OperatingFixtureFacts } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (Object.keys(message).some(key => !["type", "port", "facts"].includes(key)) || message.type !== "ready"
    || !Number.isInteger(message.port) || (message.port as number) < 1 || (message.port as number) > 65535
    || !message.facts || typeof message.facts !== "object" || Array.isArray(message.facts)) return null;
  const facts = message.facts as Record<string, unknown>;
  const ids = ["deliveryIssueId", "personalIssueId", "blockedIssueId", "objectiveId", "commitmentId", "acceptedIssueId", "acceptedCandidateId", "taskId"];
  if (Object.keys(facts).some(key => ![...ids, "fixedNow"].includes(key)) || facts.fixedNow !== NOW || facts.commitmentId !== "commitment-delivery"
    || facts.taskId !== "T-q-recorded"
    || ids.some(key => typeof facts[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(facts[key] as string))) return null;
  return { port: message.port as number, facts: facts as unknown as OperatingFixtureFacts };
}

async function bounded<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
interface FixtureProcess { child: ChildProcess; exited: Promise<void>; facts?: OperatingFixtureFacts }
async function startApi(runtime: string, environment: NodeJS.ProcessEnv, register: (api: FixtureProcess) => void) {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/fixtures/operating-views-api.ts"], {
    cwd: runtime, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
  });
  const api: FixtureProcess = { child, exited: new Promise<void>(done => { child.once("exit", () => done()); }) };
  register(api);
  // Drain bounded child output without rendering potentially private exceptions.
  let childOutput = "";
  const drain = (chunk: Buffer) => { childOutput = (childOutput + chunk.toString()).slice(-4000); };
  child.stdout!.on("data", drain); child.stderr!.on("data", drain);
  const ready = await bounded(new Promise<NonNullable<ReturnType<typeof parseOperatingReady>>>((done, reject) => {
    const receive = (message: unknown) => {
      const parsed = parseOperatingReady(message);
      if (parsed) { child.off("message", receive); done(parsed); }
    };
    child.on("message", receive);
    child.once("error", () => reject(new Error("Operating fixture API failed to start")));
    child.once("exit", () => reject(new Error("Operating fixture API exited before readiness")));
  }), 30_000, "Operating fixture API readiness deadline");
  assert.ok(!childOutput.includes("SYNTHETIC_PRIVATE"), "API startup does not print private fixture text");
  api.facts = ready.facts;
  return { api, url: `http://127.0.0.1:${ready.port}`, facts: ready.facts };
}
async function stopApi(api: FixtureProcess | null): Promise<boolean> {
  if (!api || api.child.exitCode !== null || api.child.signalCode !== null) return true;
  if (!api.child.pid) return true;
  if (api.child.connected) api.child.send("stop"); else api.child.kill("SIGTERM");
  const ended = () => api.child.exitCode !== null || api.child.signalCode !== null;
  try { await bounded(api.exited, 8000, "API stop deadline"); return ended(); }
  catch { api.child.kill("SIGKILL"); try { await bounded(api.exited, 3000, "API kill deadline"); return ended(); } catch { return false; } }
}
let scenarioId = 0;
async function scenario(api: FixtureProcess, name: "degraded" | "future-delivery" | "overflow" | "restore") {
  const id = ++scenarioId;
  await bounded(new Promise<void>((done, reject) => {
    const receive = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const message = value as Record<string, unknown>;
      if (message.type !== "scenario-result" || message.id !== id) return;
      api.child.off("message", receive);
      if (message.ok === true) done(); else reject(new Error("Owned fixture scenario refused"));
    };
    api.child.on("message", receive);
    api.child.send({ type: "scenario", id, scenario: name }, error => { if (error) { api.child.off("message", receive); reject(new Error("Owned fixture scenario IPC failed")); } });
  }), 10_000, "Owned fixture scenario deadline");
}
async function startUi(root: string, apiUrl: string, register: (vite: ViteDevServer) => void): Promise<string> {
  const probe = createPortProbe();
  await new Promise<void>((done, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", () => done()); });
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done, reject) => probe.close(error => error ? reject(error) : done()));
  const vite = await createServer({ configFile: join(repoRoot, "vite.config.ts"), root: join(repoRoot, "dashboard"), cacheDir: join(root, "vite-cache"),
    server: { host: "127.0.0.1", port, strictPort: true, proxy: { "/api": { target: apiUrl, changeOrigin: false } } }, logLevel: "silent" });
  register(vite); await vite.listen(); return vite.resolvedUrls!.local[0]!;
}

export async function runOperatingViewsSmoke(): Promise<void> {
  assert.equal(process.argv.length, 2, "Operating smoke accepts no path, provider or runtime arguments");
  let root: string | null = null, browser: Browser | null = null, vite: ViteDevServer | null = null, api: FixtureProcess | null = null;
  let stage: Stage = "setup", failure: ReturnType<typeof operatingFailureSummary> | null = null;
  let failureLocation: ReturnType<typeof operatingFailureLocation> = null;
  let actualApi = false, actualVite = false, actualBrowser = false;
  let offlineFontRequests = 0, offlineFontResponses = 0;
  const browserFailures: { stage: Stage; category: string }[] = [];
  const passed: Stage[] = [];
  const step = (next: Stage) => { if (!passed.includes(stage) && stage !== "setup" && stage !== "start") passed.push(stage); stage = next; console.log(`Q smoke: ${next}`); };
  let tracker: ReturnType<typeof trackBrowserApiReads> | null = null;
  try {
    root = await mkdtemp(join(tmpdir(), "surtec-local-dashboard-"));
    const ownedRoot = root, runtime = join(root, "runtime"), environment = operatingSmokeEnvironment(process.env, root);
    await mkdir(join(root, "registry")); await mkdir(join(root, "projects")); await mkdir(join(root, "empty-hooks"));
    for (const id of ["alpha", "beta"]) {
      const path = join(root, "projects", id); await mkdir(path); await writeFile(join(path, "fixture.txt"), `Public ${id} operating sentinel\n`);
      execFileSync("git", ["-c", `core.hooksPath=${join(root, "empty-hooks")}`, "init", "--quiet"], { cwd: path, env: environment, windowsHide: true, stdio: "pipe" });
    }
    await writeFile(join(root, "registry/projects.yml"), "projects:\n  alpha: {}\n  beta: {}\n"); await writeFile(join(root, "registry/agents.yml"), "agents: []\n");
    for (const path of ["lib", "runner", "dashboard/src/server", "schemas", "package.json", "scripts/fixtures/operating-views-api.ts"]) {
      await cp(join(repoRoot, path), join(runtime, path), { recursive: true });
    }
    await symlink(join(repoRoot, "node_modules"), join(runtime, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    step("start");
    let started = await startApi(runtime, environment, value => { api = value; }), apiUrl = started.url;
    actualApi = true;
    const facts = started.facts;
    const stateFile = (path: string) => join(ownedRoot, "state", path);
    const issueBytes = () => readFile(stateFile("issues/issues.json"), "utf8");
    const unchangedPaths = ["organization/organization.json", "portfolio/projects.json", "portfolio/clients.json"];
    const unchanged = await Promise.all(unchangedPaths.map(path => readFile(stateFile(path), "utf8")));
    const sourceHash = await harnessTreeHash(join(root, "projects"));
    const stateHash = await harnessTreeHash(stateFile(""));
    const unrelatedStateHash = await harnessTreeHash(stateFile(""), ["issues/issues.json"]);
    const request = (path: string, options: RequestInit = {}) => fetch(`${apiUrl}${path}`, { ...options, signal: AbortSignal.timeout(10_000) });
    async function json<T>(path: string): Promise<T> {
      const response = await request(path); assert.equal(response.status, 200, `Real GET ${path} succeeds`);
      assert.match(response.headers.get("cache-control") ?? "", /no-store/); return response.json() as Promise<T>;
    }
    const lineage = await json<IssueLineage>(`/api/work-issues/${facts.deliveryIssueId}`), issue = lineage.issue;
    const originalIssueBytes = await issueBytes(), originalDocument = JSON.parse(originalIssueBytes);
    let uiUrl = await startUi(root, apiUrl, value => { vite = value; });
    actualVite = true;
    try { browser = await chromium.launch({ headless: true }); }
    catch (error) { if (process.platform !== "win32" || !(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error; browser = await chromium.launch({ headless: true, channel: "msedge" }); }
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC" }), page = await context.newPage(); page.setDefaultTimeout(10_000);
    actualBrowser = true;
    tracker = trackBrowserApiReads(context); const reads = tracker;
    let pageErrors = 0, consoleErrors = 0, httpErrors = 0, externalRequests = 0;
    const mutations: string[] = [];
    page.on("pageerror", () => pageErrors++); page.on("console", message => {
      if (message.type() === "error") { consoleErrors++; if (browserFailures.length < 20) browserFailures.push({ stage, category: operatingConsoleCategory(message.text(), message.location().url) }); }
    });
    page.on("response", response => { if (response.status() >= 400) httpErrors++; });
    context.on("request", value => {
      const url = new URL(value.url());
      if (isOperatingOfflineAsset(value.url())) offlineFontRequests++;
      else if (!["127.0.0.1", "localhost"].includes(url.hostname)) externalRequests++;
      if (value.method() !== "GET") mutations.push(`${value.method()} ${url.pathname}`);
    });
    // Deny external browser traffic rather than relying on fixture prompt text.
    await context.route("**/*", route => {
      if (isOperatingOfflineAsset(route.request().url())) {
        offlineFontResponses++;
        return route.fulfill({ status: 200, contentType: "text/css", headers: { "Cache-Control": "no-store" }, body: "/* Offline acceptance uses system font fallbacks. */" });
      }
      const url = new URL(route.request().url()); return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort();
    });
    async function navigate(section: string) { await page.getByRole("button", { name: section, exact: true }).click(); await reads.drain(); }
    async function privateHidden() { assert.ok(!(await page.locator("body").innerText()).includes("SYNTHETIC_PRIVATE"), "Private facts require explicit record disclosure"); }
    async function openProject(id: string) {
      await navigate("Overview"); await page.getByRole("button", { name: `Detalle operativo de ${id}`, exact: true }).click();
      await page.getByRole("heading", { name: id, exact: true }).waitFor(); await reads.drain();
      return page.getByRole("region", { name: "Entrega y seguimiento", exact: true });
    }
    const card = page.locator(`#work-issue-${facts.deliveryIssueId}`), panel = card.getByRole("region", { name: "Entrega y seguimiento", exact: true });
    async function consultIssue() {
      await navigate("Issues"); await card.waitFor();
      const expand = card.getByRole("button", { name: "Ver linaje y evidencia", exact: true }); if (await expand.count()) await expand.click();
      await panel.getByRole("button", { name: "Consultar entrega y seguimiento", exact: true }).click();
      await panel.getByRole("heading", { name: "Aceptación técnica", exact: true }).waitFor(); await reads.drain();
    }
    await page.goto(uiUrl); await reads.drain();
    step("healthy");
    const beforeReads = await reads.snapshot(issueBytes);
    const overview = await json<OperatingView>("/api/operating/overview");
    assert.equal(overview.execution_authority, "none"); assert.deepEqual(overview.phase_p, { budget_cutover: "not-enabled", continuity: "deferred" });
    assert.equal(overview.sections.find(section => section.kind === "budgets")!.source.availability, "not-enabled");
    const partial = overview.sections.find(section => section.kind === "signals")!;
    assert.equal(partial.source.freshness, "stale"); assert.equal(partial.coverage, "partial"); assert.equal(partial.total, null);
    for (const section of overview.sections) { assert.ok(section.rows.length <= 50); assert.ok(section.rows.every(row => row.execution_authority === "none" && row.lineage.requires_authorization)); }
    const objective = overview.sections.find(section => section.kind === "objectives")!.rows.find(row => row.id === facts.objectiveId)!;
    assert.ok(objective, "Fixture objective has a canonical operating row");
    await navigate("SURTEC"); const operating = page.getByRole("region", { name: "Overview operativo SURTEC", exact: true });
    await operating.getByText(/Desactualizada/).first().waitFor(); assert.ok((await operating.innerText()).includes("Total desconocido"));
    await operating.getByRole("button", { name: `Ver objetivo ${objective.label}`, exact: true }).click();
    const objectivePanel = page.getByRole("region", { name: "Detalle de objetivo", exact: true });
    await objectivePanel.getByRole("region", { name: "Proyectos vinculados", exact: true }).getByRole("button", { name: "Ver proyecto alpha", exact: true }).click();
    await page.getByRole("heading", { name: "alpha", exact: true }).waitFor();
    const readiness = page.getByRole("region", { name: "Preparación del proyecto", exact: true });
    await readiness.getByRole("button", { name: "Consultar preparación", exact: true }).click();
    await readiness.getByRole("region", { name: "Opciones registradas del proyecto", exact: true }).waitFor();
    await readiness.getByText("Evidencia local consultada y decisiones", { exact: true }).click();
    assert.ok((await readiness.innerText()).includes("not-enabled"));
    await readiness.getByRole("button", { name: `Revisar issue ${facts.deliveryIssueId}`, exact: true }).click(); await card.waitFor();
    assert.ok((await page.getByRole("region", { name: "Referencia de issue", exact: true }).innerText()).includes(facts.deliveryIssueId));
    {
      assert.ok(facts.acceptedIssueId && facts.acceptedCandidateId, "Saved candidate fixture retains exact references");
      const acceptedCard = page.locator(`#work-issue-${facts.acceptedIssueId}`);
      await acceptedCard.getByRole("button", { name: "Ver linaje y evidencia", exact: true }).click();
      await acceptedCard.getByText(new RegExp(facts.acceptedCandidateId)).first().waitFor();
      assert.ok((await acceptedCard.innerText()).includes(facts.acceptedCandidateId));
      const exactDelivery = acceptedCard.getByRole("region", { name: "Entrega y seguimiento", exact: true });
      await exactDelivery.getByRole("button", { name: "Consultar entrega y seguimiento", exact: true }).click();
      await exactDelivery.getByRole("heading", { name: "Aceptación técnica", exact: true }).waitFor();
      assert.ok((await exactDelivery.innerText()).includes(facts.acceptedCandidateId));
      assert.equal(await exactDelivery.getByText("Sin observación registrada; no implica éxito ni fallo.", { exact: true }).count(), 5);
      await acceptedCard.getByRole("button", { name: `Ver tarea ${facts.taskId}`, exact: true }).click();
      await page.getByRole("heading", { name: "Public recorded task", exact: true }).waitFor();
      await page.getByRole("button", { name: "Volver", exact: true }).click(); await card.waitFor();
    }
    assert.ok(await reads.snapshot(issueBytes) === beforeReads, "Opening connected operating views writes no issue bytes");
    assert.equal(await reads.snapshot(() => harnessTreeHash(stateFile(""))), stateHash, "Read-only views preserve all state bytes, with no lock exclusions");
    assert.equal(mutations.length, 0);
    await navigate("Hoy");
    const recommendation = page.getByRole("article", { name: "Recomendación sig_q_recorded_task", exact: true });
    await recommendation.getByText("Linaje y perfiles · consultar evidencia", { exact: true }).click();
    await recommendation.getByRole("button", { name: "Consultar linaje y perfiles", exact: true }).click();
    await recommendation.getByRole("region", { name: "Perfiles registrados de sig_q_recorded_task", exact: true }).waitFor();
    assert.ok((await recommendation.innerText()).includes("no es un grant") || (await recommendation.innerText()).includes("no son un grant"));
    await recommendation.getByRole("button", { name: `Ver issue ${facts.acceptedIssueId}`, exact: true }).click();
    await page.locator(`#work-issue-${facts.acceptedIssueId}`).waitFor();

    step("blocked");
    const blocked = (await json<OperatingView>(`/api/operating/issues/${facts.blockedIssueId}`)).sections.find(section => section.kind === "issues")!.rows.find(row => row.id === facts.blockedIssueId)!;
    assert.ok(["blocked", "needs-decision"].includes(blocked.operating_state ?? "")); assert.ok(blocked.decision_reason, "Blocked facts expose a known reason or explicit evidence gap");
    await navigate("Issues"); const blockedCard = page.locator(`#work-issue-${facts.blockedIssueId}`); await blockedCard.waitFor();
    assert.ok((await blockedCard.innerText()).includes("Bloqueado") || (await blockedCard.innerText()).includes("Necesita decisión"));
    assert.equal(await blockedCard.getByRole("button", { name: "Despachar tarea aprobada", exact: true }).count(), 0);

    step("incomplete");
    const personalPanel = await openProject("beta");
    const personalReadiness = page.getByRole("region", { name: "Preparación del proyecto", exact: true });
    await personalReadiness.getByRole("button", { name: "Consultar preparación", exact: true }).click();
    await personalReadiness.getByRole("region", { name: "Opciones registradas del proyecto", exact: true }).waitFor();
    await personalReadiness.getByText("Evidencia local consultada y decisiones", { exact: true }).click();
    assert.ok((await personalReadiness.innerText()).includes("intentionally-unaligned"));
    assert.ok(await personalReadiness.getByRole("button", { name: "Revisar o proponer issue", exact: true }).isEnabled());
    await personalPanel.getByRole("button", { name: "Consultar entrega y seguimiento", exact: true }).click();
    await personalPanel.getByLabel("Issue de entrega", { exact: true }).selectOption(facts.personalIssueId);
    await personalPanel.getByRole("button", { name: "Registrar observación manual", exact: true }).click();
    assert.equal(await personalPanel.getByLabel("Compromiso relacionado", { exact: true }).locator("option").count(), 1);
    assert.equal(await personalPanel.locator(".delivery-readiness-record").count(), 0); await privateHidden();

    step("harness");
    await openProject("alpha"); const harness = page.getByRole("region", { name: "Harness del proyecto", exact: true });
    await harness.getByTestId("harness-status").waitFor();
    assert.ok((await harness.innerText()).includes("unknown") || (await harness.innerText()).includes("absent"));
    await harness.getByText("Ver preview de remediación (solo lectura)", { exact: true }).click();
    await harness.getByRole("region", { name: "Preview de remediación del Harness", exact: true }).waitFor();
    assert.equal(mutations.length, 0); assert.equal(existsSync(stateFile("harness/profiles.json")), false);
    assert.equal(await harnessTreeHash(join(root, "projects")), sourceHash);
    assert.equal(await reads.snapshot(() => harnessTreeHash(stateFile(""), ["issues/issues.json"])), unrelatedStateHash,
      "Only the manual issue aggregate changes; task/event/routine/budget and all other state remain untouched");

    step("delivery");
    await consultIssue();
    assert.equal(await panel.getByText("Sin observación registrada; no implica éxito ni fallo.", { exact: true }).count(), 5);
    assert.ok((await panel.innerText()).includes("aceptación técnica exacta no está acreditada"));
    const entries: IssueEvidenceReference[] = [];
    for (const [index, kind] of KINDS.entries()) {
      if (index) { await panel.getByRole("button", { name: "Consultar entrega y seguimiento", exact: true }).click(); await panel.getByRole("heading", { name: "Aceptación técnica", exact: true }).waitFor(); }
      await panel.getByRole("button", { name: "Registrar observación manual", exact: true }).click();
      const form = panel.getByRole("form", { name: "Registrar observación de entrega", exact: true });
      await form.getByLabel("Tipo de observación", { exact: true }).selectOption(kind);
      await form.getByLabel("Momento de la observación (hora local)", { exact: true }).fill("2026-10-15T12:00");
      await form.getByLabel("Resumen privado", { exact: true }).fill(`SYNTHETIC_PRIVATE_DELIVERY_${index}`);
      await form.getByLabel("Referencia de origen", { exact: true }).fill(`SYNTHETIC_PRIVATE_SOURCE_${index}`);
      await form.getByLabel("Próxima acción privada", { exact: true }).fill(`SYNTHETIC_PRIVATE_NEXT_${index}`);
      await form.getByLabel("Compromiso relacionado", { exact: true }).selectOption(facts.commitmentId);
      assert.equal(await form.getByLabel("Candidato relacionado", { exact: true }).inputValue(), "");
      const confirm = form.getByRole("checkbox", { name: CONFIRM, exact: true }), save = form.getByRole("button", { name: "Guardar observación local", exact: true });
      assert.ok(!(await confirm.isChecked()) && await save.isDisabled());
      if (!index) { await confirm.check(); await form.getByLabel("Referencia de origen", { exact: true }).fill("SYNTHETIC_PRIVATE_SOURCE_EDITED"); assert.ok(!(await confirm.isChecked()) && await save.isDisabled()); }
      await confirm.check(); const response = await observeResponse(page, `/api/work-issues/${issue.id}/delivery-observations`, "POST", () => save.click()); assert.equal(response.status(), 201);
      const result = await response.json() as { issue: WorkIssue; evidence: IssueEvidenceReference }; entries.push(result.evidence);
      assert.equal(result.issue.status, issue.status); assert.equal(result.issue.revision, issue.revision + index + 1); assert.equal(result.issue.scope_revision, issue.scope_revision);
      assert.deepEqual(result.issue.task_ids, issue.task_ids); assert.deepEqual(result.issue.candidate_ids, issue.candidate_ids);
      assert.equal(result.evidence.status, "informational"); assert.equal(result.evidence.kind, "work-product");
      for (const field of ["task_id", "execution_id", "candidate_id", "candidate_revision", "diff_fingerprint"] as const) assert.equal(result.evidence[field], null);
      assert.equal(result.evidence.created_at, NOW); assert.equal(result.evidence.delivery_observation!.occurred_at, OBSERVED);
      assert.equal(result.evidence.delivery_observation!.kind, kind); assert.equal(result.evidence.delivery_observation!.origin, "operator-entered");
      assert.equal(Object.hasOwn(result.evidence, "testing_evidence_fingerprint"), false);
      await panel.getByRole("button", { name: "Consultar entrega y seguimiento", exact: true }).waitFor(); await privateHidden();
    }
    await panel.getByRole("button", { name: "Consultar entrega y seguimiento", exact: true }).click();
    await panel.getByRole("heading", { name: "Seguimiento registrado", exact: true }).waitFor();
    assert.equal(await panel.locator(".delivery-readiness-record").count(), 5);
    for (const [index, entry] of entries.entries()) {
      const record = panel.locator(".delivery-readiness-record").filter({ hasText: entry.id });
      await record.getByRole("button", { name: `Mostrar detalle privado ${entry.id}`, exact: true }).click();
      assert.equal(await record.getByText(`SYNTHETIC_PRIVATE_DELIVERY_${index}`, { exact: true }).count(), 1); assert.equal(await record.getByRole("link").count(), 0);
      for (const other of [0, 1, 2, 3, 4].filter(value => value !== index)) assert.ok(!(await page.locator("body").innerText()).includes(`SYNTHETIC_PRIVATE_DELIVERY_${other}`));
      await record.getByRole("button", { name: `Ocultar detalle privado ${entry.id}`, exact: true }).click(); await privateHidden();
    }
    step("mobile");
    await page.setViewportSize({ width: 390, height: 844 }); await panel.getByRole("button", { name: "Registrar observación manual", exact: true }).click();
    const mobile = panel.getByRole("form", { name: "Registrar observación de entrega", exact: true });
    await mobile.getByLabel("Tipo de observación", { exact: true }).focus(); await page.keyboard.press("Tab");
    assert.ok(await mobile.getByLabel("Momento de la observación (hora local)", { exact: true }).evaluate(element => document.activeElement === element && Number.parseFloat(getComputedStyle(element).outlineWidth) >= 2));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    assert.ok(await mobile.locator("input,select,textarea,button").evaluateAll(elements => elements.every(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth; })));
    assert.ok((await mobile.getByRole("button", { name: "Guardar observación local", exact: true }).boundingBox())!.width < 350);
    assert.ok(await mobile.getByLabel("Tipo de observación", { exact: true }).locator("option").evaluateAll(elements => elements.length === 5 && elements.every(element => { const style = getComputedStyle(element); return style.color !== style.backgroundColor && style.backgroundColor !== "rgba(0, 0, 0, 0)"; })));
    await panel.getByRole("button", { name: "Cancelar registro manual", exact: true }).click(); await page.setViewportSize({ width: 1440, height: 1000 });

    step("privacy");
    const projectPanel = await openProject("alpha"); await projectPanel.getByRole("button", { name: "Consultar entrega y seguimiento", exact: true }).click();
    await projectPanel.getByLabel("Issue de entrega", { exact: true }).selectOption(issue.id); await projectPanel.getByRole("heading", { name: "Respuesta registrada", exact: true }).waitFor();
    assert.equal(await projectPanel.locator(".delivery-readiness-record").count(), 5); await privateHidden();
    await page.getByRole("button", { name: "Preparar tarea", exact: true }).click();
    assert.ok(!(await page.getByRole("textbox", { name: "Instrucciones", exact: true }).inputValue()).includes("SYNTHETIC_PRIVATE"));
    await navigate("Clientes"); await page.getByRole("button", { name: /Public completed milestone/ }).click();
    const commitmentPanel = page.getByRole("region", { name: "Entrega y seguimiento", exact: true });
    await commitmentPanel.getByRole("button", { name: "Consultar entrega y seguimiento", exact: true }).click();
    await commitmentPanel.getByLabel("Issue de entrega", { exact: true }).selectOption(issue.id); await commitmentPanel.getByRole("heading", { name: "Respuesta registrada", exact: true }).waitFor();
    assert.equal(await commitmentPanel.locator(".delivery-readiness-record").count(), 5); await privateHidden();
    for (const section of ["Hoy", "SURTEC", "Overview"]) { await navigate(section); await privateHidden(); }
    for (const path of ["/api/operating/overview", `/api/operating/objectives/${facts.objectiveId}`, "/api/operating/projects/alpha", `/api/operating/issues/${issue.id}`, "/api/today"]) {
      const response = await request(path); assert.equal(response.status, 200); assert.ok(!(await response.text()).includes("SYNTHETIC_PRIVATE"));
    }
    const savedBytes = await reads.snapshot(issueBytes), saved = JSON.parse(savedBytes);
    assert.deepEqual(saved.issues[issue.id], { ...originalDocument.issues[issue.id], evidence_ids: [...issue.evidence_ids, ...entries.map(entry => entry.id)], revision: issue.revision + 5 });
    assert.ok(!JSON.stringify(saved.events).includes("SYNTHETIC_PRIVATE"));
    for (const path of unchangedPaths) assert.ok(await readFile(stateFile(path), "utf8") === unchanged[unchangedPaths.indexOf(path)], "Unrelated organization/client/profile bytes remain unchanged");

    step("degraded");
    await reads.navigate(() => page.goto("about:blank")); await scenario(api!, "degraded");
    const degradedBytes = await readFile(stateFile("workflows/workflows.json"), "utf8");
    const degraded = await json<OperatingView>("/api/operating/overview");
    const workflowSection = degraded.sections.find(section => section.kind === "workflows")!;
    assert.equal(workflowSection.source.availability, "unavailable"); assert.equal(workflowSection.total, null);
    assert.equal(degraded.sections.find(section => section.kind === "company")!.source.availability, "available");
    await page.goto(uiUrl); await navigate("SURTEC");
    await operating.getByRole("region", { name: "Workflows", exact: true }).getByText(/No disponible/).waitFor();
    assert.ok((await operating.innerText()).includes("No disponible")); await privateHidden(); await reads.drain();
    assert.ok(await readFile(stateFile("workflows/workflows.json"), "utf8") === degradedBytes, "Degraded reads preserve exact unsupported source bytes");
    assert.ok(await issueBytes() === savedBytes); await reads.navigate(() => page.goto("about:blank")); await scenario(api!, "restore");

    step("refusals");
    const token = (await json<{ token: string }>("/api/session")).token, endpoint = `/api/work-issues/${issue.id}/delivery-observations`;
    const headers = { "Content-Type": "application/json", "X-Surtec-Session": token };
    const currentInput: RecordDeliveryObservationInput = { project_id: "alpha", expected_revision: issue.revision + 5, scope_revision: issue.scope_revision,
      candidate_id: null, candidate_revision: null, diff_fingerprint: null, delivery_observation: entries[0]!.delivery_observation!, confirm: true };
    const refuse = async (input: unknown, expected: number, extraHeaders: Record<string, string> = headers) => {
      const bytes = await issueBytes(), response = await request(endpoint, { method: "POST", headers: extraHeaders, body: JSON.stringify(input) });
      assert.equal(response.status, expected, "Protected manual record refuses invalid or stale request"); assert.ok(await issueBytes() === bytes, "Refusal leaves exact issue bytes unchanged");
    };
    await refuse(currentInput, 403, { "Content-Type": "application/json" });
    await refuse(currentInput, 403, { ...headers, Origin: "https://external.invalid" });
    await refuse(currentInput, 403, { ...headers, "Sec-Fetch-Site": "cross-site" });
    await refuse({ ...currentInput, expected_revision: issue.revision }, 409);
    await refuse({ ...currentInput, project_id: "beta" }, 409);
    await refuse({ ...currentInput, candidate_id: "C-00000000-0000-4000-8000-000000000001", candidate_revision: "a".repeat(40), diff_fingerprint: "b".repeat(64) }, 409);
    await refuse({ ...currentInput, delivery_observation: { ...currentInput.delivery_observation, source_reference: "https://external.invalid/?private=value" } }, 400);
    await refuse({ ...currentInput, delivery_observation: { ...currentInput.delivery_observation, schema_version: 2 } }, 400);
    await scenario(api!, "future-delivery");
    const futureBytes = await issueBytes(); const future = await request(`/api/work-issues/${issue.id}`); assert.equal(future.status, 409); assert.ok(await issueBytes() === futureBytes);
    await refuse(currentInput, 409); await scenario(api!, "restore");
    await scenario(api!, "overflow"); await refuse(currentInput, 409); await scenario(api!, "restore");
    assert.ok(await issueBytes() === savedBytes);

    step("reload");
    await page.goto(uiUrl); await consultIssue(); await reads.navigate(() => page.reload()); await consultIssue();
    assert.equal(await panel.locator(".delivery-readiness-record").count(), 5); assert.ok(await reads.snapshot(issueBytes) === savedBytes); await privateHidden();
    step("restart");
    await reads.navigate(() => page.goto("about:blank")); assert.ok(await stopApi(api)); api = null;
    await vite!.close(); vite = null;
    started = await startApi(runtime, environment, value => { api = value; }); apiUrl = started.url;
    assert.deepEqual(started.facts, facts); uiUrl = await startUi(root, apiUrl, value => { vite = value; });
    await refuse(currentInput, 403);
    const newToken = (await json<{ token: string }>("/api/session")).token; assert.ok(newToken !== token, "Restart rotates process-local session authority");
    await page.goto(uiUrl); await consultIssue(); assert.equal(await panel.locator(".delivery-readiness-record").count(), 5); await privateHidden();
    assert.ok(await reads.snapshot(issueBytes) === savedBytes);
    for (const path of unchangedPaths) assert.ok(await readFile(stateFile(path), "utf8") === unchanged[unchangedPaths.indexOf(path)]);
    assert.equal(await harnessTreeHash(join(root, "projects")), sourceHash);
    assert.equal(await reads.snapshot(() => harnessTreeHash(stateFile(""), ["issues/issues.json"])), unrelatedStateHash,
      "Unrelated state, including seeded task bytes and any new records, remains unchanged after restart");
    assert.deepEqual(mutations, Array.from({ length: 5 }, () => `POST ${endpoint}`));
    for (const path of ["state/workflows/workflows.json", "state/harness/profiles.json", "forbidden-effect", "forbidden-runtime"]) assert.equal(existsSync(join(root, path)), false);
    assert.equal(pageErrors, 0, "No browser page errors"); assert.equal(consoleErrors, 0, "No browser console errors"); assert.equal(httpErrors, 0, "No unexpected browser HTTP errors"); assert.equal(externalRequests, 0, "No external browser traffic");
    assert.ok(offlineFontRequests > 0); assert.equal(offlineFontResponses, offlineFontRequests, "Every optional remote stylesheet request is fulfilled locally");
    passed.push(stage);
  } catch (error) { failure = operatingFailureSummary(stage, error); failureLocation = operatingFailureLocation(error); }
  finally {
    tracker?.dispose();
    const cleanup = await cleanupSmoke({ root, browser: browser ? () => browser!.close() : undefined, vite: vite ? () => vite!.close() : undefined, api: api ? () => stopApi(api) : undefined });
    if (!cleanup.browser_closed || !cleanup.vite_closed || !cleanup.api_stopped || !cleanup.workspace_removed || cleanup.failures.length) {
      failure ??= operatingFailureSummary("cleanup", new Error("Owned cleanup incomplete"));
    }
    console.log(JSON.stringify({ ...(failure ?? { status: "passed" }), checks: passed, actual_api: actualApi, actual_vite: actualVite, actual_browser: actualBrowser,
      ...(failure ? { source_location: failureLocation, browser_failures: browserFailures } : {}), offline_font_responses: offlineFontResponses, real_runtime_calls: 0, cleanup }));
    if (root && !cleanup.workspace_removed) console.error(`Owned operating fixture retained for inspection: ${root}`);
  }
  if (failure) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runOperatingViewsSmoke().catch(error => { console.error(JSON.stringify(operatingFailureSummary("setup", error))); process.exitCode = 1; });
}
