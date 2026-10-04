import { createHash } from "node:crypto";
import type { ReviewDepth } from "../context/types";
import type { IssueClassificationInputs, IssueCriticality } from "../issues/types";
import { WORK_SCALES, type WorkScale } from "../organization/issue-lifecycle";
import { WORKFLOW_ROLES, WORKFLOW_TEMPLATES, type WorkflowReviewPolicy, type WorkflowRoleId, type WorkflowTemplateId } from "./types";
import { WorkflowContractError } from "./validation";

// Inputs are resolved application policy/classification, never role output or
// request-supplied minima. Fingerprints detect drift, not actual authority.
export interface WorkflowReviewInput {
  template_id: WorkflowTemplateId;
  work_scale: WorkScale;
  criticality: IssueCriticality;
  classification: IssueClassificationInputs;
  change_categories: string[];
  behavior_change: boolean;
  critical_client_operations: boolean;
  floors: {
    roles: { role_id: WorkflowRoleId; depth: ReviewDepth }[];
    testing: ReviewDepth;
    routing: ReviewDepth;
    project: ReviewDepth | null;
    harness: ReviewDepth | null;
    workflow: ReviewDepth;
  };
  trusted_qa_required: boolean;
}
const depth = (value: unknown): value is ReviewDepth => value === "focused" || value === "full";
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const demand = (ok: boolean): void => { if (!ok) throw new WorkflowContractError("Invalid workflow review inputs"); };
const labels = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 50
  && value.every((label) => typeof label === "string" && !!label.trim() && label.length <= 100);

export function resolveWorkflowReviewPolicy(input: WorkflowReviewInput): WorkflowReviewPolicy {
  demand(!!input && WORKFLOW_TEMPLATES.includes(input.template_id) && WORK_SCALES.includes(input.work_scale)
    && ["low", "medium", "high"].includes(input.criticality));
  const classification = input.classification, floors = input.floors;
  demand(!!classification && labels(classification.affected_domains) && labels(input.change_categories)
    && typeof classification.security_impact === "boolean" && typeof classification.requires_migration === "boolean"
    && typeof input.behavior_change === "boolean" && typeof input.critical_client_operations === "boolean"
    && typeof input.trusted_qa_required === "boolean");
  demand(!!floors && Array.isArray(floors.roles) && floors.roles.length > 0 && floors.roles.length <= WORKFLOW_ROLES.length
    && floors.roles.every((role) => !!role && WORKFLOW_ROLES.includes(role.role_id) && depth(role.depth))
    && new Set(floors.roles.map((role) => role.role_id)).size === floors.roles.length
    && [floors.testing, floors.routing, floors.workflow].every(depth)
    && [floors.project, floors.harness].every((value) => value === null || depth(value)));
  const reasons: string[] = [];
  const declared = [...classification.affected_domains, ...input.change_categories].map((value) => value.trim().toLowerCase());
  const sensitive = /(?:^|[\s/_-])(security|auth|authn|authz|authentication|authorization|persistence|storage|database|data-model|migration|payments?|billing|infrastructure|infra|deployment|ci-cd)(?:$|[\s/_-])/;
  if (classification.security_impact) reasons.push("Intrinsic full: trusted security-impact classification");
  if (classification.requires_migration) reasons.push("Intrinsic full: trusted migration classification");
  if (declared.some((value) => sensitive.test(value))) reasons.push("Intrinsic full: sensitive security, state, payment or infrastructure domain/category");
  if (input.criticality === "high" || input.critical_client_operations) reasons.push("Intrinsic full: critical issue or client operations");
  if (new Set(classification.affected_domains.map((value) => value.trim().toLowerCase())).size > 2) reasons.push("Intrinsic full: broad change across more than two domains");
  const documentationOnly = input.change_categories.length > 0
    && input.change_categories.every((category) => ["documentation", "docs", "runbook", "changelog"].includes(category.trim().toLowerCase()));
  const intrinsic = reasons.length ? "full" : input.work_scale === "trivial" && !input.behavior_change && documentationOnly ? "passive" : "focused";
  if (!reasons.length) reasons.push(intrinsic === "passive" ? "Intrinsic passive: trivial non-behavioral documentation only" : "Intrinsic focused: bounded or behavioral work");
  // Every floor is retained, including the existing routing result. In
  // particular, substantial work cannot downgrade Phase N's full requirement.
  const layers = [
    { name: "role", value: floors.roles.some((role) => role.depth === "full") ? "full" : "focused" },
    { name: "testing", value: floors.testing }, { name: "routing", value: floors.routing },
    { name: "project", value: floors.project }, { name: "harness", value: floors.harness }, { name: "workflow", value: floors.workflow },
  ];
  for (const layer of layers) if (layer.value !== null) reasons.push(`${layer.name} minimum: ${layer.value}`);
  const minimum = layers.some((layer) => layer.value === "full") ? "full" : "focused";
  const effective = intrinsic === "full" || minimum === "full" ? "full" : "focused";
  const qa = effective === "full" || input.trusted_qa_required || input.template_id === "quality-review";
  if (effective === "full") reasons.push("QA required for a full-depth candidate review");
  if (input.trusted_qa_required) reasons.push("QA required by explicit trusted policy");
  if (input.template_id === "quality-review") reasons.push("QA required by the quality-review template");
  const resolved = { intrinsic_depth: intrinsic, minimum_depth: minimum, effective_depth: effective, qa_required: qa, reasons } as Omit<WorkflowReviewPolicy, "fingerprint">;
  return { ...resolved, fingerprint: hash(resolved) };
}

export function assertResolvedWorkflowReviewPolicy(value: WorkflowReviewPolicy): void {
  demand(!!value && ["passive", "focused", "full"].includes(value.intrinsic_depth) && depth(value.minimum_depth) && depth(value.effective_depth)
    && typeof value.qa_required === "boolean" && Array.isArray(value.reasons) && value.reasons.length > 0 && value.reasons.length <= 20
    && value.reasons.every((reason) => typeof reason === "string" && !!reason.trim() && reason.length <= 500)
    && new Set(value.reasons).size === value.reasons.length);
  demand(value.effective_depth === "full" || (value.intrinsic_depth !== "full" && value.minimum_depth !== "full"));
  demand(value.effective_depth !== "full" || value.qa_required);
  const unsigned = { intrinsic_depth: value.intrinsic_depth, minimum_depth: value.minimum_depth, effective_depth: value.effective_depth, qa_required: value.qa_required, reasons: value.reasons };
  demand(value.fingerprint === hash(unsigned));
}
