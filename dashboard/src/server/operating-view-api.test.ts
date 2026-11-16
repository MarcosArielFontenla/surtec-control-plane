import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import type { Browser } from "playwright";
import type { ViteDevServer } from "vite";
import { chromium } from "playwright";
import { randomUUID } from "node:crypto";
import type { DeliveryObservation, IssueCreateInput, IssueEvidenceReference, IssueLineage, RecordDeliveryObservationInput, WorkIssue } from "../../../lib/issues/types";
import { mutateIssueDocument, readIssueDocument } from "../../../lib/state/issues";
import { createIssueService } from "./issue-service";
import { OPERATING_SECTIONS, projectOperatingView, type OperatingFact, type OperatingSourceInput, type OperatingView, type OperatingViewRequest } from "../../../lib/operating-views";
import type { ProcessManager } from "../../../runner/process-manager";
import { createApp, type AppDependencies } from "./index";
import { createOperatingViewService, type OperatingViewService } from "./operating-view-service";
import { fetchOperatingView, getOperatingIssue, getOperatingObjective, getOperatingOverview, getOperatingProject, recordDeliveryObservation } from "../ui/api";

const NOW = "2026-10-16T12:00:00.000Z", OBSERVED = "2026-10-15T12:00:00.000Z";
const ISSUE = "I-00000000-0000-4000-8000-000000000001";
let root: string;
let previousState: string | undefined;
beforeEach(() => { previousState = process.env.SURTEC_STATE_DIR; root = mkdtempSync(join(tmpdir(), "surtec-q-read-api-")); writeFileSync(join(root, "sentinel.txt"), "fixture-private-sentinel"); });
afterEach(() => {
  if (previousState === undefined) delete process.env.SURTEC_STATE_DIR; else process.env.SURTEC_STATE_DIR = previousState;
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  expect(dirname(resolve(root))).toBe(resolve(tmpdir())); expect(basename(root)).toMatch(/^surtec-q-read-api-/);
  expect(lstatSync(root).isSymbolicLink()).toBe(false); rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false);
});

function deliveryIssueInput(projectId = "alpha"): IssueCreateInput {
  const expected = "Inspect a fictional local result", criteria = ["The result remains inspectable"];
  return { project_id: projectId, title: "Public delivery issue", expected_outcome: expected, acceptance_criteria: criteria,
    authorized_scope: { expected_outcome: expected, acceptance_criteria: criteria, allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["ui"], explicit_exclusions: [] } };
}
function deliveryInput(issue: WorkIssue, kind: DeliveryObservation["kind"] = "client-response-recorded"): RecordDeliveryObservationInput {
  return { project_id: issue.project_id, expected_revision: issue.revision, scope_revision: issue.scope_revision,
    candidate_id: null, candidate_revision: null, diff_fingerprint: null, confirm: true,
    delivery_observation: { schema_version: 1, kind, origin: "operator-entered", commitment_id: null, occurred_at: OBSERVED,
      summary: "SYNTHETIC_PRIVATE_CLIENT_RESPONSE", source_reference: "fictional-response-1", next_action: "SYNTHETIC_PRIVATE_FOLLOW_UP" } };
}
function deliveryFixture() {
  process.env.SURTEC_STATE_DIR = join(root, "state");
  const forbidden = vi.fn(() => { throw new Error("Synthetic delivery effects are forbidden"); }), dispatch = vi.fn();
  const issues = createIssueService(root, { now: () => new Date(NOW), projectIds: () => ["alpha", "beta"], createTask: forbidden });
  const operating = createOperatingViewService(root, { stateRoot: join(root, "state"), projectsRoot: join(root, "projects"), clock: () => new Date(NOW) });
  const dependencies = { issues, operating, integrations: { read: forbidden, invalidate: forbidden }, context: { roles: forbidden, preview: forbidden },
    signals: { read: forbidden, act: forbidden }, harness: { read: forbidden, refresh: forbidden } } as unknown as AppDependencies;
  const create = () => createApp(root, dispatch, { list: forbidden, start: forbidden, stop: forbidden, get: forbidden } as unknown as ProcessManager, undefined, dependencies);
  return { app: create(), create, issues, forbidden, dispatch, bytes: () => readFileSync(join(root, "state/issues/issues.json"), "utf8") };
}
async function deliveryHeaders(app: ReturnType<typeof createApp>): Promise<Record<string, string>> {
  const { token } = await (await app.request("/api/session")).json();
  return { "X-Surtec-Session": token, "Content-Type": "application/json" };
}

