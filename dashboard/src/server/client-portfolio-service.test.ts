import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientRecord } from "../../../lib/client-portfolio";
import type { ProjectProfile } from "../../../lib/portfolio-profile";
import type { TaskRecord, WorkSession } from "../../../lib/state/types";
import { clientPortfolioPath } from "../../../lib/state/paths";
import { createClientPortfolioService, ClientPortfolioConflictError, ClientPortfolioNotFoundError, ClientPortfolioValidationError } from "./client-portfolio-service";

let root: string | undefined;
const NOW = new Date("2026-09-28T12:00:00.000Z");
const profile = (clientId: string | null = "client-test"): ProjectProfile => ({
  schema_version: 1,
  project_id: "alpha",
  kind: "client",
  lifecycle: "active",
  priority: 1,
  criticality: "high",
  current_goal: "Deliver fictional inventory search.",
  next_action: "Verify the search filters.",
  deadline: null,
  client_id: clientId,
  last_reviewed_at: null,
  tags: [],
});

const commitmentInput = (clientId: string | null = "client-test") => ({
  project_id: "alpha",
  client_id: clientId,
  title: "Fictional milestone",
  expected_outcome: "The fictional feature is usable.",
  due_date: "2026-09-30",
  priority: 1,
  criticality: "high" as const,
  state: "in-progress" as const,
  issue_numbers: [12],
  pull_request_numbers: [34],
  task_ids: ["TASK-1"],
  session_ids: ["session-1"],
  next_action: "Review the fictional release.",
});

function setup(initialProfiles: ProjectProfile[] = []) {
  root = mkdtempSync(join(tmpdir(), "surtec-client-service-"));
  let profiles = initialProfiles;
  const service = createClientPortfolioService(process.cwd(), {
    filePath: clientPortfolioPath(join(root, "state")),
    clock: () => new Date(NOW),
    resolveProject: (id) => ["alpha", "beta"].includes(id),
    readProfiles: () => profiles,
    readTask: (id) => id === "TASK-1" ? ({ envelope: { id, project: "alpha" } } as TaskRecord) : null,
    readSessions: () => [{ id: "session-1", project_id: "alpha" } as WorkSession],
  });
  return { service, setProfiles: (value: ProjectProfile[]) => { profiles = value; } };
}

function clientInput(overrides: Partial<Omit<ClientRecord, "id" | "created_at" | "updated_at">> = {}) {
  return {
    display_name: "Fictional Example Client",
    status: "active",
    criticality: "high",
    sla_note: "Fictional response target.",
    next_review_date: "2026-10-15",
    confidential_notes: "Fictional confidential note.",
    ...overrides,
  };
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("client portfolio service", () => {
  it("keeps client project membership derived from profiles and omits confidential fields from summaries", () => {
    const { service } = setup();
    const created = service.createClient(clientInput());
    const summaries = service.listClients();
    expect(summaries).toEqual([{
      id: created.id,
      display_name: created.display_name,
      status: "active",
      criticality: "high",
      project_ids: [],
      next_review_date: "2026-10-15",
      active_commitment_count: 0,
    }]);
    expect(JSON.stringify(summaries)).not.toContain(created.confidential_notes);
    expect(service.getClient(created.id)).toMatchObject({ confidential_notes: created.confidential_notes });
  });

  it("validates commitment project, client relation, task/session links, and preserves audit timestamps", () => {
    const { service, setProfiles } = setup();
    const createdClient = service.createClient(clientInput());
    setProfiles([profile(createdClient.id)]);
    const created = service.createCommitment(commitmentInput(createdClient.id));
    expect(created).toMatchObject({
      id: expect.stringMatching(/^commitment-/),
      project_id: "alpha",
      client_id: createdClient.id,
      issue_numbers: [12],
      pull_request_numbers: [34],
      task_ids: ["TASK-1"],
      session_ids: ["session-1"],
    });
    expect(service.listClients()[0]?.active_commitment_count).toBe(1);
    expect(service.listCommitments()).toEqual([created]);

    expect(() => service.createCommitment({ ...commitmentInput(createdClient.id), project_id: "unknown" })).toThrow(ClientPortfolioNotFoundError);
    expect(() => service.createCommitment({ ...commitmentInput(createdClient.id), task_ids: ["UNKNOWN"] })).toThrow(ClientPortfolioNotFoundError);
    expect(() => service.createCommitment({ ...commitmentInput(createdClient.id), project_id: "beta" })).toThrow(ClientPortfolioValidationError);
    expect(() => service.createCommitment({ ...commitmentInput(createdClient.id), session_ids: ["session-2"] })).toThrow(ClientPortfolioNotFoundError);
  });

  it("provides context categories without content and only builds explicitly selected context", () => {
    const { service, setProfiles } = setup();
    const createdClient = service.createClient(clientInput());
    setProfiles([profile(createdClient.id)]);
    const commitment = service.createCommitment(commitmentInput(createdClient.id));
    const options = service.contextOptions("alpha");
    expect(options).toEqual({
      available: true,
      categories: ["client-identity", "project-outcome", "active-commitments", "service-context", "confidential-notes"],
    });
    expect(JSON.stringify(options)).not.toContain(createdClient.display_name);
    expect(JSON.stringify(options)).not.toContain(createdClient.confidential_notes);
    expect(service.buildTaskContext("alpha", [])).toBeNull();

    const context = service.buildTaskContext("alpha", ["active-commitments", "confidential-notes"]);
    expect(context?.instructions).toContain(commitment.title);
    expect(context?.instructions).toContain(createdClient.confidential_notes!);
    expect(context?.audit).toEqual({
      client_id: createdClient.id,
      categories: ["active-commitments", "confidential-notes"],
      shared_at: NOW.toISOString(),
    });
    expect(() => service.buildTaskContext("alpha", ["confidential-notes", "confidential-notes"])).toThrow(ClientPortfolioValidationError);
    expect(() => service.buildTaskContext("alpha", ["made-up"])).toThrow(ClientPortfolioValidationError);
    expect(() => service.buildTaskContext("beta", ["client-identity"])).toThrow(ClientPortfolioConflictError);
  });

  it("rejects commitment associations that cross project boundaries", () => {
    const { service, setProfiles } = setup();
    const createdClient = service.createClient(clientInput());
    setProfiles([profile(createdClient.id)]);
    expect(() => service.createCommitment({
      ...commitmentInput(createdClient.id),
      task_ids: ["TASK-1"],
      project_id: "beta",
      client_id: null,
    })).toThrow(ClientPortfolioValidationError);
  });
});
