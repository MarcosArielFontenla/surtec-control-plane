import {
  readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentResult, TaskRecord } from "../lib/state/types";
import { createInterface } from "node:readline/promises";
import { createContextService, type ContextPreview, type ContextPreviewRequest, type ContextService } from "../dashboard/src/server/context-service";
import { createTask } from "../dashboard/src/server/dispatch";
import { createIssueService } from "../dashboard/src/server/issue-service";
import { readTask, writeTask, withStateLock } from "../lib/state/store";
import { taskBudgetReadiness, validateTaskRecord } from "../lib/state/validation";
import { stateDir, fixturesDir, projectsDir } from "../lib/state/paths";
import { assertTaskOutsideActiveWorkflow } from "../runner/task-orchestrator";
import { readWorkflowDocument } from "../lib/state/workflows";

function now(): string {
  return new Date().toISOString();
}

export async function runRecord(requestFile: string, options: { repoRoot?: string; context?: ContextService; confirm?: (preview: ContextPreview) => Promise<string> } = {}): Promise<string> {
  const root = options.repoRoot ?? process.cwd();
  // Raw envelopes/manifests are not dispatch authority. Parsing and preview are no-effect.
  const input = JSON.parse(readFileSync(requestFile, "utf8")) as ContextPreviewRequest;
  const keys = ["kind", "project", "agent", "role_id", "instructions", "issue_id", "expected_revision", "client_context_categories"];
  if (!input || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Reflect.ownKeys(input).some((key) => typeof key !== "string" || !keys.includes(key))) throw new Error("Invalid context request fields; caller budget authority and cutover are not accepted");
  const context = options.context ?? createContextService(root);
  const preview = context.preview(input);
  if (!preview.allowed) throw new Error("Context preview is blocked; no task was created");
  const confirmation = options.confirm ?? (async (current: ContextPreview) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive context confirmation is required; no task was created");
    console.log(JSON.stringify(current, null, 2));
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try { return (await terminal.question("Confirm the displayed context by entering its exact fingerprint (anything else cancels): ")).trim(); }
    finally { terminal.close(); }
  });
  if (await confirmation(preview) !== preview.fingerprint) throw new Error("Context preview was not confirmed; no task was created");
  const admission = { role_id: input.role_id, preview_fingerprint: preview.fingerprint, client_context_categories: input.client_context_categories };
  if (input.kind === "issue") return createIssueService(root, { context, source: "cli" }).dispatch(input.issue_id!, input.expected_revision!, input.agent, admission).taskId;
  return createTask({ project: input.project, agent: input.agent, instructions: input.instructions!, ...admission }, root, undefined, { context, source: "cli" }).id;
}

/** Read-only P scaffold inspection; neither flags nor environment activate cutover. */
export function runBudgetReadiness(id: string): ReturnType<typeof taskBudgetReadiness> {
  const task = readTask(id);
  if (!task) throw new Error("Task not found; no budget admission was invented");
  return taskBudgetReadiness(task);
}

export function runSetStatus(id: string, status: string, resultFile?: string): string {
  if (status === "running") throw new Error("Only the leased worker may start execution; admit new work through a confirmed context request");
  return withStateLock(id, () => {
    const rec = readTask(id);
    if (!rec) throw new Error(`task not found: ${id}`);
    assertTaskOutsideActiveWorkflow(rec);
    if (rec.envelope.context_manifest) throw new Error("Governed task status belongs to the leased worker; set-status cannot replace its evidence");
    if (rec.orchestration?.lease) throw new Error("Task has worker ownership; set-status cannot replace its evidence");
    const ts = now();
    rec.updated_at = ts;
    if (status === "finished") {
      if (!resultFile) throw new Error("set-status finished requires --result <file>");
      const result = JSON.parse(readFileSync(resultFile, "utf8")) as AgentResult;
      rec.lifecycle = "finished";
      rec.finished_at = ts;
      rec.outcome = result.status;
      rec.result = result;
      rec.logs_path = result.logs_path;
    } else {
      throw new Error(`unknown status: ${status} (use finished for unleased legacy history only)`);
    }
    writeTask(rec);
    return rec.lifecycle;
  });
}

function copyJsonDir(srcDir: string, destDir: string): number {
  if (!existsSync(srcDir)) return 0;
  mkdirSync(destDir, { recursive: true });
  let n = 0;
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith(".json")) continue;
    copyFileSync(join(srcDir, f), join(destDir, f));
    n++;
  }
  return n;
}

