import { throws } from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createClientPortfolioService } from "../dashboard/src/server/client-portfolio-service";
import { createContextService } from "../dashboard/src/server/context-service";
import { createTask, ValidationError } from "../dashboard/src/server/dispatch";
import type { ClientContextCategory } from "../lib/client-portfolio";
import { emptyProjectProfile } from "../lib/portfolio-profile";
import { clientPortfolioPath, eventsDir, portfolioProfilesPath } from "../lib/state/paths";
import { upsertProjectProfile } from "../lib/state/portfolio-profiles";
import { listTasks, readTask } from "../lib/state/store";
import { createRolePolicyFixture, roleFixtureAgent, roleFixtureProject, roleFixtureRole } from "./testing/role-policy-fixture";

const clientName = "Fictional Client Juniper Meridian";
const confidentialNote = "Fictional confidential note LANTERN-ORCHID-729.";
const analysis = {
  project: roleFixtureProject,
  agent: roleFixtureAgent,
  role_id: roleFixtureRole,
  instructions: "Inspect the synthetic project instructions.",
};

function withClientFixture(run: (fixture: { root: string; state: string; clientId: string }) => void) {
  const fixture = createRolePolicyFixture();
  try {
    for (const [name, value] of Object.entries(fixture.environment)) vi.stubEnv(name, value);
    const clients = createClientPortfolioService(fixture.root);
    const client = clients.createClient({
      display_name: clientName,
      status: "active",
      criticality: "low",
      sla_note: null,
      next_review_date: null,
      confidential_notes: confidentialNote,
    });
    const profilePath = portfolioProfilesPath(fixture.state);
    upsertProjectProfile({
      ...emptyProjectProfile(roleFixtureProject),
      kind: "client-product",
      client_id: client.id,
    }, profilePath);
    expect(clients.contextOptions(roleFixtureProject)).toMatchObject({
      available: true,
      categories: expect.arrayContaining(["client-identity", "confidential-notes"]),
    });
    const clientPath = clientPortfolioPath(fixture.state);
    const clientBytes = readFileSync(clientPath);
    const profileBytes = readFileSync(profilePath);

    run({ root: fixture.root, state: fixture.state, clientId: client.id });

    expect(readFileSync(clientPath)).toEqual(clientBytes);
    expect(readFileSync(profilePath)).toEqual(profileBytes);
  } finally {
    vi.unstubAllEnvs();
    fixture.dispose();
  }
}

function analysisRequest(category?: ClientContextCategory) {
  return { ...analysis, ...(category === undefined ? {} : { client_context_categories: [category] }) };
}

function expectMarkers(text: string, category?: ClientContextCategory) {
  if (category === "client-identity") expect(text).toContain(clientName);
  else expect(text).not.toContain(clientName);
  if (category === "confidential-notes") expect(text).toContain(confidentialNote);
  else expect(text).not.toContain(confidentialNote);
}

describe("org.context.confidential-consent", () => {
  it.each([
    { name: "excludes client content by default", category: undefined },
    { name: "includes only client identity with identity consent", category: "client-identity" },
    { name: "includes confidential notes only with explicit consent", category: "confidential-notes" },
  ] as const)("$name", ({ category }) => {
    withClientFixture(({ root, clientId }) => {
      const context = createContextService(root);
      const request = analysisRequest(category);
      const preview = context.preview({ ...request, kind: "analysis" });
      const selected = category === undefined ? [] : [category];
      expect(preview).toMatchObject({
        allowed: true,
        manifest: { selected_categories: selected, sandbox: "read-only" },
      });
      expect(JSON.stringify(preview)).not.toContain(confidentialNote);
      if (category === "confidential-notes") expect(preview.manifest.excluded_categories).not.toContain(category);
      else expect(preview.manifest.excluded_categories).toContain("confidential-notes");

      const { id } = createTask({ ...request, preview_fingerprint: preview.fingerprint }, root, undefined, { context });
      const task = readTask(id);
      if (!task) throw new Error("Queued confidential consent EVAL task is missing.");
      expect(task).toMatchObject({
        lifecycle: "queued",
        envelope: {
          context_manifest: {
            fingerprint: preview.fingerprint,
            selected_categories: selected,
            excluded_categories: preview.manifest.excluded_categories,
          },
        },
      });
      expect(JSON.stringify(task.envelope.context_manifest)).not.toContain(confidentialNote);
      const audit = task.envelope.metadata.client_context_share;
      if (category === undefined) expect(audit).toBeUndefined();
      else {
        expect(audit).toEqual({ client_id: clientId, categories: selected, shared_at: expect.any(String) });
        expect(JSON.stringify(audit)).not.toContain(confidentialNote);
      }
      expectMarkers(task.envelope.instructions, category);
      expectMarkers(context.revalidateTask(task).rendered, category);
    });
  });

  it("rejects an issued confidential preview after consent is removed", () => {
    withClientFixture(({ root, state }) => {
      const context = createContextService(root);
      const inventory = readdirSync(state, { recursive: true }).sort();
      const preview = context.preview({ ...analysisRequest("confidential-notes"), kind: "analysis" });
      expect(preview).toMatchObject({ allowed: true, manifest: { selected_categories: ["confidential-notes"] } });
      expect(JSON.stringify(preview)).not.toContain(confidentialNote);

      throws(
        () => createTask({ ...analysisRequest(), preview_fingerprint: preview.fingerprint }, root, undefined, { context }),
        (error: unknown) => error instanceof ValidationError
          && error.status === 409
          && error.message === "Context preview changed; regenerate before dispatch",
      );
      expect(listTasks()).toEqual([]);
      expect(existsSync(eventsDir(state))).toBe(false);
      expect(readdirSync(state, { recursive: true }).sort()).toEqual(inventory);
    });
  });
});
