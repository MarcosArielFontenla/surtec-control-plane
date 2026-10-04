import { describe, expect, it } from "vitest";
import { doctorStatus, finding } from "./doctor";
describe("read-only Doctor", () => {
  it("never represents finding metadata as repair authority", () => { const result = finding("fixture", "Observed failure", ["AGENTS.md"], "Required evidence missing", "Review locally"); expect(result.safely_automatable).toBe(false); expect(doctorStatus({ findings: [result], status: "healthy", comparison: "compatible" })).toBe("warning"); });
  it("does not turn unsupported comparisons into healthy Doctor status", () => { expect(doctorStatus({ findings: [], status: "unknown", comparison: "unknown" })).toBe("unknown"); expect(doctorStatus({ findings: [], status: "invalid", comparison: "unknown" })).toBe("invalid"); });
});
