import { throws } from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createContextService } from "../dashboard/src/server/context-service";
import { createIssueService, IssueServiceError } from "../dashboard/src/server/issue-service";
import { contextHash } from "../lib/context/assemble";
import { createTestingEvidence, sealTestingEvidence } from "../lib/context/testing-evidence";
import { readIssueDocument } from "../lib/state/issues";
import { issueStatePath, tasksDir } from "../lib/state/paths";
import { readTask, updateTask } from "../lib/state/store";
import { createRolePolicyFixture, roleFixtureAgent, roleFixtureProject, roleFixtureRole } from "./testing/role-policy-fixture";

const command = "node verify-fixture.mjs";
const executionId = "synthetic-evidence-run";
const outcome = "Update the synthetic guide within its approved scope.";
const criteria = ["The guide explains the expected behavior.", "The guide includes an example."];
const approvalId = "synthetic-completion-approval";
const rationale = "Confirmed every criterion against the exact candidate.";
type PolicyFixture = ReturnType<typeof createRolePolicyFixture>;

function prepareCandidate(policy: PolicyFixture) {
  const context = createContextService(policy.root);
  const issues = createIssueService(policy.root, { context });
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
  const issue = issues.authorize(proposed.id, proposed.revision, "synthetic-scope-approval");
  const preview = context.preview({
    kind: "issue", project: roleFixtureProject, agent: roleFixtureAgent, role_id: roleFixtureRole,
    issue_id: issue.id, expected_revision: issue.revision,
  });
  expect(preview.allowed).toBe(true);
  const { taskId } = issues.dispatch(issue.id, issue.revision, roleFixtureAgent, {
    role_id: roleFixtureRole, preview_fingerprint: preview.fingerprint,
  });
  expect(readTask(taskId)).toMatchObject({
    lifecycle: "queued",
    envelope: {
      sandbox: "workspace-write",
      context_manifest: { fingerprint: preview.fingerprint, testing: { mode: "functional", commands: [command] } },
      context_admission: {
        schema_version: 1, kind: "issue", issue_id: issue.id, issue_revision: issue.revision,
        manifest_fingerprint: preview.fingerprint,
      },
    },
  });
  const started = new Date();
  const startedAt = started.toISOString();
  updateTask(taskId, (task) => {
    if (!task.orchestration) throw new Error("The admitted fixture task has no orchestration record.");
    task.lifecycle = "running";
    task.started_at = startedAt;
    task.orchestration.attempts = 1;
    task.orchestration.lease = {
      run_id: executionId, worker_id: "synthetic-worker", acquired_at: startedAt,
      heartbeat_at: startedAt, expires_at: new Date(started.getTime() + 60_000).toISOString(),
    };
  });
  const candidate = issues.recordCandidate({
    issueId: issue.id, taskId, executionId, repositoryId: roleFixtureProject,
    baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40),
    scopeRevision: issue.scope_revision, changedPaths: ["docs/guide.md"],
  });
  expect(issues.get(issue.id).issue.status).toBe("checking");
  return { policy, issues, taskId, candidate, startedAt };
}

type CandidateFixture = ReturnType<typeof prepareCandidate>;

function withCandidate(check: (fixture: CandidateFixture) => void) {
  const policy = createRolePolicyFixture({ sandbox: "workspace-write", verify: [command] });
  try {
    for (const [name, value] of Object.entries(policy.environment)) vi.stubEnv(name, value);
    const inventory = readdirSync(policy.checkout, { recursive: true }).sort();
    const instructionsPath = join(policy.checkout, "AGENTS.md");
    const instructions = readFileSync(instructionsPath);
    check(prepareCandidate(policy));
    expect(readdirSync(policy.checkout, { recursive: true }).sort()).toEqual(inventory);
    expect(readFileSync(instructionsPath)).toEqual(instructions);
  } finally {
    vi.unstubAllEnvs();
    policy.dispose();
  }
}

function attachPassingReceipt({ taskId, candidate, startedAt }: CandidateFixture) {
  const task = readTask(taskId);
  if (!task) throw new Error("The candidate's fixture task is missing.");
  const { fingerprint: _fingerprint, ...receipt } = createTestingEvidence(task, executionId, {
    mode: "functional", runners: [{ stage: "functional", command }],
  });
  const cleanTree = contextHash("synthetic clean tree");
  const sealed = sealTestingEvidence({
    ...receipt,
    candidate: {
      id: candidate.id, base_revision: candidate.base_revision,
      candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint,
    },
    implementation: {
      started_at: startedAt, finished_at: startedAt, thread_id: "synthetic-thread", turn_id: "synthetic-turn",
    },
    observations: [{
      stage: "functional", command_fingerprint: contextHash(command), probe_fingerprint: null,
      assertions: [], outcome: "passed", exit_code: 0, started_at: startedAt, finished_at: startedAt,
      revision: candidate.candidate_revision, before_fingerprint: cleanTree, after_fingerprint: cleanTree,
    }],
  });
  updateTask(taskId, (record) => { record.testing_evidence = sealed; });
  return sealed.fingerprint;
}

