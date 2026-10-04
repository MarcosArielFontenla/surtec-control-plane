// Test-only API bootstrap. Real application/orchestrator/Git/verification,
// with a deterministic injected executor; never starts the paid runtime.
import assert from "node:assert/strict";
import { existsSync, realpathSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "../../dashboard/src/server/index";
import { TaskOrchestrator } from "../../runner/task-orchestrator";
import type { AgentExecutor } from "../../runner/agent-executor";

const root = realpathSync(process.env.SURTEC_SMOKE_FIXTURE_ROOT ?? "");
const relativeRoot = relative(realpathSync(tmpdir()), root);
assert.ok(relativeRoot && !relativeRoot.startsWith(`..${sep}`) && relativeRoot !== ".." && !isAbsolute(relativeRoot) && basename(root).startsWith("surtec-local-dashboard-"), "test bootstrap requires its owned OS-temp fixture");
assert.equal(resolve(process.env.SURTEC_STATE_DIR ?? ""), join(root, "state"));
assert.equal(resolve(process.env.SURTEC_PROJECTS_ROOT ?? ""), join(root, "projects"));
assert.equal(process.env.NODE_ENV, "test");
const disabledRuntime = join(root, "forbidden-paid-runtime");
assert.equal(process.env.SURTEC_CODEX_BIN, disabledRuntime);
assert.equal(existsSync(disabledRuntime), false, "real runtime entry must not exist in the fixture");

const executor: AgentExecutor = {
  async run(options) {
    assert.ok(["read-only", "workspace-write", "workspace-write-verify"].includes(options.mode), "fake executor refuses unknown execution modes");
    const worktree = realpathSync(options.cwd);
    const boundary = join(root, "projects", "surtec-worktrees") + sep;
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
const worker = new TaskOrchestrator({ repoRoot: root, executor, pollMs: 50 });
worker.start();
const app = createApp(root, worker, undefined, undefined, { inbox: async () => ({ items: [], repos: [] }) });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: Number(process.env.PORT) });
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await worker.stop(); server.close(); };
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
