import { throws } from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createContextService } from "../dashboard/src/server/context-service";
import { createIssueService, IssueServiceError } from "../dashboard/src/server/issue-service";
import { checkIssueTransition, ISSUE_STATUSES } from "../lib/organization/issue-lifecycle";
import { readIssueDocument } from "../lib/state/issues";
import { eventsDir, issueStatePath, tasksDir } from "../lib/state/paths";
import { listTasks } from "../lib/state/store";
import { createRolePolicyFixture, roleFixtureAgent, roleFixtureProject, roleFixtureRole } from "./testing/role-policy-fixture";

const approvalId = "synthetic-scope-approval";
const outcome = "Update the synthetic guide within its approved scope.";
const criteria = ["The guide describes the synthetic project's expected behavior."];
const now = () => new Date("2026-11-17T12:00:00.000Z");

function prepareIssue(root: string, state: string) {
  const context = createContextService(root);
  const issues = createIssueService(root, { context, now });
  const proposed = issues.create({
    project_id: roleFixtureProject,
    assigned_role_id: roleFixtureAgent,
    title: "Update the synthetic guide",
    expected_outcome: outcome,
    acceptance_criteria: criteria,
    authorized_scope: {
      expected_outcome: outcome,
      acceptance_criteria: criteria,
      allowed_path_patterns: ["docs/**"],
      excluded_path_patterns: [],
      allowed_change_categories: ["documentation"],
      explicit_exclusions: [],
    },
  });
  expect(proposed.status).toBe("proposed");
  return { context, issues, proposed, state, issuePath: issueStatePath(state) };
}

type IssueFixture = ReturnType<typeof prepareIssue>;

function withIssue(check: (fixture: IssueFixture) => void) {
  const fixture = createRolePolicyFixture({ sandbox: "workspace-write", verify: ["node verify-fixture.mjs"] });
  try {
    for (const [name, value] of Object.entries(fixture.environment)) vi.stubEnv(name, value);
    const inventory = readdirSync(fixture.checkout, { recursive: true }).sort();
    const primerPath = join(fixture.checkout, "AGENTS.md");
    const primer = readFileSync(primerPath);
    check(prepareIssue(fixture.root, fixture.state));
    expect(readdirSync(fixture.checkout, { recursive: true }).sort()).toEqual(inventory);
    expect(readFileSync(primerPath)).toEqual(primer);
  } finally {
    vi.unstubAllEnvs();
    fixture.dispose();
  }
}

function expectRejected({ issuePath, state }: IssueFixture, reason: string, action: () => unknown, relatedPaths: string[] = []) {
  const files = [issuePath, ...relatedPaths].map((path) => ({ path, bytes: readFileSync(path) }));
  const inventory = readdirSync(state, { recursive: true }).sort();
  throws(action, (error: unknown) => error instanceof IssueServiceError && error.status === 409
    && error.message === `issue transition rejected: ${reason}`);
  for (const { path, bytes } of files) expect(readFileSync(path)).toEqual(bytes);
  expect(readdirSync(state, { recursive: true }).sort()).toEqual(inventory);
}