describe("protected manual delivery API", () => {
  it("appends one independently timestamped informational fact and keeps legacy fields, lifecycle and implicit summaries unchanged", async () => {
    const fixture = deliveryFixture(), issue = fixture.issues.create(deliveryIssueInput()), legacy = fixture.bytes();
    const input = deliveryInput(issue), response = await fixture.app.request(`/api/work-issues/${issue.id}/delivery-observations`, { method: "POST", headers: await deliveryHeaders(fixture.app), body: JSON.stringify(input) });
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("no-store");
    const saved = await response.json() as { issue: WorkIssue; evidence: IssueEvidenceReference };
    expect(saved.issue).toEqual({ ...issue, evidence_ids: [saved.evidence.id], revision: issue.revision + 1 });
    expect(saved.evidence).toMatchObject({ schema_version: 1, status: "informational", task_id: null, execution_id: null, candidate_id: null,
      created_at: NOW, delivery_observation: input.delivery_observation });
    expect(["work-product", "provider"]).toContain(saved.evidence.kind); expect(JSON.parse(legacy).issues[issue.id].evidence_ids).toEqual([]);
    const detailResponse = await fixture.app.request(`/api/work-issues/${issue.id}`), detail = await detailResponse.json() as IssueLineage;
    expect(detailResponse.status).toBe(200); expect(detail.evidence).toEqual([saved.evidence]);
    expect(JSON.stringify({ issue: detail.issue, events: readIssueDocument().events, label: saved.evidence.label, reference: saved.evidence.reference })).not.toContain("SYNTHETIC_PRIVATE");
    const operating = await fixture.app.request("/api/operating/overview"); expect(operating.status).toBe(200); expect(JSON.stringify(await operating.json())).not.toContain("SYNTHETIC_PRIVATE");
    expect(fixture.dispatch).not.toHaveBeenCalled(); expect(fixture.forbidden).not.toHaveBeenCalled();
    expect(existsSync(join(root, "state/tasks"))).toBe(false); expect(existsSync(join(root, "state/workflows"))).toBe(false);
    const bytes = fixture.bytes(), restarted = fixture.create();
    expect((await restarted.request(`/api/work-issues/${issue.id}`)).status).toBe(200); expect(fixture.bytes()).toBe(bytes);
    const staleToken = await deliveryHeaders(fixture.app);
    expect((await restarted.request(`/api/work-issues/${issue.id}/delivery-observations`, { method: "POST", headers: staleToken, body: JSON.stringify({ ...input, expected_revision: saved.issue.revision }) })).status).toBe(403);
    expect(fixture.bytes()).toBe(bytes);
    const replay = await fixture.app.request(`/api/work-issues/${issue.id}/delivery-observations`, { method: "POST", headers: await deliveryHeaders(fixture.app), body: JSON.stringify(input) });
    expect(replay.status).toBe(409); expect(fixture.bytes()).toBe(bytes);
  });

  it.each([
    ["missing session", {}], ["invalid session", { "X-Surtec-Session": "invalid" }],
    ["foreign host", { host: "evil.example" }], ["foreign origin", { origin: "https://evil.example" }], ["cross-site", { "sec-fetch-site": "cross-site" }],
  ] as const)("refuses %s before any state effect", async (_label, rejectedHeaders) => {
    const fixture = deliveryFixture(), issue = fixture.issues.create(deliveryIssueInput()), before = fixture.bytes();
    const headers = { ...await deliveryHeaders(fixture.app), ...rejectedHeaders };
    if (_label === "missing session") delete (headers as Record<string, string>)["X-Surtec-Session"];
    const response = await fixture.app.request(`/api/work-issues/${issue.id}/delivery-observations`, { method: "POST", headers, body: JSON.stringify(deliveryInput(issue)) });
    expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("no-store"); expect(fixture.bytes()).toBe(before);
    expect(fixture.dispatch).not.toHaveBeenCalled(); expect(fixture.forbidden).not.toHaveBeenCalled();
  });

  it.each([
    ["null body", () => null, 400], ["unknown property", (input: RecordDeliveryObservationInput) => ({ ...input, execute: true }), 400],
    ["missing confirmation", (input: RecordDeliveryObservationInput) => ({ ...input, confirm: false }), 400],
    ["null facet", (input: RecordDeliveryObservationInput) => ({ ...input, delivery_observation: null }), 400],
    ["future facet", (input: RecordDeliveryObservationInput) => ({ ...input, delivery_observation: { ...input.delivery_observation, schema_version: 2 } }), 400],
    ["malformed date", (input: RecordDeliveryObservationInput) => ({ ...input, delivery_observation: { ...input.delivery_observation, occurred_at: "2026-02-30T00:00:00.000Z" } }), 400],
    ["future observation", (input: RecordDeliveryObservationInput) => ({ ...input, delivery_observation: { ...input.delivery_observation, occurred_at: "2099-01-01T00:00:00.000Z" } }), 400],
    ["unsafe reference", (input: RecordDeliveryObservationInput) => ({ ...input, delivery_observation: { ...input.delivery_observation, source_reference: "file:///C:/private/notes.txt" } }), 400],
    ["overlong summary", (input: RecordDeliveryObservationInput) => ({ ...input, delivery_observation: { ...input.delivery_observation, summary: "x".repeat(501) } }), 400],
    ["cross project", (input: RecordDeliveryObservationInput) => ({ ...input, project_id: "beta" }), 409],
    ["wrong scope", (input: RecordDeliveryObservationInput) => ({ ...input, scope_revision: 2 }), 409],
    ["missing candidate", (input: RecordDeliveryObservationInput) => ({ ...input, candidate_id: "C-00000000-0000-4000-8000-000000000001", candidate_revision: "b".repeat(40), diff_fingerprint: "c".repeat(64) }), 409],
  ] as const)("preserves bytes when rejecting %s", async (_label, change, status) => {
    const fixture = deliveryFixture(), issue = fixture.issues.create(deliveryIssueInput()), before = fixture.bytes();
    const response = await fixture.app.request(`/api/work-issues/${issue.id}/delivery-observations`, { method: "POST", headers: await deliveryHeaders(fixture.app), body: JSON.stringify(change(deliveryInput(issue))) });
    expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("no-store"); expect(fixture.bytes()).toBe(before);
    expect(fixture.dispatch).not.toHaveBeenCalled(); expect(fixture.forbidden).not.toHaveBeenCalled();
  });

  it("bounds raw bodies, refuses malformed JSON and refuses overflow without eviction", async () => {
    const fixture = deliveryFixture(), issue = fixture.issues.create(deliveryIssueInput()), headers = await deliveryHeaders(fixture.app), path = `/api/work-issues/${issue.id}/delivery-observations`, before = fixture.bytes();
    for (const [body, status] of [["{", 400], [JSON.stringify({ text: "x".repeat(8192) }), 413]] as const) {
      const response = await fixture.app.request(path, { method: "POST", headers, body }); expect(response.status).toBe(status); expect(fixture.bytes()).toBe(before);
    }
    const first = fixture.issues.recordDeliveryObservation(issue.id, deliveryInput(issue));
    mutateIssueDocument(document => { for (let index = 1; index < 64; index++) { const id = `E-${randomUUID()}`; document.evidence[id] = { ...first.evidence, id }; document.issues[issue.id]!.evidence_ids.push(id); } });
    const full = fixture.bytes(), current = readIssueDocument().issues[issue.id]!;
    const response = await fixture.app.request(path, { method: "POST", headers, body: JSON.stringify(deliveryInput(current)) });
    expect(response.status).toBe(409); expect(fixture.bytes()).toBe(full); expect(readIssueDocument().issues[issue.id]!.evidence_ids).toHaveLength(64);
    expect(fixture.dispatch).not.toHaveBeenCalled(); expect(fixture.forbidden).not.toHaveBeenCalled();
  });

  it("uses the existing protected client mutation without execution or replay", async () => {
    const fixture = deliveryFixture(), issue = fixture.issues.create(deliveryIssueInput());
    const fetchMock = vi.fn((path: string | URL | Request, options?: RequestInit) => fixture.app.request(String(path), options)); vi.stubGlobal("fetch", fetchMock);
    const input = deliveryInput(issue, "follow-up-recorded"), saved = await recordDeliveryObservation(issue.id, input);
    expect(saved.evidence.delivery_observation).toEqual(input.delivery_observation);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/session", `/api/work-issues/${issue.id}/delivery-observations`]);
    const [, options] = fetchMock.mock.calls[1]!; expect(options?.method).toBe("POST"); expect(new Headers(options?.headers).has("X-Surtec-Session")).toBe(true);
    const before = fixture.bytes(); await expect(recordDeliveryObservation(issue.id, input)).rejects.toThrow(); expect(fixture.bytes()).toBe(before);
    expect(fetchMock.mock.calls).toHaveLength(3); expect(fixture.dispatch).not.toHaveBeenCalled(); expect(fixture.forbidden).not.toHaveBeenCalled();
  });
});

