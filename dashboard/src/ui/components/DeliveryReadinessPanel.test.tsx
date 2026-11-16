// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ChildProcess } from "node:child_process";
import type { Browser } from "playwright";
import type { ViteDevServer } from "vite";
import type { DeliveryObservation, IssueEvidenceReference, IssueLineage, RecordDeliveryObservationInput, ReviewCandidate, WorkIssue } from "../../../../lib/issues/types";
import * as api from "../api";
import { DeliveryReadinessPanel } from "./DeliveryReadinessPanel";

const NOW = "2026-10-16T12:00:00.000Z", OBSERVED = "2026-10-15T12:00:00.000Z";
const ISSUE = "I-00000000-0000-4000-8000-000000000001", OTHER = "I-00000000-0000-4000-8000-000000000002";
const CANDIDATE = "C-00000000-0000-4000-8000-000000000001", EVIDENCE = "E-00000000-0000-4000-8000-000000000001";
const CONFIRM = "Confirmo registrar este hecho manual sin aprobar entrega ni completar compromisos";
const KINDS: DeliveryObservation["kind"][] = ["readiness-reviewed", "environment-observed", "handoff-recorded", "client-response-recorded", "follow-up-recorded"];

function fixture(overrides: Partial<WorkIssue> = {}): IssueLineage {
  const scope = { expected_outcome: "Inspect a fictional result", acceptance_criteria: ["Result remains inspectable"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["ui"], explicit_exclusions: [] };
  return { issue: { schema_version: 1, id: ISSUE, project_id: "alpha", objective_id: null, parent_issue_id: null,
    title: "Public delivery issue", expected_outcome: scope.expected_outcome, acceptance_criteria: scope.acceptance_criteria,
    status: "proposed", work_scale: "bounded", classification_inputs: { affected_domains: ["ui"], requires_migration: false, security_impact: false }, classification_rationale: [], plan: [],
    authorized_scope: scope, scope_revision: 1, scope_changed_at: null, scope_change_approval_id: null, scope_change_proposal: null,
    priority: 1, criticality: "low", blocked_by_issue_ids: [], assigned_role_id: null, related_commitment_ids: [], external_references: [], next_action: null,
    task_ids: [], candidate_ids: [], evidence_ids: [], created_at: NOW, updated_at: NOW, revision: 2, ...overrides }, tasks: [], candidates: [], evidence: [], evidence_gaps: [], sessions: [] };
}
function candidate(): ReviewCandidate {
  return { schema_version: 1, id: CANDIDATE, issue_id: ISSUE, task_id: "task-fixture", execution_id: "run-fixture", repository_id: "alpha", base_revision: "a".repeat(40), candidate_revision: "b".repeat(40), diff_fingerprint: "c".repeat(64), changed_paths: ["src/example.ts"], scope_revision: 1, created_at: OBSERVED, invalidated_at: null };
}
function observation(kind: DeliveryObservation["kind"] = "client-response-recorded"): DeliveryObservation {
  return { schema_version: 1, kind, origin: "operator-entered", commitment_id: null, occurred_at: OBSERVED,
    summary: "SYNTHETIC_PRIVATE_RESPONSE", source_reference: "private-source-732", next_action: "SYNTHETIC_PRIVATE_NEXT_ACTION" };
}
function evidence(facet: DeliveryObservation = observation(), overrides: Partial<IssueEvidenceReference> = {}): IssueEvidenceReference {
  return { schema_version: 1, id: EVIDENCE, issue_id: ISSUE, task_id: null, execution_id: null, candidate_id: null, candidate_revision: null,
    diff_fingerprint: null, scope_revision: 1, kind: "work-product", label: "Operator-entered delivery observation", reference: `/api/work-issues/${ISSUE}`, status: "informational", created_at: NOW, delivery_observation: facet, ...overrides };
}
function withEvidence(entry = evidence()): IssueLineage {
  const value = fixture(); value.evidence = [entry]; value.issue.evidence_ids = [entry.id]; return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject };
}
async function disclose() { fireEvent.click(screen.getByRole("button", { name: "Consultar entrega y seguimiento" })); await screen.findByRole("heading", { name: "Aceptación técnica" }); }
function fillForm(kind: DeliveryObservation["kind"] = "client-response-recorded") {
  fireEvent.click(screen.getByRole("button", { name: "Registrar observación manual" }));
  fireEvent.change(screen.getByLabelText("Tipo de observación"), { target: { value: kind } });
  fireEvent.change(screen.getByLabelText("Momento de la observación (hora local)"), { target: { value: "2026-10-15T12:00" } });
  fireEvent.change(screen.getByLabelText("Resumen privado"), { target: { value: "SYNTHETIC_PRIVATE_RESPONSE" } });
  fireEvent.change(screen.getByLabelText("Referencia de origen"), { target: { value: "private-source-732" } });
  fireEvent.change(screen.getByLabelText("Próxima acción privada"), { target: { value: "SYNTHETIC_PRIVATE_NEXT_ACTION" } });
}
function response(input: RecordDeliveryObservationInput) {
  const entry = evidence(input.delivery_observation, { candidate_id: input.candidate_id, candidate_revision: input.candidate_revision, diff_fingerprint: input.diff_fingerprint });
  const issue = { ...fixture().issue, revision: input.expected_revision + 1, evidence_ids: [entry.id] };
  return { issue, evidence: entry };
}

