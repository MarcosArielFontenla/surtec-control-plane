// Test-only API bootstrap. Real application/orchestrator/Git/verification,
// with a deterministic injected executor; never starts the paid runtime.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { createApp } from "../../dashboard/src/server/index";
import { TaskOrchestrator } from "../../runner/task-orchestrator";
import { WorkflowOrchestrator } from "../../runner/workflow-orchestrator";
import { managedWorktreeIdentity } from "../../runner/worktree";
import { managedGitArgs } from "../../lib/security/managed-git.mjs";
import { localGitEnvironment } from "../../lib/security/environment";
import { listTasks, readTask } from "../../lib/state/store";
import { readWorkflowDocument } from "../../lib/state/workflows";
import { readIssueDocument } from "../../lib/state/issues";
import type { AgentExecutor } from "../../runner/agent-executor";
import { createTerminalUsageEvidence } from "../../runner/terminal-usage-evidence";
import { GOVERNED_RUNTIME_CONTEXT_PROFILE } from "../../runner/runtime-context-profile";
import { inspectUnchargedClaimPackage, unchargedClaimPackage } from "../../lib/workflows/uncharged-claim-recovery";

const root = realpathSync(process.env.SURTEC_SMOKE_FIXTURE_ROOT ?? "");
const relativeRoot = relative(realpathSync(tmpdir()), root);
assert.ok(relativeRoot && !relativeRoot.startsWith(`..${sep}`) && relativeRoot !== ".." && !isAbsolute(relativeRoot) && basename(root).startsWith("surtec-local-dashboard-"), "test bootstrap requires its owned OS-temp fixture");
assert.equal(resolve(process.env.SURTEC_STATE_DIR ?? ""), join(root, "state"));
assert.equal(resolve(process.env.SURTEC_PROJECTS_ROOT ?? ""), join(root, "projects"));
assert.equal(process.env.NODE_ENV, "test");
const disabledRuntime = join(root, "forbidden-paid-runtime");
assert.equal(process.env.SURTEC_CODEX_BIN, disabledRuntime);
assert.equal(existsSync(disabledRuntime), false, "real runtime entry must not exist in the fixture");
const unchargedMode = process.argv.includes("--uncharged-claim-recovery-only");
assert.ok(!unchargedMode || typeof process.send === "function", "uncharged-claim fixture requires its owned parent IPC channel");

