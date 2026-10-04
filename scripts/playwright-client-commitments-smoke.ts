import assert from "node:assert/strict";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser } from "playwright";
import type { ClientCommitment, ClientRecord, ClientSummary } from "../lib/client-portfolio";
import type { ProjectProfile } from "../lib/portfolio-profile";
import type { Signal } from "../lib/signals/types";
import type { OverviewModel, ProjectView, TodayModel } from "../lib/state/types";

const sessionToken = "playwright-client-commitments-session-token";
const confidentialNote = "Synthetic confidential delivery note; never auto-share.";
const observedAt = new Date().toISOString();
const projectId = "fictional-alpha";
const clients = new Map<string, ClientRecord>();
const commitments = new Map<string, ClientCommitment>();
const profiles = new Map<string, ProjectProfile>([[projectId, {
  schema_version: 2, project_id: projectId, kind: "client-product", lifecycle: "active", priority: 1, criticality: "high",
  current_goal: "Synthetic client delivery", next_action: "Review the synthetic handoff", deadline: null,
  client_id: null, last_reviewed_at: null, tags: [],
}]]);
const taskRequests: { body: Record<string, unknown>; token: string | null }[] = [];
const mutationTokens: string[] = [];

const project: ProjectView = {
  id: projectId, status: "active", health: "ok", note: null, repo: "https://github.com/fictional/alpha", path: null,
  configured: true, git: { branch: "main", dirty: false, uncommitted: 0, ahead: 0, behind: 0, last_commit: null, ok: true },
  last_activity: observedAt, task_counts: { inProgress: 0, finished: 0 },
};
const overview: OverviewModel = { projects: [project], inProgress: [], history: [], attention: [] };

function clientSummaries(): ClientSummary[] {
  return [...clients.values()].map((client) => ({
    id: client.id, display_name: client.display_name, status: client.status, criticality: client.criticality,
    project_ids: [...profiles.values()].filter((profile) => profile.client_id === client.id).map((profile) => profile.project_id),
    next_review_date: client.next_review_date,
    active_commitment_count: [...commitments.values()].filter((commitment) => commitment.client_id === client.id && !["completed", "cancelled"].includes(commitment.state)).length,
  }));
}

function today(): TodayModel {
  const nextCommitment = [...commitments.values()].find((item) => ["planned", "in-progress", "blocked"].includes(item.state));
  const commitmentSignal: Signal | null = nextCommitment ? {
    schema_version: 1, id: "sig_aaaaaaaaaaaaaaaaaaaaaaaa", project_id: nextCommitment.project_id, project_kind: "client-product",
    source: "commitment", type: "commitment-due-soon", severity: "warning", title: nextCommitment.title,
    reason: "Synthetic delivery commitment is due soon.", evidence_at: observedAt, observed_at: observedAt,
    suggested_action: "Review the delivery next step.", action_kind: "review-commitment",
    ranking: { tier: "client-commitment", order: 2 }, state: "open", snoozed_until: null,
    evidence: { commitment_id: nextCommitment.id, deadline: nextCommitment.due_date, priority: nextCommitment.priority, criticality: nextCommitment.criticality },
  } : null;
  const portfolio: TodayModel["portfolio"] = {
    signal_status: "available", signals_observed_at: observedAt,
    recommendations: commitmentSignal ? [commitmentSignal] : [],
    critical_attention: commitmentSignal ? [commitmentSignal] : [], work_to_continue: [],
    client_commitments: commitmentSignal ? [commitmentSignal] : [], personal_opportunities: [], stale_profiles: [], snoozed_signals: [],
    pinned_signal_ids: [], warnings: [],
    sessions: { available: true, unavailable_reason: null, active: [], paused: [], completed: [] },
  };
  return {
    date: observedAt.slice(0, 10), time_zone: "America/Buenos_Aires", generated_at: observedAt,
    active: [], attention: [], completed: [], failed: [], cancelled: [], retries: [], cancellations: [], recoveries: [],
    counts: { active: 0, attention: 0, completed: 0, failed: 0, cancelled: 0, retries: 0 }, warnings: [],
    portfolio,
  };
}

async function launchBrowser(): Promise<Browser> {
  try { return await chromium.launch({ headless: true }); }
  catch (error) {
    if (process.platform !== "win32") throw error;
    return chromium.launch({ headless: true, channel: "msedge" });
  }
}

