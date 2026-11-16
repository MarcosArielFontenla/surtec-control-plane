// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ProjectHarnessProfile } from "../../../../lib/harness/types";
import { getProjectHarness } from "../api";
import { ProjectHarnessPanel } from "./ProjectHarnessPanel";
import type { ChildProcess } from "node:child_process";
import type { Browser } from "playwright";
import type { ViteDevServer } from "vite";
vi.mock("../api", () => ({ getProjectHarness: vi.fn() }));
const profile: ProjectHarnessProfile = {
  schema_version: 1, project_id: "alpha", status: "absent", detected_version: null, canonical_version: null, comparison: "unknown", capability_results: [], drift_summary: [], observed_at: "2026-09-30T02:00:00.000Z", source_fingerprint: null, project_fingerprint: "a".repeat(64), doctor_status: "unknown", findings: [], entries: [], testing_policy: { schema_version: 1, mode: "functional", runner_id: null, requires_red_evidence: false, applicable_task_kinds: [] }, runner_command: null, review_policy: "unknown", backup_ready: false, rollback_ready: false, validation: { status: "unknown", observed_at: null },
};
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetAllMocks(); });
describe("ProjectHarnessPanel", () => {
  it.skipIf(process.env.SURTEC_HARNESS_OPERATING_BROWSER_SMOKE !== "1")("validates T006 through actual isolated API/Vite/browser, inert preview, saved validation, drift, mobile and restart", async () => {
    vi.unstubAllGlobals(); vi.stubGlobal("Uint8Array", Object.getPrototypeOf(new TextEncoder().encode("")).constructor);
    const { cp, mkdtemp, mkdir, readFile, symlink, writeFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs"), { tmpdir } = await import("node:os");
    const { join, resolve, dirname } = await import("node:path"), { spawn, execFileSync } = await import("node:child_process");
    const { createHash } = await import("node:crypto"), { createServer: probeServer } = await import("node:net");
    const { createServer } = await import("vite"), { chromium } = await import("playwright");
    const { CAPABILITIES } = await import("../../../../lib/harness/types");
    const { cleanupSmoke, observeResponse, harnessTreeHash } = await import("../../../../scripts/playwright-local-app-smoke");
    const root = await mkdtemp(join(tmpdir(), "surtec-local-dashboard-")), repoRoot = resolve("."), runtime = join(root, "runtime"), projectRoot = join(root, "projects/alpha");
    let browser: Browser | null = null, vite: ViteDevServer | null = null, child: ChildProcess | null = null, exited = Promise.resolve();
    let output = "", stage = "setup";
    const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
    const environment: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) if (process.env[key]) environment[key] = process.env[key];
    Object.assign(environment, { NODE_ENV: "test", SURTEC_STATE_DIR: join(root, "state"), SURTEC_PROJECTS_ROOT: join(root, "projects"), SURTEC_CODEX_BIN: join(root, "forbidden-runtime"), SURTEC_FIXTURE_ROOT: root });
    async function startApi(): Promise<string> {
      output = "";
      child = spawn(process.execPath, ["--import", "tsx", "harness-operating-api.ts"], { cwd: runtime, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
      exited = new Promise<void>((done) => { child!.once("exit", () => done()); child!.once("error", () => done()); });
      const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); }; child.stdout!.on("data", collect); child.stderr!.on("data", collect);
      for (let tries = 0; tries < 150; tries++) {
        const ready = output.match(/SURTEC_HARNESS_OPERATING_READY:(\d+)/); if (ready) return `http://127.0.0.1:${ready[1]}`;
        if (child.exitCode !== null) throw new Error(`Synthetic API failed at ${stage}: ${output}`);
        await delay(200);
      }
      throw new Error(`Synthetic API readiness failed at ${stage}: ${output}`);
    }
    async function stopApi() {
      if (!child || child.exitCode !== null) return true;
      if (child.connected) child.send("stop"); else child.kill("SIGTERM");
      if (await Promise.race([exited.then(() => true), delay(8000).then(() => false)])) return true;
      child.kill("SIGKILL"); return Promise.race([exited.then(() => true), delay(3000).then(() => false)]);
    }
    async function startUi(apiUrl: string) {
      const probe = probeServer();
      await new Promise<void>((done, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", () => done()); });
      const port = (probe.address() as { port: number }).port;
      await new Promise<void>((done, reject) => probe.close((error) => error ? reject(error) : done()));
      vite = await createServer({ configFile: join(repoRoot, "vite.config.ts"), root: join(repoRoot, "dashboard"), cacheDir: join(root, "vite-cache"), server: { host: "127.0.0.1", port, strictPort: true, proxy: { "/api": { target: apiUrl, changeOrigin: false } } }, logLevel: "error" });
      await vite.listen(); return vite.resolvedUrls!.local[0]!;
    }
    try {
      await mkdir(join(root, "registry"), { recursive: true }); await mkdir(projectRoot, { recursive: true }); await mkdir(join(root, "empty-hooks"));
      for (const path of ["lib", "runner", "dashboard/src/server", "schemas", "package.json"]) await cp(join(repoRoot, path), join(runtime, path), { recursive: true });
      await symlink(join(repoRoot, "node_modules"), join(runtime, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      await writeFile(join(root, "registry/projects.yml"), "projects:\n  alpha: {}\n"); await writeFile(join(root, "registry/agents.yml"), "agents: []\n");
      const files = [
        { path: "AGENTS.md", capability: "root_instructions", body: "---\nrole: session-primer\n---\nSYNTHETIC_PRIVATE_INSTRUCTION_BODY\n" },
        { path: ".agents/AGENTS.md", capability: "registry", body: "---\nrole: artifact-registry\n---\nSynthetic fixture inventory.\n" },
        { path: ".agents/orchestration/ROUTING.md", capability: "routing", body: "Always load the mandatory policy.\n| Task class | Artifacts |\n| --- | --- |\n" },
        { path: ".agents/scripts/validate-fixture.ps1", capability: "validators", body: "throw 'This synthetic command must never execute'\n" },
      ];
      const hash = (value: string) => createHash("sha256").update(value).digest("hex");
      for (const file of files) for (const base of [projectRoot, join(root, "canonical")]) { const path = join(base, file.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.body); }
      const manifest = { schema_version: 1, harness_version: "q-fixture-v1", source_id: "q-source", format: "surtec-h1-h4",
        capabilities: Object.fromEntries(CAPABILITIES.map(capability => [capability, files.some(file => file.capability === capability)])),
        expected_entries: files.map(file => ({ path: file.path, capability: file.capability, required: true, sha256: hash(file.body) })) };
      const manifestText = JSON.stringify(manifest); await writeFile(join(root, "registry/fixture-manifest.json"), manifestText);
      await writeFile(join(root, "registry/harness-sources.yml"), JSON.stringify({ schema_version: 1,
        source: { id: "q-source", root: "canonical", manifest: "registry/fixture-manifest.json", manifest_sha256: hash(manifestText) },
        runners: { fixture: { command: "pwsh -NoProfile -File .agents/scripts/validate-fixture.ps1" } }, projects: { alpha: {
          ownership: [{ path: "AGENTS.md", classification: "user-owned", evidence: "Explicit synthetic owner declaration" }],
          testing_policy: { schema_version: 1, mode: "functional", runner_id: "fixture", requires_red_evidence: false, applicable_task_kinds: [] },
          review_policy: "human-required", backup_ready: false, rollback_ready: false, validation: null,
        } } }));
      const git = (args: string[]) => execFileSync("git", ["-c", `core.hooksPath=${join(root, "empty-hooks")}`, ...args], { cwd: projectRoot, env: environment, windowsHide: true, stdio: "pipe" });
      git(["init", "--quiet"]); git(["config", "user.name", "Synthetic Harness Fixture"]); git(["config", "user.email", "fixture@example.invalid"]); git(["add", "."]); git(["commit", "--quiet", "-m", "Synthetic Harness baseline"]);
      await writeFile(join(runtime, "harness-operating-api.ts"), `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp, type AppDependencies } from './dashboard/src/server/index';
import { createHarnessService } from './dashboard/src/server/harness-service';
const root = process.env.SURTEC_FIXTURE_ROOT!, clock = () => new Date('2026-10-15T12:00:00.000Z');
if (existsSync(process.env.SURTEC_CODEX_BIN!)) throw new Error('Paid runtime entry must not exist');
const harness = createHarnessService(root, { clock });
if (!existsSync(join(root, 'initialized'))) {
  const initial = harness.read('alpha').observation;
  if (initial.status !== 'healthy' || initial.detected_version !== 'q-fixture-v1') throw new Error('Synthetic source must validate exactly');
  const sourcePath = join(root, 'registry/harness-sources.yml'), registry = JSON.parse(readFileSync(sourcePath, 'utf8'));
  registry.projects.alpha.validation = { fingerprint: initial.project_fingerprint, status: 'passed', observed_at: '2026-10-01T12:00:00.000Z' };
  writeFileSync(sourcePath, JSON.stringify(registry)); writeFileSync(join(root, 'initialized'), 'synthetic metadata only; no validator executed');
}
const forbidden = () => { writeFileSync(join(root, 'forbidden-effect'), 'unexpected effect'); throw new Error('Synthetic effect refused'); };
const integrations = { schema_version: 2, project_id: 'alpha', observed_at: clock().toISOString(), trace_id: null,
  source_control: { provider: 'git', configured: false, health: 'unconfigured', branch: null, dirty: null, uncommitted: null, ahead: null, behind: null, remote: { provider: 'github', configured: false, health: 'unconfigured', pull_requests: null, issues: null } },
  ci: { provider: 'github-actions', configured: false, health: 'unconfigured', status: null, branch: null }, dependencies: { provider: 'npm', configured: false, health: 'unconfigured', outdated: null, observed_at: clock().toISOString() }, deployments: [] };
const dependencies = { harness, context: { roles: () => [], preview: forbidden }, integrations: { read: async () => integrations, invalidate: forbidden }, signals: { read: async () => ({ schema_version: 1, observed_at: clock().toISOString(), signals: [], pinned_signal_ids: [], warnings: [] }), act: forbidden }, inbox: async () => ({ items: [], repos: [] }) } as unknown as AppDependencies;
const app = createApp(root, forbidden as never, { list: () => [], start: forbidden, stop: forbidden, get: forbidden } as never, undefined, dependencies);
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
server.on('listening', () => console.log('SURTEC_HARNESS_OPERATING_READY:' + (server.address() as { port: number }).port));
process.on('message', message => { if (message === 'stop') server.close(() => process.exit(0)); });
`);
      stage = "actual API/UI start"; let apiUrl = await startApi(); const uiUrl = await startUi(apiUrl);
      try { browser = await chromium.launch({ headless: true }); }
      catch (error) { if (process.platform !== "win32" || !(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error; browser = await chromium.launch({ headless: true, channel: "msedge" }); }
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10000);
      const pageErrors: string[] = [], consoleErrors: string[] = [], httpErrors: string[] = [], mutations: string[] = [], harnessReads: string[] = [];
      page.on("pageerror", error => pageErrors.push(error.message)); page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
      page.on("response", response => { if (response.status() >= 400) httpErrors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
      page.on("request", request => { const path = new URL(request.url()).pathname; if (request.method() !== "GET") mutations.push(`${request.method()} ${path}`); if (request.method() === "GET" && path.includes("/harness")) harnessReads.push(path); });
      const panel = page.getByRole("region", { name: "Harness del proyecto", exact: true });
      async function openDetail() { await page.getByRole("button", { name: /Overview/ }).click(); await page.getByRole("button", { name: "Detalle operativo de alpha" }).click(); await panel.getByTestId("harness-status").waitFor(); }
      await page.goto(uiUrl); await openDetail();
      await panel.getByRole("region", { name: "Validación registrada de la lectura", exact: true }).getByText("passed", { exact: true }).waitFor();
      expect(await panel.getByText("q-fixture-v1 / q-fixture-v1", { exact: true }).count()).toBe(1); expect(existsSync(join(root, "state/harness/profiles.json"))).toBe(false);
      stage = "inert preview and keyboard anchor";
      const before = await harnessTreeHash(projectRoot), canonicalBefore = await harnessTreeHash(join(root, "canonical")), reads = harnessReads.length;
      const anchor = page.getByRole("link", { name: "Ver Harness y evidencia" }); await anchor.focus(); await anchor.press("Enter");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("project-harness-alpha");
      await panel.getByText("Ver preview de remediación (solo lectura)", { exact: true }).click(); await panel.getByRole("region", { name: "Preview de remediación del Harness" }).waitFor();
      expect(harnessReads).toHaveLength(reads); expect(mutations).toEqual([]); expect(await harnessTreeHash(projectRoot)).toBe(before); expect(existsSync(join(root, "state/harness/profiles.json"))).toBe(false);
      expect(await panel.getByText("SYNTHETIC_PRIVATE_INSTRUCTION_BODY", { exact: false }).count()).toBe(0);
      stage = "explicit protected observation persistence";
      const refreshed = await observeResponse(page, "/api/projects/alpha/harness/refresh", "POST", () => panel.getByRole("button", { name: "Actualizar Harness" }).click());
      expect(refreshed.status()).toBe(200); const savedBytes = await readFile(join(root, "state/harness/profiles.json"), "utf8");
      expect(JSON.parse(savedBytes).profiles.alpha.validation.status).toBe("passed"); expect(await harnessTreeHash(projectRoot)).toBe(before);
      stage = "drift keeps saved validation historical";
      await writeFile(join(projectRoot, "AGENTS.md"), files[0]!.body + "\nIntentional synthetic project change.\n");
      await page.reload(); await openDetail();
      await panel.getByText("drift", { exact: true }).waitFor();
      expect(await panel.getByRole("region", { name: "Validación registrada de la lectura", exact: true }).getByText("unknown", { exact: true }).count()).toBe(1);
      expect(await panel.getByRole("region", { name: "Validación histórica guardada", exact: true }).getByText("passed", { exact: true }).count()).toBe(1);
      expect(await readFile(join(root, "state/harness/profiles.json"), "utf8")).toBe(savedBytes);
      stage = "mobile expanded evidence and invalid routing";
      await writeFile(join(projectRoot, ".agents/orchestration/ROUTING.md"), "Synthetic broken routing\n");
      await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await openDetail();
      await panel.getByTestId("harness-status").filter({ hasText: "invalid" }).waitFor();
      await panel.getByText("Capacidades y archivos", { exact: true }).click(); await panel.getByText("Ver preview de remediación (solo lectura)", { exact: true }).click();
      expect(await panel.getByRole("region", { name: "Preview de remediación del Harness" }).getByText(/ownership unknown/).count()).toBeGreaterThan(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect((await panel.getByRole("button", { name: "Actualizar Harness" }).boundingBox())!.width).toBeLessThan(300);
      expect(await harnessTreeHash(join(root, "canonical"))).toBe(canonicalBefore); expect(await readFile(join(root, "state/harness/profiles.json"), "utf8")).toBe(savedBytes);
      stage = "restart, stale session and malformed saved-state refusals";
      const oldSession = (await (await fetch(`${apiUrl}/api/session`)).json()).token;
      await page.goto("about:blank"); expect(await stopApi()).toBe(true); apiUrl = await startApi(); await vite!.close(); const restartedUi = await startUi(apiUrl);
      expect((await fetch(`${apiUrl}/api/projects/alpha/harness/refresh`, { method: "POST", headers: { "X-Surtec-Session": oldSession } })).status).toBe(403);
      expect(await readFile(join(root, "state/harness/profiles.json"), "utf8")).toBe(savedBytes);
      await page.goto(restartedUi); await openDetail(); await panel.getByRole("region", { name: "Validación histórica guardada" }).waitFor();
      const unsupported = JSON.stringify({ schema_version: 2, profiles: {} }); await writeFile(join(root, "state/harness/profiles.json"), unsupported);
      const corruptProject = await harnessTreeHash(projectRoot);
      await page.reload(); await page.getByRole("button", { name: /Overview/ }).click(); await page.getByRole("button", { name: "Detalle operativo de alpha" }).click();
      await panel.getByRole("alert").waitFor(); expect(await page.getByRole("button", { name: "Preparar tarea" }).isEnabled()).toBe(true);
      const refused = await observeResponse(page, "/api/projects/alpha/harness/refresh", "POST", () => panel.getByRole("button", { name: "Actualizar Harness" }).click());
      expect(refused.status()).toBe(409); expect(await readFile(join(root, "state/harness/profiles.json"), "utf8")).toBe(unsupported); expect(await harnessTreeHash(projectRoot)).toBe(corruptProject);
      expect(mutations).toEqual(["POST /api/projects/alpha/harness/refresh", "POST /api/projects/alpha/harness/refresh"]);
      expect(existsSync(join(root, "forbidden-effect"))).toBe(false); expect(existsSync(environment.SURTEC_CODEX_BIN!)).toBe(false);
      expect(pageErrors).toEqual([]); expect(httpErrors.length).toBeGreaterThanOrEqual(2);
      expect(httpErrors.every(error => error === "409 /api/projects/alpha/harness" || error === "409 /api/projects/alpha/harness/refresh"), JSON.stringify(httpErrors)).toBe(true);
      expect(consoleErrors.filter(message => !message.includes("409 (Conflict)"))).toEqual([]);
    } catch (error) { throw new Error(`Q T006 browser acceptance failed at ${stage}: ${(error as Error).message}`); }
    finally {
      const cleanup = await cleanupSmoke({ root, browser: browser ? () => browser!.close() : undefined, vite: vite ? () => vite!.close() : undefined, api: child ? stopApi : undefined });
      expect(cleanup).toEqual({ browser_closed: true, vite_closed: true, api_stopped: true, workspace_removed: true, failures: [] }); expect(existsSync(root)).toBe(false);
    }
  }, 120000);

  it("reads without saving, then refreshes explicitly", async () => {
    vi.mocked(getProjectHarness).mockResolvedValueOnce({ observation: profile, saved: null }).mockResolvedValueOnce({ observation: profile, saved: profile });
    render(<ProjectHarnessPanel projectId="alpha" />); await screen.findByText("absent"); expect(getProjectHarness).toHaveBeenCalledWith("alpha");
    fireEvent.click(screen.getByRole("button", { name: "Actualizar Harness" })); await waitFor(() => expect(getProjectHarness).toHaveBeenCalledWith("alpha", true)); expect(await screen.findByText(/Última observación guardada:/)).toBeInTheDocument();
  });
  it("preserves evidence and reports failed refresh without implying project writes", async () => { vi.mocked(getProjectHarness).mockResolvedValueOnce({ observation: profile, saved: null }).mockRejectedValueOnce(new Error("failed")); render(<ProjectHarnessPanel projectId="alpha" />); await screen.findByText("absent"); fireEvent.click(screen.getByRole("button", { name: "Actualizar Harness" })); expect(await screen.findByRole("alert")).toHaveTextContent("no se modificó el proyecto"); expect(screen.getByText("absent")).toBeInTheDocument(); });

  it.each(["absent", "healthy", "partial", "legacy", "invalid", "unknown"] as const)("retains %s as inventory evidence without granting validation or repair", async (status) => {
    vi.mocked(getProjectHarness).mockResolvedValue({ observation: { ...profile, status }, saved: null });
    render(<ProjectHarnessPanel projectId="alpha" />);
    expect(await screen.findByTestId("harness-status")).toHaveTextContent(status);
    expect(screen.getByRole("region", { name: "Validación registrada de la lectura" })).toHaveTextContent("unknown");
    expect(screen.getByRole("region", { name: "Harness del proyecto" })).toHaveAttribute("id", "project-harness-alpha");
    expect(screen.queryByRole("button", { name: /Ejecutar|Aplicar|Reparar|Repinear|Instalar/ })).toBeNull();
    expect(getProjectHarness).toHaveBeenCalledTimes(1); expect(getProjectHarness).toHaveBeenCalledWith("alpha");
  });

  it("separates observed/canonical versions, fingerprints and source times from unknown source identity and expiry", async () => {
    const observed = { ...profile, status: "healthy" as const, detected_version: "V5.2", canonical_version: "V5.2", comparison: "compatible" as const, source_fingerprint: "b".repeat(64) };
    const saved = { ...observed, observed_at: "2025-01-01T00:00:00.000Z" };
    vi.mocked(getProjectHarness).mockResolvedValue({ observation: observed, saved });
    const view = render(<ProjectHarnessPanel projectId="alpha" />); await screen.findByText("V5.2 / V5.2");
    const source = screen.getByRole("region", { name: "Fuente y frescura del Harness" });
    expect(source).toHaveTextContent("No expuesta por este contrato"); expect(source).toHaveTextContent("fuente coincidente");
    expect(source).toHaveTextContent("no declara un plazo de caducidad");
    expect(source.querySelector(`time[datetime="${profile.observed_at}"]`)).toBeInTheDocument();
    expect(source.querySelector('time[datetime="2025-01-01T00:00:00.000Z"]')).toBeInTheDocument();
    expect(source).not.toHaveTextContent("2026-10-16");
    view.rerender(<ProjectHarnessPanel projectId="alpha" />); expect(getProjectHarness).toHaveBeenCalledTimes(1);
    expect(source).toHaveTextContent("Coincidencia no significa vigencia ni ownership");
  });

  it.each(["passed", "failed", "unknown"] as const)("shows only the recorded %s validation with its own time and missing receipt provenance", async (status) => {
    const observed = { ...profile, validation: { status, observed_at: status === "unknown" ? null : "2026-08-01T00:00:00.000Z" } };
    vi.mocked(getProjectHarness).mockResolvedValue({ observation: observed, saved: null }); render(<ProjectHarnessPanel projectId="alpha" />);
    const validation = await screen.findByRole("region", { name: "Validación registrada de la lectura" });
    expect(validation).toHaveTextContent(`Resultado registrado: ${status}`);
    expect(validation).toHaveTextContent("no expone receipt, actor ni comando ejecutado");
    if (status !== "unknown") expect(validation.querySelector("time")).toHaveAttribute("dateTime", "2026-08-01T00:00:00.000Z");
    else expect(validation).toHaveTextContent("sin fecha de validación registrada");
  });

  it("does not transfer a historical passing validation or unknown source fingerprint into the current reading", async () => {
    const saved = { ...profile, project_fingerprint: "c".repeat(64), validation: { status: "passed" as const, observed_at: "2025-01-01T00:00:00.000Z" } };
    vi.mocked(getProjectHarness).mockResolvedValue({ observation: profile, saved }); render(<ProjectHarnessPanel projectId="alpha" />); await screen.findByTestId("harness-status");
    expect(screen.getByRole("region", { name: "Fuente y frescura del Harness" })).toHaveTextContent("inventario diferente · fuente desconocida");
    expect(screen.getByRole("region", { name: "Validación registrada de la lectura" })).toHaveTextContent("Resultado registrado: unknown");
    expect(screen.getByRole("region", { name: "Validación histórica guardada" })).toHaveTextContent("Resultado registrado: passed");
    expect(screen.getByRole("region", { name: "Validación histórica guardada" })).toHaveTextContent("No se transfiere este resultado");
    expect(screen.getByText(/La lectura actual difiere/)).toBeInTheDocument();
  });

  it("identifies a known source fingerprint change without fabricating an identity or renewing validation", async () => {
    const observed = { ...profile, source_fingerprint: "b".repeat(64) }, saved = { ...profile, source_fingerprint: "c".repeat(64) };
    vi.mocked(getProjectHarness).mockResolvedValue({ observation: observed, saved }); render(<ProjectHarnessPanel projectId="alpha" />);
    expect(await screen.findByText(/inventario coincidente · fuente diferente/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Validación registrada de la lectura" })).toHaveTextContent("unknown");
  });

  it("keeps optional capabilities and missing routing distinct from active routes or a successful gate", async () => {
    vi.mocked(getProjectHarness).mockResolvedValue({ observation: { ...profile, capability_results: [
      { capability: "routing", expected: true, status: "missing", evidence: [".agents/orchestration/ROUTING.md"] },
      { capability: "telemetry", expected: false, status: "unknown", evidence: [] },
      { capability: "validators", expected: true, status: "present", evidence: [".agents/scripts/validate-spec.ps1"] },
    ] }, saved: null });
    render(<ProjectHarnessPanel projectId="alpha" />); await screen.findByTestId("harness-status"); fireEvent.click(screen.getByText("Capacidades y archivos"));
    const capabilities = screen.getByRole("region", { name: "Capacidades y routing del Harness" });
    expect(capabilities).toHaveTextContent("routing: missing"); expect(capabilities).toHaveTextContent("telemetry: unknown · no requerido por esta referencia");
    expect(capabilities).toHaveTextContent("validators: present"); expect(capabilities).toHaveTextContent("No se exponen rutas de tareas parseadas");
    expect(screen.getByRole("region", { name: "Validación registrada de la lectura" })).toHaveTextContent("unknown");
  });

  it("creates an inert preview from exact relative entries and preserves unknown ownership even for automatable suggestions", async () => {
    const command = "pnpm run imaginary-repair --apply";
    const observed: ProjectHarnessProfile = { ...profile, runner_command: command, entries: [
      { path: "AGENTS.md", status: "present", ownership: "user-owned", ownership_evidence: "Explicit user declaration" },
      { path: ".agents/orchestration/ROUTING.md", status: "missing", ownership: "unknown", ownership_evidence: null },
      { path: "D:/private/SOURCE_BODY.txt", status: "unsafe", ownership: "unknown", ownership_evidence: null },
    ], findings: [
      { id: "manual-review", severity: "warning", observed: "Review registered routing", why: "Missing applicable route", evidence: ["AGENTS.md", ".agents/orchestration/ROUTING.md", "trusted project validation record", "AGENTS.md: differs from baseline"], recommended_action: command, safely_automatable: true },
    ] };
    vi.mocked(getProjectHarness).mockResolvedValue({ observation: observed, saved: null }); render(<ProjectHarnessPanel projectId="alpha" />); await screen.findByTestId("harness-status");
    const before = vi.mocked(getProjectHarness).mock.calls.length;
    fireEvent.click(screen.getByText("Ver preview de remediación (solo lectura)"));
    const preview = screen.getByRole("region", { name: "Preview de remediación del Harness" });
    expect(preview).toHaveTextContent("AGENTS.md · present · ownership user-owned");
    expect(preview).toHaveTextContent("ownership unknown · sin evidencia de ownership");
    expect(preview).toHaveTextContent("Referencias sin entrada exacta: trusted project validation record, AGENTS.md: differs from baseline");
    expect(preview).toHaveTextContent("no concede autoridad ni habilita ejecución"); expect(preview).toHaveTextContent(command);
    expect(within(preview).queryByRole("button")).toBeNull(); expect(within(preview).queryByRole("link")).toBeNull();
    expect(getProjectHarness).toHaveBeenCalledTimes(before); expect(document.body.textContent).not.toContain("D:/private/SOURCE_BODY.txt");
  });

  it("does not invent affected entries from arbitrary evidence labels or an empty inventory", async () => {
    vi.mocked(getProjectHarness).mockResolvedValue({ observation: { ...profile, findings: [{ id: "gap", severity: "info", observed: "Missing metadata", why: "Unknown ownership", evidence: ["unresolved metadata"], recommended_action: "Review manually", safely_automatable: false }] }, saved: null });
    render(<ProjectHarnessPanel projectId="alpha" />); await screen.findByTestId("harness-status"); fireEvent.click(screen.getByText("Ver preview de remediación (solo lectura)"));
    expect(screen.getByRole("region", { name: "Preview de remediación del Harness" })).toHaveTextContent("Entradas afectadas no confirmadas");
    expect(getProjectHarness).toHaveBeenCalledTimes(1);
  });

  it("pages recorded entries, findings and drift locally without another inspection", async () => {
    const observed: ProjectHarnessProfile = { ...profile,
      entries: Array.from({ length: 21 }, (_, i) => ({ path: `.agents/file-${i}.md`, status: "missing", ownership: "unknown", ownership_evidence: null })),
      findings: Array.from({ length: 21 }, (_, i) => ({ id: `finding-${i}`, severity: "warning", observed: `Public finding ${i}`, why: "Recorded gap", evidence: [`.agents/file-${i}.md`], recommended_action: "Review manually", safely_automatable: false })),
      drift_summary: Array.from({ length: 21 }, (_, i) => `Recorded drift ${i}`),
    };
    vi.mocked(getProjectHarness).mockResolvedValue({ observation: observed, saved: null }); render(<ProjectHarnessPanel projectId="alpha" />); await screen.findByTestId("harness-status");
    fireEvent.click(screen.getByText("Capacidades y archivos"));
    const entries = screen.getByRole("region", { name: "Entradas y ownership del Harness" }), findings = screen.getByRole("region", { name: "Hallazgos registrados del Doctor" }), drift = screen.getByRole("region", { name: "Drift registrado del Harness" });
    expect(within(entries).getAllByRole("listitem")).toHaveLength(20); expect(within(findings).getAllByRole("article")).toHaveLength(20); expect(within(drift).getAllByRole("listitem")).toHaveLength(20);
    fireEvent.click(screen.getByRole("button", { name: "Página siguiente de entradas del Harness" })); expect(within(entries).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Página siguiente de hallazgos del Doctor" })); expect(within(findings).getAllByRole("article")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Página siguiente de drift del Harness" })); expect(within(drift).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByText("Ver preview de remediación (solo lectura)")); expect(within(screen.getByRole("region", { name: "Preview de remediación del Harness" })).getAllByRole("article")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Página anterior de preview de remediación" })); expect(within(findings).getAllByRole("article")).toHaveLength(20);
    expect(getProjectHarness).toHaveBeenCalledTimes(1);
  });

  it.each(["observation", "saved", "future"] as const)("rejects a foreign or unsupported %s response without exposing its content", async (kind) => {
    const response = { observation: profile, saved: null as ProjectHarnessProfile | null };
    if (kind === "observation") response.observation = { ...profile, project_id: "beta", runner_command: "PRIVATE_FOREIGN_COMMAND" };
    if (kind === "saved") response.saved = { ...profile, project_id: "beta", runner_command: "PRIVATE_FOREIGN_COMMAND" };
    if (kind === "future") response.observation = { ...profile, schema_version: 2 } as unknown as ProjectHarnessProfile;
    vi.mocked(getProjectHarness).mockResolvedValue(response); render(<ProjectHarnessPanel projectId="alpha" />);
    await screen.findByRole("alert"); expect(screen.queryByTestId("harness-status")).toBeNull(); expect(document.body.textContent).not.toContain("PRIVATE_FOREIGN_COMMAND");
  });

  it("discards an old refresh across alpha to beta to alpha and never substitutes it for the current observation", async () => {
    let finish!: (value: { observation: ProjectHarnessProfile; saved: ProjectHarnessProfile | null }) => void;
    const beta = { ...profile, project_id: "beta", status: "legacy" as const }, fresh = { ...profile, status: "partial" as const };
    vi.mocked(getProjectHarness).mockResolvedValueOnce({ observation: profile, saved: null }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce({ observation: beta, saved: null }).mockResolvedValueOnce({ observation: fresh, saved: null });
    const view = render(<ProjectHarnessPanel projectId="alpha" />); await screen.findByText("absent"); fireEvent.click(screen.getByRole("button", { name: "Actualizar Harness" }));
    await waitFor(() => expect(getProjectHarness).toHaveBeenCalledTimes(2)); view.rerender(<ProjectHarnessPanel projectId="beta" />); await screen.findByText("legacy");
    view.rerender(<ProjectHarnessPanel projectId="alpha" />); await screen.findByText("partial");
    await act(async () => finish({ observation: { ...profile, runner_command: "OLD_REFRESH_COMMAND" }, saved: profile }));
    expect(screen.getByTestId("harness-status")).toHaveTextContent("partial"); expect(document.body.textContent).not.toContain("OLD_REFRESH_COMMAND");
    expect(screen.getByRole("button", { name: "Actualizar Harness" })).toBeEnabled(); expect(getProjectHarness).toHaveBeenCalledTimes(4);
  });

  it("keeps raw read and refresh errors private while retaining the last confirmed observation", async () => {
    vi.mocked(getProjectHarness).mockRejectedValueOnce(new Error("PRIVATE READ D:/secret/auth.json"));
    const view = render(<ProjectHarnessPanel projectId="alpha" />); await screen.findByRole("alert"); expect(document.body.textContent).not.toContain("PRIVATE READ");
    vi.mocked(getProjectHarness).mockResolvedValueOnce({ observation: { ...profile, project_id: "beta" }, saved: null }).mockRejectedValueOnce(new Error("PRIVATE REFRESH BODY"));
    view.rerender(<ProjectHarnessPanel projectId="beta" />); await screen.findByTestId("harness-status"); fireEvent.click(screen.getByRole("button", { name: "Actualizar Harness" }));
    await screen.findByRole("alert"); expect(screen.getByTestId("harness-status")).toHaveTextContent("absent"); expect(document.body.textContent).not.toContain("PRIVATE REFRESH BODY");
  });
});
