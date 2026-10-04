import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentOutcome, AgentResult, TaskFailureKind, TaskRecord } from "../lib/state/types";
import type { AgentEvent, AgentExecutor, AgentUsage } from "./agent-executor";
import { readTask, updateTask } from "../lib/state/store";
import { ensureTaskOrchestration } from "../lib/state/orchestration";
import { appendTaskEvent } from "../lib/state/events";
import { expandHome } from "../lib/expand-home";
import { codexExecutor } from "./codex-executor";
import { buildGovernedPrompts, buildSystemPrompt, buildUserPrompt, GOVERNED_PROMPT_VERSION } from "./agent-prompt";
import { createContextService, ContextPreviewError, type AdmittedContext } from "../dashboard/src/server/context-service";
import { contextHash } from "../lib/context/assemble";
import { ContextContractError } from "../lib/context/validation";
import { contextAdmissionVersion } from "../lib/state/validation";
import { readContextConfig } from "../lib/policy/roles";
import { AGENT_REPORT_SCHEMA } from "./agent-report";
import { cancelledResult, toAgentResult, failureResult } from "./result";
import { createWorktree, commitAndDiff, inspectCandidateTree } from "./worktree";
import { captureVerification, runVerification, validateTestingProbes } from "./verify";
import { createTestingEvidence, sealTestingEvidence, stageOrder, testingEvidenceStatus, type TestingEvidence } from "../lib/context/testing-evidence";
import { PolicyError, PolicyService } from "../lib/policy/service";
import { redactText, safeJson } from "../lib/security/redaction";
import { noOpTracer, type Tracer } from "../lib/observability/tracing";
import { createIssueService, IssueScopeViolationError, pathsOutsideScope } from "../dashboard/src/server/issue-service";
import { rejectStandaloneWorkflowStage } from "./workflow-stage";
import { workflowExecutionOwner } from "./workflow-orchestrator";
import { correctionPathReasons, readWorkflowPolicy } from "../lib/workflows/policy";

export interface TaskRunOptions {
  signal?: AbortSignal;
  runId?: string;
  workerId?: string;
  tracer?: Tracer;
  workflowExecution?: object;
}

export interface TaskRunCompletion {
  outcome: AgentOutcome;
  retryable: boolean;
  reason?: string;
  stale: boolean;
}

type AbortKind = "cancelled" | "timeout" | "tokens" | "interrupted";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadataRun(record: TaskRecord): Record<string, unknown> {
  const current = record.envelope.metadata.run;
  return isObject(current) ? { ...current } : {};
}

function eventType(outcome: AgentOutcome): "completed" | "failed" | "needs-review" | "cancelled" {
  if (outcome === "failed") return "failed";
  if (outcome === "needs-review") return "needs-review";
  if (outcome === "cancelled") return "cancelled";
  return "completed";
}

function failureKindFor(error: unknown): TaskFailureKind {
  return error instanceof PolicyError ? "terminal" : "transient";
}