async function main(): Promise<void> {
  let browser: Browser | null = null;
  let vite: ViteDevServer | null = null;
  try {
    browser = await launchBrowser();
    vite = await createServer({ configFile: "vite.config.ts", server: { host: "127.0.0.1", port: 0, strictPort: true } });
    await vite.listen();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      let status = 200;
      let body: unknown = {};

      if (url.pathname === "/api/overview") body = overview;
      else if (url.pathname === "/api/today") body = today();
      else if (url.pathname === "/api/runs") body = { runs: [] };
      else if (url.pathname === "/api/portfolio/profiles" && method === "GET") body = { profiles: [...profiles.values()] };
      else if (url.pathname === "/api/session") body = { token: sessionToken };
      else if (url.pathname === "/api/dispatch-options") body = { projects: [{
        project: projectId, allowed_agents: ["backend-engineer"], project_sandbox_ceiling: "workspace-write",
        has_local_checkout: true, has_verification_commands: true,
        agents: [{ agent: "backend-engineer", agent_sandbox_ceiling: "workspace-write", allowed_modes: ["read-only", "workspace-write"],
          default_mode: "read-only", modes: [
            { mode: "read-only", allowed: true, reason: null },
            { mode: "workspace-write", allowed: true, reason: null },
          ] }],
      }] };
      else if (url.pathname === "/api/clients" && method === "GET") body = { clients: clientSummaries() };
      else if (url.pathname === "/api/clients" && method === "POST") {
        assert.equal(request.headers()["x-surtec-session"], sessionToken);
        mutationTokens.push(request.headers()["x-surtec-session"] ?? "");
        const input = request.postDataJSON() as Omit<ClientRecord, "id" | "created_at" | "updated_at">;
        const now = new Date().toISOString();
        const client: ClientRecord = { ...input, id: "client-smoke", created_at: now, updated_at: now };
        clients.set(client.id, client);
        status = 201;
        body = { client };
      } else if (url.pathname === "/api/clients/client-smoke" && method === "GET") {
        const client = clients.get("client-smoke");
        status = client ? 200 : 404;
        body = client ? { client } : { error: "not found" };
      } else if (url.pathname === `/api/projects/${projectId}/profile` && method === "POST") {
        assert.equal(request.headers()["x-surtec-session"], sessionToken);
        mutationTokens.push(request.headers()["x-surtec-session"] ?? "");
        const profile = request.postDataJSON() as ProjectProfile;
        profiles.set(projectId, profile);
        body = { profile };
      } else if (url.pathname === "/api/commitments" && method === "GET") body = { commitments: [...commitments.values()] };
      else if (url.pathname === "/api/commitments" && method === "POST") {
        assert.equal(request.headers()["x-surtec-session"], sessionToken);
        mutationTokens.push(request.headers()["x-surtec-session"] ?? "");
        const input = request.postDataJSON() as Omit<ClientCommitment, "id" | "created_at" | "updated_at">;
        const now = new Date().toISOString();
        const commitment: ClientCommitment = { ...input, id: "commitment-smoke", created_at: now, updated_at: now };
        commitments.set(commitment.id, commitment);
        status = 201;
        body = { commitment };
      } else if (url.pathname === `/api/projects/${projectId}/client-context-options`) {
        body = { available: true, categories: ["client-identity", "project-outcome", "active-commitments", "service-context", "confidential-notes"] };
        assert.equal(JSON.stringify(body).includes(confidentialNote), false, "context options never return client notes");
      } else if (url.pathname === "/api/tasks" && method === "POST") {
        const suppliedToken = request.headers()["x-surtec-session"] ?? null;
        taskRequests.push({ body: request.postDataJSON() as Record<string, unknown>, token: suppliedToken });
        if (suppliedToken !== sessionToken) status = 403;
        else body = { id: "T-smoke" };
      } else {
        status = 404;
        body = { error: `fixture endpoint not found: ${method} ${url.pathname}` };
      }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });

    const address = vite.httpServer?.address();
    assert.ok(address && typeof address !== "string", "Vite server has a TCP address");
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.getByText("Cockpit diario").waitFor();

    await page.getByRole("button", { name: "Clientes" }).click();
    await page.getByRole("button", { name: "Nuevo", exact: true }).first().click();
    await page.getByLabel("Nombre visible").fill("Fictional Client");
    await page.getByLabel("Nota de SLA / criticidad").fill("Synthetic service-level note.");
    await page.getByLabel("Notas confidenciales").fill(confidentialNote);
    await page.getByRole("button", { name: "Guardar cliente" }).click();
    await page.getByText("Guardado únicamente en el estado local.").waitFor();
    await page.getByText("Cliente 1", { exact: true }).waitFor();
    assert.equal(await page.locator(".client-row").getByText("Fictional Client").count(), 0, "client names are masked in the list by default");

    await page.getByRole("button", { name: "Overview" }).click();
    await page.getByRole("button", { name: `Detalle operativo de ${projectId}` }).click();
    await page.getByRole("button", { name: "Editar perfil" }).waitFor();
    await page.getByRole("button", { name: "Editar perfil" }).click();
    await page.getByLabel("Cliente asociado").selectOption("client-smoke");
    await page.getByRole("button", { name: "Guardar perfil local" }).click();
    await page.getByText("Guardado solo en el estado local.").waitFor();
    await page.getByRole("button", { name: /Volver al portfolio/ }).click();

    await page.getByRole("button", { name: "Clientes" }).click();
    await page.getByLabel("Cliente (opcional)").selectOption("client-smoke");
    await page.getByLabel("Hito / entregable").fill("Fictional client delivery");
    await page.getByLabel("Resultado esperado").fill("A synthetic release is ready for review.");
    await page.getByLabel("Próxima acción explícita").fill("Review the acceptance checklist.");
    await page.getByRole("button", { name: "Guardar compromiso" }).click();
    await page.getByText("Fictional client delivery", { exact: true }).waitFor();
    const commitmentRow = page.locator(".commitment-row").filter({ hasText: "Fictional client delivery" });
    await commitmentRow.waitFor();
    assert.match(await commitmentRow.innerText(), /Cliente oculto/, "commitment list masks the client name by default");
    await page.getByRole("button", { name: "Mostrar nombres" }).click();
    await page.locator(".client-row").filter({ hasText: "Fictional Client" }).waitFor();
    assert.match(await commitmentRow.innerText(), /Fictional Client/, "the temporary reveal shows the client name");
    await page.getByRole("button", { name: "Ocultar nombres" }).click();

    await page.getByRole("button", { name: "Hoy" }).click();
    await page.getByRole("button", { name: "Actualizar Hoy" }).click();
    await page.getByText("Fictional client delivery", { exact: true }).waitFor();
    await page.getByRole("button", { name: /Preparar tarea/ }).first().click();
    await page.getByLabel("Proyecto", { exact: true }).waitFor();
    assert.equal(await page.getByPlaceholder(/instrucciones/i).inputValue(),
      "Review the project and determine the next safe action. Client context is omitted; choose any categories explicitly in the task form.",
      "client commitment task prefills omit profile and confidential text");

    await page.getByRole("button", { name: "Overview" }).click();
    await page.getByRole("checkbox", { name: /Notas confidenciales/ }).waitFor();
    const confidentialCheckbox = page.getByRole("checkbox", { name: /Notas confidenciales/ });
    assert.equal(await confidentialCheckbox.isChecked(), false, "no client-context category is selected automatically");
    await page.getByPlaceholder(/instrucciones/i).fill("Review the fictional client delivery.");
    await confidentialCheckbox.check();
    await page.getByRole("button", { name: /Despachar/ }).click();
    await page.getByText("Despachado: T-smoke").waitFor();

    assert.equal(taskRequests.length, 1, "one task was submitted");
    assert.equal(taskRequests[0]?.token, sessionToken, "task mutation is protected by the local session token");
    assert.deepEqual(taskRequests[0]?.body.client_context_categories, ["confidential-notes"], "only the explicit category selection is sent");
    assert.equal(JSON.stringify(taskRequests[0]?.body).includes(confidentialNote), false, "the browser sends a category choice, not note contents");
    assert.equal(mutationTokens.length, 3, "client, project profile, and commitment writes are protected");
    assert.equal(mutationTokens.every((token) => token === sessionToken), true);

    console.log("Playwright Client Commitments smoke passed: local client creation, masked display, project association, delivery commitment, explicit-only client context, and protected writes.");
    await page.close();
  } finally {
    if (browser) await browser.close();
    if (vite) await vite.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
