import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TestResult } from "vitest/node";
import { SUITE_PROGRESS_LIMITS } from "../profile-maintenance";
import CiVitestTimingReporter, { readCiVitestFailures, summarizeCiVitestTiming } from "./ci-vitest-timing";

const moduleA = { ordinal: 1, source: "lib/a.test.ts" };
const moduleB = { ordinal: 2, source: "lib/b.test.ts" };
const testCase = { ordinal: 1, alias: null };
const native = { cutoff: false, writerClosed: true, reporterOriginMs: 1000, processClosedMs: 1080 };
const cutoff = { cutoff: true, writerClosed: false, reporterOriginMs: 1000, processClosedMs: null };

function capture({ skipped = 0, firstDuration = 675, secondState = "passed" } = {}) {
  const lines: string[] = [];
  function frame(event: string, elapsed: number, module: typeof moduleA | null = null,
      test: typeof testCase | null = null, data: object | null = null, duration?: number) {
    lines.push("SUITE_PROGRESS_PROFILE " + JSON.stringify({
      schema_version: 1, kind: "suite-progress-observation", sequence: lines.length + 1,
      event, reporter_elapsed_ms: elapsed, module, case: test, data,
    }) + (duration === undefined ? "" : "\t" + duration) + "\n");
  }
  frame("reporter-init", 0);
  frame("run-start", 1, null, null, { module_count: 2 });
  frame("module-queued", 2, moduleA);
  frame("module-collected", 8, moduleA, null, { case_count: 1 });
  frame("module-start", 10, moduleA);
  frame("case-ready", 11, moduleA, testCase);
  frame("module-queued", 12, moduleB);
  frame("module-collected", 19, moduleB, null, { case_count: skipped + 1 });
  frame("module-start", 20, moduleB);
  frame("case-ready", 21, moduleB, testCase);
  for (let index = 0; index < skipped; index++) {
    const omitted = { ...testCase, ordinal: index + 2 };
    frame("case-ready", 22, moduleB, omitted);
    frame("case-result", 22, moduleB, omitted, { state: "skipped", original_attempt: null });
  }
  frame("case-result", 38, moduleA, testCase, { state: "passed", original_attempt: null }, firstDuration);
  frame("module-end", 40, moduleA, null, { state: "passed" });
  frame("case-result", 47, moduleB, testCase, { state: secondState, original_attempt: null }, 821);
  frame("module-end", 50, moduleB, null, { state: secondState });
  frame("run-end", 55, null, null, { reason: secondState, unhandled_errors: 0 });
  return lines;
}

