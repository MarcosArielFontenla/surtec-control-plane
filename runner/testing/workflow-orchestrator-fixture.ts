import { expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import type { AgentRoleRegistry } from "../../lib/context/types";
import { readTask } from "../../lib/state/store";
import { readWorkflowDocument } from "../../lib/state/workflows";
import type { WorkflowRoleOutput } from "../../lib/workflows/types";
import { createIssueService } from "../../dashboard/src/server/issue-service";
import type { createPlannerPhaseRecorder, PlannerSpanObserver } from "../../scripts/profile-maintenance";

type PlannerTrace = ReturnType<typeof createPlannerPhaseRecorder>;
export type WorkflowFixtureTemplate = "analysis" | "implementation" | "trivial-change" | "operations-investigation";

export const roles = { "portfolio-analyst": "product-manager", planner: "tech-lead", "software-engineer": "backend-engineer", reviewer: "reality-checker", "qa-evaluator": "qa-reviewer", "operations-observer": "devops-engineer" };
export const workflowFixtureProjectRules = "Synthetic bounded project rules; no authority.";

export const materializeWorkflowFixtureInputs = (() => {
  let inputs: readonly Readonly<{ path: string; bytes: Buffer }>[] | undefined;
  return (targetRoot: string): readonly string[] => {
    if (!inputs) {
      const registries = ["agents.yml", "agent-roles.yml", "context-policy.yml", "workflow-policy.yml"].map((name) => {
        const path = `registry/${name}`;
        return { path, bytes: readFileSync(path) };
      });
      const registry = parse(registries.find((input) => input.path === "registry/agent-roles.yml")!.bytes.toString("utf8")) as AgentRoleRegistry;
      const evaluationPaths = [...new Set(registry.roles.flatMap((role) => role.required_evaluation_ids))];
      inputs = Object.freeze([...registries, ...evaluationPaths.map((path) => ({ path, bytes: readFileSync(path) }))].map((input) => Object.freeze(input)));
    }
    // Only public source bytes are shared; every case still owns normal files.
    for (const input of inputs) {
      const target = join(targetRoot, input.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, input.bytes, { flag: "wx" });
    }
    return Object.freeze(inputs.map((input) => input.path));
  };
})();

export function createWorkflowFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "surtec-workflow-worker-"));
  const state = join(root, "state");
  mkdirSync(join(root, "projects/alpha/.git"), { recursive: true }); mkdirSync(join(root, "registry"));
  materializeWorkflowFixtureInputs(root);
  writeFileSync(join(root, "registry/projects.yml"), `projects:\n  alpha:\n    allowed_agents: [${Object.values(roles).join(", ")}]\n    sandbox: { default: workspace-write }\n    verify: ['node verify.mjs']\n`);
  writeFileSync(join(root, "projects/alpha/AGENTS.md"), workflowFixtureProjectRules);
  vi.stubEnv("SURTEC_STATE_DIR", state); vi.stubEnv("SURTEC_PROJECTS_ROOT", join(root, "projects"));
  return { root, state };
}

export function createAuthorizedWorkflowIssue(root: string, trace?: PlannerTrace, span?: PlannerSpanObserver): string {
  let issues: ReturnType<typeof createIssueService>, proposed: ReturnType<ReturnType<typeof createIssueService>["create"]>;
  const stopCreate = trace?.begin("issue-create");
  const stopSpanCreate = span?.begin("issue-create");
  try {
    issues = createIssueService(root, { projectIds: () => ["alpha"] });
    proposed = issues.create({ project_id: "alpha", title: "Synthetic workflow", expected_outcome: "Observable synthetic result", acceptance_criteria: ["Observable acceptance"], assigned_role_id: "backend-engineer", plan: ["Existing plan"],
      authorized_scope: { expected_outcome: "Observable synthetic result", acceptance_criteria: ["Observable acceptance"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["implementation"], explicit_exclusions: [] } });
  } finally { stopSpanCreate?.(); stopCreate?.(); }
  const stopAuthorize = trace?.begin("issue-authorize");
  const stopSpanAuthorize = span?.begin("issue-authorize");
  try { issues.authorize(proposed.id, proposed.revision, "synthetic-scope-human"); }
  finally { stopSpanAuthorize?.(); stopAuthorize?.(); }
  return proposed.id;
}

export function output(kind: "analysis" | "plan" | "operations" = "analysis"): WorkflowRoleOutput {
  const base = { schema_version: 1 as const, status: "completed" as const, summary: "Bounded synthetic output", evidence_ids: [], unresolved_questions: [], risks: [], recommended_next_action: "Human inspection", requested_decision: null };
  return kind === "plan" ? { ...base, kind, plan: ["Only authorized paths"], scope_change_required: false } : kind === "operations" ? { ...base, kind, proposed_issue: null } : { ...base, kind, recommendations: ["Inspect evidence"] };
}

export type FirstReadOnlyBinding = { id: string; stageId: string; taskId: string };
export function assertReadOnlyCompletionCheckpoint(binding: FirstReadOnlyBinding, task: ReturnType<typeof readTask>, document: ReturnType<typeof readWorkflowDocument>) {
  expect(task?.envelope.id, "read-only checkpoint: exact task").toBe(binding.taskId);
  expect(task?.lifecycle, "read-only checkpoint: finished task").toBe("finished");
  const workflow = document.workflows[binding.id], stage = document.stages[binding.stageId];
  expect(workflow?.id, "read-only checkpoint: exact workflow").toBe(binding.id);
  expect(workflow?.current_stage_id, "read-only checkpoint: current stage").toBe(binding.stageId);
  expect(stage?.id, "read-only checkpoint: exact stage").toBe(binding.stageId);
  expect(stage?.workflow_id, "read-only checkpoint: stage owner").toBe(binding.id);
  expect(stage?.task_id, "read-only checkpoint: stage task").toBe(binding.taskId);
  expect(stage?.status, "read-only checkpoint: completed stage").toBe("completed");
  expect(workflow?.status, "read-only checkpoint: reconciled human gate").toBe("waiting-human");
}

export function assertQueuedStageSelection(document: ReturnType<typeof readWorkflowDocument>, workflowId: string, kind: string) {
  const workflow = document.workflows[workflowId];
  expect(workflow?.id, "queued-stage selection: exact workflow").toBe(workflowId);
  const stage = workflow?.current_stage_id ? document.stages[workflow.current_stage_id] : undefined;
  expect(stage, "queued-stage selection: current stage exists").toBeDefined();
  expect(stage?.id, "queued-stage selection: current stage identity").toBe(workflow!.current_stage_id);
  expect(stage?.workflow_id, "queued-stage selection: stage owner").toBe(workflowId);
  expect(stage?.id, "queued-stage selection: last stage").toBe(Object.values(document.stages).filter((entry) => entry.workflow_id === workflowId).at(-1)?.id);
  expect(stage?.kind, "queued-stage selection: expected kind").toBe(kind);
  expect(stage?.status, "queued-stage selection: queued status").toBe("queued");
  expect(stage?.task_id, "queued-stage selection: bound task").toEqual(expect.any(String));
  return stage!;
}
export function selectQueuedStage(workflowId: string, kind: string) {
  return assertQueuedStageSelection(readWorkflowDocument(), workflowId, kind);
}