const executor: AgentExecutor = {
  async run(options, _events, signal) {
    assert.ok(["read-only", "workspace-write", "workspace-write-verify"].includes(options.mode), "fake executor refuses unknown execution modes");
    const worktree = realpathSync(options.cwd);
    const boundary = join(root, "projects", "surtec-worktrees") + sep;
    const tasks = listTasks().filter((task) => task.lifecycle === "running" && task.orchestration?.lease
      && (task.envelope.metadata.run as Record<string, unknown> | undefined)?.context_fingerprint === options.contextFingerprint);
    assert.equal(tasks.length, 1, "synthetic output must belong to exactly one live execution contract");
    const task = tasks[0]!, admission = task.envelope.context_admission;
    if (admission?.schema_version === 2) {
      assert.equal(options.runtimeContextProfile, GOVERNED_RUNTIME_CONTEXT_PROFILE, "fresh fake roles require the bound code-owned context profile");
      const document = readWorkflowDocument(), owner = document.workflows[admission.workflow_id]!, stage = document.stages[admission.stage_id]!;
      const issue = readIssueDocument().issues[admission.issue_id]!;
      assert.equal(issue.project_id, "workflow-smoke-project");
      assert.equal(owner.current_stage_id, stage.id); assert.equal(stage.task_id, task.envelope.id);
      assert.equal(stage.execution_id, task.orchestration!.lease!.run_id);
      assert.equal(stage.kind, admission.stage_kind); assert.equal(stage.role_id, admission.role_id);
      assert.equal(stage.agent_id, task.envelope.agent); assert.equal(owner.current_grant_id, admission.grant_id);
      assert.equal(owner.authority_revision, admission.authority_revision);
      const scenarios = JSON.parse(readFileSync(join(root, "workflow-scenarios.json"), "utf8")) as Record<string, string>;
      const scenario = scenarios[issue.id];
      assert.ok(["approve", "correction", "repeat-correction", "hold", "advisory", "planner-recovery", "uncharged-claim"].includes(scenario ?? ""), "only explicit test-owned scenarios are accepted");
      const candidate = admission.candidate;
      if (stage.kind === "review" || stage.kind === "qa") {
        assert.equal(options.mode, "read-only"); assert.deepEqual(options.verifyCommands, []); assert.ok(candidate);
        const writer = readTask(candidate.task_id)!;
        const view = managedWorktreeIdentity(join(root, "projects", issue.project_id), writer.envelope.id, writer.envelope.agent);
        assert.equal(writer.lifecycle, "finished"); assert.equal(writer.outcome, "completed");
        assert.equal(writer.testing_evidence!.fingerprint, candidate.testing_evidence_fingerprint);
        assert.equal(worktree, realpathSync(view.worktreePath), "review inspects the exact implementer's managed candidate, never source HEAD");
        assert.equal(realpathSync((writer.envelope.metadata.run as { worktree_path: string }).worktree_path), worktree);
        assert.equal(execFileSync("git", managedGitArgs(["-C", worktree, "rev-parse", "HEAD"], root), { env: localGitEnvironment(), windowsHide: true, encoding: "utf8", timeout: 30_000 }).trim(), candidate.candidate_revision);
        assert.ok(readFileSync(join(worktree, "dashboard/src/workflow.txt"), "utf8").includes(issue.id));
        // Production prepare/completion performs the full before/after tree,
        // content, ownership and receipt inspection; do not add a third copy
        // of that expensive verifier inside the fake's otherwise instant turn.
      } else if (stage.sandbox === "read-only") {
        assert.equal(options.mode, "read-only"); assert.deepEqual(options.verifyCommands, []);
        assert.equal(worktree, join(root, "projects", issue.project_id));
      } else {
        assert.equal(options.mode, "workspace-write-verify"); assert.ok(worktree.startsWith(boundary));
        assert.deepEqual(options.verifyCommands, ["node verify-workflow.mjs"]);
        assert.equal(existsSync(join(worktree, "source-only.txt")), false);
        const target = join(worktree, "dashboard/src/workflow.txt");
        if (stage.kind === "correction") {
          assert.equal(readFileSync(target, "utf8").replace(/\r\n/g, "\n"), `Synthetic initial ${issue.id}.\n`);
          assert.equal(document.lineages[owner.lineage_id!]!.corrections_consumed, 1);
        }
        mkdirSync(join(worktree, "dashboard/src"), { recursive: true });
        writeFileSync(target, `Synthetic ${stage.kind === "correction" ? "corrected" : "initial"} ${issue.id}.\n`, "utf8");
      }
      // Body-free test telemetry, not a fabricated receipt or application authority.
      appendFileSync(join(root, "executor-effects.jsonl"), JSON.stringify({ mode: options.mode, fingerprint: options.contextFingerprint,
        workflow_id: owner.id, task_id: task.envelope.id, stage_id: stage.id, kind: stage.kind, role_id: stage.role_id,
        execution_id: stage.execution_id, candidate_id: candidate?.candidate_id ?? null, candidate_revision: candidate?.candidate_revision ?? null }) + "\n");
      if (scenario === "hold") await new Promise<never>((_resolve, reject) => {
        const interrupted = () => { const error = new Error("Synthetic held role interrupted"); error.name = "AbortError"; reject(error); };
        if (signal.aborted) interrupted(); else signal.addEventListener("abort", interrupted, { once: true });
      });
      // A real transport yields to socket/heartbeat work. An instant resolved
      // fake instead creates an artificial synchronous multi-role burst.
      await delay(50, undefined, { signal });
      const base = { schema_version: 1, status: "completed", summary: `Synthetic ${stage.kind} output`, evidence_ids: [] as string[],
        unresolved_questions: [], risks: [], recommended_next_action: "Inspect the exact next human gate", requested_decision: null };
      let structuredOutput: unknown;
      if (stage.kind === "planning") structuredOutput = { ...base, kind: "plan", plan: ["Change dashboard/src/workflow.txt only", "Run the configured verifier"], scope_change_required: false };
      else if (stage.kind === "analysis") structuredOutput = { ...base, kind: "analysis", recommendations: ["Inspect the bounded proposal without authorizing implementation"] };
      else if (stage.kind === "operations") structuredOutput = { ...base, kind: "operations", proposed_issue: {
        title: "Synthetic operations proposal", expected_outcome: "Observe a bounded service window", acceptance_criteria: ["Observable window evidence"],
        plan: ["Collect current evidence"], allowed_path_patterns: ["dashboard/src/**"], next_action: "Request separate human issue approval" } };
      else if (stage.kind === "implementation" || stage.kind === "correction") structuredOutput = { status: "completed", summary: "Synthetic bounded writer",
        commands_run: [], tests_run: [], risks: [], blockers: [], next_steps: [], artifacts: [] };
      else {
        const facts = readIssueDocument(), evidence = issue.evidence_ids.map((id) => facts.evidence[id]!)
          .find((entry) => entry.kind === "verification" && entry.status === "passed" && entry.candidate_id === candidate!.candidate_id);
        assert.ok(evidence, "QA/review references only real infrastructure verification evidence");
        const correct = stage.kind === "review" && stage.ordinal <= 4 && ["correction", "repeat-correction"].includes(scenario!)
          || stage.kind === "qa" && stage.ordinal > 4 && scenario === "repeat-correction";
        const advisory = stage.kind === "review" && scenario === "advisory";
        const findings = correct || advisory ? [{ id: `synthetic-${stage.id}`, severity: correct ? "blocking" : "advisory",
          summary: correct ? "Correct the exact bounded behavior" : "Confirm the retained operational window", path: "dashboard/src/workflow.txt",
          evidence_ids: [evidence.id], scope_change_required: false }] : [];
        structuredOutput = { ...base, kind: stage.kind, evidence_ids: [evidence.id], verdict: correct ? "correction-required" : "approve", findings,
          ...(stage.kind === "qa" ? { criteria: issue.acceptance_criteria.map((criterion) => ({ criterion, status: correct ? "contradictory" : "supported", evidence_ids: [evidence.id] })) } : {}) };
      }
      if (["planner-recovery", "uncharged-claim"].includes(scenario!) && stage.kind === "planning") structuredOutput = { ...base, kind: "plan", status: "needs-review",
        plan: ["Change dashboard/src/workflow.txt only", "Run the configured verifier"], scope_change_required: false,
        unresolved_questions: ["Approve this exact retained plan?"], risks: ["Verification runtime remains unmeasured"], requested_decision: "Approve the exact plan separately" };
      const result = { finalText: "Never promote raw fallback", structuredOutput, threadId: `synthetic-${stage.id}`, turnId: `synthetic-${stage.id}-turn`,
        usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 3 } };
      if (["planner-recovery", "uncharged-claim"].includes(scenario!)) {
        assert.ok(options.executionIdentity && options.contextFingerprint, "receipt binds the actual synthetic task/run/contract");
        return { ...result, usageComplete: true, terminalUsageEvidence: createTerminalUsageEvidence({ ...options.executionIdentity, contextFingerprint: options.contextFingerprint,
          threadId: result.threadId, turnId: result.turnId, usage: result.usage,
          baseline: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, cacheWriteInputTokens: 0 },
          protocolUsage: { ...result.usage, cacheWriteInputTokens: 0 }, finalItemId: `final-${stage.id}`, finalPhase: "final_answer", finalItemSequence: 1, usageSequence: 2,
          terminalSequence: 3, terminalStatus: "completed", exitCode: 0, signal: null, stdoutEof: true, stderrEof: true }) };
      }
      return result;
    }
    if (options.mode === "read-only") {
      assert.ok(["harness-smoke-project", "harness-smoke-client", "appointment-manager"].some((id) => worktree === join(root, "projects", id)), "read-only fake only inspects a synthetic checkout");
    } else {
      assert.ok(worktree.startsWith(boundary), "fake executor can only write a synthetic managed worktree");
      const outOfScope = options.prompt.includes("Synthetic scope discovery");
      const target = join(worktree, outOfScope ? "registry/discovered.txt" : "dashboard/src/fixture.txt");
      mkdirSync(join(worktree, outOfScope ? "registry" : "dashboard/src"), { recursive: true });
      writeFileSync(target, "Synthetic acceptance result.\n", "utf8");
    }
    // Test-owned effect counter, not product evidence; never persist prompts or source bodies.
    appendFileSync(join(root, "executor-effects.jsonl"), JSON.stringify({ mode: options.mode, fingerprint: options.contextFingerprint }) + "\n");
    const report = { status: "completed", summary: options.mode === "read-only" ? "Synthetic read-only fixture completed" : "Synthetic fixture changed", commands_run: [], tests_run: [], risks: [], blockers: [], next_steps: [], artifacts: [] };
    return { finalText: JSON.stringify(report), structuredOutput: report, threadId: "synthetic-thread", turnId: "synthetic-turn", usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 } };
  },
};
const workflows = new WorkflowOrchestrator(root);
const worker = new TaskOrchestrator({ repoRoot: root, workflows, executor, pollMs: 100, maxConcurrent: 1 });
let claimInjected = false;
if (unchargedMode) {
  const originalClaim = workflows.claimRun.bind(workflows);
  workflows.claimRun = (taskId, runId, proof) => {
    const task = readTask(taskId), admission = task?.envelope.context_admission;
    if (admission?.schema_version === 2 && admission.stage_kind === "implementation" && task?.orchestration?.attempts === 1 && !claimInjected) {
      const scenarios = JSON.parse(readFileSync(join(root, "workflow-scenarios.json"), "utf8")) as Record<string, string>;
      if (scenarios[admission.issue_id] === "uncharged-claim") { claimInjected = true; throw new Error("Synthetic pre-charge claim failure"); }
    }
    return originalClaim(taskId, runId, proof);
  };
}
const retainedUnchargedOwner = unchargedMode && Object.values(readWorkflowDocument().workflows).some((owner) => !["completed", "cancelled"].includes(owner.status));
if (!retainedUnchargedOwner) worker.start();
const app = createApp(root, worker, undefined, undefined, { workflows: workflows.service, inbox: async () => ({ items: [], repos: [] }) });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: Number(process.env.PORT) });
// Match the existing real-HTTP workflow fixture: Windows connection pooling
// must not expire its default five-second idle socket during Git inspection.
const httpServer = server as unknown as import("node:http").Server;
httpServer.keepAliveTimeout = 120_000;
httpServer.headersTimeout = 125_000;
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await worker.stop(); server.close(); };
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });


