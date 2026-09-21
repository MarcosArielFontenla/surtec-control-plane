import { randomUUID } from "node:crypto";
import type { TaskEnvelope, TaskRecord } from "../../../lib/state/types";
import { writeTask } from "../../../lib/state/store";
import { PolicyError, PolicyService } from "../../../lib/policy/service";
import { defaultTaskOrchestration } from "../../../lib/state/orchestration";
import { appendTaskEvent } from "../../../lib/state/events";

export class ValidationError extends Error {}

export interface CreateTaskInput {
  project: string;
  agent: string;
  instructions: string;
  sandbox?: string;
  self_verify?: boolean;
}

export function createTask(input: CreateTaskInput, repoRoot: string = process.cwd()): { id: string } {
  const project = String(input?.project ?? "");
  const agent = String(input?.agent ?? "");
  const instructions = String(input?.instructions ?? "").trim();

  if (!instructions) throw new ValidationError("instructions are required");
  if (instructions.length > 20_000) throw new ValidationError("instructions are too long");

  const sandbox = String(input?.sandbox ?? "read-only");
  if (sandbox !== "read-only" && sandbox !== "workspace-write") {
    throw new ValidationError(`invalid sandbox: ${sandbox} (use read-only or workspace-write)`);
  }

  const selfVerify = input?.self_verify === true;
  if (selfVerify && sandbox !== "workspace-write") {
    throw new ValidationError("self_verify requires sandbox workspace-write");
  }

  let repoPath: string;
  try {
    const allowed = new PolicyService(repoRoot).authorizeDispatch({ project, agent, sandbox, selfVerify });
    repoPath = allowed.project.repo_path!;
  } catch (error) {
    if (error instanceof PolicyError) throw new ValidationError(error.message);
    throw error;
  }

  const id = `T-${randomUUID().slice(0, 8)}`;
  const envelope: TaskEnvelope = {
    id,
    source: "dashboard",
    project,
    task_type: sandbox === "workspace-write" ? "implementation" : "analysis",
    agent,
    title: instructions.slice(0, 80),
    instructions,
    repo_path: repoPath,
    branch: `agent/${id}-${agent}`,
    sandbox: sandbox as "read-only" | "workspace-write",
    expected_outputs: ["summary", "risks", "next_steps"],
    requires_human_approval: true,
    metadata: { created_by: "dashboard" },
    self_verify: selfVerify && sandbox === "workspace-write",
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
    revision: 1,
    orchestration: defaultTaskOrchestration(),
  };
  writeTask(record);
  appendTaskEvent({ task_id: id, type: "queued", revision: 1, payload: { source: envelope.source } });
  return { id };
}
