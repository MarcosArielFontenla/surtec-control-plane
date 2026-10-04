import { describe, expect, it } from "vitest";
import { routeWork, type RoutingInput } from "./routing";
const fixture = (): RoutingInput => ({ sandbox: "workspace-write", workScale: "trivial", criticality: "low", securityImpact: false, requiresMigration: false, affectedDomains: ["ui"], allowedPathPatterns: ["src/ui/**"], roleId: "software-engineer", minimumReview: "focused", testingMode: "functional", authorizationCurrent: true, requiredContextValid: true, budgetRemaining: true, availableConcurrency: 2, activeProjectWriter: false, independentAcceptance: true, isolationBenefit: "independent-review" });
describe("deterministic work routing", () => {
  it("keeps trivial low-risk work direct and never delegates it", () => {
    const result = routeWork(fixture()); expect(result.action).toBe("direct"); expect(result.review_depth).toBe("focused"); expect(result.delegation).toMatchObject({ admitted: false, executable: false });
    expect(routeWork(fixture())).toEqual(result);
  });
  it("requires planning and full review for migration/substantial work", () => {
    expect(routeWork({ ...fixture(), workScale: "substantial", requiresMigration: true })).toMatchObject({ action: "planning", review_depth: "full", qa_required: true });
  });
  it.each(["authorizationCurrent", "requiredContextValid", "budgetRemaining"] as const)("requires a decision for %s failure", (key) => {
    expect(routeWork({ ...fixture(), [key]: false })).toMatchObject({ action: "needs-decision", delegation: { admitted: false, executable: false } });
  });
  it("never admits a second writer, but permits independent read-only inspection", () => {
    expect(routeWork({ ...fixture(), activeProjectWriter: true }).action).toBe("needs-decision");
    expect(routeWork({ ...fixture(), sandbox: "read-only", activeProjectWriter: true, roleId: "reviewer" }).action).toBe("review");
  });
  it("records justified delegation as a proposal, never executing it", () => {
    expect(routeWork({ ...fixture(), workScale: "bounded" }).delegation).toMatchObject({ admitted: true, executable: false });
    expect(routeWork({ ...fixture(), workScale: "bounded", independentAcceptance: false }).delegation.admitted).toBe(false);
    expect(routeWork({ ...fixture(), workScale: "bounded", availableConcurrency: 1 }).delegation.admitted).toBe(false);
  });
});