describe("org.issue.invalid-transition", () => {
  it("persists one exact scope authorization at the current revision", () => {
    withIssue(({ issues, proposed, issuePath }) => {
      const authorized = issues.authorize(proposed.id, proposed.revision, approvalId);
      expect(authorized).toMatchObject({
        status: "authorized", revision: proposed.revision + 1,
        authorized_scope: proposed.authorized_scope, scope_revision: proposed.scope_revision,
      });
      const saved = readIssueDocument(issuePath);
      expect(saved.issues[proposed.id]).toEqual(authorized);
      expect(saved.events).toMatchObject([
        { issue_id: proposed.id, type: "issue-proposed" },
        {
          issue_id: proposed.id, type: "scope-authorization-recorded", scope_revision: proposed.scope_revision,
          payload: { approval_id: approvalId, scope_revision: proposed.scope_revision },
        },
      ]);
      expect(listTasks()).toEqual([]);
    });
  });

  it("rejects a stale revision on an otherwise allowed transition", () => {
    withIssue((fixture) => {
      const { issues, proposed, issuePath } = fixture;
      const staleRevision = proposed.revision - 1;
      expect(staleRevision).toBeGreaterThan(0);
      expectRejected(fixture, "stale-revision", () => issues.authorize(proposed.id, staleRevision, approvalId));
      const saved = readIssueDocument(issuePath);
      expect(saved.issues[proposed.id]).toEqual(proposed);
      expect(saved.events.map(({ type }) => type)).toEqual(["issue-proposed"]);
      expect(listTasks()).toEqual([]);
    });
  });

  it("rejects reauthorization at the resulting current revision", () => {
    withIssue((fixture) => {
      const { issues, proposed, issuePath } = fixture;
      const authorized = issues.authorize(proposed.id, proposed.revision, approvalId);
      expectRejected(fixture, "transition-not-allowed", () => issues.authorize(authorized.id, authorized.revision, "synthetic-second-approval"));
      const saved = readIssueDocument(issuePath);
      expect(saved.issues[authorized.id]).toEqual(authorized);
      expect(saved.events.filter(({ type }) => type === "scope-authorization-recorded")).toMatchObject([
        { issue_id: authorized.id, payload: { approval_id: approvalId } },
      ]);
      expect(listTasks()).toEqual([]);
    });
  });

  it("requires the authorization action for a proposed issue", () => {
    withIssue((fixture) => {
      const { issues, proposed, issuePath } = fixture;
      const rationale = "Synthetic decision rationale.";
      expectRejected(fixture, "transition-not-allowed", () => issues.resumeBlocked(proposed.id, proposed.revision, rationale));
      expectRejected(fixture, "transition-not-allowed", () => issues.resolveDecision(proposed.id, proposed.revision, approvalId, rationale));
      expectRejected(fixture, "stale-revision", () => issues.resumeBlocked(proposed.id, proposed.revision - 1, rationale));

      const authorized = issues.authorize(proposed.id, proposed.revision, approvalId);
      expect(authorized).toMatchObject({ status: "authorized", revision: proposed.revision + 1, scope_revision: proposed.scope_revision, authorized_scope: proposed.authorized_scope });
      const saved = readIssueDocument(issuePath);
      expect(saved.issues[proposed.id]).toEqual(authorized);
      expect(saved.events.map(({ type }) => type)).toEqual(["issue-proposed", "scope-authorization-recorded"]);
      expect(saved.events.at(-1)?.payload).toEqual({ approval_id: approvalId, scope_revision: proposed.scope_revision });
      expect(listTasks()).toEqual([]);
    });
  });

  it("preserves the working issue and its queued task after forbidden decision resolution", () => {
    withIssue((fixture) => {
      const { context, issues, proposed, issuePath, state } = fixture;
      const authorized = issues.authorize(proposed.id, proposed.revision, approvalId);
      const preview = context.preview({
        kind: "issue", project: roleFixtureProject, agent: roleFixtureAgent, role_id: roleFixtureRole,
        issue_id: authorized.id, expected_revision: authorized.revision,
      });
      expect(preview.allowed).toBe(true);
      const { issue: working, taskId } = issues.dispatch(authorized.id, authorized.revision, roleFixtureAgent, {
        role_id: roleFixtureRole, preview_fingerprint: preview.fingerprint,
      });
      expect(working).toMatchObject({ status: "working", task_ids: [taskId], scope_revision: authorized.scope_revision });
      expect(listTasks()).toMatchObject([{ envelope: { id: taskId }, lifecycle: "queued" }]);

      expectRejected(fixture, "transition-not-allowed",
        () => issues.resolveDecision(working.id, working.revision, approvalId, "Synthetic same-scope decision."),
        [join(tasksDir(state), `${taskId}.json`), join(eventsDir(state), `${taskId}.jsonl`)]);
      const saved = readIssueDocument(issuePath);
      expect(saved.issues[working.id]).toEqual(working);
      expect(saved.events.map(({ type }) => type)).toEqual(["issue-proposed", "scope-authorization-recorded", "execution-admitted"]);
      expect(Object.values(saved.evidence)).toMatchObject([{ kind: "task", issue_id: working.id, task_id: taskId }]);
      expect(listTasks()).toMatchObject([{ envelope: { id: taskId }, lifecycle: "queued" }]);
    });
  });

  it.each(["done", "cancelled"] as const)("keeps every destination closed from terminal %s", (status) => {
    const revision = 4;
    const current = { status, revision, seen_event_ids: new Set(["synthetic-prior-event"]) };
    const before = structuredClone(current);
    for (const to of ISSUE_STATUSES) {
      const event = { event_id: `synthetic-transition-to-${to}`, from: status, to, expected_revision: revision };
      expect(checkIssueTransition(current, event), `${status} to ${to}`).toEqual({ accepted: false, reason: "transition-not-allowed" });
      expect(current).toEqual(before);
    }
  });
});
