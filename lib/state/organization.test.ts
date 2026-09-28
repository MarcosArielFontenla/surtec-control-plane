import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Objective } from "../organization";
import { readOrganizationSnapshot, setProjectObjectives, upsertCompanyProfile, upsertObjective } from "./organization";

let root: string;
let filePath: string;
const objective = (id: string, overrides: Partial<Objective> = {}): Objective => ({
  schema_version: 1, id, company_id: "surtec", title: `Objective ${id}`, desired_outcome: "A measurable outcome.",
  success_criteria: ["Evidence is recorded."], status: "draft", horizon: "quarter", priority: 3,
  target_date: null, parent_objective_id: null, project_ids: [], owner: "marcos", last_reviewed_at: "2026-09-28",
  ...overrides,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-organization-"));
  filePath = join(root, "organization", "organization.json");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("local organization state", () => {
  it("returns the single SURTEC company without creating local state", () => {
    expect(readOrganizationSnapshot(filePath)).toMatchObject({ company: { id: "surtec", display_name: "SURTEC", active_objective_ids: [] }, objectives: [] });
    expect(existsSync(filePath)).toBe(false);
  });

  it("keeps active objective ids and project-to-objective links consistent", () => {
    upsertObjective(objective("obj-a", { status: "active", priority: 2 }), filePath);
    upsertObjective(objective("obj-b", { status: "active", priority: 1 }), filePath);
    upsertObjective(objective("obj-c"), filePath);
    setProjectObjectives("alpha", ["obj-a", "obj-b"], "obj-b", filePath);
    setProjectObjectives("personal", [], null, filePath);

    const snapshot = readOrganizationSnapshot(filePath);
    expect(snapshot.company.active_objective_ids).toEqual(["obj-b", "obj-a"]);
    expect(snapshot.project_objectives.alpha).toEqual({ objective_ids: ["obj-a", "obj-b"], primary_objective_id: "obj-b" });
    expect(snapshot.objectives.find((item) => item.id === "obj-a")?.project_ids).toEqual(["alpha"]);
    expect(snapshot.objectives.find((item) => item.id === "obj-c")?.project_ids).toEqual([]);
    expect(snapshot.project_objectives.personal).toBeUndefined();
  });

  it("rejects unknown objectives and a primary objective not linked to the project", () => {
    expect(() => setProjectObjectives("alpha", ["unknown"], null, filePath)).toThrow(/not found/);
    upsertObjective(objective("obj-a"), filePath);
    expect(() => setProjectObjectives("alpha", ["obj-a"], "obj-b", filePath)).toThrow(/primary objective/);
  });

  it("rejects ancestry cycles and excessive depth without overwriting the last good state", () => {
    upsertObjective(objective("obj-a"), filePath);
    upsertObjective(objective("obj-b", { parent_objective_id: "obj-a" }), filePath);
    const before = readFileSync(filePath, "utf8");
    expect(() => upsertObjective(objective("obj-a", { parent_objective_id: "obj-b" }), filePath)).toThrow(/cycle/);
    expect(readFileSync(filePath, "utf8")).toBe(before);

    for (let index = 1; index <= 8; index += 1) {
      const id = `deep-${index}`;
      upsertObjective(objective(id, { parent_objective_id: index === 1 ? null : `deep-${index - 1}` }), filePath);
    }
    expect(() => upsertObjective(objective("deep-9", { parent_objective_id: "deep-8" }), filePath)).toThrow(/8 levels/);
  });

  it("rejects malformed, inconsistent, and future-version files without replacing them", () => {
    mkdirSync(join(root, "organization"), { recursive: true });
    writeFileSync(filePath, "{broken", "utf8");
    expect(() => readOrganizationSnapshot(filePath)).toThrow(/invalid JSON/);
    expect(readFileSync(filePath, "utf8")).toBe("{broken");
    const future = JSON.stringify({ schema_version: 2 });
    writeFileSync(filePath, future, "utf8");
    expect(() => readOrganizationSnapshot(filePath)).toThrow(/unsupported organization schema version/);
    expect(readFileSync(filePath, "utf8")).toBe(future);
  });

  it("only updates the SURTEC profile and preserves the derived active index", () => {
    upsertObjective(objective("obj-a", { status: "active" }), filePath);
    upsertCompanyProfile({ schema_version: 1, id: "surtec", display_name: "SURTEC Labs", mission: "Build useful tools.", operating_principles: ["Keep it local."], active_objective_ids: [], last_reviewed_at: "2026-09-27" }, filePath);
    expect(readOrganizationSnapshot(filePath).company).toMatchObject({ display_name: "SURTEC Labs", active_objective_ids: ["obj-a"] });
    expect(() => upsertCompanyProfile({ schema_version: 1, id: "other" as "surtec", display_name: "Other", mission: null, operating_principles: [], active_objective_ids: [], last_reviewed_at: null }, filePath)).toThrow();
  });
});