it.runIf(process.env.SURTEC_DELIVERY_BROWSER_SMOKE === "1")("records independent manual facts through actual isolated API/Vite/browser, reload and restart without authority or disclosure", async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  const { cp, mkdtemp, mkdir, readFile, symlink, writeFile } = await import("node:fs/promises");
  const { spawn, execFileSync } = await import("node:child_process"), { createServer: probeServer } = await import("node:net");
  const { createServer } = await import("vite");
  const { cleanupSmoke, harnessTreeHash } = await import("../../../scripts/playwright-local-app-smoke");
  const ownedRoot = await mkdtemp(join(tmpdir(), "surtec-local-dashboard-")), repoRoot = resolve("."), runtime = join(ownedRoot, "runtime");
  let browser: Browser | null = null, vite: ViteDevServer | null = null, child: ChildProcess | null = null, exited = Promise.resolve();
  let output = "", stage = "setup";
  const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) if (process.env[key]) environment[key] = process.env[key];
  Object.assign(environment, { NODE_ENV: "test", SURTEC_STATE_DIR: join(ownedRoot, "state"), SURTEC_PROJECTS_ROOT: join(ownedRoot, "projects"), SURTEC_CODEX_BIN: join(ownedRoot, "forbidden-runtime"), SURTEC_FIXTURE_ROOT: ownedRoot });
  async function startApi(): Promise<string> {
    output = "";
    child = spawn(process.execPath, ["--import", "tsx", "delivery-api.ts"], { cwd: runtime, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    exited = new Promise<void>(done => { child!.once("exit", () => done()); child!.once("error", () => done()); });
    const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); }; child.stdout!.on("data", collect); child.stderr!.on("data", collect);
    for (let tries = 0; tries < 150; tries++) {
      const ready = output.match(/SURTEC_DELIVERY_READY:(\d+)/); if (ready) return `http://127.0.0.1:${ready[1]}`;
      if (child.exitCode !== null) throw new Error(`Synthetic API failed at ${stage}: ${output}`); await delay(200);
    }
    throw new Error(`Synthetic API readiness failed at ${stage}: ${output}`);
  }
  async function stopApi() {
    if (!child || child.exitCode !== null) return true;
    if (child.connected) child.send("stop");
    if (await Promise.race([exited.then(() => true), delay(8000).then(() => false)])) return true;
    child.kill("SIGKILL"); return Promise.race([exited.then(() => true), delay(3000).then(() => false)]);
  }
  async function startUi(apiUrl: string) {
    const probe = probeServer(); await new Promise<void>((done, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", () => done()); });
    const port = (probe.address() as AddressInfo).port; await new Promise<void>((done, reject) => probe.close(error => error ? reject(error) : done()));
    vite = await createServer({ configFile: join(repoRoot, "vite.config.ts"), root: join(repoRoot, "dashboard"), cacheDir: join(ownedRoot, "vite-cache"), server: { host: "127.0.0.1", port, strictPort: true, proxy: { "/api": { target: apiUrl, changeOrigin: false } } }, logLevel: "error" });
    await vite.listen(); return vite.resolvedUrls!.local[0]!;
  }
  try {
    await mkdir(join(ownedRoot, "registry"), { recursive: true }); await mkdir(join(ownedRoot, "projects/alpha"), { recursive: true }); await mkdir(join(ownedRoot, "empty-hooks"));
    await writeFile(join(ownedRoot, "projects/alpha/fixture.txt"), "Public owned project sentinel\n");
    execFileSync("git", ["-c", `core.hooksPath=${join(ownedRoot, "empty-hooks")}`, "init", "--quiet"], { cwd: join(ownedRoot, "projects/alpha"), env: environment, windowsHide: true, stdio: "pipe" });
    await writeFile(join(ownedRoot, "registry/projects.yml"), "projects:\n  alpha: {}\n"); await writeFile(join(ownedRoot, "registry/agents.yml"), "agents: []\n");
    for (const path of ["lib", "runner", "dashboard/src/server", "schemas", "package.json"]) await cp(join(repoRoot, path), join(runtime, path), { recursive: true });
    await symlink(join(repoRoot, "node_modules"), join(runtime, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(join(runtime, "delivery-api.ts"), `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp, type AppDependencies } from './dashboard/src/server/index';
import { createIssueService } from './dashboard/src/server/issue-service';
import { createOrganizationService } from './dashboard/src/server/organization-service';
import { emptyProjectProfile } from './lib/portfolio-profile';
import { upsertProjectProfile } from './lib/state/portfolio-profiles';
const root = process.env.SURTEC_FIXTURE_ROOT!, clock = () => new Date('2026-10-16T12:00:00.000Z');
const forbidden = () => { writeFileSync(join(root, 'forbidden-effect'), 'unexpected effect'); throw new Error('Synthetic effect refused'); };
const issues = createIssueService(root, { now: clock, projectIds: () => ['alpha'], createTask: forbidden });
const organization = createOrganizationService({ clock });
if (!existsSync(join(root, 'initialized'))) {
  organization.saveCompany({ schema_version: 1, id: 'surtec', display_name: 'Public delivery fixture', mission: null, operating_principles: [], active_objective_ids: [], last_reviewed_at: null });
  upsertProjectProfile({ ...emptyProjectProfile('alpha'), last_reviewed_at: '2026-10-16' });
  const expected = 'Inspect a fictional result', criteria = ['Result remains inspectable'];
  issues.create({ project_id: 'alpha', title: 'Public delivery issue', expected_outcome: expected, acceptance_criteria: criteria, authorized_scope: { expected_outcome: expected, acceptance_criteria: criteria, allowed_path_patterns: ['src/**'], excluded_path_patterns: [], allowed_change_categories: ['ui'], explicit_exclusions: [] } });
  writeFileSync(join(root, 'initialized'), 'owned fixture only; no worker or provider');
}
const dependencies = { issues, organization, context: { roles: () => [], preview: forbidden }, integrations: { read: forbidden, invalidate: forbidden }, signals: { read: async () => ({ schema_version: 1, observed_at: clock().toISOString(), signals: [], pinned_signal_ids: [], warnings: [] }), act: forbidden }, inbox: async () => ({ items: [], repos: [] }) } as unknown as AppDependencies;
const app = createApp(root, forbidden as never, { list: () => [], start: forbidden, stop: forbidden, get: forbidden } as never, undefined, dependencies);
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
server.on('listening', () => console.log('SURTEC_DELIVERY_READY:' + (server.address() as { port: number }).port));
process.on('message', message => { if (message === 'stop') server.close(() => process.exit(0)); });
`);
    stage = "actual API/UI start"; let apiUrl = await startApi(); const uiUrl = await startUi(apiUrl);
    const unchangedPaths = ["organization/organization.json", "portfolio/projects.json"], before = await Promise.all(unchangedPaths.map(path => readFile(join(ownedRoot, "state", path), "utf8"))), sourceHash = await harnessTreeHash(join(ownedRoot, "projects"));
    try { browser = await chromium.launch({ headless: true }); }
    catch (error) { if (process.platform !== "win32" || !(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error; browser = await chromium.launch({ headless: true, channel: "msedge" }); }
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10000);
    const pageErrors: string[] = [], consoleErrors: string[] = [], httpErrors: string[] = [], mutations: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message)); page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("response", response => { if (response.status() >= 400) httpErrors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
    page.on("request", request => { if (request.method() !== "GET") mutations.push(`${request.method()} ${new URL(request.url()).pathname}`); });
    await page.goto(uiUrl); await page.getByRole("button", { name: /Issues/ }).click(); await page.getByRole("heading", { name: "Public delivery issue", exact: true }).waitFor();
    const issue = (await (await fetch(`${apiUrl}/api/work-issues`)).json()).issues[0] as WorkIssue;
    const original = JSON.parse(await readFile(join(ownedRoot, "state/issues/issues.json"), "utf8"));
    stage = "explicit browser wrapper records all five independent facts";
    let current = issue;
    // Constant function source keeps the browser import out of Vitest's SSR
    // transform; Playwright serializes the request separately as data.
    const recordInBrowser = new Function("request", "return import('/src/ui/api.ts').then(client => client.recordDeliveryObservation(request.id, request.input));") as
      (request: { id: string; input: RecordDeliveryObservationInput }) => Promise<{ issue: WorkIssue; evidence: IssueEvidenceReference }>;
    for (const kind of ["readiness-reviewed", "environment-observed", "handoff-recorded", "client-response-recorded", "follow-up-recorded"] as const) {
      const input = deliveryInput(current, kind);
      const saved = await page.evaluate(recordInBrowser, { id: issue.id, input });
      expect(saved.evidence.delivery_observation).toEqual(input.delivery_observation); expect(saved.evidence.status).toBe("informational");
      expect(saved.issue.status).toBe("proposed"); expect(saved.issue.task_ids).toEqual([]); expect(saved.issue.scope_revision).toBe(issue.scope_revision); current = saved.issue;
    }
    const inspectSaved = () => page.evaluate(async id => { const response = await fetch(`/api/work-issues/${id}`, { cache: "no-store" }); return { status: response.status, value: await response.json() as IssueLineage }; }, issue.id);
    const saved = await inspectSaved(); expect(saved.status).toBe(200); expect(saved.value.evidence).toHaveLength(5);
    expect(saved.value.evidence.map(item => item.delivery_observation!.kind)).toEqual(["readiness-reviewed", "environment-observed", "handoff-recorded", "client-response-recorded", "follow-up-recorded"]);
    for (const item of saved.value.evidence) expect(item).toMatchObject({ task_id: null, execution_id: null, candidate_id: null, status: "informational", created_at: NOW });
    stage = "existing UI and operating summaries do not expose private nested feedback";
    await page.reload(); await page.getByRole("button", { name: /Issues/ }).click();
    const card = page.locator(`#work-issue-${issue.id}`); await card.getByRole("button", { name: "Ver linaje y evidencia", exact: true }).click(); await card.getByRole("heading", { name: "Public delivery issue", exact: true }).waitFor();
    expect(await card.innerText()).not.toContain("SYNTHETIC_PRIVATE"); expect(await page.locator("body").innerText()).not.toContain("SYNTHETIC_PRIVATE");
    const overview = await page.evaluate(async () => { const response = await fetch("/api/operating/overview", { cache: "no-store" }); return { status: response.status, text: await response.text() }; });
    expect(overview.status).toBe(200); expect(overview.text).not.toContain("SYNTHETIC_PRIVATE");
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const savedBytes = await readFile(join(ownedRoot, "state/issues/issues.json"), "utf8"), after = JSON.parse(savedBytes);
    expect(after.issues[issue.id]).toEqual({ ...original.issues[issue.id], evidence_ids: current.evidence_ids, revision: current.revision });
    expect(JSON.stringify(after.events)).not.toContain("SYNTHETIC_PRIVATE");
    const oldToken = (await (await fetch(`${apiUrl}/api/session`)).json()).token as string;
    const staleBody = deliveryInput(issue), oldHeaders = { "Content-Type": "application/json", "X-Surtec-Session": oldToken };
    const replay = await fetch(`${apiUrl}/api/work-issues/${issue.id}/delivery-observations`, { method: "POST", headers: oldHeaders, body: JSON.stringify(staleBody) }); expect(replay.status).toBe(409);
    expect(await readFile(join(ownedRoot, "state/issues/issues.json"), "utf8")).toBe(savedBytes);
    stage = "API restart retains exact bytes and rotates mutation token";
    await page.goto("about:blank"); expect(await stopApi()).toBe(true); apiUrl = await startApi(); await vite!.close(); const restartedUi = await startUi(apiUrl);
    const staleSession = await fetch(`${apiUrl}/api/work-issues/${issue.id}/delivery-observations`, { method: "POST", headers: oldHeaders, body: JSON.stringify(deliveryInput(current)) }); expect(staleSession.status).toBe(403);
    await page.goto(restartedUi); const reloaded = await inspectSaved(); expect(reloaded).toEqual(saved);
    expect(await readFile(join(ownedRoot, "state/issues/issues.json"), "utf8")).toBe(savedBytes);
    expect(await Promise.all(unchangedPaths.map(path => readFile(join(ownedRoot, "state", path), "utf8")))).toEqual(before); expect(await harnessTreeHash(join(ownedRoot, "projects"))).toBe(sourceHash);
    expect(mutations).toEqual(Array.from({ length: 5 }, () => `POST /api/work-issues/${issue.id}/delivery-observations`));
    for (const path of ["state/tasks", "state/workflows", "state/harness/profiles.json", "forbidden-effect", "forbidden-runtime"]) expect(existsSync(join(ownedRoot, path))).toBe(false);
    expect(pageErrors, JSON.stringify(pageErrors)).toEqual([]); expect(httpErrors, JSON.stringify(httpErrors)).toEqual([]); expect(consoleErrors, JSON.stringify(consoleErrors)).toEqual([]);
  } catch (error) { throw new Error(`Q T009 browser acceptance failed at ${stage}: ${(error as Error).message}`); }
  finally {
    const cleanup = await cleanupSmoke({ root: ownedRoot, browser: browser ? () => browser!.close() : undefined, vite: vite ? () => vite!.close() : undefined, api: child ? stopApi : undefined });
    expect(cleanup).toEqual({ browser_closed: true, vite_closed: true, api_stopped: true, workspace_removed: true, failures: [] }); expect(existsSync(ownedRoot)).toBe(false);
  }
}, 120000);
function source(items: readonly OperatingFact[] = []): OperatingSourceInput {
  return { availability: "available", reason: "observed", origin: "saved", observed_at: OBSERVED, fresh_until: null, complete: true, items };
}
function facts(): Partial<Record<typeof OPERATING_SECTIONS[number], OperatingSourceInput>> {
  return { ...Object.fromEntries(OPERATING_SECTIONS.map((kind) => [kind, source()])),
    company: source([{ id: "surtec", label: "SURTEC", state: null }]),
    objectives: source([{ id: "objective-a", label: "Public objective", state: "active" }]),
    projects: source([{ id: "alpha", label: "Alpha", state: "active", project_kind: "personal", objective_ids: ["objective-a"], primary_objective_id: "objective-a" }]),
    issues: source([{ id: ISSUE, label: "Public issue", state: "needs-decision", project_id: "alpha", objective_id: "objective-a", decision_reason: "scope-changed" }]),
    executions: source([{ id: "TASK-1", label: "Public task", state: "finished", project_id: "alpha", issue_id: ISSUE, result_status: "completed" }]),
  };
}
function fixtureApp(operating?: OperatingViewService) {
  const forbidden = vi.fn(() => { throw new Error("fixture-private-forbidden-effect"); });
  const dispatch = vi.fn(), start = vi.fn(), stop = vi.fn();
  const observation = facts();
  const readers = Object.fromEntries(OPERATING_SECTIONS.map((kind) => [kind, vi.fn(() => observation[kind])]));
  const dependencies = {
    operating: operating ?? createOperatingViewService(root, { stateRoot: join(root, "state"), projectsRoot: join(root, "projects"), clock: () => new Date(NOW), readers }),
    integrations: { read: forbidden, invalidate: forbidden }, signals: { read: forbidden, act: forbidden },
    harness: { read: forbidden, refresh: forbidden }, routines: { budgets: forbidden, warnings: forbidden, list: forbidden, run: forbidden },
    issues: { list: forbidden, detail: forbidden }, workflows: { list: forbidden, detail: forbidden },
  } as unknown as AppDependencies;
  const app = createApp(root, dispatch, { start, stop, list: forbidden, get: forbidden } as unknown as ProcessManager, undefined, dependencies);
  return { app, readers, observation, forbidden, dispatch, start, stop };
}
const paths = ["/api/operating/overview", "/api/operating/objectives/objective-a", "/api/operating/projects/alpha", `/api/operating/issues/${ISSUE}`];

describe("operating GET boundary", () => {
  it.each(paths)("serves validated no-store %s without any provider, refresh or dispatch effect", async (path) => {
    const fixture = fixtureApp(); const response = await fixture.app.request(path);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as OperatingView; expect(body.schema_version).toBe(1); expect(body.sections).toHaveLength(11);
    expect(body.phase_p).toEqual({ budget_cutover: "not-enabled", continuity: "deferred" });
    expect(JSON.stringify(body)).not.toContain("fixture-private");
    for (const callback of [fixture.forbidden, fixture.dispatch, fixture.start, fixture.stop]) expect(callback).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual(["sentinel.txt"]);
  });

  it.each(["refresh=1", "force=true", "stateRoot=private", "id=alpha", "page_size=0", "page_size=51", "page_size=01", "page_size=1.5",
    "page_size=2&page_size=3", "cursor_unknown=abc", "cursor_issues=", "cursor_issues=a&cursor_issues=b", "cursor_issues=a%0Ab"])("refuses unknown/duplicate/unsafe query %s before source reads", async (query) => {
    const fixture = fixtureApp(); const response = await fixture.app.request(`/api/operating/overview?${query}`);
    expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("no-store");
    for (const read of Object.values(fixture.readers)) expect(read).not.toHaveBeenCalled();
    expect(fixture.forbidden).not.toHaveBeenCalled(); expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it.each(["bad..id", "a%2Fb", "a%5Cb", "a%00b"])("refuses unsafe route identifier %s before the service", async (id) => {
    const read = vi.fn(); const { app } = fixtureApp({ read });
    const response = await app.request(`/api/operating/issues/${id}`);
    expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("no-store"); expect(read).not.toHaveBeenCalled();
  });

  it.each([
    { host: "evil.example" }, { host: "127.0.0.1:4317", origin: "https://evil.example" },
    { host: "localhost:4317", "sec-fetch-site": "cross-site" }, { host: "localhost:4317", origin: "http://localhost:9000" },
  ])("preserves loopback/origin/fetch-site refusal before reading (%#)", async (headers) => {
    const read = vi.fn(); const { app } = fixtureApp({ read });
    const requestHeaders = new Headers();
    for (const [key, value] of Object.entries(headers)) if (value !== undefined) requestHeaders.set(key, value);
    const response = await app.request("/api/operating/overview", { headers: requestHeaders });
    expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("no-store"); expect(read).not.toHaveBeenCalled();
  });

  it("does not add any mutation path, with or without a valid session token", async () => {
    const read = vi.fn(); const { app, dispatch, forbidden } = fixtureApp({ read });
    const { token } = await (await app.request("/api/session")).json();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((await app.request(paths[0], { method, body: "{}" })).status).toBe(403);
      const allowedSession = await app.request(paths[0], { method, headers: { "X-Surtec-Session": token }, body: "{}" });
      expect(allowedSession.status).toBe(404); expect(allowedSession.headers.get("cache-control")).toBe("no-store");
    }
    expect(read).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled();
  });

  it("distinguishes an authoritative not-found focus from unavailable evidence", async () => {
    const fixture = fixtureApp(); const notFound = await fixture.app.request("/api/operating/projects/missing");
    expect(notFound.status).toBe(404); expect(await notFound.json()).toEqual({ error: "Operating view focus was not found." });
    const unavailable = fixtureApp(createOperatingViewService(root, { stateRoot: join(root, "missing-state"), projectsRoot: join(root, "missing-projects"), clock: () => new Date(NOW) }));
    const response = await unavailable.app.request("/api/operating/projects/alpha");
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ focus_status: "unavailable" });
  });

  it("isolates source failure in a successful response instead of echoing its exception", async () => {
    const subject = createOperatingViewService(root, { stateRoot: join(root, "state"), projectsRoot: join(root, "projects"), clock: () => new Date(NOW),
      readers: { company: () => source([{ id: "surtec", label: "SURTEC", state: null }]), signals: async () => { throw new Error("fixture-private-error"); } } });
    const response = await fixtureApp(subject).app.request(paths[0]); const body = await response.json() as OperatingView;
    expect(response.status).toBe(200); expect(body.sections.find((item) => item.kind === "signals")?.source.reason).toBe("read-failed");
    expect(body.sections.find((item) => item.kind === "company")?.total).toBe(1); expect(JSON.stringify(body)).not.toContain("fixture-private");
  });

  it("normalizes whole-service failures and refuses malformed, future or wrong-focus injected responses", async () => {
    const valid = projectOperatingView({ schema_version: 1, as_of: NOW, sources: facts() });
    for (const result of [null, { ...valid, schema_version: 2 }, { ...valid, execution_authority: "execute" }, valid]) {
      const { app } = fixtureApp({ read: vi.fn(async () => result as OperatingView) });
      const response = await app.request("/api/operating/projects/alpha");
      expect(response.status).toBe(503); expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "Operating view sources are unavailable; no changes were made." });
    }
    const { app } = fixtureApp({ read: async () => { throw new Error("fixture-private-exception"); } });
    const response = await app.request(paths[0]); expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("fixture-private");
  });

  it("transports page size and per-section cursor without exposing another scope", async () => {
    const fixture = fixtureApp(); fixture.observation.issues = source(Array.from({ length: 3 }, (_, index) => ({ id: `issue-${index}`, label: "Public issue", state: "proposed", project_id: "alpha" })));
    const first = await (await fixture.app.request(`${paths[0]}?page_size=2`)).json() as OperatingView;
    const cursor = first.sections.find((item) => item.kind === "issues")!.next_cursor!;
    const next = await fixture.app.request(`${paths[0]}?page_size=2&cursor_issues=${encodeURIComponent(cursor)}`);
    expect(next.status).toBe(200); expect((await next.json() as OperatingView).sections.find((item) => item.kind === "issues")?.rows.map((item) => item.id)).toEqual(["issue-2"]);
    expect((await fixture.app.request(`${paths[2]}?cursor_issues=${encodeURIComponent(cursor)}`)).status).toBe(400);
  });
});