export function runSeed(): { tasks: number; projects: number } {
  const source = join(fixturesDir(), "tasks");
  const records: TaskRecord[] = [];
  // Seeding is historical fixture import, never a second queue/admission path.
  for (const name of existsSync(source) ? readdirSync(source) : []) {
    if (!name.endsWith(".json")) continue;
    const record: unknown = JSON.parse(readFileSync(join(source, name), "utf8"));
    if (record && typeof record === "object" && !Array.isArray(record)) {
      const envelope = (record as { envelope?: unknown }).envelope;
      if (envelope && typeof envelope === "object" && Object.hasOwn(envelope, "budget_admission")) throw new Error("Seed cannot import budget authority; use a fresh application-owned admission after cutover");
    }
    if (!validateTaskRecord(record) || record.lifecycle !== "finished" || record.orchestration?.lease) throw new Error("Seed accepts only valid terminal task history; dispatch new work through confirmed context admission");
    if (record.envelope.context_admission?.schema_version === 2) throw new Error("Seed cannot import workflow authority or evidence; use its current workflow");
    assertTaskOutsideActiveWorkflow(record);
    if (readTask(record.envelope.id)) throw new Error("Seed cannot replace an existing task");
    records.push(record);
  }
  const assertProjectImports = () => {
    const source = join(fixturesDir(), "projects"), active = Object.values(readWorkflowDocument().workflows).filter((owner) => !["completed", "cancelled"].includes(owner.status));
    for (const name of existsSync(source) ? readdirSync(source) : []) {
      if (!name.endsWith(".json")) continue;
      let value: unknown;
      try { value = JSON.parse(readFileSync(join(source, name), "utf8")); }
      catch { throw new Error("Seed project context cannot be inspected; import is denied"); }
      const id = value && typeof value === "object" && !Array.isArray(value) ? (value as { id?: unknown }).id : null;
      if (active.some((owner) => `${owner.project_id}.json` === name || owner.project_id === id)) {
        throw new Error("Seed cannot replace project context retained by an active workflow; stop it first");
      }
    }
  };
  assertProjectImports();
  for (const record of records) withStateLock(record.envelope.id, () => {
    assertTaskOutsideActiveWorkflow(record);
    if (readTask(record.envelope.id)) throw new Error("Seed cannot replace an existing task");
    writeTask(record);
  });
  assertProjectImports();
  return {
    tasks: records.length,
    projects: copyJsonDir(join(fixturesDir(), "projects"), projectsDir()),
  };
}

function parseFlags(args: string[]): { flags: Record<string, string>; pos: string[] } {
  const flags: Record<string, string> = Object.create(null);
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2), value = args[i + 1];
      if (!key || Object.hasOwn(flags, key) || value === undefined || value.startsWith("--")) throw new Error("Invalid, duplicate or missing state command flag");
      flags[key] = value; i++;
    }
    else pos.push(args[i]);
  }
  return { flags, pos };
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseFlags(rest);
  switch (cmd) {
    case "budget-readiness": {
      if (pos.length !== 1 || Object.keys(flags).length) throw new Error("usage: surtec-state budget-readiness <task-id> (read-only; no cutover flags)");
      console.log(JSON.stringify(runBudgetReadiness(pos[0]), null, 2));
      break;
    }
    case "record": {
      if (!flags.from || pos.length || Object.keys(flags).some((key) => key !== "from")) throw new Error("usage: surtec-state record --from <context-request.json>");
      console.log(`recorded ${await runRecord(flags.from)} (queued; governed execution remains gated until integration)`);
      break;
    }
    case "set-status": {
      if (pos.length !== 2 || Object.keys(flags).some((key) => key !== "result")) throw new Error("usage: surtec-state set-status <legacy-id> finished --result <file>");
      const lifecycle = runSetStatus(pos[0], pos[1], flags.result);
      console.log(`updated ${pos[0]} -> ${lifecycle}`);
      break;
    }
    case "seed": {
      if (pos.length || Object.keys(flags).length) throw new Error("usage: surtec-state seed (no authority or cutover flags)");
      const { tasks, projects } = runSeed();
      console.log(`seeded ${tasks} task(s) and ${projects} project override(s) into ${stateDir()}`);
      break;
    }
    default:
      throw new Error("usage: surtec-state <record --from <context-request.json> | budget-readiness <task-id> | set-status <legacy-id> finished --result <file> | seed>");
  }
}

// Run only when invoked directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith("surtec-state.ts")) {
  main().catch(() => { console.error("State command failed; check request, context policy and confirmation. No runtime call was started by this CLI."); process.exitCode = 1; });
}
