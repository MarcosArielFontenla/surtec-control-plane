import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentOutcome, AgentResult } from "../lib/state/types";
import type { AgentExecutor } from "./agent-executor";
import { readTask, writeTask } from "../lib/state/store";
import { expandHome } from "../lib/expand-home";
import { codexExecutor } from "./codex-executor";
import { buildSystemPrompt, buildUserPrompt } from "./agent-prompt";
import { AGENT_REPORT_SCHEMA } from "./agent-report";
import { toAgentResult, failureResult } from "./result";
import { createWorktree, commitAndDiff } from "./worktree";
import { runVerification } from "./verify";
import { PolicyService } from "../lib/policy/service";
import { safeJson } from "../lib/security/redaction";

export async function runTask(
  taskId: string,
  repoRoot: string = process.cwd(),
  executor: AgentExecutor = codexExecutor,
): Promise<void> {
  const rec = readTask(taskId);
  if (!rec) return;
  if (rec.lifecycle !== "queued") return; // already running/finished — do not re-run/clobber

  const start = new Date().toISOString();
  rec.lifecycle = "running";
  rec.started_at = start;
  rec.updated_at = start;
  writeTask(rec);

  mkdirSync(join(repoRoot, "reports"), { recursive: true });
  const logsPath = join("reports", `${rec.envelope.id}-${rec.envelope.agent}-${start.replace(/[:.]/g, "")}.jsonl`);
  const absLogsPath = join(repoRoot, logsPath);

  const finish = (outcome: AgentOutcome, result: AgentResult): void => {
    const end = new Date().toISOString();
    rec.lifecycle = "finished";
    rec.finished_at = end;
    rec.updated_at = end;
    rec.outcome = outcome;
    rec.result = result;
    rec.logs_path = logsPath;
    writeTask(rec);
  };

  const writeLog = (obj: unknown): void => {
    try {
      writeFileSync(absLogsPath, safeJson(obj) + "\n", { encoding: "utf8", flag: "a" });
    } catch {
      /* logging must never break the run */
    }
  };

  try {
    const allowed = new PolicyService(repoRoot).authorizeTask(rec.envelope);
    const cwd = expandHome(allowed.project.repo_path!);
    const agent = allowed.agent;
    const agentsMd = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
    const verifyCommands = rec.envelope.sandbox === "workspace-write" ? allowed.project.verify_commands : [];
    const wantsVerify = rec.envelope.self_verify === true && verifyCommands.length > 0;
    const mode = wantsVerify
      ? "workspace-write-verify"
      : rec.envelope.sandbox === "workspace-write"
        ? "workspace-write"
        : "read-only";
    const systemPrompt = buildSystemPrompt(agent, agentsMd, mode, verifyCommands);
    const prompt = buildUserPrompt(rec.envelope);
    const controller = new AbortController();
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
      },
      (event) => writeLog({ event }),
      controller.signal,
    );

    const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
    try {
      if (rec.envelope.sandbox === "workspace-write") {
        if (!existsSync(join(cwd, ".git"))) {
          throw new Error(`not a git repository: ${cwd}`);
        }
        const { branch, worktreePath } = createWorktree(cwd, rec.envelope.id, rec.envelope.agent);
        const agentRun = await runAgent(worktreePath);
        const { filesChanged, diffstat, committed } = commitAndDiff(
          worktreePath,
          `agent ${rec.envelope.id}: ${rec.envelope.title}`.slice(0, 72),
        );
        const verification = committed ? runVerification(worktreePath, verifyCommands) : null;
        writeLog({ task_id: rec.envelope.id, mode, thread_id: agentRun.threadId, turn_id: agentRun.turnId, branch, worktree_path: worktreePath, committed, diffstat, verification, usage: agentRun.usage, structured_output: agentRun.structuredOutput });
        rec.envelope.metadata.run = { mode, thread_id: agentRun.threadId, turn_id: agentRun.turnId, branch, worktree_path: worktreePath, diffstat, committed, verification, usage: agentRun.usage };
        const result = toAgentResult(rec.envelope, agentRun.structuredOutput, agentRun.finalText, logsPath, filesChanged, verification);
        finish(result.status, result);
      } else {
        const agentRun = await runAgent(cwd);
        writeLog({ task_id: rec.envelope.id, mode, thread_id: agentRun.threadId, turn_id: agentRun.turnId, usage: agentRun.usage, structured_output: agentRun.structuredOutput });
        rec.envelope.metadata.run = { mode, thread_id: agentRun.threadId, turn_id: agentRun.turnId, usage: agentRun.usage };
        const result = toAgentResult(rec.envelope, agentRun.structuredOutput, agentRun.finalText, logsPath);
        finish(result.status, result);
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const reason = (err as Error)?.name === "AbortError" ? "timeout (5m)" : (err as Error)?.message ?? "unknown error";
    writeLog({ error: reason });
    finish("failed", failureResult(rec.envelope, reason, logsPath));
  }
}