describe("operating API client", () => {
  it("uses only GET/no-store and validates all four response/focus bindings without requesting a session", async () => {
    const fixture = fixtureApp();
    const fetchMock = vi.fn((path: string | URL | Request, options?: RequestInit) => fixture.app.request(String(path), options)); vi.stubGlobal("fetch", fetchMock);
    for (const call of [() => getOperatingOverview(), () => getOperatingObjective("objective-a"), () => getOperatingProject("alpha"), () => getOperatingIssue(ISSUE)]) expect((await call()).schema_version).toBe(1);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(paths);
    for (const [, options] of fetchMock.mock.calls) expect(options).toEqual({ method: "GET", cache: "no-store" });
    expect(fixture.dispatch).not.toHaveBeenCalled(); expect(fixture.forbidden).not.toHaveBeenCalled();
  });

  it("serializes section cursors through the same validated GET contract", async () => {
    const fixture = fixtureApp(); fixture.observation.issues = source([{ id: "i-a", label: "A", state: "working", project_id: "alpha" }, { id: "i-b", label: "B", state: "working", project_id: "alpha" }]);
    const fetchMock = vi.fn((path: string | URL | Request, options?: RequestInit) => fixture.app.request(String(path), options)); vi.stubGlobal("fetch", fetchMock);
    const first = await getOperatingOverview({ page_size: 1 }), cursor = first.sections.find((item) => item.kind === "issues")!.next_cursor!;
    const last = await getOperatingOverview({ page_size: 1, cursors: { issues: cursor } });
    expect(last.sections.find((item) => item.kind === "issues")?.rows[0].id).toBe("i-b");
    expect(String(fetchMock.mock.calls.at(-1)![0])).toContain(`cursor_issues=${encodeURIComponent(cursor)}`);
  });

  it.each([{ kind: "project", id: "../private" }, { kind: "overview", page_size: 51 }, { kind: "overview", cursors: { unknown: "cursor" } },
    { kind: "overview", refresh: true }, { kind: "overview", cursors: { issues: "a\nb" } }, { kind: "unknown" },
  ])("refuses unsafe client arguments before fetch (%#)", async (request) => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(fetchOperatingView(request as OperatingViewRequest)).rejects.toThrow("Invalid operating view query."); expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses malformed/future/wrong-focus responses and never exposes private error bodies", async () => {
    const valid = projectOperatingView({ schema_version: 1, as_of: NOW, sources: facts() });
    for (const body of ["{fixture-private-body", JSON.stringify({ ...valid, schema_version: 999 }), JSON.stringify(valid)]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
      await expect(getOperatingProject("alpha")).rejects.toThrow("Operating view response is invalid or unsupported.");
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response("fixture-private-error", { status: 503 })));
    await expect(getOperatingOverview()).rejects.toThrow("Operating view is unavailable (503).");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fixture-private-network-error"); }));
    await expect(getOperatingOverview()).rejects.toThrow("Operating view is unavailable.");
  });
});

