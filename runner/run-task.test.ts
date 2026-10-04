import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { execFileSync } from "node:child_process";
import { managedGitArgs } from "../lib/security/managed-git.mjs";
import { localGitEnvironment } from "../lib/security/environment";
import { evidenceHash, testingEvidenceStatus } from "../lib/context/testing-evidence";
import type { AgentRoleRegistry, ContextAdmissionV2 } from "../lib/context/types";
import { createContextService } from "../dashboard/src/server/context-service";
import { createTask } from "../dashboard/src/server/dispatch";
import { createIssueService } from "../dashboard/src/server/issue-service";
import * as issueModule from "../dashboard/src/server/issue-service";
import * as contextModule from "../dashboard/src/server/context-service";
import { PolicyService } from "../lib/policy/service";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "../lib/state/types";
import type { AgentExecutor, AgentRunResult } from "./agent-executor";
import type { Tracer } from "../lib/observability/tracing";

vi.mock("./worktree", () => ({ createWorktree: vi.fn(), commitAndDiff: vi.fn() }));
vi.mock("./verify", async (original) => {
  const actual = await original<typeof import("./verify")>();
  return { ...actual, runVerification: vi.fn(), captureVerification: vi.fn(actual.captureVerification) };
});
import { createWorktree, commitAndDiff } from "./worktree";
import { captureVerification, runVerification } from "./verify";
import { runTask } from "./run-task";
import { readTask, writeTask } from "../lib/state/store";
import { updateTask } from "../lib/state/store";
import { defaultTaskOrchestration } from "../lib/state/orchestration";
import { readTaskEvents } from "../lib/state/events";
import { assembleContext, contextHash } from "../lib/context/assemble";
import { TaskOrchestrator } from "./task-orchestrator";

let root: string;
let repo: string;
let run: ReturnType<typeof vi.fn<AgentExecutor["run"]>>;
let executor: AgentExecutor;

function structuredReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "completed",
    summary: "ok",
    commands_run: [],
    tests_run: [],
    risks: [],
    blockers: [],
    next_steps: [],
    artifacts: [],
    ...overrides,
  };
}

function agentRun(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  const structuredOutput = structuredReport();
  return {
    finalText: JSON.stringify(structuredOutput),
    structuredOutput,
    threadId: "thread-1",
    turnId: "turn-1",
    usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1, totalTokens: 15 },
    ...overrides,
  };
}

function queuedRecord(): TaskRecord {
  return {
    envelope: {
      id: "T-1", source: "dashboard", project: "stock-control", task_type: "analysis",
      agent: "backend-engineer", title: "Analyze", instructions: "Review auth.",
      repo_path: repo, branch: "agent/T-1", sandbox: "read-only",
      expected_outputs: [], requires_human_approval: true, metadata: {},
    },
    lifecycle: "queued", outcome: null,
    created_at: "2026-05-29T10:00:00Z", started_at: null,
    updated_at: "2026-05-29T10:00:00Z", finished_at: null, result: null, logs_path: null,
  };
}

