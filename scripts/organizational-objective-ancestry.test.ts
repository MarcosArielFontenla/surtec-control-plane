import { throws } from "node:assert/strict";
import { describe, expect, it } from "vitest";
import type { OrganizationDocument } from "../lib/organization";
import { OrganizationStateError, readOrganizationDocument } from "../lib/state/organization";
import { validateOrganizationDocument } from "../lib/state/validation";
import { verifySavedDocumentFixture } from "./testing/saved-document-fixture";

function objective(level: number): OrganizationDocument["objectives"][string] {
  return {
    schema_version: 1,
    id: `objective-${level}`,
    company_id: "surtec",
    title: `Synthetic objective ${level}`,
    desired_outcome: "Measure a synthetic outcome.",
    success_criteria: ["Record the fixture result."],
    status: "draft",
    horizon: "quarter",
    priority: 3,
    target_date: null,
    parent_objective_id: level === 1 ? null : `objective-${level - 1}`,
    owner: "marcos",
    last_reviewed_at: null,
  };
}

function validDocument(): OrganizationDocument {
  const chain = Array.from({ length: 8 }, (_, index) => objective(index + 1));
  return {
    schema_version: 1,
    company: {
      schema_version: 1,
      id: "surtec",
      display_name: "Synthetic organization",
      mission: null,
      operating_principles: [],
      active_objective_ids: [],
      last_reviewed_at: null,
    },
    objectives: Object.fromEntries(chain.map((entry) => [entry.id, entry])),
    project_objectives: {},
  };
}

function verifySavedDocument(document: OrganizationDocument, check: (path: string) => void) {
  const bytes = Buffer.from(JSON.stringify(document));
  expect(validateOrganizationDocument(JSON.parse(bytes.toString("utf8"))), "fixture passes the aggregate schema").toBe(true);
  verifySavedDocumentFixture("organization.json", bytes, check);
}

describe("org.objective.ancestry", () => {
  it("accepts a saved eight-level chain without changing it", () => {
    const document = validDocument();
    verifySavedDocument(document, (path) => expect(readOrganizationDocument(path)).toEqual(document));
  });

  const cycle = "objective ancestry contains a cycle";
  it.each([
    ["missing parent", "missing-objective", "objective parent does not exist"],
    ["self-parent", "objective-1", cycle],
    ["multi-objective cycle", "objective-3", cycle],
  ])("rejects a saved %s for the expected ancestry reason", (_name, parentId, reason) => {
    const document = validDocument();
    document.objectives["objective-1"].parent_objective_id = parentId;
    verifySavedDocument(document, (path) => {
      throws(() => readOrganizationDocument(path),
        (error: unknown) => error instanceof OrganizationStateError && error.message === reason);
    });
  });

  it("rejects a saved ninth objective for exceeding the depth limit", () => {
    const document = validDocument();
    const ninth = objective(9);
    document.objectives[ninth.id] = ninth;
    verifySavedDocument(document, (path) => {
      throws(() => readOrganizationDocument(path),
        (error: unknown) => error instanceof OrganizationStateError && error.message === "objective ancestry exceeds 8 levels");
    });
  });
});
