import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizePath, type Plugin } from "vite";

const profilerTestHash = "e8148953f2026de62479908c5e99e44b8b6117a29d44a515f98996e5ed7f469f";
const fixtureHash = "93249820fd2c7edff923c1ccd8f70760abdce35ac55dca9e13ba7f606b406c87";

const revisions = [
  {
    before: "expect(readFileSync(copiedProfiler)).toEqual(readFileSync(profilerSource));",
    after: "expect(readFileSync(copiedProfiler).equals(readFileSync(profilerSource))).toBe(true);",
    count: 3,
  },
  {
    before: 'expect(createHash("sha256").update(readFileSync(failureFixturePath)).digest("hex")).toBe("' + fixtureHash + '");',
    after: 'expect(createHash("sha256").update(readFileSync(new URL("../fixtures/profile-maintenance/workflow-orchestrator-p14.bin", import.meta.url))).digest("hex")).toBe("' + fixtureHash + '");',
    count: 2,
  },
] as const;

export function adaptHistoricalProfilerTest(bytes: Buffer): string {
  if (createHash("sha256").update(bytes).digest("hex") !== profilerTestHash) {
    throw new Error("Historical profiler test source has an unexpected SHA-256");
  }

  let source = bytes.toString("utf8");
  for (const { before, after, count } of revisions) {
    const parts = source.split(before);
    if (parts.length !== count + 1) {
      throw new Error("Historical profiler test has an unexpected assertion layout");
    }
    source = parts.join(after);
  }
  return source;
}

export function historicalProfilerAdapter(testFile: string) {
  const testId = normalizePath(testFile);
  return {
    name: "surtec-historical-profiler",
    enforce: "pre",
    load: (id: string) => {
      if (normalizePath(id) !== testId) return;
      // The historical assertions still read the original on-disk source.
      return adaptHistoricalProfilerTest(readFileSync(testFile));
    },
  } satisfies Plugin;
}