function writeRecord(): TaskRecord {
  const record = queuedRecord();
  record.envelope.sandbox = "workspace-write";
  record.envelope.task_type = "implementation";
  return record;
}
function workflowFixture(kind: ContextAdmissionV2["stage_kind"] = "review"): TaskRecord {
  const writer = kind === "implementation" || kind === "correction";
  const record = writer ? writeRecord() : queuedRecord();
  const role: Record<ContextAdmissionV2["stage_kind"], ContextAdmissionV2["role_id"]> = { analysis: "portfolio-analyst", planning: "planner", implementation: "software-engineer", correction: "software-engineer", review: "reviewer", qa: "qa-evaluator", operations: "operations-observer" };
  const budget = { max_attempts: 2, max_runtime_ms: 60_000, max_total_tokens: 10_000 };
  record.orchestration = { ...defaultTaskOrchestration(), ...budget };
  record.envelope.context_manifest = assembleContext({ schema_version: 1, project_id: record.envelope.project, agent_id: record.envelope.agent, task_kind: record.envelope.task_type, role_id: role[kind], sandbox: record.envelope.sandbox,
    tools: writer ? ["inspect", "edit-authorized-scope"] : ["inspect"], approval_rules: ["publication"], budget, limits: { max_lines: 500, max_bytes: 60_000, max_sources: 64 }, selected_categories: [], excluded_categories: ["confidential-notes"], omitted_sources: [],
    routing: { work_scale: "bounded", action: "direct", review_depth: "focused", qa_required: false, reasons: ["Synthetic fixture"], delegation: { admitted: false, executable: false, reasons: ["No runtime delegation"] } },
    testing: { mode: "functional", minimum_review_depth: "focused", runner_ids: [], commands: [], reasons: ["Functional default"], requires_red_evidence: false } },
    [{ id: "runtime/safety-v1", layer: "runtime-safety", source_type: "policy", text: "Synthetic safety", reason: "Fixture", sensitivity: "public" }]).manifest;
  const candidate = ["review", "qa", "correction"].includes(kind);
  record.envelope.context_admission = {
    schema_version: 2, kind: "workflow-stage", workflow_id: "workflow-1", stage_id: "stage-1", stage_generation: 1, stage_kind: kind, task_id: record.envelope.id,
    template_id: kind === "operations" ? "operations-investigation" : kind === "analysis" ? "analysis" : "implementation", template_version: 1, grant_id: "grant-1", authority_revision: 1,
    role_id: role[kind], issue_id: "issue-1", issue_revision: 3, scope_revision: 2, scope_fingerprint: contextHash("Synthetic scope"),
    approved_plan: writer ? { stage_id: "planner-1", output_fingerprint: "a".repeat(64), decision_id: "decision-1" } : null,
    predecessor_stage_id: writer || candidate ? "predecessor-1" : null, handoff_id: writer || candidate ? "handoff-1" : null,
    candidate: candidate ? { candidate_id: "candidate-1", issue_id: "issue-1", repository_id: record.envelope.project, task_id: "engineer-task", execution_id: "engineer-run", scope_revision: 2, base_revision: "a".repeat(40), candidate_revision: "b".repeat(40), changed_paths: ["src/fixture.ts"], diff_fingerprint: "c".repeat(64), content_fingerprint: "d".repeat(64), testing_evidence_fingerprint: "e".repeat(64) } : null,
    manifest_fingerprint: record.envelope.context_manifest.fingerprint, instructions_length: record.envelope.instructions.length, instructions_hash: contextHash(record.envelope.instructions),
  };
  return record;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-runtask-"));
  repo = join(root, "stock-control");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(
    join(root, "registry", "agents.yml"),
    "agents:\n  - id: backend-engineer\n    name: Backend Engineer\n    type: engineering\n    description: Implements backend.\n    default_sandbox: workspace-write\n    allowed_task_types: [bugfix]\n    requires_human_approval_for: [merge]\n",
    "utf8",
  );
  writeFileSync(
    join(root, "registry", "projects.yml"),
    "projects:\n  stock-control:\n    allowed_agents: [backend-engineer]\n    sandbox:\n      default: workspace-write\n    commands:\n      test: pnpm test\n",
    "utf8",
  );
  writeFileSync(join(root, "AGENTS.md"), "ROOT RULE: do not deploy.\n", "utf8");
  process.env.SURTEC_STATE_DIR = join(root, "state");
  process.env.SURTEC_PROJECTS_ROOT = root;
  run = vi.fn<AgentExecutor["run"]>();
  run.mockResolvedValue(agentRun());
  executor = { run };
  vi.mocked(createWorktree).mockReset();
  vi.mocked(commitAndDiff).mockReset();
  vi.mocked(runVerification).mockReset();
  vi.mocked(captureVerification).mockClear();
  vi.mocked(runVerification).mockReturnValue({ status: "passed", checks: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.SURTEC_STATE_DIR;
  delete process.env.SURTEC_PROJECTS_ROOT;
  rmSync(root, { recursive: true, force: true });
});

describe("runTask", () => {
  it.each(["analysis", "planning", "implementation", "review", "qa", "operations", "correction"] as const)("denies standalone v2 %s before context, issue, policy, worktree, commit, verification or model effects", async (kind) => {
    const context = vi.spyOn(contextModule, "createContextService"), issues = vi.spyOn(issueModule, "createIssueService"), policy = vi.spyOn(PolicyService.prototype, "authorizeTask");
    const record = workflowFixture(kind); writeTask(record);
    const completion = await runTask("T-1", root, executor);
    expect(completion).toMatchObject({ outcome: "needs-review", retryable: false, stale: false, reason: expect.stringContaining("trusted workflow controller") });
    for (const effect of [context, issues, policy, run, createWorktree, commitAndDiff, runVerification, captureVerification]) expect(effect).not.toHaveBeenCalled();
    const saved = readTask("T-1")!;
    expect(saved).toMatchObject({ lifecycle: "finished", outcome: "needs-review", orchestration: { lease: null, attempts: 1, cumulative_tokens: 0, last_failure: { kind: "terminal" } } });
    expect(saved.envelope.context_admission).toEqual(record.envelope.context_admission);
    expect(saved.envelope.context_manifest).toEqual(record.envelope.context_manifest);
    expect(saved.testing_evidence).toBeUndefined(); expect(saved.envelope.metadata.run ?? {}).not.toHaveProperty("worktree_path");
    expect(readTaskEvents("T-1").map((event) => event.type)).toEqual(["claimed", "started", "needs-review"]);
    expect(existsSync(join(root, "state/issues"))).toBe(false); expect(existsSync(join(root, "state/workflows"))).toBe(false);
  });
  it.each(["implementation", "correction"] as const)("does not turn ordinary retry of a held v2 %s stage into v1 or a resumed model thread", async (kind) => {
    const record = workflowFixture(kind); record.envelope.metadata.run = { thread_id: "legacy-engineer-thread" }; writeTask(record);
    await runTask("T-1", root, executor);
    const scheduler = new TaskOrchestrator({ repoRoot: root, executor });
    const before = readFileSync(join(root, "state/tasks/T-1.json"));
    expect(() => scheduler.retry("T-1")).toThrow(/current controller/);
    expect(await runTask("T-1", root, executor)).toBeNull();
    expect(readFileSync(join(root, "state/tasks/T-1.json"))).toEqual(before);
    expect(readTask("T-1")!.orchestration).toMatchObject({ attempts: 1, cumulative_tokens: 0 });
    expect(readTask("T-1")!.envelope.context_admission).toEqual(record.envelope.context_admission);
    expect(() => scheduler.retry("T-1")).toThrow(/current controller/);
    for (const effect of [run, createWorktree, commitAndDiff, runVerification, captureVerification]) expect(effect).not.toHaveBeenCalled();
  });
  it("also denies the valid Planner analysis variant without invoking legacy context assembly", async () => {
    const record = workflowFixture("analysis");
    const { fingerprint: _fingerprint, ...unsigned } = record.envelope.context_manifest!;
    const manifest = { ...unsigned, role_id: "planner" };
    record.envelope.context_manifest = { ...manifest, fingerprint: contextHash(JSON.stringify(manifest)) };
    const binding = record.envelope.context_admission as ContextAdmissionV2; binding.role_id = "planner"; binding.manifest_fingerprint = record.envelope.context_manifest.fingerprint;
    writeTask(record); const context = vi.spyOn(contextModule, "createContextService");
    expect(await runTask("T-1", root, executor)).toMatchObject({ outcome: "needs-review", retryable: false });
    expect(context).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(createWorktree).not.toHaveBeenCalled();
  });
  it("cannot enable a workflow stage with injected caller flags or controller-shaped metadata", async () => {
    const record = workflowFixture("review");
    record.envelope.metadata.run = { workflow_controller: true, workflow_task_id: record.envelope.id, workflow_stage_id: "stage-1", workflow_generation: 1 };
    writeTask(record);
    expect(await runTask("T-1", root, executor, { workflowExecution: { owner: true, taskId: "T-1", runId: "forged" }, workflowController: true, permit: { workflow_id: "workflow-1", stage_id: "stage-1" } } as any))
      .toMatchObject({ outcome: "needs-review", retryable: false, stale: false });
    for (const effect of [run, createWorktree, commitAndDiff, runVerification, captureVerification]) expect(effect).not.toHaveBeenCalled();
    expect(existsSync(join(root, "state/workflows"))).toBe(false); expect(readTask("T-1")!.testing_evidence).toBeUndefined();
  });
  it("holds the exact stage after expired-lease recovery and rejects stale run identity without effects", async () => {
    const record = workflowFixture(); record.lifecycle = "running"; record.orchestration!.attempts = 1;
    record.orchestration!.lease = { run_id: "old-stage-run", worker_id: "fixture", acquired_at: "2026-01-01T00:00:00Z", heartbeat_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-01T00:00:01Z" }; writeTask(record);
    const scheduler = new TaskOrchestrator({ repoRoot: root, executor });
    expect(scheduler.recoverExpiredLeases()).toBe(1);
    const path = join(root, "state/tasks/T-1.json"), recovered = readFileSync(path);
    expect(await runTask("T-1", root, executor, { runId: "old-stage-run" })).toBeNull(); expect(readFileSync(path)).toEqual(recovered);
    expect(await runTask("T-1", root, executor)).toMatchObject({ outcome: "needs-review", retryable: false });
    expect(readTask("T-1")!.envelope.context_admission).toEqual(record.envelope.context_admission);
    for (const effect of [run, createWorktree, commitAndDiff, runVerification, captureVerification]) expect(effect).not.toHaveBeenCalled();
  });
  it("holds a scheduler-owned valid v2 lease and fences expired ownership without changing its bytes", async () => {
    const record = workflowFixture("correction"); record.lifecycle = "running"; record.orchestration!.attempts = 1;
    record.orchestration!.lease = { run_id: "stage-run", worker_id: "fixture", acquired_at: "2026-01-01T00:00:00Z", heartbeat_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-01T00:00:01Z" }; writeTask(record);
    const path = join(root, "state/tasks/T-1.json"), before = readFileSync(path);
    expect(await runTask("T-1", root, executor, { runId: "stage-run" })).toMatchObject({ stale: true }); expect(readFileSync(path)).toEqual(before);
    updateTask("T-1", (task) => { task.orchestration!.lease!.expires_at = new Date(Date.now() + 60_000).toISOString(); });
    expect(await runTask("T-1", root, executor, { runId: "stage-run" })).toMatchObject({ outcome: "needs-review", retryable: false });
    for (const effect of [run, createWorktree, commitAndDiff, runVerification, captureVerification]) expect(effect).not.toHaveBeenCalled();
  });
  it.each(["future", "missing", "legacy-metadata"])("rejects corrupt v2 %s before claim and preserves task bytes", async (invalid) => {
    const record = workflowFixture(); writeTask(record);
    if (invalid === "future") Object.assign(record.envelope.context_admission!, { schema_version: 99 });
    else if (invalid === "missing") delete (record.envelope.context_admission as unknown as Record<string, unknown>).grant_id;
    else record.envelope.metadata = { issue_id: "issue-1", issue_scope_revision: 2, issue_authorized_scope: {} };
    const path = join(root, "state/tasks/T-1.json"); writeFileSync(path, JSON.stringify(record)); const before = readFileSync(path);
    await expect(runTask("T-1", root, executor)).rejects.toThrow(/invalid task record/); expect(readFileSync(path)).toEqual(before);
    expect(readTaskEvents("T-1")).toEqual([]);
    for (const effect of [run, createWorktree, commitAndDiff, runVerification, captureVerification]) expect(effect).not.toHaveBeenCalled();
  });
  function contextFixture() {
    for (const name of ["agents.yml", "agent-roles.yml", "context-policy.yml"]) cpSync(`registry/${name}`, join(root, "registry", name));
    const roles = parse(readFileSync("registry/agent-roles.yml", "utf8")) as AgentRoleRegistry;
    for (const path of new Set(roles.roles.flatMap((role) => role.required_evaluation_ids))) {
      mkdirSync(join(root, ...path.split("/").slice(0, -1)), { recursive: true }); cpSync(path, join(root, path));
    }
    writeFileSync(join(repo, "AGENTS.md"), "SELECTED PROJECT RULE: do not publish.\n");
    return createContextService(root);
  }
  function analysisFixture() {
    const context = contextFixture();
    const preview = context.preview({ kind: "analysis", project: "stock-control", agent: "backend-engineer", role_id: "software-engineer", instructions: "Inspect fixture." });
    return createTask({ project: "stock-control", agent: "backend-engineer", role_id: "software-engineer", instructions: "Inspect fixture.", preview_fingerprint: preview.fingerprint }, root, undefined, { context }).id;
  }
  async function testingFixture(strict = false, initialValue = 0, verify = true, refactor = false) {
    contextFixture();
    const source = `import {readFileSync} from 'node:fs'; const ok=JSON.parse(readFileSync('src/value.json','utf8')).value===1; console.log(JSON.stringify({schema_version:1,assertions:[{id:'behavior',status:ok?'passed':'assertion-failed'}]})); process.exit(ok?0:1);`;
    mkdirSync(join(repo, "src")); writeFileSync(join(repo, "src/value.json"), JSON.stringify({ value: initialValue })); writeFileSync(join(repo, "verify.mjs"), source);
    if (refactor) writeFileSync(join(repo, "refactor.mjs"), "process.exit(0)");
    writeFileSync(join(root, "registry/projects.yml"), `projects:\n  stock-control:\n    allowed_agents: [backend-engineer]\n    sandbox: { default: workspace-write }\n    verify: ['node ${verify ? "verify" : "missing"}.mjs'${refactor ? ", 'node refactor.mjs'" : ""}]\n`);
    if (strict) {
      const config = parse(readFileSync(join(root, "registry/context-policy.yml"), "utf8"));
      const probe = { sources: [{ path: "verify.mjs", sha256: evidenceHash(source) }], assertion_ids: ["behavior"] };
      config.runners = { red: { command: "node verify.mjs", stage: "red", probe }, green: { command: "node verify.mjs", stage: "green", probe } };
      config.testing.global = { mode: "strict-tdd", minimum_review_depth: "full", runner_ids: ["red", "green"] };
      if (refactor) { config.runners.refactor = { stage: "refactor", command: "node refactor.mjs" }; config.testing.global.runner_ids.push("refactor"); }
      else config.testing.no_refactor_justification = "Only a bounded behavior value changes; no structural refactoring is required.";
      writeFileSync(join(root, "registry/context-policy.yml"), stringify(config));
    }
    const git = (args: string[]) => execFileSync("git", managedGitArgs(["-C", repo, ...args], root), { env: localGitEnvironment(), windowsHide: true });
    git(["init", "--quiet"]); git(["config", "user.name", "Synthetic"]); git(["config", "user.email", "fixture@example.test"]); git(["add", "."]); git(["commit", "--quiet", "-m", "base"]);
    const real = await vi.importActual<typeof import("./worktree")>("./worktree");
    vi.mocked(createWorktree).mockImplementation(real.createWorktree); vi.mocked(commitAndDiff).mockImplementation(real.commitAndDiff);
    const context = createContextService(root), issues = createIssueService(root, { context, projectIds: () => ["stock-control"] });
    const proposed = issues.create({ project_id: "stock-control", title: "Fixture behavior fix", expected_outcome: "Behavior is 1", acceptance_criteria: ["Behavior assertion passes"], criticality: "low", assigned_role_id: "backend-engineer", authorized_scope: { expected_outcome: "Behavior is 1", acceptance_criteria: ["Behavior assertion passes"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["implementation"], explicit_exclusions: [] } });
    const issue = issues.authorize(proposed.id, proposed.revision, "Synthetic human scope approval");
    const preview = context.preview({ kind: "issue", project: "stock-control", agent: "backend-engineer", role_id: "software-engineer", issue_id: issue.id, expected_revision: issue.revision });
    const { taskId } = issues.dispatch(issue.id, issue.revision, "backend-engineer", { role_id: "software-engineer", preview_fingerprint: preview.fingerprint });
    return { taskId, issues, issue };
  }
  it.each([{ strict: false, refactor: false }, { strict: true, refactor: false }, { strict: true, refactor: true }])("captures ordered evidence with real isolated Git and one fake turn strict=$strict refactor=$refactor", async ({ strict, refactor }) => {
    const { taskId, issues, issue } = await testingFixture(strict, 0, true, refactor);
    run.mockImplementation(async (input) => {
      if (strict) {
        const pre = readTask(taskId)!.testing_evidence!;
        expect(pre.observations.map((entry) => entry.outcome)).toEqual(["assertion-failed"]); expect(pre.implementation).toBeNull(); expect(pre.candidate).toBeNull();
      }
      writeFileSync(join(input.cwd, "src/value.json"), JSON.stringify({ value: 1 }));
      return agentRun({ structuredOutput: structuredReport({ tests_run: ["Narrative is not receipt evidence"] }) });
    });
    await runTask(taskId, root, executor);
    const task = readTask(taskId)!;
    expect(task.outcome).toBe("completed"); expect(run).toHaveBeenCalledOnce(); expect(runVerification).not.toHaveBeenCalled();
    expect(testingEvidenceStatus(task.testing_evidence!)).toBe("passed");
    if (refactor) expect(task.testing_evidence!.observations.map((entry) => entry.stage)).toEqual(["red", "green", "refactor"]);
    const lineage = issues.get(issue.id), candidate = lineage.candidates.at(-1)!;
    expect(lineage.issue.status).toBe("ready-for-review");
    expect(lineage.evidence.some((entry) => entry.kind === "verification" && entry.testing_evidence_fingerprint === task.testing_evidence!.fingerprint && entry.status === "passed")).toBe(true);
    expect(issues.acceptCandidate(issue.id, { expectedRevision: lineage.issue.revision, candidateId: candidate.id, fingerprint: candidate.diff_fingerprint, approvalId: "Synthetic acceptance", rationale: "Verified exact behavior and candidate", confirmedCriteria: issue.acceptance_criteria }).status).toBe("done");
  }, 20_000);
  it.each(["failed", "missing"])("does not promote an agent success claim over %s functional verification", async (failure) => {
    const { taskId, issues, issue } = await testingFixture(false, 0, failure !== "missing");
    run.mockImplementation(async (input) => { writeFileSync(join(input.cwd, "src/value.json"), JSON.stringify({ value: failure === "failed" ? 2 : 1 })); return agentRun({ structuredOutput: structuredReport({ tests_run: ["Everything passed according to the model"] }) }); });
    await runTask(taskId, root, executor);
    expect(readTask(taskId)!.outcome).toBe("needs-review"); expect(issues.get(issue.id).issue.status).toBe("needs-decision");
    expect(issues.get(issue.id).evidence.filter((entry) => entry.kind === "verification").every((entry) => entry.status !== "passed")).toBe(true);
  }, 20_000);
  it("blocks a non-failing RED before the implementation turn and preserves captured failure evidence", async () => {
    const { taskId, issues, issue } = await testingFixture(true, 1);
    await runTask(taskId, root, executor);
    expect(run).not.toHaveBeenCalled(); expect(commitAndDiff).not.toHaveBeenCalled();
    expect(readTask(taskId)!.outcome).toBe("needs-review"); expect(readTask(taskId)!.testing_evidence!.candidate).toBeNull();
    expect(issues.get(issue.id).issue.status).toBe("blocked");
  }, 20_000);
  it("rejects a changed pinned probe before any worktree or model effects", async () => {
    const { taskId } = await testingFixture(true);
    writeFileSync(join(repo, "verify.mjs"), "operator source drift");
    await runTask(taskId, root, executor);
    expect(run).not.toHaveBeenCalled(); expect(createWorktree).not.toHaveBeenCalled(); expect(readTask(taskId)!.outcome).toBe("needs-review");
  }, 20_000);
  it.each(["commands", "testing"])("does not verify or promote a candidate after current %s policy is revoked during the fake turn", async (change) => {
    const { taskId, issues, issue } = await testingFixture();
    run.mockImplementation(async (input) => {
      writeFileSync(join(input.cwd, "src/value.json"), JSON.stringify({ value: 1 }));
      if (change === "commands") writeFileSync(join(root, "registry/projects.yml"), "projects:\n  stock-control:\n    allowed_agents: [backend-engineer]\n    sandbox: { default: workspace-write }\n    verify: ['node revoked.mjs']\n");
      else {
        const config = parse(readFileSync(join(root, "registry/context-policy.yml"), "utf8")); config.testing.global.minimum_review_depth = "full";
        writeFileSync(join(root, "registry/context-policy.yml"), stringify(config));
      }
      return agentRun();
    });
    await runTask(taskId, root, executor);
    expect(readTask(taskId)!.outcome).toBe("needs-review"); expect(readTask(taskId)!.testing_evidence!.observations).toEqual([]);
    expect(issues.get(issue.id).issue.status).toBe("needs-decision");
  }, 20_000);
  it("routes recovery of an interrupted unverified candidate to the existing decision path without a new model turn", async () => {
    const { taskId, issues, issue } = await testingFixture();
    updateTask(taskId, (task) => {
      const at = new Date().toISOString(); task.lifecycle = "running"; task.orchestration!.attempts = 1;
      task.orchestration!.lease = { run_id: "interrupted-run", worker_id: "fixture", acquired_at: at, heartbeat_at: at, expires_at: new Date(Date.now() + 60_000).toISOString() };
    });
    const candidate = issues.recordCandidate({ issueId: issue.id, taskId, executionId: "interrupted-run", repositoryId: "stock-control", baseRevision: "a".repeat(40), candidateRevision: "b".repeat(40), changedPaths: ["src/value.json"], scopeRevision: issue.scope_revision });
    updateTask(taskId, (task) => { task.lifecycle = "queued"; task.orchestration!.lease = null; });
    await runTask(taskId, root, executor);
    expect(run).not.toHaveBeenCalled(); expect(createWorktree).not.toHaveBeenCalled(); expect(commitAndDiff).not.toHaveBeenCalled();
    expect(readTask(taskId)!.outcome).toBe("needs-review"); expect(readTask(taskId)!.testing_evidence).toBeUndefined();
    const decision = issues.get(issue.id); expect(decision.issue.status).toBe("needs-decision");
    expect(decision.candidates.find((entry) => entry.id === candidate.id)?.invalidated_at).toBeNull();
    expect(issues.resolveDecision(issue.id, decision.issue.revision, "Synthetic recovery decision", "Explicitly regenerate preview and admit a new task").status).toBe("authorized");
  }, 20_000);
  it("executes current admitted project context rather than the control plane root primer", async () => {
    const id = analysisFixture();
    await runTask(id, root, executor);
    expect(readTask(id)?.outcome).toBe("completed"); expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0].developerInstructions).toContain("SELECTED PROJECT RULE");
    expect(run.mock.calls[0][0].developerInstructions).not.toContain("ROOT RULE");
    expect(run.mock.calls[0][0].contextFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(readTaskEvents(id).some((event) => event.payload.boundary === "execution-context")).toBe(true);
  });
  it("fences an expired governed lease before any model or worktree effect", async () => {
    const id = analysisFixture();
    updateTask(id, (task) => {
      task.lifecycle = "running"; task.orchestration!.attempts = 1;
      task.orchestration!.lease = { run_id: "expired-run", worker_id: "fixture", acquired_at: "2026-01-01T00:00:00.000Z", heartbeat_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-01T00:00:01.000Z" };
    });
    expect(await runTask(id, root, executor, { runId: "expired-run" })).toMatchObject({ stale: true });
    expect(run).not.toHaveBeenCalled(); expect(createWorktree).not.toHaveBeenCalled(); expect(readTask(id)!.lifecycle).toBe("running");
  });
  it("revalidates each attempt and resumes only its unchanged persisted contract", async () => {
    const id = analysisFixture(); await runTask(id, root, executor);
    updateTask(id, (record) => { record.lifecycle = "queued"; record.outcome = null; record.finished_at = null; });
    await runTask(id, root, executor);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0]).toMatchObject({ threadId: "thread-1", resumeContextFingerprint: run.mock.calls[0][0].contextFingerprint });
  });
  it.each(["source", "thread"])("holds changed governed %s contracts before any model or worktree effects", async (changed) => {
    const id = analysisFixture();
    if (changed === "source") writeFileSync(join(repo, "AGENTS.md"), "Changed required project source");
    else updateTask(id, (record) => { record.envelope.metadata.run = { thread_id: "unbound-thread" }; });
    await runTask(id, root, executor);
    expect(readTask(id)?.outcome).toBe("needs-review"); expect(run).not.toHaveBeenCalled(); expect(createWorktree).not.toHaveBeenCalled();
  });
  it.each([false, true])("executes current governed issues or exposes explicit blocked recovery when context changed=%s", async (changed) => {
    const context = contextFixture(); const issues = createIssueService(root, { context, projectIds: () => ["stock-control"] });
    const proposed = issues.create({ project_id: "stock-control", title: "Fixture fix", expected_outcome: "Fixture result", acceptance_criteria: ["Fixture passes"], criticality: "low", assigned_role_id: "backend-engineer", authorized_scope: { expected_outcome: "Fixture result", acceptance_criteria: ["Fixture passes"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["implementation"], explicit_exclusions: [] } });
    const issue = issues.authorize(proposed.id, proposed.revision, "Synthetic approval");
    const preview = context.preview({ kind: "issue", project: "stock-control", agent: "backend-engineer", role_id: "software-engineer", issue_id: issue.id, expected_revision: issue.revision });
    const { taskId } = issues.dispatch(issue.id, issue.revision, "backend-engineer", { role_id: "software-engineer", preview_fingerprint: preview.fingerprint });
    vi.mocked(createWorktree).mockReturnValue({ branch: "agent/fixture", worktreePath: repo });
    vi.mocked(commitAndDiff).mockReturnValue({ filesChanged: [], diffstat: "", committed: false, patch: "", patchTruncated: false });
    if (changed) writeFileSync(join(repo, "AGENTS.md"), "Changed required project context");
    await runTask(taskId, root, executor);
    if (changed) {
      expect(readTask(taskId)?.outcome).toBe("needs-review"); expect(run).not.toHaveBeenCalled(); expect(createWorktree).not.toHaveBeenCalled();
      const blocked = issues.get(issue.id).issue; expect(blocked.status).toBe("blocked");
      expect(issues.resumeBlocked(issue.id, blocked.revision, "Synthetic explicit decision to regenerate preview").status).toBe("authorized");
      return;
    }
    expect(readTask(taskId)?.outcome).toBe("needs-review"); expect(createWorktree).toHaveBeenCalledOnce();
    expect(testingEvidenceStatus(readTask(taskId)!.testing_evidence!)).toBe("incomplete");
    expect(run.mock.calls[0][0].mode).toBe("workspace-write-verify"); expect(run.mock.calls[0][0].developerInstructions).toContain("issue/authorized-work");
  });
  it.each(["read-only", "workspace-write"] as const)("holds governed %s tasks for review before model, worktree or verification effects", async (sandbox) => {
    const record = sandbox === "read-only" ? queuedRecord() : writeRecord();
    const budget = { max_attempts: 2, max_runtime_ms: 60_000, max_total_tokens: 10_000 };
    record.orchestration = { ...defaultTaskOrchestration(), ...budget };
    record.envelope.context_manifest = assembleContext({ schema_version: 1, project_id: record.envelope.project, agent_id: record.envelope.agent, task_kind: record.envelope.task_type, role_id: "software-engineer", sandbox,
      tools: sandbox === "read-only" ? ["inspect"] : ["inspect", "edit-authorized-scope"], approval_rules: ["publication"], budget, limits: { max_lines: 500, max_bytes: 60_000, max_sources: 64 }, selected_categories: [], excluded_categories: ["confidential-notes"], omitted_sources: [],
      routing: { work_scale: "bounded", action: "direct", review_depth: "focused", qa_required: false, reasons: ["Synthetic fixture"], delegation: { admitted: false, executable: false, reasons: ["Unavailable"] } },
      testing: { mode: "functional", minimum_review_depth: "focused", runner_ids: [], commands: [], reasons: ["Functional default"], requires_red_evidence: false } },
      [{ id: "runtime/safety-v1", layer: "runtime-safety", source_type: "policy", text: "Synthetic safety", reason: "Fixture", sensitivity: "public" }]).manifest;
    writeTask(record); const completion = await runTask("T-1", root, executor);
    expect(completion).toMatchObject({ outcome: "needs-review", retryable: false });
    expect(run).not.toHaveBeenCalled(); expect(createWorktree).not.toHaveBeenCalled(); expect(commitAndDiff).not.toHaveBeenCalled(); expect(runVerification).not.toHaveBeenCalled();
    const saved = readTask("T-1")!;
    expect(saved.lifecycle).toBe("finished"); expect(saved.outcome).toBe("needs-review"); expect(saved.orchestration!.lease).toBeNull();
    expect(saved.envelope.context_manifest).toEqual(record.envelope.context_manifest);
    expect(saved.envelope.metadata.run ?? {}).not.toHaveProperty("thread_id");
    expect(readTaskEvents("T-1").at(-1)?.type).toBe("needs-review");
  });
  it("transitions queued to finished and passes root instructions plus the output schema", async () => {
    writeTask(queuedRecord());

    await runTask("T-1", root, executor);

    const record = readTask("T-1")!;
    expect(record.lifecycle).toBe("finished");
    expect(record.outcome).toBe("completed");
    expect(record.result?.summary).toBe("ok");
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0].developerInstructions).toContain("ROOT RULE: do not deploy.");
    expect(run.mock.calls[0][0].outputSchema).toMatchObject({ title: "AgentReport", additionalProperties: false });
  });

  it("marks a runtime failure with a blocker", async () => {
    writeTask(queuedRecord());
    run.mockRejectedValue(new Error("runtime exploded"));

    await runTask("T-1", root, executor);

    expect(readTask("T-1")?.result?.blockers).toEqual(["runtime exploded"]);
  });

  it("routes invalid structured output to needs-review", async () => {
    writeTask(queuedRecord());
    run.mockResolvedValue(agentRun({ structuredOutput: { status: "completed" }, finalText: "raw report" }));

    await runTask("T-1", root, executor);

    const record = readTask("T-1")!;
    expect(record.outcome).toBe("needs-review");
    expect(record.result?.risks[0]).toContain("Invalid agent report");
  });

  it("fails before execution when the repository path does not exist", async () => {
    const record = queuedRecord();
    record.envelope.repo_path = join(root, "does-not-exist");
    writeTask(record);

    await runTask("T-1", root, executor);

    expect(readTask("T-1")?.result?.blockers[0]).toContain("repository path does not match");
    expect(run).not.toHaveBeenCalled();
  });

  it("fails before execution when the agent id is unknown", async () => {
    const record = queuedRecord();
    record.envelope.agent = "ghost-agent";
    writeTask(record);

    await runTask("T-1", root, executor);

    expect(readTask("T-1")?.result?.blockers[0]).toContain("unknown agent");
    expect(run).not.toHaveBeenCalled();
  });

  it("creates a worktree, executes there, commits, verifies, and records protocol metadata", async () => {
    const record = writeRecord();
    record.envelope.self_verify = true;
    writeTask(record);
    const worktreePath = join(root, "worktree");
    vi.mocked(createWorktree).mockReturnValue({ branch: "agent/T-1-backend-engineer", worktreePath });
    vi.mocked(commitAndDiff).mockReturnValue({
      filesChanged: ["src/x.ts"], diffstat: "1 file changed", committed: true,
      patch: "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n", patchTruncated: false,
    });

    await runTask("T-1", root, executor);

    expect(run.mock.calls[0][0]).toMatchObject({ cwd: worktreePath, mode: "workspace-write-verify", verifyCommands: ["pnpm test"] });
    expect(commitAndDiff).toHaveBeenCalledWith(worktreePath, expect.any(String), undefined);
    expect(runVerification).toHaveBeenCalledWith(worktreePath, ["pnpm test"]);
    const finished = readTask("T-1")!;
    expect(finished.result?.files_changed).toEqual(["src/x.ts"]);
    expect(finished.envelope.metadata.run).toMatchObject({
      thread_id: "thread-1", turn_id: "turn-1", diff_path: expect.stringMatching(/\.diff$/), diff_truncated: false,
    });
    expect(readFileSync(join(root, (finished.envelope.metadata.run as { diff_path: string }).diff_path), "utf8")).toContain("+export const x");
  });

  it("uses plain write mode when self verification is not requested", async () => {
    writeTask(writeRecord());
    vi.mocked(createWorktree).mockReturnValue({ branch: "branch", worktreePath: join(root, "worktree") });
    vi.mocked(commitAndDiff).mockReturnValue({ filesChanged: [], diffstat: "", committed: false, patch: "", patchTruncated: false });

    await runTask("T-1", root, executor);

    expect(run.mock.calls[0][0].mode).toBe("workspace-write");
    expect(runVerification).not.toHaveBeenCalled();
  });

  it("fails cleanly when a write target is not a git repository", async () => {
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    writeTask(writeRecord());

    await runTask("T-1", root, executor);

    expect(readTask("T-1")?.result?.blockers[0]).toContain("contained local git checkout");
    expect(run).not.toHaveBeenCalled();
  });

  it("turns the five-minute runtime budget into a terminal failed task", async () => {
    vi.useFakeTimers();
    writeTask(queuedRecord());
    run.mockImplementation((_input, _events, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("interrupted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }));

    const pending = runTask("T-1", root, executor);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await pending;

    const finished = readTask("T-1")!;
    expect(finished.result?.blockers).toEqual(["runtime budget exhausted (300000ms)"]);
    expect(finished.orchestration?.last_failure?.kind).toBe("budget");
  });

  it("persists thread, turn, usage, and append-only lifecycle events", async () => {
    writeTask(queuedRecord());
    run.mockImplementation(async (_input, events) => {
      await events({ type: "thread-started", at: "2026-09-21T10:00:00Z", threadId: "thread-durable" });
      await events({ type: "turn-started", at: "2026-09-21T10:00:01Z", threadId: "thread-durable", turnId: "turn-durable" });
      await events({
        type: "approval", at: "2026-09-21T10:00:01Z", threadId: "thread-durable", turnId: "turn-durable",
        approval: "command", allowed: true, command: "printenv PRIVATE_TOKEN",
      });
      await events({ type: "warning", at: "2026-09-21T10:00:01Z", threadId: "thread-durable", turnId: "turn-durable", message: "runtime warning" });
      await events({
        type: "usage",
        at: "2026-09-21T10:00:02Z",
        threadId: "thread-durable",
        turnId: "turn-durable",
        usage: { inputTokens: 8, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 13 },
      });
      return agentRun({ threadId: "thread-durable", turnId: "turn-durable" });
    });

    await runTask("T-1", root, executor);

    const finished = readTask("T-1")!;
    expect(finished.envelope.metadata.run).toMatchObject({ thread_id: "thread-durable", turn_id: "turn-durable" });
    expect(finished.orchestration?.cumulative_tokens).toBe(15);
    const events = readTaskEvents("T-1");
    expect(events.map((event) => event.type)).toEqual([
      "claimed", "started", "policy-evaluated", "thread-started", "turn-started", "approval-recorded", "warning", "usage", "usage", "completed",
    ]);
    expect(events.find((event) => event.type === "approval-recorded")?.payload).toEqual({
      approval: "command", allowed: true, thread_id: "thread-durable", turn_id: "turn-durable",
    });
  });

  it("refuses a persisted legacy thread without an admitted context binding", async () => {
    const record = queuedRecord();
    record.envelope.metadata.run = { thread_id: "thread-existing" };
    writeTask(record);

    await runTask("T-1", root, executor);

    expect(run).not.toHaveBeenCalled();
    expect(readTask("T-1")?.outcome).toBe("needs-review");
  });
  it("refuses legacy second attempts even without a persisted thread", async () => {
    const record = queuedRecord(); record.orchestration = { ...defaultTaskOrchestration(), attempts: 1 };
    writeTask(record); await runTask("T-1", root, executor);
    expect(run).not.toHaveBeenCalled(); expect(readTask("T-1")?.outcome).toBe("needs-review");
  });

  it("delivers durable cancellation through the external abort signal", async () => {
    writeTask(queuedRecord());
    const controller = new AbortController();
    run.mockImplementation((_input, _events, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("interrupted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }));

    const pending = runTask("T-1", root, executor, { signal: controller.signal });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    updateTask("T-1", (record) => {
      record.orchestration!.cancel_requested_at = new Date().toISOString();
    });
    controller.abort();
    const completion = await pending;

    expect(completion).toMatchObject({ outcome: "cancelled", retryable: false, stale: false });
    expect(readTask("T-1")).toMatchObject({ lifecycle: "finished", outcome: "cancelled", result: { status: "cancelled" } });
  });

  it("aborts when cumulative token usage exceeds the task budget", async () => {
    const record = queuedRecord();
    record.orchestration = { ...defaultTaskOrchestration(), max_total_tokens: 10 };
    record.revision = 1;
    writeTask(record);
    run.mockImplementation(async (_input, events, signal) => {
      await events({
        type: "usage",
        at: new Date().toISOString(),
        threadId: "thread-1",
        turnId: "turn-1",
        usage: { inputTokens: 11, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 11 },
      });
      expect(signal.aborted).toBe(true);
      const error = new Error("interrupted");
      error.name = "AbortError";
      throw error;
    });

    await runTask("T-1", root, executor);

    expect(readTask("T-1")?.orchestration).toMatchObject({ cumulative_tokens: 11, last_failure: { kind: "budget" } });
    expect(readTask("T-1")?.result?.blockers).toEqual(["token budget exhausted (10)"]);
  });

  it("does not let a stale attempt overwrite a replacement lease", async () => {
    writeTask(queuedRecord());
    let resolveRun!: (value: AgentRunResult) => void;
    run.mockImplementation(() => new Promise((resolve) => { resolveRun = resolve; }));

    const pending = runTask("T-1", root, executor);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    updateTask("T-1", (record) => {
      record.orchestration!.lease!.run_id = "replacement-run";
      record.orchestration!.lease!.worker_id = "replacement-worker";
    });
    resolveRun(agentRun());
    const completion = await pending;

    expect(completion).toMatchObject({ stale: true });
    expect(readTask("T-1")).toMatchObject({ lifecycle: "running", orchestration: { lease: { run_id: "replacement-run" } } });
  });

  it("redacts credentials from streamed logs", async () => {
    writeTask(queuedRecord());
    run.mockImplementation(async (_input, events) => {
      await events({ type: "warning", at: new Date().toISOString(), message: "api_key=top-secret-value" });
      return agentRun();
    });

    await runTask("T-1", root, executor);

    const record = readTask("T-1")!;
    const log = readFileSync(join(root, record.logs_path!), "utf8");
    expect(log).not.toContain("top-secret-value");
    expect(log).toContain("[REDACTED]");
  });

  it("records injected trace identifiers without requiring a tracing package", async () => {
    writeTask(queuedRecord());
    const addEvent = vi.fn();
    const end = vi.fn();
    const tracer: Tracer = {
      startSpan: vi.fn(() => ({ context: { traceId: "trace-1", spanId: "span-1" }, addEvent, end })),
    };

    await runTask("T-1", root, executor, { tracer });

    expect(readTask("T-1")?.envelope.metadata.run).toMatchObject({ trace_id: "trace-1", span_id: "span-1" });
    expect(addEvent).toHaveBeenCalledWith("task.finished", { outcome: "completed", retryable: false });
    expect(end).toHaveBeenCalledWith("ok");
  });
});
