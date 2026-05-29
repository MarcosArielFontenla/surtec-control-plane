import { randomUUID } from "node:crypto";
import type { TaskEnvelope, TaskRecord } from "../../../lib/state/types";
import { writeTask } from "../../../lib/state/store";
import { loadRegistryProjects } from "./registry";

export class ValidationError extends Error {}

export interface CreateTaskInput {
  project: string;
  agent: string;
  instructions: string;
}

export function createTask(input: CreateTaskInput, repoRoot: string = process.cwd()): { id: string } {
  const project = String(input?.project ?? "");
  const agent = String(input?.agent ?? "");
  const instructions = String(input?.instructions ?? "").trim();

  if (!instructions) throw new ValidationError("instructions are required");

  const rp = loadRegistryProjects(repoRoot).find((p) => p.id === project);
  if (!rp) throw new ValidationError(`unknown project: ${project}`);
  if (!(rp.allowed_agents ?? []).includes(agent)) {
    throw new ValidationError(`agent '${agent}' is not allowed for project '${project}'`);
  }

  const id = `T-${randomUUID().slice(0, 8)}`;
  const envelope: TaskEnvelope = {
    id,
    source: "dashboard",
    project,
    task_type: "analysis",
    agent,
    title: instructions.slice(0, 80),
    instructions,
    repo_path: rp.repo_path ?? `~/dev/surtec/${project}`,
    branch: `agent/${id}-${agent}`,
    sandbox: "read-only",
    expected_outputs: ["summary", "risks", "next_steps"],
    requires_human_approval: true,
    metadata: { created_by: "dashboard" },
  };

  const ts = new Date().toISOString();
  const record: TaskRecord = {
    envelope,
    lifecycle: "queued",
    outcome: null,
    created_at: ts,
    started_at: null,
    updated_at: ts,
    finished_at: null,
    result: null,
    logs_path: null,
  };
  writeTask(record);
  return { id };
}
