import { throws } from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createContextService } from "../dashboard/src/server/context-service";
import { createTask } from "../dashboard/src/server/dispatch";
import { createIssueService, IssueServiceError } from "../dashboard/src/server/issue-service";
import type { WorkIssue } from "../lib/issues/types";
import { readIssueDocument } from "../lib/state/issues";
import { issueStatePath } from "../lib/state/paths";
import { listTasks } from "../lib/state/store";
import { createRolePolicyFixture, roleFixtureAgent, roleFixtureProject, roleFixtureRole } from "./testing/role-policy-fixture";

const scopeGate = "issue needs exact-scope authorization or an approved rework decision before dispatch";
const approvalId = "synthetic-scope-approval";
const outcome = "Update the synthetic guide within the approved scope.";
const criteria = ["The guide explains the fixture's expected behavior."];

function createIssueFixture(policy: ReturnType<typeof createRolePolicyFixture>) {
  const context = createContextService(policy.root);
  const taskWriter = vi.fn(createTask);
  const issues = createIssueService(policy.root, { context, createTask: taskWriter });
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
  expect(proposed).toMatchObject({ status: "proposed", blocked_by_issue_ids: [], task_ids: [] });
  expect(listTasks()).toEqual([]);
  return { policy, issues, context, taskWriter, proposed };
}

type Fixture = ReturnType<typeof createIssueFixture>;

function withFixture(check: (fixture: Fixture) => void) {
  const policy = createRolePolicyFixture({ sandbox: "workspace-write", verify: ["node verify-fixture.mjs"] });
  try {
    for (const [name, value] of Object.entries(policy.environment)) vi.stubEnv(name, value);
    check(createIssueFixture(policy));
  } finally {
    vi.unstubAllEnvs();
    policy.dispose();
  }
}

function preview(fixture: Fixture, issue: WorkIssue) {
  return fixture.context.preview({
    kind: "issue",
    project: roleFixtureProject,
    agent: roleFixtureAgent,
    role_id: roleFixtureRole,
    issue_id: issue.id,
    expected_revision: issue.revision,
  });
}

function dispatch(fixture: Fixture, issue: WorkIssue, fingerprint: string) {
  return fixture.issues.dispatch(issue.id, issue.revision, roleFixtureAgent, {
    role_id: roleFixtureRole,
    preview_fingerprint: fingerprint,
  });
}

function expectUnchangedProposal(fixture: Fixture, check: () => void) {
  const path = issueStatePath(fixture.policy.state);
  const bytes = readFileSync(path);
  const inventory = readdirSync(fixture.policy.root, { recursive: true }).sort();
  try {
    check();
  } finally {
    expect(fixture.taskWriter).not.toHaveBeenCalled();
    expect(listTasks()).toEqual([]);
    expect(readdirSync(fixture.policy.root, { recursive: true }).sort()).toEqual(inventory);
    expect(readFileSync(path)).toEqual(bytes);
    const saved = readIssueDocument(path);
    expect(saved.issues[fixture.proposed.id]).toEqual(fixture.proposed);
    expect(saved.events.some((event) => ["scope-authorization-recorded", "execution-admitted"].includes(event.type))).toBe(false);
  }
}

describe("org.issue.required-approval", () => {
  it("blocks preview and dispatch of a proposed issue without scope approval", () => {
    withFixture((fixture) => {
      expectUnchangedProposal(fixture, () => {
        const blocked = preview(fixture, fixture.proposed);
        expect(blocked.allowed).toBe(false);
        expect(blocked.blocked_reasons).toContain("Issue requires exact-scope authorization or approved bounded rework");
        throws(() => dispatch(fixture, fixture.proposed, blocked.fingerprint),
          (error: unknown) => error instanceof IssueServiceError && error.status === 409 && error.message === scopeGate);
      });
    });
  });

  it("rejects a blank approval ID without admitting work", () => {
    withFixture((fixture) => {
      expectUnchangedProposal(fixture, () => {
        throws(() => fixture.issues.authorize(fixture.proposed.id, fixture.proposed.revision, " \t "),
          (error: unknown) => error instanceof IssueServiceError && error.status === 400
            && error.message === "approval_id is required and must be at most 100 characters");
      });
    });
  });

  it("records exact-scope approval before admitting one queued write task", () => {
    withFixture((fixture) => {
      const authorized = fixture.issues.authorize(fixture.proposed.id, fixture.proposed.revision, approvalId);
      expect(authorized).toMatchObject({
        status: "authorized",
        revision: fixture.proposed.revision + 1,
        scope_revision: fixture.proposed.scope_revision,
        authorized_scope: fixture.proposed.authorized_scope,
      });
      const allowed = preview(fixture, authorized);
      expect(allowed).toMatchObject({ allowed: true, manifest: { role_id: roleFixtureRole, sandbox: "workspace-write" } });

      const { taskId } = dispatch(fixture, authorized, allowed.fingerprint);
      expect(fixture.taskWriter).toHaveBeenCalledOnce();
      const tasks = listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        lifecycle: "queued", started_at: null, outcome: null,
        envelope: {
          id: taskId, project: roleFixtureProject, agent: roleFixtureAgent, sandbox: "workspace-write",
          context_manifest: { role_id: roleFixtureRole, fingerprint: allowed.fingerprint },
          context_admission: {
            schema_version: 1, kind: "issue", issue_id: authorized.id, issue_revision: authorized.revision,
            issue_status: "authorized", manifest_fingerprint: allowed.fingerprint,
          },
          metadata: {
            issue_id: authorized.id, issue_scope_revision: authorized.scope_revision,
            issue_authorized_scope: authorized.authorized_scope,
          },
        },
      });

      const saved = readIssueDocument(issueStatePath(fixture.policy.state));
      expect(saved.issues[authorized.id]).toMatchObject({ status: "working", task_ids: [taskId] });
      const gateEvents = saved.events.filter((event) => event.issue_id === authorized.id
        && ["scope-authorization-recorded", "execution-admitted"].includes(event.type));
      expect(gateEvents).toMatchObject([
        { type: "scope-authorization-recorded", scope_revision: authorized.scope_revision, payload: { approval_id: approvalId } },
        { type: "execution-admitted", scope_revision: authorized.scope_revision, payload: { task_id: taskId } },
      ]);
    });
  });
});