describe("CI Vitest timing capture", () => {
  it("keeps queue, collection, overlapping module windows, and native close distinct", () => {
    const result = summarizeCiVitestTiming(Buffer.from(capture().join("")), native);
    expect(result).toMatchObject({
      status: "complete",
      completed_module_overlap_ms: 20,
      after_run_to_close_ms: 25,
      progress: { module_count: 2, counts: { passed: 2 }, run_end: { reason: "passed" } },
      modules: [
        { source: moduleA.source, queued_ms: 2, collected_ms: 8, started_ms: 10, ended_ms: 40 },
        { source: moduleB.source, queued_ms: 12, collected_ms: 19, started_ms: 20, ended_ms: 50 },
      ],
      case_durations: { measured: 2, missing: 0 },
      top_cases: [
        { source: moduleB.source, ordinal: 1, duration_ms: 821, observed_event_gap_ms: 26 },
        { source: moduleA.source, ordinal: 1, duration_ms: 675, observed_event_gap_ms: 27 },
      ],
      open_cases: [],
    });
  });

  it("retains the verified prefix and the pending case at a cut-off with a torn line", () => {
    const lines = capture();
    const bytes = Buffer.from(lines.slice(0, 12).join("") + lines[12]!.slice(0, 41));
    expect(summarizeCiVitestTiming(bytes, cutoff)).toMatchObject({
      status: "partial", clipped_tail: true,
      progress: { sequence: 12, run_end: null, counts: { passed: 1 } },
      top_cases: [{ source: moduleA.source, duration_ms: 675 }],
      open_cases: [{ source: moduleB.source, ordinal: 1, observed_age_ms: 19 }],
      after_run_to_close_ms: null,
    });
  });

  it("counts all 122 skipped cases without ranking any of them", () => {
    expect(summarizeCiVitestTiming(Buffer.from(capture({ skipped: 122 }).join("")), native)).toMatchObject({
      status: "complete",
      progress: { counts: { passed: 2, skipped: 122 } },
      case_durations: { measured: 2, missing: 0 },
      top_cases: [
        { source: moduleB.source, state: "passed", duration_ms: 821 },
        { source: moduleA.source, state: "passed", duration_ms: 675 },
      ],
      open_cases: [],
    });
  });

  it("counts missing durations and retains reported zeroes and failed cases", () => {
    const lines = capture({ firstDuration: 0, secondState: "failed" });
    expect(summarizeCiVitestTiming(Buffer.from(lines.join("")), native)).toMatchObject({
      top_cases: [{ state: "failed", duration_ms: 821 }, { state: "passed", duration_ms: 0 }],
    });
    expect(summarizeCiVitestTiming(Buffer.from(lines.join("").replace("\t0\n", "\n")), native)).toMatchObject({
      status: "complete",
      progress: { counts: { passed: 1, failed: 1 } },
      case_durations: { measured: 1, missing: 1 },
      top_cases: [{ state: "failed", duration_ms: 821 }],
    });
  });

  it.each(["NaN", "-1", "675\t821", ""])("rejects an invalid duration suffix %j", (invalid) => {
    const bytes = Buffer.from(capture().join("").replace("\t675\n", "\t" + invalid + "\n"));
    expect(summarizeCiVitestTiming(bytes, native)).toEqual({ status: "unavailable", reason: "invalid-duration" });
  });

  it("rejects a duration attached to a skipped result or a lifecycle frame", () => {
    const lines = capture({ skipped: 1 });
    for (const index of [0, 11]) {
      const invalid = [...lines];
      invalid[index] = invalid[index]!.trimEnd() + "\t7\n";
      expect(summarizeCiVitestTiming(Buffer.from(invalid.join("")), native))
        .toEqual({ status: "unavailable", reason: "invalid-transport" });
    }
  });

  it("rejects a lost lifecycle event even if the process reached its deadline", () => {
    const lines = capture();
    lines.splice(6, 1);
    expect(summarizeCiVitestTiming(Buffer.from(lines.join("")), cutoff)).toMatchObject({
      status: "unavailable", reason: "invalid-transport",
    });
  });

  it("requires both the run-end observation and the writer close for a finished capture", () => {
    const lines = capture();
    expect(summarizeCiVitestTiming(Buffer.from(lines.slice(0, -1).join("")), native))
      .toEqual({ status: "unavailable", reason: "missing-terminal-evidence" });
    expect(summarizeCiVitestTiming(Buffer.from(lines.join("")), { ...native, writerClosed: false }))
      .toEqual({ status: "unavailable", reason: "missing-terminal-evidence" });
  });

  it("rejects a torn line without a deadline and a stream above the existing byte cap", () => {
    const truncated = Buffer.from(capture().join("").slice(0, -1));
    expect(summarizeCiVitestTiming(truncated, native)).toEqual({ status: "unavailable", reason: "incomplete-frame" });
    expect(summarizeCiVitestTiming(Buffer.alloc(SUITE_PROGRESS_LIMITS.stderr_bytes + 1), cutoff))
      .toEqual({ status: "unavailable", reason: "capacity-exhausted" });
  });

  it("refuses unrelated bytes and a reversed clock boundary", () => {
    expect(summarizeCiVitestTiming(Buffer.from("private input\n"), cutoff))
      .toEqual({ status: "unavailable", reason: "invalid-transport" });
    expect(summarizeCiVitestTiming(Buffer.from(capture().join("")), { ...native, processClosedMs: 1040 }))
      .toEqual({ status: "unavailable", reason: "invalid-clock-boundary" });
  });
});

const worktreeFailure = {
  source: "runner/worktree.test.ts", name: "rejects untracked mutation after a passing preflight",
  file: "vitest-failure-worktree-untracked.json",
};
const hardLinkFailure = {
  source: "lib/routines/actions.test.ts", name: "does not overwrite or unlink a hard-linked report target",
  file: "vitest-failure-actions-hardlink.json",
};
const testRoot = fileURLToPath(new URL("../../", import.meta.url));

