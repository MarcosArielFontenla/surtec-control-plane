import {
  readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TaskEnvelope, TaskRecord, AgentResult } from "../lib/state/types";
import { readTask, writeTask } from "../lib/state/store";
import { stateDir, fixturesDir, tasksDir, projectsDir } from "../lib/state/paths";

function now(): string {
  return new Date().toISOString();
}

export function runRecord(envelopeFile: string): string {
  const envelope = JSON.parse(readFileSync(envelopeFile, "utf8")) as TaskEnvelope;
  const ts = now();
  const record: TaskRecord = {
    envelope, lifecycle: "queued", outcome: null,
    created_at: ts, started_at: null, updated_at: ts, finished_at: null,
    result: null, logs_path: null,
  };
  writeTask(record);
  return envelope.id;
}

export function runSetStatus(id: string, status: string, resultFile?: string): string {
  const rec = readTask(id);
  if (!rec) throw new Error(`task not found: ${id}`);
  const ts = now();
  rec.updated_at = ts;
  if (status === "running") {
    rec.lifecycle = "running";
    rec.started_at = rec.started_at ?? ts;
  } else if (status === "finished") {
    if (!resultFile) throw new Error("set-status finished requires --result <file>");
    const result = JSON.parse(readFileSync(resultFile, "utf8")) as AgentResult;
    rec.lifecycle = "finished";
    rec.finished_at = ts;
    rec.outcome = result.status;
    rec.result = result;
    rec.logs_path = result.logs_path;
  } else {
    throw new Error(`unknown status: ${status} (use running|finished)`);
  }
  writeTask(rec);
  return rec.lifecycle;
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
  return {
    tasks: copyJsonDir(join(fixturesDir(), "tasks"), tasksDir()),
    projects: copyJsonDir(join(fixturesDir(), "projects"), projectsDir()),
  };
}

function parseFlags(args: string[]): { flags: Record<string, string>; pos: string[] } {
  const flags: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { flags[args[i].slice(2)] = args[i + 1]; i++; }
    else pos.push(args[i]);
  }
  return { flags, pos };
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseFlags(rest);
  switch (cmd) {
    case "record": {
      if (!flags.from) throw new Error("usage: surtec-state record --from <envelope.json>");
      console.log(`recorded ${runRecord(flags.from)} (queued)`);
      break;
    }
    case "set-status": {
      const lifecycle = runSetStatus(pos[0], pos[1], flags.result);
      console.log(`updated ${pos[0]} -> ${lifecycle}`);
      break;
    }
    case "seed": {
      const { tasks, projects } = runSeed();
      console.log(`seeded ${tasks} task(s) and ${projects} project override(s) into ${stateDir()}`);
      break;
    }
    default:
      throw new Error("usage: surtec-state <record --from <file> | set-status <id> <running|finished> [--result <file>] | seed>");
  }
}

// Run only when invoked directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith("surtec-state.ts")) {
  main();
}
