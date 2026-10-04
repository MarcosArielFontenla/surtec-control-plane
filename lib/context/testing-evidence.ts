import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../schemas/testing-evidence.schema.json";
import type { ContextRunner, TestingPlan } from "./types";
import type { TaskRecord } from "../state/types";
import type { ReviewCandidate } from "../issues/types";
import { ContextContractError } from "./validation";

export const evidenceHash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export interface TestingRequirement {
  stage: ContextRunner["stage"];
  command_fingerprint: string;
  probe_fingerprint: string | null;
  assertion_ids: string[];
}
export interface TestingObservation {
  stage: ContextRunner["stage"];
  command_fingerprint: string;
  probe_fingerprint: string | null;
  assertions: { id: string; status: "passed" | "assertion-failed" }[];
  outcome: "passed" | "assertion-failed" | "process-error" | "timed-out" | "cancelled" | "candidate-changed";
  exit_code: number | null;
  started_at: string;
  finished_at: string;
  revision: string;
  before_fingerprint: string;
  after_fingerprint: string;
}
export interface TestingEvidence {
  schema_version: 1;
  fingerprint: string;
  task_id: string;
  execution_id: string;
  project_id: string;
  issue_id: string | null;
  issue_revision: number | null;
  scope_revision: number | null;
  scope_fingerprint: string | null;
  context_fingerprint: string;
  mode: TestingPlan["mode"];
  requirements: TestingRequirement[];
  no_refactor_fingerprint: string | null;
  policy_fingerprint: string;
  implementation: { started_at: string; finished_at: string; thread_id: string; turn_id: string } | null;
  candidate: { id: string; base_revision: string; candidate_revision: string; diff_fingerprint: string } | null;
  observations: TestingObservation[];
}
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
const requireEvidence = (ok: boolean, message: string): void => { if (!ok) throw new ContextContractError(message); };
export function testingRequirement(runner: ContextRunner): TestingRequirement {
  return { stage: runner.stage, command_fingerprint: evidenceHash(runner.command), probe_fingerprint: runner.probe ? evidenceHash(JSON.stringify({ sources: [...runner.probe.sources].sort((a, b) => a.path.localeCompare(b.path)), ids: [...runner.probe.assertion_ids].sort() })) : null, assertion_ids: runner.probe ? [...runner.probe.assertion_ids].sort() : [] };
}
export function sealTestingEvidence(value: Omit<TestingEvidence, "fingerprint">): TestingEvidence {
  return { ...value, fingerprint: evidenceHash(JSON.stringify(value)) };
}
function testingScope(task: TaskRecord): { revision: number | null; fingerprint: string | null } {
  const envelope = task.envelope, admission = envelope.context_admission;
  if (admission?.schema_version === 2) {
    requireEvidence(["implementation", "correction"].includes(admission.stage_kind) && admission.role_id === "software-engineer"
      && envelope.task_type === "implementation" && envelope.sandbox === "workspace-write" && envelope.self_verify === true
      && envelope.context_manifest?.tools.includes("verify-configured") === true
      && !["issue_id", "issue_scope_revision", "issue_authorized_scope"].some((key) => Object.hasOwn(envelope.metadata, key)), "Only admitted workflow writers can own captured testing evidence");
    return { revision: admission.scope_revision, fingerprint: admission.scope_fingerprint };
  }
  return { revision: typeof envelope.metadata.issue_scope_revision === "number" ? envelope.metadata.issue_scope_revision : null,
    fingerprint: envelope.metadata.issue_authorized_scope ? evidenceHash(JSON.stringify(envelope.metadata.issue_authorized_scope)) : null };
}
export function createTestingEvidence(task: TaskRecord, executionId: string, plan: TestingPlan): TestingEvidence {
  const requirements = plan.runners.map(testingRequirement);
  const noRefactor = plan.noRefactorJustification ? evidenceHash(plan.noRefactorJustification) : null;
  const scope = testingScope(task);
  return sealTestingEvidence({ schema_version: 1, task_id: task.envelope.id, execution_id: executionId, project_id: task.envelope.project,
    issue_id: task.envelope.context_admission?.issue_id ?? null, issue_revision: task.envelope.context_admission?.issue_revision ?? null,
    scope_revision: scope.revision, scope_fingerprint: scope.fingerprint,
    context_fingerprint: task.envelope.context_manifest!.fingerprint, mode: plan.mode, requirements, no_refactor_fingerprint: noRefactor,
    policy_fingerprint: evidenceHash(JSON.stringify({ mode: plan.mode, requirements, no_refactor_fingerprint: noRefactor })), implementation: null, candidate: null, observations: [] });
}
export function assertTestingEvidence(value: unknown): asserts value is TestingEvidence {
  requireEvidence(validate(value), "Invalid or unsupported captured testing evidence");
  const receipt = value as TestingEvidence;
  const { fingerprint, ...unsigned } = receipt;
  requireEvidence(evidenceHash(JSON.stringify(unsigned)) === fingerprint, "Captured testing evidence fingerprint differs");
  requireEvidence(receipt.policy_fingerprint === evidenceHash(JSON.stringify({ mode: receipt.mode, requirements: receipt.requirements, no_refactor_fingerprint: receipt.no_refactor_fingerprint })), "Captured testing policy fingerprint differs");
  requireEvidence(new Set(receipt.requirements.map((entry) => JSON.stringify([entry.stage, entry.command_fingerprint, entry.probe_fingerprint]))).size === receipt.requirements.length, "Duplicate testing requirements");
  let previous = 0;
  for (const observation of receipt.observations) {
    const start = Date.parse(observation.started_at), finish = Date.parse(observation.finished_at);
    requireEvidence(Number.isFinite(start) && Number.isFinite(finish) && new Date(start).toISOString().slice(0, 10) === observation.started_at.slice(0, 10) && new Date(finish).toISOString().slice(0, 10) === observation.finished_at.slice(0, 10) && start >= previous && finish >= start, "Testing observation order is invalid");
    previous = finish;
    requireEvidence(new Set(observation.assertions.map((assertion) => assertion.id)).size === observation.assertions.length, "Duplicate assertion evidence");
  }
}
export function testingEvidenceStatus(receipt: TestingEvidence): "passed" | "failed" | "incomplete" {
  assertTestingEvidence(receipt);
  if (!receipt.candidate || !receipt.implementation || !receipt.requirements.length) return "incomplete";
  const started = Date.parse(receipt.implementation.started_at), finished = Date.parse(receipt.implementation.finished_at);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return "failed";
  const required = [...receipt.requirements].sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage));
  if (receipt.observations.length !== required.length) return "incomplete";
  if (receipt.mode === "strict-tdd") {
    const identity = (entry: TestingRequirement) => JSON.stringify([entry.probe_fingerprint, entry.assertion_ids]);
    const red = required.filter((entry) => entry.stage === "red"), green = required.filter((entry) => entry.stage === "green");
    if (!red.length || !green.length || [...red, ...green].some((entry) => !entry.probe_fingerprint || !entry.assertion_ids.length)
      || JSON.stringify(red.map(identity).sort()) !== JSON.stringify(green.map(identity).sort())
      || (!required.some((entry) => entry.stage === "refactor") && !receipt.no_refactor_fingerprint)) return "failed";
  } else if (required.some((entry) => entry.stage !== "functional")) return "failed";
  for (let index = 0; index < required.length; index++) {
    const expected = required[index]!, observation = receipt.observations[index]!;
    const red = expected.stage === "red";
    if (JSON.stringify([observation.stage, observation.command_fingerprint, observation.probe_fingerprint]) !== JSON.stringify([expected.stage, expected.command_fingerprint, expected.probe_fingerprint])
      || observation.before_fingerprint !== observation.after_fingerprint
      || observation.revision !== (red ? receipt.candidate.base_revision : receipt.candidate.candidate_revision)
      || (red ? Date.parse(observation.finished_at) > started : Date.parse(observation.started_at) < finished)
      || observation.outcome !== (red ? "assertion-failed" : "passed") || observation.exit_code !== (red ? 1 : 0)) return "failed";
    const assertions = [...observation.assertions].sort((a, b) => a.id.localeCompare(b.id));
    if (JSON.stringify(assertions.map((entry) => entry.id)) !== JSON.stringify(expected.assertion_ids)
      || (red ? !assertions.some((entry) => entry.status === "assertion-failed") : assertions.some((entry) => entry.status !== "passed"))) return "failed";
  }
  return "passed";
}
export const stageOrder = (stage: ContextRunner["stage"]): number => ["red", "green", "functional", "refactor"].indexOf(stage);
export function assertTestingEvidenceBinding(receipt: TestingEvidence, task: TaskRecord, candidate?: ReviewCandidate): void {
  assertTestingEvidence(receipt);
  const envelope = task.envelope, manifest = envelope.context_manifest, admission = envelope.context_admission;
  const scope = testingScope(task);
  requireEvidence(!!manifest && !!admission && receipt.task_id === envelope.id && receipt.project_id === envelope.project && receipt.context_fingerprint === manifest.fingerprint
    && receipt.issue_id === (admission.issue_id ?? null) && receipt.issue_revision === (admission.issue_revision ?? null)
    && receipt.scope_revision === scope.revision && receipt.scope_fingerprint === scope.fingerprint
    && receipt.mode === manifest.testing.mode, "Testing evidence task/context/scope binding differs");
  requireEvidence(JSON.stringify([...new Set(receipt.requirements.map((entry) => entry.command_fingerprint))].sort()) === JSON.stringify([...new Set(manifest!.testing.commands.map(evidenceHash))].sort()), "Testing evidence commands differ from admitted policy");
  if (candidate) requireEvidence(receipt.candidate?.id === candidate.id && candidate.task_id === envelope.id && candidate.issue_id === receipt.issue_id && candidate.repository_id === receipt.project_id
    && candidate.execution_id === receipt.execution_id && candidate.scope_revision === receipt.scope_revision && candidate.base_revision === receipt.candidate.base_revision
    && candidate.candidate_revision === receipt.candidate.candidate_revision && candidate.diff_fingerprint === receipt.candidate.diff_fingerprint, "Testing evidence candidate binding differs");
}