// Closed test-only child IPC. No product route, command/path selection or
// normal-state fallback; all locations derive from the verified owned root.
if (unchargedMode) {
  let operating = false, released = false;
  const send = (value: Record<string, unknown>) => new Promise<void>((done, reject) => {
    if (!process.connected || !process.send) { reject(new Error("Owned fixture IPC unavailable")); return; }
    process.send(value, (error) => error ? reject(error) : done());
  });
  const handle = async (message: unknown) => {
    assert.ok(message && typeof message === "object" && !Array.isArray(message));
    const value = message as Record<string, unknown>, keys = ["kind", "request_id", "workflow_id", "expected_revision", "expected_task_revision"];
    assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
    assert.match(String(value.request_id), /^[a-f0-9-]{36}$/);
    assert.ok(["seal-uncharged-claim", "recover-uncharged-claim", "start-recovered-claim"].includes(String(value.kind)));
    assert.ok(typeof value.workflow_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value.workflow_id));
    assert.ok(Number.isSafeInteger(value.expected_revision) && Number.isSafeInteger(value.expected_task_revision));
    assert.equal(operating, false); operating = true;
    try {
      const document = readWorkflowDocument(), owner = document.workflows[value.workflow_id], stage = owner?.current_stage_id ? document.stages[owner.current_stage_id] : null;
      const task = stage?.task_id ? readTask(stage.task_id) : null;
      assert.ok(owner && stage && task && stage.kind === "implementation" && stage.task_id === task.envelope.id);
      assert.equal(owner.revision, value.expected_revision); assert.equal(task.revision, value.expected_task_revision);
      const scenarios = JSON.parse(readFileSync(join(root, "workflow-scenarios.json"), "utf8")) as Record<string, string>;
      assert.equal(scenarios[owner.issue_id], "uncharged-claim");
      if (value.kind === "seal-uncharged-claim") {
        assert.equal(claimInjected, true); assert.equal(owner.status, "needs-decision"); assert.equal(stage.execution_id, null);
        assert.equal(task.lifecycle, "finished"); assert.equal(task.outcome, "needs-review"); assert.equal(task.orchestration?.attempts, 1);
        assert.equal(task.orchestration?.lease, null); assert.equal(task.envelope.metadata.run, undefined);
        assert.ok(!owner.uncharged_claim_recovery); stopping = true; await worker.stop(); assert.equal(worker.activeCount, 0);
        await new Promise<void>((done, reject) => {
          httpServer.closeIdleConnections();
          server.close((error?: Error) => error ? reject(error) : done());
          httpServer.closeAllConnections();
        });
        await send({ kind: "uncharged-claim-fixture-result", request_id: value.request_id, ok: true, result: { sealed: true } });
        console.log(JSON.stringify({ status: "BLOCKED", plan_approved: true, worker_stopped: true, active_tasks: 0,
          workflow_id: owner.id, workflow_status: owner.status, workflow_revision: owner.revision, counters: owner.counters, budget: owner.budget }));
        process.exitCode = 2; process.disconnect?.();
        return;
      }
      if (value.kind === "recover-uncharged-claim") {
        assert.equal(retainedUnchargedOwner, true); assert.equal(released, false);
        const archiveRoot = join(root, "claim-recovery-archive"), runtimeRoot = join(root, "runtime");
        const inspected = unchargedClaimPackage(inspectUnchargedClaimPackage({ runtimeRoot, archiveRoot }));
        const result = worker.recoverUnchargedWorkflowClaim({ workflowId: owner.id, expectedRevision: owner.revision,
          expectedIssueRevision: readIssueDocument().issues[owner.issue_id]!.revision, expectedTaskRevision: task.revision!,
          packageFingerprint: inspected.archive_fingerprint, runtimeRoot, archiveRoot, approvalId: "synthetic-uncharged-human", confirm: true });
        assert.equal(result.worker_started, false); assert.equal(worker.activeCount, 0);
        await send({ kind: "uncharged-claim-fixture-result", request_id: value.request_id, ok: true, result });
        return;
      }
      assert.equal(retainedUnchargedOwner, true); assert.equal(released, false); assert.equal(owner.uncharged_claim_recovery?.phase, "ready");
      assert.equal(owner.status, "running"); assert.equal(task.lifecycle, "queued"); assert.equal(task.orchestration?.attempts, 1);
      released = true; worker.start();
      await send({ kind: "uncharged-claim-fixture-result", request_id: value.request_id, ok: true, result: { started: true } });
    } finally { operating = false; }
  };
  process.on("message", (message: unknown) => {
    const id = message && typeof message === "object" && "request_id" in message && /^[a-f0-9-]{36}$/.test(String(message.request_id))
      ? String(message.request_id) : "invalid";
    void handle(message).catch(() => send({ kind: "uncharged-claim-fixture-result", request_id: id, ok: false }))
      .catch(() => { process.exitCode = 1; process.disconnect?.(); });
  });
}