it.runIf(process.env.SURTEC_OPERATING_BROWSER_SMOKE === "1")("operating GETs through real loopback HTTP/browser, reload, fresh app and owned cleanup", async () => {
  let fixture = fixtureApp(), browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof serve> | undefined;
  const start = async () => {
    server = serve({ fetch: fixture.app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!server.address()) await new Promise<void>((done, reject) => { server!.once("listening", done); server!.once("error", reject); });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const close = async () => { if (server) { const current = server; await new Promise<void>((done, reject) => current.close((error) => error ? reject(error) : done())); expect(current.listening).toBe(false); server = undefined; } };
  try {
    let base = await start();
    try { browser = await chromium.launch({ headless: true }); }
    catch (error) { if (process.platform !== "win32" || !(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error; browser = await chromium.launch({ headless: true, channel: "msedge" }); }
    const page = await browser.newPage(), pageErrors: string[] = [], consoleErrors: string[] = [], failedRequests: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message)); page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("requestfailed", (request) => failedRequests.push(new URL(request.url()).pathname));
    await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204, body: "" }));
    const response = await page.goto(`${base}${paths[0]}`); expect(response?.status()).toBe(200);
    const readAll = () => page.evaluate(async (routes) => Promise.all(routes.map(async (path) => {
      const response = await fetch(path, { cache: "no-store" }); const value = await response.json();
      return { status: response.status, cache: response.headers.get("cache-control"), version: value.schema_version, authority: value.execution_authority, focus: value.focus_status };
    })), paths);
    const expected = paths.map(() => ({ status: 200, cache: "no-store", version: 1, authority: "none", focus: "available" }));
    expect(await readAll()).toEqual(expected); await page.reload(); expect(await readAll()).toEqual(expected);
    const oldToken = (await (await fetch(`${base}/api/session`)).json()).token as string;
    await close(); fixture = fixtureApp(); base = await start();
    expect((await fetch(`${base}${paths[0]}`, { method: "POST", headers: { "X-Surtec-Session": oldToken } })).status).toBe(403);
    await page.goto(`${base}${paths[0]}`); expect(await readAll()).toEqual(expected);
    expect(pageErrors).toEqual([]); expect(consoleErrors).toEqual([]); expect(failedRequests).toEqual([]);
    for (const callback of [fixture.forbidden, fixture.dispatch, fixture.start, fixture.stop]) expect(callback).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual(["sentinel.txt"]); expect(readFileSync(join(root, "sentinel.txt"), "utf8")).toBe("fixture-private-sentinel");
  } finally { try { await browser?.close(); if (browser) expect(browser.isConnected()).toBe(false); } finally { await close(); } }
}, 25000);
