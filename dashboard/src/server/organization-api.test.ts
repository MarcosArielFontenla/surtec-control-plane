import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./index";
import { createHttpSecurity } from "./http-security";
import { createOrganizationService } from "./organization-service";

let root: string | undefined;
const token = "organization-api-test-session-token";
const now = () => new Date("2026-09-28T12:00:00.000Z");

afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

function testApp() {
  root = mkdtempSync(join(tmpdir(), "surtec-organization-api-"));
  return createApp(process.cwd(), () => {}, undefined, createHttpSecurity(token), {
    organization: createOrganizationService({ statePath: join(root, "state", "organization", "organization.json"), clock: now }),
  });
}

async function request(app: ReturnType<typeof createApp>, path: string, method = "GET", body?: unknown, withToken = true) {
  const headers = new Headers({ host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (withToken) headers.set("x-surtec-session", token);
  return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

describe("organization API", () => {
  it("exposes one local company and protects all profile/objective/link writes", async () => {
    const app = testApp();
    const read = await request(app, "/api/organization");
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ company: { id: "surtec", display_name: "SURTEC" }, objectives: [] });
    const denied = await request(app, "/api/organization/company", "PUT", { schema_version: 1, id: "surtec", display_name: "SURTEC", mission: null, operating_principles: [], active_objective_ids: [], last_reviewed_at: null }, false);
    expect(denied.status).toBe(403);
  });

  it("creates versioned objectives and atomically links multiple projects with one primary", async () => {
    const app = testApp();
    const created = await request(app, "/api/organization/objectives", "POST", {
      title: "Ship the internal platform", desired_outcome: "A stable, useful tool.", success_criteria: ["Checks pass."],
      status: "active", horizon: "quarter", priority: 2, target_date: "2026-12-31", parent_objective_id: null,
    });
    expect(created.status).toBe(201);
    const objective = (await created.json() as { objective: { id: string; schema_version: number } }).objective;
    expect(objective).toMatchObject({ schema_version: 1, company_id: "surtec", project_ids: [], owner: "marcos", last_reviewed_at: "2026-09-28" });
    const linked = await request(app, "/api/organization/projects/alpha/objectives", "PUT", {
      objective_ids: [objective.id], primary_objective_id: objective.id,
    });
    expect(linked.status).toBe(200);
    expect((await linked.json() as { organization: { objectives: Array<{ project_ids: string[] }> } }).organization.objectives[0]?.project_ids).toEqual(["alpha"]);
    const duplicatePrimary = await request(app, "/api/organization/projects/alpha/objectives", "PUT", { objective_ids: [], primary_objective_id: objective.id });
    expect(duplicatePrimary.status).toBe(400);
  });

  it("rejects invalid company ids, oversized input, and unknown objective parents", async () => {
    const app = testApp();
    const company = await request(app, "/api/organization/company", "PUT", {
      schema_version: 1, id: "other", display_name: "Other", mission: null, operating_principles: [], active_objective_ids: [], last_reviewed_at: null,
    });
    expect(company.status).toBe(400);
    const missingParent = await request(app, "/api/organization/objectives", "POST", {
      title: "Invalid hierarchy", desired_outcome: "An outcome.", success_criteria: [], status: "draft", horizon: "now", priority: 3,
      target_date: null, parent_objective_id: "not-found",
    });
    expect(missingParent.status).toBe(400);
  });
});
