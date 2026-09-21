import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_REPORT_SCHEMA, validateAgentReport } from "../runner/agent-report";
import { codexExecutor } from "../runner/codex-executor";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "fixtures", "codex-smoke");

function snapshot(directory: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const visit = (current: string): void => {
    for (const name of readdirSync(current)) {
      const absolute = join(current, name);
      const stats = statSync(absolute);
      if (stats.isDirectory()) visit(absolute);
      else entries[relative(directory, absolute).replaceAll("\\", "/")] = createHash("sha256").update(readFileSync(absolute)).digest("hex");
    }
  };
  visit(directory);
  return entries;
}

if (process.env.SURTEC_CODEX_SMOKE !== "1") {
  console.log("Codex smoke skipped; set SURTEC_CODEX_SMOKE=1 to opt in.");
  process.exit(0);
}

const before = snapshot(fixture);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 2 * 60 * 1000);

try {
  const rootInstructions = readFileSync(join(root, "AGENTS.md"), "utf8");
  const result = await codexExecutor.run(
    {
      cwd: fixture,
      developerInstructions: `${rootInstructions}\nThis is a read-only runtime smoke. Do not modify any file.`,
      prompt: "Read the fixture and return a concise structured report describing its purpose.",
      mode: "read-only",
      model: process.env.SURTEC_CODEX_MODEL?.trim() || undefined,
      reasoningEffort: process.env.SURTEC_CODEX_REASONING_EFFORT?.trim() || undefined,
      outputSchema: AGENT_REPORT_SCHEMA as unknown as Record<string, unknown>,
    },
    () => {},
    controller.signal,
  );
  const after = snapshot(fixture);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("read-only smoke changed the fixture");
  const validated = validateAgentReport(result.structuredOutput);
  if (!validated.ok) throw new Error(`invalid structured report: ${validated.reason}`);
  console.log(JSON.stringify({
    status: validated.report.status,
    thread_id: result.threadId,
    turn_id: result.turnId,
    usage: result.usage,
  }));
} finally {
  clearTimeout(timer);
}
