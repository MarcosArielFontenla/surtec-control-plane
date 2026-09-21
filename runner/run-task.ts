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
import { buildSystemPrompt, buildUserPrompt } from "./agent-prompt";
import { AGENT_REPORT_SCHEMA } from "./agent-report";
import { cancelledResult, toAgentResult, failureResult } from "./result";
import { createWorktree, commitAndDiff } from "./worktree";
import { runVerification } from "./verify";
import { PolicyError, PolicyService } from "../lib/policy/service";
import { safeJson } from "../lib/security/redaction";
import { noOpTracer, type Tracer } from "../lib/observability/tracing";

export interface TaskRunOptions {
  signal?: AbortSignal;
  runId?: string;
  workerId?: string;
  tracer?: Tracer;
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
      if (orchestration.attempts >= orchestration.max_attempts || orchestration.cancel_requested_at) return false;
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
    const cwd = expandHome(allowed.project.repo_path!);
    const agent = allowed.agent;
    const agentsMd = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
    const verifyCommands = initial.envelope.sandbox === "workspace-write" ? allowed.project.verify_commands : [];
    const wantsVerify = initial.envelope.self_verify === true && verifyCommands.length > 0;
    const mode = wantsVerify
      ? "workspace-write-verify"
      : initial.envelope.sandbox === "workspace-write"
        ? "workspace-write"
        : "read-only";
    const systemPrompt = buildSystemPrompt(agent, agentsMd, mode, verifyCommands);
    const prompt = buildUserPrompt(initial.envelope);
    const previousRun = metadataRun(initial);
    const threadId = typeof previousRun.thread_id === "string" ? previousRun.thread_id : undefined;
    const runAgent = (runCwd: string) => executor.run(
      {
        cwd: runCwd,
        developerInstructions: systemPrompt,
        prompt,
        mode,
        model: process.env.SURTEC_CODEX_MODEL?.trim() || undefined,
        reasoningEffort: process.env.SURTEC_CODEX_REASONING_EFFORT?.trim() || undefined,
        verifyCommands,
        outputSchema: AGENT_REPORT_SCHEMA as unknown as Record<string, unknown>,
        threadId,
      },
      handleAgentEvent,
      controller.signal,
    );

    if (initial.envelope.sandbox === "workspace-write") {
      if (!existsSync(join(cwd, ".git"))) throw new PolicyError(`not a git repository: ${cwd}`);
      const { branch, worktreePath } = createWorktree(cwd, initial.envelope.id, initial.envelope.agent);
      const worktreeRecord = ownedMutation((record) => {
        record.envelope.metadata.run = { ...metadataRun(record), mode, branch, worktree_path: worktreePath };
      });
      if (!worktreeRecord) return { outcome: "failed", retryable: false, reason: "attempt lease is no longer current", stale: true };
      appendOwnedEvent(worktreeRecord, "worktree-created", { branch });
      span.addEvent("worktree.created", { branch });
      const agentRun = await runAgent(worktreePath);
      if (agentRun.usage && recordUsage(agentRun.usage)) {
        const error = new Error("task token budget exhausted");
        error.name = "AbortError";
        throw error;
      }
      if (!ownedMutation(() => {})) return { outcome: "failed", retryable: false, reason: "attempt lease is no longer current", stale: true };
      const { filesChanged, diffstat, committed, patch, patchTruncated } = commitAndDiff(
        worktreePath,
        `agent ${initial.envelope.id}: ${initial.envelope.title}`.slice(0, 72),
      );
      const verification = committed ? runVerification(worktreePath, verifyCommands) : null;
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
        appendOwnedEvent(evidenceRecord, "verification", { status: verification.status, checks: verification.checks.length });
      }
      span.addEvent("git.diff", { committed, files_changed: filesChanged.length, truncated: patchTruncated });
      if (verification) span.addEvent("verification.finished", { status: verification.status, checks: verification.checks.length });
      const result = toAgentResult(initial.envelope, agentRun.structuredOutput, agentRun.finalText, logsPath, filesChanged, verification);
      const terminalReason = result.status === "needs-review"
        ? "invalid structured agent output"
        : result.status === "failed" ? result.blockers[0] ?? result.summary : undefined;
      return finish(result.status, result, false, terminalReason ? "terminal" : undefined, terminalReason);
    }

    const agentRun = await runAgent(cwd);
    if (agentRun.usage && recordUsage(agentRun.usage)) {
      const error = new Error("task token budget exhausted");
      error.name = "AbortError";
      throw error;
    }
    writeLog({ task_id: initial.envelope.id, mode, thread_id: agentRun.threadId, turn_id: agentRun.turnId, usage: agentRun.usage, structured_output: agentRun.structuredOutput });
    ownedMutation((record) => {
      record.envelope.metadata.run = { ...metadataRun(record), mode, thread_id: agentRun.threadId, turn_id: agentRun.turnId, usage: agentRun.usage };
    });
    const result = toAgentResult(initial.envelope, agentRun.structuredOutput, agentRun.finalText, logsPath);
    const terminalReason = result.status === "needs-review"
      ? "invalid structured agent output"
      : result.status === "failed" ? result.blockers[0] ?? result.summary : undefined;
    return finish(result.status, result, false, terminalReason ? "terminal" : undefined, terminalReason);
  } catch (error) {
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
      reason = (error as Error)?.message ?? "unknown error";
    }
    writeLog({ error: reason, failure_kind: kind });
    const result = outcome === "cancelled"
      ? cancelledResult(initial.envelope, reason, logsPath)
      : failureResult(initial.envelope, reason, logsPath);
    return finish(outcome, result, retryable, kind, reason);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onExternalAbort);
    span.end(spanStatus);
  }
}
