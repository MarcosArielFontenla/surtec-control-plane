export const ISSUE_LIFECYCLE_VERSION = 1 as const;

export const WORK_SCALES = ["trivial", "bounded", "substantial"] as const;
export type WorkScale = (typeof WORK_SCALES)[number];

export const WORK_SCALE_CONTRACT = Object.freeze({
  trivial: Object.freeze({ substantialCeremonyByDefault: false, grantsAuthority: false }),
  bounded: Object.freeze({ substantialCeremonyByDefault: false, grantsAuthority: false }),
  substantial: Object.freeze({
    substantialCeremonyByDefault: true,
    requiresDurableScope: true,
    requiresAcceptanceCriteria: true,
    requiresEvidenceRequirements: true,
    requiresNextAction: true,
    grantsAuthority: false,
  }),
} as const);

export const ISSUE_STATUSES = [
  "proposed",
  "authorized",
  "working",
  "checking",
  "needs-decision",
  "ready-for-review",
  "done",
  "blocked",
  "cancelled",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export type IssueTransitionActor = "human" | "control-plane";

export interface IssueTransitionRule {
  readonly from: IssueStatus;
  readonly to: IssueStatus;
  readonly event: string;
  readonly actor: IssueTransitionActor;
  readonly evidence: string;
  readonly policy: string;
  readonly approvalBasis: string;
  readonly publicationAuthority: "none";
}

function edge(
  from: IssueStatus,
  to: IssueStatus,
  event: string,
  actor: IssueTransitionActor,
  evidence: string,
  policy: string,
  approvalBasis: string,
): IssueTransitionRule {
  return Object.freeze({ from, to, event, actor, evidence, policy, approvalBasis, publicationAuthority: "none" });
}

/**
 * Reference contract for future issue workflows. This catalog is deliberately
 * not wired to current task, API, UI, or persistence behavior.
 */
export const ISSUE_TRANSITIONS: readonly IssueTransitionRule[] = Object.freeze([
  edge("proposed", "authorized", "scope-authorization-recorded", "human", "Exact issue content and immutable scope-revision fingerprint.", "Validate scale requirements, target/role eligibility, policy, and budget feasibility.", "exact-scope-revision"),
  edge("proposed", "cancelled", "proposal-cancelled", "human", "Proposal id and cancellation reason.", "Confirm the actor is deciding this proposal and no execution is admitted.", "human-cancellation"),
  edge("authorized", "working", "execution-admitted", "control-plane", "Current scope revision, execution/task id, selected role, and attempt identity.", "Revalidate target, policy, sandbox, capabilities, concurrency, and budgets.", "current-scope-authorization"),
  edge("authorized", "blocked", "dependency-blocked", "control-plane", "Verifiable blocker reference, source/time, and next action.", "Confirm the blocker prevents safe progress and no permitted action resolves it.", "none-to-record-block"),
  edge("authorized", "needs-decision", "authorization-stale", "control-plane", "Specific changed policy, target, scope, budget, ambiguity, or conflicting evidence.", "Fail closed; do not dispatch using stale authorization.", "human-decision-to-resume"),
  edge("authorized", "cancelled", "issue-cancelled", "human", "Issue id and cancellation reason.", "Validate the target issue and prevent new execution admission.", "human-cancellation"),
  edge("working", "checking", "candidate-produced", "control-plane", "Completed execution identity, immutable candidate fingerprint, and evidence references.", "Confirm attempt ownership, scope compliance, and required verification.", "current-scope-authorization"),
  edge("working", "blocked", "execution-blocked", "control-plane", "Concrete dependency blocker, source/time, and next action.", "Confirm safe work cannot continue and stop or pause execution as applicable.", "none-to-record-block"),
  edge("working", "needs-decision", "decision-required", "control-plane", "Exact ambiguity, proposed scope change, budget exhaustion, or conflicting evidence.", "Reject unauthorized expansion and stop affected work safely.", "human-decision-to-resume-or-revise"),
  edge("working", "cancelled", "execution-cancelled", "human", "Explicit cancellation and runtime cancellation/cleanup evidence when applicable.", "Validate issue/execution binding and cancellation procedure.", "human-cancellation"),
  edge("checking", "ready-for-review", "verification-passed", "control-plane", "Candidate fingerprint, required check results, evidence manifest, and scope comparison.", "Deterministic done-gate passes for the exact candidate and current scope revision.", "none-to-request-review"),
  edge("checking", "working", "bounded-correction-authorized", "control-plane", "Failed check findings and the candidate they describe.", "Correction budget remains; changes stay within exact scope and policy.", "current-scope-authorization"),
  edge("checking", "blocked", "verification-blocked", "control-plane", "Unavailable required verifier/dependency and a next action.", "Confirm completion cannot be evaluated safely yet.", "none-to-record-block"),
  edge("checking", "needs-decision", "verification-needs-decision", "control-plane", "Missing/conflicting evidence, material scope delta, or exhausted correction/budget limit.", "Do not downgrade evidence requirements or infer success.", "human-decision-to-exit"),
  edge("checking", "cancelled", "issue-cancelled", "human", "Issue id, cancellation reason, and stop/cleanup evidence if execution is active.", "Validate target and cancellation procedure.", "human-cancellation"),
  edge("needs-decision", "authorized", "decision-recorded", "human", "Decision rationale and exact retained or revised scope-revision fingerprint.", "Re-evaluate policy/budget; material scope changes create a new revision.", "decision-and-exact-scope-authorization"),
  edge("needs-decision", "cancelled", "decision-cancelled", "human", "Decision record and cancellation reason.", "Confirm the issue is not admitted for new work.", "human-cancellation"),
  edge("ready-for-review", "done", "candidate-accepted", "human", "Review and required QA evidence bound to the exact candidate fingerprint and scope revision.", "Confirm acceptance gates pass and the candidate has not changed.", "exact-candidate-approval"),
  edge("ready-for-review", "working", "bounded-rework-requested", "human", "Review findings and fingerprint of the rejected candidate.", "Correction allowance remains and requested work stays inside current scope.", "human-rework-under-current-scope"),
  edge("ready-for-review", "needs-decision", "review-escalated", "human", "Specific scope, evidence, policy, or budget issue found in review.", "Fail closed while the issue is unresolved.", "human-decision-to-exit"),
  edge("ready-for-review", "cancelled", "issue-cancelled", "human", "Issue id, review context, and cancellation reason.", "Confirm cancellation and prevent new execution admission.", "human-cancellation"),
  edge("blocked", "authorized", "blocker-resolved", "human", "Evidence the blocker is resolved, current scope revision, and intended next action.", "Revalidate target, policy, and remaining budgets before dispatch.", "explicit-resume-authorization"),
  edge("blocked", "needs-decision", "blocker-conflict-found", "control-plane", "Conflicting blocker evidence, changed scope, or newly discovered risk.", "Keep work blocked and require a human decision; do not infer resolution.", "human-decision-to-exit"),
  edge("blocked", "cancelled", "blocked-issue-cancelled", "human", "Issue id, blocker context, and cancellation reason.", "Confirm target issue and prevent further execution admission.", "human-cancellation"),
]);

export type IssueTransitionRejection =
  | "invalid-event-id"
  | "invalid-revision"
  | "duplicate-event"
  | "stale-revision"
  | "out-of-order-source"
  | "unknown-status"
  | "transition-not-allowed";

export interface IssueTransitionEnvelope {
  readonly event_id: string;
  readonly from: string;
  readonly to: string;
  readonly expected_revision: number;
}

export interface CurrentIssueReference {
  readonly status: string;
  readonly revision: number;
  readonly seen_event_ids: ReadonlySet<string>;
}

export type IssueTransitionCheck =
  | { readonly accepted: true; readonly rule: IssueTransitionRule }
  | { readonly accepted: false; readonly reason: IssueTransitionRejection };

const STATUS_SET: ReadonlySet<string> = new Set(ISSUE_STATUSES);
const TRANSITION_MAP: ReadonlyMap<string, IssueTransitionRule> = new Map(
  ISSUE_TRANSITIONS.map((rule) => [`${rule.from}\u0000${rule.to}`, rule]),
);

/** Pure envelope guard only; evidence, policy, identity, and approval stay external gates. */
export function checkIssueTransition(
  current: CurrentIssueReference,
  event: IssueTransitionEnvelope,
): IssueTransitionCheck {
  if (typeof event.event_id !== "string" || event.event_id.trim().length === 0) {
    return { accepted: false, reason: "invalid-event-id" };
  }
  if (!Number.isSafeInteger(event.expected_revision) || event.expected_revision < 1
    || !Number.isSafeInteger(current.revision) || current.revision < 1) {
    return { accepted: false, reason: "invalid-revision" };
  }
  if (current.seen_event_ids.has(event.event_id)) return { accepted: false, reason: "duplicate-event" };
  if (event.expected_revision !== current.revision) return { accepted: false, reason: "stale-revision" };
  if (!STATUS_SET.has(current.status) || !STATUS_SET.has(event.from) || !STATUS_SET.has(event.to)) {
    return { accepted: false, reason: "unknown-status" };
  }
  if (event.from !== current.status) return { accepted: false, reason: "out-of-order-source" };
  const rule = TRANSITION_MAP.get(`${event.from}\u0000${event.to}`);
  if (!rule) return { accepted: false, reason: "transition-not-allowed" };
  return { accepted: true, rule };
}
