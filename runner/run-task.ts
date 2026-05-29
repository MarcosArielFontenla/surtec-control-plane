import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentOutcome, AgentResult } from "../lib/state/types";
import { readTask, writeTask } from "../lib/state/store";
import { expandHome } from "../lib/expand-home";
import { runAgent } from "./claude";
import { buildSystemPrompt, buildUserPrompt } from "./agent-prompt";
import { loadRegistryAgents } from "./registry-agents";
import { toAgentResult, failureResult } from "./result";
import { createWorktree, commitAndDiff } from "./worktree";
import { runVerification } from "./verify";
import { loadProjectVerifyCommands } from "./registry-project";

export async function runTask(taskId: string, repoRoot: string = process.cwd()): Promise<void> {
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
      writeFileSync(absLogsPath, JSON.stringify(obj) + "\n", { encoding: "utf8", flag: "a" });
    } catch {
      /* logging must never break the run */
    }
  };

  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      writeLog({ error: "missing ANTHROPIC_API_KEY" });
      finish("failed", failureResult(rec.envelope, "missing ANTHROPIC_API_KEY", logsPath));
      return;
    }
    const cwd = expandHome(rec.envelope.repo_path);
    if (!existsSync(cwd)) {
      const reason = `repo not found at ${cwd}`;
      writeLog({ error: reason });
      finish("failed", failureResult(rec.envelope, reason, logsPath));
      return;
    }
    const agent = loadRegistryAgents(repoRoot).find((a) => a.id === rec.envelope.agent);
    if (!agent) {
      const reason = `unknown agent: ${rec.envelope.agent}`;
      writeLog({ error: reason });
      finish("failed", failureResult(rec.envelope, reason, logsPath));
      return;
    }
    const agentsMd = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
    const verifyCommands =
      rec.envelope.sandbox === "workspace-write" ? loadProjectVerifyCommands(repoRoot, rec.envelope.project) : [];
    const wantsVerify = rec.envelope.self_verify === true && verifyCommands.length > 0;
    const mode = wantsVerify
      ? "workspace-write-verify"
      : rec.envelope.sandbox === "workspace-write"
        ? "workspace-write"
        : "read-only";
    const systemPrompt = buildSystemPrompt(agent, agentsMd, mode, verifyCommands);
    const prompt = buildUserPrompt(rec.envelope);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
    try {
      if (rec.envelope.sandbox === "workspace-write") {
        if (!existsSync(join(cwd, ".git"))) {
          throw new Error(`not a git repository: ${cwd}`);
        }
        const { branch, worktreePath } = createWorktree(cwd, rec.envelope.id, rec.envelope.agent);
        const { text, costUsd, tokens } = await runAgent(
          { cwd: worktreePath, systemPrompt, prompt, mode, verifyCommands },
          controller.signal,
        );
        const { filesChanged, diffstat, committed } = commitAndDiff(
          worktreePath,
          `agent ${rec.envelope.id}: ${rec.envelope.title}`.slice(0, 72),
        );
        const verification = committed ? runVerification(worktreePath, verifyCommands) : null;
        writeLog({ task_id: rec.envelope.id, mode, branch, worktree_path: worktreePath, committed, diffstat, verification, cost_usd: costUsd, tokens, text });
        rec.envelope.metadata.run = { mode, branch, worktree_path: worktreePath, diffstat, committed, verification, cost_usd: costUsd, tokens };
        const result = toAgentResult(rec.envelope, text, logsPath, filesChanged, verification);
        finish(result.status, result);
      } else {
        const { text, costUsd, tokens } = await runAgent({ cwd, systemPrompt, prompt, mode }, controller.signal);
        writeLog({ task_id: rec.envelope.id, mode, cost_usd: costUsd, tokens, text });
        rec.envelope.metadata.run = { mode, cost_usd: costUsd, tokens };
        const result = toAgentResult(rec.envelope, text, logsPath);
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
