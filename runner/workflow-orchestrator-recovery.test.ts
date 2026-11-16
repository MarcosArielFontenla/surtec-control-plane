import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { createWorkflowService } from "../dashboard/src/server/workflow-service";
import { localGitEnvironment } from "../lib/security/environment";
import { managedGitArgs } from "../lib/security/managed-git.mjs";
import * as taskEvents from "../lib/state/events";
import { readIssueDocument } from "../lib/state/issues";
import * as taskState from "../lib/state/store";
import { listTasks, readTask, updateTask } from "../lib/state/store";
import * as workflowState from "../lib/state/workflows";
import { readWorkflowDocument } from "../lib/state/workflows";
import { inspectUnchargedClaimPackage, unchargedClaimPackage } from "../lib/workflows/uncharged-claim-recovery";
import type { AgentExecutor } from "./agent-executor";
import { TaskOrchestrator } from "./task-orchestrator";
import { createTerminalUsageEvidence } from "./terminal-usage-evidence";
import { assertReadOnlyCompletionCheckpoint, createAuthorizedWorkflowIssue, createWorkflowFixtureRoot,
  output, roles, selectQueuedStage, type FirstReadOnlyBinding } from "./testing/workflow-orchestrator-fixture";
import { WorkflowOrchestrator, workflowExecutionOwner } from "./workflow-orchestrator";

let root: string, state: string, issueId: string, worker: TaskOrchestrator | undefined;

beforeEach(() => {
  ({ root, state } = createWorkflowFixtureRoot());
  issueId = "";
});

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  expect(existsSync(root)).toBe(false);
});

async function completeFirstReadOnlyStage(binding: FirstReadOnlyBinding) {
  expect(await worker!.runOnce()).toBe(1);
  await vi.waitFor(() => assertReadOnlyCompletionCheckpoint(binding, readTask(binding.taskId), readWorkflowDocument()), { timeout: 5000 });
}

async function complete(taskId: string) {
  expect(await worker!.runOnce()).toBe(1);
  await vi.waitFor(() => expect(readTask(taskId)?.lifecycle).toBe("finished"), { timeout: 5000 });
}

