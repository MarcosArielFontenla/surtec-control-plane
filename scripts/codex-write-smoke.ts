import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { localGitEnvironment } from "../lib/security/environment";
import { managedGitArgs } from "../lib/security/managed-git.mjs";
import { assertPathWithin } from "../lib/security/paths";
import { redactText } from "../lib/security/redaction";
import { AGENT_REPORT_SCHEMA, validateAgentReport } from "../runner/agent-report";
import type { AgentEvent, AgentUsage } from "../runner/agent-executor";
import { codexExecutor } from "../runner/codex-executor";
import { commitAndDiff, createWorktree, removeWorktree, type WorktreeInfo } from "../runner/worktree";
import { runVerification } from "../runner/verify";

const TEMP_PREFIX = "surtec-codex-write-smoke-";
const TARGET_FILE = "smoke-fixture.txt";
const PENDING_CONTENT = "SMOKE_STATUS=pending\n";
const COMPLETE_CONTENT = "SMOKE_STATUS=complete\n";
const MAX_TURN_MS = 5 * 60 * 1000;
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown runtime error";
  return redactText(message).slice(0, 1000);
}

function usageIsValid(value: unknown): value is AgentUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  return ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"]
    .every((key) => typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0);
}

function git(args: string[]): string {
  const result = spawnSync("git", managedGitArgs(args), {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    env: localGitEnvironment(),
  });
  if (result.status !== 0 || result.error) {
    const diagnostic = redactText((result.stderr ?? "").trim()).slice(0, 500);
    throw new Error(`disposable fixture Git command failed${diagnostic ? `: ${diagnostic}` : ""}`);
  }
  return result.stdout ?? "";
}

function createDisposableRepository(tempRoot: string): string {
  const sourceRepo = join(tempRoot, "repo");
  const templates = join(tempRoot, "empty-git-template");
  const hooks = join(tempRoot, "empty-git-hooks");
  mkdirSync(sourceRepo);
  mkdirSync(templates);
  mkdirSync(hooks);

  git(["init", "--initial-branch=master", `--template=${templates}`, sourceRepo]);
  git(["-C", sourceRepo, "config", "user.name", "Surtec Disposable Smoke"]);
  git(["-C", sourceRepo, "config", "user.email", "surtec-smoke@example.invalid"]);
  git(["-C", sourceRepo, "config", "core.hooksPath", hooks]);
  git(["-C", sourceRepo, "config", "core.autocrlf", "false"]);
  git(["-C", sourceRepo, "config", "commit.gpgsign", "false"]);

  writeFileSync(join(sourceRepo, TARGET_FILE), PENDING_CONTENT, "utf8");
  writeFileSync(join(sourceRepo, "verify-smoke.mjs"),
    `import { readFileSync } from "node:fs";\nif (readFileSync("${TARGET_FILE}", "utf8") !== "${COMPLETE_CONTENT.replaceAll("\n", "\\n")}") process.exit(1);\nconsole.log("disposable fixture state verified");\n`,
    "utf8");
  git(["-C", sourceRepo, "add", "--all"]);
  git(["-C", sourceRepo, "commit", "-m", "chore: initialize disposable smoke fixture"]);
  return sourceRepo;
}

function assertOwnedTempRoot(tempRoot: string): string {
  const canonicalRoot = realpathSync.native(tempRoot);
  const canonicalTemp = realpathSync.native(tmpdir());
  if (!basename(canonicalRoot).startsWith(TEMP_PREFIX)) throw new Error("refusing cleanup outside the smoke-owned temporary directory");
  return assertPathWithin(canonicalTemp, canonicalRoot, "smoke temporary root");
}

function assertOnlyFixtureChanged(worktreePath: string): void {
  const status = git(["-C", worktreePath, "status", "--porcelain", "--untracked-files=all"]);
  const lines = status.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  if (lines.length !== 1 || lines[0]?.slice(3) !== TARGET_FILE) {
    throw new Error("write smoke must modify only the controlled fixture file");
  }
  if (readFileSync(join(worktreePath, TARGET_FILE), "utf8") !== COMPLETE_CONTENT) {
    throw new Error("write smoke did not produce the expected controlled fixture content");
  }
}

