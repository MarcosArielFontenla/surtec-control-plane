import { describe, it, expect } from "vitest";
import { runVerification } from "./verify";

const PASS = `node -e "process.exit(0)"`;
const FAIL = `node -e "process.exit(1)"`;
const BIG = `node -e "for(let i=0;i<5000;i++)process.stdout.write('x')"`;

describe("runVerification", () => {
  it("returns skipped for an empty command list", () => {
    const r = runVerification(process.cwd(), []);
    expect(r.status).toBe("skipped");
    expect(r.checks).toEqual([]);
  });

  it("returns passed when all commands exit 0", () => {
    const r = runVerification(process.cwd(), [PASS, PASS]);
    expect(r.status).toBe("passed");
    expect(r.checks).toHaveLength(2);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("fails fast: stops at the first failing command", () => {
    const r = runVerification(process.cwd(), [FAIL, PASS]);
    expect(r.status).toBe("failed");
    expect(r.checks).toHaveLength(1); // the second command never ran
    expect(r.checks[0].ok).toBe(false);
    expect(r.checks[0].command).toBe(FAIL);
  });

  it("truncates output_tail to at most 4000 chars", () => {
    const r = runVerification(process.cwd(), [BIG]);
    expect(r.status).toBe("passed");
    expect(r.checks[0].output_tail.length).toBeLessThanOrEqual(4000);
  });

  it("records a spawn error as a failed check (missing binary)", () => {
    const r = runVerification(process.cwd(), ["this-binary-does-not-exist-zzz --nope"]);
    expect(r.status).toBe("failed");
    expect(r.checks[0].ok).toBe(false);
  });
});