function issueContext(record: TaskRecord, workflow?: ReturnType<import("./workflow-orchestrator").WorkflowOrchestrator["prepare"]>): { issueId: string; scopeRevision: number; scope: import("../lib/issues/types").AuthorizedScope } | null {
  if (record.envelope.context_admission?.schema_version === 2) {
    const admission = record.envelope.context_admission;
    if (!workflow || !["implementation", "correction"].includes(workflow.stage.kind) || workflow.stage.sandbox !== "workspace-write"
      || workflow.admission.task_id !== record.envelope.id || workflow.admission.workflow_id !== admission.workflow_id
      || workflow.admission.stage_id !== admission.stage_id || workflow.admission.scope_revision !== admission.scope_revision
      || workflow.issue.id !== admission.issue_id) return null;
    return { issueId: workflow.issue.id, scopeRevision: admission.scope_revision, scope: workflow.issue.authorized_scope };
  }
  const issueId = record.envelope.metadata.issue_id;
  const scopeRevision = record.envelope.metadata.issue_scope_revision;
  const scope = record.envelope.metadata.issue_authorized_scope;
  if (typeof issueId !== "string" || !Number.isSafeInteger(scopeRevision) || !scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  const candidate = scope as Record<string, unknown>;
  if (!Array.isArray(candidate.allowed_path_patterns) || !Array.isArray(candidate.excluded_path_patterns)) return null;
  return { issueId, scopeRevision: scopeRevision as number, scope: scope as import("../lib/issues/types").AuthorizedScope };
}

export async function runTask(
  taskId: string,
  repoRoot: string = process.cwd(),
  executor: AgentExecutor = codexExecutor,
  options: TaskRunOptions = {},
): Promise<TaskRunCompletion | null> {
  let runId = options.runId ?? "";
  let claimedRevision: number | null = null;
  let attempt = 0;

  if (!runId) {
    runId = randomUUID();
    let claimed = false;
    const record = updateTask(taskId, (candidate) => {
      if (candidate.lifecycle !== "queued") return false;
      const orchestration = ensureTaskOrchestration(candidate);
      if (orchestration.attempts >= orchestration.max_attempts || orchestration.cumulative_tokens >= orchestration.max_total_tokens || orchestration.cancel_requested_at) return false;
      const at = new Date().toISOString();
      const expiry = new Date(Date.now() + orchestration.max_runtime_ms + 60_000).toISOString();
      orchestration.attempts += 1;
      orchestration.retry_at = null;
      orchestration.lease = {
        run_id: runId,
        worker_id: options.workerId ?? "direct",
        acquired_at: at,
        heartbeat_at: at,
        expires_at: expiry,
      };
      candidate.lifecycle = "running";
      candidate.started_at ??= at;
      candidate.updated_at = at;
      claimed = true;
    });
    if (!record || !claimed) return null;
    claimedRevision = record.revision ?? null;
    attempt = ensureTaskOrchestration(record).attempts;
    appendTaskEvent({
      task_id: taskId,
      type: "claimed",
      revision: record.revision!,
      run_id: runId,
      attempt,
      payload: { worker_id: options.workerId ?? "direct" },
    });
  }

  const initial = readTask(taskId);
  if (!initial) return null;
  const initialOrchestration = ensureTaskOrchestration(initial);
  if (initial.lifecycle !== "running" || initialOrchestration.lease?.run_id !== runId) return null;
  attempt = initialOrchestration.attempts;
  claimedRevision ??= initial.revision ?? 1;
  const workflowOwner = workflowExecutionOwner(options.workflowExecution, taskId, runId);
  let workflow: ReturnType<import("./workflow-orchestrator").WorkflowOrchestrator["prepare"]> | undefined;
  let workflowUsageComplete = true; // No model effect has begun yet.
  const span = (options.tracer ?? noOpTracer).startSpan("task.attempt", {
    task_id: taskId,
    project: initial.envelope.project,
    agent: initial.envelope.agent,
    attempt,
  });
  let spanStatus: "ok" | "error" = "error";

  mkdirSync(join(repoRoot, "reports"), { recursive: true });
  const startedAt = new Date().toISOString();
  const logsPath = join("reports", `${initial.envelope.id}-${initial.envelope.agent}-${startedAt.replace(/[:.]/g, "")}.jsonl`);
  const absLogsPath = join(repoRoot, logsPath);
  let attemptTokens = 0;
  let abortKind: AbortKind | null = null;
  const controller = new AbortController();

  const ownedMutation = (mutate: (record: TaskRecord) => void): TaskRecord | null => {
    let owned = false;
    const updated = updateTask(taskId, (record) => {
      const orchestration = ensureTaskOrchestration(record);
      if (record.lifecycle !== "running" || orchestration.lease?.run_id !== runId) return false;
      if (record.envelope.context_manifest && Date.parse(orchestration.lease.expires_at) <= Date.now()) return false;
      mutate(record);
      record.updated_at = new Date().toISOString();
      owned = true;
    });
    return owned ? updated : null;
  };

  const writeLog = (obj: unknown): void => {
    try {
      writeFileSync(absLogsPath, `${safeJson(obj)}\n`, { encoding: "utf8", flag: "a" });
    } catch {
      /* logging must never break the run */
    }
  };

  const appendOwnedEvent = (record: TaskRecord, type: Parameters<typeof appendTaskEvent>[0]["type"], payload: Record<string, unknown> = {}): void => {
    appendTaskEvent({
      task_id: taskId,
      type,
      revision: record.revision!,
      run_id: runId,
      attempt,
      payload,
    });
  };

  const finish = (
    outcome: AgentOutcome,
    result: AgentResult,
    retryable: boolean,
    failureKind?: TaskFailureKind,
    reason?: string,
  ): TaskRunCompletion => {
    if (workflowOwner) {
      try {
        workflowOwner.settle(options.workflowExecution!, attemptTokens, Math.max(0, Date.now() - Date.parse(startedAt)), workflowUsageComplete);
        if (!workflowUsageComplete && (outcome === "completed" || outcome === "partial")) {
          outcome = "needs-review"; retryable = false; failureKind = "terminal"; reason = "Workflow final usage is unknown; retained facts require human review";
          result = failureResult(initial.envelope, reason, logsPath); result.status = "needs-review";
        }
      }
      catch {
        outcome = "needs-review"; retryable = false; failureKind = "terminal"; reason = "Workflow completion accounting could not be fenced; retained facts require review";
        result = failureResult(initial.envelope, reason, logsPath); result.status = "needs-review";
      }
    }
    const finished = ownedMutation((record) => {
      const at = new Date().toISOString();
      const orchestration = ensureTaskOrchestration(record);
      orchestration.lease = null;
      orchestration.last_failure = failureKind && reason ? { kind: failureKind, message: reason, at, run_id: runId } : null;
      record.lifecycle = "finished";
      record.finished_at = at;
      record.outcome = outcome;
      record.result = result;
      record.logs_path = logsPath;
    });
    if (!finished) return { outcome, retryable: false, reason, stale: true };
    appendOwnedEvent(finished, eventType(outcome), { outcome, retryable, ...(reason ? { reason } : {}) });
    spanStatus = outcome === "completed" || outcome === "partial" ? "ok" : "error";
    span.addEvent("task.finished", { outcome, retryable });
    return { outcome, retryable, reason, stale: false };
  };

  const startRecord = ownedMutation((record) => {
    record.logs_path = logsPath;
    if (span.context) {
      record.envelope.metadata.run = {
        ...metadataRun(record),
        trace_id: span.context.traceId,
        span_id: span.context.spanId,
      };
    }
  });
  if (!startRecord) return { outcome: "failed", retryable: false, reason: "attempt lease is no longer current", stale: true };
  appendOwnedEvent(startRecord, "started", {
    claimed_revision: claimedRevision,
    ...(span.context ? { trace_id: span.context.traceId, span_id: span.context.spanId } : {}),
  });
  span.addEvent("task.started");

  const onExternalAbort = (): void => {
    if (controller.signal.aborted) return;
    const current = readTask(taskId);
    abortKind = current?.orchestration?.cancel_requested_at ? "cancelled" : "interrupted";
    controller.abort(options.signal?.reason);
  };
  if (options.signal?.aborted) onExternalAbort();
  else options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    abortKind = "timeout";
    controller.abort(new Error("task runtime budget exhausted"));
  }, initialOrchestration.max_runtime_ms);

  const recordUsage = (usage: AgentUsage): boolean => {
    const delta = Math.max(0, usage.totalTokens - attemptTokens);
    attemptTokens = Math.max(attemptTokens, usage.totalTokens);
    let cumulative = initialOrchestration.cumulative_tokens;
    let maxTokens = initialOrchestration.max_total_tokens;
    if (delta > 0) {
      const updated = ownedMutation((record) => {
        const orchestration = ensureTaskOrchestration(record);
        orchestration.cumulative_tokens += delta;
        cumulative = orchestration.cumulative_tokens;
        maxTokens = orchestration.max_total_tokens;
      });
      if (updated) appendOwnedEvent(updated, "usage", { delta_tokens: delta, attempt_tokens: attemptTokens, cumulative_tokens: cumulative });
    }
    if (workflowOwner && workflowOwner.observe(options.workflowExecution!, attemptTokens, Math.max(0, Date.now() - Date.parse(startedAt))) && !controller.signal.aborted) {
      abortKind = "tokens"; controller.abort(new Error("workflow aggregate budget exhausted"));
    }
    if (cumulative > maxTokens && !controller.signal.aborted) {
      abortKind = "tokens";
      controller.abort(new Error("task token budget exhausted"));
    }
    return cumulative > maxTokens;
  };

  const handleAgentEvent = async (event: AgentEvent): Promise<void> => {
    writeLog({ event });
    if (event.type === "thread-started" || event.type === "turn-started") {
      const updated = ownedMutation((record) => {
        const run = metadataRun(record);
        run.thread_id = event.threadId;
        if (event.type === "turn-started") run.turn_id = event.turnId;
        record.envelope.metadata.run = run;
      });
      if (updated) appendOwnedEvent(updated, event.type, event.type === "turn-started" ? { turn_id: event.turnId } : { thread_id: event.threadId });
      return;
    }
    if (event.type === "usage") {
      recordUsage(event.usage);
      span.addEvent("agent.usage", { total_tokens: event.usage.totalTokens });
      return;
    }
    if (event.type === "approval") {
      const updated = ownedMutation(() => {});
      if (updated) {
        appendOwnedEvent(updated, "approval-recorded", {
          approval: event.approval,
          allowed: event.allowed,
          thread_id: event.threadId,
          turn_id: event.turnId,
        });
      }
      span.addEvent("agent.approval", { approval: event.approval, allowed: event.allowed });
      return;
    }
    if (event.type === "warning") {
      const updated = ownedMutation(() => {});
      if (updated) appendOwnedEvent(updated, "warning", { message: event.message.slice(0, 1_000) });
      span.addEvent("agent.warning");
    }
  };

  try {
    switch (contextAdmissionVersion(initial.envelope.context_admission)) {
      case 2: {
        if (!workflowOwner) rejectStandaloneWorkflowStage();
        workflow = workflowOwner.prepare(options.workflowExecution!);
        if (!["analysis", "planning", "implementation", "review", "qa", "operations", "correction"].includes(workflow.stage.kind)) {
          throw new ContextContractError("This workflow stage remains disabled until its approved implementation slice");
        }
        break;
      }
      case 1: break;
      case "legacy": break;
    }
    let governed: Pick<AdmittedContext, "preview" | "rendered" | "testingPlan"> | undefined = workflow?.context;
    if (!initial.envelope.context_manifest && attempt > 1) throw new ContextPreviewError("Legacy retries require a new confirmed governed task");
    if (initial.envelope.context_manifest && !workflow) {
      try { governed = createContextService(repoRoot).revalidateTask(initial); }
      catch { throw new ContextPreviewError("Governed execution context is missing, changed or no longer authorized; a new confirmed task is required"); }
    }
    const linkedIssue = issueContext(initial, workflow);
    if (linkedIssue) {
      const gate = createIssueService(repoRoot).executionGate({ issueId: linkedIssue.issueId, taskId, executionId: runId, scopeRevision: linkedIssue.scopeRevision });
      if (gate !== "allowed") {
        const reason = gate === "candidate-ready"
          ? "lease recovery found a verified immutable candidate; no new write attempt was admitted"
          : "issue authorization or scope is no longer current; explicit issue review is required before execution";
        writeLog({ issue_execution_gate: gate, task_id: taskId, run_id: runId, reason });
        const result = failureResult(initial.envelope, reason, logsPath);
        result.status = "needs-review";
        result.summary = gate === "candidate-ready"
          ? "A verified immutable candidate was recovered; execution stopped without another write attempt."
          : "Execution stopped because the linked issue no longer admits this task attempt.";
        result.blockers = [reason];
        result.next_steps = [gate === "candidate-ready"
          ? "Review the existing candidate and its evidence; no files were changed by this recovered attempt."
          : "Resolve the issue decision or scope revision, then dispatch a new linked task." ];
        return finish("needs-review", result, false, "terminal", reason);
      }
    }
    const policy = new PolicyService(repoRoot);
    let allowed: ReturnType<typeof policy.authorizeTask>;
    try {
      allowed = policy.authorizeTask(initial.envelope);
      const policyRecord = ownedMutation(() => {});
      if (policyRecord) appendOwnedEvent(policyRecord, "policy-evaluated", { boundary: "execution", allowed: true });
      span.addEvent("policy.evaluated", { boundary: "execution", allowed: true });
    } catch (error) {
      if (error instanceof PolicyError) {
        const policyRecord = ownedMutation(() => {});
        if (policyRecord) appendOwnedEvent(policyRecord, "policy-evaluated", { boundary: "execution", allowed: false, reason: error.message });
        span.addEvent("policy.evaluated", { boundary: "execution", allowed: false });
      }
      throw error;
    }
    const cwd = workflow?.stage.sandbox === "workspace-write" ? expandHome(allowed.project.repo_path!) : workflow?.cwd ?? expandHome(allowed.project.repo_path!);
    const agent = allowed.agent;
    const verifyCommands = initial.envelope.sandbox === "workspace-write" && (!governed || governed.preview.manifest.tools.includes("verify-configured")) ? governed?.testingPlan.runners.map((runner) => runner.command) ?? allowed.project.verify_commands : [];
    if (governed?.testingPlan.mode === "strict-tdd" && !workflow) {
      if (initial.envelope.sandbox !== "workspace-write" || !governed.preview.manifest.tools.includes("verify-configured")) throw new ContextPreviewError("Strict TDD requires authorized worktree verification capability");
      validateTestingProbes(cwd, governed.testingPlan);
    }
    const wantsVerify = initial.envelope.self_verify === true && verifyCommands.length > 0;
    const mode = wantsVerify
      ? "workspace-write-verify"
      : initial.envelope.sandbox === "workspace-write"
        ? "workspace-write"
        : "read-only";
    const previousRun = metadataRun(initial);
    const threadId = workflow ? workflow.thread.threadId : typeof previousRun.thread_id === "string" ? previousRun.thread_id : undefined;
    const contractFingerprint = workflow?.thread.fingerprint ?? (governed ? contextHash(JSON.stringify({ manifest: governed.preview.fingerprint, version: GOVERNED_PROMPT_VERSION, mode, cwd, verifyCommands, outputSchema: AGENT_REPORT_SCHEMA })) : undefined);
    if (threadId && (!contractFingerprint || previousRun.context_fingerprint !== contractFingerprint)) {
      throw new ContextPreviewError("Thread admission binding is missing or changed; a new confirmed task is required");
    }
    // Invalid structured output can have raw text in its legacy result summary.
    // Never promote that text into the governed resume layer.
    const priorSummary = (initial.result?.status !== "needs-review" ? initial.result?.summary : undefined)
      ?? (typeof previousRun.prior_summary === "string" ? previousRun.prior_summary : undefined);
    const prompts = governed ? buildGovernedPrompts(governed.rendered, initial.envelope, governed.preview.manifest.limits, priorSummary) : null;
    const systemPrompt = prompts?.developerInstructions ?? buildSystemPrompt(agent, readFileSync(join(repoRoot, "AGENTS.md"), "utf8"), mode, verifyCommands);
    const prompt = prompts?.prompt ?? buildUserPrompt(initial.envelope);
    if (governed) {
      const contextRecord = ownedMutation((record) => {
        record.envelope.metadata.run = { ...metadataRun(record), context_fingerprint: contractFingerprint,
          ...(workflow ? { workflow_task_id: taskId, workflow_stage_id: workflow.stage.id, workflow_generation: workflow.stage.generation } : {}) };
      });
      if (!contextRecord) return { outcome: "failed", retryable: false, reason: "attempt lease is no longer current", stale: true };
      appendOwnedEvent(contextRecord, "policy-evaluated", { boundary: "execution-context", allowed: true, fingerprint: governed.preview.fingerprint, role_id: governed.preview.manifest.role_id, bytes: prompts!.bytes, lines: prompts!.lines });
    }
    const runAgent = (runCwd: string) => {
      if (controller.signal.aborted) { const error = new Error("task interrupted before model invocation"); error.name = "AbortError"; throw error; }
      if (!ownedMutation(() => {})) throw new ContextPreviewError("Attempt ownership changed before model invocation");
      if (workflowOwner) { workflowOwner.prepare(options.workflowExecution!); workflowUsageComplete = false; }
      return executor.run(
        {
          cwd: runCwd,
          developerInstructions: systemPrompt,
          prompt,
          mode,
          model: process.env.SURTEC_CODEX_MODEL?.trim() || undefined,
          reasoningEffort: process.env.SURTEC_CODEX_REASONING_EFFORT?.trim() || undefined,
          verifyCommands,
          outputSchema: workflow?.outputSchema ?? AGENT_REPORT_SCHEMA as unknown as Record<string, unknown>,
          threadId,
          contextFingerprint: contractFingerprint,
          resumeContextFingerprint: typeof previousRun.context_fingerprint === "string" ? previousRun.context_fingerprint : undefined,
        },
        handleAgentEvent,
        controller.signal,
      );
    };

    if (initial.envelope.sandbox === "workspace-write") {
      if (controller.signal.aborted) { const error = new Error("task interrupted before worktree creation"); error.name = "AbortError"; throw error; }
      if (!ownedMutation(() => {})) throw new ContextPreviewError("Attempt ownership changed before worktree creation");
      if (!existsSync(join(cwd, ".git"))) throw new PolicyError(`not a git repository: ${cwd}`);
      let correctionBase: string | undefined;
      if (workflow?.stage.kind === "correction") {
        const prior = workflow.stage.candidate, owner = prior ? readTask(prior.task_id) : null;
        if (!prior || !owner || prior.candidate_revision !== workflow.admission.candidate?.candidate_revision) throw new ContextContractError("Correction no longer has its exact admitted candidate base");
        try { inspectCandidateTree(cwd, owner, prior, repoRoot); }
        catch { throw new ContextContractError("Prior correction candidate tree is missing, changed or cannot be safely inspected"); }
        correctionBase = prior.candidate_revision;
      }
      const { branch, worktreePath } = createWorktree(cwd, initial.envelope.id, initial.envelope.agent, correctionBase);
      const worktreeRecord = ownedMutation((record) => {
        record.envelope.metadata.run = { ...metadataRun(record), mode, branch, worktree_path: worktreePath };
      });
      if (!worktreeRecord) return { outcome: "failed", retryable: false, reason: "attempt lease is no longer current", stale: true };
      appendOwnedEvent(worktreeRecord, "worktree-created", { branch });
      span.addEvent("worktree.created", { branch });
      const captureOptions = { signal: controller.signal, deadline: Date.parse(startedAt) + initialOrchestration.max_runtime_ms, ownsAttempt: () => {
        const current = readTask(taskId);
        return current?.lifecycle === "running" && current.orchestration?.lease?.run_id === runId && !current.orchestration.cancel_requested_at && Date.parse(current.orchestration.lease.expires_at) > Date.now();
      }, controlPlaneRoot: repoRoot, authorizeCommand: (command: string) => {
        if (!governed || !governed.preview.manifest.tools.includes("verify-configured") || initial.envelope.self_verify !== true) return false;
        try {
          const currentPolicy = new PolicyService(repoRoot);
          const current = currentPolicy.authorizeTask(initial.envelope);
          currentPolicy.authorizeRole({ project: initial.envelope.project, agent: initial.envelope.agent, roleId: governed.preview.manifest.role_id, taskKind: initial.envelope.task_type, sandbox: initial.envelope.sandbox, selfVerify: true });
          const configuredSource = governed.preview.manifest.sources.find((source) => source.id === "policy/context-config");
          // Assembly hashes the attributed string containing the config digest.
          return current.project.verify_commands.includes(command) && configuredSource?.revision === contextHash(contextHash(JSON.stringify(readContextConfig(repoRoot))));
        } catch { return false; }
      } };
      let testingEvidence: TestingEvidence | undefined = governed ? createTestingEvidence(initial, runId, governed.testingPlan) : undefined;
      const persistTesting = () => {
        if (!testingEvidence) return;
        const { fingerprint: _fingerprint, ...unsigned } = testingEvidence;
        testingEvidence = sealTestingEvidence(unsigned);
        if (!ownedMutation((record) => { record.testing_evidence = testingEvidence; })) throw new ContextPreviewError("Attempt ownership changed before testing evidence persistence");
      };
      if (governed?.testingPlan.mode === "strict-tdd") {
        const red = await captureVerification(worktreePath, governed.testingPlan.runners.filter((runner) => runner.stage === "red"), captureOptions);
        testingEvidence!.observations.push(...red.observations);
        persistTesting();
        if (red.report.status !== "passed") throw new ContextPreviewError("RED did not observe the configured behavioral assertion failure; no implementation turn was admitted");
      }
      const implementationStarted = new Date().toISOString();
      const agentRun = await runAgent(worktreePath);
      if (workflowOwner) workflowUsageComplete = !!agentRun.usage;
      if (testingEvidence) testingEvidence.implementation = { started_at: implementationStarted, finished_at: new Date().toISOString(), thread_id: agentRun.threadId, turn_id: agentRun.turnId };
      if (agentRun.usage && recordUsage(agentRun.usage)) {
        const error = new Error("task token budget exhausted");
        error.name = "AbortError";
        throw error;
      }
      if (controller.signal.aborted) { const error = new Error("task interrupted before commit"); error.name = "AbortError"; throw error; }
      if (!ownedMutation(() => {})) return { outcome: "failed", retryable: false, reason: "attempt lease is no longer current", stale: true };
      // Re-read the exact workflow admission after the model turn and before
      // any repository write. This fences source, policy, scope and lease drift.
      if (workflowOwner) workflowOwner.prepare(options.workflowExecution!);
      const issue = issueContext(initial, workflow);
      const issueService = issue ? createIssueService(repoRoot) : null;
      const { filesChanged, diffstat, committed, patch, patchTruncated, baseRevision, candidateRevision } = commitAndDiff(
        worktreePath,
        `agent ${initial.envelope.id}: ${initial.envelope.title}`.slice(0, 72),
        issue && issueService ? { validateChangedPaths: (paths) => {
          const outside = pathsOutsideScope(paths, issue.scope);
          if (outside.length) throw new IssueScopeViolationError(issue.issueId, initial.envelope.id, outside);
          if (workflow?.stage.kind === "correction") {
            const role = new PolicyService(repoRoot).authorizeRole({ project: initial.envelope.project, agent: initial.envelope.agent,
              roleId: "software-engineer", taskKind: "implementation", sandbox: "workspace-write", selfVerify: true }).role;
            const commands = new Set(governed!.preview.manifest.testing.commands);
            const probes = Object.values(readContextConfig(repoRoot).runners).filter((runner) => commands.has(runner.command))
              .flatMap((runner) => runner.probe?.sources.map((source) => source.path) ?? []);
            const reasons = correctionPathReasons({ paths, scope: issue.scope, policy: readWorkflowPolicy(repoRoot),
              trusted_source_paths: ["AGENTS.md", ...role.required_evaluation_ids], verification_probe_paths: probes });
            if (reasons.length) throw new ContextContractError("Correction changed protected policy, approval or verification paths; human direction is required");
          }
        } } : undefined,
      );
      const candidate = issue && issueService && committed && baseRevision && candidateRevision
        ? issueService.recordCandidate({ issueId: issue.issueId, taskId: initial.envelope.id, executionId: runId, repositoryId: initial.envelope.project, baseRevision, candidateRevision, changedPaths: filesChanged, scopeRevision: issue.scopeRevision })
        : null;
      let verification = committed && !governed ? runVerification(worktreePath, verifyCommands) : null;
      if (governed && testingEvidence) {
        if (candidate) testingEvidence.candidate = { id: candidate.id, base_revision: candidate.base_revision, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint };
        if (committed && candidateRevision) {
          try {
            const captured = await captureVerification(worktreePath, governed.testingPlan.runners.filter((runner) => runner.stage !== "red").sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage)), { ...captureOptions, expectedRevision: candidateRevision });
            verification = captured.report;
            testingEvidence.observations.push(...captured.observations);
          } catch {
            // Unobservable post-commit state must expose the existing issue decision
            // path, not leave a candidate falsely verified or stranded in checking.
            verification = { status: "failed", checks: [] };
          }
        }
        persistTesting();
      }
      const diffPath = committed ? `reports/${initial.envelope.id}-${runId}.diff` : null;
      if (diffPath) writeFileSync(join(repoRoot, diffPath), patch, "utf8");
      writeLog({ task_id: initial.envelope.id, mode, thread_id: agentRun.threadId, turn_id: agentRun.turnId, branch, worktree_path: worktreePath, committed, diffstat, diff_path: diffPath, diff_truncated: patchTruncated, verification, usage: agentRun.usage, structured_output: agentRun.structuredOutput });
      const evidenceRecord = ownedMutation((record) => {
        record.envelope.metadata.run = {
          ...metadataRun(record),
          mode,
          thread_id: agentRun.threadId,
          turn_id: agentRun.turnId,
          branch,
          worktree_path: worktreePath,
          diffstat,
          committed,
          diff_path: diffPath,
          diff_truncated: patchTruncated,
          verification,
          usage: agentRun.usage,
        };
      });
      if (evidenceRecord && diffPath) {
        appendOwnedEvent(evidenceRecord, "diff-captured", { path: diffPath, bytes: Buffer.byteLength(patch, "utf8"), truncated: patchTruncated });
      }
      if (evidenceRecord && verification) {
        appendOwnedEvent(evidenceRecord, "verification", { status: verification.status, checks: verification.checks.length, ...(testingEvidence ? { testing_evidence_fingerprint: testingEvidence.fingerprint } : {}) });
      }
      span.addEvent("git.diff", { committed, files_changed: filesChanged.length, truncated: patchTruncated });
      if (verification) span.addEvent("verification.finished", { status: verification.status, checks: verification.checks.length });
      const result = toAgentResult(initial.envelope, agentRun.structuredOutput, agentRun.finalText, logsPath, filesChanged, verification);
      if (testingEvidence && testingEvidenceStatus(testingEvidence) !== "passed" && ["completed", "partial"].includes(result.status)) {
        result.status = "needs-review";
        result.blockers = ["Captured testing evidence is failed or incomplete for the exact candidate."];
        result.next_steps = ["Resolve the verification decision and explicitly admit a new task; agent success claims cannot replace evidence."];
      }
      if (issue && issueService && candidate) {
        const evidenceStatus = verification?.status === "failed" ? "failed"
          : verification?.status === "passed" && (result.status === "completed" || result.status === "partial") ? "passed" : "informational";
        issueService.recordVerification({
          issueId: issue.issueId,
          taskId: initial.envelope.id,
          executionId: runId,
          candidateId: candidate.id,
          status: evidenceStatus,
          label: verification?.status === "skipped" ? "Verification skipped: no commands are configured for this project" : `Task verification ${verification?.status ?? "unavailable"}`,
          reference: verification ? `${verification.checks.length} configured command(s); ${verification.checks.filter((check) => check.ok).length} passed.` : "No verification report was produced.",
        });
      }
      if (controller.signal.aborted) { const error = new Error("task interrupted during verification"); error.name = "AbortError"; throw error; }
      const terminalReason = result.status === "needs-review"
        ? result.blockers[0] ?? "invalid structured agent output"
        : result.status === "failed" ? result.blockers[0] ?? result.summary : undefined;
      return finish(result.status, result, false, terminalReason ? "terminal" : undefined, terminalReason);
    }

    const agentRun = await runAgent(cwd);
    if (workflowOwner) workflowUsageComplete = !!agentRun.usage;
    if (agentRun.usage && recordUsage(agentRun.usage)) {
      const error = new Error("task token budget exhausted");
      error.name = "AbortError";
      throw error;
    }
    if (!workflow) writeLog({ task_id: initial.envelope.id, mode, thread_id: agentRun.threadId, turn_id: agentRun.turnId, usage: agentRun.usage, structured_output: agentRun.structuredOutput });
    ownedMutation((record) => {
      record.envelope.metadata.run = { ...metadataRun(record), mode, thread_id: agentRun.threadId, turn_id: agentRun.turnId, usage: agentRun.usage };
    });
    if (controller.signal.aborted) { const error = new Error("task interrupted before role completion"); error.name = "AbortError"; throw error; }
    const result = workflow && workflowOwner ? workflowOwner.captureOutput(options.workflowExecution!, workflow, agentRun.structuredOutput, logsPath)
      : toAgentResult(initial.envelope, agentRun.structuredOutput, agentRun.finalText, logsPath);
    const terminalReason = result.status === "needs-review"
      ? "invalid structured agent output"
      : result.status === "failed" ? result.blockers[0] ?? result.summary : undefined;
    return finish(result.status, result, false, terminalReason ? "terminal" : undefined, terminalReason);
  } catch (error) {
    const issue = issueContext(initial, workflow);
    if (error instanceof IssueScopeViolationError) {
      try { if (ownedMutation(() => {})) createIssueService(repoRoot).recordScopeFinding(error.issueId, error.taskId, error.paths); } catch { /* the task result remains needs-review if issue storage is unavailable */ }
    } else if (issue && (!workflowOwner || !controller.signal.aborted && !readTask(taskId)?.orchestration?.cancel_requested_at)) {
      try {
        const service = createIssueService(repoRoot);
        const live = service.get(issue.issueId).issue;
        // A context rejection must expose an explicit human-resume path without
        // blocking another task owner or altering a newer scope/candidate.
        if (ownedMutation(() => {}) && live.task_ids.at(-1) === taskId && live.scope_revision === issue.scopeRevision &&
            JSON.stringify(live.authorized_scope) === JSON.stringify(issue.scope)) {
          service.markBlocked(issue.issueId, initial.envelope.id, (error as Error)?.message ?? "issue task failed before producing a review candidate");
        }
      } catch { /* keep task failure durable when issue storage is unavailable */ }
    }
    let outcome: AgentOutcome = "failed";
    let retryable = false;
    let kind: TaskFailureKind;
    let reason: string;
    if ((error as Error)?.name === "AbortError" || controller.signal.aborted) {
      if (abortKind === "cancelled") {
        outcome = "cancelled";
        kind = "cancelled";
        reason = "cancelled by user";
      } else if (abortKind === "timeout") {
        kind = "budget";
        reason = `runtime budget exhausted (${initialOrchestration.max_runtime_ms}ms)`;
      } else if (abortKind === "tokens") {
        kind = "budget";
        reason = `token budget exhausted (${initialOrchestration.max_total_tokens})`;
      } else {
        kind = "transient";
        retryable = true;
        reason = "worker interrupted";
      }
    } else {
      kind = failureKindFor(error);
      retryable = kind === "transient";
      reason = redactText((error as Error)?.message ?? "unknown error");
    }
    if (error instanceof ContextPreviewError || error instanceof ContextContractError) {
      outcome = "needs-review";
      kind = "terminal";
      retryable = false;
      reason = error.message;
    }
    if (workflowOwner && !controller.signal.aborted && (error as Error)?.name !== "AbortError") {
      outcome = "needs-review"; kind = "terminal"; retryable = false;
      reason = "Workflow authority, context or execution failed; inspect retained facts before recovery.";
    }
    writeLog({ error: reason, failure_kind: kind });
    const result = outcome === "cancelled"
      ? cancelledResult(initial.envelope, reason, logsPath)
      : failureResult(initial.envelope, reason, logsPath);
    if (outcome === "needs-review") {
      result.status = "needs-review";
      result.next_steps = ["Resolve the context decision and explicitly admit a new task; no context was silently adopted."];
    }
    if (error instanceof IssueScopeViolationError) {
      outcome = "needs-review";
      kind = "terminal";
      retryable = false;
      result.status = "needs-review";
      result.summary = "Execution stopped before commit because changes exceeded the authorized issue scope.";
      result.blockers = error.paths.slice(0, 20).map((path) => redactText(path));
      result.next_steps = ["Review the recorded scope proposal. Approve a new scope revision or cancel the issue before dispatching again."];
    }
    return finish(outcome, result, retryable, kind, reason);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onExternalAbort);
    span.end(spanStatus);
  }
}