async function runAgentWithinWorktreeEnvironment(
  worktreePath: string,
  events: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof codexExecutor.run>>> {
  const previousTemp = process.env.TEMP;
  const previousTmp = process.env.TMP;
  // The App Server's workspace-write policy includes OS temp roots unless excluded.
  // Pin both inherited Windows temp variables to this disposable worktree.
  process.env.TEMP = worktreePath;
  process.env.TMP = worktreePath;
  try {
    return await codexExecutor.run(
      {
        cwd: worktreePath,
        developerInstructions: "This is an isolated write-smoke fixture. Modify only smoke-fixture.txt in this temporary worktree. Do not access other paths or use network access.",
        prompt: "In smoke-fixture.txt replace the exact line SMOKE_STATUS=pending with SMOKE_STATUS=complete. Do not change any other file. Return a concise structured report of the change.",
        mode: "workspace-write",
        model: process.env.SURTEC_CODEX_MODEL?.trim() || undefined,
        reasoningEffort: process.env.SURTEC_CODEX_REASONING_EFFORT?.trim() || undefined,
        outputSchema: AGENT_REPORT_SCHEMA as unknown as Record<string, unknown>,
      },
      events,
      signal,
    );
  } finally {
    if (previousTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = previousTemp;
    if (previousTmp === undefined) delete process.env.TMP;
    else process.env.TMP = previousTmp;
  }
}

async function runSmoke(): Promise<void> {
  let tempRoot: string | undefined;
  let sourceRepo: string | undefined;
  let worktree: WorktreeInfo | undefined;
  let failure: string | undefined;
  let resultSummary: Record<string, unknown> | undefined;
  let cleanupFailed = false;
  const controller = new AbortController();
  let interrupted = false;
  const interrupt = (): void => {
    interrupted = true;
    controller.abort();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  try {
    const canonicalTemp = realpathSync.native(tmpdir());
    tempRoot = mkdtempSync(join(canonicalTemp, TEMP_PREFIX));
    assertOwnedTempRoot(tempRoot);
    sourceRepo = createDisposableRepository(tempRoot);
    const taskId = `write-smoke-${randomUUID()}`;
    worktree = createWorktree(sourceRepo, taskId, "codex-smoke");

    const timer = setTimeout(() => controller.abort(), MAX_TURN_MS);
    let result: Awaited<ReturnType<typeof codexExecutor.run>>;
    let terminalStatus = "";
    try {
      result = await runAgentWithinWorktreeEnvironment(
        worktree.worktreePath,
        (event: AgentEvent) => {
          if (event.type === "turn-completed") terminalStatus = event.status;
        },
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
    }

    if (interrupted) throw new Error("write smoke was cancelled and the temporary fixture will be cleaned up");
    if (!result.threadId.trim() || !result.turnId.trim()) throw new Error("write smoke did not capture thread and turn identifiers");
    if (terminalStatus !== "completed") throw new Error("write smoke did not capture a completed terminal status");
    if (result.usage !== null && !usageIsValid(result.usage)) throw new Error("write smoke returned invalid usage data");
    const validated = validateAgentReport(result.structuredOutput);
    if (!validated.ok) throw new Error(`invalid structured report: ${validated.reason}`);
    if (validated.report.status !== "completed") throw new Error(`write-smoke report ended with status ${validated.report.status}`);

    assertOnlyFixtureChanged(worktree.worktreePath);
    const commit = commitAndDiff(worktree.worktreePath, "codex smoke: verify disposable write path");
    if (!commit.committed || commit.filesChanged.length !== 1 || commit.filesChanged[0] !== TARGET_FILE) {
      throw new Error("write smoke did not capture exactly one committed fixture change");
    }
    if (!commit.patch.includes(`diff --git a/${TARGET_FILE} b/${TARGET_FILE}`) || !commit.patch.includes(`+${COMPLETE_CONTENT.trimEnd()}`)) {
      throw new Error("write smoke did not capture the expected committed diff");
    }

    const verification = runVerification(worktree.worktreePath, ["node verify-smoke.mjs"]);
    if (verification.status !== "passed" || verification.checks.length !== 1 || !verification.checks[0]?.ok) {
      throw new Error("disposable write-smoke verification failed");
    }
    if (git(["-C", worktree.worktreePath, "status", "--porcelain", "--untracked-files=all"]).trim() !== "") {
      throw new Error("write-smoke verification left unexpected working-tree changes");
    }

    resultSummary = {
      status: validated.report.status,
      thread_id: result.threadId,
      turn_id: result.turnId,
      terminal_status: terminalStatus,
      usage: result.usage,
      files_changed: commit.filesChanged,
      committed: commit.committed,
      commit_id: git(["-C", worktree.worktreePath, "rev-parse", "HEAD"]).trim(),
      diffstat: commit.diffstat,
      diff_captured: commit.patch.length > 0,
      verification: verification.checks,
    };
  } catch (error) {
    failure = safeError(error);
  } finally {
    if (tempRoot) {
      try {
        if (worktree && sourceRepo) removeWorktree(sourceRepo, worktree.worktreePath, worktree.branch);
      } catch {
        cleanupFailed = true;
      }
      try {
        const ownedRoot = assertOwnedTempRoot(tempRoot);
        rmSync(ownedRoot, { recursive: true, force: false });
      } catch {
        cleanupFailed = true;
      }
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }

  if (cleanupFailed) failure = [failure, "explicit temporary repository/worktree cleanup was incomplete"].filter(Boolean).join("; ");
  if (failure) throw new Error(failure);
  if (!resultSummary) throw new Error("write smoke completed without a result summary");
  console.log(JSON.stringify({ ...resultSummary, cleanup_complete: true }));
}

if (process.env.SURTEC_CODEX_WRITE_SMOKE !== "1") {
  console.log("Codex write smoke skipped; set SURTEC_CODEX_WRITE_SMOKE=1 to opt in. This real turn can consume model quota.");
} else {
  console.warn("Starting a real Codex turn in a smoke-owned temporary Git repository; this can consume model quota. No project path is accepted and no push is performed.");
  try {
    await runSmoke();
  } catch (error) {
    console.error(`Codex write smoke failed: ${safeError(error)}`);
    process.exitCode = 1;
  }
}
