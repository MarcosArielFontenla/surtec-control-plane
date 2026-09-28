import { describe, expect, it } from "vitest";
import {
  checkIssueTransition,
  ISSUE_LIFECYCLE_VERSION,
  ISSUE_STATUSES,
  ISSUE_TRANSITIONS,
  WORK_SCALES,
  WORK_SCALE_CONTRACT,
  type CurrentIssueReference,
  type IssueTransitionEnvelope,
} from "./issue-lifecycle";

function current(status = "authorized", revision = 3, seen: string[] = []): CurrentIssueReference {
  return { status, revision, seen_event_ids: new Set(seen) };
}

function event(overrides: Partial<IssueTransitionEnvelope> = {}): IssueTransitionEnvelope {
  return { event_id: "event-4", from: "authorized", to: "working", expected_revision: 3, ...overrides };
}

describe("Phase J issue lifecycle reference contract", () => {
  it("pins the v1 work-scale and status vocabularies", () => {
    expect(ISSUE_LIFECYCLE_VERSION).toBe(1);
    expect(WORK_SCALES).toEqual(["trivial", "bounded", "substantial"]);
    expect(ISSUE_STATUSES).toEqual([
      "proposed", "authorized", "working", "checking", "needs-decision", "ready-for-review", "done", "blocked", "cancelled",
    ]);
  });

  it("keeps trivial work lightweight while requiring durable inputs for substantial work", () => {
    expect(WORK_SCALE_CONTRACT.trivial.substantialCeremonyByDefault).toBe(false);
    expect(WORK_SCALE_CONTRACT.bounded.substantialCeremonyByDefault).toBe(false);
    expect(WORK_SCALE_CONTRACT.substantial).toMatchObject({
      requiresDurableScope: true,
      requiresAcceptanceCriteria: true,
      requiresEvidenceRequirements: true,
      requiresNextAction: true,
      grantsAuthority: false,
    });
    expect(WORK_SCALE_CONTRACT.trivial.grantsAuthority).toBe(false);
    expect(WORK_SCALE_CONTRACT.bounded.grantsAuthority).toBe(false);
  });

  it("gives each allowed edge one complete actor/evidence/policy/approval contract", () => {
    const keys = ISSUE_TRANSITIONS.map((rule) => `${rule.from}->${rule.to}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ISSUE_TRANSITIONS.length).toBe(24);
    for (const rule of ISSUE_TRANSITIONS) {
      expect(["human", "control-plane"]).toContain(rule.actor);
      expect(rule.event.length).toBeGreaterThan(0);
      expect(rule.evidence.length).toBeGreaterThan(0);
      expect(rule.policy.length).toBeGreaterThan(0);
      expect(rule.approvalBasis.length).toBeGreaterThan(0);
      expect(rule.publicationAuthority).toBe("none");
    }
  });

  it("keeps terminal states closed and requires exact-candidate human acceptance for done", () => {
    expect(ISSUE_TRANSITIONS.filter((rule) => rule.from === "done" || rule.from === "cancelled")).toEqual([]);
    const doneEdges = ISSUE_TRANSITIONS.filter((rule) => rule.to === "done");
    expect(doneEdges).toHaveLength(1);
    expect(doneEdges[0]).toMatchObject({
      from: "ready-for-review",
      actor: "human",
      approvalBasis: "exact-candidate-approval",
      publicationAuthority: "none",
    });
  });

  it("does not allow scope expansion to skip a human decision", () => {
    expect(ISSUE_TRANSITIONS.some((rule) => rule.from === "working" && rule.to === "authorized")).toBe(false);
    expect(ISSUE_TRANSITIONS.filter((rule) => rule.from === "needs-decision").map((rule) => rule.to).sort())
      .toEqual(["authorized", "cancelled"]);
  });

  it("accepts an allowed transition envelope without mutating its source", () => {
    const source = current();
    expect(checkIssueTransition(source, event())).toMatchObject({
      accepted: true,
      rule: { from: "authorized", to: "working", actor: "control-plane" },
    });
    expect(source).toEqual(current());
  });

  it.each([
    ["blank event id", current(), event({ event_id: "  " }), "invalid-event-id"],
    ["invalid revision", current(), event({ expected_revision: 0 }), "invalid-revision"],
    ["duplicate event", current("authorized", 3, ["event-4"]), event(), "duplicate-event"],
    ["stale revision", current("authorized", 4), event(), "stale-revision"],
    ["out-of-order source", current("working"), event(), "out-of-order-source"],
    ["unknown status", current(), event({ to: "done-ish" }), "unknown-status"],
    ["forbidden edge", current(), event({ to: "done" }), "transition-not-allowed"],
  ] as const)("rejects %s without changing state", (_label, source, candidate, reason) => {
    const initialStatus = source.status;
    const initialRevision = source.revision;
    expect(checkIssueTransition(source, candidate)).toEqual({ accepted: false, reason });
    expect(source.status).toBe(initialStatus);
    expect(source.revision).toBe(initialRevision);
  });

  it("documents the guard's limit: acceptance does not evaluate evidence, policy, or approval", () => {
    const result = checkIssueTransition(current(), event());
    expect(result.accepted).toBe(true);
    if (result.accepted) expect(result.rule).toMatchObject({ approvalBasis: "current-scope-authorization" });
  });
});
