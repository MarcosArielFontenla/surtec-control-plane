import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_REPORT_SCHEMA, validateAgentReport } from "../runner/agent-report";
import type { AgentEvent, AgentUsage } from "../runner/agent-executor";
import { codexExecutor } from "../runner/codex-executor";
import { redactText } from "../lib/security/redaction";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = resolve(root, "fixtures", "codex-smoke");
const FIXTURE_README = "This directory is intentionally small and immutable during the opt-in read-only runtime smoke.";
const MAX_TURN_MS = 2 * 60 * 1000;

function assertReadFixture(): void {
  const canonicalRoot = realpathSync.native(root);
  const canonicalFixture = realpathSync.native(fixture);
  if (canonicalFixture !== resolve(canonicalRoot, "fixtures", "codex-smoke")) {
    throw new Error("read-only smoke fixture does not resolve to the repository-owned fixture");
  }
  const marker = join(canonicalFixture, "README.md");
  if (!lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink()) {
    throw new Error("read-only smoke fixture marker must be a regular repository-owned file");
  }
  if (readFileSync(marker, "utf8").trim() !== FIXTURE_README) {
    throw new Error("read-only smoke fixture marker is missing or unexpected");
  }
}

function snapshot(directory: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const visit = (current: string): void => {
    for (const name of readdirSync(current)) {
      const absolute = join(current, name);
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink()) throw new Error("read-only smoke fixture must not contain symbolic links");
      if (stats.isDirectory()) visit(absolute);
      else if (stats.isFile()) {
        entries[relative(directory, absolute).replaceAll("\\", "/")] = createHash("sha256").update(readFileSync(absolute)).digest("hex");
      } else {
        throw new Error("read-only smoke fixture contains an unsupported filesystem entry");
      }
    }
  };
  visit(directory);
  return entries;
}

function isUsage(value: unknown): value is AgentUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  return ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"]
    .every((key) => typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown runtime error";
  return redactText(message).slice(0, 1000);
}

function configuredCancellationDelay(): number | null {
  const configured = process.env.SURTEC_CODEX_READ_SMOKE_CANCEL_AFTER_MS;
  if (configured === undefined) return null;
  const delay = Number(configured);
  if (!Number.isInteger(delay) || delay < 250 || delay > MAX_TURN_MS) {
    throw new Error(`SURTEC_CODEX_READ_SMOKE_CANCEL_AFTER_MS must be an integer from 250 to ${MAX_TURN_MS}`);
  }
  return delay;
}

async function runCancellationCheck(cancelAfterMs: number): Promise<Record<string, unknown>> {
  assertReadFixture();
  const before = snapshot(fixture);
  const controller = new AbortController();
  const identifiers = { threadId: "", turnId: "" };
  let terminalStatus = "";
  let cancellationRequested = false;
  let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
  const hardTimeout = setTimeout(() => controller.abort(), MAX_TURN_MS + cancelAfterMs);
  let failure: unknown;
  try {
    await codexExecutor.run(
      {
        cwd: fixture,
        developerInstructions: "This is a read-only cancellation smoke. Inspect only the supplied fixture and do not modify any file.",
        prompt: "Read the fixture and briefly explain its purpose. This turn is used only to validate cancellation handling.",
        mode: "read-only",
        model: process.env.SURTEC_CODEX_MODEL?.trim() || undefined,
        reasoningEffort: process.env.SURTEC_CODEX_REASONING_EFFORT?.trim() || undefined,
        outputSchema: AGENT_REPORT_SCHEMA as unknown as Record<string, unknown>,
      },
      (event: AgentEvent) => {
        if (event.type === "thread-started") identifiers.threadId = event.threadId;
        if (event.type === "turn-started") {
          identifiers.turnId = event.turnId;
          cancellationTimer = setTimeout(() => {
            cancellationRequested = true;
            controller.abort();
          }, cancelAfterMs);
        }
        if (event.type === "turn-completed") terminalStatus = event.status;
      },
      controller.signal,
    );
    failure = new Error("turn completed before the requested cancellation was observed");
  } catch (error) {
    if (!cancellationRequested || !(error instanceof Error) || error.name !== "AbortError") failure = error;
  } finally {
    clearTimeout(hardTimeout);
    if (cancellationTimer) clearTimeout(cancellationTimer);
  }
  const after = snapshot(fixture);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("cancellation smoke changed the fixture");
  if (failure) throw new Error(`cancellation smoke did not interrupt cleanly: ${safeError(failure)}`);
  if (!identifiers.threadId || !identifiers.turnId || terminalStatus !== "interrupted") {
    throw new Error("cancellation smoke did not capture thread, turn, and interrupted terminal status");
  }
  return { thread_id: identifiers.threadId, turn_id: identifiers.turnId, terminal_status: terminalStatus, fixture_unchanged: true };
}

async function main(cancelAfterMs: number | null): Promise<void> {
  assertReadFixture();
  const before = snapshot(fixture);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_TURN_MS);
  let result: Awaited<ReturnType<typeof codexExecutor.run>> | undefined;
  let terminalStatus = "";
  let failure: unknown;
  try {
    result = await codexExecutor.run(
      {
        cwd: fixture,
        developerInstructions: "This is a read-only runtime smoke. Inspect only the supplied fixture and do not modify any file.",
        prompt: "Read the fixture and return a concise structured report describing its purpose.",
        mode: "read-only",
        model: process.env.SURTEC_CODEX_MODEL?.trim() || undefined,
        reasoningEffort: process.env.SURTEC_CODEX_REASONING_EFFORT?.trim() || undefined,
        outputSchema: AGENT_REPORT_SCHEMA as unknown as Record<string, unknown>,
      },
      (event: AgentEvent) => {
        if (event.type === "turn-completed") terminalStatus = event.status;
      },
      controller.signal,
    );
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
  }

  const after = snapshot(fixture);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("read-only smoke changed the fixture");
  if (failure) throw new Error(`read-only Codex turn failed: ${safeError(failure)}`);
  if (!result) throw new Error("read-only Codex turn returned no result");
  if (!result.threadId.trim() || !result.turnId.trim()) throw new Error("read-only smoke did not capture thread and turn identifiers");
  if (terminalStatus !== "completed") throw new Error("read-only smoke did not capture a completed terminal status");
  if (result.usage !== null && !isUsage(result.usage)) throw new Error("read-only smoke returned invalid usage data");

  const validated = validateAgentReport(result.structuredOutput);
  if (!validated.ok) throw new Error(`invalid structured report: ${validated.reason}`);
  if (validated.report.status !== "completed") throw new Error(`read-only report ended with status ${validated.report.status}`);

  let cancellation: Record<string, unknown> | null = null;
  if (cancelAfterMs !== null) cancellation = await runCancellationCheck(cancelAfterMs);

  console.log(JSON.stringify({
    status: validated.report.status,
    thread_id: result.threadId,
    turn_id: result.turnId,
    terminal_status: terminalStatus,
    usage: result.usage,
    fixture_unchanged: true,
    cancellation,
  }));
}

if (process.env.SURTEC_CODEX_SMOKE !== "1") {
  console.log("Codex read-only smoke skipped; set SURTEC_CODEX_SMOKE=1 to opt in. This real turn can consume model quota.");
} else {
  console.warn("Starting a real read-only Codex App Server turn against the checked-in fixture; this can consume model quota.");
  try {
    await main(configuredCancellationDelay());
  } catch (error) {
    console.error(`Codex read-only smoke failed: ${safeError(error)}`);
    process.exitCode = 1;
  }
}
