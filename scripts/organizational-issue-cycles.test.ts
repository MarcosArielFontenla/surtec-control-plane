import { throws } from "node:assert/strict";
import { describe, expect, it } from "vitest";
import type { IssueDocument, WorkIssue } from "../lib/issues/types";
import { IssueStateError, readIssueDocument } from "../lib/state/issues";
import { validateIssueDocument } from "../lib/state/validation";
import { verifySavedDocumentFixture } from "./testing/saved-document-fixture";

const a = "I-00000000-0000-4000-8000-000000000001";
const b = "I-00000000-0000-4000-8000-000000000002";
const c = "I-00000000-0000-4000-8000-000000000003";
const d = "I-00000000-0000-4000-8000-000000000004";
const timestamp = "2026-01-01T00:00:00.000Z";

function issue(id: string, parentId: string | null, blockers: string[]): WorkIssue {
  const outcome = "Record a synthetic issue relationship.";
  const criteria = ["Preserve the saved issue data."];
  return {
    schema_version: 1,
    id,
    project_id: "fixture",
    objective_id: null,
    parent_issue_id: parentId,
    title: "Synthetic issue",
    expected_outcome: outcome,
    acceptance_criteria: criteria,
    status: "proposed",
    work_scale: "trivial",
    classification_inputs: { affected_domains: ["docs"], requires_migration: false, security_impact: false },
    classification_rationale: ["Synthetic scope"],
    plan: [],
    authorized_scope: {
      expected_outcome: outcome,
      acceptance_criteria: criteria,
      allowed_path_patterns: ["docs/**"],
      excluded_path_patterns: [],
      allowed_change_categories: ["documentation"],
      explicit_exclusions: [],
    },
    scope_revision: 1,
    scope_changed_at: null,
    scope_change_approval_id: null,
    scope_change_proposal: null,
    priority: 10,
    criticality: "low",
    blocked_by_issue_ids: blockers,
    assigned_role_id: null,
    related_commitment_ids: [],
    external_references: [],
    next_action: null,
    task_ids: [],
    evidence_ids: [],
    candidate_ids: [],
    created_at: timestamp,
    updated_at: timestamp,
    revision: 1,
  };
}

function validDocument(): IssueDocument {
  return {
    schema_version: 1,
    issues: {
      [a]: issue(a, null, []),
      [b]: issue(b, a, [a]),
      [c]: issue(c, a, [a]),
      [d]: issue(d, b, [b, c]),
    },
    candidates: {},
    evidence: {},
    events: [],
  };
}

function verifySavedDocument(document: IssueDocument, check: (path: string) => void) {
  const bytes = Buffer.from(JSON.stringify(document));
  expect(validateIssueDocument(JSON.parse(bytes.toString("utf8"))), "fixture passes the aggregate schema").toBe(true);
  verifySavedDocumentFixture("issues.json", bytes, check);
}

function expectCycle(document: IssueDocument, message: string) {
  verifySavedDocument(document, (path) => {
    throws(() => readIssueDocument(path),
      (error: unknown) => error instanceof IssueStateError && error.message === message);
  });
}

describe("org.issue.cycles", () => {
  it("accepts the parent tree and the blocker diamond with a shared dependency", () => {
    const document = validDocument();
    verifySavedDocument(document, (path) => expect(readIssueDocument(path)).toEqual(document));
  });

  it.each([["self-loop", a], ["transitive cycle", d]])("rejects a parent %s", (_name, parentId) => {
    const document = validDocument();
    document.issues[a].parent_issue_id = parentId;
    expectCycle(document, "issue parent ancestry contains a cycle");
  });

  it.each([["self-loop", a], ["transitive cycle", d]])("rejects a blocker %s", (_name, blockerId) => {
    const document = validDocument();
    document.issues[a].blocked_by_issue_ids = [blockerId];
    expectCycle(document, "issue blocker graph contains a cycle");
  });
});