describe("uncharged-claim stopped-owner recovery", () => {
  async function stoppedClaim() {
    const repo = join(root, "projects/alpha");
    const git = (...args: string[]) => execFileSync("git", managedGitArgs(["-C", repo, ...args], root),
      { env: localGitEnvironment(), windowsHide: true, stdio: "pipe" });
    git("init", "-b", "main"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Synthetic fixture");
    writeFileSync(join(repo, "verify.mjs"), "process.exit(0);\n"); git("add", "-A"); git("commit", "-m", "synthetic uncharged base");
    issueId = createAuthorizedWorkflowIssue(root);
    const controller = new WorkflowOrchestrator(root);
    const executor: AgentExecutor = { run: vi.fn(async () => ({
      finalText: "Never copy this raw fallback", structuredOutput: output("plan"), threadId: "synthetic-thread", turnId: "synthetic-turn",
      usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 3 },
    })) };
    worker = new TaskOrchestrator({ repoRoot: root, workflows: controller, executor, maxConcurrent: 1 });
    const admission = { template_id: "implementation", template_version: 1, project_id: "alpha", issue_id: issueId,
      expected_revision: readIssueDocument().issues[issueId]!.revision,
      selected_agents: { planner: roles.planner, "software-engineer": roles["software-engineer"], reviewer: roles.reviewer },
      budget: { max_tasks: 4, max_attempts: 4, max_runtime_ms: 900000, max_total_tokens: 100000 } };
    const preview = controller.service.preview(admission); expect(preview.allowed).toBe(true);
    const started = controller.service.start({ request: admission, preview_fingerprint: preview.fingerprint, confirm: true, approval_id: "synthetic-root-human" });
    const f = { controller, executor, taskId: started.stages[0]!.task_id!, id: started.workflow.id, stageId: started.stages[0]!.id };
    await completeFirstReadOnlyStage(f);
    const detail = f.controller.service.detail(f.id), decision = detail.decisions.find((entry) => entry.id === detail.workflow.pending_decision_id)!;
    f.controller.service.decide(f.id, { expected_revision: detail.workflow.revision, expected_issue_revision: decision.expected_issue_revision,
      decision_id: decision.id, resource_fingerprint: decision.resource_fingerprint, decision: "approve", approval_id: "synthetic-exact-plan",
      rationale: "Approve the exact synthetic scope", confirm: true });
    f.controller.reconcile();
    const engineer = selectQueuedStage(f.id, "implementation"), originalClaim = f.controller.claimRun.bind(f.controller);
    const injected = vi.spyOn(f.controller, "claimRun").mockImplementation((taskId, runId, proof) => {
      if (taskId === engineer.task_id) throw new Error("Synthetic pre-charge failure");
      return originalClaim(taskId, runId, proof);
    });
    expect(await worker!.runOnce()).toBe(1);
    await vi.waitFor(() => expect(readWorkflowDocument().workflows[f.id]!.status).toBe("needs-decision"), { timeout: 5000 });
    await worker!.stop(); injected.mockRestore();
    const document = readWorkflowDocument(), task = readTask(engineer.task_id!)!;
    expect(task.lifecycle).toBe("finished"); expect(task.outcome).toBe("needs-review"); expect(task.orchestration!.attempts).toBe(1);
    expect(task.envelope.metadata.run).toBeUndefined(); expect(document.stages[engineer.id]!.execution_id).toBeNull();
    expect(f.executor.run).toHaveBeenCalledOnce();
    const archive = join(root, "claim-archive"); mkdirSync(archive);
    copyFileSync(join(state, "workflows/workflows.json"), join(archive, "workflows.json"));
    copyFileSync(join(state, "tasks", engineer.task_id! + ".json"), join(archive, "task.json"));
    copyFileSync(join(state, "events", engineer.task_id! + ".jsonl"), join(archive, "events.jsonl"));
    copyFileSync(join(state, "issues/issues.json"), join(archive, "issues.json"));
    copyFileSync("scripts/fixtures/local-issue-api.ts", join(archive, "operator.mjs"));
    const owner = document.workflows[f.id]!;
    // Explicit synthetic native transcript for unit qualification. C06 uses
    // real attributable child exit/EOFs, not these synthetic producer facts.
    writeFileSync(join(archive, "native.json"), JSON.stringify({ pid: process.pid, native_exit: 2, native_signal: null, root_exit_observed: true,
      stdout_eof: true, stderr_eof: true, timed_out: false, capture_truncated: false, spawn_error: null, stream_error: null,
      termination_requested: false, elapsed_ms: 10, stdout: JSON.stringify({ status: "BLOCKED", plan_approved: true, worker_stopped: true, active_tasks: 0,
        workflow_id: f.id, workflow_status: owner.status, workflow_revision: owner.revision, counters: owner.counters, budget: owner.budget }) + "\n", stderr: "" }));
    const packageFingerprint = unchargedClaimPackage(inspectUnchargedClaimPackage({ runtimeRoot: process.cwd(), archiveRoot: archive })).archive_fingerprint;
    const request = () => ({ workflowId: f.id, expectedRevision: readWorkflowDocument().workflows[f.id]!.revision,
      expectedIssueRevision: readIssueDocument().issues[issueId]!.revision, expectedTaskRevision: readTask(engineer.task_id!)!.revision!,
      packageFingerprint, runtimeRoot: process.cwd(), archiveRoot: archive, approvalId: "synthetic-uncharged-human", confirm: true as const });
    return { ...f, engineer, archive, request, document, plannerBytes: readFileSync(join(state, "tasks", f.taskId + ".json")),
      eventsBytes: readFileSync(join(state, "events", engineer.task_id! + ".jsonl")) };
  }
  it("requeues the same identity once without starting and charges its existing controller before effects", async () => {
    const f = await stoppedClaim(), counters = structuredClone(f.document.workflows[f.id]!.counters), input = f.request();
    const result = worker!.recoverUnchargedWorkflowClaim(input);
    expect(result).toMatchObject({ phase: "ready", worker_started: false, task_id: f.engineer.task_id });
    const ready = readWorkflowDocument(), task = readTask(f.engineer.task_id!)!;
    expect(task.lifecycle).toBe("queued"); expect(task.orchestration!.attempts).toBe(1); expect(task.revision).toBe(4);
    expect(task.envelope).toEqual(JSON.parse(readFileSync(join(f.archive, "task.json"), "utf8")).envelope);
    expect(ready.workflows[f.id]!.counters).toEqual({ ...counters, accounting_complete: true });
    expect(ready.accounting).toEqual(f.document.accounting); expect(listTasks()).toHaveLength(2);
    expect(readFileSync(join(state, "tasks", f.taskId + ".json")).equals(f.plannerBytes)).toBe(true);
    expect(readFileSync(join(state, "events", f.engineer.task_id! + ".jsonl")).subarray(0, f.eventsBytes.length).equals(f.eventsBytes)).toBe(true);
    expect(f.executor.run).toHaveBeenCalledOnce(); expect(worker!.activeCount).toBe(0);
    expect(() => worker!.recoverUnchargedWorkflowClaim(f.request())).toThrow();
    // Exercise the controller boundary directly; C06 separately exercises the
    // normal scheduler and the complete writer/review/QA sequence.
    const runId = "synthetic-resumed-claim", at = new Date().toISOString();
    updateTask(f.engineer.task_id!, (current) => {
      current.lifecycle = "running"; current.orchestration!.attempts++;
      current.orchestration!.lease = { run_id: runId, worker_id: worker!.workerId, acquired_at: at, heartbeat_at: at,
        expires_at: new Date(Date.now() + 60000).toISOString() };
    });
    const proof = f.controller.claimRun(f.engineer.task_id!, runId);
    expect(workflowExecutionOwner(proof, f.engineer.task_id!, runId)).toBe(f.controller);
    expect(readTask(f.engineer.task_id!)!.orchestration!.attempts).toBe(2);
    expect(readWorkflowDocument().accounting[runId]).toMatchObject({ attempt: 2, attempt_charged: true, task_id: f.engineer.task_id });
    f.controller.release(proof);
    updateTask(f.engineer.task_id!, (current) => { current.lifecycle = "finished"; current.outcome = "needs-review";
      current.finished_at = at; current.orchestration!.lease = null; });
    f.controller.block(f.id, "Synthetic charged attempt retained without a provider invocation", true);
    expect(f.executor.run).toHaveBeenCalledOnce();
    const blocked = readWorkflowDocument(); expect(blocked.workflows[f.id]!.counters.attempts).toBe(2);
    expect(blocked.workflows[f.id]!.counters.accounting_complete).toBe(false);
    expect(blocked.workflows[f.id]!.uncharged_claim_recovery!.phase).toBe("ready");
    expect(() => worker!.recoverUnchargedWorkflowClaim(f.request())).toThrow();
  }, 15000);
  it.each(["source", "cancel", "stale", "archive"] as const)("refuses %s drift without changing retained bytes", async (kind) => {
    const f = await stoppedClaim(), request = f.request();
    if (kind === "source") writeFileSync(join(root, "registry/projects.yml"), readFileSync(join(root, "registry/projects.yml"), "utf8").replace("node verify.mjs", "node --version"));
    if (kind === "cancel") f.controller.service.cancel(f.id, { expected_revision: request.expectedRevision, expected_issue_revision: request.expectedIssueRevision });
    if (kind === "stale") request.expectedRevision--;
    if (kind === "archive") writeFileSync(join(f.archive, "operator.mjs"), "Unsupported operator");
    const workflow = readFileSync(join(state, "workflows/workflows.json")), task = readFileSync(join(state, "tasks", f.engineer.task_id! + ".json"));
    expect(() => worker!.recoverUnchargedWorkflowClaim(request)).toThrow();
    expect(readFileSync(join(state, "workflows/workflows.json")).equals(workflow)).toBe(true);
    expect(readFileSync(join(state, "tasks", f.engineer.task_id! + ".json")).equals(task)).toBe(true);
    expect(f.executor.run).toHaveBeenCalledOnce();
  }, 15000);
  it.each([1, 2, 3])("retains a failed workflow journal write %i and explicitly continues only its recognized state", async (failAt) => {
    const f = await stoppedClaim(), original = workflowState.mutateWorkflowDocument;
    let calls = 0;
    const failed = vi.spyOn(workflowState, "mutateWorkflowDocument").mockImplementation((...args) => {
      if (++calls === failAt) throw new Error("Synthetic journal write failure");
      return original(...args);
    });
    expect(() => worker!.recoverUnchargedWorkflowClaim(f.request())).toThrow("Synthetic journal write failure");
    failed.mockRestore();
    const retained = readWorkflowDocument(); expect(retained.workflows[f.id]!.counters.accounting_complete).toBe(false);
    const before = readFileSync(join(state, "workflows/workflows.json")); new WorkflowOrchestrator(root).reconcile();
    expect(readFileSync(join(state, "workflows/workflows.json")).equals(before)).toBe(true);
    const controller = new WorkflowOrchestrator(root); await worker!.stop(); worker = new TaskOrchestrator({ repoRoot: root, workflows: controller, executor: f.executor, maxConcurrent: 1 });
    expect(worker.recoverUnchargedWorkflowClaim(f.request()).phase).toBe("ready");
    expect(readTask(f.engineer.task_id!)!.orchestration!.attempts).toBe(1);
    expect(taskEvents.readTaskEvents(f.engineer.task_id!).filter((event) => event.type === "lease-recovered")).toHaveLength(1);
    expect(f.executor.run).toHaveBeenCalledOnce();
  }, 15000);
  it("can explicitly continue before task replacement but never fabricates a missing recovery event", async () => {
    const f = await stoppedClaim(), originalUpdate = taskState.updateTask;
    const failed = vi.spyOn(taskState, "updateTask").mockImplementation((...args) => {
      if (args[0] === f.engineer.task_id) throw new Error("Synthetic task write failure");
      return originalUpdate(...args);
    });
    expect(() => worker!.recoverUnchargedWorkflowClaim(f.request())).toThrow("Synthetic task write failure"); failed.mockRestore();
    expect(readWorkflowDocument().workflows[f.id]!.uncharged_claim_recovery!.phase).toBe("prepared");
    expect(readTask(f.engineer.task_id!)!.lifecycle).toBe("finished");
    const eventFailure = vi.spyOn(taskEvents, "appendTaskEvent").mockImplementation(() => { throw new Error("Synthetic event append failure"); });
    expect(() => worker!.recoverUnchargedWorkflowClaim(f.request())).toThrow("Synthetic event append failure"); eventFailure.mockRestore();
    const workflow = readFileSync(join(state, "workflows/workflows.json")), task = readFileSync(join(state, "tasks", f.engineer.task_id! + ".json"));
    expect(readTask(f.engineer.task_id!)!.lifecycle).toBe("queued");
    expect(() => worker!.recoverUnchargedWorkflowClaim(f.request())).toThrow();
    expect(await worker!.runOnce()).toBe(0); expect(f.executor.run).toHaveBeenCalledOnce();
    expect(readFileSync(join(state, "workflows/workflows.json")).equals(workflow)).toBe(true);
    expect(readFileSync(join(state, "tasks", f.engineer.task_id! + ".json")).equals(task)).toBe(true);
  }, 15000);
  it("rejects a serialized or foreign worker proof before filesystem qualification", async () => {
    const f = await stoppedClaim(), before = readFileSync(join(state, "workflows/workflows.json"));
    expect(() => f.controller.recoverUnchargedClaim(f.request(), {})).toThrow(/stopped and idle/);
    expect(readFileSync(join(state, "workflows/workflows.json")).equals(before)).toBe(true); expect(f.executor.run).toHaveBeenCalledOnce();
  }, 15000);
});

