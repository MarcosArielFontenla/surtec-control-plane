import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

type SandboxMode = "read-only" | "workspace-write";

type TaskEnvelope = {
  id: string;
  source: string;
  project: string;
  task_type: string;
  agent: string;
  title: string;
  instructions: string;
  repo_path: string;
  branch: string;
  sandbox: SandboxMode;
  expected_outputs: string[];
  requires_human_approval: boolean;
  metadata: Record<string, unknown>;
};

const requiredStringFields: Array<keyof TaskEnvelope> = [
  "id",
  "source",
  "project",
  "task_type",
  "agent",
  "title",
  "instructions",
  "repo_path",
  "branch",
  "sandbox",
];

function readTaskEnvelope(filePath: string): TaskEnvelope {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<TaskEnvelope>;

  for (const field of requiredStringFields) {
    if (typeof parsed[field] !== "string" || parsed[field] === "") {
      throw new Error(`Missing or invalid task field: ${field}`);
    }
  }

  if (parsed.sandbox !== "read-only" && parsed.sandbox !== "workspace-write") {
    throw new Error(`Unsupported sandbox mode: ${parsed.sandbox}`);
  }

  if (!Array.isArray(parsed.expected_outputs)) {
    throw new Error("Missing or invalid task field: expected_outputs");
  }

  if (typeof parsed.requires_human_approval !== "boolean") {
    throw new Error("Missing or invalid task field: requires_human_approval");
  }

  if (typeof parsed.metadata !== "object" || parsed.metadata === null || Array.isArray(parsed.metadata)) {
    throw new Error("Missing or invalid task field: metadata");
  }

  return parsed as TaskEnvelope;
}

function expandHome(inputPath: string): string {
  if (inputPath === "~") {
    return process.env.HOME ?? process.env.USERPROFILE ?? inputPath;
  }

  if (inputPath.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (!home) {
      throw new Error("Cannot expand ~/ because HOME or USERPROFILE is not set.");
    }
    return join(home, inputPath.slice(2));
  }

  return inputPath;
}

function buildPrompt(task: TaskEnvelope): string {
  return [
    `Task ${task.id}: ${task.title}`,
    "",
    `Source: ${task.source}`,
    `Project: ${task.project}`,
    `Task type: ${task.task_type}`,
    `Agent: ${task.agent}`,
    `Branch: ${task.branch}`,
    "",
    "Instructions:",
    task.instructions,
    "",
    "Expected outputs:",
    ...task.expected_outputs.map((output) => `- ${output}`),
    "",
    "Return summary, files changed, commands run, tests run, risks, blockers, and next steps.",
    "Do not merge. Do not deploy. Do not touch secrets.",
  ].join("\n");
}

function main(): void {
  const taskFile = process.argv[2];
  if (!taskFile) {
    throw new Error("Usage: tsx run-task.ts <task-json-file>");
  }

  const task = readTaskEnvelope(taskFile);
  const repoPath = expandHome(task.repo_path);
  const prompt = buildPrompt(task);
  const args = ["exec", "--sandbox", task.sandbox, "--json", prompt];
  const reportsDir = "reports";
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const logPath = join(reportsDir, `${task.id}-${task.agent}-${timestamp}.jsonl`);

  mkdirSync(reportsDir, { recursive: true });

  console.log(`Task: ${task.id}`);
  console.log(`Agent: ${task.agent}`);
  console.log(`Repository: ${repoPath}`);
  console.log(`Sandbox: ${task.sandbox}`);
  console.log(`Log: ${logPath}`);
  console.log(`Command dry-run: cd ${repoPath} && codex ${args.map((arg) => JSON.stringify(arg)).join(" ")}`);

  if (process.env.SURTEC_EXECUTE === "1") {
    const result = spawnSync("codex", args, {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    writeFileSync(logPath, result.stdout + result.stderr, "utf8");
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  writeFileSync(
    logPath,
    JSON.stringify({
      task_id: task.id,
      agent: task.agent,
      mode: "dry-run",
      repo_path: repoPath,
      sandbox: task.sandbox,
      command: ["codex", ...args],
    }) + "\n",
    "utf8",
  );
}

main();