async function issueSyntheticResult(target: typeof worktreeFailure, makeResult: (directory: string) => TestResult,
  assertCapture: (data: { directory: string; bytes: Buffer; boundary: typeof native }) => void,
  afterResult?: (directory: string) => void) {
  const parent = join(testRoot, "tmp");
  mkdirSync(parent, { recursive: true });
  const directory = join(realpathSync(parent), "ci-vitest-timing-" + randomBytes(6).toString("hex"));
  mkdirSync(directory);
  const previous = process.env.SURTEC_CI_VITEST_TIMING_DIR;
  process.env.SURTEC_CI_VITEST_TIMING_DIR = directory;
  try {
    const result = makeResult(directory), project = {};
    const spec = { moduleId: join(testRoot, target.source), project, pool: "forks" };
    const module: Parameters<CiVitestTimingReporter["onTestModuleQueued"]>[0] = { ...spec, toTestSpecification: () => spec, children: { allTests: () => [test] }, state: () => result.state };
    const test = {
      module, name: target.name, result: () => result,
      diagnostic: () => ({ duration: 5010, retryCount: 0, repeatCount: 0, slow: false,
        startTime: 1, heap: undefined, flaky: false }),
    };
    const reporter = new CiVitestTimingReporter();
    reporter.onInit();
    reporter.onTestRunStart([spec]);
    reporter.onTestModuleQueued(module);
    reporter.onTestModuleCollected(module);
    reporter.onTestModuleStart(module);
    if (result.state !== "skipped") reporter.onTestCaseReady(test);
    reporter.onTestCaseResult(test);
    try {
      afterResult?.(directory);
    } finally {
      reporter.onTestModuleEnd(module);
      await reporter.onTestRunEnd([module], [], result.state === "failed" ? "failed" : "passed");
    }
    const { epoch_ms } = JSON.parse(readFileSync(join(directory, "vitest-origin.json"), "utf8"));
    assertCapture({ directory, bytes: readFileSync(join(directory, "vitest-progress.log")),
      boundary: { cutoff: false, writerClosed: true, reporterOriginMs: epoch_ms, processClosedMs: Date.now() + 100 } });
  } finally {
    if (previous === undefined) delete process.env.SURTEC_CI_VITEST_TIMING_DIR;
    else process.env.SURTEC_CI_VITEST_TIMING_DIR = previous;
    if (realpathSync(directory) === directory && dirname(directory) === realpathSync(parent)) {
      rmSync(directory, { recursive: true });
    }
  }
}