describe("planner-recovery owned controller", () => {
  async function retained(completeUsage = true) {
    issueId = createAuthorizedWorkflowIssue(root);
    const policyPath = join(root, "registry/workflow-policy.yml"), policy = parse(readFileSync(policyPath, "utf8"));
    policy.minimum_review_depth = "full"; writeFileSync(policyPath, JSON.stringify(policy));
    const controller = new WorkflowOrchestrator(root);
    const value = { ...output("plan"), status: "needs-review", unresolved_questions: ["Approve this exact plan?"], risks: ["Verification cost remains unmeasured"] };
    const executor: AgentExecutor = { run: vi.fn(async (input) => {
      const usage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 12 };
      const terminalUsageEvidence = createTerminalUsageEvidence({ ...input.executionIdentity!, contextFingerprint: input.contextFingerprint!,
        threadId: "recovery-thread", turnId: "recovery-turn", usage, baseline: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, cacheWriteInputTokens: 0 },
        protocolUsage: { ...usage, cacheWriteInputTokens: 0 }, finalItemId: "final-1", finalPhase: "final_answer", finalItemSequence: 1, usageSequence: 2, terminalSequence: 3,
        terminalStatus: "completed", exitCode: 0, signal: null, stdoutEof: true, stderrEof: true });
      return { finalText: "", structuredOutput: value, threadId: "recovery-thread", turnId: "recovery-turn", usage, usageComplete: completeUsage,
        ...(completeUsage ? { terminalUsageEvidence } : {}) };
    }) };
    worker = new TaskOrchestrator({ repoRoot: root, workflows: controller, executor, maxConcurrent: 1 });
    const request = { template_id: "implementation", template_version: 1, project_id: "alpha", issue_id: issueId, expected_revision: readIssueDocument().issues[issueId]!.revision,
      selected_agents: { planner: "tech-lead", "software-engineer": "backend-engineer", reviewer: "reality-checker", "qa-evaluator": "qa-reviewer" },
      client_context_categories: {}, correction_enabled: false, budget: { max_tasks: 4, max_attempts: 4, max_runtime_ms: 900000, max_total_tokens: 100000 } };
    const preview = controller.service.preview(request); expect(preview.allowed).toBe(true);
    const started = controller.service.start({ request, preview_fingerprint: preview.fingerprint, approval_id: "synthetic-root", confirm: true });
    const taskId = started.stages[0]!.task_id!, id = started.workflow.id; await complete(taskId); controller.reconcile();
    return { controller, executor, id, taskId };
  }
  function offerInput(detail: ReturnType<ReturnType<typeof createWorkflowService>["detail"]>) {
    const offer = detail.planner_recovery_offer!;
    expect(offer.eligible, JSON.stringify(offer)).toBe(true);
    return { expected_revision: detail.workflow.revision, expected_issue_revision: offer.issue_revision, source_fingerprint: offer.source_fingerprint,
      confirm: true, approval_id: "synthetic-recovery-human", rationale: "Offer unchanged proposal for independent exact approval",
      questions: offer.questions.map((q) => ({ index: q.index, fingerprint: q.fingerprint, kind: "plan-approval-gate", answer: "Defer to the separate exact-plan gate" })),
      risks: offer.risks.map((r) => ({ index: r.index, fingerprint: r.fingerprint })) };
  }
  it.each(["receipt", "missing-receipt", "run", "result", "scope", "source", "slots", "stop"])("refuses %s drift with no redispatch, refund or state repair", async (change) => {
    const f = await retained(), detail = f.controller.service.detail(f.id), input = offerInput(detail);
    const taskPath = join(state, "tasks", f.taskId + ".json"), workflowPath = join(state, "workflows/workflows.json");
    if (["receipt", "missing-receipt", "run", "result"].includes(change)) {
      const task = JSON.parse(readFileSync(taskPath, "utf8"));
      if (change === "receipt") task.envelope.metadata.run.terminal_usage_evidence.digest = "a".repeat(64);
      if (change === "missing-receipt") delete task.envelope.metadata.run.terminal_usage_evidence;
      if (change === "run") task.orchestration.last_failure.run_id = "foreign-run";
      if (change === "result") task.result.summary = "Substituted despite the same failure label";
      writeFileSync(taskPath, JSON.stringify(task));
    }
    if (change === "scope" || change === "slots") {
      const document = JSON.parse(readFileSync(workflowPath, "utf8")), owner = document.workflows[f.id];
      if (change === "scope") {
        document.stages[owner.current_stage_id].output.scope_change_required = true;
        document.stages[owner.current_stage_id].output_fingerprint = createHash("sha256").update(JSON.stringify(document.stages[owner.current_stage_id].output)).digest("hex");
      }
      else { owner.budget.max_tasks = 3; document.grants[owner.current_grant_id].budget.max_tasks = 3; }
      writeFileSync(workflowPath, JSON.stringify(document));
    }
    if (change === "source") {
      const path = join(root, "registry/projects.yml"); writeFileSync(path, readFileSync(path, "utf8").replace("node verify.mjs", "node --version"));
    }
    if (change === "stop") f.controller.service.cancel(f.id, { expected_revision: detail.workflow.revision, expected_issue_revision: input.expected_issue_revision });
    const beforeWorkflow = readFileSync(workflowPath), beforeTask = readFileSync(taskPath);
    expect(f.controller.service.detail(f.id).planner_recovery_offer!.eligible).toBe(false);
    expect(() => f.controller.service.offerPlannerRecovery(f.id, input)).toThrow();
    expect(readFileSync(workflowPath).equals(beforeWorkflow)).toBe(true); expect(readFileSync(taskPath).equals(beforeTask)).toBe(true);
    expect(listTasks()).toHaveLength(1); expect(f.executor.run).toHaveBeenCalledOnce();
  }, 15000);
  it("keeps task/event/output/charges and gates Engineer separately across restart", async () => {
    const f = await retained(), detail = f.controller.service.detail(f.id), input = offerInput(detail);
    const taskPath = join(state, "tasks", f.taskId + ".json"), eventsPath = join(state, "events", f.taskId + ".jsonl");
    const taskBytes = readFileSync(taskPath), eventBytes = readFileSync(eventsPath), stage = detail.stages[0]!;
    expect(detail.workflow.status).toBe("needs-decision"); expect(detail.decisions).toHaveLength(0);
    const offered = f.controller.service.offerPlannerRecovery(f.id, input);
    expect(offered.workflow.status).toBe("waiting-human"); expect(offered.stages[0]!.status).toBe("needs-review");
    expect(offered.workflow.counters).toEqual(detail.workflow.counters); expect(offered.accounting).toEqual(detail.accounting);
    expect(offered.stages[0]!.output).toEqual(stage.output); expect(readFileSync(taskPath).equals(taskBytes)).toBe(true); expect(readFileSync(eventsPath).equals(eventBytes)).toBe(true);
    expect(() => f.controller.service.offerPlannerRecovery(f.id, input)).toThrow();
    new WorkflowOrchestrator(root).reconcile(); expect(listTasks()).toHaveLength(1); expect(f.executor.run).toHaveBeenCalledOnce();
    const decision = offered.decisions[0]!;
    f.controller.service.decide(f.id, { expected_revision: offered.workflow.revision, expected_issue_revision: decision.expected_issue_revision, decision_id: decision.id,
      resource_fingerprint: decision.resource_fingerprint, decision: "approve", approval_id: "synthetic-exact-plan", rationale: "Approve unchanged bounded plan", confirm: true });
    f.controller.reconcile(); new WorkflowOrchestrator(root).reconcile();
    const admitted = f.controller.service.detail(f.id); expect(listTasks()).toHaveLength(2); expect(admitted.handoffs).toHaveLength(1);
    expect(admitted.handoffs[0]!.outcome_summary).toContain("Human adopted"); expect(admitted.handoffs[0]!.unresolved_questions).toEqual(stage.output!.unresolved_questions);
    expect(admitted.stages[0]!.status).toBe("needs-review"); expect(readTask(f.taskId)!.outcome).toBe("needs-review");
    expect(readFileSync(taskPath).equals(taskBytes)).toBe(true); expect(readFileSync(eventsPath).equals(eventBytes)).toBe(true); expect(f.executor.run).toHaveBeenCalledOnce();
    const engineer = admitted.stages.at(-1)!; expect(engineer.kind).toBe("implementation"); expect(engineer.status).toBe("queued");
    expect(readTask(engineer.task_id!)!.envelope.context_manifest!.sources.some((source) => source.id.includes("planner-recovery"))).toBe(true);
  }, 15000);
  it("retains rejection and never replaces its receipt or starts a role", async () => {
    const f = await retained(), offered = f.controller.service.offerPlannerRecovery(f.id, offerInput(f.controller.service.detail(f.id))), decision = offered.decisions[0]!;
    f.controller.service.decide(f.id, { expected_revision: offered.workflow.revision, expected_issue_revision: decision.expected_issue_revision, decision_id: decision.id,
      resource_fingerprint: decision.resource_fingerprint, decision: "reject", approval_id: "synthetic-reject", rationale: "Do not proceed", confirm: true });
    new WorkflowOrchestrator(root).reconcile();
    const rejected = f.controller.service.detail(f.id); expect(rejected.workflow.status).toBe("needs-decision");
    expect(rejected.workflow.planner_recovery).toEqual(offered.workflow.planner_recovery); expect(rejected.planner_recovery_offer!.eligible).toBe(false);
    expect(listTasks()).toHaveLength(1); expect(f.executor.run).toHaveBeenCalledOnce();
  }, 15000);
  it("refuses incomplete accounting without repair or another invocation", async () => {
    const f = await retained(false), before = readFileSync(join(state, "workflows/workflows.json"));
    expect(f.controller.service.detail(f.id).planner_recovery_offer!.eligible).toBe(false);
    expect(readFileSync(join(state, "workflows/workflows.json")).equals(before)).toBe(true); expect(listTasks()).toHaveLength(1); expect(f.executor.run).toHaveBeenCalledOnce();
  }, 15000);
  it("refuses stale offers and incomplete acknowledgement without state changes", async () => {
    const f = await retained(), detail = f.controller.service.detail(f.id), input = offerInput(detail), path = join(state, "workflows/workflows.json"), bytes = readFileSync(path);
    expect(() => f.controller.service.offerPlannerRecovery(f.id, { ...input, source_fingerprint: "a".repeat(64) })).toThrow();
    expect(() => f.controller.service.offerPlannerRecovery(f.id, { ...input, risks: [] })).toThrow();
    expect(() => f.controller.service.offerPlannerRecovery(f.id, { ...input, questions: [] })).toThrow();
    expect(() => f.controller.service.offerPlannerRecovery(f.id, { ...input, grant: {} })).toThrow();
    expect(readFileSync(path).equals(bytes)).toBe(true); expect(listTasks()).toHaveLength(1); expect(f.executor.run).toHaveBeenCalledOnce();
  }, 15000);
});