function reportPassingStatusAndFinish({ issues, taskId, candidate }: CandidateFixture) {
  issues.recordVerification({
    issueId: candidate.issue_id, taskId, executionId, candidateId: candidate.id,
    status: "passed", label: "Reported fixture verification", reference: "Synthetic verification report.",
  });
  updateTask(taskId, (task) => {
    if (!task.orchestration) throw new Error("The running fixture task has no orchestration record.");
    task.lifecycle = "finished";
    task.outcome = "completed";
    task.finished_at = new Date().toISOString();
    task.orchestration.lease = null;
  });
  return issues.get(candidate.issue_id);
}

function acceptanceInput(fixture: CandidateFixture, expectedRevision: number) {
  return {
    expectedRevision, candidateId: fixture.candidate.id, fingerprint: fixture.candidate.diff_fingerprint,
    approvalId, rationale, confirmedCriteria: criteria,
  };
}

function candidateBinding({ candidate, taskId }: CandidateFixture) {
  return {
    task_id: taskId, execution_id: executionId, candidate_id: candidate.id,
    candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint,
    scope_revision: candidate.scope_revision,
  };
}

function expectDeniedAcceptance(fixture: CandidateFixture, revision: number, message: string) {
  const { policy, taskId, issues, candidate } = fixture;
  const issuePath = issueStatePath(policy.state);
  const taskPath = join(tasksDir(policy.state), `${taskId}.json`);
  const issueBytes = readFileSync(issuePath);
  const taskBytes = readFileSync(taskPath);
  const inventory = readdirSync(policy.state, { recursive: true }).sort();
  throws(
    () => issues.acceptCandidate(candidate.issue_id, { ...acceptanceInput(fixture, revision), acknowledgeEvidenceGaps: true }),
    (error: unknown) => error instanceof IssueServiceError && error.status === 409 && error.message === message,
  );
  expect(readFileSync(issuePath)).toEqual(issueBytes);
  expect(readFileSync(taskPath)).toEqual(taskBytes);
  expect(readdirSync(policy.state, { recursive: true }).sort()).toEqual(inventory);
  const saved = readIssueDocument(issuePath);
  expect(saved.events.some((event) => event.type === "candidate-accepted")).toBe(false);
  expect(Object.values(saved.evidence).some((entry) => entry.kind === "review")).toBe(false);
}

describe("org.issue.completion-evidence", () => {
  it("keeps reported success without a captured receipt out of review and completion", () => {
    withCandidate((fixture) => {
      const recorded = reportPassingStatusAndFinish(fixture);
      expect(recorded.issue.status).toBe("needs-decision");
      const verification = recorded.evidence.filter((entry) => entry.kind === "verification");
      expect(verification).toMatchObject([{ ...candidateBinding(fixture), status: "informational" }]);
      expect(verification[0]).not.toHaveProperty("testing_evidence_fingerprint");
      expectDeniedAcceptance(fixture, recorded.issue.revision, "issue is not ready for review or has changed");
    });
  });

  it("blocks acceptance when the captured receipt is lost after verification", () => {
    withCandidate((fixture) => {
      const fingerprint = attachPassingReceipt(fixture);
      const ready = reportPassingStatusAndFinish(fixture);
      expect(ready.issue.status).toBe("ready-for-review");
      expect(ready.evidence.filter((entry) => entry.kind === "verification")).toMatchObject([
        { ...candidateBinding(fixture), status: "passed", testing_evidence_fingerprint: fingerprint },
      ]);
      updateTask(fixture.taskId, (task) => { delete task.testing_evidence; });
      expectDeniedAcceptance(fixture, ready.issue.revision,
        "governed candidate requires exact captured testing evidence; evidence-gap acknowledgment cannot waive it");
    });
  });

  it("completes the issue with exact passing evidence and explicit acceptance", () => {
    withCandidate((fixture) => {
      const fingerprint = attachPassingReceipt(fixture);
      const ready = reportPassingStatusAndFinish(fixture);
      expect(ready.issue.status).toBe("ready-for-review");
      const done = fixture.issues.acceptCandidate(ready.issue.id, acceptanceInput(fixture, ready.issue.revision));
      expect(done).toMatchObject({ status: "done", revision: ready.issue.revision + 1 });

      const saved = readIssueDocument(issueStatePath(fixture.policy.state));
      expect(saved.issues[done.id]).toEqual(done);
      expect(Object.values(saved.evidence).filter((entry) => ["verification", "review"].includes(entry.kind))).toMatchObject([
        { ...candidateBinding(fixture), issue_id: done.id, kind: "verification", status: "passed", testing_evidence_fingerprint: fingerprint },
        { ...candidateBinding(fixture), issue_id: done.id, kind: "review", status: "passed", reference: `${approvalId}: ${rationale}` },
      ]);
      const events = saved.events.filter((event) => event.issue_id === done.id
        && ["verification-passed", "candidate-accepted"].includes(event.type));
      const { candidate } = fixture;
      const binding = {
        candidate_id: candidate.id, candidate_revision: candidate.candidate_revision,
        diff_fingerprint: candidate.diff_fingerprint, scope_revision: candidate.scope_revision,
      };
      expect(events).toMatchObject([
        { type: "verification-passed", payload: binding },
        {
          type: "candidate-accepted",
          payload: { ...binding, approval_id: approvalId, rationale, confirmed_criteria: criteria, evidence_gap_acknowledged: false },
        },
      ]);
    });
  });
});