describe("CI Vitest targeted failure evidence", () => {
  it("flushes the exact timeout message before run-end and verifies a partial capture", async () => {
    const message = "Test timed out in 5000ms.\nUse a longer timeout for a long-running test.";
    const stack = "Error: " + message + "\n    at helper (" + join(testRoot, "helper.ts") + ":4:2)"
      + "\n    at case (" + join(testRoot, worktreeFailure.source) + ":182:4)";
    await issueSyntheticResult(worktreeFailure, () => ({ state: "failed", errors: [{ name: "Error", message, stack }] }),
      ({ directory, bytes, boundary }) => {
        const prefix = Buffer.from(bytes.toString("utf8").split("\n").slice(0, 7).join("\n") + "\n{\"torn\":");
        expect(readCiVitestFailures(directory, prefix, { ...boundary, cutoff: true, writerClosed: false })).toEqual([
          expect.objectContaining({ status: "captured", receipt: expect.objectContaining({
            message, error_name: "Error", site: { line: 182, column: 4 }, redacted: false, truncated: false, omitted_errors: 0,
          }) }),
          { source: hardLinkFailure.source, name: hardLinkFailure.name, status: "unknown" },
        ]);
      }, (directory) => {
        expect(existsSync(join(directory, "vitest-writer.json"))).toBe(false);
        expect(readFileSync(join(directory, worktreeFailure.file), "utf8")).toContain("Test timed out in 5000ms.");
      });
  });

  it("retains the assertion name and original message and counts additional errors", async () => {
    const message = "expected 1 to be 0";
    await issueSyntheticResult(hardLinkFailure, () => ({ state: "failed", errors: [
      { nameStr: "AssertionError", message, actual: "1", expected: "0" },
      { name: "Error", message: "second error" },
    ] }), ({ directory, bytes, boundary }) => {
      expect(readCiVitestFailures(directory, bytes, boundary)[1]).toMatchObject({
        status: "captured", receipt: { message, error_name: "AssertionError", omitted_errors: 1 },
      });
      expect(readFileSync(join(directory, hardLinkFailure.file), "utf8")).not.toContain("second error");
    });
  });

  it("keeps filesystem code and syscall while redacting secrets and temporary paths", async () => {
    await issueSyntheticResult(hardLinkFailure, (directory) => ({ state: "failed", errors: [{
      name: "Error", message: "EPERM: link '" + join(directory, "target.json") + "' Authorization: Bearer do-not-retain",
      code: "EPERM", syscall: "link", stacks: [{ file: join(testRoot, hardLinkFailure.source), line: 320, column: 61, method: "link" }],
    }] }), ({ directory, bytes, boundary }) => {
      const evidence = readCiVitestFailures(directory, bytes, boundary)[1];
      expect(evidence).toMatchObject({ status: "captured", receipt: {
        code: "EPERM", syscall: "link", redacted: true, truncated: false, site: { line: 320, column: 61 },
        message: expect.stringContaining("EPERM: link '[TEMP]"),
      } });
      const persisted = readFileSync(join(directory, hardLinkFailure.file), "utf8");
      expect(persisted).not.toContain("do-not-retain");
      expect(persisted).not.toContain(JSON.stringify(directory).slice(1, -1));
    });
  });

  it("bounds the serialized UTF-8 record and marks reduced messages", async () => {
    await issueSyntheticResult(worktreeFailure, () => ({ state: "failed", errors: [{ message: "failure: " + "🙂\n".repeat(3000) }] }),
      ({ directory, bytes, boundary }) => {
        const value = readCiVitestFailures(directory, bytes, boundary)[0];
        expect(value).toMatchObject({ status: "captured", receipt: { truncated: true, message: expect.stringMatching(/^failure: /) } });
        expect(readFileSync(join(directory, worktreeFailure.file)).length).toBeLessThanOrEqual(2048);
      });
  });

  it.each([
    { ...worktreeFailure, name: worktreeFailure.name + " (another case)" },
    { ...worktreeFailure, source: "runner/other.test.ts" },
  ])("ignores a nonmatching case: $source $name", async (target) => {
    await issueSyntheticResult(target, () => ({ state: "failed", errors: [{ message: "unrelated failure" }] }),
      ({ directory }) => expect(existsSync(join(directory, worktreeFailure.file))).toBe(false));
  });

  it("ignores earlier errors from a case that eventually passed", async () => {
    await issueSyntheticResult(worktreeFailure, () => ({ state: "passed", errors: [{ message: "earlier attempt" }] }),
      ({ directory }) => expect(existsSync(join(directory, worktreeFailure.file))).toBe(false));
  });

  it("marks a missing, truncated or unbound receipt unknown independently of progress", async () => {
    await issueSyntheticResult(worktreeFailure, () => ({ state: "failed", errors: [{ message: "failure" }] }),
      ({ directory, bytes, boundary }) => {
        const file = join(directory, worktreeFailure.file);
        const original = readFileSync(file, "utf8");
        expect(readCiVitestFailures(directory, bytes, { ...boundary, reporterOriginMs: boundary.reporterOriginMs - 1 })[0])
          .toMatchObject({ status: "unknown" });
        const record = JSON.parse(original);
        writeFileSync(file, JSON.stringify({ ...record, sequence: record.sequence + 1 }) + "\n");
        expect(readCiVitestFailures(directory, bytes, boundary)[0]).toMatchObject({ status: "unknown" });
        writeFileSync(file, original.slice(0, -3));
        expect(readCiVitestFailures(directory, bytes, boundary)[0]).toMatchObject({ status: "unknown" });
        unlinkSync(file);
        expect(readCiVitestFailures(directory, bytes, boundary)[0]).toMatchObject({ status: "unknown" });
        expect(summarizeCiVitestTiming(bytes, boundary)).toMatchObject({ status: "complete", progress: { counts: { failed: 1 } } });
      });
  });

  it("preserves progress and existing files when the exclusive diagnostic write fails", async () => {
    await issueSyntheticResult(worktreeFailure, (directory) => {
      writeFileSync(join(directory, worktreeFailure.file), "preexisting");
      return { state: "failed", errors: [{ message: "failure" }] };
    }, ({ directory, bytes, boundary }) => {
      expect(readFileSync(join(directory, worktreeFailure.file), "utf8")).toBe("preexisting");
      expect(readCiVitestFailures(directory, bytes, boundary)[0]).toMatchObject({ status: "unknown" });
      expect(summarizeCiVitestTiming(bytes, boundary)).toMatchObject({ status: "complete", progress: { counts: { failed: 1 } } });
    });
  });
});