beforeEach(() => {
  vi.spyOn(api, "getWorkIssues").mockResolvedValue({ issues: [fixture().issue] });
  vi.spyOn(api, "getWorkIssue").mockResolvedValue(fixture());
  vi.spyOn(api, "recordDeliveryObservation").mockImplementation(async (_id, input) => {
    const saved = response(input);
    if (input.candidate_id) saved.issue.candidate_ids = [input.candidate_id];
    vi.mocked(api.getWorkIssue).mockResolvedValue({ ...fixture(), issue: saved.issue, candidates: input.candidate_id ? [candidate()] : [], evidence: [saved.evidence] });
    return saved;
  });
  for (const method of ["saveCommitment", "saveClient", "dispatchWorkIssue", "authorizeWorkIssue", "acceptWorkIssueCandidate", "previewContext", "createWorkIssue"] as const) vi.spyOn(api, method).mockRejectedValue(new Error("Synthetic unrelated effect forbidden"));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("independent local delivery presentation", () => {
  it("mounts project/commitment context without implicit reads, writes or private data", () => {
    render(<DeliveryReadinessPanel projectId="alpha" commitmentId="commitment-1" />);
    expect(api.getWorkIssues).not.toHaveBeenCalled(); expect(api.getWorkIssue).not.toHaveBeenCalled(); expect(api.recordDeliveryObservation).not.toHaveBeenCalled();
    expect(screen.queryByText("SYNTHETIC_PRIVATE_RESPONSE")).toBeNull();
  });

  it("keeps six facts separate and absence unrecorded for a personal issue", async () => {
    render(<DeliveryReadinessPanel projectId="alpha" lineage={fixture()} />); await disclose();
    for (const name of ["Aceptación técnica", "Readiness revisada", "Entorno observado", "Handoff registrado", "Respuesta registrada", "Seguimiento registrado"]) expect(screen.getByRole("heading", { name })).toBeTruthy();
    expect(api.recordDeliveryObservation).not.toHaveBeenCalled(); expect(api.saveCommitment).not.toHaveBeenCalled();
  });

  it.each(KINDS)("shows provenance/time but reveals private %s text only intentionally", async (kind) => {
    render(<DeliveryReadinessPanel projectId="alpha" lineage={withEvidence(evidence(observation(kind)))} />); await disclose();
    for (const marker of Object.values(observation()).filter(value => typeof value === "string" && (value.startsWith("SYNTHETIC_PRIVATE") || value === "private-source-732"))) expect(screen.queryByText(marker as string)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Mostrar detalle privado/ }));
    expect(screen.getByText("SYNTHETIC_PRIVATE_RESPONSE")).toBeTruthy(); expect(screen.getByText("private-source-732")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /private-source/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Ocultar detalle privado/ })); expect(screen.queryByText("SYNTHETIC_PRIVATE_RESPONSE")).toBeNull();
  });

  it.each([null, { ...observation(), schema_version: 2 }, { ...observation(), authority: true }, { ...observation(), source_reference: "javascript:alert(1)" }])("refuses malformed/future facts without displaying private bodies or permitting repair (%#)", async (facet) => {
    render(<DeliveryReadinessPanel projectId="alpha" lineage={withEvidence(evidence(facet as DeliveryObservation))} />); await disclose();
    expect(screen.queryByText("SYNTHETIC_PRIVATE_RESPONSE")).toBeNull(); expect(screen.queryByRole("button", { name: /Mostrar detalle privado/ })).toBeNull();
    const record = screen.queryByRole("button", { name: "Registrar observación manual" }); if (record) expect(record).toBeDisabled();
    expect(api.recordDeliveryObservation).not.toHaveBeenCalled();
  });

  it("does not convert local done with missing exact evidence into delivery readiness", async () => {
    render(<DeliveryReadinessPanel projectId="alpha" lineage={fixture({ status: "done" })} />); await disclose();
    expect(screen.queryByText("SYNTHETIC_PRIVATE_RESPONSE")).toBeNull(); expect(screen.queryByRole("button", { name: /Aceptar candidato|Desplegar|Enviar al cliente/ })).toBeNull();
    expect(api.acceptWorkIssueCandidate).not.toHaveBeenCalled(); expect(api.saveCommitment).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation and preserves the unbound candidate triple", async () => {
    render(<DeliveryReadinessPanel projectId="alpha" lineage={fixture()} />); await disclose(); fillForm();
    expect(screen.getByRole("button", { name: "Guardar observación local" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(CONFIRM)); fireEvent.click(screen.getByRole("button", { name: "Guardar observación local" }));
    await waitFor(() => expect(api.recordDeliveryObservation).toHaveBeenCalledTimes(1));
    expect(api.recordDeliveryObservation).toHaveBeenCalledWith(ISSUE, expect.objectContaining({ project_id: "alpha", expected_revision: 2, scope_revision: 1, candidate_id: null, candidate_revision: null, diff_fingerprint: null, confirm: true }));
    for (const method of [api.saveCommitment, api.dispatchWorkIssue, api.authorizeWorkIssue, api.acceptWorkIssueCandidate, api.previewContext]) expect(method).not.toHaveBeenCalled();
  });

  it.each(["Resumen privado", "Referencia de origen", "Próxima acción privada"])("invalidates confirmation when %s changes", async (label) => {
    render(<DeliveryReadinessPanel projectId="alpha" lineage={fixture()} />); await disclose(); fillForm(); fireEvent.click(screen.getByLabelText(CONFIRM));
    fireEvent.change(screen.getByLabelText(label), { target: { value: label === "Referencia de origen" ? "different-source" : "Different fictional text" } });
    expect(screen.getByLabelText(CONFIRM)).not.toBeChecked(); expect(screen.getByRole("button", { name: "Guardar observación local" })).toBeDisabled();
  });

  it("binds a deliberately selected current candidate exactly, never by a readiness label", async () => {
    const detail = fixture(); detail.candidates = [candidate()]; detail.issue.candidate_ids = [CANDIDATE];
    render(<DeliveryReadinessPanel projectId="alpha" lineage={detail} />); await disclose(); fillForm("readiness-reviewed");
    fireEvent.change(screen.getByLabelText("Candidato relacionado"), { target: { value: CANDIDATE } }); fireEvent.click(screen.getByLabelText(CONFIRM));
    fireEvent.click(screen.getByRole("button", { name: "Guardar observación local" }));
    await waitFor(() => expect(api.recordDeliveryObservation).toHaveBeenCalledWith(ISSUE, expect.objectContaining({ candidate_id: CANDIDATE, candidate_revision: candidate().candidate_revision, diff_fingerprint: candidate().diff_fingerprint })));
  });

  it("serializes double submissions and ignores a response after unmount", async () => {
    const pending = deferred<ReturnType<typeof response>>(); vi.mocked(api.recordDeliveryObservation).mockReturnValue(pending.promise);
    const onChanged = vi.fn(), view = render(<DeliveryReadinessPanel projectId="alpha" lineage={fixture()} onChanged={onChanged} />); await disclose(); fillForm(); fireEvent.click(screen.getByLabelText(CONFIRM));
    const form = screen.getByRole("button", { name: "Guardar observación local" }).closest("form")!;
    fireEvent.submit(form); fireEvent.submit(form); expect(api.recordDeliveryObservation).toHaveBeenCalledTimes(1);
    const input = vi.mocked(api.recordDeliveryObservation).mock.calls[0]![1]; view.unmount();
    await act(async () => { pending.resolve(response(input)); await pending.promise; }); expect(onChanged).not.toHaveBeenCalled();
  });

  it("does not replay an uncertain failed POST before an explicit evidence refresh", async () => {
    vi.mocked(api.recordDeliveryObservation).mockRejectedValue(new Error("PRIVATE_SERVER_BODY"));
    render(<DeliveryReadinessPanel projectId="alpha" lineage={fixture()} />); await disclose(); fillForm(); fireEvent.click(screen.getByLabelText(CONFIRM));
    fireEvent.click(screen.getByRole("button", { name: "Guardar observación local" })); await screen.findByRole("status");
    expect(screen.queryByText(/PRIVATE_SERVER_BODY/)).toBeNull(); expect(api.recordDeliveryObservation).toHaveBeenCalledTimes(1);
    const save = screen.queryByRole("button", { name: "Guardar observación local" }); if (save) { expect(save).toBeDisabled(); fireEvent.click(save); }
    expect(api.recordDeliveryObservation).toHaveBeenCalledTimes(1);
  });

  it("resets private drafts and confirmations when issue revision changes", async () => {
    const view = render(<DeliveryReadinessPanel projectId="alpha" lineage={fixture()} />); await disclose(); fillForm(); fireEvent.click(screen.getByLabelText(CONFIRM));
    view.rerender(<DeliveryReadinessPanel projectId="alpha" lineage={fixture({ revision: 3 })} />);
    await waitFor(() => { const field = screen.queryByLabelText("Resumen privado"); if (field) expect(field).toHaveValue(""); });
    const confirmed = screen.queryByLabelText(CONFIRM); if (confirmed) expect(confirmed).not.toBeChecked(); expect(api.recordDeliveryObservation).not.toHaveBeenCalled();
  });

  it("refuses a manual fact from a future scope without revealing its private body", async () => {
    render(<DeliveryReadinessPanel projectId="alpha" lineage={withEvidence(evidence(observation(), { scope_revision: 2 }))} />); await disclose();
    expect(screen.getByText(/Brecha de evidencia: hay metadata manual inválida/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Mostrar detalle privado/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Registrar observación manual" })).toBeDisabled();
    expect(screen.queryByText("SYNTHETIC_PRIVATE_RESPONSE")).toBeNull(); expect(api.recordDeliveryObservation).not.toHaveBeenCalled();
  });

  it.each(["revision", "fingerprint", "invalidation"])("clears the draft when a same-ID candidate changes its %s", async (change) => {
    const detail = fixture(); detail.candidates = [candidate()]; detail.issue.candidate_ids = [CANDIDATE];
    const view = render(<DeliveryReadinessPanel projectId="alpha" lineage={detail} />); await disclose(); fillForm(); fireEvent.click(screen.getByLabelText(CONFIRM));
    const replacement = structuredClone(detail);
    if (change === "revision") replacement.candidates[0]!.candidate_revision = "d".repeat(40);
    if (change === "fingerprint") replacement.candidates[0]!.diff_fingerprint = "e".repeat(64);
    if (change === "invalidation") replacement.candidates[0]!.invalidated_at = NOW;
    view.rerender(<DeliveryReadinessPanel projectId="alpha" lineage={replacement} />);
    await screen.findByRole("button", { name: "Consultar entrega y seguimiento" });
    expect(screen.queryByRole("form", { name: "Registrar observación de entrega" })).toBeNull(); expect(api.recordDeliveryObservation).not.toHaveBeenCalled();
  });

  it.each(["date", "kind", "commitment"])("invalidates confirmation when the explicit %s binding changes", async (change) => {
    render(<DeliveryReadinessPanel projectId="alpha" lineage={fixture({ related_commitment_ids: ["commitment-1"] })} />); await disclose(); fillForm(); fireEvent.click(screen.getByLabelText(CONFIRM));
    const label = change === "date" ? "Momento de la observación (hora local)" : change === "kind" ? "Tipo de observación" : "Compromiso relacionado";
    const value = change === "date" ? "2026-10-14T12:00" : change === "kind" ? "follow-up-recorded" : "commitment-1";
    fireEvent.change(screen.getByLabelText(label), { target: { value } }); expect(screen.getByLabelText(CONFIRM)).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Guardar observación local" })).toBeDisabled(); expect(api.recordDeliveryObservation).not.toHaveBeenCalled();
  });

  it.each(["other-project", "stale-revision"])("refuses a %s detail instead of using another issue's facts", async (change) => {
    vi.mocked(api.getWorkIssue).mockResolvedValue(fixture(change === "other-project" ? { project_id: "beta" } : { revision: 3 }));
    render(<DeliveryReadinessPanel projectId="alpha" />);
    fireEvent.click(screen.getByRole("button", { name: "Consultar entrega y seguimiento" }));
    const selection = await screen.findByLabelText("Issue de entrega"); fireEvent.change(selection, { target: { value: ISSUE } });
    await screen.findByRole("status"); expect(screen.queryByRole("heading", { name: "Aceptación técnica" })).toBeNull();
    expect(api.recordDeliveryObservation).not.toHaveBeenCalled();
  });

  it("ignores a project lookup completed after switching to another project", async () => {
    const pending = deferred<{ issues: WorkIssue[] }>(); vi.mocked(api.getWorkIssues).mockReturnValueOnce(pending.promise).mockResolvedValue({ issues: [fixture({ id: OTHER, project_id: "beta" }).issue] });
    const view = render(<DeliveryReadinessPanel projectId="alpha" />); fireEvent.click(screen.getByRole("button", { name: "Consultar entrega y seguimiento" }));
    view.rerender(<DeliveryReadinessPanel projectId="beta" />); fireEvent.click(await screen.findByRole("button", { name: "Consultar entrega y seguimiento" }));
    const selection = await screen.findByLabelText("Issue de entrega");
    await act(async () => { pending.resolve({ issues: [fixture().issue] }); await pending.promise; });
    expect(within(selection).getByRole("option", { name: new RegExp(OTHER) })).toBeTruthy();
    expect(within(selection).queryByRole("option", { name: new RegExp(ISSUE) })).toBeNull(); expect(api.getWorkIssue).not.toHaveBeenCalled();
  });

  it("reports only exact technical references and never treats a role review as human acceptance", async () => {
    const detail = fixture({ status: "done", candidate_ids: [CANDIDATE] }); detail.candidates = [candidate()];
    const entry = evidence(observation(), { candidate_id: CANDIDATE, candidate_revision: candidate().candidate_revision, diff_fingerprint: candidate().diff_fingerprint,
      task_id: candidate().task_id, execution_id: candidate().execution_id, kind: "review", status: "passed", label: "Infrastructure-sealed role review (not human acceptance)" });
    delete entry.delivery_observation; detail.evidence = [entry]; detail.issue.evidence_ids = [entry.id];
    render(<DeliveryReadinessPanel projectId="alpha" lineage={detail} />); await disclose();
    const technical = within(screen.getByRole("region", { name: "Aceptación técnica" }));
    expect(technical.getByText(/sin registro passed exacto/)).toBeTruthy();
    expect(screen.queryByText(/Aceptación humana local registrada para este candidato/)).toBeNull(); expect(api.acceptWorkIssueCandidate).not.toHaveBeenCalled();
  });

  it.each([64, 65])("refuses recording at %s manual facts without evicting or exposing history", async (count) => {
    const detail = fixture(); detail.evidence = Array.from({ length: count }, (_, index) => evidence(observation(), { id: `E-00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` })); detail.issue.evidence_ids = detail.evidence.map(entry => entry.id);
    render(<DeliveryReadinessPanel projectId="alpha" lineage={detail} />); await disclose();
    expect(screen.getByRole("button", { name: "Registrar observación manual" })).toBeDisabled(); expect(api.recordDeliveryObservation).not.toHaveBeenCalled();
    expect(screen.queryByText("SYNTHETIC_PRIVATE_RESPONSE")).toBeNull(); expect(detail.evidence).toHaveLength(count);
  });
});

it.skipIf(process.env.SURTEC_DELIVERY_UI_BROWSER_SMOKE !== "1")("records and consults independent delivery facts through actual isolated API/Vite/UI controls, privacy, mobile and restart", async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  vi.stubGlobal("Uint8Array", Object.getPrototypeOf(new TextEncoder().encode("")).constructor);
  const { cp, mkdtemp, mkdir, readFile, symlink, writeFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs"), { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path"), { spawn, execFileSync } = await import("node:child_process");
  const { createServer: probeServer } = await import("node:net");
  const { createServer } = await import("vite"), { chromium } = await import("playwright");
  const { cleanupSmoke, observeResponse, harnessTreeHash } = await import("../../../../scripts/playwright-local-app-smoke");
  const root = await mkdtemp(join(tmpdir(), "surtec-local-dashboard-")), repoRoot = resolve("."), runtime = join(root, "runtime");
  let browser: Browser | null = null, vite: ViteDevServer | null = null, child: ChildProcess | null = null, exited = Promise.resolve();
  let output = "", stage = "setup";
  const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) if (process.env[key]) environment[key] = process.env[key];
  Object.assign(environment, { NODE_ENV: "test", SURTEC_STATE_DIR: join(root, "state"), SURTEC_PROJECTS_ROOT: join(root, "projects"), SURTEC_CODEX_BIN: join(root, "forbidden-runtime"), SURTEC_FIXTURE_ROOT: root });
  async function startApi(): Promise<string> {
    output = "";
    child = spawn(process.execPath, ["--import", "tsx", "delivery-ui-api.ts"], { cwd: runtime, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    exited = new Promise<void>(done => { child!.once("exit", () => done()); child!.once("error", () => done()); });
    const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); }; child.stdout!.on("data", collect); child.stderr!.on("data", collect);
    for (let tries = 0; tries < 150; tries++) {
      const ready = output.match(/SURTEC_DELIVERY_UI_READY:(\d+)/); if (ready) return `http://127.0.0.1:${ready[1]}`;
      if (child.exitCode !== null) throw new Error(`Synthetic API failed at ${stage}: ${output}`); await delay(200);
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
    const probe = probeServer(); await new Promise<void>((done, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", () => done()); });
    const port = (probe.address() as { port: number }).port; await new Promise<void>((done, reject) => probe.close(error => error ? reject(error) : done()));
    vite = await createServer({ configFile: join(repoRoot, "vite.config.ts"), root: join(repoRoot, "dashboard"), cacheDir: join(root, "vite-cache"), server: { host: "127.0.0.1", port, strictPort: true, proxy: { "/api": { target: apiUrl, changeOrigin: false } } }, logLevel: "error" });
    await vite.listen(); return vite.resolvedUrls!.local[0]!;
  }
  try {
    await mkdir(join(root, "registry"), { recursive: true }); await mkdir(join(root, "projects")); await mkdir(join(root, "empty-hooks"));
    for (const id of ["alpha", "beta"]) {
      const path = join(root, "projects", id); await mkdir(path); await writeFile(join(path, "fixture.txt"), `Public ${id} delivery sentinel\n`);
      execFileSync("git", ["-c", `core.hooksPath=${join(root, "empty-hooks")}`, "init", "--quiet"], { cwd: path, env: environment, windowsHide: true, stdio: "pipe" });
    }
    await writeFile(join(root, "registry/projects.yml"), "projects:\n  alpha: {}\n  beta: {}\n"); await writeFile(join(root, "registry/agents.yml"), "agents: []\n");
    for (const path of ["lib", "runner", "dashboard/src/server", "schemas", "package.json"]) await cp(join(repoRoot, path), join(runtime, path), { recursive: true });
    await symlink(join(repoRoot, "node_modules"), join(runtime, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(join(runtime, "delivery-ui-api.ts"), `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp, type AppDependencies } from './dashboard/src/server/index';
import { createOrganizationService } from './dashboard/src/server/organization-service';
import { createIssueService } from './dashboard/src/server/issue-service';
import { mutateIssueDocument } from './lib/state/issues';
import { mutateClientPortfolio } from './lib/state/client-portfolio';
import { emptyProjectProfile } from './lib/portfolio-profile';
import { upsertProjectProfile } from './lib/state/portfolio-profiles';
const root = process.env.SURTEC_FIXTURE_ROOT!, clock = () => new Date('2026-10-16T12:00:00.000Z'), now = clock().toISOString();
const forbidden = () => { writeFileSync(join(root, 'forbidden-effect'), 'unexpected effect'); throw new Error('Synthetic effect refused'); };
if (existsSync(process.env.SURTEC_CODEX_BIN!)) throw new Error('Runtime entry must remain absent');
const organization = createOrganizationService({ clock }), issues = createIssueService(root, { now: clock, projectIds: () => ['alpha', 'beta'], createTask: forbidden });
if (!existsSync(join(root, 'initialized'))) {
  organization.saveCompany({ schema_version: 1, id: 'surtec', display_name: 'Public delivery UI fixture', mission: null, operating_principles: [], active_objective_ids: [], last_reviewed_at: null });
  mutateClientPortfolio(document => {
    document.clients['client-delivery'] = { id: 'client-delivery', display_name: 'Public fixture client', status: 'active', criticality: 'low', sla_note: null, next_review_date: null, confidential_notes: 'SYNTHETIC_PRIVATE_CLIENT_NOTES', created_at: now, updated_at: now };
    document.commitments['commitment-delivery'] = { id: 'commitment-delivery', project_id: 'alpha', client_id: 'client-delivery', title: 'Public completed milestone', expected_outcome: 'Inspect independently recorded delivery facts', due_date: null, priority: 3, criticality: 'low', state: 'completed', issue_numbers: [], pull_request_numbers: [], task_ids: [], session_ids: [], next_action: 'Inspect existing evidence without inferring delivery', created_at: now, updated_at: now };
  });
  upsertProjectProfile({ ...emptyProjectProfile('alpha'), kind: 'client-product', client_id: 'client-delivery', last_reviewed_at: '2026-10-16' });
  upsertProjectProfile({ ...emptyProjectProfile('beta'), kind: 'experiment', last_reviewed_at: '2026-10-16' });
  const expected = 'Inspect a fictional result', criteria = ['Result remains inspectable'];
  const input = { project_id: 'alpha', title: 'Public delivery issue', expected_outcome: expected, acceptance_criteria: criteria, related_commitment_ids: ['commitment-delivery'], authorized_scope: { expected_outcome: expected, acceptance_criteria: criteria, allowed_path_patterns: ['src/**'], excluded_path_patterns: [], allowed_change_categories: ['ui'], explicit_exclusions: [] } };
  const completed = issues.create(input);
  // Deliberately incomplete historical state proves that local Done alone
  // does not invent exact acceptance or any manual delivery fact.
  mutateIssueDocument(document => { document.issues[completed.id]!.status = 'done'; });
  issues.create({ ...input, project_id: 'beta', title: 'Public personal experiment', related_commitment_ids: [] });
  writeFileSync(join(root, 'initialized'), 'Owned synthetic state only; no worker/model/provider');
}
const dependencies = { organization, issues, context: { roles: () => [], preview: forbidden }, integrations: { read: async (id: string) => ({ schema_version: 2, project_id: id, observed_at: now, trace_id: null, source_control: { provider: 'git', configured: false, health: 'unconfigured', branch: null, dirty: null, uncommitted: null, ahead: null, behind: null, remote: { provider: 'github', configured: false, health: 'unconfigured', pull_requests: null, issues: null } }, ci: { provider: 'github-actions', configured: false, health: 'unconfigured', status: null, branch: null }, dependencies: { provider: 'npm', configured: false, health: 'unconfigured', outdated: null, observed_at: now }, deployments: [] }), invalidate: forbidden }, signals: { read: async () => ({ schema_version: 1, observed_at: now, signals: [], pinned_signal_ids: [], warnings: [] }), act: forbidden }, inbox: async () => ({ items: [], repos: [] }) } as unknown as AppDependencies;
const app = createApp(root, forbidden as never, { list: () => [], start: forbidden, stop: forbidden, get: forbidden } as never, undefined, dependencies);
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
server.on('listening', () => console.log('SURTEC_DELIVERY_UI_READY:' + (server.address() as { port: number }).port));
process.on('message', message => { if (message === 'stop') server.close(() => process.exit(0)); });
`);
    stage = "actual API and dashboard start"; let apiUrl = await startApi(); const uiUrl = await startUi(apiUrl);
    const unchangedPaths = ["organization/organization.json", "portfolio/projects.json", "portfolio/clients.json"];
    const unchanged = await Promise.all(unchangedPaths.map(path => readFile(join(root, "state", path), "utf8"))), sourceHash = await harnessTreeHash(join(root, "projects"));
    const originalBytes = await readFile(join(root, "state/issues/issues.json"), "utf8"), original = JSON.parse(originalBytes);
    const issue = (await (await fetch(`${apiUrl}/api/work-issues`)).json()).issues.find((entry: WorkIssue) => entry.project_id === "alpha") as WorkIssue;
    const personal = (await (await fetch(`${apiUrl}/api/work-issues`)).json()).issues.find((entry: WorkIssue) => entry.project_id === "beta") as WorkIssue;
    try { browser = await chromium.launch({ headless: true }); }
    catch (error) { if (process.platform !== "win32" || !(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error; browser = await chromium.launch({ headless: true, channel: "msedge" }); }
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC" }); page.setDefaultTimeout(10000);
    const pageErrors: string[] = [], consoleErrors: string[] = [], httpErrors: string[] = [], mutations: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message)); page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("response", response => { if (response.status() >= 400) httpErrors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
    page.on("request", request => { if (request.method() !== "GET") mutations.push(`${request.method()} ${new URL(request.url()).pathname}`); });
    const card = page.locator(`#work-issue-${issue.id}`), issuePanel = card.getByRole("region", { name: "Entrega y seguimiento", exact: true });
    const assertPrivateHidden = async () => expect(await page.locator("body").innerText()).not.toContain("SYNTHETIC_PRIVATE");
    async function consultIssue() {
      await page.getByRole("button", { name: "Issues", exact: true }).click();
      await card.waitFor();
      const expand = card.getByRole("button", { name: "Ver linaje y evidencia", exact: true }); if (await expand.count()) await expand.click();
      await issuePanel.getByRole("button", { name: "Consultar entrega y seguimiento", exact: true }).click();
      await issuePanel.getByRole("heading", { name: "Aceptación técnica", exact: true }).waitFor();
    }
    async function openProject(id: string) {
      await page.getByRole("button", { name: "Overview", exact: true }).click();
      await page.getByRole("button", { name: `Detalle operativo de ${id}`, exact: true }).click();
      await page.getByRole("heading", { name: id, exact: true }).waitFor();
      const panel = page.getByRole("region", { name: "Entrega y seguimiento", exact: true });
      await panel.getByRole("button", { name: "Consultar entrega y seguimiento", exact: true }).waitFor(); return panel;
    }
    await page.goto(uiUrl);
    stage = "independent absence despite completed commitment and Done issue";
    await consultIssue(); await assertPrivateHidden();
    expect(await issuePanel.getByText("Sin candidato actual confirmado: la aceptación técnica exacta no está acreditada. No se deduce de tareas finalizadas.", { exact: true }).count()).toBe(1);
    expect(await issuePanel.getByText("Sin observación registrada; no implica éxito ni fallo.", { exact: true }).count()).toBe(5);
    expect(mutations).toEqual([]);
    stage = "five explicit UI records with independent provenance and confirmation";
    const entries: IssueEvidenceReference[] = [];
    for (const [index, kind] of KINDS.entries()) {
      if (index) {
        await issuePanel.getByRole("button", { name: "Consultar entrega y seguimiento", exact: true }).click();
        await issuePanel.getByRole("heading", { name: "Aceptación técnica", exact: true }).waitFor();
      }
      await issuePanel.getByRole("button", { name: "Registrar observación manual", exact: true }).click();
      const form = issuePanel.getByRole("form", { name: "Registrar observación de entrega", exact: true });
      await form.getByLabel("Tipo de observación", { exact: true }).selectOption(kind);
      await form.getByLabel("Momento de la observación (hora local)", { exact: true }).fill("2026-10-15T12:00");
      await form.getByLabel("Resumen privado", { exact: true }).fill(`SYNTHETIC_PRIVATE_DELIVERY_${index}`);
      await form.getByLabel("Referencia de origen", { exact: true }).fill(`SYNTHETIC_PRIVATE_SOURCE_${index}`);
      await form.getByLabel("Próxima acción privada", { exact: true }).fill(`SYNTHETIC_PRIVATE_NEXT_${index}`);
      await form.getByLabel("Compromiso relacionado", { exact: true }).selectOption("commitment-delivery");
      expect(await form.getByLabel("Candidato relacionado", { exact: true }).inputValue()).toBe("");
      const confirm = form.getByRole("checkbox", { name: CONFIRM, exact: true }), save = form.getByRole("button", { name: "Guardar observación local", exact: true });
      expect(await confirm.isChecked()).toBe(false); expect(await save.isDisabled()).toBe(true);
      if (index === 0) {
        await confirm.check();
        await form.getByLabel("Referencia de origen", { exact: true }).fill("SYNTHETIC_PRIVATE_SOURCE_EDITED");
        expect(await confirm.isChecked()).toBe(false); expect(await save.isDisabled()).toBe(true);
      }
      await confirm.check();
      const response = await observeResponse(page, `/api/work-issues/${issue.id}/delivery-observations`, "POST", () => save.click());
      expect(response.status()).toBe(201);
      const result = await response.json() as { issue: WorkIssue; evidence: IssueEvidenceReference }; entries.push(result.evidence);
      expect(result.issue).toMatchObject({ id: issue.id, status: "done", revision: issue.revision + index + 1, scope_revision: issue.scope_revision, task_ids: [], candidate_ids: [] });
      expect(result.evidence).toMatchObject({ task_id: null, execution_id: null, candidate_id: null, candidate_revision: null, diff_fingerprint: null, kind: "work-product", status: "informational", created_at: NOW,
        delivery_observation: { schema_version: 1, kind, origin: "operator-entered", commitment_id: "commitment-delivery", occurred_at: OBSERVED } });
      expect(Object.hasOwn(result.evidence, "testing_evidence_fingerprint")).toBe(false);
      await issuePanel.getByRole("button", { name: "Consultar entrega y seguimiento", exact: true }).waitFor();
      await assertPrivateHidden();
    }
    stage = "private record disclosure stays local to explicit detail";
    await issuePanel.getByRole("button", { name: "Consultar entrega y seguimiento", exact: true }).click();
    await issuePanel.getByRole("heading", { name: "Seguimiento registrado", exact: true }).waitFor(); await assertPrivateHidden();
    expect(await issuePanel.locator(".delivery-readiness-record").count()).toBe(5);
    for (const [index, entry] of entries.entries()) {
      const record = issuePanel.locator(".delivery-readiness-record").filter({ hasText: entry.id });
      expect(await record.innerText()).toContain("operator-entered");
      expect(await record.locator("time").first().getAttribute("datetime")).toBe(OBSERVED);
      expect(await record.locator("time").last().getAttribute("datetime")).toBe(NOW);
      await record.getByRole("button", { name: `Mostrar detalle privado ${entry.id}`, exact: true }).click();
      expect(await record.getByText(`SYNTHETIC_PRIVATE_DELIVERY_${index}`, { exact: true }).count()).toBe(1);
      expect(await record.getByText(index ? `SYNTHETIC_PRIVATE_SOURCE_${index}` : "SYNTHETIC_PRIVATE_SOURCE_EDITED", { exact: true }).count()).toBe(1);
      expect(await record.getByText(`SYNTHETIC_PRIVATE_NEXT_${index}`, { exact: true }).count()).toBe(1);
      expect(await record.getByRole("link").count()).toBe(0);
      for (const other of [0, 1, 2, 3, 4].filter(value => value !== index)) expect(await page.locator("body").innerText()).not.toContain(`SYNTHETIC_PRIVATE_DELIVERY_${other}`);
      await record.getByRole("button", { name: `Ocultar detalle privado ${entry.id}`, exact: true }).click(); await assertPrivateHidden();
    }
    stage = "390-pixel manual form controls, readable options and keyboard focus";
    await page.setViewportSize({ width: 390, height: 844 });
    await issuePanel.getByRole("button", { name: "Registrar observación manual", exact: true }).click();
    const mobileForm = issuePanel.getByRole("form", { name: "Registrar observación de entrega", exact: true });
    await mobileForm.getByLabel("Tipo de observación", { exact: true }).focus();
    await page.keyboard.press("Tab"); expect(await mobileForm.getByLabel("Momento de la observación (hora local)", { exact: true }).evaluate(element => document.activeElement === element)).toBe(true);
    expect(await mobileForm.getByLabel("Momento de la observación (hora local)", { exact: true }).evaluate(element => Number.parseFloat(getComputedStyle(element).outlineWidth) >= 2)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await mobileForm.locator("input,select,textarea,button").evaluateAll(elements => elements.every(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth; }))).toBe(true);
    expect((await mobileForm.getByRole("button", { name: "Guardar observación local", exact: true }).boundingBox())!.width).toBeLessThan(350);
    expect(await mobileForm.getByLabel("Tipo de observación", { exact: true }).locator("option").evaluateAll(elements => elements.length === 5 && elements.every(element => { const style = getComputedStyle(element); return style.color !== style.backgroundColor && style.backgroundColor !== "rgba(0, 0, 0, 0)"; }))).toBe(true);
    await issuePanel.getByRole("button", { name: "Cancelar registro manual", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    stage = "project and commitment consultations do not complete or publish anything";
    const projectPanel = await openProject("alpha"); await assertPrivateHidden();
    await projectPanel.getByRole("button", { name: "Consultar entrega y seguimiento", exact: true }).click();
    await projectPanel.getByLabel("Issue de entrega", { exact: true }).selectOption(issue.id);
    await projectPanel.getByRole("heading", { name: "Respuesta registrada", exact: true }).waitFor();
    expect(await projectPanel.locator(".delivery-readiness-record").count()).toBe(5); await assertPrivateHidden();
    await page.getByRole("button", { name: "Preparar tarea", exact: true }).click();
    expect(await page.getByRole("textbox", { name: "Instrucciones", exact: true }).inputValue()).not.toContain("SYNTHETIC_PRIVATE"); await assertPrivateHidden();
    await page.getByRole("button", { name: "Clientes", exact: true }).click();
    const commitmentRow = page.getByRole("button", { name: /Public completed milestone/ }); await commitmentRow.waitFor();
    expect(await commitmentRow.innerText()).toContain("Completado"); expect(await commitmentRow.innerText()).not.toContain("SYNTHETIC_PRIVATE");
    await commitmentRow.click();
    const commitmentPanel = page.getByRole("region", { name: "Entrega y seguimiento", exact: true });
    await commitmentPanel.getByRole("button", { name: "Consultar entrega y seguimiento", exact: true }).click();
    await commitmentPanel.getByLabel("Issue de entrega", { exact: true }).selectOption(issue.id);
    await commitmentPanel.getByRole("heading", { name: "Respuesta registrada", exact: true }).waitFor();
    expect(await commitmentPanel.locator(".delivery-readiness-record").count()).toBe(5); await assertPrivateHidden();
    expect(await readFile(join(root, "state/portfolio/clients.json"), "utf8")).toBe(unchanged[2]);
    stage = "personal experiment has no client or release requirement";
    const personalPanel = await openProject("beta");
    await personalPanel.getByRole("button", { name: "Consultar entrega y seguimiento", exact: true }).click();
    await personalPanel.getByLabel("Issue de entrega", { exact: true }).selectOption(personal.id);
    await personalPanel.getByRole("heading", { name: "Aceptación técnica", exact: true }).waitFor();
    expect(await personalPanel.locator(".delivery-readiness-record").count()).toBe(0);
    expect(await personalPanel.getByRole("button", { name: "Registrar observación manual", exact: true }).isEnabled()).toBe(true);
    await personalPanel.getByRole("button", { name: "Registrar observación manual", exact: true }).click();
    expect(await personalPanel.getByLabel("Compromiso relacionado", { exact: true }).inputValue()).toBe("");
    expect(await personalPanel.getByLabel("Compromiso relacionado", { exact: true }).locator("option").count()).toBe(1); await assertPrivateHidden();
    stage = "overview, Today and source projections keep confidential facts out";
    for (const section of ["Hoy", "SURTEC", "Overview"]) { await page.getByRole("button", { name: section, exact: true }).click(); await assertPrivateHidden(); }
    expect(await page.getByRole("textbox", { name: "Instrucciones", exact: true }).inputValue()).not.toContain("SYNTHETIC_PRIVATE");
    for (const path of ["/api/operating/overview", "/api/operating/projects/alpha", "/api/operating/issues/" + issue.id, "/api/today"]) {
      const response = await fetch(`${apiUrl}${path}`); expect(response.status).toBe(200); expect(await response.text()).not.toContain("SYNTHETIC_PRIVATE");
    }
    stage = "reload preserves facts without replaying a write";
    await page.reload(); await consultIssue(); await assertPrivateHidden();
    expect(await issuePanel.locator(".delivery-readiness-record").count()).toBe(5);
    const savedBytes = await readFile(join(root, "state/issues/issues.json"), "utf8"), saved = JSON.parse(savedBytes);
    expect(saved.issues[issue.id]).toEqual({ ...original.issues[issue.id], evidence_ids: entries.map(entry => entry.id), revision: issue.revision + 5 });
    expect(saved.issues[personal.id]).toEqual(original.issues[personal.id]);
    expect(Object.values(saved.evidence)).toEqual(entries); expect(JSON.stringify(saved.events)).not.toContain("SYNTHETIC_PRIVATE");
    const oldToken = (await (await fetch(`${apiUrl}/api/session`)).json()).token as string;
    const headers = { "Content-Type": "application/json", "X-Surtec-Session": oldToken };
    const staleInput: RecordDeliveryObservationInput = { project_id: "alpha", expected_revision: issue.revision, scope_revision: issue.scope_revision,
      candidate_id: null, candidate_revision: null, diff_fingerprint: null, delivery_observation: entries[0]!.delivery_observation!, confirm: true };
    const stale = await fetch(`${apiUrl}/api/work-issues/${issue.id}/delivery-observations`, { method: "POST", headers, body: JSON.stringify(staleInput) }); expect(stale.status).toBe(409);
    expect(await readFile(join(root, "state/issues/issues.json"), "utf8")).toBe(savedBytes);
    stage = "actual API restart retains bytes and rejects the old mutation token";
    await page.goto("about:blank"); expect(await stopApi()).toBe(true); apiUrl = await startApi(); await vite!.close(); const restartedUi = await startUi(apiUrl);
    const expired = await fetch(`${apiUrl}/api/work-issues/${issue.id}/delivery-observations`, { method: "POST", headers, body: JSON.stringify({ ...staleInput, expected_revision: issue.revision + 5 }) }); expect(expired.status).toBe(403);
    await page.goto(restartedUi); await consultIssue(); await assertPrivateHidden();
    expect(await issuePanel.locator(".delivery-readiness-record").count()).toBe(5);
    expect(await readFile(join(root, "state/issues/issues.json"), "utf8")).toBe(savedBytes);
    expect(await Promise.all(unchangedPaths.map(path => readFile(join(root, "state", path), "utf8")))).toEqual(unchanged);
    expect(await harnessTreeHash(join(root, "projects"))).toBe(sourceHash);
    expect(mutations).toEqual(Array.from({ length: 5 }, () => `POST /api/work-issues/${issue.id}/delivery-observations`));
    for (const path of ["state/tasks", "state/workflows", "state/harness/profiles.json", "forbidden-effect", "forbidden-runtime"]) expect(existsSync(join(root, path))).toBe(false);
    expect(pageErrors, JSON.stringify(pageErrors)).toEqual([]); expect(httpErrors, JSON.stringify(httpErrors)).toEqual([]); expect(consoleErrors, JSON.stringify(consoleErrors)).toEqual([]);
  } catch (error) { throw new Error(`Q T010 browser acceptance failed at ${stage}: ${(error as Error).message}`); }
  finally {
    const cleanup = await cleanupSmoke({ root, browser: browser ? () => browser!.close() : undefined, vite: vite ? () => vite!.close() : undefined, api: child ? stopApi : undefined });
    expect(cleanup).toEqual({ browser_closed: true, vite_closed: true, api_stopped: true, workspace_removed: true, failures: [] }); expect(existsSync(root)).toBe(false);
  }
}, 120000);
