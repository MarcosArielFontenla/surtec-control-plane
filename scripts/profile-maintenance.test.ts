import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { existsSync, linkSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupOwnedRoot, continuePlannerDiagnosis, coreMeasurementPassed, createOwnedProfileRoot, createPlannerFsMarkerCollector, createPlannerFsObserver, createPlannerPhaseRecorder, fixtureProfileEnvironment, observationComplete, observeFunctionCalls, parsePlannerFsOutput, parsePlannerPhaseOutput, parseProfileArguments, plannerFsArguments, plannerFsEnvironment, PLANNER_FS_PHASES, PLANNER_PHASES, PROFILE_CLEANUP_RESERVE_MS, PROFILE_LIMIT_MS, PROFILE_WORKLOADS, ProfileDeadline, profileEnvironment, profileJobs, profileSummaries, runPlannerFsDiagnosticWatchdog, runProfileWatchdog, sanitizePlannerFsDiagnostic, sanitizePlannerFsReceipt, sanitizePlannerPhaseReceipt, sanitizeProfileReport, sourceHashesChanged, summarizeLoadedVitestOutput, summarizeVitestOutput, superviseChild, uninspectedOwnedRootCount, type PlannerFsDiagnosticReport, type PlannerFsReceipt, type PlannerPhaseReceipt, type ProfileReport, type SupervisedChild } from "./profile-maintenance";
import { createPlannerFailureCapture, createPlannerFailureMarkerCollector, parsePlannerFailureOutput, plannerFailureArguments, plannerFailureEnvironment, PLANNER_FAILURE_CASE, PLANNER_HOOK_TIMEOUT_MESSAGE, PLANNER_TEST_TIMEOUT_MESSAGE, projectPlannerFailureContext, runPlannerFailureDiagnosticWatchdog, sanitizePlannerFailureDiagnostic, sanitizePlannerFailureReceipt, sanitizePlannerFailureSourceMetadata, type PlannerFailureDiagnosticReport, type PlannerFailureReceipt, type PlannerFailureSourceLimits } from "./profile-maintenance";
import { createPlannerSpanCapture, createPlannerSpanMarkerCollector, parsePlannerSpanOutput, plannerSpanArguments, plannerSpanEnvironment, PLANNER_SPAN_PHASES, runPlannerSpanDiagnosticWatchdog, sanitizePlannerSpanCursor, sanitizePlannerSpanDiagnostic, sanitizePlannerSpanReceipt, type PlannerSpanDiagnosticReport, type PlannerSpanReceipt } from "./profile-maintenance";
import SuiteProgressReporter, { createSuiteProgressCollector, createSuiteProgressReporter, parseSuiteProgressOutput, runSuiteProgressDiagnosticWatchdog, sanitizeSuiteProgressDiagnostic, sanitizeSuiteProgressFrame, sanitizeSuiteProgressSnapshot, sanitizeSuiteProgressSourceMetadata, SUITE_PROGRESS_CONTRACT_HASHES, SUITE_PROGRESS_LIMITATIONS, SUITE_PROGRESS_LIMITS, SUITE_PROGRESS_SOURCES, suiteProgressArguments, suiteProgressEnvironment, summarizeSuiteProgressJson, type SuiteProgressDiagnosticReport, type SuiteProgressFrame, type SuiteProgressSnapshot } from "./profile-maintenance";
import { createSuiteAttributionCosts, sanitizeSuiteAttributionCosts, type SuiteAttributionCosts } from "./profile-maintenance";

const roots: string[] = [];
function ownedRoot() {
  const owned = createOwnedProfileRoot(); roots.push(owned.path); writeFileSync(join(owned.path, ".profile-owner"), owned.token);
  return owned;
}
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const path of roots.splice(0)) if (existsSync(path)) {
    expect(dirname(resolve(path))).toBe(resolve(tmpdir())); expect(lstatSync(path).isSymbolicLink()).toBe(false);
    rmSync(path, { recursive: true }); expect(existsSync(path)).toBe(false);
  }
});

const fixedFsNames = ["lstatSync", "statSync", "openSync", "fstatSync", "readSync", "readFileSync", "writeFileSync", "appendFileSync", "mkdirSync", "fsyncSync", "renameSync", "unlinkSync", "closeSync", "existsSync", "readdirSync"];
function fakeFsTarget(): Record<string, (...args: unknown[]) => unknown> { return Object.fromEntries(fixedFsNames.map((name) => [name, vi.fn(() => "synthetic-result")])); }
function completeFsReceipt(): PlannerFsReceipt { const target = fakeFsTarget(), observer = createPlannerFsObserver({ target, clock: () => 0, synchronize: () => {} }); for (const phase of PLANNER_FS_PHASES) { const end = observer.begin(phase); target.lstatSync!(); end(); } observer.finish(); return observer.receipt(); }
function partialFsReport(receipt: PlannerFsReceipt | null = completeFsReceipt()): PlannerFsDiagnosticReport { return { schema_version: 1, workload: "first-planner-fs", diagnostic_only: true, acceptance: false, status: "failed", wall_ms: 10, wall_limit_ms: PROFILE_LIMIT_MS, cleanup_reserve_ms: PROFILE_CLEANUP_RESERVE_MS, source_hashes: {}, source_hashes_after: {}, source_drift: null, receipt, suite: null, first_planner: null, cleanup: "unavailable-no-uncertain-fixture-deleted", limitations: [] }; }
describe("P06 bounded loaded Planner filesystem attribution", () => {
  it("keeps a single fixed loaded invocation separate from the original workload/jobs", () => {
    expect(parseProfileArguments(["--workload=first-planner-fs"])).toBe("first-planner-fs"); expect(PROFILE_WORKLOADS).not.toContain("first-planner-fs");
    const args = plannerFsArguments(); expect(args.slice(1)).toEqual(["run", "--reporter=json"]); expect(args.join(" ")).not.toContain("--maxWorkers"); expect(args.join(" ")).not.toContain("--testNamePattern");
    const env = plannerFsEnvironment({ PATH: "synthetic", SURTEC_TEST_PLANNER_PROFILE: "1", SURTEC_TEST_PLANNER_FS_PROFILE: "untrusted", OPENAI_API_KEY: "private", SURTEC_STATE_DIR: "private", NODE_OPTIONS: "private" });
    expect(env).toEqual({ PATH: "synthetic", NO_COLOR: "1", CI: "1", SURTEC_TEST_PLANNER_FS_PROFILE: "1" });
  });
  it("observes all fifteen fixed exports in both windows and preserves this, arguments and exact results", () => {
    const result = {}, argument = {}, target = fakeFsTarget(), sync = vi.fn();
    for (const name of fixedFsNames) target[name] = vi.fn(function (this: unknown, value: unknown, count: unknown) { expect(this).toBe(target); expect(value).toBe(argument); expect(count).toBe(3); return result; });
    const originals = { ...target }, observer = createPlannerFsObserver({ target, clock: () => 1, synchronize: sync });
    for (const phase of PLANNER_FS_PHASES) { const end = observer.begin(phase); for (const name of fixedFsNames) expect(target[name]!(argument, 3)).toBe(result); end(); }
    observer.finish(); const receipt = observer.receipt(); expect(receipt.observation_complete).toBe(true); expect(receipt.restoration_complete).toBe(true); expect(sync).toHaveBeenCalledTimes(4);
    for (const phase of PLANNER_FS_PHASES) for (const name of fixedFsNames) { expect(receipt.counts[phase]?.[`fs.${name}`]).toBe(1); expect(receipt.operation_elapsed_ms[phase]?.[`fs.${name}`]).toBe(0); expect(target[name]).toBe(originals[name]); }
    expect(JSON.stringify(receipt)).not.toContain("synthetic-result");
  });
  it("preserves promise and thrown error identities without awaiting or replacing them", () => {
    const promise = Promise.resolve(1), error = new Error("Synthetic original failure"), target = fakeFsTarget(); target.lstatSync = () => promise; target.openSync = () => { throw error; };
    const observer = createPlannerFsObserver({ target, clock: () => 1, synchronize: () => {} }), end = observer.begin("admission"); expect(target.lstatSync()).toBe(promise);
    let actual: unknown; try { target.openSync(); } catch (failure) { actual = failure; } expect(actual).toBe(error); end(); observer.begin("dispatch")(); observer.finish(); expect(observer.receipt().observation_complete).toBe(true);
  });
  it.each([0, 1, 2, 3])("keeps clock error at read %s unavailable without changing the original failure", (fault) => {
    let reads = 0; const target = fakeFsTarget(), error = new Error("Synthetic original failure"); target.lstatSync = () => { throw error; };
    const observer = createPlannerFsObserver({ target, clock: () => { if (reads++ === fault) throw new Error("Private observer fault"); return reads; }, synchronize: () => {} }), end = observer.begin("admission");
    let actual: unknown; try { target.lstatSync(); } catch (failure) { actual = failure; } expect(actual).toBe(error); expect(() => end()).not.toThrow(); observer.begin("dispatch")(); observer.finish(); expect(observer.receipt().observation_complete).toBe(false); expect(observer.receipt().restoration_complete).toBe(true);
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])("latches invalid/regressing clock values %s", (value) => {
    let reads = 0; const target = fakeFsTarget(), observer = createPlannerFsObserver({ target, clock: () => reads++ === 2 ? value : reads, synchronize: () => {} }), end = observer.begin("admission"); expect(target.lstatSync!()).toBe("synthetic-result"); end(); observer.begin("dispatch")(); observer.finish(); expect(observer.receipt().observation_complete).toBe(false);
  });
  it("latches a finite positive clock regression without changing results or inventing elapsed duration", () => {
    const readings = [2, 3, 2, 4, 5, 6], target = fakeFsTarget(), observer = createPlannerFsObserver({ target, clock: () => readings.shift() ?? 7, synchronize: () => {} }), end = observer.begin("admission");
    expect(target.lstatSync!()).toBe("synthetic-result"); end(); observer.begin("dispatch")(); observer.finish(); const receipt = observer.receipt();
    expect(receipt.observation_complete).toBe(false); expect(receipt.restoration_complete).toBe(true); expect(receipt.operation_elapsed_ms.admission?.["fs.lstatSync"]).toBeUndefined();
  });
  it("refuses duplicate/overlapping/late observations and restores an unfinished window without inventing wall time", () => {
    const target = fakeFsTarget(), original = target.lstatSync, observer = createPlannerFsObserver({ target, clock: () => 1, synchronize: () => {} }), end = observer.begin("admission"), saved = target.lstatSync!;
    observer.begin("dispatch")(); observer.finish(); expect(target.lstatSync).toBe(original); expect(observer.receipt().phases_wall_ms.admission).toBeUndefined(); expect(observer.receipt().observation_complete).toBe(false);
    expect(() => end()).not.toThrow(); expect(saved()).toBe("synthetic-result"); expect(observer.receipt().observation_complete).toBe(false);
  });
  it.each(["finish", "receipt"] as const)("keeps an in-flight original result when it invokes %s and never clocks after closing", (action) => {
    const target = fakeFsTarget(), result = {}, clock = vi.fn(() => 1); let observer!: ReturnType<typeof createPlannerFsObserver>;
    target.lstatSync = () => { observer[action](); return result; }; observer = createPlannerFsObserver({ target, clock, synchronize: () => {} }); const end = observer.begin("admission"); expect(target.lstatSync()).toBe(result); const reads = clock.mock.calls.length; end(); observer.finish();
    expect(clock).toHaveBeenCalledTimes(reads); expect(observer.receipt().observation_complete).toBe(false);
  });
  it("preserves a foreign descriptor and invalidates an unexpected reset to the original", () => {
    for (const kind of ["foreign", "original"] as const) {
      const target = fakeFsTarget(), original = target.lstatSync!, foreign = () => "foreign", observer = createPlannerFsObserver({ target, clock: () => 1, synchronize: () => {} }), end = observer.begin("admission");
      target.lstatSync = kind === "foreign" ? foreign : original; end(); observer.begin("dispatch")(); observer.finish(); expect(target.lstatSync).toBe(kind === "foreign" ? foreign : original); expect(observer.receipt().observation_complete).toBe(false);
    }
  });
  it("does not execute getter/proxy hooks and rolls back partial installation", () => {
    const getter = vi.fn(), target = fakeFsTarget(), original = target.lstatSync; Object.defineProperty(target, "readFileSync", { configurable: true, enumerable: true, get: getter });
    const observer = createPlannerFsObserver({ target, clock: () => 1, synchronize: () => {} }); observer.begin("admission")(); observer.finish(); expect(target.lstatSync).toBe(original); expect(getter).not.toHaveBeenCalled(); expect(observer.receipt().observation_complete).toBe(false);
    const hook = vi.fn(), proxy = new Proxy(fakeFsTarget(), { getOwnPropertyDescriptor: hook }); const proxied = createPlannerFsObserver({ target: proxy, clock: () => 1, synchronize: () => {} }); proxied.begin("admission")(); proxied.finish(); expect(hook).not.toHaveBeenCalled(); expect(proxied.receipt().observation_complete).toBe(false);
  });
  it("attempts every owned restoration when one fails and never overwrites unknown foreign state", () => {
    const target = fakeFsTarget(), originals = { ...target }, nativeDefine = Object.defineProperty, observer = createPlannerFsObserver({ target, clock: () => 1, synchronize: () => {} }), end = observer.begin("admission");
    const define = vi.spyOn(Object, "defineProperty").mockImplementation((object, key, descriptor) => { if (object === target && key === "readFileSync" && descriptor.value === originals.readFileSync) throw new Error("Synthetic restore outage"); return nativeDefine(object, key, descriptor); });
    end(); define.mockRestore(); observer.finish(); expect(observer.receipt().restoration_complete).toBe(false);
    for (const name of fixedFsNames) if (name !== "readFileSync") expect(target[name]).toBe(originals[name]);
    nativeDefine(target, "readFileSync", { value: originals.readFileSync, configurable: true, enumerable: true, writable: true });
  });
  it.each([1, 2])("marks synchronization fault %s unavailable while preserving the original operation", (fault) => {
    let calls = 0; const target = fakeFsTarget(), observer = createPlannerFsObserver({ target, clock: () => 1, synchronize: () => { if (++calls === fault) throw new Error("Synthetic bridge fault"); } }), end = observer.begin("admission"); expect(target.lstatSync!()).toBe("synthetic-result"); end(); observer.begin("dispatch")(); observer.finish(); expect(observer.receipt().observation_complete).toBe(false);
  });
  it("wraps and restores the real native named ESM alias in a tiny owned fixture", () => {
    const root = ownedRoot(), original = fs.lstatSync, observer = createPlannerFsObserver();
    try {
      const admission = observer.begin("admission"); try { expect(fs.lstatSync).not.toBe(original); expect(lstatSync(root.path).isDirectory()).toBe(true); } finally { admission(); } expect(fs.lstatSync).toBe(original);
      const dispatch = observer.begin("dispatch"); try { expect(lstatSync(root.path).isDirectory()).toBe(true); } finally { dispatch(); }
    } finally { observer.finish(); }
    const receipt = observer.receipt();
    expect(receipt.observation_complete).toBe(true); expect(receipt.restoration_complete).toBe(true); expect(receipt.counts.admission?.["fs.lstatSync"]).toBe(1); expect(receipt.counts.dispatch?.["fs.lstatSync"]).toBe(1); expect(JSON.stringify(receipt)).not.toContain(root.path);
  });
  it("projects one native marker across chunks and invalidates prior progress on a duplicate or malformed late marker", () => {
    const receipt = completeFsReceipt(), updates: Array<PlannerFsReceipt | null> = [], collector = createPlannerFsMarkerCollector((value) => updates.push(value)), line = `PLANNER_FS_PROFILE ${JSON.stringify(receipt)}\n`;
    collector.push(line.slice(0, 13)); collector.push(line.slice(13)); expect(updates).toEqual([receipt]); collector.push("PLANNER_FS_PROFILE {invalid"); expect(updates.at(-1)).toBeNull(); expect(collector.finish()).toBeNull();
    expect(parsePlannerFsOutput(line)).toEqual(receipt); expect(parsePlannerFsOutput(line + line)).toBeNull(); expect(parsePlannerFsOutput("PLANNER_FS_PROFILE {invalid}\n")).toBeNull();
  });
  it("rejects duplicate/escaped keys, raw extras, getters, proxies and invalid operation mappings", () => {
    const receipt = completeFsReceipt(), raw = JSON.stringify(receipt), duplicate = raw.replace('"fs.lstatSync":1', '"fs.lstatSync":1,"fs.lstatSync":2'), escaped = raw.replace('"fs.lstatSync":1', '"fs.lstatSync":1,"fs.lstat' + String.fromCharCode(92) + 'u0053ync":2');
    expect(parsePlannerFsOutput(`PLANNER_FS_PROFILE ${duplicate}\n`)).toBeNull(); expect(parsePlannerFsOutput(`PLANNER_FS_PROFILE ${escaped}\n`)).toBeNull();
    for (const value of [{ ...receipt, private: "body" }, { ...receipt, variant: "analysis" }, { ...receipt, schema_version: 2 }, { ...receipt, counts: { admission: { "fs.PrivatePath": 1 } } }, { ...receipt, counts: { admission: { "fs.lstatSync": Number.MAX_SAFE_INTEGER + 1 } } }, { ...receipt, operation_elapsed_ms: {} }, { ...receipt, restoration_complete: false }]) expect(sanitizePlannerFsReceipt(value)).toBeNull();
    const hook = vi.fn(), getter = { ...receipt }; Object.defineProperty(getter, "variant", { enumerable: true, get: hook }); expect(sanitizePlannerFsReceipt(getter)).toBeNull(); expect(hook).not.toHaveBeenCalled(); expect(sanitizePlannerFsReceipt(new Proxy(receipt, {}))).toBeNull();
  });
  it("keeps actual full-suite and first-Planner results separate from the receipt", () => {
    const json = JSON.stringify({ numTotalTestSuites: 1, success: false, testResults: [{ name: "D:/synthetic/runner/workflow-orchestrator.test.ts", assertionResults: [{ fullName: "runs only the exact first read-only implementation stage and retains a human gate", status: "failed", duration: 5001 }, { fullName: "another real test", status: "passed", duration: 3 }, { status: "skipped" }] }] });
    expect(summarizeLoadedVitestOutput(json)).toEqual({ suite: { passed: false, passed_tests: 1, failed_tests: 1, skipped_tests: 1, test_ms: 5004 }, first_planner: { passed: false, test_ms: 5001 } });
    const report = partialFsReport(); expect(sanitizePlannerFsDiagnostic(report)?.acceptance).toBe(false); expect(sanitizePlannerFsDiagnostic({ ...report, status: "completed" })).toBeNull(); expect(JSON.stringify(sanitizePlannerFsDiagnostic({ ...report, private: "body" }))).not.toContain("body");
  });
  it("rejects contradictory IPC suite/planner success counters rather than crediting invented completion", () => {
    const base = partialFsReport(), source_hashes = completedPlannerReport().source_hashes;
    const completed = { ...base, status: "completed", source_hashes, source_hashes_after: { ...source_hashes }, source_drift: false, suite: { passed: true, passed_tests: 1, failed_tests: 0, skipped_tests: 0, test_ms: 1 }, first_planner: { passed: true, test_ms: 1 }, cleanup: "verified-normal-suite-and-no-new-planner-prefix-roots" };
    expect(sanitizePlannerFsDiagnostic(completed)?.status).toBe("completed");
    expect(sanitizePlannerFsDiagnostic({ ...completed, suite: { ...completed.suite, passed_tests: 0 } })).toBeNull();
    expect(sanitizePlannerFsDiagnostic({ ...completed, status: "failed", suite: { ...completed.suite, failed_tests: 1 } })).toBeNull();
    expect(sanitizePlannerFsDiagnostic({ ...completed, status: "failed", suite: { ...completed.suite, passed: false, passed_tests: 0 } })).toBeNull();
  });
  it("retains a sanitized partial receipt on watchdog expiry without claiming suite or cleanup acceptance", async () => {
    vi.useFakeTimers(); const start = Date.now(), child = new Child(), deadline = new ProfileDeadline(() => Date.now() - start), partial = partialFsReport(); child.send.mockImplementation(() => { child.emit("message", { role: "planner-fs-progress", report: partial }); });
    const pending = runPlannerFsDiagnosticWatchdog(deadline, () => child); await vi.advanceTimersByTimeAsync(PROFILE_LIMIT_MS); const report = await pending;
    expect(report.status).toBe("deadline"); expect(report.receipt).toEqual(partial.receipt); expect(report.acceptance).toBe(false); expect(report.suite).toBeNull(); expect(report.cleanup).toBe("unavailable-no-uncertain-fixture-deleted"); expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
class Child extends EventEmitter implements SupervisedChild {
  readonly signals: Array<NodeJS.Signals | undefined> = [];
  readonly stdout = { destroy: vi.fn(), on: vi.fn() };
  readonly stderr = { destroy: vi.fn(), on: vi.fn() };
  readonly channel = { unref: vi.fn() };
  readonly connected = true;
  readonly disconnect = vi.fn();
  readonly unref = vi.fn();
  readonly send = vi.fn();
  kill(signal?: NodeJS.Signals): boolean { this.signals.push(signal); return true; }
}
function failedReport(): ProfileReport {
  return { schema_version: 1, workload: "routine-history", status: "failed", wall_limit_ms: PROFILE_LIMIT_MS, cleanup_reserve_ms: PROFILE_CLEANUP_RESERVE_MS, wall_ms: 10, source_hashes: {}, source_hashes_after: {}, source_drift: null, samples: [{ mode: "wall", control: null, kind: "fixture", sample: 1, status: "failed", wall_ms: 10, preparation_ms: null, action_verification_ms: null, assertion_observation_ms: null, fixture_test_ms: 5001, operations: 1, counts: null, operation_elapsed_ms: null, planner_phases: null, cleanup_ms: 0, cleanup_complete: false }], summaries: [], cleanup: { complete: false, retained_owned_roots: 0, uninspected_owned_roots: 0, fixture_cleanup: "unavailable" }, limitations: [] };
}
function reporter(statuses: Array<{ status: string; duration: number }>, success = true) {
  return JSON.stringify({ numTotalTestSuites: 1, success, numFailedTests: success ? 0 : 1, testResults: [{ assertionResults: statuses }] });
}

describe("T015 finite synthetic maintenance profiler", () => {
  it("accepts only the fixed workload enum and defaults to core", () => {
    expect(parseProfileArguments([])).toBe("core");
    for (const workload of PROFILE_WORKLOADS) expect(parseProfileArguments([`--workload=${workload}`])).toBe(workload);
  });
  it.each([["--path=D:/private/state"], ["--workload=unknown"], ["--workload=core", "--workload=recovery"], ["--command=pnpm test"], ["--internal-core"], ["--workload", "core"], ["--workload=core\n"]].map((args) => ({ args })))("refuses paths, commands, internal entry and expanded selections $args", ({ args }) => {
    expect(() => parseProfileArguments(args)).toThrow("Only one fixed");
  });
  it("does not forward provider credentials, user state, flags, Git overrides or loader code", () => {
    const env = profileEnvironment({ PATH: "synthetic-path", SystemRoot: "synthetic-windows", TEMP: "synthetic-temp", OPENAI_API_KEY: "synthetic-secret", GH_TOKEN: "synthetic-secret", SURTEC_STATE_DIR: "private-state", SURTEC_CODEX_WRITE_SMOKE: "1", SURTEC_MAINTENANCE_BROWSER_SMOKE: "1", NODE_OPTIONS: "--import untrusted", GIT_CONFIG_GLOBAL: "private", HOME: "private", USERPROFILE: "private", unrelated: "private" });
    expect(env).toEqual({ PATH: "synthetic-path", SystemRoot: "synthetic-windows", TEMP: "synthetic-temp", NO_COLOR: "1", CI: "1" });
    expect(JSON.stringify(env)).not.toContain("private"); expect(JSON.stringify(env)).not.toContain("secret");
  });
  it("transparent observation preserves this, arguments and exact return identity", () => {
    const returned = {}, first = {}, counts: string[] = [];
    const target = { marker: "synthetic", method(this: { marker: string }, arg: object, second: number) { expect(this.marker).toBe("synthetic"); expect(arg).toBe(first); expect(second).toBe(2); return returned; } };
    const original = target.method, restore = observeFunctionCalls(target, ["method"], (name) => counts.push(name));
    expect(target.method(first, 2)).toBe(returned); expect(counts).toEqual(["method"]); restore(); restore(); expect(target.method).toBe(original);
  });
  it("transparent observation preserves thrown errors and promise identity without observing payloads", () => {
    const error = new Error("synthetic private body"), promise = Promise.resolve(1), target = { failure() { throw error; }, promise() { return promise; } }, count = vi.fn();
    const restore = observeFunctionCalls(target, ["failure", "promise"], count);
    try { expect(() => target.failure()).toThrow(error); expect(target.promise()).toBe(promise); expect(count.mock.calls).toEqual([["failure"], ["promise"]]); } finally { restore(); }
  });
  it("observes synchronous elapsed durations with this, arguments and return identity unchanged", () => {
    let now = 10; const result = {}, argument = {}, elapsed: Array<[string, number]> = [];
    const target = { marker: result, run(this: { marker: object }, value: object) { expect(this.marker).toBe(result); expect(value).toBe(argument); now = 17.25; return result; } };
    const restore = observeFunctionCalls(target, ["run"], () => {}, { clock: () => now, observe: (name, duration) => elapsed.push([name, duration]) });
    try { expect(target.run(argument)).toBe(result); expect(elapsed).toEqual([["run", 7.25]]); } finally { restore(); }
  });
  it("records elapsed time in finally and preserves exact thrown identity", () => {
    let now = 0; const failure = new Error("Synthetic private error"), elapsed = vi.fn(), target = { run() { now = 12; throw failure; } };
    const restore = observeFunctionCalls(target, ["run"], () => {}, { clock: () => now, observe: elapsed });
    try { let actual: unknown; try { target.run(); } catch (error) { actual = error; } expect(actual).toBe(failure); expect(elapsed).toHaveBeenCalledExactlyOnceWith("run", 12); } finally { restore(); }
  });
  it("times only the synchronous return of a promise without replacing or awaiting it", () => {
    let now = 0; const promise = Promise.resolve("synthetic"), elapsed = vi.fn(), target = { run() { now = 3; return promise; } };
    const restore = observeFunctionCalls(target, ["run"], () => {}, { clock: () => now, observe: elapsed });
    try { expect(target.run()).toBe(promise); now = 100; expect(elapsed).toHaveBeenCalledExactlyOnceWith("run", 3); } finally { restore(); }
  });
  it("does not turn unavailable or failed observation into a changed operation result or fabricated duration", () => {
    const result = {}, failure = new Error("Synthetic original error"), elapsed = vi.fn(), target = { result() { return result; }, error() { throw failure; } };
    const restore = observeFunctionCalls(target, ["result", "error"], () => { throw new Error("Synthetic observer failure"); }, { clock: () => { throw new Error("Synthetic clock unavailable"); }, observe: elapsed });
    try { expect(target.result()).toBe(result); let actual: unknown; try { target.error(); } catch (error) { actual = error; } expect(actual).toBe(failure); expect(elapsed).not.toHaveBeenCalled(); } finally { restore(); }
  });
  it("a failing elapsed callback cannot replace the original thrown error", () => {
    const failure = new Error("Synthetic original error"), target = { run() { throw failure; } };
    const restore = observeFunctionCalls(target, ["run"], () => {}, { clock: () => 1, observe: () => { throw new Error("Synthetic recording failure"); } });
    try { let actual: unknown; try { target.run(); } catch (error) { actual = error; } expect(actual).toBe(failure); } finally { restore(); }
  });
  it.each(["count", "clock-start", "clock-end", "start-NaN", "end-NaN", "start-Infinity", "end-Infinity", "regression", "record"] as const)("latches %s observation faults without changing results or admitting a successful measurement", (fault) => {
    const result = {}, failure = new Error("Synthetic original failure"), target = { result() { return result; }, failure() { throw failure; } }; let calls = 0;
    const restore = observeFunctionCalls(target, ["result", "failure"], () => { if (fault === "count") throw new Error("Synthetic counting fault"); }, {
      clock: () => {
        const start = calls++ % 2 === 0;
        if (fault === (start ? "clock-start" : "clock-end")) throw new Error("Synthetic clock fault");
        if (fault === (start ? "start-NaN" : "end-NaN")) return Number.NaN;
        if (fault === (start ? "start-Infinity" : "end-Infinity")) return Number.POSITIVE_INFINITY;
        return fault === "regression" ? start ? 2 : 1 : calls;
      }, observe: () => { if (fault === "record") throw new Error("Synthetic recording fault"); },
    });
    try {
      expect(target.result()).toBe(result); let actual: unknown; try { target.failure(); } catch (error) { actual = error; } expect(actual).toBe(failure); expect(observationComplete(restore)).toBe(false);
      const receipt = { preparation_ms: 0, action_verification_ms: 0, assertion_observation_ms: 0, operations: 100, counts: null, operation_elapsed_ms: null, observation_complete: observationComplete(restore), writer_idle: true };
      expect(coreMeasurementPassed(receipt, "counts")).toBe(false); expect(receipt.writer_idle).toBe(true);
    } finally { restore(); }
    expect(observationComplete(restore)).toBe(false);
  });
  it("keeps clock regression across calls latched and does not accept forged observer health", () => {
    const readings = [1, 3, 2, 4], target = { run: () => 1 }, restore = observeFunctionCalls(target, ["run"], () => {}, { clock: () => readings.shift()!, observe: () => {} });
    try { expect(target.run()).toBe(1); expect(observationComplete(restore)).toBe(true); expect(target.run()).toBe(1); expect(observationComplete(restore)).toBe(false); } finally { restore(); }
    expect(observationComplete(() => {})).toBe(false);
  });
  it("accepts complete zero-millisecond elapsed measurements but refuses null, missing keys or zero counts", () => {
    const counts = { preparation: {}, action_verification: { "fs.lstatSync": 2 }, assertion_observation: {} }, elapsed = { preparation: {}, action_verification: { "fs.lstatSync": 0 }, assertion_observation: {} };
    const receipt = { preparation_ms: 0, action_verification_ms: 0, assertion_observation_ms: 0, operations: 100, counts, operation_elapsed_ms: elapsed, observation_complete: true, writer_idle: true };
    expect(coreMeasurementPassed(receipt, "counts")).toBe(true); expect(coreMeasurementPassed({ ...receipt, operation_elapsed_ms: null }, "counts")).toBe(false);
    expect(coreMeasurementPassed({ ...receipt, operation_elapsed_ms: { ...elapsed, action_verification: {} } }, "counts")).toBe(false);
    expect(coreMeasurementPassed({ ...receipt, counts: { ...counts, action_verification: { "fs.lstatSync": 0 } } }, "counts")).toBe(false);
  });
  it("does not invoke getters and rolls back a partially installed observer", () => {
    const getter = vi.fn(), target = { method: () => 1 }, original = target.method;
    Object.defineProperty(target, "getter", { configurable: true, get: getter });
    expect(() => observeFunctionCalls(target, ["method", "getter"], () => {})).toThrow("Observation target unavailable");
    expect(target.method).toBe(original); expect(getter).not.toHaveBeenCalled();
  });
  it("uses one deadline across setup and successive samples, reserving cleanup inside 900 seconds", () => {
    let now = 0; const deadline = new ProfileDeadline(() => now);
    expect(deadline.remaining()).toBe(PROFILE_LIMIT_MS); expect(deadline.workRemaining()).toBe(PROFILE_LIMIT_MS - PROFILE_CLEANUP_RESERVE_MS);
    now = 400_000; expect(deadline.workRemaining()).toBe(470_000);
    now = 870_000; expect(deadline.mayLaunch()).toBe(false); expect(deadline.remaining()).toBe(30_000);
    now = 900_001; expect(deadline.remaining()).toBe(0); expect(deadline.elapsed()).toBe(900_001);
  });
  it("does not kill an issued child after its normal observed close", async () => {
    const child = new Child(), result = superviseChild(child, new ProfileDeadline(() => 0)); child.emit("close", 0);
    await expect(result).resolves.toEqual({ exit_code: 0, closed: true, expired: false, failed: false }); expect(child.signals).toEqual([]);
  });
  it("stops only the stalled issued handle and preserves uncertain closure", async () => {
    vi.useFakeTimers(); const start = Date.now(), child = new Child(), foreign = new Child();
    const deadline = new ProfileDeadline(() => Date.now() - start + 869_999), result = superviseChild(child, deadline, 10);
    await vi.advanceTimersByTimeAsync(21);
    await expect(result).resolves.toEqual({ exit_code: null, closed: false, expired: true, failed: false });
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]); expect(foreign.signals).toEqual([]);
    expect(child.stdout.destroy).toHaveBeenCalledOnce(); expect(child.stderr.destroy).toHaveBeenCalledOnce(); expect(child.disconnect).toHaveBeenCalledOnce(); expect(child.channel.unref).toHaveBeenCalledOnce(); expect(child.unref).toHaveBeenCalledOnce();
    expect(foreign.stdout.destroy).not.toHaveBeenCalled(); expect(foreign.unref).not.toHaveBeenCalled();
  });
  it("waits for owned closure after a process error rather than leaving its handle alive", async () => {
    vi.useFakeTimers(); const child = new Child(), result = superviseChild(child, new ProfileDeadline(() => 0), 10);
    child.emit("error", new Error("private subprocess body")); expect(child.signals).toEqual(["SIGTERM"]); child.emit("close", 1);
    await expect(result).resolves.toEqual({ exit_code: 1, closed: true, expired: false, failed: true });
  });
  it("does not leave shutdown timers when kill closes the issued handle synchronously", async () => {
    vi.useFakeTimers(); const child = new Child();
    vi.spyOn(child, "kill").mockImplementation((signal) => { child.signals.push(signal); child.emit("close", 1); return true; });
    const result = superviseChild(child, new ProfileDeadline(() => 870_000), 10);
    await vi.advanceTimersByTimeAsync(0); await expect(result).resolves.toEqual({ exit_code: 1, closed: true, expired: true, failed: false });
    expect(child.signals).toEqual(["SIGTERM"]); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not restart the wall ceiling when supervising a second sample", async () => {
    vi.useFakeTimers(); const start = Date.now(), deadline = new ProfileDeadline(() => Date.now() - start);
    const first = new Child(), firstResult = superviseChild(first, deadline); await vi.advanceTimersByTimeAsync(400_000); first.emit("close", 0); await firstResult;
    const second = new Child(), secondResult = superviseChild(second, deadline, 10); await vi.advanceTimersByTimeAsync(470_020);
    await expect(secondResult).resolves.toMatchObject({ expired: true, closed: false }); expect(deadline.elapsed()).toBe(870_020); expect(deadline.remaining()).toBe(29_980);
  });
  it("bounds shutdown when the cleanup reserve has already been exhausted", async () => {
    vi.useFakeTimers(); const child = new Child(), result = superviseChild(child, new ProfileDeadline(() => PROFILE_LIMIT_MS), 10);
    await vi.advanceTimersByTimeAsync(0); await expect(result).resolves.toMatchObject({ expired: true, closed: false }); expect(child.signals).toEqual(["SIGTERM"]);
  });
  it("removes only a verified owned root after proven writer quiescence", () => {
    const root = ownedRoot(); writeFileSync(join(root.path, "synthetic.json"), "{}"); expect(cleanupOwnedRoot(root, true)).toBe(true); expect(existsSync(root.path)).toBe(false);
  });
  it.each([false, true])("retains bytes for uncertain writers or mismatched ownership, writersCertain=%s", (writersCertain) => {
    const root = ownedRoot(), file = join(root.path, "synthetic.json"); writeFileSync(file, "synthetic unchanged bytes");
    expect(cleanupOwnedRoot({ ...root, token: writersCertain ? "wrong-token" : root.token }, writersCertain)).toBe(false); expect(readFileSync(file, "utf8")).toBe("synthetic unchanged bytes");
  });
  it("refuses identity replacement, broad paths and hard-linked descendants", () => {
    const root = ownedRoot(); expect(cleanupOwnedRoot({ ...root, ino: -1 }, true)).toBe(false);
    expect(cleanupOwnedRoot({ ...root, path: resolve(tmpdir()) }, true)).toBe(false);
    const file = join(root.path, "one.json"); writeFileSync(file, "synthetic"); linkSync(file, join(root.path, "two.json"));
    expect(cleanupOwnedRoot(root, true)).toBe(false); expect(readFileSync(file, "utf8")).toBe("synthetic");
  });
  it("tracks a returned root whose initial identity cannot be inspected rather than inventing cleanup", () => {
    const before = uninspectedOwnedRootCount(), nativeCreate = fs.mkdtempSync.bind(fs), nativeStat = fs.lstatSync.bind(fs); let created = "";
    vi.spyOn(fs, "mkdtempSync").mockImplementation((...args) => { const path = nativeCreate(...args); created = String(path); roots.push(created); return path; });
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => { if (String(args[0]) === created) throw new Error("Synthetic initial identity outage"); return nativeStat(...args); });
    expect(() => createOwnedProfileRoot()).toThrow("Synthetic initial identity outage"); expect(uninspectedOwnedRootCount()).toBe(before + 1);
    vi.restoreAllMocks(); expect(existsSync(created)).toBe(true);
  });
  it("stops a cleanup walk at the shared deadline before removing its target", () => {
    const root = ownedRoot(), file = join(root.path, "synthetic.json"); writeFileSync(file, "unchanged"); let now = 0;
    const deadline = new ProfileDeadline(() => now), nativeStat = fs.lstatSync.bind(fs), remove = vi.spyOn(fs, "rmSync");
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => { const value = nativeStat(...args); if (String(args[0]) === file) now = PROFILE_LIMIT_MS; return value; });
    expect(cleanupOwnedRoot(root, true, deadline)).toBe(false); expect(remove).not.toHaveBeenCalled(); expect(readFileSync(file, "utf8")).toBe("unchanged");
  });
  it("refuses cleanup when its reserve is already exhausted", () => {
    const root = ownedRoot(); expect(cleanupOwnedRoot(root, true, new ProfileDeadline(() => PROFILE_LIMIT_MS))).toBe(false); expect(existsSync(root.path)).toBe(true);
  });
  it("detects source drift without surfacing source bodies", () => {
    expect(sourceHashesChanged({ safe: "a".repeat(64) }, { safe: "a".repeat(64) })).toBe(false);
    expect(sourceHashesChanged({ safe: "a".repeat(64) }, { safe: "b".repeat(64) })).toBe(true);
    expect(sourceHashesChanged({ safe: "a".repeat(64) }, {})).toBe(true);
  });
  it("projects aggregate controller reports and rejects raw paths or operation text", () => {
    const report = failedReport(), raw = { ...report, token: "PRIVATE TOKEN", limitations: ["PRIVATE BODY STACK PATH"] };
    const projected = sanitizeProfileReport(raw, "routine-history"); expect(projected?.samples[0]?.fixture_test_ms).toBe(5001); expect(JSON.stringify(projected)).not.toContain("PRIVATE");
    expect(sanitizeProfileReport({ ...report, source_hashes: { "D:/private/state": "a".repeat(64) } }, "routine-history")).toBeNull();
    expect(sanitizeProfileReport({ ...report, status: "completed" }, "routine-history")).toBeNull();
    expect(sanitizeProfileReport({ ...report, samples: [report.samples[0]!, report.samples[0]!] }, "routine-history")).toBeNull();
  });
  it("projects numeric elapsed sums only for the separate counts pass and closed operations", () => {
    const report = failedReport(), table = { preparation: {}, action_verification: { "fs.lstatSync": 4.25 }, assertion_observation: {} };
    const sample = { ...report.samples[0]!, kind: "boundary" as const, control: "absent" as const, mode: "counts" as const, fixture_test_ms: null, counts: { preparation: {}, action_verification: { "fs.lstatSync": 2 }, assertion_observation: {} }, operation_elapsed_ms: table };
    const raw = { ...report, workload: "core" as const, samples: [sample] };
    const projected = sanitizeProfileReport(raw, "core"); expect(projected?.samples[0]?.operation_elapsed_ms).toEqual(table); expect(projected?.limitations.join(" ")).toContain("must not be summed as a kernel census");
    expect(sanitizeProfileReport({ ...raw, samples: [{ ...sample, operation_elapsed_ms: { ...table, action_verification: { "fs.PrivateToken": 4.25 } } }] }, "core")).toBeNull();
    expect(sanitizeProfileReport({ ...raw, samples: [{ ...sample, operation_elapsed_ms: { ...table, action_verification: { "fs.lstatSync": -1 } } }] }, "core")).toBeNull();
    expect(sanitizeProfileReport({ ...raw, samples: [{ ...sample, mode: "wall", counts: null }] }, "core")).toBeNull();
    expect(sanitizeProfileReport({ ...raw, samples: [{ ...sample, operation_elapsed_ms: null }] }, "core")?.samples[0]?.operation_elapsed_ms).toBeNull();
    expect(sanitizeProfileReport({ ...raw, samples: [{ ...sample, status: "passed", operations: 100, operation_elapsed_ms: null }] }, "core")).toBeNull();
    expect(sanitizeProfileReport({ ...raw, samples: [{ ...sample, status: "passed", operations: 100, operation_elapsed_ms: { ...table, action_verification: {} } }] }, "core")).toBeNull();
  });
  it("publishes failed partial measurements only after a closed controller with a valid aggregate receipt", async () => {
    const child = new Child(); child.send.mockImplementation(() => { child.emit("message", { role: "profile-report", report: failedReport() }); child.emit("close", 0); });
    const report = await runProfileWatchdog("routine-history", new ProfileDeadline(() => 10), () => child);
    expect(report.status).toBe("failed"); expect(report.samples[0]?.fixture_test_ms).toBe(5001); expect(report.cleanup.complete).toBe(false); expect(child.signals).toEqual([]);
  });
  it("does not trust a report when controller completion or descendant writers remain uncertain", async () => {
    const child = new Child(); child.send.mockImplementation(() => { child.emit("message", { role: "profile-report", report: failedReport() }); child.emit("close", 1); });
    const report = await runProfileWatchdog("routine-history", new ProfileDeadline(() => 10), () => child);
    expect(report.samples).toEqual([]); expect(report.cleanup.complete).toBe(false); expect(report.cleanup.retained_owned_roots).toBeNull(); expect(report.cleanup.uninspected_owned_roots).toBeNull();
  });
  it("keeps the outer watchdog responsive while its synthetic controller stalls, including reserved cleanup", async () => {
    vi.useFakeTimers(); const start = Date.now(), child = new Child(), deadline = new ProfileDeadline(() => Date.now() - start);
    const pending = runProfileWatchdog("core", deadline, () => child);
    await vi.advanceTimersByTimeAsync(870_000); expect(child.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000); const report = await pending;
    expect(report.status).toBe("deadline"); expect(report.wall_ms).toBe(PROFILE_LIMIT_MS); expect(report.cleanup.complete).toBe(false); expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]); expect(child.unref).toHaveBeenCalledOnce();
  });
  it("retains sanitized completed-job progress on expiry without claiming the controller or active fixture is clean", async () => {
    vi.useFakeTimers(); const start = Date.now(), child = new Child(), deadline = new ProfileDeadline(() => Date.now() - start), partial = failedReport();
    child.send.mockImplementation(() => { child.emit("message", { role: "profile-progress", report: partial }); });
    const pending = runProfileWatchdog("routine-history", deadline, () => child); await vi.advanceTimersByTimeAsync(PROFILE_LIMIT_MS);
    const report = await pending; expect(report.status).toBe("deadline"); expect(report.samples[0]?.fixture_test_ms).toBe(5001); expect(report.source_drift).toBeNull(); expect(report.cleanup.complete).toBe(false); expect(report.cleanup.retained_owned_roots).toBeNull();
  });
  it("bounds a failed IPC send through the owned supervisor rather than waiting a fresh sample deadline", async () => {
    vi.useFakeTimers(); const child = new Child(); child.send.mockImplementation(() => { throw new Error("Private IPC error body"); });
    const pending = runProfileWatchdog("core", new ProfileDeadline(() => 0), () => child); await vi.advanceTimersByTimeAsync(2000);
    const report = await pending; expect(report.status).toBe("failed"); expect(report.cleanup.complete).toBe(false); expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]); expect(JSON.stringify(report)).not.toContain("Private IPC");
  });
  it("keeps failed fixture durations and exact selected counts without exposing errors, paths or record bodies", () => {
    const raw = `unrelated private output\n${JSON.stringify({ numTotalTestSuites: 1, success: false, numFailedTests: 1, testResults: [{ assertionResults: [{ status: "failed", duration: 5001, failureMessages: ["PRIVATE ROOT TOKEN BODY STACK"] }, { status: "passed", duration: 2 }, { status: "skipped", duration: 0 }] }] })}`;
    const result = summarizeVitestOutput(raw, 2); expect(result).toEqual({ passed: false, test_ms: 5003, tests: 2 }); expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("accepts formatted reporter JSON but never counts filtered cases as passes", () => {
    const value = JSON.parse(reporter([{ status: "passed", duration: 10 }, { status: "skipped", duration: 0 }]));
    expect(summarizeVitestOutput(JSON.stringify(value, null, 2), 1)).toEqual({ passed: true, test_ms: 10, tests: 1 });
    expect(summarizeVitestOutput(JSON.stringify(value), 2).passed).toBe(false);
  });
  it.each(["not JSON with private body", '{"numTotalTestSuites":1,"success":true}', '{"numTotalTestSuites":1,"testResults":null}', ""]) ("sanitizes malformed output %j", (output) => {
    expect(summarizeVitestOutput(output, 1)).toEqual({ passed: false, test_ms: 0, tests: 0 });
  });
  it("computes medians only after three actual successful wall samples and excludes counts passes", () => {
    type Entry = Parameters<typeof profileSummaries>[0][number];
    const sample = (wall_ms: number, mode: Entry["mode"] = "wall", status: Entry["status"] = "passed"): Entry => ({ mode, control: "absent", kind: "boundary", sample: 1, status, wall_ms, preparation_ms: 0, action_verification_ms: 0, assertion_observation_ms: 0, fixture_test_ms: null, operations: 100, counts: null, operation_elapsed_ms: null, planner_phases: null, cleanup_ms: 0, cleanup_complete: true });
    expect(profileSummaries([sample(3), sample(1), sample(2), sample(100, "counts")])).toEqual([{ kind: "boundary", control: "absent", samples: 3, median_wall_ms: 2, maximum_wall_ms: 3 }]);
    expect(profileSummaries([sample(3), sample(1, "wall", "failed")])).toEqual([{ kind: "boundary", control: "absent", samples: 1, median_wall_ms: null, maximum_wall_ms: null }]);
  });
});

function completePlannerReceipt(): PlannerPhaseReceipt {
  let now = 0; const recorder = createPlannerPhaseRecorder(() => now++);
  for (const phase of PLANNER_PHASES) recorder.begin(phase)();
  return recorder.receipt();
}
function completedPlannerReport(): ProfileReport {
  const base = failedReport(), source_hashes = Object.fromEntries(["scripts/profile-maintenance.ts", "lib/state/maintenance.ts", "lib/state/store.ts", "lib/state/events.ts", "lib/state/paths.ts", "lib/state/validation.ts", "schemas/maintenance-control.schema.json", "runner/workflow-orchestrator.test.ts"].map((path) => [path, "a".repeat(64)]));
  return { ...base, workload: "first-planner", status: "completed", source_hashes, source_hashes_after: { ...source_hashes }, source_drift: false, samples: profileJobs("first-planner").map((job) => ({ ...base.samples[0]!, ...job, status: "passed", wall_ms: job.sample, fixture_test_ms: 1, operations: 1, planner_phases: job.mode === "phases" ? completePlannerReceipt() : null, cleanup_complete: true })), cleanup: { complete: true, retained_owned_roots: 0, uninspected_owned_roots: 0, fixture_cleanup: "verified-no-new-prefix-roots" } };
}
describe("P05 first Planner timestamp-only diagnosis", () => {
  it("keeps three original wall samples and one separate fixed phase pass", () => {
    expect(profileJobs("first-planner").map(({ mode, sample }) => ({ mode, sample }))).toEqual([{ mode: "wall", sample: 1 }, { mode: "wall", sample: 2 }, { mode: "wall", sample: 3 }, { mode: "phases", sample: 1 }]);
    expect(profileJobs("core")).toHaveLength(24); expect(profileJobs("corrections")).toHaveLength(3);
  });
  it("issues exactly the one opt-in diagnostic flag only to the separate first-Planner phase child", () => {
    const source = { PATH: "synthetic", SURTEC_TEST_PLANNER_PROFILE: "user-value", OPENAI_API_KEY: "private" };
    expect(fixtureProfileEnvironment("first-planner", "phases", source)).toEqual({ PATH: "synthetic", NO_COLOR: "1", CI: "1", SURTEC_TEST_PLANNER_PROFILE: "1" });
    for (const workload of PROFILE_WORKLOADS) expect(fixtureProfileEnvironment(workload, "wall", source)).not.toHaveProperty("SURTEC_TEST_PLANNER_PROFILE");
    expect(fixtureProfileEnvironment("recovery", "phases", source)).not.toHaveProperty("SURTEC_TEST_PLANNER_PROFILE");
  });
  it("continues bounded diagnosis after a failed wall sample without restarting its deadline or relabeling failure", () => {
    expect(continuePlannerDiagnosis("first-planner", "failed", true, false, false)).toBe(true);
    expect(continuePlannerDiagnosis("first-planner", "deadline", true, true, false)).toBe(false);
    expect(continuePlannerDiagnosis("first-planner", "failed", false, false, false)).toBe(false);
    expect(continuePlannerDiagnosis("corrections", "failed", true, false, false)).toBe(false);
    expect(continuePlannerDiagnosis("first-planner", "failed", true, false, true)).toBe(false);
    let elapsed = 870_000; const deadline = new ProfileDeadline(() => elapsed); expect(deadline.mayLaunch()).toBe(false); elapsed = 900_000; expect(deadline.remaining()).toBe(0);
  });
  it("records all twelve finite phases once and seals a deeply frozen aggregate", () => {
    const receipt = completePlannerReceipt(); expect(receipt.observation_complete).toBe(true); expect(Object.keys(receipt.phases_ms)).toEqual([...PLANNER_PHASES]);
    for (const phase of PLANNER_PHASES) { expect(receipt.phases_ms[phase]).toBe(1); expect(receipt.phase_counts[phase]).toBe(1); }
    expect(Object.isFrozen(receipt)).toBe(true); expect(Object.isFrozen(receipt.phases_ms)).toBe(true); expect(Object.isFrozen(receipt.phase_counts)).toBe(true);
  });
  it("executes no callback and does not await, wrap or replace an original result or error", () => {
    const hook = vi.fn(), recorder = createPlannerPhaseRecorder(() => 1), promise = Promise.resolve(1), failure = new Error("Synthetic original error");
    expect(() => recorder.begin(hook as never)()).not.toThrow(); expect(hook).not.toHaveBeenCalled();
    const end = recorder.begin("issue-create"), result = promise; end(); expect(result).toBe(promise);
    let actual: unknown; const finish = recorder.begin("issue-authorize"); try { try { throw failure; } finally { finish(); } } catch (error) { actual = error; }
    expect(actual).toBe(failure); expect(recorder.receipt().observation_complete).toBe(false);
  });
  it("retains missing/active observations as incomplete and never heals a receipt after its seal", () => {
    const clock = vi.fn(() => 1), recorder = createPlannerPhaseRecorder(clock), end = recorder.begin("preview"), first = recorder.receipt();
    expect(first.observation_complete).toBe(false); expect(first.phase_counts).toEqual({ preview: 1 }); expect(first.phases_ms).toEqual({}); end();
    expect(recorder.receipt()).toBe(first); expect(clock).toHaveBeenCalledOnce();
  });
  it("latches duplicate phase/end observations without invoking another clock", () => {
    const clock = vi.fn(() => 1), recorder = createPlannerPhaseRecorder(clock), end = recorder.begin("preview"); recorder.begin("preview")(); end(); end();
    expect(clock).toHaveBeenCalledTimes(2); expect(recorder.receipt().observation_complete).toBe(false); expect(recorder.receipt().phase_counts).toEqual({ preview: 1 });
  });
  it("downgrades later receipts after sealed begin/end misuse without mutating the historical snapshot", () => {
    let now = 0; const clock = vi.fn(() => now++), recorder = createPlannerPhaseRecorder(clock); let firstEnd!: () => void;
    for (const phase of PLANNER_PHASES) { const end = recorder.begin(phase); if (!firstEnd) firstEnd = end; end(); }
    const first = recorder.receipt(); expect(first.observation_complete).toBe(true); recorder.begin("preview")(); firstEnd();
    expect(clock).toHaveBeenCalledTimes(24); expect(recorder.receipt().observation_complete).toBe(false); expect(first.observation_complete).toBe(true);
  });
  it.each(["already-active", "begins-during-cleanup"] as const)("refuses complete observation when a body phase %s overlaps cleanup", (kind) => {
    let now = 0; const recorder = createPlannerPhaseRecorder(() => now++);
    const body = kind === "already-active" ? recorder.begin("issue-create") : undefined, cleanup = recorder.begin("cleanup");
    if (body) body(); else recorder.begin("issue-create")();
    for (const phase of PLANNER_PHASES) if (!["issue-create", "cleanup"].includes(phase)) recorder.begin(phase)(); cleanup();
    const receipt = recorder.receipt(); expect(Object.keys(receipt.phases_ms)).toHaveLength(12); expect(receipt.observation_complete).toBe(false);
  });
  it.each(["start-error", "end-error", "start-NaN", "end-NaN", "start-Infinity", "end-Infinity", "negative", "regression"] as const)("keeps %s clock faults non-throwing and unavailable", (fault) => {
    let calls = 0; const clock = () => { const start = calls++ === 0; if (fault === (start ? "start-error" : "end-error")) throw new Error("Synthetic private clock error"); if (fault === (start ? "start-NaN" : "end-NaN")) return Number.NaN; if (fault === (start ? "start-Infinity" : "end-Infinity")) return Number.POSITIVE_INFINITY; return fault === "negative" ? -1 : fault === "regression" ? start ? 2 : 1 : calls; };
    const recorder = createPlannerPhaseRecorder(clock); expect(() => recorder.begin("preview")()).not.toThrow(); const receipt = recorder.receipt(); expect(receipt.observation_complete).toBe(false); expect(receipt.phases_ms).toEqual({}); expect(JSON.stringify(receipt)).not.toContain("private");
  });
  it("parses one closed phase marker independently of the real Vitest JSON aggregate", () => {
    const receipt = completePlannerReceipt(), output = `PLANNER_PHASE_PROFILE ${JSON.stringify(receipt)}\n${reporter([{ status: "passed", duration: 2 }])}`;
    expect(parsePlannerPhaseOutput(output)).toEqual(receipt); expect(summarizeVitestOutput(output, 1)).toEqual({ passed: true, test_ms: 2, tests: 1 });
    expect(parsePlannerPhaseOutput(`${output}\nPLANNER_PHASE_PROFILE ${JSON.stringify(receipt)}`)).toBeNull(); expect(parsePlannerPhaseOutput("PLANNER_PHASE_PROFILE {invalid}")).toBeNull();
  });
  it("rejects duplicate JSON properties including escaped phase aliases", () => {
    const raw = JSON.stringify(completePlannerReceipt()), duplicate = raw.replace('"preview":1', '"preview":1,"preview":2'), escaped = raw.replace('"preview":1', '"preview":1,"pre' + String.fromCharCode(92) + 'u0076iew":2');
    expect(parsePlannerPhaseOutput(`PLANNER_PHASE_PROFILE ${duplicate}`)).toBeNull(); expect(parsePlannerPhaseOutput(`PLANNER_PHASE_PROFILE ${escaped}`)).toBeNull();
  });
  it("refuses wrong variants, schema versions, extra fields, unknown keys, invalid counters and malformed completion", () => {
    const receipt = completePlannerReceipt();
    for (const value of [{ ...receipt, variant: "analysis" }, { ...receipt, schema_version: 2 }, { ...receipt, private: "body" }, { ...receipt, phases_ms: { ...receipt.phases_ms, "D:/private": 1 } }, { ...receipt, phases_ms: { ...receipt.phases_ms, preview: -1 } }, { ...receipt, phase_counts: { ...receipt.phase_counts, preview: 2 } }, { ...receipt, phases_ms: {} }]) expect(sanitizePlannerPhaseReceipt(value)).toBeNull();
    const hook = vi.fn(), accessor = { ...receipt }; Object.defineProperty(accessor, "variant", { enumerable: true, get: hook }); expect(sanitizePlannerPhaseReceipt(accessor)).toBeNull(); expect(hook).not.toHaveBeenCalled();
    const proxyHook = vi.fn(), proxy = new Proxy(receipt, { get: proxyHook }); expect(sanitizePlannerPhaseReceipt(proxy)).toBeNull(); expect(proxyHook).not.toHaveBeenCalled();
  });
  it("accepts completed first-Planner campaigns only with all four jobs, the real test counts and complete phase evidence", () => {
    const report = completedPlannerReport(); expect(sanitizeProfileReport(report, "first-planner")?.samples).toHaveLength(4);
    expect(sanitizeProfileReport({ ...report, samples: report.samples.slice(0, 3) }, "first-planner")).toBeNull();
    expect(sanitizeProfileReport({ ...report, samples: report.samples.map((sample) => sample.mode === "phases" ? { ...sample, planner_phases: { ...sample.planner_phases!, observation_complete: false } } : sample) }, "first-planner")).toBeNull();
    expect(sanitizeProfileReport({ ...report, samples: report.samples.map((sample) => sample.mode === "phases" ? { ...sample, operations: 0 } : sample) }, "first-planner")).toBeNull();
  });
  it("never promotes a passed phase receipt over a failed wall sample or leaks phase receipts into other modes", () => {
    const report = completedPlannerReport(), failed = { ...report, samples: report.samples.map((sample) => sample.mode === "wall" && sample.sample === 1 ? { ...sample, status: "failed" as const } : sample) };
    expect(sanitizeProfileReport(failed, "first-planner")).toBeNull(); expect(sanitizeProfileReport({ ...failed, status: "failed" }, "first-planner")?.status).toBe("failed");
    expect(sanitizeProfileReport({ ...report, samples: report.samples.map((sample) => sample.mode === "wall" ? { ...sample, planner_phases: completePlannerReceipt() } : sample) }, "first-planner")).toBeNull();
    const incomplete = { ...report, status: "failed", samples: [{ ...report.samples[3]!, status: "failed", planner_phases: { schema_version: 1, variant: "implementation", phases_ms: {}, phase_counts: {}, observation_complete: false } }] };
    expect(sanitizeProfileReport(incomplete, "first-planner")?.samples[0]?.planner_phases?.observation_complete).toBe(false);
  });
});

const failureFixturePath = resolve("runner/workflow-orchestrator.test.ts");
const failureSourceLimits: PlannerFailureSourceLimits = { line_columns: Object.freeze(Array.from({ length: 40 }, () => 80)) };
type SyntheticFailureContext = (() => void) & { task: { name: string; file: { filepath: string }; result: Record<string, unknown>; [key: string]: unknown } };
function failureContext(result: Record<string, unknown> = { state: "fail", retryCount: 0, repeatCount: 0, errors: [{ name: "Error", message: PLANNER_TEST_TIMEOUT_MESSAGE }] }): SyntheticFailureContext {
  const context = () => {};
  Object.defineProperty(context, "task", { value: { name: PLANNER_FAILURE_CASE, file: { filepath: failureFixturePath }, result }, configurable: true, writable: true, enumerable: true });
  return context as SyntheticFailureContext;
}
function failureReceipt(context = failureContext()): PlannerFailureReceipt {
  const receipt = projectPlannerFailureContext(context, failureSourceLimits);
  if (!receipt) throw new Error("Synthetic selected binding unavailable");
  return receipt;
}
function partialFailureReport(receipt: PlannerFailureReceipt | null = failureReceipt()): PlannerFailureDiagnosticReport {
  return { schema_version: 1, workload: "first-planner-failure", diagnostic_only: true, acceptance: false, status: "failed", wall_ms: 10, wall_limit_ms: PROFILE_LIMIT_MS, cleanup_reserve_ms: PROFILE_CLEANUP_RESERVE_MS, source_hashes: { "runner/workflow-orchestrator.test.ts": "a".repeat(64) }, source_hashes_after: {}, source_drift: null, receipt, suite: null, first_planner: null, cleanup: "unavailable-no-uncertain-fixture-deleted", limitations: [] };
}
function failureSourceEnvelope() { return { role: "planner-failure-source", fixture_sha256: "a".repeat(64), sourceLimits: failureSourceLimits }; }
function completedFailureReport(): PlannerFailureDiagnosticReport {
  const source_hashes = completedPlannerReport().source_hashes;
  return { ...partialFailureReport(failureReceipt(failureContext({ state: "pass", retryCount: 0, repeatCount: 0 }))), status: "completed", source_hashes, source_hashes_after: { ...source_hashes }, source_drift: false, suite: { passed: true, passed_tests: 1, failed_tests: 0, skipped_tests: 0, test_ms: 1 }, first_planner: { passed: true, test_ms: 1 }, cleanup: "verified-normal-suite-and-no-new-planner-prefix-roots" };
}
describe("P08 early bounded first-Planner failure evidence", () => {
  it("keeps one opt-in full-workload selection and the existing worker/time bounds", () => {
    expect(parseProfileArguments(["--workload=first-planner-failure"])).toBe("first-planner-failure"); expect(parseProfileArguments([])).toBe("core"); expect(PROFILE_WORKLOADS).not.toContain("first-planner-failure");
    expect(plannerFailureArguments()).toEqual(plannerFsArguments()); expect(plannerFailureArguments().slice(1)).toEqual(["run", "--reporter=json"]);
    expect(plannerFailureArguments().join(" ")).not.toMatch(/maxWorkers|testNamePattern|retry|repeat|bail/); expect(PROFILE_LIMIT_MS).toBe(900_000); expect(PROFILE_CLEANUP_RESERVE_MS).toBe(30_000);
    const inherited = { PATH: "synthetic", SURTEC_TEST_PLANNER_FAILURE_PROFILE: "private", SURTEC_TEST_PLANNER_PROFILE: "1", SURTEC_TEST_PLANNER_FS_PROFILE: "1", SURTEC_MAINTENANCE_BROWSER_SMOKE: "1", SURTEC_STATE_DIR: "private", OPENAI_API_KEY: "private", NODE_OPTIONS: "private" };
    expect(plannerFailureEnvironment(inherited)).toEqual({ PATH: "synthetic", NO_COLOR: "1", CI: "1", SURTEC_TEST_PLANNER_FAILURE_PROFILE: "1" });
    expect(profileEnvironment(inherited)).toEqual({ PATH: "synthetic", NO_COLOR: "1", CI: "1" }); expect(plannerFsEnvironment(inherited)).not.toHaveProperty("SURTEC_TEST_PLANNER_FAILURE_PROFILE"); expect(fixtureProfileEnvironment("first-planner", "phases", inherited)).not.toHaveProperty("SURTEC_TEST_PLANNER_FAILURE_PROFILE");
  });
  it("projects an installed-style function context and regenerates only the complete public Test-timeout signature", () => {
    const context = failureContext(), result = context.task.result, errors = result.errors, descriptors = Object.getOwnPropertyDescriptors(result), receipt = failureReceipt(context);
    expect(receipt).toMatchObject({ schema_version: 1, kind: "planner-failure-observation", variant: "implementation", observation_point: "start-of-existing-root-afterEach", result_scope: "pre-cleanup-framework-result", acceptance: false, framework_state: "fail", capture_status: "captured", error_count: 1, classification_complete: true, unavailable_reason: null });
    expect(receipt.errors[0]).toMatchObject({ index: 0, reported_name: "Error", signature: "test-timeout-5000", message: "Test timed out in 5000ms.", sites: [] });
    expect(context.task.result).toBe(result); expect(result.errors).toBe(errors); expect(Object.getOwnPropertyDescriptors(result)).toEqual(descriptors); expect(Object.isFrozen(context)).toBe(false); expect(Object.isFrozen(result)).toBe(false); expect(Object.isFrozen(errors)).toBe(false);
    expect(Object.isFrozen(receipt)).toBe(true); expect(Object.isFrozen(receipt.errors)).toBe(true); expect(Object.isFrozen(receipt.errors[0])).toBe(true); expect(Object.isFrozen(receipt.errors[0]!.sites)).toBe(true);
  });
  it("distinguishes the unchanged Hook timeout rather than guessing from duration or a name", () => {
    expect(PLANNER_TEST_TIMEOUT_MESSAGE).toBe('Test timed out in 5000ms.\nIf this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".');
    expect(PLANNER_HOOK_TIMEOUT_MESSAGE).toBe('Hook timed out in 10000ms.\nIf this is a long-running hook, pass a timeout value as the last argument or configure it globally with "hookTimeout".');
    const context = failureContext({ state: "fail", retryCount: 0, repeatCount: 0, duration: 999_999, errors: [{ name: "PrivateOwnerName", message: PLANNER_HOOK_TIMEOUT_MESSAGE }] }), receipt = failureReceipt(context);
    expect(receipt.errors[0]).toMatchObject({ reported_name: "unknown", signature: "hook-timeout-10000", message: "Hook timed out in 10000ms." }); expect(receipt.classification_complete).toBe(true); expect(JSON.stringify(receipt)).not.toContain("PrivateOwnerName");
  });
  it.each(["Error", "AssertionError", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "AggregateError", "PrivateName"]) ("keeps the reported %s name closed and omits an unsupported private message", (name) => {
    const receipt = failureReceipt(failureContext({ state: "fail", retryCount: 0, repeatCount: 0, errors: [{ name, message: "Private owner token and result body", expected: "PRIVATE EXPECTED", actual: "PRIVATE ACTUAL", cause: { message: "PRIVATE CAUSE" } }] }));
    expect(receipt.errors[0]).toMatchObject({ reported_name: name === "PrivateName" ? "unknown" : name, signature: "unsupported", message: null }); expect(receipt.classification_complete).toBe(false); expect(JSON.stringify(receipt)).not.toMatch(/Private|PRIVATE/);
  });
  it.each(["Test timed out in 5000ms.", `${PLANNER_TEST_TIMEOUT_MESSAGE} private suffix`, PLANNER_TEST_TIMEOUT_MESSAGE.replace("5000", "6000"), PLANNER_HOOK_TIMEOUT_MESSAGE.replace("10000", "5000"), PLANNER_TEST_TIMEOUT_MESSAGE.replace("\n", "\r\n")])("does not treat a prefix, suffix or other timeout value as the installed signature", (message) => {
    const receipt = failureReceipt(failureContext({ state: "fail", retryCount: 0, repeatCount: 0, errors: [{ name: "Error", message }] })); expect(receipt.errors[0]?.signature).toBe("unsupported"); expect(receipt.errors[0]?.message).toBeNull(); expect(receipt.classification_complete).toBe(false);
  });
  it("captures pass with exactly zero errors but never turns missing or contradictory state into pass", () => {
    for (const errors of [undefined, []]) {
      const result = { state: "pass", retryCount: 0, repeatCount: 0, ...(errors === undefined ? {} : { errors }) }, receipt = failureReceipt(failureContext(result));
      expect(receipt).toMatchObject({ framework_state: "pass", capture_status: "captured", error_count: 0, errors: [], classification_complete: true });
    }
    for (const result of [{ state: "run", retryCount: 0, repeatCount: 0 }, { state: "pass", retryCount: 0, repeatCount: 0, errors: [{ name: "Error", message: PLANNER_TEST_TIMEOUT_MESSAGE }] }, { state: "fail", retryCount: 0, repeatCount: 0 }, { state: "fail", retryCount: 0, repeatCount: 0, errors: [] }]) {
      expect(failureReceipt(failureContext(result))).toMatchObject({ framework_state: "unavailable", capture_status: "unavailable", error_count: null, errors: [], classification_complete: false });
    }
  });
  it("selects only the exact trusted module and literal case, ignoring unrelated cyclic suite data", () => {
    const context = failureContext(); context.task.suite = context; expect(failureReceipt(context).framework_state).toBe("fail");
    for (const [name, filepath] of [[`${PLANNER_FAILURE_CASE} private suffix`, failureFixturePath], [PLANNER_FAILURE_CASE, resolve("private/workflow-orchestrator.test.ts")], [PLANNER_FAILURE_CASE, `${failureFixturePath}.private`]]) {
      const other = failureContext(); other.task.name = name!; other.task.file.filepath = filepath!; expect(projectPlannerFailureContext(other, failureSourceLimits)).toBeNull();
    }
    context.task.file.filepath = failureFixturePath.replaceAll("\\", "/"); expect(failureReceipt(context).framework_state).toBe("fail"); expect(projectPlannerFailureContext(Object.create(context), failureSourceLimits)).toBeNull();
  });
  it("bounds filepath candidates and does not format a private object during selection", () => {
    const context = failureContext(); context.task.file.filepath = `${failureFixturePath}${"x".repeat(65537)}`; expect(projectPlannerFailureContext(context, failureSourceLimits)).toBeNull();
    const formatter = vi.fn(() => failureFixturePath); Object.defineProperty(context.task.file, "filepath", { value: { toString: formatter }, configurable: true, enumerable: true }); expect(projectPlannerFailureContext(context, failureSourceLimits)).toBeNull(); expect(formatter).not.toHaveBeenCalled();
  });
  it.each(["retryCount", "repeatCount"] as const)("requires the original zero %s rather than accepting replacement attempts", (counter) => {
    for (const value of [1, -1, "0", Number.NaN, Number.POSITIVE_INFINITY, undefined]) { const context = failureContext(); context.task.result[counter] = value; expect(failureReceipt(context).capture_status).toBe("unavailable"); }
    const context = failureContext(); delete context.task.result[counter]; expect(failureReceipt(context).capture_status).toBe("unavailable");
  });
  it("retains ordered exact error counts through eight entries and refuses holes or truncation", () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({ name: "Error", message: index % 2 ? PLANNER_HOOK_TIMEOUT_MESSAGE : PLANNER_TEST_TIMEOUT_MESSAGE })), receipt = failureReceipt(failureContext({ state: "fail", retryCount: 0, repeatCount: 0, errors: entries }));
    expect(receipt.error_count).toBe(8); expect(receipt.errors.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]); expect(receipt.classification_complete).toBe(true);
    const sparse = [...entries]; delete sparse[2];
    for (const errors of [[...entries, entries[0]], sparse, {}, [null], ["PRIVATE ERROR"], [new Error("PRIVATE ERROR")]]) expect(failureReceipt(failureContext({ state: "fail", retryCount: 0, repeatCount: 0, errors })).capture_status).toBe("unavailable");
  });
  it("rejects result arrays and non-index error-array fields without reading their values", () => {
    const result = Object.assign([], { state: "fail", retryCount: 0, repeatCount: 0, errors: [{ name: "Error", message: PLANNER_TEST_TIMEOUT_MESSAGE }] }); expect(failureReceipt(failureContext(result as unknown as Record<string, unknown>)).capture_status).toBe("unavailable");
    const errors = [{ name: "Error", message: PLANNER_TEST_TIMEOUT_MESSAGE }], getter = vi.fn(); Object.defineProperty(errors, "private", { enumerable: true, get: getter }); expect(failureReceipt(failureContext({ state: "fail", retryCount: 0, repeatCount: 0, errors })).capture_status).toBe("unavailable"); expect(getter).not.toHaveBeenCalled();
  });
  it.each(["context", "task", "file", "result", "state", "counter", "errors", "entry", "name", "message", "stack"] as const)("does not invoke a getter at the %s descriptor boundary", (boundary) => {
    const context = failureContext(), getter = vi.fn(() => "PRIVATE GETTER"), result = context.task.result, errors = result.errors as Array<Record<string, unknown>>, entry = errors[0]!;
    const [target, key]: [object, string] = boundary === "context" ? [context, "task"] : boundary === "task" ? [context.task, "name"] : boundary === "file" ? [context.task.file, "filepath"] : boundary === "result" ? [context.task, "result"] : boundary === "state" ? [result, "state"] : boundary === "counter" ? [result, "retryCount"] : boundary === "errors" ? [result, "errors"] : boundary === "entry" ? [errors, "0"] : [entry, boundary];
    Object.defineProperty(target, key, { configurable: true, enumerable: true, get: getter }); const projected = projectPlannerFailureContext(context, failureSourceLimits);
    expect(projected === null || projected.capture_status === "unavailable" || boundary === "stack" && projected.errors[0]?.positions_status === "unavailable").toBe(true); expect(getter).not.toHaveBeenCalled(); expect(JSON.stringify(projected)).not.toContain("PRIVATE");
  });
  it.each(["context", "task", "file", "result", "errors", "entry"] as const)("rejects a Proxy at the %s boundary before executing its traps", (boundary) => {
    let context: unknown = failureContext(); const selected = context as SyntheticFailureContext, hook = vi.fn(), proxy = <T extends object>(value: T): T => new Proxy(value, { get: hook, getOwnPropertyDescriptor: hook, getPrototypeOf: hook, ownKeys: hook });
    if (boundary === "context") context = proxy(selected); else if (boundary === "task") selected.task = proxy(selected.task); else if (boundary === "file") selected.task.file = proxy(selected.task.file); else if (boundary === "result") selected.task.result = proxy(selected.task.result); else if (boundary === "errors") selected.task.result.errors = proxy(selected.task.result.errors as object); else (selected.task.result.errors as object[])[0] = proxy((selected.task.result.errors as object[])[0]!);
    const projected = projectPlannerFailureContext(context, failureSourceLimits); expect(projected === null || projected.capture_status === "unavailable").toBe(true); expect(hook).not.toHaveBeenCalled();
  });
  it("ignores custom methods, expected/actual/cause and their cycles without mutating source objects", () => {
    const context = failureContext(), entry = (context.task.result.errors as Record<string, unknown>[])[0]!, getter = vi.fn(), custom = vi.fn(); entry.cause = entry; context.task.suite = context.task;
    for (const key of ["expected", "actual", "diff", "cause-private", "toJSON", "toString"]) Object.defineProperty(entry, key, { enumerable: true, get: getter }); entry.format = custom;
    const before = Object.getOwnPropertyDescriptors(entry), receipt = failureReceipt(context); expect(receipt.errors[0]?.signature).toBe("test-timeout-5000"); expect(getter).not.toHaveBeenCalled(); expect(custom).not.toHaveBeenCalled(); expect(Object.getOwnPropertyDescriptors(entry)).toEqual(before); expect(entry.cause).toBe(entry);
    const cycle: unknown[] = []; cycle.push(cycle); expect(failureReceipt(failureContext({ state: "fail", retryCount: 0, repeatCount: 0, errors: cycle })).capture_status).toBe("unavailable");
  });
  it("supports detached null-prototype result and error payloads", () => {
    const entry = Object.assign(Object.create(null), { name: "Error", message: PLANNER_TEST_TIMEOUT_MESSAGE }), result = Object.assign(Object.create(null), { state: "fail", retryCount: 0, repeatCount: 0, errors: [entry] }), receipt = failureReceipt(failureContext(result)); expect(receipt.capture_status).toBe("captured"); expect(receipt.classification_complete).toBe(true); expect(Object.getPrototypeOf(entry)).toBeNull(); expect(Object.isFrozen(entry)).toBe(false);
  });
  it("projects at most three reported source sites across all errors and never exposes path or method names", () => {
    const stack = Array.from({ length: 4 }, (_, index) => `    at PRIVATE_METHOD (${failureFixturePath}:${index + 1}:2)`).join("\n"), receipt = failureReceipt(failureContext({ state: "fail", retryCount: 0, repeatCount: 0, errors: [{ name: "Error", message: PLANNER_TEST_TIMEOUT_MESSAGE, stack }, { name: "Error", message: PLANNER_HOOK_TIMEOUT_MESSAGE, stack }] }));
    const sites = receipt.errors.flatMap((entry) => entry.sites); expect(sites).toEqual([1, 2, 3].map((line) => ({ source: "workflow-fixture", line, column: 2 }))); expect(receipt.errors.some((entry) => entry.positions_status === "limit-reached")).toBe(true); expect(Object.isFrozen(sites[0])).toBe(true); expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE_METHOD|surtec-control-plane|workflow-orchestrator\.test/);
  });
  it("requires exact public fixture sites within the precomputed positive line/column limits", () => {
    const stack = [` at PUBLIC (${failureFixturePath}:40:80)`, ` at PRIVATE (D:/private/workflow-orchestrator.test.ts:2:3)`, ` at BAD (${failureFixturePath}:41:1)`, ` at BAD (${failureFixturePath}:2:81)`, ` at BAD (${failureFixturePath}:0:1)`, ` at BAD (${failureFixturePath}:1:0)`].join("\n"), receipt = failureReceipt(failureContext({ state: "fail", retryCount: 0, repeatCount: 0, errors: [{ name: "Error", message: PLANNER_TEST_TIMEOUT_MESSAGE, stack }] }));
    expect(receipt.errors[0]?.sites).toEqual([{ source: "workflow-fixture", line: 40, column: 80 }]); expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE|PUBLIC|BAD|D:/);
  });
  it("does not scan beyond 128 stack lines or call a private stack formatter", () => {
    for (const [prefixLines, expected] of [[127, 1], [128, 0]] as const) {
      const stack = `${"private non-frame\n".repeat(prefixLines)} at PRIVATE (${failureFixturePath}:2:3)`, receipt = failureReceipt(failureContext({ state: "fail", retryCount: 0, repeatCount: 0, errors: [{ name: "Error", message: PLANNER_TEST_TIMEOUT_MESSAGE, stack }] })); expect(receipt.errors[0]?.sites).toHaveLength(expected); expect(receipt.errors[0]?.positions_status).toBe("limit-reached");
    }
    const formatter = vi.fn(() => "private stack"), receipt = failureReceipt(failureContext({ state: "fail", retryCount: 0, repeatCount: 0, errors: [{ name: "Error", message: PLANNER_TEST_TIMEOUT_MESSAGE, stack: { toString: formatter } }] })); expect(receipt.errors[0]?.positions_status).toBe("unavailable"); expect(formatter).not.toHaveBeenCalled();
  });
  it.each(["x".repeat(1025), "é".repeat(513), "😀".repeat(257)])("bounds unsupported message units and UTF-8 bytes before matching", (message) => {
    const receipt = failureReceipt(failureContext({ state: "fail", retryCount: 0, repeatCount: 0, errors: [{ name: "Error", message }] })); expect(receipt.errors[0]?.signature).toBe("unsupported"); expect(receipt.errors[0]?.message).toBeNull(); expect(receipt.capture_status).toBe("captured");
  });
  it.each(["x".repeat(65537), "é".repeat(32769), "😀".repeat(16385)])("bounds optional stack units and UTF-8 bytes before splitting", (stack) => {
    const receipt = failureReceipt(failureContext({ state: "fail", retryCount: 0, repeatCount: 0, errors: [{ name: "Error", message: PLANNER_TEST_TIMEOUT_MESSAGE, stack }] })); expect(receipt.errors[0]?.signature).toBe("test-timeout-5000"); expect(receipt.errors[0]?.sites).toEqual([]); expect(receipt.errors[0]?.positions_status).toBe("unavailable");
  });
  it("prepares and detaches public source limits before capture rather than reading inside the hook", () => {
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(() => Buffer.from("public line\npublic second line")), write = vi.fn(), capture = createPlannerFailureCapture({ env: { SURTEC_TEST_PLANNER_FAILURE_PROFILE: "1" }, write }); expect(read).toHaveBeenCalledOnce(); read.mockClear();
    capture.capture(failureContext()); expect(read).not.toHaveBeenCalled(); expect(write).toHaveBeenCalledOnce(); const receipt = parsePlannerFailureOutput(String(write.mock.calls[0]?.[0])); expect(receipt?.capture_status).toBe("captured");
    const mutable = { line_columns: [3] }, detachedWrite = vi.fn(), detached = createPlannerFailureCapture({ env: { SURTEC_TEST_PLANNER_FAILURE_PROFILE: "1" }, write: detachedWrite, sourceLimits: mutable }); mutable.line_columns[0] = 999;
    detached.capture(failureContext({ state: "fail", retryCount: 0, repeatCount: 0, errors: [{ name: "Error", message: PLANNER_TEST_TIMEOUT_MESSAGE, stack: ` at PRIVATE (${failureFixturePath}:1:99)` }] })); expect(parsePlannerFailureOutput(String(detachedWrite.mock.calls[0]?.[0]))?.errors[0]?.sites).toEqual([]);
  });
  it("records unavailable metadata without replacing the framework result when source preparation fails", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("PRIVATE SOURCE FAULT"); }); const write = vi.fn(), context = failureContext(), capture = createPlannerFailureCapture({ env: { SURTEC_TEST_PLANNER_FAILURE_PROFILE: "1" }, write });
    expect(() => capture.capture(context)).not.toThrow(); expect(context.task.result.state).toBe("fail"); const receipt = parsePlannerFailureOutput(String(write.mock.calls[0]?.[0])); expect(receipt).toMatchObject({ capture_status: "unavailable", unavailable_reason: "source-limits-unavailable", acceptance: false }); expect(JSON.stringify(receipt)).not.toContain("PRIVATE");
  });
  it.each([{}, { SURTEC_TEST_PLANNER_FAILURE_PROFILE: "0" }, { SURTEC_TEST_PLANNER_FAILURE_PROFILE: "1", SURTEC_TEST_PLANNER_PROFILE: "0" }, { SURTEC_TEST_PLANNER_FAILURE_PROFILE: "1", SURTEC_TEST_PLANNER_FS_PROFILE: "" }])("is silent by default and abstains on any present legacy flag without claiming legacy instrumentation is off", (env) => {
    const read = vi.spyOn(fs, "readFileSync"), write = vi.fn(), capture = createPlannerFailureCapture({ env, write, sourceLimits: failureSourceLimits }); capture.capture(failureContext()); expect(write).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });
  it("honors the native process environment opt-in using own descriptors without serializing its values", () => {
    vi.stubEnv("SURTEC_TEST_PLANNER_FAILURE_PROFILE", "1"); vi.stubEnv("SURTEC_TEST_PLANNER_PROFILE", undefined); vi.stubEnv("SURTEC_TEST_PLANNER_FS_PROFILE", undefined);
    const write = vi.fn(); try { createPlannerFailureCapture({ write, sourceLimits: failureSourceLimits }).capture(failureContext()); expect(write).toHaveBeenCalledOnce(); expect(parsePlannerFailureOutput(String(write.mock.calls[0]?.[0]))?.capture_status).toBe("captured"); } finally { vi.unstubAllEnvs(); }
  });
  it("emits one bounded immediate native line without waiting for drainage or interpreting backpressure as acceptance", () => {
    const write = vi.fn((_line: string) => false), capture = createPlannerFailureCapture({ env: { SURTEC_TEST_PLANNER_FAILURE_PROFILE: "1" }, sourceLimits: failureSourceLimits, write }); expect(capture.capture(failureContext())).toBeUndefined(); expect(write).toHaveBeenCalledOnce(); const line = String(write.mock.calls[0]?.[0]); expect(line.startsWith("PLANNER_FAILURE_PROFILE ")).toBe(true); expect(line.endsWith("\n")).toBe(true); expect(Buffer.byteLength(line)).toBeLessThanOrEqual(8192); expect(parsePlannerFailureOutput(line)?.acceptance).toBe(false);
  });
  it("does not consume the one marker for another case or rewrite it after late callback mutation", () => {
    const write = vi.fn(), capture = createPlannerFailureCapture({ env: { SURTEC_TEST_PLANNER_FAILURE_PROFILE: "1" }, sourceLimits: failureSourceLimits, write }), other = failureContext(); other.task.name = "unrelated synthetic case"; capture.capture(other); expect(write).not.toHaveBeenCalled();
    const selected = failureContext(); capture.capture(selected); selected.task.result.state = "pass"; selected.task.result.errors = []; capture.capture(selected); expect(write).toHaveBeenCalledOnce(); expect(parsePlannerFailureOutput(String(write.mock.calls[0]?.[0]))?.framework_state).toBe("fail");
  });
  it.each([false, true])("snapshots before original cleanup and preserves cleanup failure identity, throws=%s", async (throws) => {
    const steps: string[] = [], context = failureContext(), cleanupFailure = new Error("Synthetic original cleanup failure"), lines: string[] = [], capture = createPlannerFailureCapture({ env: { SURTEC_TEST_PLANNER_FAILURE_PROFILE: "1" }, sourceLimits: failureSourceLimits, write: (line) => { steps.push("capture"); lines.push(line); } });
    const finish = vi.fn(() => steps.push("finish")), stop = vi.fn(async () => { steps.push("stop"); context.task.result.state = "pass"; context.task.result.errors = []; if (throws) throw cleanupFailure; }), restore = vi.fn(() => steps.push("restore")), remove = vi.fn(() => steps.push("remove"));
    const existingHook = async () => { capture.capture(context); finish(); await stop(); restore(); remove(); }; let observed: unknown; try { await existingHook(); } catch (error) { observed = error; }
    expect(observed).toBe(throws ? cleanupFailure : undefined); expect(steps).toEqual(throws ? ["capture", "finish", "stop"] : ["capture", "finish", "stop", "restore", "remove"]); expect(parsePlannerFailureOutput(lines[0]!)?.framework_state).toBe("fail"); expect(parsePlannerFailureOutput(lines[0]!)?.error_count).toBe(1); expect(context.task.result.state).toBe("pass");
  });
  it("does not replace original cleanup or test errors with a synchronous EPIPE-style observer fault", async () => {
    const original = new Error("Synthetic original error"), steps: string[] = [], capture = createPlannerFailureCapture({ env: { SURTEC_TEST_PLANNER_FAILURE_PROFILE: "1" }, sourceLimits: failureSourceLimits, write: () => { steps.push("write"); throw Object.assign(new Error("PRIVATE PIPE"), { code: "EPIPE" }); } }); let actual: unknown;
    try { capture.capture(failureContext()); steps.push("cleanup"); throw original; } catch (error) { actual = error; } expect(actual).toBe(original); expect(steps).toEqual(["write", "cleanup"]);
  });
  it("collects a byte-split marker and discards raw unrelated output without a raw fallback", () => {
    const receipt = failureReceipt(), updates: Array<PlannerFailureReceipt | null> = [], collector = createPlannerFailureMarkerCollector((value) => updates.push(value), failureSourceLimits), bytes = Buffer.from(`unrelated PRIVATE STDERR BODY\nPLANNER_FAILURE_PROFILE ${JSON.stringify(receipt)}\n`);
    for (const byte of bytes) collector.push(Buffer.from([byte])); expect(collector.finish()).toEqual(receipt); expect(updates).toEqual([receipt]); expect(JSON.stringify(updates)).not.toContain("PRIVATE");
  });
  it("rejects duplicate and escaped-alias JSON keys rather than accepting collapsed properties", () => {
    const raw = JSON.stringify(failureReceipt()), duplicate = raw.replace('"error_count":1', '"error_count":1,"error_count":1'), escaped = raw.replace('"error_count":1', '"error_count":1,"error_' + String.fromCharCode(92) + 'u0063ount":1');
    for (const body of [duplicate, escaped]) expect(parsePlannerFailureOutput(`PLANNER_FAILURE_PROFILE ${body}\n`)).toBeNull();
  });
  it("revokes earlier safe progress on any second malformed, duplicate or truncated marker", () => {
    const receipt = failureReceipt(), line = `PLANNER_FAILURE_PROFILE ${JSON.stringify(receipt)}\n`;
    for (const late of [line, "PLANNER_FAILURE_PROFILE {invalid}\n", "PLANNER_FAILURE_PROFILE {"]) {
      const updates: Array<PlannerFailureReceipt | null> = [], collector = createPlannerFailureMarkerCollector((value) => updates.push(value), failureSourceLimits); collector.push(line); expect(updates.at(-1)).toEqual(receipt); collector.push(late); expect(updates.at(-1)).toBeNull(); expect(collector.finish()).toBeNull();
    }
    expect(parsePlannerFailureOutput(line.trimEnd())).toBeNull(); expect(parsePlannerFailureOutput("PLANNER_FAILURE_PROFILE {invalid}\n")).toBeNull();
  });
  it("enforces the 8 KiB line byte ceiling across chunks including multi-byte input", () => {
    for (const body of ["x".repeat(8192), "é".repeat(4096)]) { const updates: Array<PlannerFailureReceipt | null> = [], collector = createPlannerFailureMarkerCollector((value) => updates.push(value), failureSourceLimits); collector.push(Buffer.from("PLANNER_FAILURE_PROFILE ")); collector.push(Buffer.from(body)); collector.push(Buffer.from("\n")); expect(collector.finish()).toBeNull(); expect(updates.at(-1)).toBeNull(); }
  });
  it("accepts an exactly bounded line but refuses one additional byte including its newline", () => {
    const receipt = failureReceipt(), raw = `PLANNER_FAILURE_PROFILE ${JSON.stringify(receipt)}`;
    expect(parsePlannerFailureOutput(`${raw.padEnd(8191, " ")}\n`)).toEqual(receipt); expect(parsePlannerFailureOutput(`${raw.padEnd(8192, " ")}\n`)).toBeNull();
  });
  it("rejects raw extras and contradictory closed receipt states without evaluating getters or Proxy traps", () => {
    const receipt = failureReceipt(), getter = vi.fn(), accessor = { ...receipt }; Object.defineProperty(accessor, "framework_state", { enumerable: true, get: getter }); expect(sanitizePlannerFailureReceipt(accessor, failureSourceLimits)).toBeNull(); expect(getter).not.toHaveBeenCalled(); const hook = vi.fn(); expect(sanitizePlannerFailureReceipt(new Proxy(receipt, { get: hook, ownKeys: hook }), failureSourceLimits)).toBeNull(); expect(hook).not.toHaveBeenCalled();
    for (const value of [{ ...receipt, private: "PRIVATE BODY" }, { ...receipt, schema_version: 2 }, { ...receipt, acceptance: true }, { ...receipt, error_count: 2 }, { ...receipt, error_count: 9 }, { ...receipt, framework_state: "pass" }, { ...receipt, capture_status: "unavailable" }, { ...receipt, unavailable_reason: "private" }, { ...receipt, errors: [{ ...receipt.errors[0], index: 1 }] }, { ...receipt, errors: [{ ...receipt.errors[0], reported_name: "PrivateName" }] }, { ...receipt, errors: [{ ...receipt.errors[0], message: "PRIVATE MESSAGE" }] }, { ...receipt, errors: [{ ...receipt.errors[0], sites: [{ source: "PRIVATE PATH", line: 2, column: 3 }] }] }]) expect(sanitizePlannerFailureReceipt(value, failureSourceLimits)).toBeNull();
    const projection = sanitizePlannerFailureReceipt(receipt, failureSourceLimits); expect(projection).toEqual(receipt); expect(projection).not.toBe(receipt); expect(Object.isFrozen(projection)).toBe(true);
  });
  it("validates total site count, frozen source bounds, positions status and classification coherence", () => {
    const receipt = failureReceipt(), entry = receipt.errors[0]!, sites = [1, 2, 3].map((line) => ({ source: "workflow-fixture", line, column: 2 }));
    const fourSites = { ...receipt, error_count: 2, errors: [{ ...entry, sites, positions_status: "limit-reached" }, { ...entry, index: 1, sites: [{ source: "workflow-fixture", line: 4, column: 2 }] }] };
    for (const value of [fourSites, { ...receipt, errors: [{ ...entry, sites: [{ source: "workflow-fixture", line: 41, column: 1 }] }] }, { ...receipt, errors: [{ ...entry, sites: [{ source: "workflow-fixture", line: 1, column: 81 }] }] }, { ...receipt, errors: [{ ...entry, sites: [{ source: "workflow-fixture", line: 1, column: 2 }], positions_status: "unavailable" }] }, { ...receipt, classification_complete: false }]) expect(sanitizePlannerFailureReceipt(value, failureSourceLimits)).toBeNull();
    const hook = vi.fn(), columns = [80]; Object.defineProperty(columns, "0", { get: hook }); expect(projectPlannerFailureContext(failureContext(), { line_columns: columns })?.unavailable_reason).toBe("source-limits-unavailable"); expect(hook).not.toHaveBeenCalled();
  });
  it("keeps final execution/source/cleanup evidence independent from an early receipt", () => {
    const partial = partialFailureReport(), completed = completedFailureReport(); expect(sanitizePlannerFailureDiagnostic(partial, failureSourceLimits)?.receipt).toEqual(partial.receipt); expect(sanitizePlannerFailureDiagnostic(partial, failureSourceLimits)?.acceptance).toBe(false); expect(sanitizePlannerFailureDiagnostic(completed, failureSourceLimits)?.status).toBe("completed");
    for (const report of [{ ...partial, status: "completed" }, { ...completed, receipt: null }, { ...completed, source_drift: true }, { ...completed, cleanup: "unavailable-no-uncertain-fixture-deleted" }, { ...completed, suite: { ...completed.suite!, passed_tests: 0 } }, { ...completed, suite: { ...completed.suite!, failed_tests: 1 } }, { ...completed, first_planner: { passed: false, test_ms: 1 } }, { ...completed, acceptance: true }]) expect(sanitizePlannerFailureDiagnostic(report, failureSourceLimits)).toBeNull();
    expect(JSON.stringify(sanitizePlannerFailureDiagnostic({ ...partial, private: "PRIVATE TOKEN", limitations: ["PRIVATE BODY"] }, failureSourceLimits))).not.toContain("PRIVATE");
  });
  it("validates one bounded public-source envelope without executing getters or Proxy traps", () => {
    const metadata = failureSourceEnvelope(), projected = sanitizePlannerFailureSourceMetadata(metadata); expect(projected).toEqual(metadata); expect(projected).not.toBe(metadata); expect(Object.isFrozen(projected)).toBe(true); expect(Object.isFrozen(projected?.sourceLimits.line_columns)).toBe(true);
    const sparse = [3, 4]; delete sparse[0];
    for (const value of [{ ...metadata, private: "PRIVATE BODY" }, { ...metadata, fixture_sha256: "b" }, { ...metadata, fixture_sha256: "A".repeat(64) }, { ...metadata, sourceLimits: { line_columns: [] } }, { ...metadata, sourceLimits: { line_columns: [0] } }, { ...metadata, sourceLimits: { line_columns: [65537] } }, { ...metadata, sourceLimits: { line_columns: Array.from({ length: 10001 }, () => 1) } }, { ...metadata, sourceLimits: { line_columns: sparse } }]) expect(sanitizePlannerFailureSourceMetadata(value)).toBeNull();
    const hook = vi.fn(), accessor = { ...metadata }; Object.defineProperty(accessor, "sourceLimits", { enumerable: true, get: hook }); expect(sanitizePlannerFailureSourceMetadata(accessor)).toBeNull(); expect(sanitizePlannerFailureSourceMetadata(new Proxy(metadata, { get: hook, ownKeys: hook }))).toBeNull(); expect(hook).not.toHaveBeenCalled();
  });
  it("retains a sanitized received error on fake watchdog expiry without inventing suite, source-after or cleanup facts", async () => {
    vi.useFakeTimers(); const start = Date.now(), child = new Child(), foreign = new Child(), partial = partialFailureReport(), deadline = new ProfileDeadline(() => Date.now() - start); child.send.mockImplementation(() => { child.emit("message", failureSourceEnvelope()); child.emit("message", { role: "planner-failure-progress", report: partial }); });
    const pending = runPlannerFailureDiagnosticWatchdog(deadline, () => child); await vi.advanceTimersByTimeAsync(870_000); expect(child.signals).toEqual([]); await vi.advanceTimersByTimeAsync(30_000); const report = await pending;
    expect(report).toMatchObject({ status: "deadline", wall_ms: PROFILE_LIMIT_MS, wall_limit_ms: PROFILE_LIMIT_MS, cleanup_reserve_ms: PROFILE_CLEANUP_RESERVE_MS, receipt: partial.receipt, acceptance: false, suite: null, first_planner: null, source_hashes_after: {}, source_drift: null, cleanup: "unavailable-no-uncertain-fixture-deleted" }); expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]); expect(foreign.signals).toEqual([]); expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ role: "planner-failure-controller" }));
  });
  it("does not preserve a revoked receipt or a changed snapshot in late private progress", async () => {
    vi.useFakeTimers(); const child = new Child(), partial = partialFailureReport(), deadline = new ProfileDeadline(() => 0); child.send.mockImplementation(() => { child.emit("message", failureSourceEnvelope()); child.emit("message", { role: "planner-failure-progress", report: partial }); child.emit("message", { role: "planner-failure-progress", report: { ...partial, receipt: null } }); child.emit("close", 1); });
    const report = await runPlannerFailureDiagnosticWatchdog(deadline, () => child); expect(report.receipt).toBeNull(); expect(report.suite).toBeNull(); expect(report.cleanup).toBe("unavailable-no-uncertain-fixture-deleted");
  });
  it.each(["missing", "malformed", "duplicate", "wrong-hash"] as const)("does not preserve partial capture after %s source metadata", async (fault) => {
    const child = new Child(), partial = partialFailureReport(); child.send.mockImplementation(() => {
      if (fault !== "missing") child.emit("message", fault === "malformed" ? { ...failureSourceEnvelope(), sourceLimits: { line_columns: [0] } } : failureSourceEnvelope());
      child.emit("message", { role: "planner-failure-progress", report: fault === "wrong-hash" ? { ...partial, source_hashes: { "runner/workflow-orchestrator.test.ts": "b".repeat(64) } } : partial });
      if (fault === "duplicate") child.emit("message", failureSourceEnvelope()); child.emit("close", 1);
    }); const report = await runPlannerFailureDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(report.receipt).toBeNull(); expect(report.source_drift).toBeNull(); expect(report.cleanup).toBe("unavailable-no-uncertain-fixture-deleted");
  });
  it("revokes immutable early progress when a later snapshot changes fail to pass instead of rewriting it", async () => {
    const child = new Child(), partial = partialFailureReport(), changed = { ...partial, receipt: failureReceipt(failureContext({ state: "pass", retryCount: 0, repeatCount: 0 })) }; child.send.mockImplementation(() => { child.emit("message", failureSourceEnvelope()); child.emit("message", { role: "planner-failure-progress", report: partial }); child.emit("message", { role: "planner-failure-progress", report: changed }); child.emit("message", { role: "planner-failure-report", report: completedFailureReport() }); child.emit("close", 0); });
    const report = await runPlannerFailureDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(report.status).toBe("failed"); expect(report.receipt).toBeNull(); expect(report.acceptance).toBe(false);
  });
  it("does not let a final report reinstate revoked early evidence", async () => {
    const child = new Child(), partial = partialFailureReport(); child.send.mockImplementation(() => { child.emit("message", failureSourceEnvelope()); child.emit("message", { role: "planner-failure-progress", report: partial }); child.emit("message", { role: "planner-failure-progress", report: { ...partial, receipt: null } }); child.emit("message", { role: "planner-failure-report", report: completedFailureReport() }); child.emit("close", 0); });
    const report = await runPlannerFailureDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(report.status).toBe("failed"); expect(report.receipt).toBeNull(); expect(report.suite).toBeNull();
  });
  it("does not let a final pass snapshot replace an already received early failure", async () => {
    const child = new Child(), partial = partialFailureReport(); child.send.mockImplementation(() => { child.emit("message", failureSourceEnvelope()); child.emit("message", { role: "planner-failure-progress", report: partial }); child.emit("message", { role: "planner-failure-report", report: completedFailureReport() }); child.emit("close", 0); });
    const report = await runPlannerFailureDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(report.status).toBe("failed"); expect(report.receipt).toBeNull(); expect(report.suite).toBeNull();
  });
  it("keeps malformed-progress revocation sticky rather than accepting a later valid receipt", async () => {
    const child = new Child(), partial = partialFailureReport(); child.send.mockImplementation(() => { child.emit("message", failureSourceEnvelope()); child.emit("message", { role: "planner-failure-progress", report: partial }); child.emit("message", { role: "planner-failure-progress", report: { ...partial, receipt: { ...partial.receipt, error_count: 2 } } }); child.emit("message", { role: "planner-failure-progress", report: partial }); child.emit("message", { role: "planner-failure-report", report: partial }); child.emit("close", 0); });
    const report = await runPlannerFailureDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(report.receipt).toBeNull(); expect(report.suite).toBeNull(); expect(report.status).toBe("failed");
  });
  it("invalidates progress received before source metadata even when a later handshake and report are valid", async () => {
    const child = new Child(), partial = partialFailureReport(); child.send.mockImplementation(() => { child.emit("message", { role: "planner-failure-progress", report: partial }); child.emit("message", failureSourceEnvelope()); child.emit("message", { role: "planner-failure-report", report: partial }); child.emit("close", 0); });
    const report = await runPlannerFailureDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(report.receipt).toBeNull(); expect(report.status).toBe("failed");
  });
  it("accepts repetitions of the exact detached early snapshot without filesystem work in the outer watchdog", async () => {
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("Synthetic unexpected outer filesystem read"); }), child = new Child(), partial = partialFailureReport(); child.send.mockImplementation(() => { child.emit("message", failureSourceEnvelope()); child.emit("message", { role: "planner-failure-progress", report: partial }); child.emit("message", { role: "planner-failure-progress", report: partial }); child.emit("message", { role: "planner-failure-report", report: partial }); child.emit("close", 0); });
    const report = await runPlannerFailureDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(report.receipt).toEqual(partial.receipt); expect(report.status).toBe("failed"); expect(report.acceptance).toBe(false); expect(read).not.toHaveBeenCalled();
  });
  it("validates received progress immediately instead of following later source-object mutation", async () => {
    const child = new Child(), partial = partialFailureReport(); child.send.mockImplementation(() => { child.emit("message", failureSourceEnvelope()); child.emit("message", { role: "planner-failure-progress", report: partial }); partial.source_hashes["runner/workflow-orchestrator.test.ts"] = "b".repeat(64); child.emit("close", 1); });
    const report = await runPlannerFailureDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(report.receipt).toEqual(partial.receipt); expect(report.source_hashes["runner/workflow-orchestrator.test.ts"]).toBe("a".repeat(64)); expect(report.source_hashes_after).toEqual({}); expect(report.source_drift).toBeNull();
  });
  it("requires actual normal controller closure for a completed diagnostic and never promotes it to acceptance", async () => {
    const child = new Child(), completed = completedFailureReport(); child.send.mockImplementation(() => { child.emit("message", failureSourceEnvelope()); child.emit("message", { role: "planner-failure-report", report: completed }); child.emit("close", 0); }); const report = await runPlannerFailureDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(report.status).toBe("completed"); expect(report.acceptance).toBe(false); expect(child.signals).toEqual([]);
  });
  it("bounds a failed private send through its issued supervisor without a new budget or raw error fallback", async () => {
    vi.useFakeTimers(); const child = new Child(); child.send.mockImplementation(() => { throw new Error("PRIVATE IPC BODY"); }); const pending = runPlannerFailureDiagnosticWatchdog(new ProfileDeadline(() => 0), () => child); await vi.advanceTimersByTimeAsync(2000); const report = await pending; expect(report.status).toBe("failed"); expect(report.receipt).toBeNull(); expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]); expect(JSON.stringify(report)).not.toContain("PRIVATE");
    const launch = vi.fn(() => new Child()); expect((await runPlannerFailureDiagnosticWatchdog(new ProfileDeadline(() => PROFILE_LIMIT_MS), launch)).status).toBe("deadline"); expect(launch).not.toHaveBeenCalled();
  });
});

function spanHarness(clock: () => number = () => 0, context = failureContext()) {
  const lines: string[] = [], capture = createPlannerSpanCapture({ env: { SURTEC_TEST_PLANNER_SPAN_PROFILE: "1" }, sourceLimits: failureSourceLimits, clock, write: (line) => { lines.push(line); } });
  capture.prepare(context); const observer = capture.beginCallback(); if (!observer) throw new Error("Synthetic selected span binding unavailable");
  return { capture, context, observer, lines, receipt(): PlannerSpanReceipt { capture.capture(context); const value = parsePlannerSpanOutput(lines[0] ?? "", failureSourceLimits); if (!value) throw new Error("Synthetic span envelope unavailable"); return value; } };
}
function completeSpanReceipt(context = failureContext()): PlannerSpanReceipt {
  let now = 0; const harness = spanHarness(() => now++, context); for (const phase of PLANNER_SPAN_PHASES) harness.observer.begin(phase)(); return harness.receipt();
}
function partialSpanReport(receipt: PlannerSpanReceipt | null = completeSpanReceipt()): PlannerSpanDiagnosticReport {
  return { ...partialFailureReport(), workload: "first-planner-spans", receipt };
}
function spanSourceEnvelope() { return { ...failureSourceEnvelope(), role: "planner-span-source" }; }
function completedSpanReport(): PlannerSpanDiagnosticReport {
  return { ...completedFailureReport(), workload: "first-planner-spans", receipt: completeSpanReceipt(failureContext({ state: "pass", retryCount: 0, repeatCount: 0 })) };
}

describe("P09 case-bound public Planner span observation", () => {
  it("adds one fixed full-workload selector without changing existing workloads, flags, workers or limits", () => {
    expect(parseProfileArguments(["--workload=first-planner-spans"])).toBe("first-planner-spans"); expect(PROFILE_WORKLOADS).not.toContain("first-planner-spans"); expect(plannerSpanArguments()).toEqual(plannerFailureArguments()); expect(plannerSpanArguments().slice(1)).toEqual(["run", "--reporter=json"]);
    expect(plannerSpanArguments().join(" ")).not.toMatch(/maxWorkers|testNamePattern|retry|repeat|bail|timeout/); expect(PROFILE_LIMIT_MS).toBe(900_000); expect(PROFILE_CLEANUP_RESERVE_MS).toBe(30_000); expect(PLANNER_SPAN_PHASES).toEqual(PLANNER_PHASES.slice(0, -1));
    const source = { PATH: "synthetic", SURTEC_TEST_PLANNER_PROFILE: "1", SURTEC_TEST_PLANNER_FS_PROFILE: "1", SURTEC_TEST_PLANNER_FAILURE_PROFILE: "1", SURTEC_TEST_PLANNER_SPAN_PROFILE: "private", OPENAI_API_KEY: "private", NODE_OPTIONS: "private", SURTEC_STATE_DIR: "private" };
    expect(plannerSpanEnvironment(source)).toEqual({ PATH: "synthetic", NO_COLOR: "1", CI: "1", SURTEC_TEST_PLANNER_SPAN_PROFILE: "1" });
    for (const env of [profileEnvironment(source), plannerFailureEnvironment(source), plannerFsEnvironment(source), fixtureProfileEnvironment("first-planner", "phases", source)]) expect(env).not.toHaveProperty("SURTEC_TEST_PLANNER_SPAN_PROFILE");
  });
  it.each([{}, { SURTEC_TEST_PLANNER_SPAN_PROFILE: "0" }, { SURTEC_TEST_PLANNER_SPAN_PROFILE: "1", SURTEC_TEST_PLANNER_PROFILE: "0" }, { SURTEC_TEST_PLANNER_SPAN_PROFILE: "1", SURTEC_TEST_PLANNER_FS_PROFILE: "" }, { SURTEC_TEST_PLANNER_SPAN_PROFILE: "1", SURTEC_TEST_PLANNER_FAILURE_PROFILE: "0" }])("resolves disabled or conflicting flags before source bounds, clock or output", (env) => {
    const read = vi.spyOn(fs, "readFileSync"), source = vi.fn(() => failureSourceLimits), clock = vi.fn(() => 0), write = vi.fn(); const capture = createPlannerSpanCapture({ env, get sourceLimits() { return source(); }, clock, write });
    capture.prepare(failureContext()); expect(capture.beginCallback()).toBeUndefined(); capture.capture(failureContext()); expect(read).not.toHaveBeenCalled(); expect(source).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
  it("honors native process environment descriptors without serializing their private values", () => {
    vi.stubEnv("SURTEC_TEST_PLANNER_SPAN_PROFILE", "1"); for (const flag of ["SURTEC_TEST_PLANNER_PROFILE", "SURTEC_TEST_PLANNER_FS_PROFILE", "SURTEC_TEST_PLANNER_FAILURE_PROFILE"]) vi.stubEnv(flag, undefined);
    const write = vi.fn(), context = failureContext(); try { const capture = createPlannerSpanCapture({ write, sourceLimits: failureSourceLimits, clock: () => 0 }); capture.prepare(context); expect(capture.beginCallback()).toBeDefined(); capture.capture(context); expect(write).toHaveBeenCalledOnce(); expect(parsePlannerSpanOutput(String(write.mock.calls[0]?.[0]), failureSourceLimits)?.span_cursor.timing_status).toBe("captured"); } finally { vi.unstubAllEnvs(); }
  });
  it("prepares detached source bounds once outside hooks and performs no domain or source filesystem reads in them", () => {
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(() => Buffer.from("public line\npublic second line")), clock = vi.fn(() => 0), write = vi.fn(), capture = createPlannerSpanCapture({ env: { SURTEC_TEST_PLANNER_SPAN_PROFILE: "1" }, clock, write }); expect(read).toHaveBeenCalledOnce(); read.mockClear();
    const stat = vi.spyOn(fs, "lstatSync"), list = vi.spyOn(fs, "readdirSync"), context = failureContext(); capture.prepare(context); expect(clock).not.toHaveBeenCalled(); const observer = capture.beginCallback(); observer?.begin("issue-create")(); capture.capture(context); expect(read).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(write).toHaveBeenCalledOnce();
    const mutable = { line_columns: [3] }, lines: string[] = [], bounded = createPlannerSpanCapture({ env: { SURTEC_TEST_PLANNER_SPAN_PROFILE: "1" }, sourceLimits: mutable, clock: () => 0, write: (line) => { lines.push(line); } }), selected = failureContext({ state: "fail", retryCount: 0, repeatCount: 0, errors: [{ name: "Error", message: PLANNER_TEST_TIMEOUT_MESSAGE, stack: ` at PRIVATE (${failureFixturePath}:1:4)` }] }); mutable.line_columns[0] = 99;
    bounded.prepare(selected); bounded.beginCallback(); bounded.capture(selected); expect(parsePlannerSpanOutput(lines[0]!, failureSourceLimits)?.failure_receipt.errors[0]?.sites).toEqual([]);
  });
  it.each(["name", "file", "retry", "repeat", "inherited", "array"] as const)("refuses an unselected or malformed %s preparation without starting a clock", (fault) => {
    const context = failureContext(), clock = vi.fn(() => 0), write = vi.fn(), capture = createPlannerSpanCapture({ env: { SURTEC_TEST_PLANNER_SPAN_PROFILE: "1" }, sourceLimits: failureSourceLimits, clock, write }); let candidate: unknown = context;
    if (fault === "name") context.task.name += " private suffix"; else if (fault === "file") context.task.file.filepath = resolve("private/workflow-orchestrator.test.ts"); else if (fault === "retry") context.task.result.retryCount = 1; else if (fault === "repeat") context.task.result.repeatCount = 1; else if (fault === "inherited") candidate = Object.create(context); else candidate = [];
    capture.prepare(candidate); expect(capture.beginCallback()).toBeUndefined(); expect(clock).not.toHaveBeenCalled(); capture.capture(candidate); expect(clock).not.toHaveBeenCalled(); expect(JSON.stringify(write.mock.calls)).not.toContain("private");
  });
  it.each(["context", "task", "file", "result", "name", "counter"] as const)("never invokes a getter or Proxy trap at the %s binding boundary", (boundary) => {
    for (const kind of ["getter", "proxy"] as const) {
      let context: unknown = failureContext(); const selected = context as SyntheticFailureContext, hook = vi.fn(), proxy = <T extends object>(value: T): T => new Proxy(value, { get: hook, ownKeys: hook, getPrototypeOf: hook, getOwnPropertyDescriptor: hook });
      if (kind === "getter") { const [target, key]: [object, string] = boundary === "context" ? [selected, "task"] : boundary === "task" ? [selected.task, "name"] : boundary === "file" ? [selected.task.file, "filepath"] : boundary === "result" ? [selected.task, "result"] : boundary === "name" ? [selected.task, "name"] : [selected.task.result, "retryCount"]; Object.defineProperty(target, key, { configurable: true, enumerable: true, get: hook }); }
      else if (boundary === "context") context = proxy(selected); else if (boundary === "file") selected.task.file = proxy(selected.task.file); else if (boundary === "result" || boundary === "counter") selected.task.result = proxy(selected.task.result); else selected.task = proxy(selected.task);
      const write = vi.fn(), clock = vi.fn(() => 0), capture = createPlannerSpanCapture({ env: { SURTEC_TEST_PLANNER_SPAN_PROFILE: "1" }, sourceLimits: failureSourceLimits, write, clock }); capture.prepare(context); expect(capture.beginCallback()).toBeUndefined(); capture.capture(context); expect(hook).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled();
    }
  });
  it("requires the identical private task at capture and never correlates another same-shaped case", () => {
    let now = 0; const harness = spanHarness(() => now), other = failureContext(); harness.observer.begin("issue-create")(); now = 5; harness.capture.capture(other); expect(harness.lines).toEqual([]); const receipt = harness.receipt(); expect(receipt.failure_receipt).toEqual(failureReceipt(harness.context)); expect(receipt.span_cursor.timing_status).toBe("captured"); expect(JSON.stringify(receipt)).not.toMatch(/task|workflow-orchestrator\.test|surtec-control-plane|PRIVATE/);
  });
  it("records a missing binding or missing callback marker as unavailable instead of a fabricated zero window", () => {
    for (const prepared of [false, true]) { const context = failureContext({ state: "fail", retryCount: 0, repeatCount: 0, errors: [{ name: "Error", message: PLANNER_HOOK_TIMEOUT_MESSAGE }] }), clock = vi.fn(() => 0), lines: string[] = [], capture = createPlannerSpanCapture({ env: { SURTEC_TEST_PLANNER_SPAN_PROFILE: "1" }, sourceLimits: failureSourceLimits, clock, write: (line) => { lines.push(line); } }); if (prepared) capture.prepare(context); capture.capture(context); const receipt = parsePlannerSpanOutput(lines[0]!, failureSourceLimits);
      expect(receipt?.failure_receipt.errors[0]?.signature).toBe("hook-timeout-10000"); expect(receipt?.span_cursor).toEqual({ measurement_scope: "callback-entry-observer-to-root-afterEach", timing_status: "unavailable", unavailable_reason: prepared ? "callback-start-not-observed" : "case-binding-unavailable", observation_elapsed_ms: null, phases: null, cursor_phase: null, last_ended_phase: null, between_spans_ms: null, cursor_elapsed_ms: null, cleanup: "not-observed-at-this-point", sealed: true }); expect(clock).not.toHaveBeenCalled(); }
  });
  it("invalidates a consumed slot on a duplicate start without assigning its local observer to another case", () => {
    const clock = vi.fn(() => 0), harness = spanHarness(clock); expect(harness.capture.beginCallback()).toBeUndefined(); harness.observer.begin("issue-create")(); const receipt = harness.receipt(); expect(receipt.span_cursor.timing_status).toBe("unavailable"); expect(receipt.span_cursor.unavailable_reason).toBe("case-binding-unavailable"); expect(clock).toHaveBeenCalledOnce();
  });
  it("does not replace a task's original map entry after duplicate preparation of its one-shot slot", () => {
    const context = failureContext(), clock = vi.fn(() => 0), lines: string[] = [], capture = createPlannerSpanCapture({ env: { SURTEC_TEST_PLANNER_SPAN_PROFILE: "1" }, sourceLimits: failureSourceLimits, clock, write: (line) => { lines.push(line); } }); capture.prepare(context); capture.prepare(context); expect(capture.beginCallback()).toBeUndefined(); capture.capture(context); expect(parsePlannerSpanOutput(lines[0]!, failureSourceLimits)?.span_cursor).toMatchObject({ timing_status: "unavailable", unavailable_reason: "case-binding-unavailable", phases: null }); expect(clock).not.toHaveBeenCalled();
  });
  it("invalidates an active handle on every later preparation while retaining its exact WeakMap entry", () => {
    const harness = spanHarness(), end = harness.observer.begin("issue-create"), other = failureContext(); other.task.name = "unrelated synthetic case"; harness.capture.prepare(other); expect(harness.capture.beginCallback()).toBeUndefined(); end(); harness.capture.capture(harness.context); expect(parsePlannerSpanOutput(harness.lines[0]!, failureSourceLimits)?.span_cursor).toMatchObject({ timing_status: "unavailable", unavailable_reason: "case-binding-unavailable", phases: null });
  });
  it("keeps sealed history immune to later preparations, local begins, closers and framework mutation", () => {
    let now = 0; const clock = vi.fn(() => now), harness = spanHarness(clock), end = harness.observer.begin("issue-create"); now = 2; const receipt = harness.receipt(), serialized = JSON.stringify(receipt), reads = clock.mock.calls.length;
    const other = failureContext(); other.task.name = "unrelated synthetic later case"; harness.capture.prepare(other); harness.capture.beginCallback()?.begin("issue-create")(); end(); harness.observer.begin("issue-authorize")(); harness.context.task.result.state = "pass"; harness.context.task.result.errors = []; harness.capture.capture(harness.context);
    expect(harness.lines).toHaveLength(1); expect(JSON.stringify(receipt)).toBe(serialized); expect(clock).toHaveBeenCalledTimes(reads); expect(receipt.failure_receipt.framework_state).toBe("fail"); expect(Object.isFrozen(harness.context.task.result)).toBe(false); expect(Object.isFrozen(receipt.span_cursor.phases?.["issue-create"])).toBe(true);
  });
  it("keeps late explicit local observer callbacks separate from the next prepared observer", () => {
    let now = 0; const lines: string[] = [], clock = vi.fn(() => now), capture = createPlannerSpanCapture({ env: { SURTEC_TEST_PLANNER_SPAN_PROFILE: "1" }, sourceLimits: failureSourceLimits, clock, write: (line) => { lines.push(line); } }), first = failureContext(), second = failureContext(); capture.prepare(first); const firstObserver = capture.beginCallback()!, late = firstObserver.begin("issue-create"); now = 2; capture.capture(first); const historical = lines[0], reads = clock.mock.calls.length;
    capture.prepare(second); const secondObserver = capture.beginCallback(); late(); firstObserver.begin("issue-authorize")(); expect(secondObserver).toBeUndefined(); expect(clock).toHaveBeenCalledTimes(reads); capture.capture(second); expect(lines).toEqual([historical]); expect(parsePlannerSpanOutput(historical!, failureSourceLimits)?.span_cursor.phases?.["issue-create"].state).toBe("open");
  });
  it("does not let an invalidated unsealed local handle clock or mark the next active case", () => {
    const clock = vi.fn(() => 0), lines: string[] = [], capture = createPlannerSpanCapture({ env: { SURTEC_TEST_PLANNER_SPAN_PROFILE: "1" }, sourceLimits: failureSourceLimits, clock, write: (line) => { lines.push(line); } }), first = failureContext(), second = failureContext(); capture.prepare(first); const firstObserver = capture.beginCallback()!, late = firstObserver.begin("issue-create"); capture.prepare(second); const secondObserver = capture.beginCallback()!; expect(secondObserver).not.toBe(firstObserver); const reads = clock.mock.calls.length; late(); firstObserver.begin("issue-authorize")(); expect(clock).toHaveBeenCalledTimes(reads);
    secondObserver.begin("issue-create")(); capture.capture(second); expect(parsePlannerSpanOutput(lines[0]!, failureSourceLimits)?.span_cursor).toMatchObject({ timing_status: "captured", phases: { "issue-create": { state: "ended" }, "issue-authorize": { state: "not-observed" } } });
  });
  it.each(["retryCount", "repeatCount"] as const)("seals unavailable timing when original %s changes before capture", (counter) => {
    const clock = vi.fn(() => 0), harness = spanHarness(clock), end = harness.observer.begin("issue-create"); harness.context.task.result[counter] = 1; const receipt = harness.receipt(), before = JSON.stringify(receipt), reads = clock.mock.calls.length; expect(receipt.failure_receipt).toMatchObject({ capture_status: "unavailable", unavailable_reason: "invalid-counters" }); expect(receipt.span_cursor).toMatchObject({ timing_status: "unavailable", unavailable_reason: "case-binding-unavailable", phases: null }); end(); harness.observer.begin("issue-authorize")(); expect(clock).toHaveBeenCalledTimes(reads); expect(JSON.stringify(receipt)).toBe(before);
  });
  it("seals a known local handle when the selected framework result becomes malformed", () => {
    const clock = vi.fn(() => 0), harness = spanHarness(clock), end = harness.observer.begin("issue-create"); harness.context.task.result = [] as unknown as Record<string, unknown>; const receipt = harness.receipt(), before = JSON.stringify(receipt), reads = clock.mock.calls.length; expect(receipt.failure_receipt).toMatchObject({ capture_status: "unavailable", unavailable_reason: "invalid-result" }); expect(receipt.span_cursor).toMatchObject({ timing_status: "unavailable", unavailable_reason: "case-binding-unavailable", phases: null }); end(); harness.observer.begin("issue-authorize")(); expect(clock).toHaveBeenCalledTimes(reads); expect(JSON.stringify(receipt)).toBe(before);
  });
  it("records an open span, ended span and directly observed gaps as a dense ordered partition", () => {
    let now = 100; const harness = spanHarness(() => now); now = 101; harness.observer.begin("issue-create")(); now = 104; const end = harness.observer.begin("issue-authorize"); now = 109; const receipt = harness.receipt(), cursor = receipt.span_cursor;
    expect(Object.keys(receipt)).toHaveLength(8); expect(Object.keys(cursor)).toHaveLength(11); expect(Object.keys(cursor.phases!)).toEqual([...PLANNER_SPAN_PHASES]); expect(cursor).toMatchObject({ timing_status: "captured", unavailable_reason: null, observation_elapsed_ms: 9, cursor_phase: "issue-authorize", last_ended_phase: "issue-create", between_spans_ms: 4, cursor_elapsed_ms: 5, cleanup: "not-observed-at-this-point", sealed: true });
    expect(cursor.phases?.["issue-create"]).toEqual({ entries: 1, state: "ended", start_ms: 1, end_ms: 1, elapsed_ms: 0 }); expect(cursor.phases?.["issue-authorize"]).toEqual({ entries: 1, state: "open", start_ms: 4, end_ms: null, elapsed_ms: 5 }); for (const phase of PLANNER_SPAN_PHASES.slice(2)) expect(cursor.phases?.[phase]).toEqual({ entries: 0, state: "not-observed", start_ms: null, end_ms: null, elapsed_ms: null }); end(); expect(receipt.span_cursor).toBe(cursor);
  });
  it("records initial and final between-span cursors without inventing phase starts or a body-end marker", () => {
    let now = 10; const initial = spanHarness(() => now); now = 13; const untouched = initial.receipt().span_cursor; expect(untouched).toMatchObject({ observation_elapsed_ms: 3, cursor_phase: "between-public-spans", last_ended_phase: null, between_spans_ms: 3, cursor_elapsed_ms: 3 }); expect(Object.values(untouched.phases!).every((row) => row.state === "not-observed")).toBe(true);
    now = 0; const all = spanHarness(() => now); for (const phase of PLANNER_SPAN_PHASES) { now += 2; const end = all.observer.begin(phase); now += 1; end(); } now += 3; const ended = all.receipt().span_cursor; expect(ended).toMatchObject({ observation_elapsed_ms: 36, cursor_phase: "between-public-spans", last_ended_phase: "probe-assertions", between_spans_ms: 25, cursor_elapsed_ms: 3 }); expect(Object.values(ended.phases!).every((row) => row.state === "ended" && row.elapsed_ms === 1)).toBe(true); expect(sanitizePlannerSpanCursor(ended)).toEqual(ended);
  });
  it("revalidates fractional offsets with canonical arithmetic rather than naive floating-point sums", () => {
    const readings = [0, 0.1, 0.2, 0.3, 0.4, 0.6], harness = spanHarness(() => readings.shift()!); harness.observer.begin("issue-create")(); harness.observer.begin("issue-authorize")(); const cursor = harness.receipt().span_cursor;
    expect(cursor.timing_status).toBe("captured"); expect(cursor.observation_elapsed_ms).toBe(0.6); expect(sanitizePlannerSpanCursor(cursor)).toEqual(cursor); expect(sanitizePlannerSpanReceipt({ ...harness.receipt(), span_cursor: cursor }, failureSourceLimits)?.span_cursor).toEqual(cursor);
  });
  it("allows a shorter later duration while requiring monotonically ordered offsets", () => {
    let now = 0; const harness = spanHarness(() => now), first = harness.observer.begin("issue-create"); now = 10; first(); now = 11; const second = harness.observer.begin("issue-authorize"); now = 12; second(); now = 13; const cursor = harness.receipt().span_cursor; expect(cursor.timing_status).toBe("captured"); expect(cursor.phases?.["issue-create"].elapsed_ms).toBe(10); expect(cursor.phases?.["issue-authorize"].elapsed_ms).toBe(1); expect(sanitizePlannerSpanCursor(cursor)).toEqual(cursor);
  });
  it.each(["reverse", "unknown", "overlap", "duplicate-phase", "duplicate-end"] as const)("latches %s span sequence errors without executing an action callback", (fault) => {
    const harness = spanHarness(), callback = vi.fn(); if (fault === "reverse") harness.observer.begin("issue-authorize")(); else if (fault === "unknown") harness.observer.begin(callback as never)(); else { const end = harness.observer.begin("issue-create"); if (fault === "overlap") harness.observer.begin("issue-authorize")(); else { end(); if (fault === "duplicate-end") end(); else harness.observer.begin("issue-create")(); } }
    harness.observer.begin("issue-authorize")(); const receipt = harness.receipt(); expect(receipt.span_cursor).toMatchObject({ timing_status: "unavailable", unavailable_reason: "invalid-span-sequence", phases: null, observation_elapsed_ms: null }); expect(receipt.failure_receipt.errors[0]?.signature).toBe("test-timeout-5000"); expect(callback).not.toHaveBeenCalled();
  });
  it.each(["throw", "NaN", "infinity", "negative", "regression", "ceiling"] as const)("keeps a %s clock fault unavailable while preserving the P08 failure projection", (fault) => {
    let reads = 0; const clock = vi.fn(() => { if (reads++ !== 2) return reads; if (fault === "throw") throw new Error("PRIVATE CLOCK BODY"); return fault === "NaN" ? Number.NaN : fault === "infinity" ? Number.POSITIVE_INFINITY : fault === "negative" ? -1 : fault === "regression" ? 1 : PROFILE_LIMIT_MS + 2; });
    const harness = spanHarness(clock), end = harness.observer.begin("issue-create"); expect(() => end()).not.toThrow(); const receipt = harness.receipt(); expect(receipt.span_cursor).toMatchObject({ timing_status: "unavailable", unavailable_reason: "invalid-clock", phases: null, observation_elapsed_ms: null }); expect(receipt.failure_receipt).toEqual(failureReceipt(harness.context)); expect(JSON.stringify(receipt)).not.toContain("PRIVATE");
  });
  it.each([0, 1, 3])("does not invent timing when clock read %s throws at callback entry, begin or capture", (fault) => {
    let reads = 0; const harness = spanHarness(() => { if (reads++ === fault) throw new Error("PRIVATE CLOCK"); return reads; }); harness.observer.begin("issue-create")(); expect(harness.receipt().span_cursor).toMatchObject({ timing_status: "unavailable", unavailable_reason: "invalid-clock", cursor_phase: null, cursor_elapsed_ms: null, between_spans_ms: null });
  });
  it.each([false, true])("seals before existing cleanup and preserves original cleanup error identity, throws=%s", async (throws) => {
    const harness = spanHarness(), original = new Error("Synthetic original cleanup error"), steps: string[] = [], end = harness.observer.begin("issue-create"); let observed: unknown;
    const existingHook = async () => { harness.capture.capture(harness.context); steps.push("finish"); end(); await Promise.resolve(); steps.push("stop"); harness.context.task.result.state = "pass"; if (throws) throw original; steps.push("restore", "remove"); }; try { await existingHook(); } catch (error) { observed = error; }
    expect(observed).toBe(throws ? original : undefined); expect(steps).toEqual(throws ? ["finish", "stop"] : ["finish", "stop", "restore", "remove"]); expect(parsePlannerSpanOutput(harness.lines[0]!, failureSourceLimits)).toMatchObject({ failure_receipt: { framework_state: "fail" }, span_cursor: { cleanup: "not-observed-at-this-point", phases: { "issue-create": { state: "open" } } } });
  });
  it("cannot replace an original thrown error, promise or finally cleanup with observer clock/write faults", () => {
    const original = new Error("Synthetic original operation failure"), promise = Promise.resolve("synthetic original promise"), cleanup = vi.fn(), context = failureContext(), write = vi.fn(() => { throw Object.assign(new Error("PRIVATE PIPE"), { code: "EPIPE" }); }), capture = createPlannerSpanCapture({ env: { SURTEC_TEST_PLANNER_SPAN_PROFILE: "1" }, sourceLimits: failureSourceLimits, clock: () => { throw new Error("PRIVATE CLOCK"); }, write }); capture.prepare(context); const observer = capture.beginCallback(), end = observer?.begin("issue-create"); let actual: unknown;
    const result = promise; expect(result).toBe(promise); try { try { throw original; } finally { end?.(); capture.capture(context); cleanup(); } } catch (error) { actual = error; } expect(actual).toBe(original); expect(cleanup).toHaveBeenCalledOnce(); expect(write).toHaveBeenCalledOnce(); capture.capture(context); expect(write).toHaveBeenCalledOnce();
  });
  it("emits one bounded line containing eight errors, three total sites and eleven rows with no private payload", () => {
    const limits = { line_columns: Array.from({ length: 10_000 }, () => 65536) }, context = failureContext({ state: "fail", retryCount: 0, repeatCount: 0, errors: Array.from({ length: 8 }, () => ({ name: "AggregateError", message: PLANNER_HOOK_TIMEOUT_MESSAGE, stack: [9998, 9999, 10000].map((line) => ` at PRIVATE_METHOD (${failureFixturePath}:${line}:65536)`).join("\n"), expected: "PRIVATE BODY" })) }), lines: string[] = []; let now = 0; const capture = createPlannerSpanCapture({ env: { SURTEC_TEST_PLANNER_SPAN_PROFILE: "1" }, sourceLimits: limits, clock: () => now, write: (line) => { lines.push(line); return false; } }); capture.prepare(context); const observer = capture.beginCallback()!;
    for (const [index, phase] of PLANNER_SPAN_PHASES.entries()) { now = 0.0000012345678901234567 * (index * 2 + 1); const end = observer.begin(phase); now = 0.0000012345678901234567 * (index * 2 + 2); end(); } now = PROFILE_LIMIT_MS; expect(capture.capture(context)).toBeUndefined(); capture.capture(context); expect(lines).toHaveLength(1); const line = lines[0]!, receipt = parsePlannerSpanOutput(line, limits)!;
    expect(receipt.failure_receipt.error_count).toBe(8); expect(receipt.failure_receipt.errors.flatMap((error) => error.sites)).toHaveLength(3); expect(Object.keys(receipt.span_cursor.phases!)).toHaveLength(11); expect(receipt.span_cursor.observation_elapsed_ms).toBe(PROFILE_LIMIT_MS); expect(line.startsWith("PLANNER_SPAN_PROFILE ")).toBe(true); expect(line.endsWith("\n")).toBe(true); expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(8192); expect(line).not.toMatch(/PRIVATE|workflow-orchestrator\.test|surtec-control-plane/); expect(sanitizePlannerSpanReceipt(receipt, limits)).toEqual(receipt);
    // 32 characters plus JSON quotes overbound every nonnegative binary64 JSON number lexeme.
    const numericWidthBound = `PLANNER_SPAN_PROFILE ${JSON.stringify(receipt, (_key, value: unknown) => typeof value === "number" ? "9".repeat(32) : value)}\n`; expect(Buffer.byteLength(numericWidthBound, "utf8")).toBeLessThanOrEqual(8192);
  });
  it("rejects contradictory partitions, numeric totals, row combinations and closed-field extras", () => {
    const receipt = completeSpanReceipt(), cursor = receipt.span_cursor, phases = cursor.phases!, first = phases["issue-create"], last = phases["probe-assertions"];
    const candidates = [{ ...cursor, private: "PRIVATE BODY" }, { ...cursor, observation_elapsed_ms: -1 }, { ...cursor, observation_elapsed_ms: Number.NaN }, { ...cursor, observation_elapsed_ms: PROFILE_LIMIT_MS + 1 }, { ...cursor, between_spans_ms: cursor.between_spans_ms! + 1 }, { ...cursor, cursor_elapsed_ms: cursor.cursor_elapsed_ms! + 1 }, { ...cursor, last_ended_phase: "issue-create" }, { ...cursor, cursor_phase: "probe-assertions" }, { ...cursor, cleanup: "ended" }, { ...cursor, sealed: false }, { ...cursor, phases: { ...phases, cleanup: first } }, { ...cursor, phases: { ...phases, "issue-create": { ...first, entries: 0 } } }, { ...cursor, phases: { ...phases, "issue-create": { ...first, elapsed_ms: first.elapsed_ms! + 1 } } }, { ...cursor, phases: { ...phases, "issue-create": { ...first, end_ms: null } } }, { ...cursor, phases: { ...phases, "probe-assertions": { ...last, start_ms: 0, elapsed_ms: last.end_ms } } }];
    for (const candidate of candidates) expect(sanitizePlannerSpanCursor(candidate)).toBeNull(); const missing = { ...phases }; delete (missing as Partial<typeof phases>)["issue-create"]; expect(sanitizePlannerSpanCursor({ ...cursor, phases: missing })).toBeNull();
    for (const value of [{ ...receipt, private: "PRIVATE" }, { ...receipt, acceptance: true }, { ...receipt, kind: "planner-failure-observation" }, { ...receipt, failure_receipt: { ...receipt.failure_receipt, error_count: 2 } }]) expect(sanitizePlannerSpanReceipt(value, failureSourceLimits)).toBeNull();
  });
  it("rejects getters and Proxy traps throughout detached envelopes and leaves framework-owned objects mutable", () => {
    const receipt = completeSpanReceipt(), hook = vi.fn(), accessor = { ...receipt }; Object.defineProperty(accessor, "span_cursor", { enumerable: true, get: hook }); expect(sanitizePlannerSpanReceipt(accessor, failureSourceLimits)).toBeNull(); expect(sanitizePlannerSpanReceipt(new Proxy(receipt, { get: hook, ownKeys: hook }), failureSourceLimits)).toBeNull(); const cursor = { ...receipt.span_cursor }; Object.defineProperty(cursor, "phases", { enumerable: true, get: hook }); expect(sanitizePlannerSpanCursor(cursor)).toBeNull(); expect(sanitizePlannerSpanCursor(new Proxy(receipt.span_cursor, { get: hook, ownKeys: hook }))).toBeNull(); expect(hook).not.toHaveBeenCalled();
    const projection = sanitizePlannerSpanReceipt(receipt, failureSourceLimits)!; expect(projection).not.toBe(receipt); expect(Object.isFrozen(projection)).toBe(true); expect(Object.isFrozen(projection.failure_receipt)).toBe(true); expect(Object.isFrozen(projection.span_cursor)).toBe(true); expect(Object.isFrozen(projection.span_cursor.phases)).toBe(true);
  });
  it("rejects fabricated fields in unavailable cursors and multiple open or missing predecessor spans", () => {
    const context = failureContext(), lines: string[] = [], capture = createPlannerSpanCapture({ env: { SURTEC_TEST_PLANNER_SPAN_PROFILE: "1" }, sourceLimits: failureSourceLimits, write: (line) => { lines.push(line); } }); capture.capture(context); const unavailable = parsePlannerSpanOutput(lines[0]!, failureSourceLimits)!.span_cursor; expect(sanitizePlannerSpanCursor(unavailable)).toEqual(unavailable); for (const value of [{ ...unavailable, phases: {} }, { ...unavailable, observation_elapsed_ms: 0 }, { ...unavailable, cursor_elapsed_ms: 0 }, { ...unavailable, last_ended_phase: "issue-create" }, { ...unavailable, unavailable_reason: null }]) expect(sanitizePlannerSpanCursor(value)).toBeNull();
    const harness = spanHarness(), open = harness.observer.begin("issue-create"), cursor = harness.receipt().span_cursor, phases = cursor.phases!; expect(sanitizePlannerSpanCursor({ ...cursor, phases: { ...phases, "issue-authorize": { ...phases["issue-create"] } } })).toBeNull(); expect(sanitizePlannerSpanCursor({ ...cursor, phases: { ...phases, "issue-create": { ...phases["issue-authorize"] }, "issue-authorize": { ...phases["issue-create"] } } })).toBeNull(); open();
    const getter = vi.fn(), row = { ...phases["issue-create"] }; Object.defineProperty(row, "start_ms", { enumerable: true, get: getter }); expect(sanitizePlannerSpanCursor({ ...cursor, phases: { ...phases, "issue-create": row } })).toBeNull(); expect(sanitizePlannerSpanCursor({ ...cursor, phases: new Proxy(phases, { get: getter, ownKeys: getter }) })).toBeNull(); expect(getter).not.toHaveBeenCalled();
  });
  it("collects byte-split UTF-8 output while retaining only the closed native marker", () => {
    const receipt = completeSpanReceipt(), updates: Array<PlannerSpanReceipt | null> = [], collector = createPlannerSpanMarkerCollector((value) => updates.push(value), failureSourceLimits), bytes = Buffer.from(`PRIVATE é😀 output\nPLANNER_SPAN_PROFILE ${JSON.stringify(receipt)}\n`); for (const byte of bytes) collector.push(Buffer.from([byte])); expect(collector.finish()).toEqual(receipt); expect(updates).toEqual([receipt]); expect(JSON.stringify(updates)).not.toContain("PRIVATE");
  });
  it("rejects duplicate and escaped-alias keys within both nested projections", () => {
    const raw = JSON.stringify(completeSpanReceipt()); for (const [key, alias] of [["error_count", "error_" + String.fromCharCode(92) + "u0063ount"], ["entries", "entr" + String.fromCharCode(92) + "u0069es"], ["span_cursor", "span_" + String.fromCharCode(92) + "u0063ursor"]]) { const pattern = `"${key}":`, duplicate = raw.replace(pattern, `"${alias}":null,${pattern}`); expect(parsePlannerSpanOutput(`PLANNER_SPAN_PROFILE ${duplicate}\n`, failureSourceLimits)).toBeNull(); const exact = raw.replace(pattern, `"${key}":null,${pattern}`); expect(parsePlannerSpanOutput(`PLANNER_SPAN_PROFILE ${exact}\n`, failureSourceLimits)).toBeNull(); }
    const escapedOnly = raw.replace('"span_cursor":', '"span_' + String.fromCharCode(92) + 'u0063ursor":'); expect(parsePlannerSpanOutput(`PLANNER_SPAN_PROFILE ${escapedOnly}\n`, failureSourceLimits)).toBeNull();
  });
  it("enforces the incremental 8192-byte ceiling including prefix and LF and rejects invalid UTF-8", () => {
    const receipt = completeSpanReceipt(), raw = `PLANNER_SPAN_PROFILE ${JSON.stringify(receipt)}`; expect(parsePlannerSpanOutput(`${raw.padEnd(8191, " ")}\n`, failureSourceLimits)).toEqual(receipt); expect(parsePlannerSpanOutput(`${raw.padEnd(8192, " ")}\n`, failureSourceLimits)).toBeNull();
    for (const body of [Buffer.from("é".repeat(4096)), Buffer.from([0xc3, 0x28])]) { const collector = createPlannerSpanMarkerCollector(undefined, failureSourceLimits); collector.push("PLANNER_SPAN_PROFILE "); collector.push(body); collector.push("\n"); expect(collector.finish()).toBeNull(); }
  });
  it.each(["duplicate", "malformed", "truncated", "prefix", "prefix-LF", "marker-without-space-LF", "oversized"] as const)("permanently revokes earlier safe progress after a %s marker", (fault) => {
    const receipt = completeSpanReceipt(), line = `PLANNER_SPAN_PROFILE ${JSON.stringify(receipt)}\n`, updates: Array<PlannerSpanReceipt | null> = [], collector = createPlannerSpanMarkerCollector((value) => updates.push(value), failureSourceLimits); collector.push(line); expect(updates.at(-1)).toEqual(receipt); collector.push(fault === "duplicate" ? line : fault === "malformed" ? "PLANNER_SPAN_PROFILE {invalid}\n" : fault === "truncated" ? "PLANNER_SPAN_PROFILE {" : fault === "prefix" ? "PLANNER_SPAN_" : fault === "prefix-LF" ? "PLANNER_SPAN_\n" : fault === "marker-without-space-LF" ? "PLANNER_SPAN_PROFILE\n" : `PLANNER_SPAN_PROFILE ${"x".repeat(8192)}\n`); expect(collector.finish()).toBeNull(); expect(updates.at(-1)).toBeNull();
    expect(parsePlannerSpanOutput(line.trimEnd(), failureSourceLimits)).toBeNull(); expect(parsePlannerSpanOutput(line.replace('"sealed":true', '"sealed":true,"private":"BODY"'), failureSourceLimits)).toBeNull();
  });
  it("does not heal a reserved prefix truncated at LF when a later complete marker arrives", () => {
    const receipt = completeSpanReceipt(), line = `PLANNER_SPAN_PROFILE ${JSON.stringify(receipt)}\n`; for (const prefix of ["PLANNER_SPAN_\n", "PLANNER_SPAN_PROFILE\n"]) expect(parsePlannerSpanOutput(prefix + line, failureSourceLimits)).toBeNull();
  });
  it("requires separate coherent final suite, source and cleanup facts before a diagnostic completes", () => {
    const partial = partialSpanReport(), completed = completedSpanReport(); expect(sanitizePlannerSpanDiagnostic(partial, failureSourceLimits)?.receipt).toEqual(partial.receipt); expect(sanitizePlannerSpanDiagnostic(completed, failureSourceLimits)?.status).toBe("completed");
    for (const report of [{ ...partial, status: "completed" }, { ...completed, receipt: null }, { ...completed, source_drift: true }, { ...completed, cleanup: "unavailable-no-uncertain-fixture-deleted" }, { ...completed, suite: { ...completed.suite!, passed_tests: 0 } }, { ...completed, suite: { ...completed.suite!, failed_tests: 1 } }, { ...completed, first_planner: { passed: false, test_ms: 1 } }, { ...completed, acceptance: true }]) expect(sanitizePlannerSpanDiagnostic(report, failureSourceLimits)).toBeNull();
    expect(JSON.stringify(sanitizePlannerSpanDiagnostic({ ...partial, private: "PRIVATE BODY" }, failureSourceLimits))).not.toContain("PRIVATE");
  });
  it("rejects completed diagnostics with an early failure or any unfinished public span", () => {
    const completed = completedSpanReport(), noSpans = spanHarness(() => 0, failureContext({ state: "pass", retryCount: 0, repeatCount: 0 })).receipt(), open = spanHarness(() => 0, failureContext({ state: "pass", retryCount: 0, repeatCount: 0 })); open.observer.begin("issue-create");
    for (const receipt of [completeSpanReceipt(), noSpans, open.receipt()]) { expect(sanitizePlannerSpanDiagnostic({ ...completed, receipt }, failureSourceLimits)).toBeNull(); expect(sanitizePlannerSpanDiagnostic({ ...partialSpanReport(receipt), status: "failed" }, failureSourceLimits)?.receipt).toEqual(receipt); }
  });
  it("retains one source-bound immutable envelope on fake deadline expiry without inventing suite or cleanup", async () => {
    vi.useFakeTimers(); const start = Date.now(), child = new Child(), foreign = new Child(), partial = partialSpanReport(), read = vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("Unexpected outer filesystem read"); }); child.send.mockImplementation(() => { child.emit("message", spanSourceEnvelope()); child.emit("message", { role: "planner-span-progress", report: partial }); });
    const pending = runPlannerSpanDiagnosticWatchdog(new ProfileDeadline(() => Date.now() - start), () => child); await vi.advanceTimersByTimeAsync(870_000); expect(child.signals).toEqual([]); await vi.advanceTimersByTimeAsync(30_000); const report = await pending; expect(report).toMatchObject({ status: "deadline", wall_ms: PROFILE_LIMIT_MS, wall_limit_ms: PROFILE_LIMIT_MS, cleanup_reserve_ms: PROFILE_CLEANUP_RESERVE_MS, receipt: partial.receipt, suite: null, first_planner: null, source_hashes_after: {}, source_drift: null, cleanup: "unavailable-no-uncertain-fixture-deleted", acceptance: false }); expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]); expect(foreign.signals).toEqual([]); expect(read).not.toHaveBeenCalled(); expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ role: "planner-span-controller" }));
  });
  it.each(["missing", "malformed", "duplicate", "wrong-hash", "out-of-order", "extra"] as const)("revokes the whole envelope permanently for %s source metadata", async (fault) => {
    const child = new Child(), partial = partialSpanReport(); child.send.mockImplementation(() => { if (fault === "out-of-order") child.emit("message", { role: "planner-span-progress", report: partial }); if (fault !== "missing") child.emit("message", fault === "malformed" ? { ...spanSourceEnvelope(), sourceLimits: { line_columns: [0] } } : fault === "extra" ? { ...spanSourceEnvelope(), private: "PRIVATE" } : spanSourceEnvelope()); child.emit("message", { role: "planner-span-progress", report: fault === "wrong-hash" ? { ...partial, source_hashes: { "runner/workflow-orchestrator.test.ts": "b".repeat(64) } } : partial }); if (fault === "duplicate") child.emit("message", spanSourceEnvelope()); child.emit("message", { role: "planner-span-report", report: partial }); child.emit("close", 0); }); const report = await runPlannerSpanDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(report.receipt).toBeNull(); expect(report.status).toBe("failed"); expect(report.suite).toBeNull(); expect(report.source_drift).toBeNull(); expect(report.cleanup).toBe("unavailable-no-uncertain-fixture-deleted");
  });
  it.each(["null", "malformed", "failure-change", "cursor-change", "extra-envelope", "final-before-progress"] as const)("makes %s IPC revocation sticky across later valid progress and a final report", async (fault) => {
    const child = new Child(), partial = partialSpanReport(); child.send.mockImplementation(() => { child.emit("message", spanSourceEnvelope()); child.emit("message", { role: "planner-span-progress", report: partial });
      const changed = fault === "null" ? { ...partial, receipt: null } : fault === "malformed" ? { ...partial, receipt: { ...partial.receipt, span_cursor: {} } } : fault === "failure-change" ? { ...partial, receipt: { ...partial.receipt!, failure_receipt: failureReceipt(failureContext({ state: "pass", retryCount: 0, repeatCount: 0 })) } } : fault === "cursor-change" ? { ...partial, receipt: completeSpanReceipt() } : partial;
      if (fault === "final-before-progress") child.emit("message", { role: "planner-span-report", report: partial }); child.emit("message", fault === "extra-envelope" ? { role: "planner-span-progress", report: changed, private: "PRIVATE" } : { role: "planner-span-progress", report: fault === "cursor-change" ? { ...changed, receipt: spanHarness().receipt() } : changed }); child.emit("message", { role: "planner-span-progress", report: partial }); child.emit("message", { role: "planner-span-report", report: partial }); child.emit("close", 0);
    }); const report = await runPlannerSpanDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(report.receipt).toBeNull(); expect(report.status).toBe("failed"); expect(report.suite).toBeNull(); expect(report.acceptance).toBe(false);
  });
  it("detaches the entire first envelope immediately and accepts only its unchanged canonical identity", async () => {
    const child = new Child(), partial = partialSpanReport(), raw = JSON.parse(JSON.stringify(partial)) as PlannerSpanDiagnosticReport; child.send.mockImplementation(() => { child.emit("message", spanSourceEnvelope()); child.emit("message", { role: "planner-span-progress", report: raw }); raw.receipt!.failure_receipt.errors[0]!.signature = "unsupported"; raw.receipt!.span_cursor.observation_elapsed_ms = 999; raw.source_hashes["runner/workflow-orchestrator.test.ts"] = "b".repeat(64); child.emit("close", 1); }); const report = await runPlannerSpanDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(report.receipt).toEqual(partial.receipt); expect(report.source_hashes["runner/workflow-orchestrator.test.ts"]).toBe("a".repeat(64)); expect(report.source_hashes_after).toEqual({}); expect(report.source_drift).toBeNull();
  });
  it("accepts repeated identical envelopes and a normal completed report without outer filesystem work", async () => {
    const completed = completedSpanReport(), child = new Child(), read = vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("Unexpected outer filesystem read"); }); child.send.mockImplementation(() => { child.emit("message", spanSourceEnvelope()); child.emit("message", { role: "planner-span-progress", report: completed }); child.emit("message", { role: "planner-span-progress", report: completed }); child.emit("message", { role: "planner-span-report", report: completed }); child.emit("close", 0); }); const report = await runPlannerSpanDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(report.status).toBe("completed"); expect(report.receipt).toEqual(completed.receipt); expect(report.acceptance).toBe(false); expect(child.signals).toEqual([]); expect(read).not.toHaveBeenCalled();
  });
  it("supervises only the issued handle after a failed send and never launches after the original ceiling", async () => {
    vi.useFakeTimers(); const child = new Child(), foreign = new Child(); child.send.mockImplementation(() => { throw new Error("PRIVATE IPC BODY"); }); const pending = runPlannerSpanDiagnosticWatchdog(new ProfileDeadline(() => 0), () => child); await vi.advanceTimersByTimeAsync(2000); const report = await pending; expect(report.status).toBe("failed"); expect(report.receipt).toBeNull(); expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]); expect(foreign.signals).toEqual([]); expect(JSON.stringify(report)).not.toContain("PRIVATE"); const launch = vi.fn(() => new Child()); expect((await runPlannerSpanDiagnosticWatchdog(new ProfileDeadline(() => PROFILE_LIMIT_MS), launch)).status).toBe("deadline"); expect(launch).not.toHaveBeenCalled();
  });
});

const suiteProgressFlags = { SURTEC_TEST_SUITE_PROGRESS_PROFILE: "1", SURTEC_TEST_PLANNER_SPAN_PROFILE: "1" };
type ProgressState = "passed" | "failed" | "skipped";
interface ProgressModule { moduleId: string; project: object; toTestSpecification(): { moduleId: string; project: object; pool: string }; children: { allTests(): Iterable<ProgressCase> }; state(): ProgressState }
function progressModule(source = "runner/workflow-orchestrator.test.ts", names = [PLANNER_FAILURE_CASE, "PRIVATE ordinary case"], project: object = {}) {
  const specification = { moduleId: resolve(source).replaceAll("\\", "/"), project, pool: "forks" };
  let state: ProgressState = "passed";
  const module: ProgressModule = { moduleId: specification.moduleId, project, toTestSpecification: () => specification, children: { *allTests(): Generator<ProgressCase> { yield* tests; } }, state: () => state };
  const tests: ProgressCase[] = names.map((name) => ({ module, name, result: vi.fn(() => ({ state: "passed" })), diagnostic: vi.fn(() => ({ retryCount: 0, repeatCount: 0 })) }));
  return { module, specification, tests, setState(next: ProgressState) { state = next; } };
}
interface ProgressCase { module: ProgressModule; name: string; result: () => { state: string }; diagnostic: () => { retryCount: number; repeatCount: number } | undefined }
function progressHarness(selected = [progressModule()], clock: () => number = () => 0) {
  const lines: string[] = [], reporter = createSuiteProgressReporter({ env: suiteProgressFlags, clock, write: (line) => { lines.push(line); return false; } });
  return { selected, reporter, lines, start() { reporter.onInit(); reporter.onTestRunStart(selected.map(({ specification }) => specification)); }, collect() { for (const { module } of selected) { reporter.onTestModuleQueued(module); reporter.onTestModuleCollected(module); reporter.onTestModuleStart(module); } }, complete(reason: "passed" | "failed" | "interrupted" = "passed", errors: unknown[] = []) { for (const entry of selected) { for (const test of entry.tests) { reporter.onTestCaseReady(test); reporter.onTestCaseResult(test); } reporter.onTestModuleEnd(entry.module); } reporter.onTestRunEnd(selected.map(({ module }) => module), errors, reason); }, snapshot() { return parseSuiteProgressOutput(lines.join("")); }, frames() { return lines.map((line) => JSON.parse(line.slice("SUITE_PROGRESS_PROFILE ".length)) as SuiteProgressFrame); } };
}
function completeProgress() { const harness = progressHarness(); harness.start(); harness.collect(); harness.complete(); const snapshot = harness.snapshot(); if (!snapshot) throw new Error("Synthetic progress unavailable"); return { ...harness, progress: snapshot }; }
function progressJson(progress: SuiteProgressSnapshot = completeProgress().progress) {
  return JSON.stringify({ numTotalTestSuites: 17, success: true, numPassedTests: progress.counts.passed, numFailedTests: progress.counts.failed, numPendingTests: progress.counts.skipped, numTodoTests: 0, numTotalTests: progress.counts.finished, testResults: progress.modules.map((module) => ({ name: resolve(module.source).replaceAll("\\", "/"), status: module.state === "failed" ? "failed" : "passed", assertionResults: Array.from({ length: module.counts.collected }, (_, index) => ({ title: module.source === "runner/workflow-orchestrator.test.ts" && index === 0 ? PLANNER_FAILURE_CASE : "PRIVATE other title", fullName: module.source === "runner/workflow-orchestrator.test.ts" && index === 0 ? `fictional suite ${PLANNER_FAILURE_CASE}` : "PRIVATE suite PRIVATE other title", status: index < module.counts.passed ? "passed" : index < module.counts.passed + module.counts.failed ? "failed" : "pending", duration: 1, failureMessages: ["PRIVATE ERROR BODY"] })) })) });
}
function progressSourceEnvelope() { return { role: "suite-progress-source", fixture_sha256: "a".repeat(64), sourceLimits: failureSourceLimits, source_hashes: Object.fromEntries(SUITE_PROGRESS_SOURCES.map((source, index) => [source, index >= 11 ? SUITE_PROGRESS_CONTRACT_HASHES[index - 11]! : "a".repeat(64)])) }; }
function partialProgressReport(progress: SuiteProgressSnapshot | null = completeProgress().progress): SuiteProgressDiagnosticReport {
  return { schema_version: 1, workload: "full-suite-progress", diagnostic_only: true, acceptance: false, status: "failed", wall_ms: 10, wall_limit_ms: PROFILE_LIMIT_MS, cleanup_reserve_ms: PROFILE_CLEANUP_RESERVE_MS, source_hashes: progressSourceEnvelope().source_hashes, source_hashes_after: {}, source_drift: null, progress, receipt: null, json: null, native_exit: null, stdio_close: null, last_progress_received_ms: progress ? 0 : null, cleanup: "unavailable-no-uncertain-fixture-deleted", limitations: [...SUITE_PROGRESS_LIMITATIONS] };
}
function completedProgressReport(): SuiteProgressDiagnosticReport {
  const base = partialProgressReport(), receipt = completedSpanReport().receipt;
  return { ...base, status: "completed", source_hashes_after: { ...base.source_hashes }, source_drift: false, receipt, json: summarizeSuiteProgressJson(progressJson(base.progress!), base.progress!), native_exit: { code: 0, signal: null, received_ms: 8 }, stdio_close: { exit_code: 0, closed: true, expired: false, failed: false }, cleanup: "verified-normal-suite-and-no-new-planner-prefix-roots" };
}
function emitProgressFrames(child: Child, harness = completeProgress(), received_ms = 0) { for (const frame of harness.frames()) child.emit("message", { role: "suite-progress-frame", frame, received_ms }); }

describe("P10 bounded public suite progress", () => {
  it("adds one fixed full-workload dual-reporter command and strips all inherited diagnostic authority", () => {
    expect(parseProfileArguments(["--workload=full-suite-progress"])).toBe("full-suite-progress"); expect(PROFILE_WORKLOADS).not.toContain("full-suite-progress");
    const args = suiteProgressArguments(); expect(args.slice(1)).toEqual(["run", "--reporter=json", `--reporter=${fileURLToPath(new URL("./profile-maintenance.ts", import.meta.url))}`]); expect(args.join(" ")).not.toMatch(/maxWorkers|testNamePattern|retry|repeat|bail|timeout/);
    const inherited = { PATH: "synthetic", ...suiteProgressFlags, SURTEC_TEST_PLANNER_PROFILE: "1", SURTEC_TEST_PLANNER_FS_PROFILE: "1", SURTEC_TEST_PLANNER_FAILURE_PROFILE: "1", SURTEC_MAINTENANCE_BROWSER_SMOKE: "1", SURTEC_STATE_DIR: "PRIVATE", OPENAI_API_KEY: "PRIVATE", NODE_OPTIONS: "PRIVATE" };
    expect(suiteProgressEnvironment(inherited)).toEqual({ PATH: "synthetic", NO_COLOR: "1", CI: "1", ...suiteProgressFlags });
    for (const env of [profileEnvironment(inherited), plannerFsEnvironment(inherited), plannerFailureEnvironment(inherited), plannerSpanEnvironment(inherited), fixtureProfileEnvironment("first-planner", "phases", inherited)]) expect(env).not.toHaveProperty("SURTEC_TEST_SUITE_PROGRESS_PROFILE");
    expect(SUITE_PROGRESS_LIMITS).toEqual({ frame_bytes: 2048, frames: 50000, stderr_bytes: 8388608, modules: 256, cases: 20000, open_cases: 64, tail: 32, snapshot_bytes: 131072 }); expect(PROFILE_LIMIT_MS).toBe(900000); expect(PROFILE_CLEANUP_RESERVE_MS).toBe(30000);
  });
  it.each([{}, { SURTEC_TEST_SUITE_PROGRESS_PROFILE: "0" }, { SURTEC_TEST_SUITE_PROGRESS_PROFILE: "1" }, { ...suiteProgressFlags, SURTEC_TEST_PLANNER_PROFILE: "0" }, { ...suiteProgressFlags, SURTEC_TEST_PLANNER_FS_PROFILE: "" }, { ...suiteProgressFlags, SURTEC_TEST_PLANNER_FAILURE_PROFILE: "0" }])("keeps missing or conflicting flags inert before clock, filesystem or native output", (env) => {
    const read = vi.spyOn(fs, "readFileSync"), clock = vi.fn(() => 0), write = vi.fn(), reporter = createSuiteProgressReporter({ env, clock, write }), entry = progressModule(); reporter.onInit(); reporter.onTestRunStart([entry.specification]); reporter.onTestModuleQueued(entry.module); reporter.onTestCaseReady(entry.tests[0]!); reporter.onTestRunEnd([], [], "passed"); expect(clock).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });
  it("exposes only the installed public synchronous lifecycle through its default class without import effects", () => {
    vi.stubEnv("SURTEC_TEST_SUITE_PROGRESS_PROFILE", undefined); const write = vi.spyOn(process.stderr, "write"), syncWrite = vi.spyOn(fs, "writeSync"), read = vi.spyOn(fs, "readFileSync"); try { const reporter = new SuiteProgressReporter(); expect(Object.getOwnPropertyNames(SuiteProgressReporter.prototype).sort()).toEqual(["constructor", "onInit", "onTestRunStart", "onTestModuleQueued", "onTestModuleCollected", "onTestModuleStart", "onTestCaseReady", "onTestCaseResult", "onTestModuleEnd", "onTestRunEnd"].sort()); expect(reporter.onInit()).toBeUndefined(); expect(write).not.toHaveBeenCalled(); expect(syncWrite).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); } finally { vi.unstubAllEnvs(); }
  });
  it("sorts the private selected roster and preserves the documented queued-to-collected wrapper transition once", () => {
    const first = progressModule("scripts/z.test.ts", ["PRIVATE z"]), second = progressModule("lib/a.test.ts", ["PRIVATE a"]), harness = progressHarness([first, second]); harness.start();
    const queued = { ...first.module, children: { *allTests(): Generator<ProgressCase> {} } }; harness.reporter.onTestModuleQueued(queued); harness.reporter.onTestModuleCollected(first.module); harness.reporter.onTestModuleStart(first.module); harness.reporter.onTestCaseReady(first.tests[0]!); harness.reporter.onTestCaseResult(first.tests[0]!); harness.reporter.onTestModuleEnd(first.module);
    harness.reporter.onTestModuleQueued(second.module); harness.reporter.onTestModuleCollected(second.module); harness.reporter.onTestModuleStart(second.module); harness.reporter.onTestCaseReady(second.tests[0]!); harness.reporter.onTestCaseResult(second.tests[0]!); harness.reporter.onTestModuleEnd(second.module); harness.reporter.onTestRunEnd([first.module, second.module], [], "passed");
    expect(harness.snapshot()).toMatchObject({ availability: "available", counts: { collected: 2, ready: 2, finished: 2, passed: 2 }, planner_result: null, modules: [{ ordinal: 1, source: "lib/a.test.ts" }, { ordinal: 2, source: "scripts/z.test.ts" }] }); expect(JSON.stringify(harness.snapshot())).not.toMatch(/PRIVATE|moduleId|project|fullName/);
  });
  it.each(["same-shaped-case", "same-shaped-module", "project", "pool", "specification-path", "replacement-after-collection", "duplicate-case"] as const)("rejects %s without correlating private objects by title or framework id", (fault) => {
    const entry = progressModule(), harness = progressHarness([entry]); harness.start(); harness.reporter.onTestModuleQueued(entry.module);
    if (fault === "project") entry.module.project = {}; else if (fault === "pool") entry.specification.pool = "threads"; else if (fault === "specification-path") entry.specification.moduleId = resolve("scripts/foreign.test.ts");
    if (fault === "duplicate-case") entry.tests.push(entry.tests[0]!); harness.reporter.onTestModuleCollected(entry.module); harness.reporter.onTestModuleStart(entry.module);
    if (fault === "same-shaped-module" || fault === "replacement-after-collection") harness.reporter.onTestModuleStart({ ...entry.module }); else harness.reporter.onTestCaseReady(fault === "same-shaped-case" ? { ...entry.tests[0]! } : entry.tests[0]!);
    expect(harness.snapshot()).toMatchObject({ availability: "unavailable", unavailable_reason: fault === "replacement-after-collection" || fault === "same-shaped-module" || fault === "same-shaped-case" || fault === "duplicate-case" || fault === "project" || fault === "pool" || fault === "specification-path" ? "invalid-binding" : "invalid-sequence" });
  });
  it.each(["../runner/foreign.test.ts", "runner//foreign.test.ts", "runner/./foreign.test.ts", "private/foreign.test.ts", "runner/é.test.ts", 'scripts/quo"te.test.ts', "runner/x.test.ts?query", "runner/x.test.ts#fragment", "C:/private/runner/x.test.ts", "//private/runner/x.test.ts", "runner/x%2f.test.ts"])("refuses an unselected or unsafe public path %s", (source) => {
    const harness = progressHarness(); harness.reporter.onInit(); harness.reporter.onTestRunStart([{ moduleId: source, project: {}, pool: "forks" }]); expect(harness.snapshot()).toMatchObject({ availability: "unavailable", unavailable_reason: "invalid-binding" });
  });
  it("rejects duplicate selected paths across projects rather than merging their counts", () => { const first = progressModule(), second = progressModule(); const harness = progressHarness([first, second]); harness.start(); expect(harness.snapshot()).toMatchObject({ availability: "unavailable", unavailable_reason: "invalid-binding" }); });
  it("does not inspect an already-final batched result during ready and requires public original-attempt counters at result", () => {
    const entry = progressModule(), result = vi.fn(() => ({ state: "passed", errors: ["PRIVATE"] })), diagnostic = vi.fn(() => ({ retryCount: 0, repeatCount: 0, private: "PRIVATE" })); entry.tests[0]!.result = result; entry.tests[0]!.diagnostic = diagnostic;
    const harness = progressHarness([entry]); harness.start(); harness.collect(); expect(harness.reporter.onTestCaseReady(entry.tests[0]!)).toBeUndefined(); expect(result).not.toHaveBeenCalled(); expect(diagnostic).not.toHaveBeenCalled(); harness.reporter.onTestCaseResult(entry.tests[0]!); expect(result).toHaveBeenCalledOnce(); expect(diagnostic).toHaveBeenCalledOnce(); expect(harness.snapshot()?.planner_result).toMatchObject({ state: "passed", original_attempt: "zero" }); expect(JSON.stringify(harness.snapshot())).not.toContain("PRIVATE");
  });
  it.each(["retry", "repeat", "missing", "negative", "NaN", "throw"] as const)("keeps %s public Planner attempt evidence distinct from a passed callback pair", (fault) => {
    const entry = progressModule(), harness = progressHarness([entry]); entry.tests[0]!.diagnostic = () => { if (fault === "throw") throw new Error("PRIVATE DIAGNOSTIC"); return fault === "missing" ? undefined : { retryCount: fault === "retry" ? 1 : fault === "negative" ? -1 : fault === "NaN" ? Number.NaN : 0, repeatCount: fault === "repeat" ? 1 : 0 }; }; harness.start(); harness.collect(); harness.complete(); expect(harness.snapshot()?.planner_result?.original_attempt).toBe(fault === "retry" || fault === "repeat" ? "nonzero" : "unavailable"); expect(JSON.stringify(harness.snapshot())).not.toContain("PRIVATE");
  });
  it("keeps skipped results without ready before module start as delivered negative-path observations", () => {
    const entry = progressModule("scripts/collection-failure.test.ts", ["PRIVATE skipped"]), test = entry.tests[0]!, harness = progressHarness([entry]); test.result = () => ({ state: "skipped" }); entry.setState("failed"); harness.start(); harness.reporter.onTestModuleQueued(entry.module); harness.reporter.onTestCaseResult(test);
    expect(harness.snapshot()).toMatchObject({ availability: "available", counts: { ready: 0, finished: 1, skipped: 1 }, open_cases: [], modules: [{ collected: false, started: false }] }); harness.reporter.onTestModuleStart(entry.module); harness.reporter.onTestModuleEnd(entry.module); harness.reporter.onTestRunEnd([entry.module], [], "failed"); expect(harness.snapshot()?.run_end).toEqual({ reason: "failed", unhandled_errors: 0 });
  });
  it.each(["beforeAll", "aroundAll", "collection"] as const)("retains coherent failed-module facts for a synthetic %s failure", (hook) => {
    const entry = progressModule("scripts/hooks.test.ts", ["PRIVATE skipped"]), harness = progressHarness([entry]); entry.tests[0]!.result = () => ({ state: "skipped" }); entry.setState("failed"); harness.start(); harness.reporter.onTestModuleQueued(entry.module); if (hook !== "collection") harness.reporter.onTestModuleCollected(entry.module); if (hook !== "collection") harness.reporter.onTestModuleStart(entry.module); harness.reporter.onTestCaseResult(entry.tests[0]!); if (hook === "collection") harness.reporter.onTestModuleStart(entry.module); harness.reporter.onTestModuleEnd(entry.module); harness.reporter.onTestRunEnd([entry.module], [], "failed"); expect(harness.snapshot()).toMatchObject({ availability: "available", counts: { ready: 0, finished: 1, skipped: 1, passed: 0 }, run_end: { reason: "failed", unhandled_errors: 0 } });
  });
  it("maintains explicit open sets when finished exceeds ready and interleaved boundaries close independently", () => {
    const entry = progressModule("scripts/interleaved.test.ts", ["PRIVATE open", "PRIVATE skipped", "PRIVATE second"]), harness = progressHarness([entry]); entry.tests[1]!.result = () => ({ state: "skipped" }); harness.start(); harness.collect(); harness.reporter.onTestCaseReady(entry.tests[0]!); harness.reporter.onTestCaseResult(entry.tests[1]!); expect(harness.snapshot()).toMatchObject({ counts: { ready: 1, finished: 1, skipped: 1 }, open_cases: [{ module: 1, case: 1 }] }); harness.reporter.onTestCaseReady(entry.tests[2]!); harness.reporter.onTestCaseResult(entry.tests[0]!); expect(harness.snapshot()?.open_cases).toEqual([{ module: 1, case: 3 }]); harness.reporter.onTestCaseResult(entry.tests[2]!); expect(harness.snapshot()).toMatchObject({ counts: { ready: 2, finished: 3, passed: 2, skipped: 1 }, open_cases: [] });
  });
  it.each(["missing-init", "duplicate-init", "duplicate-ready", "duplicate-result", "passed-without-ready", "late-after-run"] as const)("latches %s instead of fabricating a coherent lifecycle", (fault) => {
    const entry = progressModule(), harness = progressHarness([entry]); if (fault === "missing-init") harness.reporter.onTestRunStart([entry.specification]); else { harness.start(); if (fault === "duplicate-init") harness.reporter.onInit(); harness.collect(); if (fault === "passed-without-ready") harness.reporter.onTestCaseResult(entry.tests[0]!); else if (fault === "late-after-run") { harness.complete(); harness.reporter.onTestCaseReady(entry.tests[0]!); } else { harness.reporter.onTestCaseReady(entry.tests[0]!); if (fault === "duplicate-ready") harness.reporter.onTestCaseReady(entry.tests[0]!); else { harness.reporter.onTestCaseResult(entry.tests[0]!); harness.reporter.onTestCaseResult(entry.tests[0]!); } } } expect(harness.snapshot()).toMatchObject({ availability: "unavailable", unavailable_reason: "invalid-sequence" });
  });
  it.each(["throw", "NaN", "infinity", "negative", "regression", "ceiling"] as const)("records a terminal %s clock fault without substituting zero or reading again", (fault) => {
    let reads = 0; const clock = vi.fn(() => { if (reads++ === 0) return 10; if (fault === "throw") throw new Error("PRIVATE CLOCK"); return fault === "NaN" ? Number.NaN : fault === "infinity" ? Number.POSITIVE_INFINITY : fault === "negative" ? -1 : fault === "regression" ? 9 : PROFILE_LIMIT_MS + 11; }), harness = progressHarness(undefined, clock); harness.start(); const before = clock.mock.calls.length; harness.reporter.onInit(); expect(clock).toHaveBeenCalledTimes(before); expect(harness.snapshot()).toMatchObject({ availability: "unavailable", unavailable_reason: "invalid-clock" }); expect(harness.frames().at(-1)?.reporter_elapsed_ms).toBeNull(); expect(JSON.stringify(harness.snapshot())).not.toContain("PRIVATE");
  });
  it("anchors elapsed delivery time at actual init and never adds listeners, timers or filesystem reads", () => {
    let now = 100; const read = vi.spyOn(fs, "readFileSync"), timer = vi.spyOn(globalThis, "setTimeout"), listener = vi.spyOn(process, "on"), clock = vi.fn(() => now), harness = progressHarness(undefined, clock); expect(clock).not.toHaveBeenCalled(); harness.reporter.onInit(); expect(harness.frames()[0]?.reporter_elapsed_ms).toBe(0); expect(clock).toHaveBeenCalledOnce(); now = 101; harness.reporter.onTestRunStart(harness.selected.map(({ specification }) => specification)); expect(harness.frames()[1]?.reporter_elapsed_ms).toBe(1); expect(read).not.toHaveBeenCalled(); expect(timer).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
  });
  it("does not retry a synchronous native write failure or interpret backpressure as completion", () => {
    const write = vi.fn(() => { throw new Error("PRIVATE PIPE"); }), clock = vi.fn(() => 0), reporter = createSuiteProgressReporter({ env: suiteProgressFlags, write, clock }); expect(reporter.onInit()).toBeUndefined(); reporter.onTestRunStart([progressModule().specification]); expect(write).toHaveBeenCalledOnce(); const harness = completeProgress(); expect(harness.snapshot()?.availability).toBe("available"); expect(harness.lines.every((line) => line.startsWith("SUITE_PROGRESS_PROFILE ") && line.endsWith("\n") && Buffer.byteLength(line) <= 2048)).toBe(true);
  });
});

describe("P10 privacy, framing and bounded projection", () => {
  it("keeps an advancing native clock compatible with the zero init offset", () => { let now = 100; const harness = progressHarness(undefined, () => now++); harness.start(); harness.collect(); harness.complete(); expect(harness.frames()[0]?.reporter_elapsed_ms).toBe(0); expect(harness.snapshot()?.availability).toBe("available"); });
  it("accepts the early replacement on a skipped result without inventing collection or module start", () => {
    const entry = progressModule("scripts/early-failure.test.ts", ["PRIVATE skipped"]), harness = progressHarness([entry]), placeholder = { ...entry.module, children: { *allTests(): Generator<ProgressCase> {} } }; entry.tests[0]!.result = () => ({ state: "skipped" }); entry.setState("failed"); harness.start(); harness.reporter.onTestModuleQueued(placeholder); harness.reporter.onTestCaseResult(entry.tests[0]!); expect(harness.snapshot()).toMatchObject({ availability: "available", counts: { collected: 0, ready: 0, finished: 1, skipped: 1 }, modules: [{ collected: false, started: false }] }); harness.reporter.onTestModuleStart(entry.module); harness.reporter.onTestModuleEnd(entry.module); harness.reporter.onTestRunEnd([entry.module], [], "failed"); expect(harness.snapshot()?.availability).toBe("available");
  });
  it.each(["specification", "module", "children", "case", "result", "diagnostic"] as const)("does not execute getters or Proxy traps at the %s privacy boundary", (boundary) => {
    for (const kind of ["getter", "proxy"] as const) {
      const entry = progressModule(), harness = progressHarness([entry]), hook = vi.fn(() => "PRIVATE GETTER"), proxy = <T extends object>(value: T): T => new Proxy(value, { get: hook, ownKeys: hook, getOwnPropertyDescriptor: () => { hook(); return undefined; }, getPrototypeOf: () => { hook(); return null; } });
      if (boundary === "specification") { harness.reporter.onInit(); if (kind === "getter") Object.defineProperty(entry.specification, "moduleId", { configurable: true, enumerable: true, get: hook }); harness.reporter.onTestRunStart([kind === "proxy" ? proxy(entry.specification) : entry.specification]); }
      else { harness.start(); if (boundary === "module") { if (kind === "getter") Object.defineProperty(entry.module, "moduleId", { configurable: true, enumerable: true, get: hook }); harness.reporter.onTestModuleQueued(kind === "proxy" ? proxy(entry.module) : entry.module); }
        else if (boundary === "children") { harness.reporter.onTestModuleQueued(entry.module); if (kind === "getter") Object.defineProperty(entry.module.children, "allTests", { configurable: true, enumerable: true, get: hook }); else entry.module.children = proxy(entry.module.children); harness.reporter.onTestModuleCollected(entry.module); }
        else if (boundary === "case") { if (kind === "getter") Object.defineProperty(entry.tests[0]!, "module", { configurable: true, enumerable: true, get: hook }); else entry.tests[0] = proxy(entry.tests[0]!); harness.collect(); harness.reporter.onTestCaseReady(entry.tests[0]!); }
        else { harness.collect(); harness.reporter.onTestCaseReady(entry.tests[0]!); const result = { state: "passed" }, diagnostic = { retryCount: 0, repeatCount: 0 }; if (boundary === "result") { if (kind === "getter") Object.defineProperty(result, "state", { configurable: true, enumerable: true, get: hook }); entry.tests[0]!.result = () => kind === "proxy" ? proxy(result) : result; } else { if (kind === "getter") Object.defineProperty(diagnostic, "retryCount", { configurable: true, enumerable: true, get: hook }); entry.tests[0]!.diagnostic = () => kind === "proxy" ? proxy(diagnostic) : diagnostic; } harness.reporter.onTestCaseResult(entry.tests[0]!); }
      }
      expect(hook).not.toHaveBeenCalled(); const snapshot = harness.snapshot(); expect(boundary === "diagnostic" ? snapshot?.planner_result?.original_attempt === "unavailable" : snapshot?.availability === "unavailable").toBe(true); expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
    }
  });
  it("reads no unrelated private framework fields and leaves original payloads mutable", () => {
    const entry = progressModule(), hook = vi.fn(), harness = progressHarness([entry]); for (const object of [entry.module, ...entry.tests]) for (const key of ["id", "fullName", "metadata", "errors", "tags", "task", "toJSON"]) Object.defineProperty(object, key, { configurable: true, enumerable: true, get: hook }); harness.start(); harness.collect(); harness.complete(); expect(hook).not.toHaveBeenCalled(); expect(harness.snapshot()?.availability).toBe("available"); expect(Object.isFrozen(entry.module)).toBe(false); expect(Object.isFrozen(entry.tests[0])).toBe(false); expect(JSON.stringify(harness.snapshot())).not.toMatch(/PRIVATE|"(?:metadata|fullName|task|errors|tags|id)":/);
  });
  it("rejects absent, extra, malformed, accessor and Proxy frame fields without evaluating them", () => {
    const frame = completeProgress().frames().find((row) => row.event === "case-result")!, hook = vi.fn(), accessor = { ...frame }; Object.defineProperty(accessor, "data", { enumerable: true, get: hook });
    const missing = { ...frame } as Partial<SuiteProgressFrame>; delete missing.case;
    for (const value of [missing, { ...frame, private: "PRIVATE" }, { ...frame, sequence: 50001 }, { ...frame, sequence: 0 }, { ...frame, sequence: 1.5 }, { ...frame, reporter_elapsed_ms: Number.NaN }, { ...frame, reporter_elapsed_ms: 900001 }, { ...frame, module: { ...frame.module, ordinal: 257 } }, { ...frame, case: { ordinal: 20001, alias: null } }, { ...frame, case: { ordinal: 1, alias: "PRIVATE" } }, { ...frame, data: { state: "passed", original_attempt: null } }, accessor, new Proxy(frame, { get: hook, ownKeys: hook })]) expect(sanitizeSuiteProgressFrame(value)).toBeNull(); expect(hook).not.toHaveBeenCalled();
    const projection = sanitizeSuiteProgressFrame(frame); expect(projection).toEqual(frame); expect(projection).not.toBe(frame);
  });
  it("reserves finite numeric and maximum-label frame envelopes inside the 2048-byte budget", () => {
    const source = `scripts/${"x".repeat(176)}.test.ts`; expect(source).toHaveLength(192);
    const frame: SuiteProgressFrame = { schema_version: 1, kind: "suite-progress-observation", sequence: 50000, event: "case-result", reporter_elapsed_ms: 899999.9999999999, module: { ordinal: 256, source }, case: { ordinal: 20000, alias: null }, data: { state: "skipped", original_attempt: null } }; expect(sanitizeSuiteProgressFrame(frame)).toEqual(frame);
    const plannerFrame = { ...frame, module: { ordinal: 256, source: "runner/workflow-orchestrator.test.ts" }, case: { ordinal: 20000, alias: "first-implementation-planner" }, data: { state: "skipped", original_attempt: "unavailable" } }; expect(sanitizeSuiteProgressFrame(plannerFrame)).toEqual(plannerFrame); expect(Buffer.byteLength(`SUITE_PROGRESS_PROFILE ${JSON.stringify(plannerFrame)}\n`)).toBeLessThanOrEqual(2048);
    const envelope = `SUITE_PROGRESS_PROFILE ${JSON.stringify(frame, (key, value: unknown) => key === "reporter_elapsed_ms" ? "9".repeat(32) : value)}\n`; expect(Buffer.byteLength(envelope)).toBeLessThanOrEqual(2048);
    for (const [event, data] of [["run-start", { module_count: 256 }], ["module-collected", { case_count: 20000 }], ["run-end", { reason: "interrupted", unhandled_errors: 20000 }], ["observer-unavailable", { reason: "capacity-exhausted" }]] as const) { const candidate = { ...frame, event, module: event === "module-collected" ? frame.module : null, case: null, reporter_elapsed_ms: event === "observer-unavailable" ? null : frame.reporter_elapsed_ms, data }; expect(sanitizeSuiteProgressFrame(candidate)).not.toBeNull(); expect(Buffer.byteLength(`SUITE_PROGRESS_PROFILE ${JSON.stringify(candidate)}\n`)).toBeLessThanOrEqual(2048); }
  });
  it("retains the maximum 256-module, 20000-case, 64-open and 32-tail aggregate within 128 KiB", () => {
    const base = completeProgress().progress, modules = Array.from({ length: 256 }, (_, index) => { const collected = index === 255 ? 110 : 78, ready = index < 64 ? 1 : 0; return { ordinal: index + 1, source: `scripts/${String(index).padStart(3, "0")}${"x".repeat(173)}.test.ts`, queued: true, collected: true, started: true, ended: false, state: null, counts: { collected, ready, finished: collected - ready, passed: 0, failed: 0, skipped: collected - ready } }; });
    const tail: SuiteProgressFrame[] = Array.from({ length: 32 }, (_, index) => ({ schema_version: 1, kind: "suite-progress-observation", sequence: 49969 + index, event: "case-result", reporter_elapsed_ms: 899999.9999999999, module: { ordinal: 256, source: modules[255]!.source }, case: { ordinal: 79 + index, alias: null }, data: { state: "skipped", original_attempt: null } }));
    const snapshot = { ...base, sequence: 50000, reporter_elapsed_ms: 899999.9999999999, module_count: 256, modules, counts: { collected: 20000, ready: 64, finished: 19936, passed: 0, failed: 0, skipped: 19936 }, open_cases: Array.from({ length: 64 }, (_, index) => ({ module: index + 1, case: 1 })), tail, run_end: null, planner_result: null };
    expect(sanitizeSuiteProgressSnapshot(snapshot)).toEqual(snapshot); const report = { ...partialProgressReport(), progress: snapshot, receipt: completedSpanReport().receipt, wall_ms: 899999.9999999999, last_progress_received_ms: 899999.9999999999 }; expect(sanitizeSuiteProgressDiagnostic(report, failureSourceLimits)).not.toBeNull(); expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(131072);
    const numericEnvelope = JSON.stringify(report, (key, value: unknown) => typeof value === "number" && /(?:_ms|elapsed_ms)$/.test(key) ? "9".repeat(32) : value); expect(Buffer.byteLength(numericEnvelope)).toBeLessThanOrEqual(131072);
    // P09's 8192-byte entire-line limit conservatively overbounds its JSON payload.
    const numericReceipt = JSON.stringify(report.receipt, (key, value: unknown) => typeof value === "number" && /(?:_ms|elapsed_ms)$/.test(key) ? "9".repeat(32) : value); expect(Buffer.byteLength(numericEnvelope) - Buffer.byteLength(numericReceipt) + 8192).toBeLessThanOrEqual(131072);
  });
  it.each(["modules", "cases", "open-cases"] as const)("fails observation rather than increasing the %s bound", (bound) => {
    const selected = bound === "modules" ? Array.from({ length: 257 }, (_, index) => progressModule(`scripts/m${index}.test.ts`, [])) : [progressModule("scripts/capacity.test.ts", Array.from({ length: bound === "cases" ? 20001 : 65 }, (_, index) => `PRIVATE ${index}`))], harness = progressHarness(selected); harness.start(); if (bound !== "modules") { harness.collect(); if (bound === "open-cases") for (const test of selected[0]!.tests) harness.reporter.onTestCaseReady(test); } expect(harness.snapshot()).toMatchObject({ availability: "unavailable", unavailable_reason: "capacity-exhausted" }); expect(harness.frames().filter((frame) => frame.event === "observer-unavailable")).toHaveLength(1);
  });
  it("rotates only the last 32 frames while cumulative counters keep increasing", () => { const entry = progressModule("scripts/tail.test.ts", Array.from({ length: 40 }, (_, index) => `PRIVATE ${index}`)), harness = progressHarness([entry]); harness.start(); harness.collect(); harness.complete(); const snapshot = harness.snapshot()!; expect(snapshot.tail).toHaveLength(32); expect(snapshot.counts).toEqual({ collected: 40, ready: 40, finished: 40, passed: 40, failed: 0, skipped: 0 }); expect(snapshot.tail[0]!.sequence).toBe(snapshot.sequence - 31); });
  it("reserves one terminal unavailable frame inside the same 8 MiB writer budget", () => {
    const entry = progressModule(`scripts/${"x".repeat(176)}.test.ts`, []), harness = progressHarness([entry]); for (let index = 0; index < 10000; index++) entry.tests.push({ module: entry.module, name: "PRIVATE", result: () => ({ state: "passed" }), diagnostic: () => undefined }); harness.start(); harness.collect(); for (const test of entry.tests) { harness.reporter.onTestCaseReady(test); harness.reporter.onTestCaseResult(test); }
    const frames = harness.frames(); expect(frames.at(-1)).toMatchObject({ event: "observer-unavailable", data: { reason: "capacity-exhausted" } }); expect(frames.filter((frame) => frame.event === "observer-unavailable")).toHaveLength(1); expect(frames.length).toBeLessThanOrEqual(50000); expect(Buffer.byteLength(harness.lines.join(""))).toBeLessThanOrEqual(8388608); expect(harness.snapshot()?.availability).toBe("unavailable"); const count = harness.lines.length; harness.reporter.onInit(); expect(harness.lines).toHaveLength(count);
  });
  it("collects byte-split UTF-8 and drops unrelated stderr while retaining detached safe observations", () => {
    const harness = completeProgress(), updates: Array<SuiteProgressSnapshot | null> = [], collector = createSuiteProgressCollector((value) => updates.push(value)), bytes = Buffer.from(`PRIVATE é😀 output\n${harness.lines.join("")}`); for (const byte of bytes) collector.push(Buffer.from([byte])); expect(collector.finish()).toEqual(harness.progress); expect(JSON.stringify(updates)).not.toContain("PRIVATE"); const first = JSON.stringify(updates[0]); expect(updates.at(-1)?.sequence).toBeGreaterThan(updates[0]!.sequence); expect(JSON.stringify(updates[0])).toBe(first);
  });
  it.each(["duplicate", "escaped-alias", "escaped-only", "missing-LF", "prefix-LF", "marker-without-space-LF", "truncated", "malformed", "extra", "sequence-gap", "regressive-time", "after-run"] as const)("permanently revokes transport availability after %s and cannot heal on later valid input", (fault) => {
    const harness = completeProgress(), raw = harness.lines[0]!, rest = harness.lines.slice(1).join(""), slash = String.fromCharCode(92), bad = fault === "duplicate" ? raw.replace('"sequence":1', '"sequence":1,"sequence":1') : fault === "escaped-alias" ? raw.replace('"sequence":1', `"se${slash}u0071uence":1,"sequence":1`) : fault === "escaped-only" ? raw.replace('"sequence":1', `"se${slash}u0071uence":1`) : fault === "prefix-LF" ? "SUITE_PROGRESS_\n" : fault === "marker-without-space-LF" ? "SUITE_PROGRESS_PROFILE\n" : fault === "malformed" ? "SUITE_PROGRESS_PROFILE {invalid}\n" : fault === "extra" ? raw.replace('"data":null', '"data":null,"private":"PRIVATE"') : fault === "sequence-gap" ? raw.replace('"sequence":1', '"sequence":2') : fault === "regressive-time" ? harness.lines[1]!.replace('"reporter_elapsed_ms":0', '"reporter_elapsed_ms":-1') : fault === "after-run" ? raw : fault === "missing-LF" ? raw.trimEnd() : "SUITE_PROGRESS_PROFILE {";
    const collector = createSuiteProgressCollector(); if (fault === "after-run") collector.push(harness.lines.join("")); else if (fault === "regressive-time") collector.push(raw); collector.push(bad); collector.finish(); collector.push(raw + rest); const snapshot = collector.finish(); expect(snapshot === null || snapshot.availability === "unavailable").toBe(true); expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
  });
  it("enforces the exact 2048-byte framing ceiling including LF and all 8 MiB stderr bytes", () => {
    const first = completeProgress().lines[0]!.trimEnd(); expect(parseSuiteProgressOutput(`${first.padEnd(2047, " ")}\n`)?.availability).toBe("available"); expect(parseSuiteProgressOutput(`${first.padEnd(2048, " ")}\n`)).toBeNull();
    for (const invalid of [Buffer.from([0xc3, 0x28]), Buffer.from([0xf0, 0x9f]), Buffer.from("é".repeat(1024))]) { const collector = createSuiteProgressCollector(); collector.push("SUITE_PROGRESS_PROFILE "); collector.push(invalid); collector.push("\n"); expect(collector.finish()).toBeNull(); }
    const harness = completeProgress(), collector = createSuiteProgressCollector(); collector.push(harness.lines.join("")); const remaining = 8388608 - Buffer.byteLength(harness.lines.join("")); collector.push("x".repeat(remaining)); expect(collector.snapshot()?.availability).toBe("available"); collector.push("x"); expect(collector.finish()?.availability).toBe("unavailable");
  });
  it("rejects contradictory snapshot counts, bindings, open sets, tail sizes and unknown raw fields", () => {
    const snapshot = completeProgress().progress, hook = vi.fn(), accessor = { ...snapshot }; Object.defineProperty(accessor, "modules", { enumerable: true, get: hook });
    for (const value of [{ ...snapshot, private: "PRIVATE" }, { ...snapshot, counts: { ...snapshot.counts, finished: 3 } }, { ...snapshot, modules: [...snapshot.modules, snapshot.modules[0]] }, { ...snapshot, module_count: 0 }, { ...snapshot, open_cases: [{ module: 1, case: 1 }] }, { ...snapshot, tail: Array.from({ length: 33 }, () => snapshot.tail[0]) }, accessor, new Proxy(snapshot, { get: hook, ownKeys: hook })]) expect(sanitizeSuiteProgressSnapshot(value)).toBeNull(); expect(hook).not.toHaveBeenCalled();
  });
});

describe("P10 independent JSON, IPC and process closure facts", () => {
  it("requires complete unique JSON modules and reconciles assertions without treating nested suites as modules", () => {
    const progress = completeProgress().progress, raw = progressJson(progress), summary = summarizeSuiteProgressJson(raw, progress); expect(summary).toEqual({ passed: true, module_count: 1, passed_tests: 2, failed_tests: 0, skipped_tests: 0, first_planner: { passed: true, test_ms: 1 } }); expect(JSON.stringify(summary)).not.toContain("PRIVATE");
    const value = JSON.parse(raw); for (const testResults of [[], [...value.testResults, value.testResults[0]], [{ ...value.testResults[0], name: resolve("scripts/unknown.test.ts") }], [{ ...value.testResults[0], assertionResults: value.testResults[0].assertionResults.slice(0, 1) }]]) expect(summarizeSuiteProgressJson(JSON.stringify({ ...value, testResults }), progress)).toBeNull();
    expect(summarizeSuiteProgressJson(raw.slice(0, -1), progress)).toBeNull(); expect(summarizeSuiteProgressJson(raw + raw, progress)).toBeNull(); expect(summarizeSuiteProgressJson(raw.replace('"success":true', '"success":true,"success":true'), progress)).toBeNull(); expect(summarizeSuiteProgressJson(raw.padEnd(8388609, " "), progress)).toBeNull();
  });
  it("normalizes pending and todo once each and does not credit a skipped case as passed", () => {
    const entry = progressModule("scripts/skipped-json.test.ts", ["PRIVATE pending", "PRIVATE todo"]), harness = progressHarness([entry]); entry.tests.forEach((test) => { test.result = () => ({ state: "skipped" }); }); harness.start(); harness.collect(); harness.complete(); const progress = harness.snapshot()!, json = JSON.parse(progressJson(progress)); json.testResults[0].assertionResults[0].status = "pending"; json.testResults[0].assertionResults[1].status = "todo"; json.numPendingTests = 1; json.numTodoTests = 1;
    expect(summarizeSuiteProgressJson(JSON.stringify(json), progress)).toMatchObject({ module_count: 1, passed_tests: 0, failed_tests: 0, skipped_tests: 2, first_planner: null }); json.testResults[0].assertionResults[0].status = "passed"; expect(summarizeSuiteProgressJson(JSON.stringify(json), progress)).toBeNull();
  });
  it("reconciles each final assertion ordinal with its observed case state even when swapped totals agree", () => {
    const entry = progressModule("scripts/ordinal-json.test.ts", ["PRIVATE pass", "PRIVATE skip"]), harness = progressHarness([entry]); entry.tests[1]!.result = () => ({ state: "skipped" }); harness.start(); harness.collect(); harness.complete(); const collector = createSuiteProgressCollector(); collector.push(harness.lines.join("")); const progress = collector.finish()!, json = JSON.parse(progressJson(progress)); expect(summarizeSuiteProgressJson(JSON.stringify(json), progress, collector.reconcile)).not.toBeNull(); [json.testResults[0].assertionResults[0].status, json.testResults[0].assertionResults[1].status] = ["pending", "passed"]; expect(summarizeSuiteProgressJson(JSON.stringify(json), progress, collector.reconcile)).toBeNull();
  });
  it("does not hide a failed zero-case module behind passing assertion totals or JSON success", () => {
    const entry = progressModule("scripts/import-failed.test.ts", []), harness = progressHarness([entry]); entry.setState("failed"); harness.start(); harness.collect(); harness.reporter.onTestModuleEnd(entry.module); harness.reporter.onTestRunEnd([entry.module], [], "failed"); const progress = harness.snapshot()!, value = JSON.parse(progressJson(progress)); value.success = false; value.numFailedTestSuites = 1;
    expect(summarizeSuiteProgressJson(JSON.stringify(value), progress)?.passed).toBe(false); value.success = true; value.testResults[0].status = "passed"; expect(summarizeSuiteProgressJson(JSON.stringify(value), progress)).toBeNull();
  });
  it("keeps a passed run-end reason and nonzero unhandled count as independent negative evidence", () => {
    const harness = progressHarness(); harness.start(); harness.collect(); harness.complete("passed", [new Error("PRIVATE UNHANDLED")]); expect(harness.snapshot()).toMatchObject({ availability: "available", run_end: { reason: "passed", unhandled_errors: 1 } }); const completed = completedProgressReport(); expect(sanitizeSuiteProgressDiagnostic({ ...completed, progress: harness.snapshot() }, failureSourceLimits)).toBeNull(); expect(JSON.stringify(harness.snapshot())).not.toContain("PRIVATE");
  });
  it("cannot complete from run end without separately received JSON, P09, zero original Planner, owned exit, close and source checks", () => {
    const completed = completedProgressReport(); expect(sanitizeSuiteProgressDiagnostic(completed, failureSourceLimits)?.status).toBe("completed"); expect(sanitizeSuiteProgressDiagnostic(partialProgressReport(), failureSourceLimits)?.acceptance).toBe(false);
    for (const candidate of [{ ...completed, receipt: null }, { ...completed, json: null }, { ...completed, native_exit: null }, { ...completed, native_exit: { code: 1, signal: null, received_ms: 8 } }, { ...completed, native_exit: { code: null, signal: "SIGTERM", received_ms: 8 } }, { ...completed, stdio_close: null }, { ...completed, stdio_close: { exit_code: 0, closed: false, expired: false, failed: false } }, { ...completed, stdio_close: { exit_code: 1, closed: true, expired: false, failed: false } }, { ...completed, source_hashes_after: {} }, { ...completed, source_drift: true }, { ...completed, cleanup: "unavailable-no-uncertain-fixture-deleted" }, { ...completed, acceptance: true }, { ...completed, progress: { ...completed.progress!, planner_result: { ...completed.progress!.planner_result!, original_attempt: "nonzero" } } }, { ...completed, progress: { ...completed.progress!, run_end: null } }]) expect(sanitizeSuiteProgressDiagnostic(candidate, failureSourceLimits)).toBeNull();
  });
  it("detaches source/DTO data immediately and rejects accessors, proxies, private fields and oversized reports", () => {
    const source = progressSourceEnvelope(), hook = vi.fn(), accessor = { ...source }; Object.defineProperty(accessor, "sourceLimits", { enumerable: true, get: hook }); expect(sanitizeSuiteProgressSourceMetadata(source)).toEqual(source);
    for (const value of [accessor, new Proxy(source, { get: hook, ownKeys: hook }), { ...source, private: "PRIVATE" }, { ...source, fixture_sha256: "b".repeat(64) }, { ...source, sourceLimits: { line_columns: [0] } }, { ...source, source_hashes: { ...source.source_hashes, "private/path": "a".repeat(64) } }, { ...source, source_hashes: { ...source.source_hashes, [SUITE_PROGRESS_SOURCES[11]!]: "b".repeat(64) } }]) expect(sanitizeSuiteProgressSourceMetadata(value)).toBeNull(); expect(hook).not.toHaveBeenCalled();
    const report = partialProgressReport(), reportAccessor = { ...report }; Object.defineProperty(reportAccessor, "progress", { enumerable: true, get: hook }); expect(sanitizeSuiteProgressDiagnostic(reportAccessor, failureSourceLimits)).toBeNull(); expect(sanitizeSuiteProgressDiagnostic(new Proxy(report, { get: hook, ownKeys: hook }), failureSourceLimits)).toBeNull(); expect(hook).not.toHaveBeenCalled(); expect(JSON.stringify(sanitizeSuiteProgressDiagnostic({ ...report, private: "PRIVATE", limitations: ["PRIVATE BODY"] }, failureSourceLimits))).not.toContain("PRIVATE"); expect(sanitizeSuiteProgressDiagnostic({ ...report, progress: { ...report.progress!, modules: Array.from({ length: 257 }, () => report.progress!.modules[0]) } }, failureSourceLimits)).toBeNull();
  });
  it("retains progress received before P09 and a passive exit before close on deadline without outer filesystem work", async () => {
    vi.useFakeTimers(); const start = Date.now(), child = new Child(), foreign = new Child(), harness = completeProgress(), read = vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("Unexpected outer filesystem read"); }); child.send.mockImplementation(() => { child.emit("message", progressSourceEnvelope()); emitProgressFrames(child, harness); child.emit("message", { role: "suite-progress-exit", native_exit: { code: 0, signal: null, received_ms: 0 } }); });
    const pending = runSuiteProgressDiagnosticWatchdog(new ProfileDeadline(() => Date.now() - start), () => child); await vi.advanceTimersByTimeAsync(870000); expect(child.signals).toEqual([]); await vi.advanceTimersByTimeAsync(30000); const report = await pending;
    expect(report).toMatchObject({ status: "deadline", wall_ms: PROFILE_LIMIT_MS, progress: harness.progress, receipt: null, json: null, native_exit: { code: 0, signal: null, received_ms: 0 }, stdio_close: null, source_hashes_after: {}, source_drift: null, cleanup: "unavailable-no-uncertain-fixture-deleted", acceptance: false }); expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]); expect(foreign.signals).toEqual([]); expect(read).not.toHaveBeenCalled(); expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ role: "suite-progress-controller" }));
  });
  it("allows later P09, JSON and exit/close facts after framework run-end without inventing an earlier completion", async () => {
    const child = new Child(), harness = completeProgress(), completed = completedProgressReport(), read = vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("Unexpected outer filesystem read"); }); child.send.mockImplementation(() => { child.emit("message", progressSourceEnvelope()); emitProgressFrames(child, harness); child.emit("message", { role: "suite-progress-receipt", receipt: completed.receipt, received_ms: 2 }); child.emit("message", { role: "suite-progress-exit", native_exit: completed.native_exit }); child.emit("message", { role: "suite-progress-report", report: completed }); child.emit("close", 0); });
    const report = await runSuiteProgressDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(report.status).toBe("completed"); expect(report.progress?.run_end?.reason).toBe("passed"); expect(report.json?.passed).toBe(true); expect(report.native_exit?.code).toBe(0); expect(report.stdio_close?.closed).toBe(true); expect(report.acceptance).toBe(false); expect(child.signals).toEqual([]); expect(read).not.toHaveBeenCalled();
  });
  it.each(["missing", "malformed", "duplicate", "wrong-hash", "before-source", "extra"] as const)("revokes %s source consistency and cannot reinstate a valid final report", async (fault) => {
    const child = new Child(), harness = completeProgress(), completed = completedProgressReport(); child.send.mockImplementation(() => { if (fault === "before-source") emitProgressFrames(child, harness); if (fault !== "missing") child.emit("message", fault === "malformed" ? { ...progressSourceEnvelope(), sourceLimits: { line_columns: [0] } } : fault === "wrong-hash" ? { ...progressSourceEnvelope(), fixture_sha256: "b".repeat(64) } : fault === "extra" ? { ...progressSourceEnvelope(), private: "PRIVATE" } : progressSourceEnvelope()); emitProgressFrames(child, harness); if (fault === "duplicate") child.emit("message", progressSourceEnvelope()); child.emit("message", { role: "suite-progress-report", report: completed }); child.emit("close", 0); }); const report = await runSuiteProgressDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(report.status).toBe("failed"); expect(report.progress === null || report.progress.availability === "unavailable").toBe(true); expect(report.receipt).toBeNull(); expect(report.json).toBeNull(); expect(report.source_drift).toBeNull(); expect(report.cleanup).toBe("unavailable-no-uncertain-fixture-deleted");
  });
  it.each(["replay", "sequence-gap", "receipt-change", "exit-change", "clock-regression", "private-field", "final-before-frame"] as const)("keeps %s IPC contradictions unavailable after a later valid message", async (fault) => {
    const child = new Child(), harness = completeProgress(), completed = completedProgressReport(); child.send.mockImplementation(() => { child.emit("message", progressSourceEnvelope()); emitProgressFrames(child, harness, fault === "clock-regression" ? 1 : 0); if (fault === "receipt-change") { child.emit("message", { role: "suite-progress-receipt", receipt: completed.receipt, received_ms: 2 }); child.emit("message", { role: "suite-progress-receipt", receipt: completeSpanReceipt(), received_ms: 3 }); } else if (fault === "exit-change") { child.emit("message", { role: "suite-progress-exit", native_exit: completed.native_exit }); child.emit("message", { role: "suite-progress-exit", native_exit: { ...completed.native_exit!, code: 1 } }); } else { if (fault === "final-before-frame") child.emit("message", { role: "suite-progress-report", report: completed }); const frame = fault === "clock-regression" ? { ...harness.frames()[0], sequence: harness.progress.sequence + 1, event: "observer-unavailable", module: null, case: null, reporter_elapsed_ms: null, data: { reason: "invalid-clock" } } : fault === "sequence-gap" ? { ...harness.frames()[0], sequence: harness.progress.sequence + 2 } : harness.frames()[0]; child.emit("message", { role: "suite-progress-frame", frame, received_ms: fault === "clock-regression" ? 0 : 2, ...(fault === "private-field" ? { private: "PRIVATE" } : {}) }); } child.emit("message", { role: "suite-progress-report", report: completed }); child.emit("close", 0); });
    const report = await runSuiteProgressDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(report.status).toBe("failed"); expect(report.json).toBeNull(); expect(report.acceptance).toBe(false); expect(report.cleanup).toBe("unavailable-no-uncertain-fixture-deleted");
  });
  it("copies frame and receipt messages immediately rather than following private object mutation", async () => {
    const child = new Child(), harness = completeProgress(), first = JSON.parse(JSON.stringify(harness.frames()[0])) as SuiteProgressFrame, receipt = JSON.parse(JSON.stringify(completedSpanReport().receipt)) as PlannerSpanReceipt, expectedReceipt = JSON.parse(JSON.stringify(receipt)); child.send.mockImplementation(() => { child.emit("message", progressSourceEnvelope()); child.emit("message", { role: "suite-progress-frame", frame: first, received_ms: 1 }); first.sequence = 999; child.emit("message", { role: "suite-progress-receipt", receipt, received_ms: 2 }); receipt.span_cursor.observation_elapsed_ms = 999; child.emit("close", 1); }); const report = await runSuiteProgressDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(report.progress?.sequence).toBe(1); expect(report.receipt).toEqual(expectedReceipt); expect(report.json).toBeNull(); expect(report.source_hashes_after).toEqual({});
  });
  it("bounds failed, stalled and failed-send controllers to the issued handle and original shared ceiling", async () => {
    vi.useFakeTimers(); const child = new Child(), foreign = new Child(); child.send.mockImplementation(() => { throw new Error("PRIVATE IPC BODY"); }); const pending = runSuiteProgressDiagnosticWatchdog(new ProfileDeadline(() => 0), () => child); await vi.advanceTimersByTimeAsync(2000); const report = await pending; expect(report.status).toBe("failed"); expect(report.progress).toBeNull(); expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]); expect(foreign.signals).toEqual([]); expect(JSON.stringify(report)).not.toContain("PRIVATE"); const launch = vi.fn(() => new Child()); expect((await runSuiteProgressDiagnosticWatchdog(new ProfileDeadline(() => PROFILE_LIMIT_MS), launch)).status).toBe("deadline"); expect(launch).not.toHaveBeenCalled();
  });
});

describe("P10 real isolated TS reporter loader", () => {
  it("loads a byte-identical copied default reporter with private stdout JSON and stderr progress only", async () => {
    const owned = createOwnedProfileRoot(), started = performance.now(), deadline = new ProfileDeadline(() => PROFILE_LIMIT_MS - PROFILE_CLEANUP_RESERVE_MS - 3500 + performance.now() - started);
    let exitObserved = false, closeObserved = false, stdoutBytes = 0, stderrBytes = 0, overflow = false, child: ReturnType<typeof spawn> | undefined;
    const stdout: Buffer[] = [], stderr: Buffer[] = [], abort = new AbortController(), profilerSource = fileURLToPath(new URL("./profile-maintenance.ts", import.meta.url)), cli = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
    try {
      expect(dirname(owned.path)).toBe(resolve(tmpdir())); expect(lstatSync(owned.path).isSymbolicLink()).toBe(false); writeFileSync(join(owned.path, ".profile-owner"), owned.token);
      const scripts = join(owned.path, "scripts"), copiedProfiler = join(scripts, "profile-maintenance.ts"), fixture = join(scripts, "p10-loader.test.ts"), config = join(owned.path, "fixture.mjs"); fs.mkdirSync(scripts); fs.copyFileSync(profilerSource, copiedProfiler); expect(readFileSync(copiedProfiler)).toEqual(readFileSync(profilerSource));
      writeFileSync(fixture, [
        'describe("fictional P10 loader", () => {',
        '  it("passes one small asynchronous case", async () => { await Promise.resolve(); expect(1).toBe(1); });',
        '  it.skip("keeps one explicit skipped case", () => {});',
        '  describe("beforeAll failure", () => { beforeAll(() => { throw new Error("fictional beforeAll failure"); }); it("is skipped by beforeAll", () => {}); });',
        '  describe("aroundAll failure", () => { aroundAll(() => { throw new Error("fictional aroundAll failure"); }); it("is skipped by aroundAll", () => {}); });',
        '});',
      ].join("\n"));
      writeFileSync(config, `export default ${JSON.stringify({ root: owned.path, cacheDir: join(owned.path, ".vite-cache"), test: { root: owned.path, include: ["scripts/p10-loader.test.ts"], globals: true, environment: "node", setupFiles: [], watch: false } })};\n`);
      expect(resolve(cli)).toBe(cli); expect(existsSync(cli)).toBe(true); expect(existsSync(join(owned.path, "node_modules"))).toBe(false); expect(deadline.mayLaunch()).toBe(true);
      child = spawn(process.execPath, [cli, "run", `--config=${config}`, "--reporter=json", `--reporter=${copiedProfiler}`], { cwd: owned.path, env: suiteProgressEnvironment(process.env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      child.once("exit", () => { exitObserved = true; }); child.once("close", () => { closeObserved = true; });
      child.stdout!.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; if (stdoutBytes > 8388608) { overflow = true; abort.abort(); } else if (!overflow) stdout.push(Buffer.from(chunk)); });
      child.stderr!.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 8388608) { overflow = true; abort.abort(); } else if (!overflow) stderr.push(Buffer.from(chunk)); });
      const result = await superviseChild(child, deadline, 250, abort.signal), output = Buffer.concat(stdout).toString("utf8"), errors = Buffer.concat(stderr), progress = parseSuiteProgressOutput(errors);
      expect(result).toEqual({ exit_code: 1, closed: true, expired: false, failed: false }); expect(exitObserved).toBe(true); expect(closeObserved).toBe(true); expect(overflow).toBe(false); expect(performance.now() - started).toBeLessThan(4500);
      expect(progress).toMatchObject({ availability: "available", module_count: 1, counts: { collected: 4, finished: 4, passed: 1, failed: 0, skipped: 3 }, modules: [{ source: "scripts/p10-loader.test.ts", ended: true, state: "failed" }], planner_result: null, run_end: { reason: "failed", unhandled_errors: 0 } });
      expect(output).not.toContain("SUITE_PROGRESS_PROFILE "); expect(output).not.toContain('"workload":"full-suite-progress"'); expect(errors.toString("utf8")).toContain("SUITE_PROGRESS_PROFILE "); expect(parsePlannerSpanOutput(output)).toBeNull(); expect(progress?.tail.some((frame) => frame.event === "run-end")).toBe(true);
      const json = JSON.parse(output) as { success: boolean; testResults: Array<{ name: string; assertionResults: unknown[] }> }; expect(json.success).toBe(false); expect(json.testResults).toHaveLength(1); expect(json.testResults[0]?.name.replaceAll("\\", "/")).toBe(fixture.replaceAll("\\", "/")); expect(json.testResults[0]?.assertionResults).toHaveLength(4);
      // The copied reporter and the original parser intentionally have different roots.
      const publicLabelJson = { ...json, testResults: json.testResults.map((module) => ({ ...module, name: "scripts/p10-loader.test.ts" })) }; expect(summarizeSuiteProgressJson(JSON.stringify(publicLabelJson), progress!)?.passed).toBe(false);
      expect(existsSync(join(owned.path, "node_modules"))).toBe(false);
    } finally {
      const safeToRemove = child === undefined || exitObserved && closeObserved;
      if (!safeToRemove || !cleanupOwnedRoot(owned, safeToRemove, deadline)) throw new Error("Owned P10 loader fixture retained because issued exit/close or cleanup could not be verified.");
    }
    expect(existsSync(owned.path)).toBe(false);
  });
});

describe("P10 independently reviewed contract pins", () => {
  it("matches all five fixed paths and hashes without deriving expected evidence from the implementation", () => {
    // These literals independently preserve the reviewed installed-contract evidence.
    const reviewed = [
      ["node_modules/vitest/dist/chunks/reporters.d.DtoKVV2s.d.ts", "7FA6FDC6EEEB3850E6B3166836F8C9199594C4F4BED3CEE02CAC0CA33D71894D"],
      ["node_modules/vitest/dist/chunks/cli-api.CnMVyzaz.js", "A236001D048380E2C67D05423FC9EA3F26B07EE019BA8D6E622082F29D49102E"],
      ["node_modules/vitest/dist/chunks/index.UpGiHP7g.js", "CDAFAF8E508042DDDBA72F8C7BBAE84E2836DDB6B06C7026520C35D91AF4E798"],
      ["node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js", "E509F3CC1BD81AE6426265253FA926CBDE02BE5CEBFE35B1DF422017BFFDCA31"],
      ["node_modules/.pnpm/@vitest+runner@4.1.11/node_modules/@vitest/runner/dist/chunk-artifact.js", "BF6AF6D2F4469911879A67E83B8F9E7B20332CF42795032C53457B10CCC1C617"],
    ] as const;
    expect(SUITE_PROGRESS_SOURCES.slice(11)).toEqual(reviewed.map(([source]) => source));
    expect(SUITE_PROGRESS_CONTRACT_HASHES).toEqual(reviewed.map(([, hash]) => hash.toLowerCase()));
    const source = progressSourceEnvelope();
    for (const [path, hash] of reviewed) {
      expect(hash).toMatch(/^[A-F0-9]{64}$/);
      source.source_hashes[path] = hash.toLowerCase();
    }
    expect(sanitizeSuiteProgressSourceMetadata(source)).toEqual(source);
    for (const [path] of reviewed) {
      expect(sanitizeSuiteProgressSourceMetadata({ ...source, source_hashes: { ...source.source_hashes, [path]: "b".repeat(64) } })).toBeNull();
    }
  });
});

// P11 Axis B synthetic delivery windows; no worker, timer, filesystem or campaign is launched.
function attributionCostHarness(moduleCount: number) {
  const costs = createSuiteAttributionCosts(); let sequence = 0;
  const source = (ordinal: number) => `scripts/cost-${String(ordinal).padStart(3, "0")}.test.ts`;
  const push = (event: SuiteProgressFrame["event"], elapsed = 0, ordinal: number | null = null, data: unknown = null, test: SuiteProgressFrame["case"] = null, path?: string) => costs.accept({ schema_version: 1, kind: "suite-progress-observation", sequence: ++sequence, event, reporter_elapsed_ms: event === "observer-unavailable" ? null : elapsed, module: ordinal === null ? null : { ordinal, source: path ?? source(ordinal) }, case: test, data } as SuiteProgressFrame);
  expect(push("reporter-init")).toBe(true); expect(push("run-start", 0, null, { module_count: moduleCount })).toBe(true);
  return { costs, push, source };
}
function attributionEndedCosts(windows: Array<{ start: number; end: number; state?: "passed" | "failed" | "skipped" }>): SuiteAttributionCosts {
  const harness = attributionCostHarness(windows.length);
  windows.forEach((_, index) => { expect(harness.push("module-collected", 0, index + 1, { case_count: 0 })).toBe(true); });
  const boundaries = windows.flatMap((window, index) => [{ time: window.start, event: "module-start" as const, ordinal: index + 1, state: window.state ?? "passed" }, { time: window.end, event: "module-end" as const, ordinal: index + 1, state: window.state ?? "passed" }]).sort((a, b) => a.time - b.time || (a.event === b.event ? a.ordinal - b.ordinal : a.event === "module-start" ? -1 : 1));
  for (const row of boundaries) expect(harness.push(row.event, row.time, row.ordinal, row.event === "module-end" ? { state: row.state } : null)).toBe(true);
  return harness.costs.snapshot()!;
}
describe("P11 bounded prospective suite delivery costs", () => {
  it("is inert before an actual frame and adds no reads, clocks, listeners or timers", () => {
    const read = vi.spyOn(fs, "readFileSync"), clock = vi.spyOn(performance, "now"), listener = vi.spyOn(process, "on"), timer = vi.spyOn(globalThis, "setTimeout"), write = vi.spyOn(process.stderr, "write");
    const costs = createSuiteAttributionCosts(); expect(costs.snapshot()).toBeNull(); costs.revoke(); expect(costs.snapshot()).toBeNull();
    for (const probe of [read, clock, listener, timer, write]) expect(probe).not.toHaveBeenCalled();
  });
  it("keeps an observed empty run distinct from a missing observation", () => {
    const harness = attributionCostHarness(0), sample = harness.costs.snapshot();
    expect(sample).toMatchObject({ availability: "available", sequence: 2, reporter_elapsed_ms: 0, module_count: 0, observed_modules: 0, without_start_modules: 0, ended: { eligible_count: 0, retained_count: 0, omitted_count: 0, sum_ms: 0, union_ms: 0, top: [] }, start_without_end: { eligible_count: 0, retained_count: 0, omitted_count: 0, top: [] } });
    expect(sanitizeSuiteAttributionCosts(sample)).toEqual(sample);
  });
  it.each([
    { label: "disjoint", windows: [{ start: 1, end: 3 }, { start: 5, end: 9 }], sum: 6, union: 6 },
    { label: "overlapping", windows: [{ start: 1, end: 6 }, { start: 4, end: 9 }], sum: 10, union: 8 },
    { label: "nested", windows: [{ start: 1, end: 9 }, { start: 3, end: 5 }], sum: 10, union: 8 },
    { label: "touching", windows: [{ start: 1, end: 4 }, { start: 4, end: 9 }], sum: 8, union: 8 },
    { label: "zero", windows: [{ start: 1, end: 1 }, { start: 3, end: 3 }], sum: 0, union: 0 },
    { label: "identical", windows: [{ start: 1, end: 9 }, { start: 1, end: 9 }], sum: 16, union: 8 },
  ])("computes canonical $label received intervals without dividing by workers", ({ windows, sum, union }) => {
    const sample = attributionEndedCosts(windows);
    expect(sample.ended).toMatchObject({ eligible_count: 2, retained_count: 2, omitted_count: 0, sum_ms: sum, union_ms: union });
    expect(sample.start_without_end?.eligible_count).toBe(0); expect(sanitizeSuiteAttributionCosts(sample)).toEqual(sample);
  });
  it("sums in ordinal order and unions in chronological start/end/ordinal order", () => {
    const windows = [{ start: 9, end: 9.1 }, { start: 1, end: 1.2 }, { start: 3, end: 3.3 }], sample = attributionEndedCosts(windows);
    expect(sample.ended?.sum_ms).toBe(windows.reduce((sum, row) => sum + (row.end - row.start), 0));
    expect(sample.ended?.union_ms).toBe([...windows].sort((a, b) => a.start - b.start).reduce((sum, row) => sum + (row.end - row.start), 0));
  });
  it("retains passed, failed, skipped and zero-case/zero-duration module delivery windows", () => {
    const sample = attributionEndedCosts([{ start: 1, end: 3, state: "failed" }, { start: 1, end: 1, state: "skipped" }, { start: 1, end: 2 }]);
    expect(sample.ended?.top.map((row) => [row.ordinal, row.state, row.elapsed_ms])).toEqual([[1, "failed", 2], [3, "passed", 1], [2, "skipped", 0]]);
  });
  it("preserves failed-module evidence with an early skipped case and no collection fact", () => {
    const harness = attributionCostHarness(1);
    expect(harness.push("module-queued", 1, 1)).toBe(true); expect(harness.push("case-result", 2, 1, { state: "skipped", original_attempt: null }, { ordinal: 1, alias: null })).toBe(true); expect(harness.push("module-start", 5, 1)).toBe(true); expect(harness.push("module-end", 10, 1, { state: "failed" })).toBe(true);
    expect(harness.costs.snapshot()?.ended).toMatchObject({ eligible_count: 1, sum_ms: 5, union_ms: 5, top: [{ state: "failed", start_ms: 5, end_ms: 10 }] });
  });
  it("distinguishes unstarted queued/collected observations from a started module without end", () => {
    const harness = attributionCostHarness(4);
    expect(harness.push("module-queued", 1, 1)).toBe(true); expect(harness.push("module-collected", 2, 2, { case_count: 0 })).toBe(true); expect(harness.push("module-start", 3, 3)).toBe(true); expect(harness.push("run-end", 20, null, { reason: "interrupted", unhandled_errors: 0 })).toBe(true);
    expect(harness.costs.snapshot()).toMatchObject({ module_count: 4, observed_modules: 3, without_start_modules: 2, reporter_elapsed_ms: 20, ended: { eligible_count: 0, sum_ms: 0, union_ms: 0 }, start_without_end: { eligible_count: 1, retained_count: 1, omitted_count: 0, top: [{ ordinal: 3, start_ms: 3, horizon_ms: 20, elapsed_ms: 17 }] } });
  });
  it("retains the last reporter horizon and never invents an end from snapshot or revocation", () => {
    const harness = attributionCostHarness(1); expect(harness.push("module-start", 7, 1)).toBe(true); const first = harness.costs.snapshot();
    expect(first?.start_without_end?.top[0]).toMatchObject({ start_ms: 7, horizon_ms: 7, elapsed_ms: 0 }); expect(harness.costs.snapshot()).toEqual(first); harness.costs.revoke();
    expect(harness.costs.snapshot()).toMatchObject({ availability: "unavailable", unavailable_reason: "invalid-transport", reporter_elapsed_ms: 7, ended: null, start_without_end: null }); expect(first?.availability).toBe("available");
  });
  it("ranks ended top sixteen by descending interval with explicit omitted counts", () => {
    const sample = attributionEndedCosts(Array.from({ length: 20 }, (_, index) => ({ start: 0, end: index + 1 })));
    expect(sample.ended).toMatchObject({ eligible_count: 20, retained_count: 16, omitted_count: 4, sum_ms: 210, union_ms: 20 }); expect(sample.ended?.top.map((row) => row.ordinal)).toEqual(Array.from({ length: 16 }, (_, index) => 20 - index));
  });
  it("resolves top-sixteen zero-width ties by ordinal rather than callback delivery order", () => {
    const sample = attributionEndedCosts(Array.from({ length: 20 }, () => ({ start: 1, end: 1 })));
    expect(sample.ended?.top.map((row) => row.ordinal)).toEqual(Array.from({ length: 16 }, (_, index) => index + 1)); expect(sample.ended).toMatchObject({ omitted_count: 4, sum_ms: 0, union_ms: 0 });
  });
  it("ranks only four open module observations to the reporter horizon with explicit omissions", () => {
    const harness = attributionCostHarness(7); for (let ordinal = 1; ordinal <= 7; ordinal++) expect(harness.push("module-start", ordinal, ordinal)).toBe(true); expect(harness.push("run-end", 100, null, { reason: "interrupted", unhandled_errors: 0 })).toBe(true);
    const open = harness.costs.snapshot()?.start_without_end; expect(open).toMatchObject({ eligible_count: 7, retained_count: 4, omitted_count: 3 }); expect(open?.top.map((row) => [row.ordinal, row.horizon_ms, row.elapsed_ms])).toEqual([[1, 100, 99], [2, 100, 98], [3, 100, 97], [4, 100, 96]]);
  });
  it("keeps four equal open-interval ties in ordinal order", () => {
    const harness = attributionCostHarness(6); for (const ordinal of [6, 4, 2, 5, 3, 1]) expect(harness.push("module-start", 4, ordinal)).toBe(true);
    expect(harness.costs.snapshot()?.start_without_end?.top.map((row) => row.ordinal)).toEqual([1, 2, 3, 4]); expect(harness.costs.snapshot()?.start_without_end?.omitted_count).toBe(2);
  });
  it("supports all 256 windows and the separate 230400000 ms overlapping-sum bound", () => {
    const sample = attributionEndedCosts(Array.from({ length: 256 }, () => ({ start: 0, end: 900000 })));
    expect(sample.ended).toMatchObject({ eligible_count: 256, retained_count: 16, omitted_count: 240, sum_ms: 230400000, union_ms: 900000 }); expect(sanitizeSuiteAttributionCosts(sample)).toEqual(sample); expect(Buffer.byteLength(JSON.stringify(sample))).toBeLessThan(131072);
  });
  it("detaches accepted frames and each exported snapshot without freezing caller data", () => {
    const harness = attributionCostHarness(1), frame: SuiteProgressFrame = { schema_version: 1, kind: "suite-progress-observation", sequence: 3, event: "module-start", reporter_elapsed_ms: 1, module: { ordinal: 1, source: harness.source(1) }, case: null, data: null };
    expect(harness.costs.accept(frame)).toBe(true); frame.module!.source = "scripts/private-mutated.test.ts"; const first = harness.costs.snapshot()!; first.start_without_end!.top[0]!.source = "scripts/export-mutated.test.ts"; first.start_without_end!.top.length = 0;
    expect(harness.costs.snapshot()?.start_without_end?.top).toEqual([{ ordinal: 1, source: harness.source(1), start_ms: 1, horizon_ms: 1, elapsed_ms: 0 }]); expect(Object.isFrozen(frame)).toBe(false);
  });
  it.each(["replay", "clock-regression", "end-without-start", "source-replacement", "ordinal-roster-order", "capacity"] as const)("permanently rejects %s and never heals with a later valid delta", (fault) => {
    const harness = attributionCostHarness(2); expect(harness.push("module-start", 10, 1)).toBe(true);
    let accepted: boolean;
    if (fault === "replay") accepted = harness.costs.accept({ schema_version: 1, kind: "suite-progress-observation", sequence: 3, event: "module-start", reporter_elapsed_ms: 10, module: { ordinal: 1, source: harness.source(1) }, case: null, data: null });
    else if (fault === "clock-regression") accepted = harness.push("module-start", 9, 2);
    else if (fault === "end-without-start") accepted = harness.push("module-end", 11, 2, { state: "failed" });
    else if (fault === "source-replacement") accepted = harness.push("module-end", 11, 1, { state: "failed" }, null, "scripts/replaced.test.ts");
    else if (fault === "ordinal-roster-order") accepted = harness.push("module-start", 11, 2, null, null, "scripts/aaa.test.ts");
    else accepted = harness.push("module-start", 11, 257);
    expect(accepted).toBe(false); expect(harness.push("module-start", 12, 2)).toBe(false); const sample = harness.costs.snapshot(); expect(sample === null || sample.availability === "unavailable").toBe(true); if (sample) expect(sample.ended).toBeNull();
  });
  it("retains a fixed upstream observer failure reason and does not export stale costs", () => {
    const harness = attributionCostHarness(1); expect(harness.push("module-start", 3, 1)).toBe(true); expect(harness.push("observer-unavailable", 0, null, { reason: "invalid-clock" })).toBe(true);
    expect(harness.costs.snapshot()).toMatchObject({ availability: "unavailable", unavailable_reason: "invalid-clock", sequence: 4, reporter_elapsed_ms: 3, ended: null, start_without_end: null }); expect(harness.push("module-end", 10, 1, { state: "passed" })).toBe(false);
  });
  it.each(["extra", "missing", "count", "omissions", "ranking", "time", "sum", "union", "state", "source", "horizon", "open-count", "availability"] as const)("closes a contradictory %s exported sample", (fault) => {
    const sample = attributionEndedCosts([{ start: 0, end: 5 }, { start: 0, end: 3 }]), value = JSON.parse(JSON.stringify(sample)) as SuiteAttributionCosts & Record<string, unknown>;
    if (fault === "extra") value.private = "PRIVATE"; else if (fault === "missing") delete (value as Partial<SuiteAttributionCosts>).sequence;
    else if (fault === "count") value.observed_modules = 1; else if (fault === "omissions") value.ended!.omitted_count = 1; else if (fault === "ranking") value.ended!.top.reverse(); else if (fault === "time") value.ended!.top[0]!.elapsed_ms = 4; else if (fault === "sum") value.ended!.sum_ms = 9; else if (fault === "union") value.ended!.union_ms = 4; else if (fault === "state") (value.ended!.top[0]! as { state: string }).state = "PRIVATE"; else if (fault === "source") value.ended!.top[0]!.source = "../PRIVATE.test.ts"; else if (fault === "horizon") value.reporter_elapsed_ms = 4; else if (fault === "open-count") value.start_without_end!.eligible_count = 1; else value.availability = "unavailable";
    expect(sanitizeSuiteAttributionCosts(value)).toBeNull();
  });
  it("refuses accessors, Proxies and custom array properties without invoking private hooks", () => {
    const sample = attributionEndedCosts([{ start: 0, end: 5 }]), hook = vi.fn(() => "PRIVATE"), accessor = { ...sample }; Object.defineProperty(accessor, "ended", { enumerable: true, get: hook });
    expect(sanitizeSuiteAttributionCosts(accessor)).toBeNull(); expect(sanitizeSuiteAttributionCosts(new Proxy(sample, { ownKeys: () => { hook(); return []; } }))).toBeNull();
    const nested = JSON.parse(JSON.stringify(sample)) as SuiteAttributionCosts; Object.defineProperty(nested.ended!.top[0]!, "start_ms", { enumerable: true, get: hook }); expect(sanitizeSuiteAttributionCosts(nested)).toBeNull();
    const array = JSON.parse(JSON.stringify(sample)) as SuiteAttributionCosts; Object.defineProperty(array.ended!.top, "private", { value: "PRIVATE", enumerable: true }); expect(sanitizeSuiteAttributionCosts(array)).toBeNull(); expect(hook).not.toHaveBeenCalled();
  });
  it("rejects malformed unavailability and never accepts unknown fields in its null-measurement form", () => {
    const harness = attributionCostHarness(1); harness.costs.revoke(); const sample = harness.costs.snapshot()!;
    expect(sanitizeSuiteAttributionCosts(sample)).toEqual(sample); expect(sanitizeSuiteAttributionCosts({ ...sample, unavailable_reason: null })).toBeNull(); expect(sanitizeSuiteAttributionCosts({ ...sample, ended: { eligible_count: 0 } })).toBeNull(); expect(sanitizeSuiteAttributionCosts({ ...sample, private: "PRIVATE" })).toBeNull();
  });
  it("detaches a maximum-width label sample without copying hidden input properties", () => {
    const harness = attributionCostHarness(1), source = `scripts/${"a".repeat(192 - "scripts/".length - ".test.ts".length)}.test.ts`;
    expect(Buffer.byteLength(source)).toBe(192); expect(harness.push("module-start", 0, 1, null, null, source)).toBe(true); expect(harness.push("module-end", 900000, 1, { state: "failed" }, null, source)).toBe(true);
    const sample = harness.costs.snapshot()!, safe = sanitizeSuiteAttributionCosts(sample)!; expect(safe).toEqual(sample); expect(safe).not.toBe(sample); expect(safe.ended!.top[0]).not.toBe(sample.ended!.top[0]); expect(safe.ended!.top[0]!.source).toBe(source);
  });
});

import { createPlannerWaitCapture, createPlannerWaitMarkerCollector, parsePlannerWaitOutput, sanitizePlannerWaitReceipt, type PlannerWaitReceipt } from "./profile-maintenance";
import { compactSuiteProgress, runSuiteAttributionDiagnosticWatchdog, sanitizeSuiteAttributionDiagnostic, sanitizeSuiteAttributionSourceMetadata, SUITE_ATTRIBUTION_CONTRACT_HASHES, SUITE_ATTRIBUTION_LIMITATIONS, SUITE_ATTRIBUTION_SOURCES, suiteAttributionArguments, suiteAttributionEnvironment, type SuiteAttributionDiagnosticReport } from "./profile-maintenance";

const p11Flags = { SURTEC_TEST_PLANNER_WAIT_PROFILE: "1", ...suiteProgressFlags };
function waitHarness(clock: () => number = () => 0, context = failureContext()) {
  const lines: string[] = [], capture = createPlannerWaitCapture({ env: p11Flags, clock, write: (line) => { lines.push(line); } });
  capture.prepare(context); const observer = capture.beginCallback(); if (!observer) throw new Error("Synthetic selected wait binding unavailable");
  const fixture = { taskId: "PRIVATE-TASK", root: "PRIVATE-ROOT", executor: {}, worker: {} }, options = { runId: "PRIVATE-RUN", signal: {}, proof: {} };
  observer.bindFixture(fixture);
  return { capture, context, observer, fixture, options, lines, receipt(): PlannerWaitReceipt { capture.capture(context); const value = parsePlannerWaitOutput(lines[0] ?? ""); if (!value) throw new Error("Synthetic wait envelope unavailable"); return value; } };
}
async function completeWaitReceipt() {
  let now = 0; const harness = waitHarness(() => now++), original = Promise.resolve("PRIVATE RESULT");
  expect(harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => { harness.observer.checkpoint("executor-enter"); harness.observer.checkpoint("executor-body-return"); return original; })).toBe(original);
  await Promise.resolve(); harness.observer.checkpoint("wait-enter"); harness.observer.beginRead().returned("finished"); harness.observer.checkpoint("wait-return"); const receipt = harness.receipt(); if (receipt.capture_status !== "captured") throw new Error("Synthetic complete wait unavailable"); return receipt;
}

describe("P11 private Planner wait capture", () => {
  it("keeps the original invocation, environment allowlist, workers and deadline unchanged", () => {
    expect(parseProfileArguments(["--workload=full-suite-attribution"])).toBe("full-suite-attribution"); expect(PROFILE_WORKLOADS).not.toContain("full-suite-attribution"); expect(suiteAttributionArguments()).toEqual(suiteProgressArguments());
    expect(suiteAttributionEnvironment({ PATH: "synthetic", ...p11Flags, SURTEC_TEST_PLANNER_PROFILE: "0", SURTEC_TEST_PLANNER_FS_PROFILE: "", SURTEC_TEST_PLANNER_FAILURE_PROFILE: "1", SURTEC_STATE_DIR: "PRIVATE", OPENAI_API_KEY: "PRIVATE", NODE_OPTIONS: "PRIVATE" })).toEqual({ PATH: "synthetic", CI: "1", NO_COLOR: "1", ...p11Flags });
    for (const env of [profileEnvironment(p11Flags), plannerFsEnvironment(p11Flags), plannerFailureEnvironment(p11Flags), plannerSpanEnvironment(p11Flags), suiteProgressEnvironment(p11Flags), fixtureProfileEnvironment("first-planner", "phases", p11Flags)]) expect(env).not.toHaveProperty("SURTEC_TEST_PLANNER_WAIT_PROFILE");
    expect(PROFILE_LIMIT_MS).toBe(900000); expect(PROFILE_CLEANUP_RESERVE_MS).toBe(30000); expect(suiteAttributionArguments().join(" ")).not.toMatch(/maxWorkers|testNamePattern|retry|repeat|bail|timeout/);
  });
  it.each([{}, { ...p11Flags, SURTEC_TEST_PLANNER_WAIT_PROFILE: "0" }, { ...p11Flags, SURTEC_TEST_SUITE_PROGRESS_PROFILE: "0" }, { ...p11Flags, SURTEC_TEST_PLANNER_SPAN_PROFILE: "0" }, ...["SURTEC_TEST_PLANNER_PROFILE", "SURTEC_TEST_PLANNER_FS_PROFILE", "SURTEC_TEST_PLANNER_FAILURE_PROFILE"].flatMap((flag) => ["", "0", "1"].map((value) => ({ ...p11Flags, [flag]: value })))])("does not clock, read source, create timers/listeners or write for inactive flags", (env) => {
    const read = vi.spyOn(fs, "readFileSync"), timer = vi.spyOn(globalThis, "setTimeout"), listener = vi.spyOn(process, "on"), clock = vi.fn(() => 0), write = vi.fn(), capture = createPlannerWaitCapture({ env, clock, write }); capture.prepare(failureContext()); expect(capture.beginCallback()).toBeUndefined(); capture.capture(failureContext());
    expect(read).not.toHaveBeenCalled(); expect(timer).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
  it.each(["getter", "proxy"] as const)("does not invoke an environment %s before deciding eligibility", (kind) => {
    const hook = vi.fn(), plain = { ...p11Flags }, env = kind === "proxy" ? new Proxy(plain, { get: hook, ownKeys: hook, getOwnPropertyDescriptor: hook, getPrototypeOf: hook }) : Object.defineProperty(plain, "SURTEC_TEST_PLANNER_WAIT_PROFILE", { enumerable: true, get: hook }), clock = vi.fn(() => 0), write = vi.fn(), capture = createPlannerWaitCapture({ env, clock, write }); capture.prepare(failureContext()); capture.beginCallback(); capture.capture(failureContext()); expect(hook).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
  it("starts once at actual callback entry and has no implicit domain read, timer or listener", () => {
    const clock = vi.fn(() => 17), write = vi.fn(), capture = createPlannerWaitCapture({ env: p11Flags, clock, write }), context = failureContext(), read = vi.spyOn(fs, "readFileSync"), timer = vi.spyOn(globalThis, "setTimeout"), listener = vi.spyOn(process, "on"); capture.prepare(context); expect(clock).not.toHaveBeenCalled(); expect(capture.beginCallback()).toBeDefined(); expect(clock).toHaveBeenCalledOnce(); capture.capture(context); const receipt = parsePlannerWaitOutput(String(write.mock.calls[0]?.[0]));
    expect(receipt).toMatchObject({ capture_status: "captured", checkpoints: { "callback-start": 0, capture: 0 }, polls: { calls: 0, read_returns: 0, read_throws: 0, first_start_ms: null, last_start_ms: null, max_start_gap_ms: null, read_total_ms: 0, read_max_ms: null, last_lifecycle: null } }); expect(read).not.toHaveBeenCalled(); expect(timer).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
  });
  it.each(["name", "file", "retry", "repeat", "inherited", "array"] as const)("refuses non-original %s contexts without starting observation", (fault) => {
    const context = failureContext(), clock = vi.fn(() => 0), write = vi.fn(), capture = createPlannerWaitCapture({ env: p11Flags, clock, write }); let candidate: unknown = context;
    if (fault === "name") context.task.name += " PRIVATE"; else if (fault === "file") context.task.file.filepath = resolve("PRIVATE/fixture.test.ts"); else if (fault === "retry") context.task.result.retryCount = 1; else if (fault === "repeat") context.task.result.repeatCount = 1; else if (fault === "inherited") candidate = Object.create(context); else candidate = [];
    capture.prepare(candidate); expect(capture.beginCallback()).toBeUndefined(); capture.capture(candidate); expect(clock).not.toHaveBeenCalled(); expect(JSON.stringify(write.mock.calls)).not.toContain("PRIVATE");
  });
  it.each(["context", "task", "file", "result", "counter"] as const)("refuses accessors and Proxies at the %s binding without running traps", (boundary) => {
    for (const kind of ["getter", "proxy"] as const) {
      let context: unknown = failureContext(); const selected = context as SyntheticFailureContext, hook = vi.fn(), proxy = <T extends object>(value: T): T => new Proxy(value, { get: hook, ownKeys: hook, getOwnPropertyDescriptor: hook, getPrototypeOf: hook });
      if (kind === "getter") { const [target, key]: [object, string] = boundary === "context" ? [selected, "task"] : boundary === "task" ? [selected.task, "name"] : boundary === "file" ? [selected.task.file, "filepath"] : boundary === "result" ? [selected.task, "result"] : [selected.task.result, "retryCount"]; Object.defineProperty(target, key, { enumerable: true, configurable: true, get: hook }); }
      else if (boundary === "context") context = proxy(selected); else if (boundary === "file") selected.task.file = proxy(selected.task.file); else if (boundary === "result" || boundary === "counter") selected.task.result = proxy(selected.task.result); else selected.task = proxy(selected.task);
      const clock = vi.fn(() => 0), capture = createPlannerWaitCapture({ env: p11Flags, clock, write: vi.fn() }); capture.prepare(context); expect(capture.beginCallback()).toBeUndefined(); capture.capture(context); expect(hook).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled();
    }
  });
  it("does not adopt equal-shaped contexts, duplicate preparation or a second callback handle", () => {
    const harness = waitHarness(), other = failureContext(); harness.capture.capture(other); expect(harness.lines).toEqual([]); harness.capture.prepare(harness.context); expect(harness.capture.beginCallback()).toBeUndefined(); expect(harness.receipt()).toMatchObject({ capture_status: "unavailable", unavailable_reason: "invalid-binding", checkpoints: null, polls: null });
    const second = waitHarness(); expect(second.capture.beginCallback()).toBeUndefined(); expect(second.receipt().unavailable_reason).toBe("invalid-binding");
  });
  it("keeps missing callback entry unavailable rather than inventing a zero sample", () => {
    const clock = vi.fn(() => 0), lines: string[] = [], context = failureContext(), capture = createPlannerWaitCapture({ env: p11Flags, clock, write: (line) => { lines.push(line); } }); capture.prepare(context); capture.capture(context); expect(parsePlannerWaitOutput(lines[0]!)).toMatchObject({ capture_status: "unavailable", unavailable_reason: "callback-not-observed", observation_elapsed_ms: null, checkpoints: null, polls: null }); expect(clock).not.toHaveBeenCalled();
  });
  it("preserves exact arguments, nested references and Promise while admitting executor-before-return ordering", async () => {
    let now = 0; const harness = waitHarness(() => now++), original = Promise.resolve({ PRIVATE: "result" }), invoke = vi.fn(() => { harness.observer.checkpoint("executor-enter"); harness.observer.checkpoint("executor-body-return"); return original; }), binding = { ...harness.fixture, options: harness.options };
    expect(harness.observer.observeAttempt(binding, invoke)).toBe(original); expect(invoke).toHaveBeenCalledOnce(); expect(binding.options.signal).toBe(harness.options.signal); expect(binding.options.proof).toBe(harness.options.proof); expect(binding.worker).toBe(harness.fixture.worker); expect(Object.hasOwn(binding.options, "tracer")).toBe(false);
    await Promise.resolve(); harness.observer.checkpoint("wait-enter"); harness.observer.beginRead().returned("finished"); harness.observer.checkpoint("wait-return"); const receipt = harness.receipt();
    expect(receipt.capture_status).toBe("captured"); expect(receipt.order).toEqual(["callback-start", "attempt-enter", "executor-enter", "executor-body-return", "attempt-return", "attempt-resolve", "wait-enter", "wait-return", "capture"]); expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE|"(?:signal|proof|runId|taskId|root|executor|worker|options|result)":/);
  });
  it("admits settlement after wait entry and distinguishes fake body return from native settlement", async () => {
    let settle!: () => void, now = 0; const original = new Promise<void>((resolvePromise) => { settle = resolvePromise; }), harness = waitHarness(() => now++);
    expect(harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => { harness.observer.checkpoint("executor-enter"); harness.observer.checkpoint("executor-body-return"); return original; })).toBe(original); harness.observer.checkpoint("wait-enter"); harness.observer.beginRead().returned("running"); settle(); await Promise.resolve(); harness.observer.beginRead().returned("finished"); harness.observer.checkpoint("wait-return");
    const receipt = harness.receipt(); expect(receipt.capture_status).toBe("captured"); expect(receipt.order!.indexOf("wait-enter")).toBeLessThan(receipt.order!.indexOf("attempt-resolve")); expect(receipt.polls).toMatchObject({ calls: 2, read_returns: 2, read_throws: 0, last_lifecycle: "finished" });
  });
  it("does not require settlement before an already-returned wait or confuse it with task persistence", async () => {
    let settle!: () => void; const original = new Promise<void>((resolvePromise) => { settle = resolvePromise; }), harness = waitHarness(); harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => original); harness.observer.checkpoint("wait-enter"); harness.observer.beginRead().returned("finished"); harness.observer.checkpoint("wait-return"); settle(); await Promise.resolve(); expect(harness.receipt().order).toEqual(["callback-start", "attempt-enter", "attempt-return", "wait-enter", "wait-return", "attempt-resolve", "capture"]);
  });
  it("preserves synchronous thrown identity without reading its payload", () => {
    const harness = waitHarness(), trap = vi.fn(), original = Object.defineProperty({}, "message", { enumerable: true, get: trap }); let actual: unknown;
    try { harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => { throw original; }); } catch (error) { actual = error; }
    expect(actual).toBe(original); expect(trap).not.toHaveBeenCalled(); expect(harness.receipt()).toMatchObject({ capture_status: "captured", checkpoints: { "attempt-sync-throw": 0, "attempt-return": null, "attempt-resolve": null, "attempt-reject": null } });
  });
  it("observes native rejection without serializing its reason or replacing the native Promise", async () => {
    const hook = vi.fn(), reason = Object.defineProperty({}, "message", { get: hook }), original = Promise.reject(reason), harness = waitHarness(); expect(harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => original)).toBe(original); await Promise.resolve(); harness.observer.checkpoint("wait-enter"); harness.observer.checkpoint("wait-reject"); const receipt = harness.receipt(); expect(receipt.checkpoints?.["attempt-reject"]).toBe(0); expect(receipt.checkpoints?.["attempt-resolve"]).toBeNull(); expect(hook).not.toHaveBeenCalled(); expect(JSON.stringify(receipt)).not.toContain("message");
  });
  it.each(["plain", "then-getter", "proxy"] as const)("returns unsupported %s unchanged without consulting a thenable", (kind) => {
    const hook = vi.fn(), harness = waitHarness(), plain = {}, original = kind === "then-getter" ? Object.defineProperty(plain, "then", { get: hook }) : kind === "proxy" ? new Proxy(plain, { get: hook, getPrototypeOf: hook }) : plain; expect(harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => original)).toBe(original); expect(harness.receipt().capture_status).toBe("unavailable"); expect(hook).not.toHaveBeenCalled();
  });
  it.each(["taskId", "root", "executor", "worker", "runId", "options-getter", "options-proxy"] as const)("does not change original execution when private %s binding is invalid", (fault) => {
    const harness = waitHarness(), binding = { ...harness.fixture, options: harness.options }, hook = vi.fn(), original = Promise.resolve(0), invoke = vi.fn(() => original);
    if (fault === "taskId" || fault === "root") binding[fault] += "-different"; else if (fault === "executor" || fault === "worker") binding[fault] = {}; else if (fault === "runId") binding.options = { ...harness.options, runId: "" }; else if (fault === "options-getter") binding.options = Object.defineProperty({}, "runId", { get: hook }) as typeof harness.options; else binding.options = new Proxy(harness.options, { get: hook, ownKeys: hook, getOwnPropertyDescriptor: hook, getPrototypeOf: hook });
    expect(harness.observer.observeAttempt(binding, invoke)).toBe(original); expect(invoke).toHaveBeenCalledOnce(); expect(harness.receipt().unavailable_reason).toBe("invalid-binding"); expect(hook).not.toHaveBeenCalled();
  });
  it("seals the pre-stop snapshot before constructing it and all late activity is inert before clock/output", async () => {
    let settle!: () => void, now = 0; const clock = vi.fn(() => now++), original = new Promise<void>((resolvePromise) => { settle = resolvePromise; }), harness = waitHarness(clock); harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => original); harness.observer.checkpoint("wait-enter"); const read = harness.observer.beginRead(); read.returned("running"); const receipt = harness.receipt(), serialized = JSON.stringify(receipt), clocks = clock.mock.calls.length;
    settle(); await Promise.resolve(); read.threw(); harness.observer.beginRead().returned("PRIVATE"); harness.observer.checkpoint("wait-return"); harness.observer.bindFixture({ ...harness.fixture, worker: {} }); harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => original); harness.capture.prepare(failureContext()); harness.capture.beginCallback(); harness.capture.capture(harness.context);
    expect(clock).toHaveBeenCalledTimes(clocks); expect(harness.lines).toHaveLength(1); expect(JSON.stringify(receipt)).toBe(serialized); expect(receipt.checkpoints?.["attempt-resolve"]).toBeNull(); expect(receipt.checkpoints?.["wait-return"]).toBeNull(); expect(Object.isFrozen(receipt.checkpoints)).toBe(true); expect(Object.isFrozen(receipt.polls)).toBe(true);
  });
  it("aggregates only original synchronous reads, with no replay or private lifecycle property access", () => {
    let now = 0; const harness = waitHarness(() => now); harness.observer.checkpoint("wait-enter"); now = 2; const first = harness.observer.beginRead(); now = 5; first.returned("queued"); now = 11; const second = harness.observer.beginRead(); now = 15; second.threw(); now = 20; const third = harness.observer.beginRead(); now = 21; third.returned("finished"); harness.observer.checkpoint("wait-return"); now = 22;
    expect(harness.receipt().polls).toEqual({ calls: 3, read_returns: 2, read_throws: 1, first_start_ms: 2, last_start_ms: 20, max_start_gap_ms: 9, read_total_ms: 8, read_max_ms: 4, last_lifecycle: "finished" });
  });
  it.each([[undefined, "missing"], ["queued", "queued"], ["running", "running"], ["finished", "finished"], ["PRIVATE", "unsupported"], [null, "unsupported"], [{ lifecycle: "PRIVATE" }, "unsupported"]])("normalizes lifecycle %s without persisting its raw value", (value, expected) => {
    const harness = waitHarness(); harness.observer.checkpoint("wait-enter"); harness.observer.beginRead().returned(value); expect(harness.receipt().polls?.last_lifecycle).toBe(expected);
  });
  it.each(["overlap", "duplicate-read", "before-wait", "after-wait", "duplicate-checkpoint", "wrong-branch"] as const)("fails observation closed for %s without changing execution", (fault) => {
    const harness = waitHarness(); if (fault !== "before-wait") harness.observer.checkpoint("wait-enter");
    if (fault === "duplicate-checkpoint") harness.observer.checkpoint("wait-enter"); else if (fault === "wrong-branch") { harness.observer.checkpoint("wait-return"); harness.observer.checkpoint("wait-reject"); } else { if (fault === "after-wait") harness.observer.checkpoint("wait-return"); const read = harness.observer.beginRead(); if (fault === "overlap") harness.observer.beginRead(); read.returned("finished"); if (fault === "duplicate-read") read.threw(); }
    expect(harness.receipt().unavailable_reason).toBe("invalid-sequence");
  });
  it.each([256, 257])("bounds original poll count at 256 while allowing all %s calls to proceed", (count) => {
    const harness = waitHarness(), read = vi.fn(() => "running"); harness.observer.checkpoint("wait-enter"); for (let index = 0; index < count; index++) harness.observer.beginRead().returned(read()); harness.observer.checkpoint("wait-reject"); const receipt = harness.receipt(); expect(read).toHaveBeenCalledTimes(count); expect(receipt.capture_status).toBe(count === 256 ? "captured" : "unavailable"); if (count === 256) expect(receipt.polls?.calls).toBe(256); else expect(receipt.unavailable_reason).toBe("capacity-exhausted");
  });
  it.each(["throw", "NaN", "infinity", "negative", "regression", "ceiling"] as const)("keeps invalid %s clock evidence unavailable and then inert", (fault) => {
    let reads = 0; const clock = vi.fn(() => { if (reads++ === 0) return 10; if (fault === "throw") throw new Error("PRIVATE CLOCK"); return fault === "NaN" ? NaN : fault === "infinity" ? Infinity : fault === "negative" ? -1 : fault === "regression" ? 9 : 900011; }), harness = waitHarness(clock); harness.observer.checkpoint("wait-enter"); const clocks = clock.mock.calls.length; harness.observer.beginRead().returned("finished"); expect(harness.receipt()).toMatchObject({ capture_status: "unavailable", unavailable_reason: "invalid-clock", checkpoints: null, polls: null }); expect(clock).toHaveBeenCalledTimes(clocks);
  });
  it("absorbs a failed native write once without leaking or retrying its error", () => {
    const write = vi.fn(() => { throw new Error("PRIVATE WRITE"); }), context = failureContext(), capture = createPlannerWaitCapture({ env: p11Flags, clock: () => 0, write }); capture.prepare(context); capture.beginCallback(); expect(() => capture.capture(context)).not.toThrow(); capture.capture(context); expect(write).toHaveBeenCalledOnce();
  });
});

describe("P11 closed wait receipt and private stdout framing", () => {
  it("detaches fixed own data and rejects getters, Proxies and private extra fields", async () => {
    const receipt = await completeWaitReceipt(), hook = vi.fn(), accessor = { ...receipt }; Object.defineProperty(accessor, "polls", { enumerable: true, get: hook }); expect(sanitizePlannerWaitReceipt(receipt)).toEqual(receipt);
    for (const value of [accessor, new Proxy(receipt, { get: hook, ownKeys: hook, getOwnPropertyDescriptor: hook, getPrototypeOf: hook }), { ...receipt, private: "PRIVATE" }, { ...receipt, acceptance: true }, { ...receipt, sealed: false }, { ...receipt, source: "PRIVATE" }, { ...receipt, alias: "PRIVATE" }, { ...receipt, polls: { ...receipt.polls, private: "PRIVATE" } }, { ...receipt, checkpoints: { ...receipt.checkpoints, private: 0 } }]) expect(sanitizePlannerWaitReceipt(value)).toBeNull(); expect(hook).not.toHaveBeenCalled();
    const raw = JSON.parse(JSON.stringify(receipt)), copy = sanitizePlannerWaitReceipt(raw)!; raw.order.length = 0; raw.polls.calls = 99; expect(copy).toEqual(receipt); expect(copy).not.toBe(raw);
  });
  it("rejects contradictory branches, ordering, monotonic bounds and aggregate counters", async () => {
    const receipt = await completeWaitReceipt(); for (const mutate of [
      (value: PlannerWaitReceipt) => { value.order = ["capture", "callback-start"] as typeof value.order; },
      (value: PlannerWaitReceipt) => { value.order = [...value.order!, "capture"]; },
      (value: PlannerWaitReceipt) => { value.checkpoints!["callback-start"] = 1; },
      (value: PlannerWaitReceipt) => { value.checkpoints!["attempt-reject"] = value.checkpoints!["attempt-resolve"]; },
      (value: PlannerWaitReceipt) => { value.checkpoints!["executor-enter"] = 900001; },
      (value: PlannerWaitReceipt) => { value.polls!.calls = 257; },
      (value: PlannerWaitReceipt) => { value.polls!.read_throws = 1; },
      (value: PlannerWaitReceipt) => { value.polls!.read_total_ms = -1; },
      (value: PlannerWaitReceipt) => { value.polls!.read_max_ms = 900001; },
      (value: PlannerWaitReceipt) => { value.polls!.max_start_gap_ms = 1; },
    ]) { const raw = JSON.parse(JSON.stringify(receipt)) as PlannerWaitReceipt; mutate(raw); expect(sanitizePlannerWaitReceipt(raw)).toBeNull(); }
  });
  it("keeps unavailable fields null instead of retaining plausible partial measurements", () => {
    const harness = waitHarness(); harness.observer.checkpoint("wait-return"); const receipt = harness.receipt(); expect(sanitizePlannerWaitReceipt(receipt)).toEqual(receipt); for (const value of [{ ...receipt, checkpoints: {} }, { ...receipt, order: [] }, { ...receipt, polls: {} }, { ...receipt, observation_elapsed_ms: 0 }, { ...receipt, unavailable_reason: null }]) expect(sanitizePlannerWaitReceipt(value)).toBeNull();
  });
  it("preserves all other stdout bytes including P09 and JSON before or after the one validated line", async () => {
    const receipt = await completeWaitReceipt(), marker = `PLANNER_WAIT_PROFILE ${JSON.stringify(receipt)}\n`, p09 = `PLANNER_SPAN_PROFILE ${JSON.stringify(completeSpanReceipt())}\n`, json = '{"success":true,"value":"PLANNER_WAIT_PROFILE inside JSON"}\n';
    for (const output of [marker + p09 + json, p09 + json + marker, p09 + marker + json]) { const bytes: Buffer[] = [], collector = createPlannerWaitMarkerCollector(undefined, (chunk) => bytes.push(Buffer.from(chunk))); for (const byte of Buffer.from(output)) collector.push(Buffer.from([byte])); expect(collector.finish()).toEqual(receipt); expect(collector.valid()).toBe(true); expect(Buffer.concat(bytes)).toEqual(Buffer.from(p09 + json)); }
  });
  it("leaves arbitrary interleaving inside JSON unrepaired", async () => {
    const receipt = await completeWaitReceipt(), output = `{"before":1,PLANNER_WAIT_PROFILE ${JSON.stringify(receipt)}\n"after":2}\n`, bytes: Buffer[] = [], collector = createPlannerWaitMarkerCollector(undefined, (chunk) => bytes.push(Buffer.from(chunk))); collector.push(output); expect(collector.finish()).toBeNull(); expect(Buffer.concat(bytes).toString()).toBe(output); expect(() => JSON.parse(Buffer.concat(bytes).toString())).toThrow();
  });
  it.each(["duplicate", "malformed", "truncated", "prefix", "prefix-LF", "missing-space", "oversized", "utf8", "escaped-key", "duplicate-key"] as const)("permanently revokes a %s transport and preserves rejected bytes rather than repairing JSON", async (fault) => {
    const receipt = await completeWaitReceipt(), line = `PLANNER_WAIT_PROFILE ${JSON.stringify(receipt)}\n`, bytes: Buffer[] = [], updates: Array<PlannerWaitReceipt | null> = [], collector = createPlannerWaitMarkerCollector((value) => updates.push(value), (chunk) => bytes.push(Buffer.from(chunk)));
    collector.push(line); const malformed = fault === "duplicate" ? line : fault === "malformed" ? "PLANNER_WAIT_PROFILE {bad}\n" : fault === "truncated" ? "PLANNER_WAIT_PROFILE {" : fault === "prefix" ? "PLANNER_WAIT_" : fault === "prefix-LF" ? "PLANNER_WAIT_\n" : fault === "missing-space" ? "PLANNER_WAIT_PROFILE\n" : fault === "oversized" ? `PLANNER_WAIT_PROFILE ${"x".repeat(8192)}\n` : fault === "utf8" ? Buffer.concat([Buffer.from("PLANNER_WAIT_PROFILE "), Buffer.from([0xc3, 0x28, 10])]) : fault === "escaped-key" ? line.replace('"sealed":', '"se' + String.fromCharCode(92) + 'u0061led":') : line.replace('"sealed":true', '"sealed":false,"sealed":true'); collector.push(malformed); expect(collector.finish()).toBeNull(); expect(collector.valid()).toBe(false); expect(updates.at(-1)).toBeNull(); expect(Buffer.concat(bytes).length).toBeGreaterThan(0);
  });
  it("enforces the 8192 whole-line bytes, including prefix and LF, without changing the native stdout cap", async () => {
    const receipt = await completeWaitReceipt(), raw = `PLANNER_WAIT_PROFILE ${JSON.stringify(receipt)}`; expect(parsePlannerWaitOutput(`${raw.padEnd(8191, " ")}\n`)).toEqual(receipt); expect(parsePlannerWaitOutput(`${raw.padEnd(8192, " ")}\n`)).toBeNull();
    const collector = createPlannerWaitMarkerCollector(); collector.push(Buffer.alloc(8388608, 120)); collector.push("x"); expect(collector.finish()).toBeNull(); expect(collector.valid()).toBe(false);
  });
});

function attributionSourceEnvelope() {
  const original = progressSourceEnvelope(), source_hashes: Record<string, string> = { ...original.source_hashes, "runner/task-orchestrator.ts": "a".repeat(64), "runner/run-task.ts": "a".repeat(64), "node_modules/vitest/dist/chunks/test.DNmyFkvJ.js": "f07fc8036b066834143b14748bd70c436a6a2f15f648455af8d3a003a4eafc94" }; return { ...original, role: "suite-attribution-source", source_hashes };
}
function attributionEvidence(harness = completeProgress()) { const costs = createSuiteAttributionCosts(); for (const frame of harness.frames()) if (!costs.accept(frame)) throw new Error("Synthetic attribution costs unavailable"); return { progress: harness.progress, costs: costs.snapshot() }; }
async function completedAttributionReport(harness = completeProgress()): Promise<SuiteAttributionDiagnosticReport> {
  const old = completedProgressReport(), evidence = attributionEvidence(harness), source_hashes = attributionSourceEnvelope().source_hashes;
  return { ...old, workload: "full-suite-attribution", source_hashes, source_hashes_after: { ...source_hashes }, progress: compactSuiteProgress(evidence.progress), costs: evidence.costs, wait_receipt: await completeWaitReceipt(), limitations: [...SUITE_ATTRIBUTION_LIMITATIONS] };
}
function emitAttributionFrames(child: Child, harness = completeProgress(), received_ms = 0) { for (const frame of harness.frames()) child.emit("message", { role: "suite-attribution-frame", frame, received_ms }); }

describe("P11 independent nineteen-source, compact final and IPC evidence", () => {
  it("matches six independently reviewed installed contracts without deriving expected pins from exports", () => {
    const reviewed = [
      ["node_modules/vitest/dist/chunks/reporters.d.DtoKVV2s.d.ts", "7FA6FDC6EEEB3850E6B3166836F8C9199594C4F4BED3CEE02CAC0CA33D71894D"],
      ["node_modules/vitest/dist/chunks/cli-api.CnMVyzaz.js", "A236001D048380E2C67D05423FC9EA3F26B07EE019BA8D6E622082F29D49102E"],
      ["node_modules/vitest/dist/chunks/index.UpGiHP7g.js", "CDAFAF8E508042DDDBA72F8C7BBAE84E2836DDB6B06C7026520C35D91AF4E798"],
      ["node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js", "E509F3CC1BD81AE6426265253FA926CBDE02BE5CEBFE35B1DF422017BFFDCA31"],
      ["node_modules/.pnpm/@vitest+runner@4.1.11/node_modules/@vitest/runner/dist/chunk-artifact.js", "BF6AF6D2F4469911879A67E83B8F9E7B20332CF42795032C53457B10CCC1C617"],
      ["node_modules/vitest/dist/chunks/test.DNmyFkvJ.js", "F07FC8036B066834143B14748BD70C436A6A2F15F648455AF8D3A003A4EAFC94"],
    ] as const;
    expect(SUITE_ATTRIBUTION_SOURCES.slice(0, 16)).toEqual(SUITE_PROGRESS_SOURCES); expect(SUITE_ATTRIBUTION_SOURCES.slice(16)).toEqual(["runner/task-orchestrator.ts", "runner/run-task.ts", reviewed[5][0]]); expect(SUITE_ATTRIBUTION_CONTRACT_HASHES).toEqual(reviewed.map(([, hash]) => hash.toLowerCase()));
    const envelope = attributionSourceEnvelope(); expect(sanitizeSuiteAttributionSourceMetadata(envelope)).toEqual(envelope);
    for (const [path, hash] of reviewed) { expect(envelope.source_hashes[path]).toBe(hash.toLowerCase()); expect(sanitizeSuiteAttributionSourceMetadata({ ...envelope, source_hashes: { ...envelope.source_hashes, [path]: "b".repeat(64) } })).toBeNull(); }
    expect(sanitizeSuiteProgressSourceMetadata({ ...envelope, role: "suite-progress-source" })).toBeNull();
  });
  it("requires full private projections instead of trusting the compact top-N export", async () => {
    const report = await completedAttributionReport(), evidence = attributionEvidence(); expect(sanitizeSuiteAttributionDiagnostic(report, failureSourceLimits, evidence)).toEqual(report); expect(sanitizeSuiteAttributionDiagnostic(report, failureSourceLimits)).toBeNull(); expect(report.progress).not.toHaveProperty("modules"); expect(report.progress).not.toHaveProperty("open_cases"); expect(report).not.toHaveProperty("original_report");
    for (const value of [{ ...report, progress: { ...report.progress!, observed_modules: 0 } }, { ...report, costs: { ...report.costs!, sequence: report.costs!.sequence + 1 } }, { ...report, progress: { ...report.progress!, open_case_count: 1 } }, { ...report, progress: { ...report.progress!, modules: evidence.progress.modules } }, { ...report, acceptance: true }, { ...report, private: "PRIVATE" }, { ...report, source_hashes: progressSourceEnvelope().source_hashes }, { ...report, wait_receipt: null }, { ...report, receipt: null }, { ...report, json: null }, { ...report, native_exit: null }, { ...report, stdio_close: null }, { ...report, source_drift: null }, { ...report, cleanup: "unavailable-no-uncertain-fixture-deleted" }]) expect(sanitizeSuiteAttributionDiagnostic(value, failureSourceLimits, evidence)).toBeNull();
  });
  it("keeps body, native settlement and successful terminal wait independent completion prerequisites", async () => {
    const report = await completedAttributionReport(), evidence = attributionEvidence();
    for (const kind of ["open-attempt", "open-wait", "rejected-wait", "running", "no-executor"] as const) {
      const harness = waitHarness(), unresolved = new Promise<void>(() => {}); harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => { if (kind !== "no-executor") { harness.observer.checkpoint("executor-enter"); harness.observer.checkpoint("executor-body-return"); } return kind === "open-attempt" ? unresolved : Promise.resolve(); }); await Promise.resolve(); harness.observer.checkpoint("wait-enter"); harness.observer.beginRead().returned(kind === "running" ? "running" : "finished"); if (kind !== "open-wait") harness.observer.checkpoint(kind === "rejected-wait" ? "wait-reject" : "wait-return");
      const receipt = harness.receipt(); expect(receipt.capture_status).toBe("captured"); expect(sanitizeSuiteAttributionDiagnostic({ ...report, wait_receipt: receipt }, failureSourceLimits, evidence)).toBeNull(); expect(sanitizeSuiteAttributionDiagnostic({ ...report, status: "failed", wait_receipt: receipt }, failureSourceLimits, evidence)?.status).toBe("failed");
    }
  });
  it("refuses nested getters and detached evidence mutation without following private properties", async () => {
    const report = await completedAttributionReport(), evidence = attributionEvidence(), hook = vi.fn(), accessor = { ...report.progress! }; Object.defineProperty(accessor, "counts", { enumerable: true, get: hook });
    for (const value of [{ ...report, progress: accessor }, new Proxy(report, { get: hook, ownKeys: hook, getOwnPropertyDescriptor: hook, getPrototypeOf: hook }), { ...report, wait_receipt: Object.defineProperty({}, "kind", { enumerable: true, get: hook }) }]) expect(sanitizeSuiteAttributionDiagnostic(value, failureSourceLimits, evidence)).toBeNull(); expect(hook).not.toHaveBeenCalled();
    const raw = JSON.parse(JSON.stringify(report)), detached = sanitizeSuiteAttributionDiagnostic(raw, failureSourceLimits, evidence)!; raw.progress.counts.passed = 0; raw.source_hashes["runner/run-task.ts"] = "b".repeat(64); expect(detached).toEqual(report);
  });
  it("retains pre-deadline worker, progress and passive exit facts without outer filesystem access", async () => {
    vi.useFakeTimers(); const started = Date.now(), child = new Child(), foreign = new Child(), harness = completeProgress(), wait = await completeWaitReceipt(), read = vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("Unexpected outer filesystem read"); });
    child.send.mockImplementation(() => { child.emit("message", attributionSourceEnvelope()); emitAttributionFrames(child, harness); child.emit("message", { role: "suite-attribution-wait", receipt: wait, received_ms: 0 }); child.emit("message", { role: "suite-attribution-exit", native_exit: { code: 0, signal: null, received_ms: 0 } }); });
    const pending = runSuiteAttributionDiagnosticWatchdog(new ProfileDeadline(() => Date.now() - started), () => child); await vi.advanceTimersByTimeAsync(870000); expect(child.signals).toEqual([]); await vi.advanceTimersByTimeAsync(30000); const report = await pending;
    expect(report).toMatchObject({ status: "deadline", wall_ms: 900000, wait_receipt: wait, receipt: null, json: null, native_exit: { code: 0, signal: null, received_ms: 0 }, stdio_close: null, source_hashes_after: {}, cleanup: "unavailable-no-uncertain-fixture-deleted", acceptance: false }); expect(report.progress).toEqual(compactSuiteProgress(harness.progress)); expect(report.costs).toEqual(attributionEvidence(harness).costs); expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]); expect(foreign.signals).toEqual([]); expect(read).not.toHaveBeenCalled(); expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ role: "suite-attribution-controller" }));
  });
  it("completes only after coherent once-bound receipts, original JSON, native exit and stdio close", async () => {
    const child = new Child(), harness = completeProgress(), completed = await completedAttributionReport(harness), read = vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("Unexpected outer filesystem read"); });
    child.send.mockImplementation(() => { child.emit("message", attributionSourceEnvelope()); emitAttributionFrames(child, harness); child.emit("message", { role: "suite-attribution-receipt", receipt: completed.receipt, received_ms: 2 }); child.emit("message", { role: "suite-attribution-wait", receipt: completed.wait_receipt, received_ms: 3 }); child.emit("message", { role: "suite-attribution-exit", native_exit: completed.native_exit }); child.emit("message", { role: "suite-attribution-report", report: completed }); child.emit("close", 0); });
    const report = await runSuiteAttributionDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(report.status).toBe("completed"); expect(report.acceptance).toBe(false); expect(report.progress?.run_end?.reason).toBe("passed"); expect(report.wait_receipt).toEqual(completed.wait_receipt); expect(child.signals).toEqual([]); expect(read).not.toHaveBeenCalled();
  });
  it.each(["missing", "extra", "malformed", "duplicate", "wrong-hash", "before-source"] as const)("keeps %s source consistency revoked after a later plausible final", async (fault) => {
    const child = new Child(), harness = completeProgress(), report = await completedAttributionReport(harness), source = attributionSourceEnvelope(); child.send.mockImplementation(() => { if (fault === "before-source") emitAttributionFrames(child, harness); if (fault !== "missing") child.emit("message", fault === "extra" ? { ...source, private: "PRIVATE" } : fault === "malformed" ? { ...source, sourceLimits: { line_columns: [0] } } : fault === "wrong-hash" ? { ...source, source_hashes: { ...source.source_hashes, "runner/run-task.ts": "INVALID" } } : source); if (fault === "duplicate") child.emit("message", source); emitAttributionFrames(child, harness); child.emit("message", { role: "suite-attribution-report", report }); child.emit("close", 0); });
    const result = await runSuiteAttributionDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(result.status).toBe("failed"); expect(result.progress).toBeNull(); expect(result.wait_receipt).toBeNull(); expect(result.json).toBeNull(); expect(result.cleanup).toBe("unavailable-no-uncertain-fixture-deleted");
  });
  it.each(["replay", "sequence-gap", "wait-change", "receipt-change", "wait-revocation", "receipt-revocation", "exit-change", "private-field", "final-before-frame"] as const)("does not heal a %s contradiction with valid-looking later data", async (fault) => {
    const child = new Child(), harness = completeProgress(), report = await completedAttributionReport(harness); child.send.mockImplementation(() => {
      child.emit("message", attributionSourceEnvelope()); emitAttributionFrames(child, harness);
      if (fault.startsWith("wait")) { child.emit("message", { role: "suite-attribution-wait", receipt: report.wait_receipt, received_ms: 1 }); child.emit("message", fault === "wait-revocation" ? { role: "suite-attribution-wait-unavailable" } : { role: "suite-attribution-wait", receipt: report.wait_receipt, received_ms: 1 }); }
      else if (fault.startsWith("receipt")) { child.emit("message", { role: "suite-attribution-receipt", receipt: report.receipt, received_ms: 1 }); child.emit("message", fault === "receipt-revocation" ? { role: "suite-attribution-receipt-unavailable" } : { role: "suite-attribution-receipt", receipt: report.receipt, received_ms: 1 }); }
      else if (fault === "exit-change") { child.emit("message", { role: "suite-attribution-exit", native_exit: report.native_exit }); child.emit("message", { role: "suite-attribution-exit", native_exit: { ...report.native_exit!, code: 1 } }); }
      else { if (fault === "final-before-frame") child.emit("message", { role: "suite-attribution-report", report }); child.emit("message", { role: "suite-attribution-frame", frame: fault === "sequence-gap" ? { ...harness.frames()[0], sequence: harness.progress.sequence + 2 } : harness.frames()[0], received_ms: 1, ...(fault === "private-field" ? { private: "PRIVATE" } : {}) }); }
      child.emit("message", { role: "suite-attribution-report", report }); child.emit("close", 0);
    }); const result = await runSuiteAttributionDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(result.status).toBe("failed"); expect(result.json).toBeNull(); expect(result.acceptance).toBe(false); expect(result.cleanup).toBe("unavailable-no-uncertain-fixture-deleted");
  });
  it("detaches frame and wait deltas immediately instead of following object mutation", async () => {
    const child = new Child(), harness = completeProgress(), frame = JSON.parse(JSON.stringify(harness.frames()[0])) as SuiteProgressFrame, receipt = await completeWaitReceipt(), mutable = JSON.parse(JSON.stringify(receipt)) as PlannerWaitReceipt; child.send.mockImplementation(() => { child.emit("message", attributionSourceEnvelope()); child.emit("message", { role: "suite-attribution-frame", frame, received_ms: 0 }); frame.sequence = 999; child.emit("message", { role: "suite-attribution-wait", receipt: mutable, received_ms: 0 }); mutable.observation_elapsed_ms = 999; child.emit("close", 1); }); const result = await runSuiteAttributionDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child); expect(result.progress?.sequence).toBe(1); expect(result.wait_receipt).toEqual(receipt); expect(result.json).toBeNull();
  });
  it("uses only the issued handle for failed send/stalled close and never grants a fresh work budget", async () => {
    vi.useFakeTimers(); const child = new Child(), foreign = new Child(); child.send.mockImplementation(() => { throw new Error("PRIVATE IPC"); }); const pending = runSuiteAttributionDiagnosticWatchdog(new ProfileDeadline(() => 0), () => child); await vi.advanceTimersByTimeAsync(2000); const result = await pending; expect(result.status).toBe("failed"); expect(result.progress).toBeNull(); expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]); expect(foreign.signals).toEqual([]); expect(JSON.stringify(result)).not.toContain("PRIVATE"); const launch = vi.fn(() => new Child()); expect((await runSuiteAttributionDiagnosticWatchdog(new ProfileDeadline(() => PROFILE_LIMIT_MS), launch)).status).toBe("deadline"); expect(launch).not.toHaveBeenCalled();
  });
});

describe("P11 real isolated wait emitter and stdout framer", () => {
  it("loads only the copied public profiler and fictional case, keeping actual wait, JSON and stderr progress separate", async () => {
    const owned = createOwnedProfileRoot(), started = performance.now(), deadline = new ProfileDeadline(() => PROFILE_LIMIT_MS - PROFILE_CLEANUP_RESERVE_MS - 3500 + performance.now() - started);
    let exitObserved = false, closeObserved = false, stdoutBytes = 0, stderrBytes = 0, overflow = false, cleanupEligible = false;
    const stdout: Buffer[] = [], stderr: Buffer[] = [], abort = new AbortController(), profilerSource = fileURLToPath(new URL("./profile-maintenance.ts", import.meta.url)), cli = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
    try {
      expect(dirname(owned.path)).toBe(resolve(tmpdir())); expect(lstatSync(owned.path).isSymbolicLink()).toBe(false); writeFileSync(join(owned.path, ".profile-owner"), owned.token);
      const scripts = join(owned.path, "scripts"), runner = join(owned.path, "runner"), copiedProfiler = join(scripts, "profile-maintenance.ts"), fixture = join(runner, "workflow-orchestrator.test.ts"), config = join(owned.path, "fixture.mjs"); fs.mkdirSync(scripts); fs.mkdirSync(runner); fs.copyFileSync(profilerSource, copiedProfiler); expect(readFileSync(copiedProfiler)).toEqual(readFileSync(profilerSource));
      const fictionalSource = [
        'import { createPlannerWaitCapture, parsePlannerWaitOutput } from "../scripts/profile-maintenance.ts";',
        'const capture = createPlannerWaitCapture();',
        'beforeEach((context) => { capture.prepare(context); });',
        'afterEach((context) => { capture.capture(context); });',
        `it(${JSON.stringify(PLANNER_FAILURE_CASE)}, async () => {`,
        '  const observer = capture.beginCallback(); expect(observer).toBeDefined();',
        '  const binding = { taskId: "fictional-task", root: "fictional-root", executor: {}, worker: {} }; observer.bindFixture(binding);',
        '  const original = Promise.resolve(); const returned = observer.observeAttempt({ ...binding, options: { runId: "fictional-run" } }, () => { observer.checkpoint("executor-enter"); observer.checkpoint("executor-body-return"); return original; });',
        '  expect(returned).toBe(original); await original;',
        '  observer.checkpoint("wait-enter"); observer.beginRead().returned("finished"); observer.checkpoint("wait-return");',
        '  expect(parsePlannerWaitOutput("unrelated private JSON\\n")).toBeNull();',
        '});',
      ].join("\n");
      writeFileSync(fixture, fictionalSource); expect(fictionalSource.match(/^import /gm)).toHaveLength(1); expect(fictionalSource).not.toMatch(/from ["'](?:vitest|\.\.\/lib|\.\/task-orchestrator)|globalThis|PLANNER_WAIT_PROFILE /);
      writeFileSync(config, `export default ${JSON.stringify({ root: owned.path, cacheDir: join(owned.path, ".vite-cache"), test: { root: owned.path, include: ["runner/workflow-orchestrator.test.ts"], globals: true, environment: "node", setupFiles: [], watch: false } })};\n`);
      expect(resolve(cli)).toBe(cli); expect(existsSync(cli)).toBe(true); expect(existsSync(join(owned.path, "node_modules"))).toBe(false); expect(deadline.mayLaunch()).toBe(true);
      const child = spawn(process.execPath, [cli, "run", `--config=${config}`, "--reporter=json", `--reporter=${copiedProfiler}`], { cwd: owned.path, env: suiteAttributionEnvironment(process.env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      child.once("exit", () => { exitObserved = true; }); child.once("close", () => { closeObserved = true; });
      child.stdout!.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; if (stdoutBytes > 8388608) { overflow = true; abort.abort(); } else if (!overflow) stdout.push(Buffer.from(chunk)); });
      child.stderr!.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 8388608) { overflow = true; abort.abort(); } else if (!overflow) stderr.push(Buffer.from(chunk)); });
      const result = await superviseChild(child, deadline, 250, abort.signal);
      cleanupEligible = exitObserved && closeObserved && !overflow && !abort.signal.aborted && result.exit_code === 0 && result.closed && !result.expired && !result.failed;
      expect(result).toEqual({ exit_code: 0, closed: true, expired: false, failed: false }); expect(exitObserved).toBe(true); expect(closeObserved).toBe(true); expect(overflow).toBe(false); expect(performance.now() - started).toBeLessThan(4500);
      const output = Buffer.concat(stdout), errors = Buffer.concat(stderr), privateJson: Buffer[] = [], updates: Array<PlannerWaitReceipt | null> = [], framer = createPlannerWaitMarkerCollector((value) => updates.push(value), (chunk) => privateJson.push(Buffer.from(chunk))); framer.push(output); const receipt = framer.finish(), progress = parseSuiteProgressOutput(errors), jsonText = Buffer.concat(privateJson).toString("utf8");
      expect(updates).toHaveLength(1); expect(framer.valid()).toBe(true); expect(receipt).toMatchObject({ capture_status: "captured", sealed: true, polls: { calls: 1, read_returns: 1, last_lifecycle: "finished" } }); expect(output.toString("utf8").match(/^PLANNER_WAIT_PROFILE /gm)).toHaveLength(1); expect(jsonText).not.toContain("PLANNER_WAIT_PROFILE "); expect(output.toString("utf8")).not.toContain("SUITE_PROGRESS_PROFILE "); expect(errors.toString("utf8")).toContain("SUITE_PROGRESS_PROFILE ");
      expect(progress).toMatchObject({ availability: "available", module_count: 1, counts: { collected: 1, finished: 1, passed: 1, failed: 0, skipped: 0 }, planner_result: { state: "passed", original_attempt: "zero" }, run_end: { reason: "passed", unhandled_errors: 0 } });
      const json = JSON.parse(jsonText) as { success: boolean; testResults: Array<{ name: string; assertionResults: unknown[] }> }; expect(json.success).toBe(true); expect(json.testResults).toHaveLength(1); expect(json.testResults[0]?.assertionResults).toHaveLength(1); expect(parsePlannerSpanOutput(output.toString("utf8"))).toBeNull();
      const publicJson = { ...json, testResults: json.testResults.map((module) => ({ ...module, name: "runner/workflow-orchestrator.test.ts" })) }; expect(summarizeSuiteProgressJson(JSON.stringify(publicJson), progress!)?.passed).toBe(true);
      const evidence = attributionEvidence({ ...completeProgress(), progress: progress!, frames: () => errors.toString("utf8").split("\n").filter((line) => line.startsWith("SUITE_PROGRESS_PROFILE ")).map((line) => JSON.parse(line.slice("SUITE_PROGRESS_PROFILE ".length)) as SuiteProgressFrame) });
      const source_hashes = attributionSourceEnvelope().source_hashes, report: SuiteAttributionDiagnosticReport = { ...partialProgressReport(), workload: "full-suite-attribution", source_hashes, source_hashes_after: { ...source_hashes }, source_drift: false, status: "completed", progress: compactSuiteProgress(progress), wait_receipt: receipt, costs: evidence.costs, json: summarizeSuiteProgressJson(JSON.stringify(publicJson), progress!), native_exit: { code: 0, signal: null, received_ms: 0 }, stdio_close: result, cleanup: "verified-normal-suite-and-no-new-planner-prefix-roots", limitations: [...SUITE_ATTRIBUTION_LIMITATIONS] };
      expect(sanitizeSuiteAttributionDiagnostic(report, failureSourceLimits, evidence)).toBeNull(); expect(existsSync(join(owned.path, "node_modules"))).toBe(false);
    } finally {
      if (!cleanupEligible || !cleanupOwnedRoot(owned, cleanupEligible, deadline)) throw new Error("Owned P11 emitter fixture retained because normal issued exit/close and uninterrupted supervision could not be verified.");
    }
    expect(existsSync(owned.path)).toBe(false);
  });
});

describe("P11 fixture composition without importing or executing its domain", () => {
  it("passes the exact default argument projection with an own undefined tracer and original nested proofs", async () => {
    const harness = waitHarness(), native = Promise.resolve(), runTaskProjection = vi.fn((_taskId: string, _root: string, _executor: object, _options: object) => native), options = harness.options;
    expect(harness.observer.observeAttempt({ ...harness.fixture, options }, () => runTaskProjection(harness.fixture.taskId, harness.fixture.root, harness.fixture.executor, { ...options, tracer: undefined }))).toBe(native);
    const [taskId, root, executor, projected] = runTaskProjection.mock.calls[0]!; expect(taskId).toBe(harness.fixture.taskId); expect(root).toBe(harness.fixture.root); expect(executor).toBe(harness.fixture.executor); expect(projected).toEqual({ ...options, tracer: undefined }); expect(Object.hasOwn(projected, "tracer")).toBe(true); expect((projected as typeof options).proof).toBe(options.proof); expect((projected as typeof options).signal).toBe(options.signal); expect(projected).not.toBe(options); expect(Object.hasOwn(options, "tracer")).toBe(false); await Promise.resolve(); expect(harness.receipt().capture_status).toBe("captured");
  });
  it("keeps default runTask options, one synchronous read per branch and the original 5000 ms wait", () => {
    const source = readFileSync(failureFixturePath, "utf8").replaceAll("\r\n", "\n"), completeStart = source.indexOf("async function complete("), fixture = source.slice(source.indexOf("function fixture("), completeStart), complete = source.slice(completeStart, source.indexOf("\n}\n", completeStart) + 3);
    expect(fixture).toContain('...(wait ? { runAttempt: (taskId: string, runOptions: Parameters<typeof runTask>[3]) => wait.observeAttempt({ taskId, root: attemptRoot, executor, worker: boundWorker, options: runOptions! }, () => runTask(taskId, attemptRoot, executor, { ...runOptions, tracer: undefined })) } : {})');
    expect(fixture).toContain('wait?.bindFixture({ taskId: started.stages[0]!.task_id!, root: attemptRoot, executor, worker: boundWorker });');
    expect(complete.match(/readTask\(taskId\)\?\.lifecycle/g)).toHaveLength(2); expect(complete.match(/await /g)).toHaveLength(2); expect(complete).toContain('await vi.waitFor(wait ? () => {'); expect(complete).toContain('try { lifecycle = readTask(taskId)?.lifecycle; } catch (error) { read.threw(); throw error; }'); expect(complete).toContain('read.returned(lifecycle); expect(lifecycle).toBe("finished");'); expect(complete).toContain('} : () => expect(readTask(taskId)?.lifecycle).toBe("finished"), { timeout: 5000 });'); expect(complete).not.toMatch(/interval:|setTimeout|setInterval|Promise\.race|worker!\.start/);
    const hook = source.slice(source.indexOf("afterEach(async (context)"), source.indexOf("function ensureBaseIssue")); expect(hook.indexOf("plannerSpanCapture.capture")).toBeLessThan(hook.indexOf("plannerFailureCapture.capture")); expect(hook.indexOf("plannerFailureCapture.capture")).toBeLessThan(hook.indexOf("plannerWaitCapture.capture")); expect(hook.indexOf("plannerWaitCapture.capture")).toBeLessThan(hook.indexOf("await worker?.stop()")); expect(hook.match(/plannerWaitCapture\.capture\(context\)/g)).toHaveLength(1);
  });
  it("refuses a different context sharing the same task object rather than adopting its binding", () => {
    const harness = waitHarness(), sameTaskContext = Object.assign(() => {}, { task: harness.context.task }); harness.capture.capture(sameTaskContext); expect(parsePlannerWaitOutput(harness.lines[0]!)).toMatchObject({ capture_status: "unavailable", unavailable_reason: "invalid-binding" });
  });
  it.each(["constructor", "then"] as const)("returns a native Promise with an own %s getter unchanged without reading the getter", async (property) => {
    const harness = waitHarness(), hook = vi.fn(), original = Promise.resolve(); Object.defineProperty(original, property, { configurable: true, get: hook }); expect(harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => original)).toBe(original); expect(harness.receipt().unavailable_reason).toBe("invalid-binding"); expect(hook).not.toHaveBeenCalled();
  });
  it("retains an actual in-flight synchronous read as partial and ignores its late closer after sealing", () => {
    const clock = vi.fn(() => 0), harness = waitHarness(clock); harness.observer.checkpoint("wait-enter"); const reading = harness.observer.beginRead(), receipt = harness.receipt(), clocks = clock.mock.calls.length; expect(receipt).toMatchObject({ capture_status: "captured", polls: { calls: 1, read_returns: 0, read_throws: 0, read_max_ms: null, last_lifecycle: null } }); reading.returned("finished"); expect(clock).toHaveBeenCalledTimes(clocks); expect(harness.lines).toHaveLength(1); expect(parsePlannerWaitOutput(harness.lines[0]!)).toEqual(receipt);
  });
});

import { createSuiteProgressProjection } from "./profile-maintenance";

describe("P11 joint fixed transport envelope", () => {
  it("retains 256 private modules, 20000 cases, 64 open cases, full tail and top16/top4 within the original byte ceilings", async () => {
    const projection = createSuiteProgressProjection(), costs = createSuiteAttributionCosts(), frames: SuiteProgressFrame[] = [], source = (ordinal: number) => ordinal === 17 ? "scripts/017.test.ts" : `scripts/${String(ordinal).padStart(3, "0")}-${"x".repeat(172)}.test.ts`;
    let sequence = 0, valid = true, stderrBytes = 0;
    const push = (event: SuiteProgressFrame["event"], ordinal: number | null = null, data: unknown = null, test: number | null = null, elapsed = 0) => {
      const frame = { schema_version: 1, kind: "suite-progress-observation", sequence: ++sequence, reporter_elapsed_ms: elapsed, event, module: ordinal === null ? null : { ordinal, source: source(ordinal) }, case: test === null ? null : { ordinal: test, alias: null }, data } as SuiteProgressFrame;
      valid = projection.accept(frame) && costs.accept(frame) && valid; stderrBytes += Buffer.byteLength(`SUITE_PROGRESS_PROFILE ${JSON.stringify(frame)}\n`); frames.push(frame); if (frames.length > 32) frames.shift();
    };
    push("reporter-init"); push("run-start", null, { module_count: 256 });
    for (let ordinal = 1; ordinal <= 256; ordinal++) { push("module-queued", ordinal); push("module-collected", ordinal, { case_count: ordinal === 17 ? 19936 : ordinal === 256 ? 64 : 0 }); push("module-start", ordinal); }
    // Skipped cases need no invented ready event. Their short public source
    // keeps this actual 20000-case stream inside the unchanged stderr cap;
    // all top16/top4 and final-tail module labels remain at their 192 bytes.
    for (let test = 1; test <= 19936; test++) push("case-result", 17, { state: "skipped", original_attempt: null }, test);
    for (let test = 1; test <= 64; test++) push("case-ready", 256, null, test);
    for (let ordinal = 1; ordinal <= 252; ordinal++) push("module-end", ordinal, { state: ordinal === 17 ? "skipped" : "passed" }, null, 899999.9999999999);
    expect(valid).toBe(true); const progress = projection.snapshot()!, cost = costs.snapshot()!; expect(progress).not.toBeNull(); expect(progress.modules).toHaveLength(256); expect(progress.counts.collected).toBe(20000); expect(progress.open_cases).toHaveLength(64); expect(progress.tail).toHaveLength(32); expect(cost.ended).toMatchObject({ eligible_count: 252, retained_count: 16, omitted_count: 236 }); expect(cost.start_without_end).toMatchObject({ eligible_count: 4, retained_count: 4, omitted_count: 0 }); expect(cost.ended!.top.every((row) => Buffer.byteLength(row.source) === 192)).toBe(true); expect(cost.start_without_end!.top.every((row) => Buffer.byteLength(row.source) === 192)).toBe(true);
    let waitReads = 0; const waitHarnessValue = waitHarness(() => waitReads++ === 0 ? 0 : 899999.9999999999), native = Promise.resolve(); waitHarnessValue.observer.observeAttempt({ ...waitHarnessValue.fixture, options: waitHarnessValue.options }, () => { waitHarnessValue.observer.checkpoint("executor-enter"); waitHarnessValue.observer.checkpoint("executor-body-return"); return native; }); await Promise.resolve(); waitHarnessValue.observer.checkpoint("wait-enter"); for (let index = 0; index < 256; index++) waitHarnessValue.observer.beginRead().returned("finished"); waitHarnessValue.observer.checkpoint("wait-return"); const wait = waitHarnessValue.receipt(), span = completeSpanReceipt(), hashes = attributionSourceEnvelope().source_hashes;
    const report: SuiteAttributionDiagnosticReport = { ...partialProgressReport(), workload: "full-suite-attribution", wall_ms: 900000, source_hashes: hashes, source_hashes_after: { ...hashes }, source_drift: false, progress: compactSuiteProgress(progress), costs: cost, receipt: span, wait_receipt: wait, limitations: [...SUITE_ATTRIBUTION_LIMITATIONS] };
    const safe = sanitizeSuiteAttributionDiagnostic(report, failureSourceLimits, { progress, costs: cost }); expect(safe).not.toBeNull(); expect(Buffer.byteLength(JSON.stringify(safe))).toBeLessThanOrEqual(131072); expect(Buffer.byteLength(JSON.stringify({ role: "suite-attribution-report", report: safe }))).toBeLessThanOrEqual(131072);
    const waitLine = `PLANNER_WAIT_PROFILE ${JSON.stringify(wait)}`.padEnd(8191, " ") + "\n", spanLine = `PLANNER_SPAN_PROFILE ${JSON.stringify(span)}`.padEnd(8191, " ") + "\n"; expect(Buffer.byteLength(waitLine)).toBe(8192); expect(Buffer.byteLength(spanLine)).toBe(8192); expect(parsePlannerWaitOutput(waitLine)).toEqual(wait); expect(parsePlannerSpanOutput(spanLine, failureSourceLimits)).toEqual(span);
    const maximumSource = { ...attributionSourceEnvelope(), sourceLimits: { line_columns: Array.from({ length: 10000 }, () => 65536) } }, sourceBytes = Buffer.byteLength(JSON.stringify(maximumSource)); expect(sanitizeSuiteAttributionSourceMetadata(maximumSource)).not.toBeNull(); expect(sourceBytes).toBeLessThanOrEqual(131072);
    // Reserve both maximum receipt slots and every frame's IPC envelope, even
    // when this concrete valid stream uses fewer than the permitted 50000.
    const maximumMessages = 1 + 50000 + 2 + 2 + 1 + 1, maximumIpcBytes = sourceBytes + 8388608 + 50000 * 128 + 2 * 8192 + 2 * 128 + 256 + 131072;
    expect(maximumMessages).toBe(50007); expect(maximumMessages).toBeLessThanOrEqual(50008); expect(maximumIpcBytes).toBeLessThanOrEqual(8388608 + 2 * 131072 + 50000 * 128); expect(stderrBytes).toBeLessThanOrEqual(8388608); expect(sequence).toBeLessThanOrEqual(50000);
    const maximumFinalBound = Buffer.byteLength(JSON.stringify({ role: "suite-attribution-report", report: safe })) + 2 * 8192 - Buffer.byteLength(JSON.stringify(wait)) - Buffer.byteLength(JSON.stringify(span)) + 32 * 2048 - frames.reduce((sum, frame) => sum + Buffer.byteLength(JSON.stringify(frame)), 0);
    expect(maximumFinalBound).toBeLessThanOrEqual(131072);
  });
});

// P12 additions use only synthetic frames and privately owned fictional objects.
import { createWorkflowCaseTimingProjection, sanitizeWorkflowCaseTiming, type WorkflowCaseTiming } from "./profile-maintenance";

function workflowTimingHarness(caseCount: number | null = 0, start: number | null = 0) {
  const projection = createWorkflowCaseTimingProjection(), frames: SuiteProgressFrame[] = [];
  let sequence = 0;
  const push = (event: SuiteProgressFrame["event"], elapsed = 0, data: unknown = null, ordinal: number | null = null, alias: "first-implementation-planner" | null = null, moduleOrdinal: number | null = 1, source = "runner/workflow-orchestrator.test.ts") => {
    const frame = { schema_version: 1, kind: "suite-progress-observation", sequence: ++sequence, reporter_elapsed_ms: event === "observer-unavailable" ? null : elapsed, event, module: moduleOrdinal === null ? null : { ordinal: moduleOrdinal, source }, case: ordinal === null ? null : { ordinal, alias }, data } as SuiteProgressFrame;
    frames.push(frame); return projection.accept(frame);
  };
  expect(push("reporter-init", 0, null, null, null, null)).toBe(true);
  expect(push("run-start", 0, { module_count: 2 }, null, null, null)).toBe(true);
  expect(push("module-queued")).toBe(true);
  if (caseCount !== null) expect(push("module-collected", 0, { case_count: caseCount })).toBe(true);
  if (start !== null) expect(push("module-start", start)).toBe(true);
  return { projection, push, frames, snapshot(): WorkflowCaseTiming { const value = projection.snapshot(); if (!value) throw new Error("Synthetic workflow timing unavailable"); return value; } };
}

describe("P12 pure workflow-case delivery projection", () => {
  it("stays inert before received frames and does not introduce clocks, reads, timers or listeners", () => {
    const clock = vi.spyOn(performance, "now"), read = vi.spyOn(fs, "readFileSync"), timer = vi.spyOn(globalThis, "setTimeout"), listener = vi.spyOn(process, "on"), projection = createWorkflowCaseTimingProjection();
    expect(projection.snapshot()).toBeNull(); projection.revoke(); expect(projection.snapshot()).toBeNull(); expect(clock).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(timer).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
  });
  it("selects the exact fixed source rather than a remembered module or Planner ordinal", () => {
    const harness = workflowTimingHarness(1); expect(harness.push("case-ready", 2, null, 1, "first-implementation-planner")).toBe(true); expect(harness.push("case-result", 4, { state: "passed", original_attempt: "zero" }, 1, "first-implementation-planner")).toBe(true); expect(harness.push("module-end", 5, { state: "passed" })).toBe(true);
    const value = harness.snapshot(); expect(value).toMatchObject({ availability: "available", module: { ordinal: 1, source: "runner/workflow-orchestrator.test.ts" }, counts: { collected: 1, paired: 1, open: 0, unpaired: 0, unobserved: 0 }, ended: { eligible_count: 1, retained_count: 1, omitted_count: 0, top: [{ ordinal: 1, alias: "first-implementation-planner", state: "passed", original_attempt: "zero", start_ms: 2, end_ms: 4, elapsed_ms: 2 }] } });
    expect(value.ended!.top[0]).not.toHaveProperty("name"); expect(value).not.toHaveProperty("cases");
  });
  it("measures inclusive received ready/result windows without inventing callback or hook time", () => {
    const harness = workflowTimingHarness(2); expect(harness.push("case-ready", 2, null, 1)).toBe(true); expect(harness.push("case-result", 8, { state: "failed", original_attempt: null }, 1)).toBe(true); expect(harness.push("case-ready", 8, null, 2)).toBe(true); expect(harness.push("case-result", 8, { state: "passed", original_attempt: null }, 2)).toBe(true); expect(harness.push("module-end", 10, { state: "failed" })).toBe(true);
    expect(harness.snapshot()).toMatchObject({ window: { start_ms: 0, end_ms: 10, horizon_ms: 10, state: "failed" }, ended: { top: [{ ordinal: 1, elapsed_ms: 6 }, { ordinal: 2, elapsed_ms: 0 }] }, coverage: { union_ms: 6, complement_ms: 4, gaps: { eligible_count: 2, retained_count: 2, omitted_count: 0, top: [{ ordinal: 1, start_ms: 0, end_ms: 2, elapsed_ms: 2 }, { ordinal: 2, start_ms: 8, end_ms: 10, elapsed_ms: 2 }] } } });
  });
  it("unions touching, nested and overlapping windows in canonical geometry rather than summing them", () => {
    const harness = workflowTimingHarness(4);
    for (const [ordinal, at] of [[1, 1], [2, 2], [3, 4]] as const) expect(harness.push("case-ready", at, null, ordinal)).toBe(true);
    expect(harness.push("case-result", 5, { state: "passed", original_attempt: null }, 2)).toBe(true); expect(harness.push("case-result", 6, { state: "passed", original_attempt: null }, 1)).toBe(true); expect(harness.push("case-result", 7, { state: "passed", original_attempt: null }, 3)).toBe(true); expect(harness.push("case-ready", 7, null, 4)).toBe(true); expect(harness.push("case-result", 9, { state: "passed", original_attempt: null }, 4)).toBe(true); expect(harness.push("module-end", 10, { state: "passed" })).toBe(true);
    const value = harness.snapshot(); expect(value.coverage).toMatchObject({ union_ms: 8, complement_ms: 2, gaps: { eligible_count: 2 } }); expect(value.ended!.top.map((row) => row.ordinal)).toEqual([1, 2, 3, 4]); expect(value.coverage!.union_ms + value.coverage!.complement_ms).toBe(10);
  });
  it("counts unpaired skipped results and unobserved collected cases separately from open and ended cases", () => {
    const harness = workflowTimingHarness(5); expect(harness.push("case-result", 1, { state: "skipped", original_attempt: null }, 1)).toBe(true); expect(harness.push("case-ready", 2, null, 2)).toBe(true); expect(harness.push("case-result", 4, { state: "skipped", original_attempt: null }, 2)).toBe(true); expect(harness.push("case-ready", 5, null, 3)).toBe(true); expect(harness.push("module-end", 8, { state: "failed" })).toBe(true);
    expect(harness.snapshot()).toMatchObject({ counts: { collected: 5, paired: 1, open: 1, unpaired: 1, unobserved: 2 }, ended: { eligible_count: 1, top: [{ ordinal: 2, state: "skipped", elapsed_ms: 2 }] }, open: { eligible_count: 1, top: [{ ordinal: 3, start_ms: 5, horizon_ms: 8, elapsed_ms: 3 }] } });
  });
  it("does not convert unknown collection into zero or fabricate a missing module start", () => {
    const harness = workflowTimingHarness(null, null); expect(harness.push("case-result", 2, { state: "skipped", original_attempt: null }, 1)).toBe(true);
    expect(harness.snapshot()).toMatchObject({ availability: "available", window: { start_ms: null, end_ms: null, horizon_ms: null, state: null }, counts: { collected: null, paired: 0, open: 0, unpaired: 1, unobserved: null }, coverage: null });
  });
  it("keeps an absent target distinct from a known empty zero-width module", () => {
    const projection = createWorkflowCaseTimingProjection(); expect(projection.accept({ schema_version: 1, kind: "suite-progress-observation", sequence: 1, reporter_elapsed_ms: 0, event: "reporter-init", module: null, case: null, data: null })).toBe(true); expect(projection.snapshot()).toMatchObject({ module: null, window: null, counts: null, ended: null, coverage: null, open: null });
    const harness = workflowTimingHarness(0); expect(harness.push("module-end", 0, { state: "passed" })).toBe(true); expect(harness.snapshot()).toMatchObject({ counts: { collected: 0, paired: 0, open: 0, unpaired: 0, unobserved: 0 }, coverage: { union_ms: 0, complement_ms: 0, gaps: { eligible_count: 0, retained_count: 0, omitted_count: 0, top: [] } } });
  });
  it("uses only received reporter horizon for open target cases and freezes an observed module end", () => {
    const harness = workflowTimingHarness(1, 2); expect(harness.push("case-ready", 3, null, 1)).toBe(true); expect(harness.push("module-start", 9, null, null, null, 2, "scripts/fictional-other.test.ts")).toBe(true); expect(harness.snapshot().open!.top[0]).toMatchObject({ horizon_ms: 9, elapsed_ms: 6 }); expect(harness.push("module-end", 10, { state: "failed" })).toBe(true); expect(harness.push("module-end", 20, { state: "passed" }, null, null, 2, "scripts/fictional-other.test.ts")).toBe(true); expect(harness.snapshot()).toMatchObject({ reporter_elapsed_ms: 20, window: { horizon_ms: 10 }, open: { top: [{ horizon_ms: 10, elapsed_ms: 7 }] } });
  });
  it("retains top16 ended and top4 strictly-positive gaps with deterministic ties and exact omissions", () => {
    const harness = workflowTimingHarness(20);
    for (let ordinal = 1; ordinal <= 20; ordinal++) { expect(harness.push("case-ready", ordinal * 3 - 2, null, ordinal)).toBe(true); expect(harness.push("case-result", ordinal * 3 - 1, { state: "passed", original_attempt: null }, ordinal)).toBe(true); }
    expect(harness.push("module-end", 60, { state: "passed" })).toBe(true); const value = harness.snapshot(); expect(value.ended).toMatchObject({ eligible_count: 20, retained_count: 16, omitted_count: 4 }); expect(value.ended!.top.map((row) => row.ordinal)).toEqual(Array.from({ length: 16 }, (_, index) => index + 1)); expect(value.coverage).toMatchObject({ union_ms: 20, complement_ms: 40, gaps: { eligible_count: 21, retained_count: 4, omitted_count: 17 } }); expect(value.coverage!.gaps.top.map((row) => row.ordinal)).toEqual([2, 3, 4, 5]); expect(value.coverage!.gaps.top.every((row) => row.elapsed_ms > 0)).toBe(true);
  });
  it("retains top4 open ready cases and all original counts without an invented end", () => {
    const harness = workflowTimingHarness(6); for (let ordinal = 1; ordinal <= 6; ordinal++) expect(harness.push("case-ready", ordinal, null, ordinal)).toBe(true); expect(harness.push("module-start", 20, null, null, null, 2, "scripts/fictional-other.test.ts")).toBe(true);
    expect(harness.snapshot()).toMatchObject({ counts: { collected: 6, open: 6, paired: 0, unpaired: 0, unobserved: 0 }, open: { eligible_count: 6, retained_count: 4, omitted_count: 2, top: [{ ordinal: 1, elapsed_ms: 19 }, { ordinal: 2, elapsed_ms: 18 }, { ordinal: 3, elapsed_ms: 17 }, { ordinal: 4, elapsed_ms: 16 }] } }); expect(harness.snapshot().open!.top.every((row) => !Object.hasOwn(row, "end_ms"))).toBe(true);
  });
  it.each(["replay", "sequence", "clock", "identity", "alias", "non-skipped-no-ready", "observer"] as const)("permanently revokes invalid %s frames without repairing the original ledger", (fault) => {
    const harness = workflowTimingHarness(1), original = harness.frames.at(-1)!;
    const bad: unknown = fault === "replay" ? original : fault === "sequence" ? { ...original, sequence: original.sequence + 2 } : fault === "clock" ? { ...original, sequence: original.sequence + 1, reporter_elapsed_ms: -1 } : fault === "identity" ? { ...original, sequence: original.sequence + 1, module: { ordinal: 1, source: "scripts/other.test.ts" } } : fault === "alias" ? { ...original, sequence: original.sequence + 1, event: "case-ready", case: { ordinal: 1, alias: "PRIVATE" } } : fault === "observer" ? { ...original, sequence: original.sequence + 1, event: "observer-unavailable", reporter_elapsed_ms: null, module: null, data: { reason: "invalid-clock" } } : { ...original, sequence: original.sequence + 1, event: "case-result", case: { ordinal: 1, alias: null }, data: { state: "failed", original_attempt: null } };
    expect(harness.projection.accept(bad)).toBe(fault === "observer"); expect(harness.snapshot().availability).toBe("unavailable"); expect(harness.projection.accept({ ...original, sequence: original.sequence + 1 })).toBe(false); expect(harness.snapshot().availability).toBe("unavailable");
  });
  it("validates a closed detached projection rather than accepting accessor, proxy or private roster data", () => {
    const harness = workflowTimingHarness(0); expect(harness.push("module-end", 4, { state: "passed" })).toBe(true); const value = harness.snapshot(), hook = vi.fn(), accessor = { ...value }; Object.defineProperty(accessor, "coverage", { enumerable: true, get: hook });
    expect(sanitizeWorkflowCaseTiming(value)).toEqual(value); for (const candidate of [accessor, new Proxy(value, { get: hook, ownKeys: hook, getOwnPropertyDescriptor: hook, getPrototypeOf: hook }), { ...value, private: "PRIVATE" }, { ...value, cases: [] }, { ...value, coverage: { ...value.coverage!, complement_ms: 3 } }, { ...value, counts: { ...value.counts!, collected: 1 } }]) expect(sanitizeWorkflowCaseTiming(candidate)).toBeNull(); expect(hook).not.toHaveBeenCalled();
    const input = JSON.parse(JSON.stringify(value)), copy = sanitizeWorkflowCaseTiming(input)!; input.coverage.gaps.top[0].end_ms = 999; expect(copy).toEqual(value); expect(copy).not.toBe(input);
  });
  it.each(["outside-start", "outside-end", "negative", "infinite", "nan", "elapsed", "over-cap", "gap-zero", "gap-ordinal", "roster-count"] as const)("rejects %s arithmetic or containment without clipping or tolerance", (fault) => {
    const harness = workflowTimingHarness(1); expect(harness.push("case-ready", 2, null, 1)).toBe(true); expect(harness.push("case-result", 4, { state: "passed", original_attempt: null }, 1)).toBe(true); expect(harness.push("module-end", 8, { state: "passed" })).toBe(true); const value = JSON.parse(JSON.stringify(harness.snapshot())) as WorkflowCaseTiming;
    if (fault === "outside-start") value.ended!.top[0]!.start_ms = -1; else if (fault === "outside-end") value.ended!.top[0]!.end_ms = 9; else if (fault === "negative") value.coverage!.union_ms = -1; else if (fault === "infinite") value.coverage!.complement_ms = Infinity; else if (fault === "nan") value.reporter_elapsed_ms = NaN; else if (fault === "elapsed") value.ended!.top[0]!.elapsed_ms = 2.0000000000000004; else if (fault === "over-cap") value.reporter_elapsed_ms = 900001; else if (fault === "gap-zero") value.coverage!.gaps.top[0]!.elapsed_ms = 0; else if (fault === "gap-ordinal") value.coverage!.gaps.top[0]!.ordinal = 20002; else value.counts!.unobserved = 1;
    expect(sanitizeWorkflowCaseTiming(value)).toBeNull();
  });
});

import { createPlannerContinuityCapture, sanitizePlannerContinuityReceipt, type PlannerContinuityReceipt } from "./profile-maintenance";

const p12Flags = { ...p11Flags, SURTEC_TEST_PLANNER_CONTINUITY_PROFILE: "1" };
function continuityContext() { return Object.assign(failureContext(), { signal: new AbortController().signal }); }
function continuityHarness(input: { clock?: () => number; context?: ReturnType<typeof continuityContext>; timers?: object; controller?: { release(...args: unknown[]): unknown; reconcile(...args: unknown[]): unknown } } = {}) {
  const context = input.context ?? continuityContext(), lines: string[] = [], timers = input.timers ?? { isFakeTimers: vi.fn(() => false) }, controller = input.controller ?? { release: vi.fn<(...args: unknown[]) => undefined>(() => undefined), reconcile: vi.fn<(...args: unknown[]) => undefined>(() => undefined) };
  const capture = createPlannerContinuityCapture({ env: p12Flags, clock: input.clock ?? (() => 0), timers, write: (line) => { lines.push(line); } }); capture.prepare(context); const observer = capture.beginCallback(); if (!observer) throw new Error("Synthetic continuity callback binding unavailable");
  const fixture = { taskId: "PRIVATE-TASK", root: "PRIVATE-ROOT", executor: {}, worker: {}, controller }, options = { runId: "PRIVATE-RUN", workflowExecution: {} };
  observer.bindFixture(fixture);
  return { capture, context, observer, fixture, options, controller, timers, lines, receipt(): PlannerContinuityReceipt { capture.capture(context); const raw = lines[0]; if (!raw?.startsWith("PLANNER_CONTINUITY_PROFILE ")) throw new Error("Synthetic continuity marker unavailable"); const value = sanitizePlannerContinuityReceipt(JSON.parse(raw.slice("PLANNER_CONTINUITY_PROFILE ".length))); if (!value) throw new Error("Synthetic continuity receipt unavailable"); return value; } };
}
async function completeContinuityReceipt() {
  let time = 0; const harness = continuityHarness({ clock: () => time++ }), native = Promise.resolve("PRIVATE RESULT"); expect(harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => native)).toBe(native); await Promise.resolve(); harness.observer.checkpoint("wait-enter"); expect(harness.observer.observePoll(() => undefined)).toBeUndefined(); harness.controller.release(harness.options.workflowExecution); harness.controller.reconcile(); harness.observer.checkpoint("wait-return"); return harness.receipt();
}

describe("P12 sealed fixture-owned Planner continuity", () => {
  it.each([{}, { ...p12Flags, SURTEC_TEST_PLANNER_CONTINUITY_PROFILE: "0" }, ...["SURTEC_TEST_PLANNER_WAIT_PROFILE", "SURTEC_TEST_SUITE_PROGRESS_PROFILE", "SURTEC_TEST_PLANNER_SPAN_PROFILE"].map((flag) => ({ ...p12Flags, [flag]: "0" })), ...["SURTEC_TEST_PLANNER_PROFILE", "SURTEC_TEST_PLANNER_FS_PROFILE", "SURTEC_TEST_PLANNER_FAILURE_PROFILE"].flatMap((flag) => ["", "0", "1"].map((value) => ({ ...p12Flags, [flag]: value })))])("does not sample, read, write or install methods when flags are unselected", (env) => {
    const clock = vi.fn(() => 0), query = vi.fn(() => false), write = vi.fn(), read = vi.spyOn(fs, "readFileSync"), timer = vi.spyOn(globalThis, "setTimeout"), listener = vi.spyOn(process, "on"), capture = createPlannerContinuityCapture({ env, clock, write, timers: { isFakeTimers: query } }), context = continuityContext(); capture.prepare(context); expect(capture.beginCallback()).toBeUndefined(); capture.capture(context);
    expect(clock).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(timer).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled();
  });
  it.each(["getter", "proxy"] as const)("rejects an environment %s before clocks, samplers or traps", (kind) => {
    const hook = vi.fn(), plain = { ...p12Flags }, env = kind === "getter" ? Object.defineProperty(plain, "SURTEC_TEST_PLANNER_CONTINUITY_PROFILE", { enumerable: true, get: hook }) : new Proxy(plain, { get: hook, ownKeys: hook, getOwnPropertyDescriptor: hook, getPrototypeOf: hook }), clock = vi.fn(() => 0), write = vi.fn(), capture = createPlannerContinuityCapture({ env, clock, write, timers: { isFakeTimers: hook } }), context = continuityContext(); capture.prepare(context); expect(capture.beginCallback()).toBeUndefined(); capture.capture(context); expect(hook).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
  it("never queries the lazy fake-timer helper before the first actual poll body", () => {
    const query = vi.fn(() => false), harness = continuityHarness({ timers: { isFakeTimers: query } }), native = new Promise<void>(() => {}); expect(query).not.toHaveBeenCalled(); harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => native); harness.controller.reconcile(); harness.controller.release(harness.options.workflowExecution); harness.observer.checkpoint("wait-enter"); expect(query).not.toHaveBeenCalled(); harness.observer.observePoll(() => { expect(query).toHaveBeenCalledOnce(); }); const receipt = harness.receipt(); expect(receipt.capture_status).toBe("captured"); expect(receipt.snapshots?.["first-bound-release-entry"]).toMatchObject({ fake_timers: null, aborted: false }); expect(receipt.snapshots?.["first-poll-entry"]).toMatchObject({ fake_timers: false, aborted: false });
  });
  it("preserves exact receiver, argument references, return identity and a native Promise result for original methods", async () => {
    const returned = {}, native = Promise.resolve("PRIVATE"), proof = {}, second = {}, release = vi.fn(function (this: unknown, ...args: unknown[]) { expect(this).toBe(controller); expect(args).toEqual([proof, second, 3]); expect(args[0]).toBe(proof); expect(args[1]).toBe(second); return returned; }), reconcile = vi.fn(function (this: unknown, ...args: unknown[]) { expect(this).toBe(controller); expect(args).toEqual([second]); return native; }), controller = { release, reconcile }, harness = continuityHarness({ controller }); harness.options.workflowExecution = proof; harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => native); expect(controller.release(proof, second, 3)).toBe(returned); expect(controller.reconcile(second)).toBe(native); await Promise.resolve(); expect(release).toHaveBeenCalledOnce(); expect(reconcile).toHaveBeenCalledOnce(); expect(harness.receipt()).toMatchObject({ capture_status: "captured", methods: { release: { entries: 1, returned: 1, threw: 0, open: 0 }, reconcile: { entries: 1, returned: 1, threw: 0, open: 0 } } });
  });
  it("preserves original thrown identity without inspecting private getters or converting it to a rejection", () => {
    const trap = vi.fn(), error = Object.defineProperty({}, "message", { get: trap }), controller = { release: vi.fn<(...args: unknown[]) => never>(() => { throw error; }), reconcile: vi.fn(() => undefined) }, harness = continuityHarness({ controller }); harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => Promise.resolve()); let caught: unknown; try { controller.release(harness.options.workflowExecution); } catch (value) { caught = value; } expect(caught).toBe(error); expect(trap).not.toHaveBeenCalled(); expect(harness.receipt()).toMatchObject({ capture_status: "captured", methods: { release: { entries: 1, returned: 0, threw: 1, open: 0 } } });
  });
  it("observes only the selected instance and never changes its prototype or a sibling controller", () => {
    class Controller { release(..._args: unknown[]) { return this; } reconcile(..._args: unknown[]) { return this; } }
    const descriptor = Object.getOwnPropertyDescriptors(Controller.prototype), selected = new Controller(), sibling = new Controller(), originalSiblingRelease = sibling.release, originalSiblingReconcile = sibling.reconcile, harness = continuityHarness({ controller: selected }); expect(selected.release).not.toBe(originalSiblingRelease); expect(selected.reconcile).not.toBe(originalSiblingReconcile); expect(sibling.release).toBe(originalSiblingRelease); expect(sibling.reconcile).toBe(originalSiblingReconcile); expect(Object.getOwnPropertyDescriptors(Controller.prototype)).toEqual(descriptor); expect(sibling.reconcile()).toBe(sibling); expect(harness.receipt().methods?.reconcile.entries).toBe(0);
  });
  it.each(["receiver", "proof", "taskId", "root", "executor", "worker", "controller", "runId", "options-proxy", "options-getter"] as const)("keeps original execution but refuses an inconsistent private %s binding", (fault) => {
    const harness = continuityHarness(), hook = vi.fn(), native = Promise.resolve(), binding = { ...harness.fixture, options: harness.options }, invoke = vi.fn(() => native);
    if (fault === "taskId" || fault === "root") binding[fault] += "-changed"; else if (fault === "executor" || fault === "worker" || fault === "controller") binding[fault] = {} as typeof binding.executor & typeof binding.worker & typeof binding.controller; else if (fault === "runId") binding.options = { ...binding.options, runId: "" }; else if (fault === "options-proxy") binding.options = new Proxy(binding.options, { get: hook, ownKeys: hook, getOwnPropertyDescriptor: hook, getPrototypeOf: hook }); else if (fault === "options-getter") binding.options = Object.defineProperty({}, "workflowExecution", { enumerable: true, get: hook }) as typeof binding.options;
    expect(harness.observer.observeAttempt(binding, invoke)).toBe(native); if (fault === "receiver") Reflect.apply(harness.controller.reconcile, {}, []); if (fault === "proof") harness.controller.release({}); expect(invoke).toHaveBeenCalledOnce(); expect(harness.receipt().unavailable_reason).toBe("invalid-binding"); expect(hook).not.toHaveBeenCalled();
  });
  it.each(["controller-getter", "controller-proxy", "method-proxy", "noncallable", "nonconfigurable", "deep-prototype"] as const)("refuses unsupported %s installation without getters, Proxy traps or prototype writes", (fault) => {
    const hook = vi.fn(), base = { release: vi.fn(() => undefined), reconcile: vi.fn(() => undefined) }; let controller: object = base;
    if (fault === "controller-getter") Object.defineProperty(base, "reconcile", { enumerable: true, configurable: true, get: hook }); else if (fault === "controller-proxy") controller = new Proxy(base, { get: hook, ownKeys: hook, getOwnPropertyDescriptor: hook, getPrototypeOf: hook }); else if (fault === "method-proxy") base.reconcile = new Proxy(base.reconcile, { apply: hook }); else if (fault === "noncallable") Object.defineProperty(base, "reconcile", { value: 1, enumerable: true, configurable: true }); else if (fault === "nonconfigurable") Object.defineProperty(base, "release", { value: base.release, configurable: false, writable: false, enumerable: true }); else { controller = Object.create(base); for (let depth = 0; depth < 10; depth++) controller = Object.create(controller); }
    const prototype = Object.getPrototypeOf(base), capture = createPlannerContinuityCapture({ env: p12Flags, clock: () => 0, timers: { isFakeTimers: () => false }, write: (line) => { lines.push(line); } }), lines: string[] = [], context = continuityContext(); capture.prepare(context); const observer = capture.beginCallback()!; observer.bindFixture({ taskId: "private", root: "private", worker: {}, executor: {}, controller }); capture.capture(context); expect(sanitizePlannerContinuityReceipt(JSON.parse(lines[0]!.slice("PLANNER_CONTINUITY_PROFILE ".length)))?.unavailable_reason).toBe("invalid-binding"); expect(hook).not.toHaveBeenCalled(); expect(Object.getPrototypeOf(base)).toBe(prototype);
  });
  it("uses the original native Promise and preserves P11-first native reaction order", async () => {
    const context = continuityContext(), historicalLines: string[] = [], historical = createPlannerWaitCapture({ env: p11Flags, clock: () => 0, write: (line) => { historicalLines.push(line); } }); historical.prepare(context); const inner = historical.beginCallback()!, harness = continuityHarness({ context }), original = Promise.resolve("PRIVATE"), callbacks: string[] = []; inner.bindFixture({ taskId: harness.fixture.taskId, root: harness.fixture.root, executor: harness.fixture.executor, worker: harness.fixture.worker });
    const returned = harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => inner.observeAttempt({ taskId: harness.fixture.taskId, root: harness.fixture.root, executor: harness.fixture.executor, worker: harness.fixture.worker, options: harness.options }, () => { callbacks.push("invoke"); return original; })); expect(returned).toBe(original); original.then(() => callbacks.push("external")); await Promise.resolve(); historical.capture(context); const receipt = harness.receipt(); expect(callbacks).toEqual(["invoke", "external"]); expect(parsePlannerWaitOutput(historicalLines[0]!)?.checkpoints?.["attempt-resolve"]).toBe(0); expect(receipt.checkpoints?.["attempt-resolve"]).toBe(0);
  });
  it.each(["plain", "then-getter", "constructor-getter", "proxy", "subclass"] as const)("returns unsupported %s unchanged and refuses observation without reading then or payload", (kind) => {
    const hook = vi.fn(), native = Promise.resolve(), plain = {}, value = kind === "plain" ? plain : kind === "then-getter" ? Object.defineProperty(native, "then", { get: hook }) : kind === "constructor-getter" ? Object.defineProperty(native, "constructor", { get: hook }) : kind === "subclass" ? new (class extends Promise<void> {})(() => {}) : new Proxy(plain, { get: hook, getPrototypeOf: hook }), harness = continuityHarness(); expect(harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => value)).toBe(value); expect(harness.receipt().unavailable_reason).toBe("invalid-binding"); expect(hook).not.toHaveBeenCalled();
  });
  it("preserves a synchronous attempt throw and a native rejection without exporting either value", async () => {
    const trap = vi.fn(), error = Object.defineProperty({}, "message", { get: trap }), sync = continuityHarness(); let caught: unknown; try { sync.observer.observeAttempt({ ...sync.fixture, options: sync.options }, () => { throw error; }); } catch (value) { caught = value; } expect(caught).toBe(error); expect(sync.receipt()).toMatchObject({ capture_status: "captured", checkpoints: { "attempt-sync-throw": 0, "attempt-return": null, "attempt-reject": null } });
    const rejected = Promise.reject(error), harness = continuityHarness(); expect(harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => rejected)).toBe(rejected); await Promise.resolve(); expect(harness.receipt().checkpoints?.["attempt-reject"]).toBe(0); expect(trap).not.toHaveBeenCalled();
  });
  it("aggregates only the original synchronous poll body with exact returned and thrown identities", () => {
    let time = 0; const harness = continuityHarness({ clock: () => time }), value = {}, error = {}, calls = vi.fn(); harness.observer.checkpoint("wait-enter"); time = 2; expect(harness.observer.observePoll(() => { calls(); time = 5; return value; })).toBe(value); time = 8; let caught: unknown; try { harness.observer.observePoll(() => { calls(); time = 12; throw error; }); } catch (actual) { caught = actual; } expect(caught).toBe(error); harness.observer.checkpoint("wait-reject"); time = 13; expect(harness.receipt().polls).toEqual({ entries: 2, returned: 1, threw: 1, open: 0, first_start_ms: 2, last_start_ms: 8, last_completed_end_ms: 12, completed_total_ms: 7, completed_max_ms: 4, open_max_age_ms: null }); expect(calls).toHaveBeenCalledTimes(2);
  });
  it("keeps a poll captured inside its original body open and ignores the original late exit after seal", () => {
    let time = 0, receipt!: PlannerContinuityReceipt; const clock = vi.fn(() => time), query = vi.fn(() => false), harness = continuityHarness({ clock, timers: { isFakeTimers: query } }); harness.observer.checkpoint("wait-enter"); time = 2; expect(harness.observer.observePoll(() => { time = 7; receipt = harness.receipt(); return "same"; })).toBe("same"); const calls = clock.mock.calls.length, samples = query.mock.calls.length; expect(receipt.polls).toMatchObject({ entries: 1, returned: 0, threw: 0, open: 1, completed_total_ms: 0, completed_max_ms: null, last_completed_end_ms: null, open_max_age_ms: 5 }); expect(clock).toHaveBeenCalledTimes(calls); expect(query).toHaveBeenCalledTimes(samples); expect(harness.lines).toHaveLength(1);
  });
  it("represents reentrant inclusive method intervals without removing the original guard or summing them as CPU", () => {
    let time = 0, guarded = false; const body = vi.fn(), controller = { release(..._args: unknown[]) {}, reconcile(..._args: unknown[]) { if (guarded) return "guarded"; guarded = true; body(); time = 3; expect(controller.reconcile()).toBe("guarded"); time = 8; guarded = false; return "done"; } }, harness = continuityHarness({ clock: () => time, controller }); time = 1; expect(controller.reconcile()).toBe("done"); time = 10; const receipt = harness.receipt(); expect(body).toHaveBeenCalledOnce(); expect(receipt.methods?.reconcile).toMatchObject({ entries: 2, returned: 2, threw: 0, open: 0, completed_total_ms: 7, completed_max_ms: 7, top: [{ ordinal: 1, start_ms: 1, end_ms: 8, elapsed_ms: 7, settlement: "settlement-unobserved" }, { ordinal: 2, start_ms: 3, end_ms: 3, elapsed_ms: 0, settlement: "settlement-unobserved" }] });
  });
  it("exports only bounded aggregate age for reentrant methods that remain open at seal", () => {
    let time = 0, depth = 0, receipt!: PlannerContinuityReceipt; const controller = { release(..._args: unknown[]) {}, reconcile(..._args: unknown[]) { depth++; if (depth < 3) { time++; controller.reconcile(); } else { time = 10; receipt = harness.receipt(); } return depth; } }, harness = continuityHarness({ clock: () => time, controller }); controller.reconcile(); expect(receipt.methods?.reconcile).toMatchObject({ entries: 3, returned: 0, threw: 0, open: 3, completed_total_ms: 0, completed_max_ms: null, open_max_age_ms: 10, top: [] }); expect(receipt.methods?.reconcile).not.toHaveProperty("open_calls"); expect(harness.lines).toHaveLength(1);
  });
  it.each(["before-settlement", "after-settlement", "straddles-settlement", "settlement-unobserved"] as const)("derives %s only from the same P12 clock and actual native settlement", async (relation) => {
    let time = 0, settle!: () => void, receipt!: PlannerContinuityReceipt; const original = new Promise<void>((resolvePromise) => { settle = resolvePromise; }), controller = { release(..._args: unknown[]) {}, reconcile(..._args: unknown[]) { time = 4; return "same"; } }, harness = continuityHarness({ clock: () => time, controller }); harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => original);
    if (relation === "after-settlement") { time = 1; settle(); await Promise.resolve(); time = 2; controller.reconcile(); }
    else if (relation === "straddles-settlement") { time = 2; controller.reconcile(); time = 4; settle(); await Promise.resolve(); }
    else { time = 2; controller.reconcile(); if (relation === "before-settlement") { time = 5; settle(); await Promise.resolve(); } }
    time = 8; receipt = harness.receipt(); expect(receipt.capture_status).toBe("captured"); if (relation !== "straddles-settlement") expect(receipt.methods?.reconcile.top[0]?.settlement).toBe(relation); else expect(receipt.methods?.reconcile.top[0]?.settlement).toBe("straddles-settlement");
  });
  it.each([256, 257])("allows every original one of %s poll bodies while enforcing the unchanged observer capacity", (count) => {
    const harness = continuityHarness(), body = vi.fn(() => undefined); harness.observer.checkpoint("wait-enter"); for (let index = 0; index < count; index++) harness.observer.observePoll(body); expect(body).toHaveBeenCalledTimes(count); const receipt = harness.receipt(); expect(receipt.capture_status).toBe(count === 256 ? "captured" : "unavailable"); if (count === 257) expect(receipt.unavailable_reason).toBe("capacity-exhausted"); else expect(receipt.polls?.entries).toBe(256);
  });
  it.each([128, 129])("preserves every original one of %s combined controller calls while bounding observation", (count) => {
    const release = vi.fn<(...args: unknown[]) => undefined>(() => undefined), reconcile = vi.fn(() => undefined), controller = { release, reconcile }, harness = continuityHarness({ controller }); harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => new Promise<void>(() => {})); for (let index = 0; index < count; index++) index % 2 ? controller.release(harness.options.workflowExecution) : controller.reconcile(); expect(release.mock.calls.length + reconcile.mock.calls.length).toBe(count); const receipt = harness.receipt(); expect(receipt.capture_status).toBe(count === 128 ? "captured" : "unavailable"); if (count === 129) expect(receipt.unavailable_reason).toBe("capacity-exhausted"); else { expect(receipt.methods?.release.entries).toBe(64); expect(receipt.methods?.reconcile.entries).toBe(64); expect(receipt.methods?.reconcile.top).toHaveLength(4); }
  });
  it.each(["nonboolean", "throw", "getter", "proxy", "reentrant"] as const)("fails only observation for %s timer sampling while preserving the original poll", (fault) => {
    const body = vi.fn(() => "same"), hook = vi.fn(), timers: object = fault === "getter" ? Object.defineProperty({}, "isFakeTimers", { enumerable: true, get: hook }) : fault === "proxy" ? new Proxy({ isFakeTimers: () => false }, { get: hook, ownKeys: hook, getOwnPropertyDescriptor: hook, getPrototypeOf: hook }) : { isFakeTimers: () => { if (fault === "throw") throw new Error("PRIVATE"); if (fault === "reentrant") harness.observer.observePoll(() => undefined); return fault === "nonboolean" ? "PRIVATE" : false; } }, harness = continuityHarness({ timers }); harness.observer.checkpoint("wait-enter"); expect(harness.observer.observePoll(body)).toBe("same"); expect(body).toHaveBeenCalledOnce(); expect(harness.receipt().capture_status).toBe("unavailable"); expect(hook).not.toHaveBeenCalled();
  });
  it("reads only the captured native signal aborted getter and does not inspect reason or attach a listener", () => {
    const controller = new AbortController(), signal = controller.signal, trap = vi.fn(), context = Object.assign(failureContext(), { signal }); Object.defineProperty(signal, "aborted", { get: trap }); Object.defineProperty(signal, "reason", { get: trap }); const add = vi.spyOn(signal, "addEventListener"), harness = continuityHarness({ context }); harness.observer.checkpoint("wait-enter"); harness.observer.observePoll(() => undefined); controller.abort("PRIVATE"); const receipt = harness.receipt(); expect(receipt.capture_status).toBe("captured"); expect(receipt.snapshots?.["first-poll-entry"]?.aborted).toBe(false); expect(receipt.snapshots?.seal?.aborted).toBe(true); expect(trap).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled(); expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE|"reason"\s*:/);
  });
  it.each(["signal-getter", "signal-proxy", "signal-brand", "signal-inherited"] as const)("refuses unsupported %s without reading a trap or inventing an abort fact", (fault) => {
    const hook = vi.fn(), context = continuityContext(); if (fault === "signal-getter") Object.defineProperty(context, "signal", { enumerable: true, configurable: true, get: hook }); else if (fault === "signal-proxy") context.signal = new Proxy(context.signal, { get: hook, getOwnPropertyDescriptor: hook, getPrototypeOf: hook }); else if (fault === "signal-brand") context.signal = {} as AbortSignal; else { const signal = context.signal; delete (context as Partial<typeof context>).signal; Object.setPrototypeOf(context, { signal }); }
    const lines: string[] = [], capture = createPlannerContinuityCapture({ env: p12Flags, clock: () => 0, timers: { isFakeTimers: () => false }, write: (line) => { lines.push(line); } }); capture.prepare(context); capture.beginCallback(); capture.capture(context); expect(lines).toHaveLength(1); expect(sanitizePlannerContinuityReceipt(JSON.parse(lines[0]!.slice("PLANNER_CONTINUITY_PROFILE ".length)))?.capture_status).toBe("unavailable"); expect(hook).not.toHaveBeenCalled();
  });
  it("makes sealed late methods, polls, settlements and recursive samplers inert before every observer read", async () => {
    let settle!: () => void; const native = new Promise<void>((resolvePromise) => { settle = resolvePromise; }), clock = vi.fn(() => 0), query = vi.fn(() => false), release = vi.fn<(...args: unknown[]) => string>(() => "release"), reconcile = vi.fn(() => "reconcile"), controller = { release, reconcile }, harness = continuityHarness({ clock, timers: { isFakeTimers: query }, controller }); harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => native); harness.observer.checkpoint("wait-enter"); harness.observer.observePoll(() => undefined); const receipt = harness.receipt(), serialized = JSON.stringify(receipt), clocks = clock.mock.calls.length, samples = query.mock.calls.length; settle(); await Promise.resolve(); expect(controller.release({})).toBe("release"); expect(controller.reconcile()).toBe("reconcile"); expect(harness.observer.observePoll(() => "original-late")).toBe("original-late"); harness.observer.checkpoint("wait-return"); harness.capture.capture(harness.context); expect(clock).toHaveBeenCalledTimes(clocks); expect(query).toHaveBeenCalledTimes(samples); expect(harness.lines).toHaveLength(1); expect(JSON.stringify(receipt)).toBe(serialized); expect(receipt.checkpoints?.["attempt-resolve"]).toBeNull(); expect(release).toHaveBeenCalledOnce(); expect(reconcile).toHaveBeenCalledOnce();
  });
  it.each(["negative", "backwards", "infinite", "over-cap", "throw", "reentrant"] as const)("fails the %s clock closed without changing a method result or invoking private payloads", (fault) => {
    let calls = 0, harness!: ReturnType<typeof continuityHarness>; const clock = () => { calls++; if (calls === 1) return 1; if (fault === "throw") throw new Error("PRIVATE"); if (fault === "reentrant") harness.observer.checkpoint("wait-enter"); return fault === "negative" ? -1 : fault === "backwards" ? 0 : fault === "infinite" ? Infinity : fault === "over-cap" ? 900002 : 1; }; harness = continuityHarness({ clock }); expect(harness.controller.reconcile()).toBeUndefined(); expect(harness.receipt().unavailable_reason).toBe("invalid-clock");
  });
  it("writes one best-effort bounded receipt and never retries a failed native write", () => {
    const write = vi.fn<(line: string) => never>(() => { throw new Error("PRIVATE"); }), capture = createPlannerContinuityCapture({ env: p12Flags, clock: () => 0, timers: { isFakeTimers: () => false }, write }), context = continuityContext(); capture.prepare(context); capture.beginCallback(); expect(() => capture.capture(context)).not.toThrow(); capture.capture(context); expect(write).toHaveBeenCalledOnce(); expect(Buffer.byteLength(String(write.mock.calls[0]![0]))).toBeLessThanOrEqual(8192); expect(String(write.mock.calls[0]![0])).not.toContain("PRIVATE");
  });
  it("detaches a closed private-data-free receipt and rejects accessors, proxies and contradictory aggregates", async () => {
    const receipt = await completeContinuityReceipt(), hook = vi.fn(), accessor = { ...receipt }; Object.defineProperty(accessor, "polls", { enumerable: true, get: hook }); expect(sanitizePlannerContinuityReceipt(receipt)).toEqual(receipt);
    for (const value of [accessor, new Proxy(receipt, { get: hook, ownKeys: hook, getOwnPropertyDescriptor: hook, getPrototypeOf: hook }), { ...receipt, private: "PRIVATE" }, { ...receipt, acceptance: true }, { ...receipt, sealed: false }, { ...receipt, source: "PRIVATE" }, { ...receipt, polls: { ...receipt.polls!, entries: 257 } }, { ...receipt, methods: { ...receipt.methods!, release: { ...receipt.methods!.release, entries: 129 } } }, { ...receipt, snapshots: { ...receipt.snapshots!, private: false } }]) expect(sanitizePlannerContinuityReceipt(value)).toBeNull(); expect(hook).not.toHaveBeenCalled(); expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE|"(?:taskId|root|worker|controller|executor|workflowExecution|signal|options|result|error|runId)":/);
    const raw = JSON.parse(JSON.stringify(receipt)), copy = sanitizePlannerContinuityReceipt(raw)!; raw.order.length = 0; raw.methods.release.entries = 99; expect(copy).toEqual(receipt); expect(copy).not.toBe(raw); expect(Object.isFrozen(copy.methods)).toBe(true);
  });
});

import { createPlannerContinuityOutputCollector, createWorkflowTimingOutputCollector, sanitizeSuiteWorkflowTimingDiagnostic, sanitizeSuiteWorkflowTimingSourceMetadata, SUITE_WORKFLOW_TIMING_CONTRACT_HASHES, SUITE_WORKFLOW_TIMING_LIMITATIONS, SUITE_WORKFLOW_TIMING_SOURCES, suiteWorkflowTimingArguments, suiteWorkflowTimingEnvironment, type SuiteWorkflowTimingDiagnosticReport } from "./profile-maintenance";

function workflowTimingSourceEnvelope() { return { ...attributionSourceEnvelope(), role: "suite-workflow-timing-source", source_hashes: { ...attributionSourceEnvelope().source_hashes, "runner/workflow-orchestrator.ts": "a".repeat(64) } }; }
function workflowTimingEvidence(harness = completeProgress()) { const old = attributionEvidence(harness), projection = createWorkflowCaseTimingProjection(); for (const frame of harness.frames()) if (!projection.accept(frame)) throw new Error("Synthetic workflow timing frame unavailable"); return { ...old, workflow_cases: projection.snapshot() }; }
async function completedWorkflowTimingReport(harness = completeProgress()): Promise<SuiteWorkflowTimingDiagnosticReport> { const old = await completedAttributionReport(harness), source_hashes = workflowTimingSourceEnvelope().source_hashes; return { ...old, workload: "full-suite-workflow-timing", source_hashes, source_hashes_after: { ...source_hashes }, continuity_receipt: await completeContinuityReceipt(), workflow_cases: workflowTimingEvidence(harness).workflow_cases, limitations: [...SUITE_WORKFLOW_TIMING_LIMITATIONS] }; }

describe("P12 three-receipt stdout framing with one permanent revocation", () => {
  it("separates only complete validated P11/P12 lines while preserving every P09 and JSON byte in order", async () => {
    const continuity = await completeContinuityReceipt(), wait = await completeWaitReceipt(), span = completeSpanReceipt(), p12 = `PLANNER_CONTINUITY_PROFILE ${JSON.stringify(continuity)}\n`, p11 = `PLANNER_WAIT_PROFILE ${JSON.stringify(wait)}\n`, p09 = `PLANNER_SPAN_PROFILE ${JSON.stringify(span)}\n`, json = '{"success":true,"private":"PLANNER_CONTINUITY_PROFILE inside JSON"}\n';
    for (const output of [p12 + p11 + p09 + json, p09 + json + p11 + p12, p11 + p09 + p12 + json]) { const data: Buffer[] = [], spans: unknown[] = [], waits: unknown[] = [], captures: unknown[] = [], revocations = vi.fn(), collector = createWorkflowTimingOutputCollector({ data: (chunk) => data.push(Buffer.from(chunk)), span: (value) => spans.push(value), wait: (value) => waits.push(value), continuity: (value) => captures.push(value), revoke: revocations }, failureSourceLimits); for (const byte of Buffer.from(output)) collector.push(Buffer.from([byte])); expect(collector.finish()).toEqual({ receipt: span, wait_receipt: wait, continuity_receipt: continuity }); expect(collector.valid()).toBe(true); expect(Buffer.concat(data)).toEqual(Buffer.from(p09 + json)); expect(spans).toEqual([span]); expect(waits).toEqual([wait]); expect(captures).toEqual([continuity]); expect(revocations).not.toHaveBeenCalled(); }
  });
  it.each(["duplicate", "malformed", "truncated", "reserved-prefix", "prefix-LF", "missing-space", "oversized", "invalid-utf8", "escaped-key", "duplicate-key"] as const)("coalesces %s into one sticky set revocation and never heals or emits another receipt", async (fault) => {
    const continuity = await completeContinuityReceipt(), wait = await completeWaitReceipt(), span = completeSpanReceipt(), p12 = `PLANNER_CONTINUITY_PROFILE ${JSON.stringify(continuity)}\n`, p11 = `PLANNER_WAIT_PROFILE ${JSON.stringify(wait)}\n`, p09 = `PLANNER_SPAN_PROFILE ${JSON.stringify(span)}\n`, data: Buffer[] = [], revoke = vi.fn(), captured = vi.fn(), collector = createWorkflowTimingOutputCollector({ data: (chunk) => data.push(Buffer.from(chunk)), continuity: captured, revoke }, failureSourceLimits); collector.push(p12); collector.push(p11); collector.push(p09);
    const malformed = fault === "duplicate" ? p12 : fault === "malformed" ? "PLANNER_CONTINUITY_PROFILE {bad}\n" : fault === "truncated" ? "PLANNER_CONTINUITY_PROFILE {" : fault === "reserved-prefix" ? "PLANNER_CONTINUITY_" : fault === "prefix-LF" ? "PLANNER_CONTINUITY_\n" : fault === "missing-space" ? "PLANNER_CONTINUITY_PROFILE\n" : fault === "oversized" ? `PLANNER_CONTINUITY_PROFILE ${"x".repeat(8192)}\n` : fault === "invalid-utf8" ? Buffer.concat([Buffer.from("PLANNER_CONTINUITY_PROFILE "), Buffer.from([0xc3, 0x28, 10])]) : fault === "escaped-key" ? p12.replace('"sealed":', '"se' + String.fromCharCode(92) + 'u0061led":') : p12.replace('"sealed":true', '"sealed":false,"sealed":true'); collector.push(malformed); const first = collector.finish(); expect(first).toEqual({ receipt: null, wait_receipt: null, continuity_receipt: null }); expect(collector.valid()).toBe(false); expect(revoke).toHaveBeenCalledOnce(); collector.push(p12); collector.push(p11); collector.push(p09); expect(collector.finish()).toEqual(first); expect(revoke).toHaveBeenCalledOnce(); expect(captured).toHaveBeenCalledOnce(); expect(Buffer.concat(data).length).toBeGreaterThan(0);
  });
  it("keeps valid unavailable observations distinct from malformed transport and preserves other receipts", async () => {
    const harness = continuityHarness(); harness.observer.checkpoint("wait-return"); const unavailable = harness.receipt(), wait = await completeWaitReceipt(), span = completeSpanReceipt(), revoke = vi.fn(), collector = createWorkflowTimingOutputCollector({ revoke }, failureSourceLimits); collector.push(`PLANNER_CONTINUITY_PROFILE ${JSON.stringify(unavailable)}\nPLANNER_WAIT_PROFILE ${JSON.stringify(wait)}\nPLANNER_SPAN_PROFILE ${JSON.stringify(span)}\n`); expect(collector.finish()).toEqual({ receipt: span, wait_receipt: wait, continuity_receipt: unavailable }); expect(collector.valid()).toBe(true); expect(revoke).not.toHaveBeenCalled();
  });
  it("does not repair an arbitrary receipt-like interleave inside private JSON", async () => {
    const continuity = await completeContinuityReceipt(), output = `{"before":1,PLANNER_CONTINUITY_PROFILE ${JSON.stringify(continuity)}\n"after":2}\n`, data: Buffer[] = [], collector = createWorkflowTimingOutputCollector({ data: (chunk) => data.push(Buffer.from(chunk)) }); collector.push(output); expect(collector.finish().continuity_receipt).toBeNull(); expect(Buffer.concat(data).toString()).toBe(output); expect(() => JSON.parse(Buffer.concat(data).toString())).toThrow();
  });
  it("applies 8192 whole-line bytes including prefix/LF and the original eight-MiB original-byte ceiling", async () => {
    const receipt = await completeContinuityReceipt(), raw = `PLANNER_CONTINUITY_PROFILE ${JSON.stringify(receipt)}`, accepted = createPlannerContinuityOutputCollector(), rejected = createPlannerContinuityOutputCollector(); accepted.push(`${raw.padEnd(8191, " ")}\n`); rejected.push(`${raw.padEnd(8192, " ")}\n`); expect(accepted.finish()).toEqual(receipt); expect(rejected.finish()).toBeNull(); expect(rejected.valid()).toBe(false);
    const revoke = vi.fn(), collector = createWorkflowTimingOutputCollector({ revoke }); collector.push(Buffer.alloc(8388608, 120)); collector.push("x"); expect(collector.finish()).toEqual({ receipt: null, wait_receipt: null, continuity_receipt: null }); expect(collector.valid()).toBe(false); expect(revoke).toHaveBeenCalledOnce();
  });
});

describe("P12 closed twenty-source and compact final evidence", () => {
  it("keeps the exact original full-workload arguments, limits and environment boundary", () => {
    expect(parseProfileArguments(["--workload=full-suite-workflow-timing"])).toBe("full-suite-workflow-timing"); expect(PROFILE_WORKLOADS).not.toContain("full-suite-workflow-timing"); expect(suiteWorkflowTimingArguments()).toEqual(suiteAttributionArguments()); expect(suiteWorkflowTimingArguments().join(" ")).not.toMatch(/maxWorkers|testNamePattern|retry|repeat|bail|timeout/);
    expect(suiteWorkflowTimingEnvironment({ PATH: "synthetic", ...p12Flags, SURTEC_TEST_PLANNER_PROFILE: "1", SURTEC_TEST_PLANNER_FS_PROFILE: "0", SURTEC_TEST_PLANNER_FAILURE_PROFILE: "", SURTEC_STATE_DIR: "PRIVATE", OPENAI_API_KEY: "PRIVATE", NODE_OPTIONS: "PRIVATE" })).toEqual({ PATH: "synthetic", CI: "1", NO_COLOR: "1", ...p12Flags });
    for (const env of [profileEnvironment(p12Flags), plannerFsEnvironment(p12Flags), plannerFailureEnvironment(p12Flags), plannerSpanEnvironment(p12Flags), suiteProgressEnvironment(p12Flags), suiteAttributionEnvironment(p12Flags), fixtureProfileEnvironment("first-planner", "phases", p12Flags)]) expect(env).not.toHaveProperty("SURTEC_TEST_PLANNER_CONTINUITY_PROFILE"); expect(PROFILE_LIMIT_MS).toBe(900000); expect(PROFILE_CLEANUP_RESERVE_MS).toBe(30000); expect(SUITE_PROGRESS_LIMITS).toEqual({ frame_bytes: 2048, frames: 50000, stderr_bytes: 8388608, modules: 256, cases: 20000, open_cases: 64, tail: 32, snapshot_bytes: 131072 });
  });
  it("pins the same six independently reviewed installed APIs and adds only the read-only controller source", () => {
    const reviewed = ["7fa6fdc6eeeb3850e6b3166836f8c9199594c4f4bed3cee02cac0ca33d71894d", "a236001d048380e2c67d05423fc9ea3f26b07ee019ba8d6e622082f29d49102e", "cdafaf8e508042dddba72f8c7bbae84e2836ddb6b06c7026520c35d91af4e798", "e509f3cc1bd81ae6426265253fa926cbde02be5cebfe35b1df422017bffdca31", "bf6af6d2f4469911879a67e83b8f9e7b20332cf42795032c53457b10ccc1c617", "f07fc8036b066834143b14748bd70c436a6a2f15f648455af8d3a003a4eafc94"];
    expect(SUITE_WORKFLOW_TIMING_SOURCES).toHaveLength(20); expect(SUITE_WORKFLOW_TIMING_SOURCES.slice(0, 19)).toEqual(SUITE_ATTRIBUTION_SOURCES); expect(SUITE_WORKFLOW_TIMING_SOURCES[19]).toBe("runner/workflow-orchestrator.ts"); expect(SUITE_WORKFLOW_TIMING_CONTRACT_HASHES).toEqual(reviewed); const source = workflowTimingSourceEnvelope(); expect(sanitizeSuiteWorkflowTimingSourceMetadata(source)).toEqual(source); expect(sanitizeSuiteAttributionSourceMetadata({ ...source, role: "suite-attribution-source" })).toBeNull(); expect(sanitizeSuiteProgressSourceMetadata({ ...source, role: "suite-progress-source" })).toBeNull();
    for (const value of [{ ...source, private: "PRIVATE" }, { ...source, source_hashes: attributionSourceEnvelope().source_hashes }, { ...source, source_hashes: { ...source.source_hashes, "runner/workflow-orchestrator.ts": "BAD" } }, { ...source, sourceLimits: { line_columns: [0] } }]) expect(sanitizeSuiteWorkflowTimingSourceMetadata(value)).toBeNull();
  });
  it("requires full privately replayed original evidence and new case geometry rather than trusting top-N data", async () => {
    const report = await completedWorkflowTimingReport(), evidence = workflowTimingEvidence(); expect(sanitizeSuiteWorkflowTimingDiagnostic(report, failureSourceLimits, evidence)).toEqual(report); expect(sanitizeSuiteWorkflowTimingDiagnostic(report, failureSourceLimits)).toBeNull(); expect(report).not.toHaveProperty("original_report"); expect(report.progress).not.toHaveProperty("modules"); expect(report.workflow_cases).not.toHaveProperty("cases");
    for (const value of [{ ...report, acceptance: true }, { ...report, private: "PRIVATE" }, { ...report, source_hashes: attributionSourceEnvelope().source_hashes }, { ...report, workflow_cases: null }, { ...report, continuity_receipt: null }, { ...report, receipt: null }, { ...report, wait_receipt: null }, { ...report, json: null }, { ...report, native_exit: null }, { ...report, stdio_close: null }, { ...report, source_drift: null }, { ...report, cleanup: "unavailable-no-uncertain-fixture-deleted" }, { ...report, workflow_cases: { ...report.workflow_cases!, sequence: report.workflow_cases!.sequence + 1 } }]) expect(sanitizeSuiteWorkflowTimingDiagnostic(value, failureSourceLimits, evidence)).toBeNull();
  });
  it("does not upgrade a valid partial or unavailable continuity capture into completed evidence", async () => {
    const report = await completedWorkflowTimingReport(), evidence = workflowTimingEvidence(), harness = continuityHarness(); harness.observer.checkpoint("wait-enter"); harness.observer.observePoll(() => undefined); const partial = harness.receipt(); expect(sanitizeSuiteWorkflowTimingDiagnostic({ ...report, continuity_receipt: partial }, failureSourceLimits, evidence)).toBeNull(); expect(sanitizeSuiteWorkflowTimingDiagnostic({ ...report, status: "failed", continuity_receipt: partial }, failureSourceLimits, evidence)?.status).toBe("failed"); const unavailable = continuityHarness(); unavailable.observer.checkpoint("wait-return"); const missing = unavailable.receipt(); expect(sanitizeSuiteWorkflowTimingDiagnostic({ ...report, status: "failed", continuity_receipt: missing }, failureSourceLimits, evidence)?.continuity_receipt?.capture_status).toBe("unavailable");
  });
  it("rejects nested accessors and Proxies without invoking them and detaches valid source and aggregate facts", async () => {
    const report = await completedWorkflowTimingReport(), evidence = workflowTimingEvidence(), hook = vi.fn(), accessor = { ...report.workflow_cases! }; Object.defineProperty(accessor, "coverage", { enumerable: true, get: hook }); for (const value of [{ ...report, workflow_cases: accessor }, new Proxy(report, { get: hook, ownKeys: hook, getOwnPropertyDescriptor: hook, getPrototypeOf: hook }), { ...report, continuity_receipt: Object.defineProperty({}, "kind", { enumerable: true, get: hook }) }]) expect(sanitizeSuiteWorkflowTimingDiagnostic(value, failureSourceLimits, evidence)).toBeNull(); expect(hook).not.toHaveBeenCalled(); const input = JSON.parse(JSON.stringify(report)), detached = sanitizeSuiteWorkflowTimingDiagnostic(input, failureSourceLimits, evidence)!; input.source_hashes["runner/workflow-orchestrator.ts"] = "b".repeat(64); input.workflow_cases.counts.paired = 999; expect(detached).toEqual(report);
  });
});

describe("P12 real isolated continuity emitter and original public reporter", () => {
  it("imports only the verified copied profiler, invokes fictional original methods and emits one actual bounded receipt", async () => {
    const owned = createOwnedProfileRoot(), started = performance.now(), deadline = new ProfileDeadline(() => PROFILE_LIMIT_MS - PROFILE_CLEANUP_RESERVE_MS - 3500 + performance.now() - started);
    let exitObserved = false, closeObserved = false, stdoutBytes = 0, stderrBytes = 0, overflow = false, cleanupEligible = false;
    const stdout: Buffer[] = [], stderr: Buffer[] = [], abort = new AbortController(), profilerSource = fileURLToPath(new URL("./profile-maintenance.ts", import.meta.url)), cli = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
    try {
      expect(dirname(owned.path)).toBe(resolve(tmpdir())); expect(lstatSync(owned.path).isSymbolicLink()).toBe(false); writeFileSync(join(owned.path, ".profile-owner"), owned.token);
      const scripts = join(owned.path, "scripts"), runner = join(owned.path, "runner"), copiedProfiler = join(scripts, "profile-maintenance.ts"), fixture = join(runner, "workflow-orchestrator.test.ts"), config = join(owned.path, "fixture.mjs"); fs.mkdirSync(scripts); fs.mkdirSync(runner); fs.copyFileSync(profilerSource, copiedProfiler); expect(readFileSync(copiedProfiler)).toEqual(readFileSync(profilerSource));
      const fictionalSource = [
        'import { createPlannerContinuityCapture } from "../scripts/profile-maintenance.ts";',
        'const capture = createPlannerContinuityCapture({ timers: vi });',
        'beforeEach((context) => { capture.prepare(context); });',
        'afterEach((context) => { capture.capture(context); });',
        `it(${JSON.stringify(PLANNER_FAILURE_CASE)}, async () => {`,
        '  const observer = capture.beginCallback(); expect(observer).toBeDefined();',
        '  const proof = {}, argument = {}, result = {}, calls = { release: 0, reconcile: 0 };',
        '  const controller = { release(value) { expect(this).toBe(controller); expect(value).toBe(proof); calls.release++; return result; }, reconcile(value) { expect(this).toBe(controller); expect(value).toBe(argument); calls.reconcile++; return result; } };',
        '  const binding = { taskId: "fictional-task", root: "fictional-root", executor: {}, worker: {}, controller }; observer.bindFixture(binding);',
        '  const original = Promise.resolve(); const returned = observer.observeAttempt({ ...binding, options: { runId: "fictional-run", workflowExecution: proof } }, () => original);',
        '  expect(returned).toBe(original); await original;',
        '  observer.checkpoint("wait-enter"); await vi.waitFor(() => observer.observePoll(() => { expect(returned).toBe(original); }), { timeout: 5000 }); observer.checkpoint("wait-return");',
        '  expect(controller.release(proof)).toBe(result); expect(controller.reconcile(argument)).toBe(result); expect(calls).toEqual({ release: 1, reconcile: 1 });',
        '});',
      ].join("\n");
      writeFileSync(fixture, fictionalSource); expect(fictionalSource.match(/^import /gm)).toHaveLength(1); expect(fictionalSource).not.toMatch(/from ["'](?:vitest|\.\.\/lib|\.\/task-orchestrator)|globalThis|PLANNER_CONTINUITY_PROFILE /); writeFileSync(config, `export default ${JSON.stringify({ root: owned.path, cacheDir: join(owned.path, ".vite-cache"), test: { root: owned.path, include: ["runner/workflow-orchestrator.test.ts"], globals: true, environment: "node", setupFiles: [], watch: false } })};\n`);
      expect(resolve(cli)).toBe(cli); expect(existsSync(cli)).toBe(true); expect(existsSync(join(owned.path, "node_modules"))).toBe(false); expect(deadline.mayLaunch()).toBe(true);
      const child = spawn(process.execPath, [cli, "run", `--config=${config}`, "--reporter=json", `--reporter=${copiedProfiler}`], { cwd: owned.path, env: suiteWorkflowTimingEnvironment(process.env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); child.once("exit", () => { exitObserved = true; }); child.once("close", () => { closeObserved = true; });
      child.stdout!.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; if (stdoutBytes > 8388608) { overflow = true; abort.abort(); } else if (!overflow) stdout.push(Buffer.from(chunk)); }); child.stderr!.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 8388608) { overflow = true; abort.abort(); } else if (!overflow) stderr.push(Buffer.from(chunk)); });
      const result = await superviseChild(child, deadline, 250, abort.signal); cleanupEligible = exitObserved && closeObserved && !overflow && !abort.signal.aborted && result.exit_code === 0 && result.closed && !result.expired && !result.failed;
      expect(result).toEqual({ exit_code: 0, closed: true, expired: false, failed: false }); expect(exitObserved).toBe(true); expect(closeObserved).toBe(true); expect(overflow).toBe(false); expect(performance.now() - started).toBeLessThan(4500);
      const output = Buffer.concat(stdout), errors = Buffer.concat(stderr), data: Buffer[] = [], captures: PlannerContinuityReceipt[] = [], framer = createWorkflowTimingOutputCollector({ data: (chunk) => data.push(Buffer.from(chunk)), continuity: (value) => captures.push(value) }, failureSourceLimits); framer.push(output); const receipts = framer.finish(), progress = parseSuiteProgressOutput(errors), jsonText = Buffer.concat(data).toString("utf8");
      expect(framer.valid()).toBe(true); expect(captures).toHaveLength(1); expect(receipts).toMatchObject({ receipt: null, wait_receipt: null, continuity_receipt: { capture_status: "captured", sealed: true, polls: { entries: 1, returned: 1, threw: 0 }, methods: { release: { entries: 1, returned: 1 }, reconcile: { entries: 1, returned: 1 } } } }); expect(output.toString("utf8").match(/^PLANNER_CONTINUITY_PROFILE /gm)).toHaveLength(1); expect(jsonText).not.toContain("PLANNER_CONTINUITY_PROFILE "); expect(output.toString("utf8")).not.toContain("SUITE_PROGRESS_PROFILE "); expect(errors.toString("utf8")).toContain("SUITE_PROGRESS_PROFILE ");
      expect(progress).toMatchObject({ availability: "available", module_count: 1, counts: { collected: 1, finished: 1, passed: 1, failed: 0, skipped: 0 }, planner_result: { state: "passed", original_attempt: "zero" }, run_end: { reason: "passed", unhandled_errors: 0 } }); const json = JSON.parse(jsonText) as { success: boolean; testResults: Array<{ name: string; assertionResults: unknown[] }> }; expect(json.success).toBe(true); expect(json.testResults).toHaveLength(1); expect(json.testResults[0]?.assertionResults).toHaveLength(1);
      const frames = errors.toString("utf8").split("\n").filter((line) => line.startsWith("SUITE_PROGRESS_PROFILE ")).map((line) => JSON.parse(line.slice("SUITE_PROGRESS_PROFILE ".length)) as SuiteProgressFrame), projection = createWorkflowCaseTimingProjection(); for (const frame of frames) expect(projection.accept(frame)).toBe(true); expect(projection.snapshot()).toMatchObject({ availability: "available", counts: { collected: 1, paired: 1, open: 0, unobserved: 0 } });
      const evidence = workflowTimingEvidence({ ...completeProgress(), progress: progress!, frames: () => frames }), source_hashes = workflowTimingSourceEnvelope().source_hashes, fictionalReport: SuiteWorkflowTimingDiagnosticReport = { ...partialProgressReport(), workload: "full-suite-workflow-timing", status: "completed", source_hashes, source_hashes_after: { ...source_hashes }, source_drift: false, progress: compactSuiteProgress(progress), wait_receipt: null, costs: evidence.costs, workflow_cases: evidence.workflow_cases, continuity_receipt: receipts.continuity_receipt, receipt: null, json: null, native_exit: { code: 0, signal: null, received_ms: 0 }, stdio_close: result, cleanup: "verified-normal-suite-and-no-new-planner-prefix-roots", limitations: [...SUITE_WORKFLOW_TIMING_LIMITATIONS] }; expect(sanitizeSuiteWorkflowTimingDiagnostic(fictionalReport, failureSourceLimits, evidence)).toBeNull(); expect(existsSync(join(owned.path, "node_modules"))).toBe(false);
    } finally {
      if (!cleanupEligible || !cleanupOwnedRoot(owned, cleanupEligible, deadline)) throw new Error("Owned P12 emitter fixture retained because normal issued exit/close and uninterrupted supervision could not be verified.");
    }
    expect(existsSync(owned.path)).toBe(false);
  });
});

import { createHash } from "node:crypto";
import { runSuiteWorkflowTimingDiagnosticWatchdog } from "./profile-maintenance";

function emitWorkflowTimingFrames(child: Child, harness = completeProgress(), received_ms = 0) {
  for (const frame of harness.frames()) child.emit("message", { role: "suite-workflow-timing-frame", frame, received_ms });
}
function emitWorkflowTimingReceipts(child: Child, report: SuiteWorkflowTimingDiagnosticReport) {
  child.emit("message", { role: "suite-workflow-timing-receipt", receipt: report.receipt, received_ms: 1 });
  child.emit("message", { role: "suite-workflow-timing-wait", receipt: report.wait_receipt, received_ms: 2 });
  child.emit("message", { role: "suite-workflow-timing-continuity", receipt: report.continuity_receipt, received_ms: 3 });
}

describe("P12 independent replay and issued process closure", () => {
  it("requires the original JSON, three once-bound receipts, passive native exit and controller close", async () => {
    const child = new Child(), harness = completeProgress(), completed = await completedWorkflowTimingReport(harness);
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("Unexpected outer filesystem read"); });
    child.send.mockImplementation(() => {
      child.emit("message", workflowTimingSourceEnvelope()); emitWorkflowTimingFrames(child, harness); emitWorkflowTimingReceipts(child, completed);
      child.emit("message", { role: "suite-workflow-timing-exit", native_exit: completed.native_exit });
      child.emit("message", { role: "suite-workflow-timing-report", report: completed }); child.emit("close", 0);
    });
    const report = await runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child);
    expect(report).toEqual(completed); expect(report.status).toBe("completed"); expect(report.acceptance).toBe(false);
    expect(read).not.toHaveBeenCalled(); expect(child.signals).toEqual([]);
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ role: "suite-workflow-timing-controller" }));
  });
  it("retains partial Planner and workflow geometry at the original deadline without outer filesystem reads", async () => {
    vi.useFakeTimers(); const started = Date.now(), child = new Child(), foreign = new Child(), harness = completeProgress(), continuity = await completeContinuityReceipt();
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("Unexpected outer filesystem read"); });
    child.send.mockImplementation(() => {
      child.emit("message", workflowTimingSourceEnvelope()); emitWorkflowTimingFrames(child, harness);
      child.emit("message", { role: "suite-workflow-timing-continuity", receipt: continuity, received_ms: 0 });
      child.emit("message", { role: "suite-workflow-timing-exit", native_exit: { code: 0, signal: null, received_ms: 0 } });
    });
    const pending = runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(() => Date.now() - started), () => child);
    await vi.advanceTimersByTimeAsync(870000); expect(child.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(30000); const report = await pending;
    expect(report).toMatchObject({ status: "deadline", wall_ms: 900000, continuity_receipt: continuity, wait_receipt: null, receipt: null, json: null, stdio_close: null, source_hashes_after: {}, cleanup: "unavailable-no-uncertain-fixture-deleted" });
    expect(report.workflow_cases).toEqual(workflowTimingEvidence(harness).workflow_cases); expect(report.progress).toEqual(compactSuiteProgress(harness.progress));
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]); expect(foreign.signals).toEqual([]); expect(read).not.toHaveBeenCalled();
  });
  it.each(["missing", "extra", "malformed", "duplicate", "wrong-pin", "before-source"] as const)("keeps %s source evidence unavailable after a plausible final", async (fault) => {
    const child = new Child(), harness = completeProgress(), completed = await completedWorkflowTimingReport(harness), source = workflowTimingSourceEnvelope();
    child.send.mockImplementation(() => {
      if (fault === "before-source") emitWorkflowTimingFrames(child, harness);
      if (fault !== "missing") child.emit("message", fault === "extra" ? { ...source, private: "PRIVATE" } : fault === "malformed" ? { ...source, sourceLimits: { line_columns: [0] } } : fault === "wrong-pin" ? { ...source, source_hashes: { ...source.source_hashes, [SUITE_WORKFLOW_TIMING_SOURCES[18]]: "b".repeat(64) } } : source);
      if (fault === "duplicate") child.emit("message", source);
      emitWorkflowTimingFrames(child, harness); emitWorkflowTimingReceipts(child, completed);
      child.emit("message", { role: "suite-workflow-timing-report", report: completed }); child.emit("close", 0);
    });
    const report = await runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child);
    expect(report.status).toBe("failed"); expect(report.progress).toBeNull(); expect(report.workflow_cases).toBeNull(); expect(report.continuity_receipt).toBeNull(); expect(report.json).toBeNull();
  });
  it.each(["replay", "sequence-gap", "continuity-duplicate", "continuity-change", "foreign-geometry", "receipt-revoked", "exit-duplicate", "private-field", "final-before-frames", "new-source-drift"] as const)("does not heal a %s contradiction with later valid-looking evidence", async (fault) => {
    const child = new Child(), harness = completeProgress(), completed = await completedWorkflowTimingReport(harness);
    child.send.mockImplementation(() => {
      child.emit("message", workflowTimingSourceEnvelope());
      if (fault === "final-before-frames") child.emit("message", { role: "suite-workflow-timing-report", report: completed });
      emitWorkflowTimingFrames(child, harness); emitWorkflowTimingReceipts(child, completed);
      if (fault === "continuity-duplicate") child.emit("message", { role: "suite-workflow-timing-continuity", receipt: completed.continuity_receipt, received_ms: 3 });
      else if (fault === "receipt-revoked") child.emit("message", { role: "suite-workflow-timing-receipts-unavailable" });
      else if (fault === "replay" || fault === "sequence-gap" || fault === "private-field") child.emit("message", { role: "suite-workflow-timing-frame", frame: fault === "sequence-gap" ? { ...harness.frames()[0], sequence: harness.progress.sequence + 2 } : harness.frames()[0], received_ms: 3, ...(fault === "private-field" ? { private: "PRIVATE" } : {}) });
      child.emit("message", { role: "suite-workflow-timing-exit", native_exit: completed.native_exit });
      if (fault === "exit-duplicate") child.emit("message", { role: "suite-workflow-timing-exit", native_exit: completed.native_exit });
      const final = fault === "continuity-change" ? { ...completed, continuity_receipt: null } : fault === "foreign-geometry" ? { ...completed, workflow_cases: { ...completed.workflow_cases!, counts: { ...completed.workflow_cases!.counts!, paired: 0 } } } : fault === "new-source-drift" ? { ...completed, source_hashes: { ...completed.source_hashes, "runner/workflow-orchestrator.ts": "b".repeat(64) } } : completed;
      child.emit("message", { role: "suite-workflow-timing-report", report: final }); child.emit("close", 0);
    });
    const report = await runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child);
    expect(report.status).toBe("failed"); expect(report.json).toBeNull(); expect(report.cleanup).toBe("unavailable-no-uncertain-fixture-deleted"); expect(report.acceptance).toBe(false);
  });
  it("retains known progress after the one global receipt revocation without restoring any receipt", async () => {
    const child = new Child(), harness = completeProgress(), completed = await completedWorkflowTimingReport(harness);
    child.send.mockImplementation(() => {
      child.emit("message", workflowTimingSourceEnvelope()); emitWorkflowTimingFrames(child, harness); emitWorkflowTimingReceipts(child, completed);
      child.emit("message", { role: "suite-workflow-timing-receipts-unavailable" }); child.emit("close", 1);
    });
    const report = await runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child);
    expect(report.status).toBe("failed"); expect(report.progress).toEqual(compactSuiteProgress(harness.progress)); expect(report.workflow_cases).toEqual(workflowTimingEvidence(harness).workflow_cases);
    expect(report.receipt).toBeNull(); expect(report.wait_receipt).toBeNull(); expect(report.continuity_receipt).toBeNull();
  });
  it("detaches frame and continuity deltas before their sender mutates the original objects", async () => {
    const child = new Child(), harness = completeProgress(), frame = JSON.parse(JSON.stringify(harness.frames()[0])) as SuiteProgressFrame, continuity = await completeContinuityReceipt(), mutable = JSON.parse(JSON.stringify(continuity)) as PlannerContinuityReceipt;
    child.send.mockImplementation(() => {
      child.emit("message", workflowTimingSourceEnvelope()); child.emit("message", { role: "suite-workflow-timing-frame", frame, received_ms: 0 }); frame.sequence = 999;
      child.emit("message", { role: "suite-workflow-timing-continuity", receipt: mutable, received_ms: 0 }); mutable.observation_elapsed_ms = 999; child.emit("close", 1);
    });
    const report = await runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child);
    expect(report.progress?.sequence).toBe(1); expect(report.workflow_cases?.sequence).toBe(1); expect(report.continuity_receipt).toEqual(continuity); expect(report.json).toBeNull();
  });
  it.each(["missing-exit", "failed-close", "missing-close"] as const)("does not substitute a passing report for %s", async (fault) => {
    vi.useFakeTimers(); const child = new Child(), completed = await completedWorkflowTimingReport();
    child.send.mockImplementation(() => {
      child.emit("message", workflowTimingSourceEnvelope()); emitWorkflowTimingFrames(child); emitWorkflowTimingReceipts(child, completed);
      if (fault !== "missing-exit") child.emit("message", { role: "suite-workflow-timing-exit", native_exit: completed.native_exit });
      child.emit("message", { role: "suite-workflow-timing-report", report: completed }); if (fault !== "missing-close") child.emit("close", fault === "failed-close" ? 1 : 0);
    });
    const pending = runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child);
    if (fault === "missing-close") await vi.advanceTimersByTimeAsync(902000);
    const report = await pending; expect(report.status).toBe(fault === "missing-close" ? "deadline" : "failed"); expect(report.json).toBeNull(); expect(report.cleanup).toBe("unavailable-no-uncertain-fixture-deleted");
  });
  it("supervises only the issued stalled handle and cannot launch with a depleted original budget", async () => {
    vi.useFakeTimers(); const child = new Child(), foreign = new Child(); child.send.mockImplementation(() => { throw new Error("PRIVATE IPC"); });
    const pending = runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(() => 0), () => child); await vi.advanceTimersByTimeAsync(2000);
    const report = await pending; expect(report.status).toBe("failed"); expect(report.progress).toBeNull(); expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]); expect(foreign.signals).toEqual([]); expect(JSON.stringify(report)).not.toContain("PRIVATE");
    const launch = vi.fn(() => new Child()); expect((await runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(() => PROFILE_LIMIT_MS), launch)).status).toBe("deadline"); expect(launch).not.toHaveBeenCalled();
  });
});

describe("P12 original composition and bounded joint transport", () => {
  it.each(["name", "file", "retry", "repeat", "context-proxy", "context-getter"] as const)("never starts a new continuity observation for an unselected %s context", (fault) => {
    const context = continuityContext(), hook = vi.fn(), clock = vi.fn(() => 0), query = vi.fn(() => false), write = vi.fn(); let candidate: unknown = context;
    if (fault === "name") context.task.name += " other";
    else if (fault === "file") context.task.file.filepath += ".other";
    else if (fault === "retry") context.task.result!.retryCount = 1;
    else if (fault === "repeat") context.task.result!.repeatCount = 1;
    else if (fault === "context-proxy") candidate = new Proxy(context, { get: hook, getOwnPropertyDescriptor: hook, getPrototypeOf: hook, ownKeys: hook });
    else candidate = Object.defineProperty(() => {}, "task", { enumerable: true, get: hook });
    const capture = createPlannerContinuityCapture({ env: p12Flags, clock, timers: { isFakeTimers: query }, write }); capture.prepare(candidate);
    expect(capture.beginCallback()).toBeUndefined(); expect(clock).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(hook).not.toHaveBeenCalled();
  });
  it("never adopts an equal-shaped context or overwrites the first bound boolean snapshots", () => {
    const abort = new AbortController(), context = Object.assign(failureContext(), { signal: abort.signal }), harness = continuityHarness({ context });
    harness.observer.checkpoint("wait-enter"); harness.observer.observePoll(() => undefined); abort.abort("PRIVATE"); harness.observer.observePoll(() => undefined);
    const receipt = harness.receipt(); expect(receipt.snapshots?.["first-poll-entry"]?.aborted).toBe(false); expect(receipt.snapshots?.["first-poll-exit"]?.aborted).toBe(false); expect(receipt.snapshots?.seal?.aborted).toBe(true);
    const other = continuityHarness(), duplicate = Object.assign(() => {}, { task: other.context.task, signal: other.context.signal }); other.capture.capture(duplicate);
    const parsed = sanitizePlannerContinuityReceipt(JSON.parse(other.lines[0]!.slice("PLANNER_CONTINUITY_PROFILE ".length))); expect(parsed?.unavailable_reason).toBe("invalid-binding");
  });
  it("preserves every byte of the 547 historical tests and the original fixture execution projection", () => {
    const tests = readFileSync(fileURLToPath(new URL("./profile-maintenance.test.ts", import.meta.url)), "utf8"), historical = tests.slice(0, tests.indexOf("// P12 additions use only synthetic frames") - 1);
    expect(createHash("sha256").update(historical).digest("hex")).toBe("d5b685595a96fe2770c51075e8bf5d9688524d5604cdfc2c9d3831dd4e5ec1d3");
    const source = readFileSync(failureFixturePath, "utf8"), fixture = source.slice(source.indexOf("function fixture("), source.indexOf("async function complete("));
    expect(fixture).toContain("continuity.observeAttempt({ ...binding, controller }, () => historicalWait.observeAttempt(binding, invoke))");
    expect(fixture.indexOf("controller.service.start(")).toBeLessThan(fixture.indexOf("continuity?.bindFixture("));
    expect(fixture).toContain("() => runTask(taskId, attemptRoot, executor, { ...runOptions, tracer: undefined })");
    const hook = source.slice(source.indexOf("afterEach(async (context)"), source.indexOf("function ensureBaseIssue"));
    expect(hook.indexOf("plannerWaitCapture.capture(context)")).toBeLessThan(hook.indexOf("plannerContinuityCapture.capture(context)"));
    expect(hook.indexOf("plannerContinuityCapture.capture(context)")).toBeLessThan(hook.indexOf("await worker?.stop()"));
    expect(source.match(/plannerContinuityCapture\.capture\(context\)/g)).toHaveLength(1);
    const facade = source.slice(source.indexOf("function plannerPollVi("), source.indexOf("const roles ="));
    expect(facade).toContain("Reflect.apply(plannerOriginalVi.waitFor, plannerOriginalVi,"); expect(facade).toContain("[() => continuity.observePoll(args[0]), ...args.slice(1)]");
    expect(facade).not.toMatch(/async |await |setTimeout|setInterval|\.then\(/);
  });
  it("retains the full private case roster at the 20000-case bound and only four of 20001 positive gaps", () => {
    const harness = workflowTimingHarness(20000);
    for (let ordinal = 1; ordinal <= 20000; ordinal++) {
      expect(harness.push("case-ready", 2 * ordinal - 1, null, ordinal)).toBe(true);
      expect(harness.push("case-result", 2 * ordinal - 1, { state: "passed", original_attempt: null }, ordinal)).toBe(true);
    }
    expect(harness.push("module-end", 40000, { state: "passed" })).toBe(true);
    const value = harness.snapshot(); expect(value.counts).toEqual({ collected: 20000, paired: 20000, open: 0, unpaired: 0, unobserved: 0 });
    expect(value.ended).toMatchObject({ eligible_count: 20000, retained_count: 16, omitted_count: 19984 });
    expect(value.coverage).toMatchObject({ union_ms: 0, complement_ms: 40000, gaps: { eligible_count: 20001, retained_count: 4, omitted_count: 19997 } });
    expect(value.coverage!.gaps.top.map((row) => row.ordinal)).toEqual([2, 3, 4, 5]);
  });
  it("jointly serializes twenty sources, maximum rosters/tail/rankings and three full receipt slots inside unchanged caps", async () => {
    const projection = createSuiteProgressProjection(), costs = createSuiteAttributionCosts(), workflow = createWorkflowCaseTimingProjection(), frames: SuiteProgressFrame[] = [];
    let sequence = 0, stderrBytes = 0, valid = true;
    const source = (ordinal: number) => ordinal === 17 ? "runner/workflow-orchestrator.test.ts" : `${ordinal < 17 ? "lib" : "scripts"}/${String(ordinal).padStart(3, "0")}-${"x".repeat(ordinal < 17 ? 176 : 172)}.test.ts`;
    const push = (event: SuiteProgressFrame["event"], ordinal: number | null = null, data: unknown = null, test: number | null = null, elapsed = 0) => {
      const frame = { schema_version: 1, kind: "suite-progress-observation", sequence: ++sequence, reporter_elapsed_ms: elapsed, event, module: ordinal === null ? null : { ordinal, source: source(ordinal) }, case: test === null ? null : { ordinal: test, alias: null }, data } as SuiteProgressFrame;
      valid = projection.accept(frame) && costs.accept(frame) && workflow.accept(frame) && valid;
      stderrBytes += Buffer.byteLength(`SUITE_PROGRESS_PROFILE ${JSON.stringify(frame)}\n`); frames.push(frame); if (frames.length > 32) frames.shift();
    };
    push("reporter-init"); push("run-start", null, { module_count: 256 });
    for (let ordinal = 1; ordinal <= 256; ordinal++) { push("module-queued", ordinal); push("module-collected", ordinal, { case_count: ordinal === 17 ? 19940 : ordinal === 256 ? 60 : 0 }); push("module-start", ordinal); }
    for (let test = 1; test <= 20; test++) { push("case-ready", 17, null, test, test * 3 - 2); push("case-result", 17, { state: "passed", original_attempt: null }, test, test * 3 - 1); }
    for (let test = 21; test <= 19936; test++) push("case-result", 17, { state: "skipped", original_attempt: null }, test, 60);
    for (let test = 19937; test <= 19940; test++) push("case-ready", 17, null, test, test - 19876);
    for (let test = 1; test <= 60; test++) push("case-ready", 256, null, test, 65);
    for (let ordinal = 1; ordinal <= 252; ordinal++) push("module-end", ordinal, { state: ordinal === 17 ? "failed" : "passed" }, null, 899999.9999999999);
    expect(valid).toBe(true); const progress = projection.snapshot()!, cost = costs.snapshot()!, cases = workflow.snapshot()!;
    expect(progress.counts.collected).toBe(20000); expect(progress.open_cases).toHaveLength(64); expect(progress.tail).toHaveLength(32);
    expect(cost.ended).toMatchObject({ retained_count: 16, omitted_count: 236 }); expect(cost.start_without_end?.top).toHaveLength(4);
    expect(cases.ended?.top).toHaveLength(16); expect(cases.open?.top).toHaveLength(4); expect(cases.coverage?.gaps.top).toHaveLength(4);
    let clocks = 0, settle!: () => void; const original = new Promise<void>((resolvePromise) => { settle = resolvePromise; }), harness = continuityHarness({ clock: () => clocks++ === 0 ? 0 : 899999.9999999999 });
    harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => original); harness.observer.checkpoint("wait-enter"); harness.observer.observePoll(() => undefined); settle(); await Promise.resolve();
    for (let index = 0; index < 64; index++) { harness.controller.release(harness.options.workflowExecution); harness.controller.reconcile(); }
    for (let index = 1; index < 256; index++) harness.observer.observePoll(() => undefined);
    harness.observer.checkpoint("wait-return"); const continuity = harness.receipt(), wait = await completeWaitReceipt(), span = completeSpanReceipt(), sourceEnvelope = workflowTimingSourceEnvelope();
    expect(continuity.capture_status).toBe("captured"); expect(continuity.snapshots && Object.values(continuity.snapshots).every((entry) => entry !== null)).toBe(true);
    const report: SuiteWorkflowTimingDiagnosticReport = { ...partialProgressReport(), workload: "full-suite-workflow-timing", wall_ms: 900000, source_hashes: sourceEnvelope.source_hashes, source_hashes_after: { ...sourceEnvelope.source_hashes }, source_drift: false, progress: compactSuiteProgress(progress), receipt: span, wait_receipt: wait, costs: cost, workflow_cases: cases, continuity_receipt: continuity, limitations: [...SUITE_WORKFLOW_TIMING_LIMITATIONS] };
    const safe = sanitizeSuiteWorkflowTimingDiagnostic(report, failureSourceLimits, { progress, costs: cost, workflow_cases: cases }); expect(safe).not.toBeNull();
    // Actual joint serialization reserves full slots even though sanitizers emit
    // compact JSON. Padding is legal JSON whitespace, not dropped evidence.
    let serialized = JSON.stringify({ role: "suite-workflow-timing-report", report: safe });
    for (const receipt of [span, wait, continuity]) { const raw = JSON.stringify(receipt); serialized = serialized.replace(raw, raw.padEnd(8192, " ")); }
    for (const frame of frames) { const raw = JSON.stringify(frame); serialized = serialized.replace(raw, raw.padEnd(2048, " ")); }
    expect(JSON.parse(serialized)).toEqual({ role: "suite-workflow-timing-report", report: safe }); expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(131072);
    const maximumSource = { ...sourceEnvelope, sourceLimits: { line_columns: Array.from({ length: 10000 }, () => 65536) } }, sourceBytes = Buffer.byteLength(JSON.stringify(maximumSource));
    expect(sanitizeSuiteWorkflowTimingSourceMetadata(maximumSource)).not.toBeNull(); expect(sourceBytes).toBeLessThanOrEqual(131072); expect(JSON.stringify(safe)).not.toContain("line_columns");
    const maximumMessages = 1 + 50000 + 3 + 1 + 1 + 1, maximumIpcBytes = sourceBytes + 8388608 + 50000 * 128 + 3 * 8192 + 128 + 256 + 131072;
    expect(maximumMessages).toBe(50007); expect(maximumMessages).toBeLessThanOrEqual(50008); expect(maximumIpcBytes).toBeLessThanOrEqual(8388608 + 2 * 131072 + 50000 * 128);
    expect(stderrBytes).toBeLessThanOrEqual(8388608); expect(sequence).toBeLessThanOrEqual(50000);
    const data: Buffer[] = [], collector = createWorkflowTimingOutputCollector({ data: (chunk) => data.push(Buffer.from(chunk)) }, failureSourceLimits);
    for (const [marker, receipt] of [["PLANNER_SPAN_PROFILE ", span], ["PLANNER_WAIT_PROFILE ", wait], ["PLANNER_CONTINUITY_PROFILE ", continuity]] as const) {
      const line = `${marker}${JSON.stringify(receipt)}`.padEnd(8191, " ") + "\n"; expect(Buffer.byteLength(line)).toBe(8192); collector.push(line);
    }
    expect(collector.finish()).toEqual({ receipt: span, wait_receipt: wait, continuity_receipt: continuity }); expect(collector.valid()).toBe(true);
  });
});

// P13 additions preserve the complete 703-test prefix byte for byte.
import ts from "typescript";
import { types as p13NodeTypes } from "node:util";
import { createP12ObservationLossCapture, formatP12ObservationLossLine, P12_OBSERVATION_REJECTION_SITES, P12_OBSERVATION_TERMINAL_BRANCHES, sanitizeP12ObservationLossReceipt, type P12ObservationLossReceipt } from "./profile-maintenance";

const p13ProfilerText = readFileSync(fileURLToPath(new URL("./profile-maintenance.ts", import.meta.url)), "utf8");
const p13ParentText = p13ProfilerText.slice(p13ProfilerText.indexOf("export async function runSuiteWorkflowTimingDiagnosticWatchdog("), p13ProfilerText.indexOf("async function suiteWorkflowTimingControllerWorker("));
const p13CompanionText = p13ProfilerText.slice(p13ProfilerText.indexOf("// P13 observes only"), p13ProfilerText.indexOf("interface WorkflowTimingControllerChild"));
const p13RecordText = p13ProfilerText.slice(p13ProfilerText.indexOf("function suiteInteger("), p13ProfilerText.indexOf("function suiteSource("));
const p13CompiledParent = ts.transpileModule(`${p13RecordText}\n${p13CompanionText}\n${p13ParentText}`.replace(/\bexport /g, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
type P13Outcome = NonNullable<NonNullable<P12ObservationLossReceipt["terminal"]>["controller_supervision"]>;
function p13EmptyReport(): SuiteWorkflowTimingDiagnosticReport {
  return { ...partialProgressReport(null), workload: "full-suite-workflow-timing", source_hashes: {}, progress: null, wait_receipt: null, costs: null, workflow_cases: null, continuity_receipt: null, limitations: [...SUITE_WORKFLOW_TIMING_LIMITATIONS] };
}
function p13FinalReport(): SuiteWorkflowTimingDiagnosticReport { return { ...p13EmptyReport(), source_hashes: workflowTimingSourceEnvelope().source_hashes }; }
const p13SourceMessage = () => workflowTimingSourceEnvelope();
const p13FrameMessage = () => ({ role: "suite-workflow-timing-frame", received_ms: 0, frame: { schema_version: 1, kind: "suite-progress-observation", sequence: 1, reporter_elapsed_ms: 0, event: "reporter-init", module: null, case: null, data: null } });
const p13FinalMessage = (report = p13FinalReport()) => ({ role: "suite-workflow-timing-report", report });
const p13RevocationMessage = () => ({ role: "suite-workflow-timing-receipts-unavailable" });
const p13ExitMessage = () => ({ role: "suite-workflow-timing-exit", native_exit: { code: 0, signal: null, received_ms: 0 } });
const p13ReceiptMessage = (kind: "p09" | "p11" | "p12", receipt: unknown = {}) => ({ role: kind === "p09" ? "suite-workflow-timing-receipt" : kind === "p11" ? "suite-workflow-timing-wait" : "suite-workflow-timing-continuity", receipt, received_ms: 0 });

interface P13ParentOptions {
  refuse?: "source" | "frame" | "progress" | "costs" | "workflow" | "final";
  throwAt?: "source" | "send" | "launch" | "supervise" | "await";
  outcome?: P13Outcome; now?: number; byteSize?: (value: string) => number;
}
/** Evaluate the exact parent/companion source with pure local boundary fakes.
 * This reaches defensive guards that full replay forbids (notably count/bytes
 * and independent projection refusals), without a production injection seam,
 * subprocess, real fixture, altered guard, timer or enlarged timeout.
 */
function p13ParentHarness(options: P13ParentOptions = {}) {
  const trace: string[] = [], child = new Child(); let now = options.now ?? 10;
  const fault = Object.defineProperty({}, "message", { get: vi.fn(() => { throw new Error("Unexpected error inspection"); }) });
  const call = <T>(name: string, action: () => T): T => { trace.push(name); return action(); };
  const project = (kind: "progress" | "costs" | "workflow") => ({ accept: () => call(`${kind}.accept`, () => options.refuse !== kind), snapshot: () => call(`${kind}.snapshot`, () => null) });
  const dependencies = {
    nodeTypes: p13NodeTypes, ProfileDeadline, SUITE_PROGRESS_LIMITS,
    Buffer: { byteLength: (value: string) => call("bytes", () => options.byteSize ? options.byteSize(value) : Buffer.byteLength(value)) },
    createSuiteProgressProjection: () => project("progress"), createSuiteAttributionCosts: () => project("costs"), createWorkflowCaseTimingProjection: () => project("workflow"),
    workflowTimingUnavailable: (deadline: ProfileDeadline, expired = false) => call("unavailable", () => ({ ...p13EmptyReport(), status: expired ? "deadline" : "failed", wall_ms: deadline.elapsed() })),
    compactSuiteProgress: (value: unknown) => call("compact", () => value),
    spanTime: (value: unknown) => call("spanTime", () => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 900000),
    sanitizeSuiteWorkflowTimingSourceMetadata: (value: unknown) => call("source", () => { if (options.throwAt === "source") throw fault; return options.refuse === "source" ? null : sanitizeSuiteWorkflowTimingSourceMetadata(value); }),
    sanitizeSuiteProgressFrame: (value: unknown) => call("frame", () => options.refuse === "frame" ? null : value),
    sanitizePlannerSpanReceipt: (value: unknown) => call("p09", () => value), sanitizePlannerWaitReceipt: (value: unknown) => call("p11", () => value), sanitizePlannerContinuityReceipt: (value: unknown) => call("p12", () => value),
    suiteExit: (value: unknown) => call("exit", () => value),
    sanitizeSuiteWorkflowTimingDiagnostic: (value: unknown) => call("final", () => options.refuse === "final" ? null : value),
    sourceHashesChanged: (before: Record<string, string>, after: Record<string, string>) => call("hashes", () => sourceHashesChanged(before, after)),
    superviseChild: (_child: Child, _deadline: ProfileDeadline, shutdown: number, signal: AbortSignal, phase: string) => call(`supervise:${shutdown}:${phase}`, () => {
      signal.addEventListener("abort", () => { trace.push("abort"); });
      if (options.throwAt === "supervise") throw fault;
      if (options.throwAt === "await") return Promise.reject(fault);
      return Promise.resolve(options.outcome ?? { exit_code: 0, closed: true, expired: false, failed: false });
    }),
  };
  const factory = new Function("deps", `const { nodeTypes, ProfileDeadline, SUITE_PROGRESS_LIMITS, Buffer, createSuiteProgressProjection, createSuiteAttributionCosts, createWorkflowCaseTimingProjection, workflowTimingUnavailable, compactSuiteProgress, spanTime, sanitizeSuiteWorkflowTimingSourceMetadata, sanitizeSuiteProgressFrame, sanitizePlannerSpanReceipt, sanitizePlannerWaitReceipt, sanitizePlannerContinuityReceipt, suiteExit, sanitizeSuiteWorkflowTimingDiagnostic, sourceHashesChanged, superviseChild } = deps;\n${p13CompiledParent}\nreturn { run: runSuiteWorkflowTimingDiagnosticWatchdog, capture: createP12ObservationLossCapture };`);
  const api = factory(dependencies) as { run: typeof runSuiteWorkflowTimingDiagnosticWatchdog; capture: typeof createP12ObservationLossCapture };
  const capture = api.capture(), clock = () => call("clock", () => now), launch = () => call("launch", () => { if (options.throwAt === "launch") throw fault; return child; });
  return {
    child, capture, trace, fault, api, setNow: (value: number) => { now = value; },
    async run(enabled = true, messages: unknown[] = [], after?: () => void) {
      child.send.mockImplementation(() => {
        trace.push("send"); if (options.throwAt === "send") throw fault;
        for (const message of messages) child.emit("message", message); after?.();
      });
      const report = await api.run(new ProfileDeadline(clock), launch, enabled ? capture.handle : undefined);
      return { report, receipt: capture.read(report), trace: [...trace] };
    },
  };
}
function p13CapturedReceipt(): P12ObservationLossReceipt {
  return { schema_version: 1, kind: "p12-observation-loss", observation_point: "watchdog-return", diagnostic_only: true, acceptance: false, sealed: true, capture_status: "captured", unavailable_reason: null,
    first_rejection: { site: "receipt-revocation-envelope-or-duplicate", role: "receipts-unavailable", counted_messages: 50009, accounted_ipc_bytes: 15181824, validated_frame_sequence: 50000, frame_sequence: 50000, source_seen: true, source_valid: true, final_seen: true, final_valid: true, receipt_set_revoked: true },
    terminal: { branch: "controller-supervision-failed", original_status: "failed", controller_supervision: { exit_code: Number.MIN_SAFE_INTEGER, closed: false, expired: false, failed: true } } };
}

describe("P13 closed parent-only rejection and terminal receipt", () => {
  it("freezes all 703 original test bytes, the fixture, six independent pins and every original budget", () => {
    const tests = readFileSync(fileURLToPath(new URL("./profile-maintenance.test.ts", import.meta.url))), prefix = tests.subarray(0, tests.indexOf(Buffer.from("// P13 additions preserve")) - 1);
    expect(createHash("sha256").update(prefix).digest("hex")).toBe("615c603b10a9148b67dc28d92bfaab12f81e444f5490af3a2c7194191bf59f2d");
    expect(createHash("sha256").update(readFileSync(failureFixturePath)).digest("hex")).toBe("93249820fd2c7edff923c1ccd8f70760abdce35ac55dca9e13ba7f606b406c87");
    const pins = ["7fa6fdc6eeeb3850e6b3166836f8c9199594c4f4bed3cee02cac0ca33d71894d", "a236001d048380e2c67d05423fc9ea3f26b07ee019ba8d6e622082f29d49102e", "cdafaf8e508042dddba72f8c7bbae84e2836ddb6b06c7026520c35d91af4e798", "e509f3cc1bd81ae6426265253fa926cbde02be5cebfe35b1df422017bffdca31", "bf6af6d2f4469911879a67e83b8f9e7b20332cf42795032c53457b10ccc1c617", "f07fc8036b066834143b14748bd70c436a6a2f15f648455af8d3a003a4eafc94"];
    expect(SUITE_WORKFLOW_TIMING_CONTRACT_HASHES).toEqual(pins); expect(SUITE_WORKFLOW_TIMING_SOURCES).toHaveLength(20); expect(SUITE_WORKFLOW_TIMING_SOURCES.slice(0, 19)).toEqual(SUITE_ATTRIBUTION_SOURCES);
    expect(SUITE_PROGRESS_LIMITS).toEqual({ frame_bytes: 2048, frames: 50000, stderr_bytes: 8388608, modules: 256, cases: 20000, open_cases: 64, tail: 32, snapshot_bytes: 131072 });
    expect(PROFILE_LIMIT_MS).toBe(900000); expect(PROFILE_CLEANUP_RESERVE_MS).toBe(30000);
    expect(p13ParentText).not.toMatch(/readFile|readdir|setTimeout|setInterval|process\.send|process\.stderr|process\.stdout|\.snapshot\(\).*reject/);
    expect(p13ParentText.match(/controller\.send\(/g)).toHaveLength(1); expect(p13ParentText.match(/controller\.on\("message"/g)).toHaveLength(1);
    expect(p13ParentText).toContain("++messages > 50008"); expect(p13ParentText).toContain("SUITE_PROGRESS_LIMITS.stderr_bytes + 2 * SUITE_PROGRESS_LIMITS.snapshot_bytes + 50000 * 128");
    expect(p13ParentText).toContain('superviseChild(controller, deadline, 1000, cancellation.signal, "cleanup")');
  });
  const guardCases: Array<{ site: typeof P12_OBSERVATION_REJECTION_SITES[number]; options?: P13ParentOptions; messages: () => unknown[] }> = [
    { site: "message-envelope", messages: () => [null] },
    { site: "message-after-final", messages: () => [p13SourceMessage(), p13FinalMessage(), p13SourceMessage()] },
    { site: "source-duplicate", messages: () => [p13SourceMessage(), p13SourceMessage()] },
    { site: "source-invalid", options: { refuse: "source" }, messages: () => [p13SourceMessage()] },
    { site: "source-required", messages: () => [p13FrameMessage()] },
    { site: "delta-envelope-or-time", messages: () => [p13SourceMessage(), { ...p13FrameMessage(), private: "PRIVATE" }] },
    { site: "frame-invalid", options: { refuse: "frame" }, messages: () => [p13SourceMessage(), p13FrameMessage()] },
    { site: "progress-replay", options: { refuse: "progress" }, messages: () => [p13SourceMessage(), p13FrameMessage()] },
    { site: "costs-replay", options: { refuse: "costs" }, messages: () => [p13SourceMessage(), p13FrameMessage()] },
    { site: "workflow-replay", options: { refuse: "workflow" }, messages: () => [p13SourceMessage(), p13FrameMessage()] },
    { site: "receipt-after-revocation", messages: () => [p13SourceMessage(), p13RevocationMessage(), p13ReceiptMessage("p12")] },
    ...(["p09", "p11", "p12"] as const).flatMap((kind) => [
      { site: `${kind}-duplicate` as typeof P12_OBSERVATION_REJECTION_SITES[number], messages: () => [p13SourceMessage(), p13ReceiptMessage(kind), p13ReceiptMessage(kind)] },
      { site: `${kind}-invalid` as typeof P12_OBSERVATION_REJECTION_SITES[number], messages: () => [p13SourceMessage(), p13ReceiptMessage(kind, null)] },
    ]),
    { site: "receipt-revocation-envelope-or-duplicate", messages: () => [p13SourceMessage(), p13RevocationMessage(), p13RevocationMessage()] },
    { site: "exit-envelope-or-duplicate", messages: () => [p13SourceMessage(), p13ExitMessage(), p13ExitMessage()] },
    { site: "exit-invalid-or-time", messages: () => [p13SourceMessage(), { ...p13ExitMessage(), native_exit: null }] },
    { site: "final-envelope", messages: () => [p13SourceMessage(), { ...p13FinalMessage(), extra: true }] },
    { site: "final-sanitizer", options: { refuse: "final" }, messages: () => [p13SourceMessage(), p13FinalMessage()] },
    { site: "final-binding", messages: () => [p13SourceMessage(), p13FinalMessage({ ...p13FinalReport(), source_hashes: {} })] },
    { site: "message-role", messages: () => [p13SourceMessage(), { role: "PRIVATE unknown role" }] },
    { site: "message-handler-exception", options: { throwAt: "source" }, messages: () => [p13SourceMessage()] },
  ];
  it.each(guardCases)("captures $site once without changing any original report, guard, clock or effect call", async ({ site, options, messages }) => {
    const disabled = p13ParentHarness(options), enabled = p13ParentHarness(options), list = messages();
    const old = await disabled.run(false, list), observed = await enabled.run(true, list);
    expect(observed.report).toEqual(old.report); expect(observed.trace).toEqual(old.trace); expect(observed.report.status).toBe("failed");
    expect(observed.receipt).toMatchObject({ capture_status: "captured", acceptance: false, first_rejection: { site }, terminal: { branch: "revoked", original_status: "failed", controller_supervision: { exit_code: 0, closed: true, expired: false, failed: false } } });
    expect(observed.report).toMatchObject({ source_hashes: {}, source_hashes_after: {}, progress: null, costs: null, workflow_cases: null, receipt: null, wait_receipt: null, continuity_receipt: null, native_exit: null, stdio_close: null, json: null });
    const before = enabled.capture.read(observed.report), trace = [...enabled.trace]; enabled.child.emit("message", p13FinalMessage()); enabled.child.emit("message", p13SourceMessage());
    expect(enabled.capture.read(observed.report)).toEqual(before); expect(enabled.trace).toEqual(trace); expect(JSON.stringify(before)).not.toContain("PRIVATE");
    expect(Object.getOwnPropertyDescriptor(enabled.fault, "message")!.get).not.toHaveBeenCalled();
  });
  it.each(["progress", "costs", "workflow"] as const)("keeps the independent %s refusal short-circuited at its original projection", async (kind) => {
    const harness = p13ParentHarness({ refuse: kind }), result = await harness.run(true, [p13SourceMessage(), p13FrameMessage()]);
    expect(result.trace.filter((entry) => entry.endsWith(".accept"))).toEqual(kind === "progress" ? ["progress.accept"] : kind === "costs" ? ["progress.accept", "costs.accept"] : ["progress.accept", "costs.accept", "workflow.accept"]);
    expect(result.receipt.first_rejection).toMatchObject({ site: `${kind}-replay`, role: "frame", counted_messages: 2, validated_frame_sequence: 0, frame_sequence: 1, source_seen: true, source_valid: true, final_seen: false, final_valid: false });
  });
  it.each(["extra", "time-type", "regression", "future"] as const)("honestly keeps the %s delta failure compound with the original clock short circuit", async (kind) => {
    const message = { ...p13FrameMessage(), received_ms: kind === "time-type" ? "PRIVATE" : kind === "regression" ? -1 : kind === "future" ? 11 : 0, ...(kind === "extra" ? { extra: true } : {}) };
    const harness = p13ParentHarness(), result = await harness.run(true, [p13SourceMessage(), message]);
    expect(result.receipt.first_rejection?.site).toBe("delta-envelope-or-time"); expect(result.trace.filter((entry) => entry === "frame")).toHaveLength(0);
    expect(result.trace.filter((entry) => entry === "clock")).toHaveLength(kind === "future" ? 4 : 3);
  });
  it("records the original counted value 50009 without claiming a receive ordinal or changing the IPC cap", async () => {
    const harness = p13ParentHarness({ byteSize: () => 0 }), message = p13FrameMessage(), messages = [p13SourceMessage(), ...Array.from({ length: 50008 }, () => message)];
    const result = await harness.run(true, messages);
    expect(result.receipt.first_rejection).toMatchObject({ site: "message-count", counted_messages: 50009, accounted_ipc_bytes: 50007 * 128, validated_frame_sequence: 1, frame_sequence: null });
    expect(result.trace.filter((entry) => entry === "frame")).toHaveLength(50007);
  });
  it("records the one original byte-cap overshoot only after all three projections pass", async () => {
    const budget = 8388608 + 2 * 131072 + 50000 * 128, harness = p13ParentHarness({ byteSize: (value) => value.includes('"role":"suite-workflow-timing-source"') ? budget : 1 });
    const result = await harness.run(true, [p13SourceMessage(), p13FrameMessage(), p13FinalMessage()]);
    expect(result.receipt.first_rejection).toMatchObject({ site: "ipc-byte-limit", role: "frame", counted_messages: 2, accounted_ipc_bytes: budget + 129, validated_frame_sequence: 1, frame_sequence: 1 });
    expect(result.trace.filter((entry) => entry.endsWith(".accept"))).toEqual(["progress.accept", "costs.accept", "workflow.accept"]); expect(result.report.progress).toBeNull();
  });
  it.each(["send", "launch", "supervise", "await"] as const)("records %s exceptions without inspecting the thrown value or changing abort/return order", async (throwAt) => {
    const disabled = p13ParentHarness({ throwAt }), enabled = p13ParentHarness({ throwAt }), old = await disabled.run(false), result = await enabled.run(true);
    expect(result.report).toEqual(old.report); expect(result.trace).toEqual(old.trace); expect(result.receipt.first_rejection?.site).toBe(throwAt === "send" ? "controller-send-exception" : "watchdog-exception");
    expect(result.receipt.terminal?.branch).toBe(throwAt === "send" ? "final-missing" : "watchdog-exception");
    expect(result.trace.includes("abort")).toBe(throwAt === "send"); expect(Object.getOwnPropertyDescriptor(enabled.fault, "message")!.get).not.toHaveBeenCalled();
  });
  const terminalCases: Array<{ branch: typeof P12_OBSERVATION_TERMINAL_BRANCHES[number]; options?: P13ParentOptions; final?: boolean; atReturn?: number }> = [
    { branch: "budget-before-launch", options: { now: 870000 } },
    { branch: "controller-not-closed", options: { outcome: { exit_code: null, closed: false, expired: true, failed: true } } },
    { branch: "controller-expired", options: { outcome: { exit_code: 0, closed: true, expired: true, failed: true } } },
    { branch: "controller-supervision-failed", options: { outcome: { exit_code: 1, closed: true, expired: false, failed: true } } },
    { branch: "controller-exit-nonzero", options: { outcome: { exit_code: -9, closed: true, expired: false, failed: false } } },
    { branch: "final-missing" }, { branch: "return-budget", final: true, atReturn: 900000 }, { branch: "report-returned", final: true },
  ];
  it.each(terminalCases)("retains the exact $branch branch and supervision tuple without a new clock sample", async ({ branch, options, final, atReturn }) => {
    const disabled = p13ParentHarness(options), enabled = p13ParentHarness(options), messages = final ? [p13SourceMessage(), p13FinalMessage()] : [];
    const old = await disabled.run(false, messages, () => { if (atReturn !== undefined) disabled.setNow(atReturn); }), result = await enabled.run(true, final ? [p13SourceMessage(), p13FinalMessage()] : [], () => { if (atReturn !== undefined) enabled.setNow(atReturn); });
    expect(result.report).toEqual(old.report); expect(result.trace).toEqual(old.trace);
    expect(result.receipt.terminal).toEqual({ branch, original_status: result.report.status, controller_supervision: branch === "budget-before-launch" ? null : options?.outcome ?? { exit_code: 0, closed: true, expired: false, failed: false } });
    expect(result.receipt.first_rejection?.site ?? null).toBe(branch === "budget-before-launch" ? "budget-before-launch" : null);
    if (branch === "budget-before-launch") expect(result.trace).toEqual(["clock", "unavailable", "clock"]);
  });
  it("does not replace a first rejection with a send exception, expiry or plausible final", async () => {
    const harness = p13ParentHarness({ outcome: { exit_code: null, closed: false, expired: true, failed: true } });
    const result = await harness.run(true, [p13SourceMessage(), p13SourceMessage(), p13FinalMessage()], () => { harness.setNow(900000); throw harness.fault; });
    expect(result.receipt).toMatchObject({ first_rejection: { site: "source-duplicate" }, terminal: { branch: "revoked", original_status: "deadline", controller_supervision: { closed: false, expired: true, failed: true } } });
    expect(result.report).toMatchObject({ status: "deadline", progress: null, source_hashes: {}, costs: null, workflow_cases: null, receipt: null, wait_receipt: null, continuity_receipt: null });
  });
  it("makes an unsupported outer tuple unavailable only in the diagnosis, never normalizing a signed exit", async () => {
    const harness = p13ParentHarness({ outcome: { exit_code: Number.POSITIVE_INFINITY, closed: true, expired: false, failed: false } }), result = await harness.run(true);
    expect(result.report.status).toBe("failed"); expect(result.receipt).toMatchObject({ capture_status: "unavailable", unavailable_reason: "invalid-state", first_rejection: null, terminal: null });
  });
});

describe("P13 real fake-child binding, negative evidence and lifecycle", () => {
  it.each([false, true])("keeps well-formed unavailable receipt/global revocation distinct from a parent rejection: revoke=%s", async (revoke) => {
    const child = new Child(), capture = createP12ObservationLossCapture(), unavailable = continuityHarness(); unavailable.observer.checkpoint("wait-return"); const receipt = unavailable.receipt();
    child.send.mockImplementation(() => { child.emit("message", p13SourceMessage()); child.emit("message", p13ReceiptMessage("p12", receipt)); if (revoke) child.emit("message", p13RevocationMessage()); child.emit("close", -7); });
    const report = await runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child, capture.handle), observation = capture.read(report);
    expect(observation).toMatchObject({ capture_status: "captured", first_rejection: null, terminal: { branch: "controller-exit-nonzero", controller_supervision: { exit_code: -7, closed: true, expired: false, failed: false } } });
    expect(report.continuity_receipt).toEqual(revoke ? null : receipt); expect(Object.keys(report.source_hashes)).toHaveLength(20); expect(child.signals).toEqual([]);
  });
  it("binds once to the exact returned report, keeps reads detached and ignores late hostile payloads", async () => {
    const child = new Child(), capture = createP12ObservationLossCapture(), trap = vi.fn(), completed = await completedWorkflowTimingReport(), clock = vi.fn(() => 10);
    expect(capture.read(new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap }))).toMatchObject({ capture_status: "unavailable", unavailable_reason: "incomplete-observation" });
    child.send.mockImplementation(() => { child.emit("message", p13SourceMessage()); emitWorkflowTimingFrames(child); emitWorkflowTimingReceipts(child, completed); child.emit("message", { role: "suite-workflow-timing-exit", native_exit: completed.native_exit }); child.emit("message", p13FinalMessage(completed)); child.emit("close", 0); });
    const report = await runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(clock), () => child, capture.handle), original = capture.read(report);
    expect(report).toEqual(completed); expect(original).toMatchObject({ first_rejection: null, terminal: { branch: "report-returned", original_status: "completed" } });
    expect(capture.read({ ...report })).toMatchObject({ unavailable_reason: "invalid-binding" }); expect(capture.read(new Proxy(report, { get: trap }))).toMatchObject({ unavailable_reason: "invalid-binding" });
    const mutable = capture.read(report); mutable.terminal!.controller_supervision!.exit_code = 99; expect(capture.read(report)).toEqual(original);
    const reads = clock.mock.calls.length; child.emit("message", new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap })); child.emit("message", p13FinalMessage(completed)); child.emit("close", 3);
    expect(capture.read(report)).toEqual(original); expect(clock).toHaveBeenCalledTimes(reads); expect(trap).not.toHaveBeenCalled();
    const otherChild = new Child(); otherChild.send.mockImplementation(() => { otherChild.emit("message", null); otherChild.emit("close", 0); });
    const other = await runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(() => 10), () => otherChild, capture.handle);
    expect(capture.read(other)).toMatchObject({ unavailable_reason: "invalid-binding" }); expect(capture.read(report)).toEqual(original);
  });
  it.each(["plain", "getter", "proxy", "function", "null"] as const)("refuses a foreign %s handle without evaluating it or changing execution", async (kind) => {
    const trap = vi.fn(), fake = kind === "plain" ? {} : kind === "getter" ? Object.defineProperty({}, "capture", { get: trap }) : kind === "proxy" ? new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap }) : kind === "function" ? () => trap() : null;
    const child = new Child(); child.send.mockImplementation(() => { child.emit("close", 0); });
    const report = await runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child, fake);
    expect(report).toEqual(p13EmptyReport()); expect(trap).not.toHaveBeenCalled(); expect(child.send).toHaveBeenCalledOnce(); expect(child.signals).toEqual([]);
  });
  it("rejects handle reuse during an in-flight invocation without minting or replacing its observation", async () => {
    const capture = createP12ObservationLossCapture(), first = new Child(), second = new Child(); second.send.mockImplementation(() => { second.emit("close", -1); });
    const pending = runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(() => 10), () => first, capture.handle);
    const other = await runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(() => 10), () => second, capture.handle);
    expect(capture.read(other).unavailable_reason).toBe("incomplete-observation"); first.emit("close", 0); const report = await pending;
    expect(capture.read(report)).toMatchObject({ capture_status: "captured", terminal: { branch: "final-missing" } }); expect(capture.read(other).unavailable_reason).toBe("invalid-binding");
  });
  it.each(["completed", "send-failure", "expiry"] as const)("preserves actual %s supervisor signals, detach/cleanup and clock order with observation on/off", async (kind) => {
    vi.useFakeTimers();
    const completed = await completedWorkflowTimingReport();
    const execute = async (enabled: boolean) => {
      const child = new Child(), capture = createP12ObservationLossCapture(), trace: string[] = [], started = Date.now();
      const clock = () => { trace.push("clock"); return kind === "expiry" ? Date.now() - started : 10; };
      child.send.mockImplementation(() => {
        trace.push("send"); if (kind === "send-failure") throw Object.defineProperty({}, "message", { get: () => { throw new Error("Unexpected private getter"); } });
        if (kind === "completed") { child.emit("message", p13SourceMessage()); emitWorkflowTimingFrames(child); emitWorkflowTimingReceipts(child, completed); child.emit("message", { role: "suite-workflow-timing-exit", native_exit: completed.native_exit }); child.emit("message", p13FinalMessage(completed)); child.emit("close", 0); }
      });
      const pending = runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(clock), () => { trace.push("launch"); return child; }, enabled ? capture.handle : undefined);
      if (kind !== "completed") await vi.advanceTimersByTimeAsync(kind === "expiry" ? 900000 : 2000);
      const report = await pending;
      return { report, observation: capture.read(report), trace, signals: child.signals, detach: [child.stdout.destroy.mock.calls.length, child.stderr.destroy.mock.calls.length, child.disconnect.mock.calls.length, child.channel.unref.mock.calls.length, child.unref.mock.calls.length] };
    };
    const old = await execute(false), observed = await execute(true);
    expect(observed.report).toEqual(old.report); expect(observed.trace).toEqual(old.trace); expect(observed.signals).toEqual(old.signals); expect(observed.detach).toEqual(old.detach);
    expect(observed.signals).toEqual(kind === "completed" ? [] : ["SIGTERM", "SIGKILL"]); expect(observed.observation.capture_status).toBe("captured");
  });
});

describe("P13 privacy, fixed numeric bounds and optional single-write output", () => {
  it("has closed detached nested DTOs and no path, error, credential, payload or source dictionaries", () => {
    const input = p13CapturedReceipt(), receipt = sanitizeP12ObservationLossReceipt(input)!; expect(receipt).toEqual(input);
    input.first_rejection!.counted_messages = 1; input.terminal!.controller_supervision!.exit_code = 1; expect(receipt.first_rejection!.counted_messages).toBe(50009); expect(receipt.terminal!.controller_supervision!.exit_code).toBe(Number.MIN_SAFE_INTEGER);
    expect(Object.keys(receipt)).toEqual(["schema_version", "kind", "observation_point", "diagnostic_only", "acceptance", "sealed", "capture_status", "unavailable_reason", "first_rejection", "terminal"]);
    const json = JSON.stringify(receipt); expect(json).not.toMatch(/PRIVATE|source_hashes|fixture|module|case_name|task_id|payload|stack|token|credential|[A-Z]:\\/);
  });
  const boundCases: Array<[string, unknown, boolean]> = [
    ["counted_messages", 0, true], ["counted_messages", 50009, true], ["counted_messages", 50010, false], ["counted_messages", -1, false], ["counted_messages", 0.5, false],
    ["accounted_ipc_bytes", 15181824, true], ["accounted_ipc_bytes", 15181825, false], ["accounted_ipc_bytes", -1, false],
    ["validated_frame_sequence", 50000, true], ["validated_frame_sequence", 50001, false], ["frame_sequence", null, true], ["frame_sequence", 0, true], ["frame_sequence", 50000, true], ["frame_sequence", 50001, false],
    ["frame_sequence", NaN, false], ["frame_sequence", Infinity, false], ["role", "receipts-unavailable", true], ["role", null, true], ["role", "PRIVATE", false], ["source_seen", 1, false], ["final_valid", null, false],
  ];
  it.each(boundCases)("checks bounded first-rejection field %s=%s", (field, value, valid) => {
    const input = p13CapturedReceipt(); Object.assign(input.first_rejection!, { [field]: value }); expect(sanitizeP12ObservationLossReceipt(input) !== null).toBe(valid);
  });
  it.each([null, Number.MIN_SAFE_INTEGER, -9, 0, Number.MAX_SAFE_INTEGER, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])("preserves only nullable signed safe outer exit %s", (exit_code) => {
    const input = p13CapturedReceipt(); input.terminal!.controller_supervision!.exit_code = exit_code; const receipt = sanitizeP12ObservationLossReceipt(input), valid = exit_code === null || Number.isSafeInteger(exit_code);
    expect(receipt !== null).toBe(valid); if (valid) expect(receipt!.terminal!.controller_supervision!.exit_code).toBe(exit_code);
  });
  it.each(["root", "first", "terminal", "supervision"] as const)("refuses unknown, accessor and Proxy %s fields without reading error getters", (level) => {
    const trap = vi.fn(), receipt = p13CapturedReceipt(), object = level === "root" ? receipt : level === "first" ? receipt.first_rejection! : level === "terminal" ? receipt.terminal! : receipt.terminal!.controller_supervision!;
    const wrap = (value: unknown) => level === "root" ? value : level === "first" ? { ...receipt, first_rejection: value } : level === "terminal" ? { ...receipt, terminal: value } : { ...receipt, terminal: { ...receipt.terminal!, controller_supervision: value } };
    for (const value of [{ ...object, private: "PRIVATE" }, Object.defineProperty({ ...object }, Object.keys(object)[0]!, { enumerable: true, get: trap }), new Proxy(object, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap })]) expect(sanitizeP12ObservationLossReceipt(wrap(value))).toBeNull();
    expect(trap).not.toHaveBeenCalled();
  });
  it.each(["invalid-binding", "incomplete-observation", "invalid-state"] as const)("keeps unavailable %s evidence empty and non-accepting", (unavailable_reason) => {
    const input = { ...p13CapturedReceipt(), capture_status: "unavailable", unavailable_reason, first_rejection: null, terminal: null };
    expect(sanitizeP12ObservationLossReceipt(input)).toEqual(input); expect(sanitizeP12ObservationLossReceipt({ ...input, first_rejection: p13CapturedReceipt().first_rejection })).toBeNull(); expect(sanitizeP12ObservationLossReceipt({ ...input, terminal: p13CapturedReceipt().terminal })).toBeNull();
  });
  it.each([
    ["schema_version", 2], ["kind", "PRIVATE"], ["observation_point", "elsewhere"], ["diagnostic_only", false], ["acceptance", true], ["sealed", false],
    ["capture_status", "success"], ["unavailable_reason", "PRIVATE"], ["terminal", null],
  ])("refuses a changed root literal %s", (field, value) => { expect(sanitizeP12ObservationLossReceipt({ ...p13CapturedReceipt(), [field as string]: value })).toBeNull(); });
  it.each(["branch", "original_status", "closed", "expired", "failed"] as const)("refuses unsupported terminal %s data", (field) => {
    const receipt = p13CapturedReceipt(); if (field === "branch" || field === "original_status") Object.assign(receipt.terminal!, { [field]: "PRIVATE" }); else Object.assign(receipt.terminal!.controller_supervision!, { [field]: 1 });
    expect(sanitizeP12ObservationLossReceipt(receipt)).toBeNull();
  });
  it("never reads caller report contents, even after the bound report becomes accessor-hostile", async () => {
    const capture = createP12ObservationLossCapture(), child = new Child(), trap = vi.fn(), write = vi.fn(); child.send.mockImplementation(() => { child.emit("close", 0); });
    const report = await runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child, capture.handle), receipt = capture.read(report);
    Object.defineProperty(report, "status", { enumerable: true, get: trap }); Object.defineProperty(report, "source_hashes", { enumerable: true, get: trap });
    expect(capture.read(report)).toEqual(receipt); capture.emit(report, "{}\n", write); expect(write).toHaveBeenCalledOnce(); expect(trap).not.toHaveBeenCalled();
  });
  it("fits every maximum enum-width/counter combination within 2048 bytes and the ordinary joint final", async () => {
    const report = await completedWorkflowTimingReport(), originalLine = `${JSON.stringify(report)}\n`, original = JSON.stringify(report);
    for (const site of P12_OBSERVATION_REJECTION_SITES) for (const branch of P12_OBSERVATION_TERMINAL_BRANCHES) {
      const receipt = p13CapturedReceipt(); receipt.first_rejection!.site = site; receipt.terminal!.branch = branch; const line = formatP12ObservationLossLine(receipt, originalLine)!;
      expect(line).not.toBeNull(); expect(Buffer.byteLength(line)).toBeLessThanOrEqual(2048); expect(JSON.parse(line.slice("P12_OBSERVATION_LOSS_PROFILE ".length))).toEqual(receipt);
      expect(Buffer.byteLength(`${JSON.stringify({ role: "suite-workflow-timing-report", report })}\n${line}`)).toBeLessThanOrEqual(131072);
    }
    expect(JSON.stringify(report)).toBe(original);
  });
  it.each([2048, 2049])("enforces the literal %s whole-line boundary including prefix/LF without truncating JSON", (size) => {
    const original = JSON.stringify, receipt = p13CapturedReceipt(), raw = original(receipt), prefix = "P12_OBSERVATION_LOSS_PROFILE ";
    vi.spyOn(JSON, "stringify").mockImplementation(((value: unknown) => (value as { kind?: unknown })?.kind === "p12-observation-loss" ? raw.padEnd(size - prefix.length - 1, " ") : original(value)) as typeof JSON.stringify);
    const line = formatP12ObservationLossLine(receipt, "{}\n");
    if (size === 2048) { expect(Buffer.byteLength(line!)).toBe(2048); expect(JSON.parse(line!.slice(prefix.length))).toEqual(receipt); } else expect(line).toBeNull();
  });
  it.each([131072, 131073])("preserves original evidence at the exact joint %s-byte edge and suppresses only the extra line", (size) => {
    const receipt = p13CapturedReceipt(), ordinary = formatP12ObservationLossLine(receipt, "{}\n")!, wrapper = Buffer.byteLength('{"role":"suite-workflow-timing-report","report":') + 1;
    const original = "{}".padEnd(size - wrapper - Buffer.byteLength(ordinary) - 1, " ") + "\n", line = formatP12ObservationLossLine(receipt, original), bytes = Buffer.byteLength(original);
    expect(JSON.parse(original)).toEqual({}); expect(line !== null).toBe(size === 131072); expect(Buffer.byteLength(original)).toBe(bytes);
    if (line) expect(bytes + wrapper + Buffer.byteLength(line)).toBe(131072);
  });
  it("jointly fits real maximum rosters/rankings, 32 full frame slots, three full receipt slots and the widest diagnosis", async () => {
    const projection = createSuiteProgressProjection(), costs = createSuiteAttributionCosts(), workflow = createWorkflowCaseTimingProjection(), tail: SuiteProgressFrame[] = []; let sequence = 0, valid = true;
    const moduleSource = (ordinal: number) => ordinal === 17 ? "runner/workflow-orchestrator.test.ts" : `${ordinal < 17 ? "lib" : "scripts"}/${String(ordinal).padStart(3, "0")}-${"x".repeat(ordinal < 17 ? 176 : 172)}.test.ts`;
    const push = (event: SuiteProgressFrame["event"], ordinal: number | null = null, data: unknown = null, test: number | null = null, elapsed = 0) => {
      const frame = { schema_version: 1, kind: "suite-progress-observation", sequence: ++sequence, reporter_elapsed_ms: elapsed, event, module: ordinal === null ? null : { ordinal, source: moduleSource(ordinal) }, case: test === null ? null : { ordinal: test, alias: null }, data } as SuiteProgressFrame;
      valid = projection.accept(frame) && costs.accept(frame) && workflow.accept(frame) && valid; tail.push(frame); if (tail.length > 32) tail.shift();
    };
    push("reporter-init"); push("run-start", null, { module_count: 256 });
    for (let ordinal = 1; ordinal <= 256; ordinal++) { push("module-queued", ordinal); push("module-collected", ordinal, { case_count: ordinal === 17 ? 19940 : ordinal === 256 ? 60 : 0 }); push("module-start", ordinal); }
    for (let ordinal = 1; ordinal <= 20; ordinal++) { push("case-ready", 17, null, ordinal, ordinal * 3 - 2); push("case-result", 17, { state: "passed", original_attempt: null }, ordinal, ordinal * 3 - 1); }
    for (let ordinal = 21; ordinal <= 19936; ordinal++) push("case-result", 17, { state: "skipped", original_attempt: null }, ordinal, 60);
    for (let ordinal = 19937; ordinal <= 19940; ordinal++) push("case-ready", 17, null, ordinal, ordinal - 19876);
    for (let ordinal = 1; ordinal <= 60; ordinal++) push("case-ready", 256, null, ordinal, 65);
    for (let ordinal = 1; ordinal <= 252; ordinal++) push("module-end", ordinal, { state: ordinal === 17 ? "failed" : "passed" }, null, 899999.9999999999);
    const progress = projection.snapshot()!, cost = costs.snapshot()!, cases = workflow.snapshot()!;
    expect(valid).toBe(true); expect(progress.counts.collected).toBe(20000); expect(progress.open_cases).toHaveLength(64); expect(progress.tail).toHaveLength(32); expect(cost.ended?.top).toHaveLength(16); expect(cost.start_without_end?.top).toHaveLength(4); expect(cases.ended?.top).toHaveLength(16); expect(cases.open?.top).toHaveLength(4); expect(cases.coverage?.gaps.top).toHaveLength(4);
    let clocks = 0, settle!: () => void; const original = new Promise<void>((done) => { settle = done; }), harness = continuityHarness({ clock: () => clocks++ === 0 ? 0 : 899999.9999999999 });
    harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => original); harness.observer.checkpoint("wait-enter"); harness.observer.observePoll(() => undefined); settle(); await Promise.resolve();
    for (let index = 0; index < 64; index++) { harness.controller.release(harness.options.workflowExecution); harness.controller.reconcile(); }
    for (let index = 1; index < 256; index++) harness.observer.observePoll(() => undefined); harness.observer.checkpoint("wait-return");
    const continuity = harness.receipt(), wait = await completeWaitReceipt(), span = completeSpanReceipt(), source = workflowTimingSourceEnvelope();
    const report: SuiteWorkflowTimingDiagnosticReport = { ...p13EmptyReport(), wall_ms: 900000, source_hashes: source.source_hashes, source_hashes_after: { ...source.source_hashes }, source_drift: false, progress: compactSuiteProgress(progress), receipt: span, wait_receipt: wait, continuity_receipt: continuity, costs: cost, workflow_cases: cases };
    const safe = sanitizeSuiteWorkflowTimingDiagnostic(report, failureSourceLimits, { progress, costs: cost, workflow_cases: cases }); expect(safe).not.toBeNull();
    let serialized = JSON.stringify(safe);
    for (const receipt of [span, wait, continuity]) { const raw = JSON.stringify(receipt); serialized = serialized.replace(raw, raw.padEnd(8192, " ")); }
    for (const frame of tail) { const raw = JSON.stringify(frame); serialized = serialized.replace(raw, raw.padEnd(2048, " ")); }
    expect(JSON.parse(serialized)).toEqual(safe); const line = formatP12ObservationLossLine(p13CapturedReceipt(), `${serialized}\n`)!;
    expect(line).not.toBeNull(); expect(Buffer.byteLength(line)).toBeLessThanOrEqual(2048); expect(Buffer.byteLength(`{"role":"suite-workflow-timing-report","report":${serialized}}\n${line}`)).toBeLessThanOrEqual(131072);
    expect(sanitizeSuiteWorkflowTimingSourceMetadata({ ...source, sourceLimits: { line_columns: Array.from({ length: 10000 }, () => 65536) } })).not.toBeNull();
    expect(1 + 50000 + 3 + 1 + 1 + 1).toBeLessThanOrEqual(50008); expect(8388608 + 50000 * 128 + 3 * 8192 + 128 + 256 + 131072).toBeLessThanOrEqual(8388608 + 2 * 131072 + 50000 * 128);
  });
  it.each(["throw", "false", "reentrant", "suppressed"] as const)("makes the optional %s writer sticky, once-only and unable to change original output/status", async (kind) => {
    const capture = createP12ObservationLossCapture(), child = new Child(); child.send.mockImplementation(() => { child.emit("close", 0); });
    const report = await runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child, capture.handle), original = `${JSON.stringify(report)}\n`, exit = report.status === "completed" ? 0 : 1;
    const write = vi.fn<(line: string) => unknown>(() => { if (kind === "throw") throw new Error("PRIVATE writer error"); if (kind === "reentrant") capture.emit(report, original, write); return false; });
    const line = kind === "suppressed" ? original.padEnd(131073, " ") + "\n" : original;
    expect(() => capture.emit(report, line, write)).not.toThrow(); capture.emit(report, original, write);
    expect(write).toHaveBeenCalledTimes(kind === "suppressed" ? 0 : 1); expect(`${JSON.stringify(report)}\n`).toBe(original); expect(exit).toBe(1); expect(report.status).toBe("failed");
    if (kind !== "suppressed") { expect(typeof write.mock.calls[0]![0]).toBe("string"); expect(Buffer.byteLength(write.mock.calls[0]![0])).toBeLessThanOrEqual(2048); expect(write.mock.calls[0]![0]).not.toContain("PRIVATE"); }
  });
  it("uses the unchanged CLI selection/stdout/exit exception path before its one optional diagnostic write", async () => {
    const cli = p13ProfilerText.slice(p13ProfilerText.lastIndexOf('} else if (process.argv[1] && resolve(process.argv[1]) === script) {') + 2);
    const start = cli.indexOf("  try {"), body = cli.slice(start, cli.lastIndexOf("}"));
    const code = ts.transpileModule(`async function invoke(){${body}}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    for (const workload of ["full-suite-workflow-timing", "full-suite-attribution"] as const) for (const mode of ["normal", "stderr-throw", "stdout-throw"] as const) for (const status of ["completed", "failed", "deadline"] as const) {
      const report = { ...p13EmptyReport(), status }, exit = status === "completed" ? 0 : 1, order: string[] = [], stdout: string[] = [], stderr: string[] = [], handle = {}, processFake = { argv: ["node", "profiler"], exitCode: undefined as number | undefined, stdout: { write: (line: string) => { order.push("stdout"); if (mode === "stdout-throw" && stdout.length === 0) { stdout.push("attempt"); throw new Error("PRIVATE stdout"); } stdout.push(line); } } };
      const capture = () => { order.push("capture"); return { handle, emit: (value: unknown, line: string) => { expect(value).toBe(report); expect(line).toBe(`${JSON.stringify(report)}\n`); expect(processFake.exitCode).toBe(exit); order.push("emit"); try { if (mode === "stderr-throw") throw new Error("PRIVATE stderr"); stderr.push("diagnostic"); } catch { /* Diagnostic-only failure. */ } } }; };
      const watchdog = async (_deadline?: unknown, _launch?: unknown, observed?: unknown) => { order.push("watchdog"); expect(observed).toBe(workload === "full-suite-workflow-timing" ? handle : undefined); return report; };
      const invoke = new Function("process", "parseProfileArguments", "createP12ObservationLossCapture", "runSuiteWorkflowTimingDiagnosticWatchdog", "runSuiteAttributionDiagnosticWatchdog", `${code}\nreturn invoke;`)(processFake, () => workload, capture, watchdog, watchdog) as () => Promise<void>;
      await invoke(); expect(processFake.exitCode).toBe(mode === "stdout-throw" ? 1 : exit);
      if (mode === "stdout-throw") { expect(order).not.toContain("emit"); expect(stdout.at(-1)).toBe('{"schema_version":1,"status":"failed","reason":"invalid-selection-or-measurement-unavailable"}\n'); }
      else { expect(stdout).toEqual([`${JSON.stringify(report)}\n`]); expect(order).toEqual(workload === "full-suite-workflow-timing" ? ["capture", "watchdog", "stdout", "emit"] : ["watchdog", "stdout"]); }
      expect(stderr).toEqual(workload === "full-suite-workflow-timing" && mode === "normal" ? ["diagnostic"] : []);
    }
  });
});

// P14 additions preserve the complete 828-test prefix byte for byte.
import { formatP14DeltaRejectionLine, P14_DELTA_CONDITIONS, sanitizeP14DeltaRejectionReceipt, type P14DeltaRejectionReceipt } from "./profile-maintenance";
type P14Condition = typeof P14_DELTA_CONDITIONS[number];
type P14Role = NonNullable<P14DeltaRejectionReceipt["delta"]>["role"];
const p14Roles = ["frame", "p09", "p11", "p12"] as const;
function p14Message(role: P14Role, received_ms: unknown = 0): Record<string, unknown> { return { ...(role === "frame" ? p13FrameMessage() : p13ReceiptMessage(role)), received_ms }; }
function p14Receipt(condition: P14Condition = "after-parent-elapsed"): P14DeltaRejectionReceipt {
  const measured = condition === "delivery-regression" || condition === "after-parent-elapsed";
  return { schema_version: 1, kind: "p14-delta-rejection", observation_point: "watchdog-return", diagnostic_only: true, acceptance: false, sealed: true, capture_status: "captured", unavailable_reason: null,
    delta: { condition, role: "frame", counted_messages: 3, received_ms: measured ? 5.25 : null, previous_delivery_ms: measured ? 5.5 : null, parent_elapsed_ms: condition === "after-parent-elapsed" ? 5 : null } };
}
interface P14HarnessOptions extends P13ParentOptions { legacyGuard?: boolean; throwPredicate?: "exact" | "range" | "clock" }
/** Test-only evaluated source. Private fault injection exists only in this
 * returned local closure, never in the production factory/watchdog API. */
function p14ParentHarness(options: P14HarnessOptions = {}) {
  const trace: string[] = [], failures: unknown[] = [], child = new Child(); let now = options.now ?? 10, clockCalls = 0;
  const errorGetter = vi.fn(), fault = Object.defineProperty({}, "message", { get: errorGetter });
  const call = <T>(name: string, action: () => T): T => { trace.push(name); return action(); };
  const fail = (): never => { failures.push(fault); throw fault; };
  const project = (kind: "progress" | "costs" | "workflow") => ({ accept: () => call(`${kind}.accept`, () => options.refuse !== kind), snapshot: () => call(`${kind}.snapshot`, () => null) });
  const dependencies = {
    nodeTypes: p13NodeTypes, ProfileDeadline, SUITE_PROGRESS_LIMITS, trace, fault,
    Buffer: { byteLength: (value: string) => call("bytes", () => options.byteSize ? options.byteSize(value) : Buffer.byteLength(value)) },
    createSuiteProgressProjection: () => project("progress"), createSuiteAttributionCosts: () => project("costs"), createWorkflowCaseTimingProjection: () => project("workflow"),
    workflowTimingUnavailable: (deadline: ProfileDeadline, expired = false) => call("unavailable", () => ({ ...p13EmptyReport(), status: expired ? "deadline" : "failed", wall_ms: deadline.elapsed() })),
    compactSuiteProgress: (value: unknown) => call("compact", () => value),
    spanTime: (value: unknown) => call("range", () => options.throwPredicate === "range" ? fail() : typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 900000),
    sanitizeSuiteWorkflowTimingSourceMetadata: (value: unknown) => call("source", () => options.throwAt === "source" ? fail() : options.refuse === "source" ? null : sanitizeSuiteWorkflowTimingSourceMetadata(value)),
    sanitizeSuiteProgressFrame: (value: unknown) => call("frame", () => options.refuse === "frame" ? null : value),
    sanitizePlannerSpanReceipt: (value: unknown) => call("p09", () => value), sanitizePlannerWaitReceipt: (value: unknown) => call("p11", () => value), sanitizePlannerContinuityReceipt: (value: unknown) => call("p12", () => value),
    suiteExit: (value: unknown) => call("exit", () => value), sanitizeSuiteWorkflowTimingDiagnostic: (value: unknown) => call("final", () => options.refuse === "final" ? null : value),
    sourceHashesChanged: (before: Record<string, string>, after: Record<string, string>) => call("hashes", () => sourceHashesChanged(before, after)),
    superviseChild: (_child: Child, _deadline: ProfileDeadline, shutdown: number, signal: AbortSignal, phase: string) => call(`supervise:${shutdown}:${phase}`, () => {
      signal.addEventListener("abort", () => { trace.push("abort"); }); if (options.throwAt === "supervise") fail();
      return options.throwAt === "await" ? Promise.reject(fault) : Promise.resolve(options.outcome ?? { exit_code: 0, closed: true, expired: false, failed: false });
    }),
    exactGuard: () => { trace.push("exact"); if (options.throwPredicate === "exact") fail(); },
  };
  let parent = p13ParentText;
  if (options.legacyGuard) {
    const start = parent.indexOf("          let deltaCondition: P14DeltaCondition"), end = parent.indexOf("\n          if (frameKind)", start);
    if (start < 0 || end <= start) throw new Error("Synthetic original guard boundary unavailable");
    parent = parent.slice(0, start) + '          if (!suiteExact(value, keys) || !spanTime(data.received_ms) || data.received_ms < lastDelivery || data.received_ms > deadline.elapsed()) { reject("delta-envelope-or-time", data); revoked = true; return; } lastDelivery = data.received_ms;' + parent.slice(end);
  }
  parent = parent.replace(/\bsuiteRecord\(/g, "guardRecord(").replace(/\bsuiteExact\(/g, "guardExact(");
  const compiled = ts.transpileModule(`${p13RecordText}\n${p13CompanionText}\n${parent}`.replace(/\bexport /g, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const build = new Function("deps", `const { nodeTypes, ProfileDeadline, SUITE_PROGRESS_LIMITS, Buffer, createSuiteProgressProjection, createSuiteAttributionCosts, createWorkflowCaseTimingProjection, workflowTimingUnavailable, compactSuiteProgress, spanTime, sanitizeSuiteWorkflowTimingSourceMetadata, sanitizeSuiteProgressFrame, sanitizePlannerSpanReceipt, sanitizePlannerWaitReceipt, sanitizePlannerContinuityReceipt, suiteExit, sanitizeSuiteWorkflowTimingDiagnostic, sourceHashesChanged, superviseChild } = deps;\n${compiled}\nfunction guardRecord(value, maximum) { deps.trace.push("record"); return suiteRecord(value, maximum); }\nfunction guardExact(value, keys) { deps.exactGuard(); return suiteExact(value, keys); }\nreturn { run: runSuiteWorkflowTimingDiagnosticWatchdog, capture: createP12ObservationLossCapture, privateState: (handle) => observationLossHandles.get(handle), poisonDelta: (mode) => { const original = sanitizeP14DeltaRejectionReceipt; sanitizeP14DeltaRejectionReceipt = mode === "throw" ? () => { throw deps.fault; } : () => null; return () => { sanitizeP14DeltaRejectionReceipt = original; }; } };`);
  const api = build(dependencies) as { run: typeof runSuiteWorkflowTimingDiagnosticWatchdog; capture: typeof createP12ObservationLossCapture; privateState: (handle: object) => Record<string, unknown>; poisonDelta: (mode: "throw" | "null") => () => void };
  const capture = api.capture(), clock = () => call("clock", () => { clockCalls++; if (options.throwPredicate === "clock" && clockCalls === 2) fail(); return now; });
  return {
    child, capture, api, trace, failures, fault, errorGetter, setNow: (value: number) => { now = value; },
    async run(messages: unknown[] = [], after?: () => void, enabled = true) {
      child.send.mockImplementation(() => { trace.push("send"); if (options.throwAt === "send") fail(); for (const value of messages) child.emit("message", value); after?.(); });
      const report = await api.run(new ProfileDeadline(clock), () => call("launch", () => options.throwAt === "launch" ? fail() : child), enabled ? capture.handle : undefined);
      return { report, p13: capture.read(report), p14: capture.readDelta(report), trace: [...trace] };
    },
  };
}
async function p14BoundTarget(condition: P14Condition = "after-parent-elapsed") {
  const capture = createP12ObservationLossCapture(), child = new Child(), clock = vi.fn(() => 10);
  const target = p14Message("frame", condition === "delivery-regression" ? 4.25 : condition === "received-ms-range" ? NaN : 10.25);
  if (condition === "envelope-shape") target.extra = "PRIVATE";
  child.send.mockImplementation(() => { child.emit("message", p13SourceMessage()); emitWorkflowTimingFrames(child, completeProgress(), 5); child.emit("message", target); child.emit("close", 0); });
  const report = await runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(clock), () => child, capture.handle);
  return { capture, child, clock, report, p13: capture.read(report), p14: capture.readDelta(report) };
}

describe("P14 original delta guard discrimination and evaluation equivalence", () => {
  it("preserves every byte of all 828 prior tests and the original fixture, source/pin and IPC boundaries", () => {
    const tests = readFileSync(fileURLToPath(new URL("./profile-maintenance.test.ts", import.meta.url))), prefix = tests.subarray(0, tests.indexOf(Buffer.from("// P14 additions preserve")) - 1);
    expect(createHash("sha256").update(prefix).digest("hex")).toBe("29a4a08160bf277011e81327ed4bcc59b02d1f246f9c5ee394ad7fc3b276e863");
    expect(createHash("sha256").update(readFileSync(failureFixturePath)).digest("hex")).toBe("93249820fd2c7edff923c1ccd8f70760abdce35ac55dca9e13ba7f606b406c87");
    expect(P14_DELTA_CONDITIONS).toEqual(["envelope-shape", "received-ms-range", "delivery-regression", "after-parent-elapsed"]);
    expect(P12_OBSERVATION_REJECTION_SITES).toContain("delta-envelope-or-time"); expect(P12_OBSERVATION_REJECTION_SITES).not.toContain("delivery-regression");
    expect(SUITE_WORKFLOW_TIMING_SOURCES).toHaveLength(20); expect(SUITE_WORKFLOW_TIMING_SOURCES.slice(0, 19)).toEqual(SUITE_ATTRIBUTION_SOURCES); expect(SUITE_WORKFLOW_TIMING_CONTRACT_HASHES).toHaveLength(6);
    expect(p13ParentText.match(/controller\.send\(/g)).toHaveLength(1); expect(p13ParentText.match(/controller\.on\("message"/g)).toHaveLength(1);
    expect(p13ParentText).not.toMatch(/readFile|readdir|setTimeout|setInterval|process\.(send|stdout|stderr)/);
    expect(PROFILE_LIMIT_MS).toBe(900000); expect(PROFILE_CLEANUP_RESERVE_MS).toBe(30000); expect(SUITE_PROGRESS_LIMITS).toEqual({ frame_bytes: 2048, frames: 50000, stderr_bytes: 8388608, modules: 256, cases: 20000, open_cases: 64, tail: 32, snapshot_bytes: 131072 });
    expect(p13ParentText).toContain("++messages > 50008"); expect(p13ParentText).toContain("SUITE_PROGRESS_LIMITS.stderr_bytes + 2 * SUITE_PROGRESS_LIMITS.snapshot_bytes + 50000 * 128");
  });
  it.each(p14Roles.flatMap((role) => P14_DELTA_CONDITIONS.map((condition) => [role, condition] as const)))("distinguishes %s/%s without changing original predicates, clocks, effects or P13", async (role, condition) => {
    const target = p14Message(role, condition === "received-ms-range" ? NaN : condition === "delivery-regression" ? 4.25 : 10.25); if (condition === "envelope-shape") target.extra = "PRIVATE";
    const messages = [p13SourceMessage(), p14Message("frame", 5), target], original = p14ParentHarness({ legacyGuard: true }), enabled = p14ParentHarness(), disabled = p14ParentHarness();
    const baseline = await original.run(messages), result = await enabled.run(messages), off = await disabled.run(messages, undefined, false);
    expect(result.report).toEqual(baseline.report); expect(result.report).toEqual(off.report); expect(result.p13).toEqual(baseline.p13); expect(result.trace).toEqual(baseline.trace); expect(result.trace).toEqual(off.trace);
    expect(result.p13.first_rejection).toMatchObject({ site: "delta-envelope-or-time", role, counted_messages: 3, validated_frame_sequence: 1 });
    expect(result.p14).toMatchObject({ capture_status: "captured", unavailable_reason: null, acceptance: false, delta: { condition, role, counted_messages: 3, received_ms: condition === "delivery-regression" ? 4.25 : condition === "after-parent-elapsed" ? 10.25 : null, previous_delivery_ms: condition === "delivery-regression" || condition === "after-parent-elapsed" ? 5 : null, parent_elapsed_ms: condition === "after-parent-elapsed" ? 10 : null } });
    expect(result.trace.filter((entry) => entry === "clock")).toHaveLength(condition === "after-parent-elapsed" ? 5 : 4); expect(result.trace.filter((entry) => entry === "frame")).toHaveLength(1);
    expect(result.report).toMatchObject({ status: "failed", source_hashes: {}, progress: null, costs: null, workflow_cases: null, json: null, native_exit: null, stdio_close: null });
    const line = `${JSON.stringify(result.report)}\n`, writes: string[] = []; enabled.capture.emit(result.report, line, (value) => { writes.push(value); });
    expect(writes[0]).toBe(formatP12ObservationLossLine(baseline.p13, line)); expect(writes[1]).toBe(formatP14DeltaRejectionLine(result.p14, line, writes[0]!)); expect(writes).toHaveLength(2);
  });
  it.each(P14_DELTA_CONDITIONS)("captures actual parent/fake-Child %s while retaining an all-null revoked report", async (condition) => {
    const result = await p14BoundTarget(condition);
    expect(result.p14.delta).toMatchObject({ condition, role: "frame", counted_messages: result.p13.first_rejection!.counted_messages });
    expect(result.p13).toMatchObject({ first_rejection: { site: "delta-envelope-or-time", source_seen: true, source_valid: true, final_seen: false }, terminal: { branch: "revoked", controller_supervision: { exit_code: 0, closed: true, expired: false, failed: false } } });
    expect(result.report).toMatchObject({ status: "failed", source_hashes: {}, progress: null, costs: null, workflow_cases: null, receipt: null, wait_receipt: null, continuity_receipt: null, json: null, native_exit: null, stdio_close: null }); expect(result.child.signals).toEqual([]);
  });
  it.each([0, -0, 5.5, 5.500000000000001, 10, 10.000000000000002, 900000, -1, 900001, NaN, Infinity, -Infinity])("preserves strict fractional/equality/range behavior for received offset %s", async (received) => {
    const messages = [p13SourceMessage(), p14Message("frame", 5.5), p14Message("p12", received)], original = p14ParentHarness({ legacyGuard: true }), current = p14ParentHarness();
    const baseline = await original.run(messages), result = await current.run(messages); expect(result.report).toEqual(baseline.report); expect(result.p13).toEqual(baseline.p13); expect(result.trace).toEqual(baseline.trace);
    const condition = !Number.isFinite(received) || received < 0 || received > 900000 ? "received-ms-range" : received < 5.5 ? "delivery-regression" : received > 10 ? "after-parent-elapsed" : null;
    expect(result.p14.capture_status).toBe(condition ? "captured" : "unavailable"); expect(result.p14.delta?.condition ?? null).toBe(condition);
    if (!condition) expect(result.p14.unavailable_reason).toBe("not-target-rejection");
  });
  it.each(["missing", "extra", "value-object", "value-proxy", "value-string", "accessor-envelope", "proxy-envelope"] as const)("does not inspect private %s values or turn earlier envelope refusals into target observations", async (kind) => {
    const hook = vi.fn(), candidate = p14Message("frame", 0); let target: unknown = candidate;
    if (kind === "missing") delete candidate.received_ms;
    else if (kind === "extra") candidate.extra = "PRIVATE";
    else if (kind === "value-object") candidate.received_ms = Object.defineProperty({}, "valueOf", { get: hook });
    else if (kind === "value-proxy") candidate.received_ms = new Proxy({}, { get: hook, ownKeys: hook, getPrototypeOf: hook });
    else if (kind === "value-string") candidate.received_ms = "PRIVATE timestamp";
    else if (kind === "accessor-envelope") Object.defineProperty(candidate, "received_ms", { enumerable: true, get: hook });
    else target = new Proxy(candidate, { get: hook, ownKeys: hook, getPrototypeOf: hook });
    const harness = p14ParentHarness(), result = await harness.run([p13SourceMessage(), target]);
    expect(hook).not.toHaveBeenCalled(); expect(JSON.stringify(result.p14)).not.toContain("PRIVATE");
    if (kind === "accessor-envelope" || kind === "proxy-envelope") { expect(result.p13.first_rejection?.site).toBe("message-envelope"); expect(result.p14.unavailable_reason).toBe("not-target-rejection"); }
    else expect(result.p14.delta).toMatchObject({ condition: kind === "extra" || kind === "missing" ? "envelope-shape" : "received-ms-range", received_ms: null, previous_delivery_ms: null, parent_elapsed_ms: null });
  });
  it.each(["exact", "range", "clock"] as const)("does not label a throwing %s predicate as a failed boolean or inspect its thrown identity", async (throwPredicate) => {
    const original = p14ParentHarness({ legacyGuard: true, throwPredicate }), current = p14ParentHarness({ throwPredicate }), messages = [p13SourceMessage(), p14Message("frame", 0)];
    const baseline = await original.run(messages), result = await current.run(messages);
    expect(result.report).toEqual(baseline.report); expect(result.p13).toEqual(baseline.p13); expect(result.trace).toEqual(baseline.trace); expect(current.failures).toEqual([current.fault]); expect(current.errorGetter).not.toHaveBeenCalled();
    expect(result.p13.first_rejection?.site).toBe("message-handler-exception"); expect(result.p14).toMatchObject({ capture_status: "unavailable", unavailable_reason: "not-target-rejection", delta: null });
  });
  it("discards accepted tags and latches the actual first target without later repair or expiry overwrite", async () => {
    const harness = p14ParentHarness({ outcome: { exit_code: null, closed: false, expired: true, failed: true } }), accepted = p14Message("p12", 5), target = { ...p14Message("frame", "PRIVATE"), extra: true };
    const result = await harness.run([p13SourceMessage(), accepted, target, p14Message("frame", -1), p13FinalMessage()], () => { harness.setNow(900000); });
    expect(result.p14.delta).toEqual({ condition: "envelope-shape", role: "frame", counted_messages: 3, received_ms: null, previous_delivery_ms: null, parent_elapsed_ms: null });
    expect(result.p13).toMatchObject({ first_rejection: { site: "delta-envelope-or-time" }, terminal: { branch: "revoked", original_status: "deadline" } });
  });
});

describe("P14 target-only sealed binding and independent failure", () => {
  const otherSites: Array<{ site: typeof P12_OBSERVATION_REJECTION_SITES[number]; options?: P14HarnessOptions; messages: () => unknown[] }> = [
    { site: "budget-before-launch", options: { now: 870000 }, messages: () => [] },
    { site: "message-envelope", messages: () => [null] }, { site: "message-after-final", messages: () => [p13SourceMessage(), p13FinalMessage(), p13SourceMessage()] },
    { site: "source-duplicate", messages: () => [p13SourceMessage(), p13SourceMessage()] }, { site: "source-invalid", options: { refuse: "source" }, messages: () => [p13SourceMessage()] }, { site: "source-required", messages: () => [p14Message("frame")] },
    { site: "frame-invalid", options: { refuse: "frame" }, messages: () => [p13SourceMessage(), p14Message("frame")] },
    ...(["progress", "costs", "workflow"] as const).map((kind) => ({ site: `${kind}-replay` as typeof P12_OBSERVATION_REJECTION_SITES[number], options: { refuse: kind }, messages: () => [p13SourceMessage(), p14Message("frame")] })),
    { site: "receipt-after-revocation", messages: () => [p13SourceMessage(), p13RevocationMessage(), p14Message("p12")] },
    ...(["p09", "p11", "p12"] as const).flatMap((role) => [
      { site: `${role}-duplicate` as typeof P12_OBSERVATION_REJECTION_SITES[number], messages: () => [p13SourceMessage(), p14Message(role), p14Message(role)] },
      { site: `${role}-invalid` as typeof P12_OBSERVATION_REJECTION_SITES[number], messages: () => [p13SourceMessage(), p13ReceiptMessage(role, null)] },
    ]),
    { site: "receipt-revocation-envelope-or-duplicate", messages: () => [p13SourceMessage(), p13RevocationMessage(), p13RevocationMessage()] },
    { site: "exit-envelope-or-duplicate", messages: () => [p13SourceMessage(), p13ExitMessage(), p13ExitMessage()] }, { site: "exit-invalid-or-time", messages: () => [p13SourceMessage(), { ...p13ExitMessage(), native_exit: null }] },
    { site: "final-envelope", messages: () => [p13SourceMessage(), { ...p13FinalMessage(), extra: true }] }, { site: "final-sanitizer", options: { refuse: "final" }, messages: () => [p13SourceMessage(), p13FinalMessage()] },
    { site: "final-binding", messages: () => [p13SourceMessage(), p13FinalMessage({ ...p13FinalReport(), source_hashes: {} })] }, { site: "message-role", messages: () => [p13SourceMessage(), { role: "PRIVATE" }] },
    { site: "message-handler-exception", options: { throwAt: "source" }, messages: () => [p13SourceMessage()] }, { site: "controller-send-exception", options: { throwAt: "send" }, messages: () => [] }, { site: "watchdog-exception", options: { throwAt: "launch" }, messages: () => [] },
  ];
  it.each(otherSites)("keeps non-target $site explicitly unavailable and never emits a P14 line", async ({ site, options, messages }) => {
    const harness = p14ParentHarness(options), result = await harness.run(messages());
    expect(result.p13.first_rejection?.site).toBe(site); expect(result.p14).toMatchObject({ capture_status: "unavailable", unavailable_reason: "not-target-rejection", delta: null });
    const before = result.p14, writes: string[] = []; harness.child.emit("message", { ...p14Message("frame"), extra: true }); expect(harness.capture.readDelta(result.report)).toEqual(before);
    harness.capture.emit(result.report, `${JSON.stringify(result.report)}\n`, (line) => { writes.push(line); }); expect(writes).toHaveLength(1); expect(writes[0]).toMatch(/^P12_OBSERVATION_LOSS_PROFILE /);
  });
  it.each(["message-count", "ipc-byte-limit"] as const)("keeps the unchanged %s guard outside P14", async (site) => {
    const budget = 8388608 + 2 * 131072 + 50000 * 128, options = site === "message-count" ? { byteSize: () => 0 } : { byteSize: (value: string) => value.includes('"role":"suite-workflow-timing-source"') ? budget : 1 };
    const messages = site === "message-count" ? [p13SourceMessage(), ...Array.from({ length: 50008 }, () => p14Message("frame"))] : [p13SourceMessage(), p14Message("frame")];
    const harness = p14ParentHarness(options), result = await harness.run(messages); expect(result.p13.first_rejection?.site).toBe(site); expect(result.p14.unavailable_reason).toBe("not-target-rejection");
  });
  it.each([false, true])("does not classify a valid unavailable receipt/global revocation as a delta refusal: revoke=%s", async (revoke) => {
    const capture = createP12ObservationLossCapture(), child = new Child(), missing = continuityHarness(); missing.observer.checkpoint("wait-return");
    child.send.mockImplementation(() => { child.emit("message", p13SourceMessage()); child.emit("message", p13ReceiptMessage("p12", missing.receipt())); if (revoke) child.emit("message", p13RevocationMessage()); child.emit("close", 1); });
    const report = await runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child, capture.handle);
    expect(capture.read(report).first_rejection).toBeNull(); expect(capture.readDelta(report)).toMatchObject({ capture_status: "unavailable", unavailable_reason: "not-target-rejection", delta: null });
  });
  it("binds only the first claimed invocation/report and detaches P14 while ignoring hostile late activity", async () => {
    const capture = createP12ObservationLossCapture(), first = new Child(), second = new Child(), hook = vi.fn(), clock = vi.fn(() => 10);
    expect(capture.readDelta(new Proxy({}, { get: hook, ownKeys: hook }))).toMatchObject({ unavailable_reason: "incomplete-observation" });
    const pending = runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(clock), () => first, capture.handle);
    second.send.mockImplementation(() => { second.emit("message", p13SourceMessage()); second.emit("message", p14Message("frame", 11)); second.emit("close", 0); });
    const other = await runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(() => 10), () => second, capture.handle);
    expect(capture.readDelta(other).unavailable_reason).toBe("incomplete-observation"); first.emit("message", p13SourceMessage()); first.emit("message", p14Message("frame", 11)); first.emit("close", 0);
    const report = await pending, receipt = capture.readDelta(report), old = capture.read(report); expect(receipt.delta?.condition).toBe("after-parent-elapsed");
    expect(capture.readDelta(other).unavailable_reason).toBe("invalid-binding"); expect(capture.readDelta({ ...report }).unavailable_reason).toBe("invalid-binding"); expect(capture.readDelta(new Proxy(report, { get: hook })).unavailable_reason).toBe("invalid-binding");
    const copy = capture.readDelta(report); copy.delta!.received_ms = 99; expect(capture.readDelta(report)).toEqual(receipt);
    Object.defineProperty(report, "status", { enumerable: true, get: hook }); const reads = clock.mock.calls.length;
    first.emit("message", new Proxy({}, { get: hook, getPrototypeOf: hook, ownKeys: hook })); first.emit("message", p14Message("frame", -1));
    expect(capture.readDelta(report)).toEqual(receipt); expect(capture.read(report)).toEqual(old); expect(clock).toHaveBeenCalledTimes(reads); expect(hook).not.toHaveBeenCalled();
  });
  it.each(["plain", "accessor", "proxy", "function", "null"] as const)("does not inspect or claim a foreign %s handle", async (kind) => {
    const hook = vi.fn(), capture = createP12ObservationLossCapture(), child = new Child();
    const foreign = kind === "plain" ? { ...capture.handle } : kind === "accessor" ? Object.defineProperty({}, "readDelta", { get: hook }) : kind === "proxy" ? new Proxy(capture.handle, { get: hook, getPrototypeOf: hook, ownKeys: hook }) : kind === "function" ? () => hook() : null;
    child.send.mockImplementation(() => { child.emit("message", p13SourceMessage()); child.emit("message", p14Message("frame", 11)); child.emit("close", 0); });
    const report = await runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(() => 10), () => child, foreign);
    expect(report.status).toBe("failed"); expect(capture.readDelta(report).unavailable_reason).toBe("incomplete-observation"); expect(hook).not.toHaveBeenCalled();
  });
  it.each(["missing", "role", "count", "operand", "accessor"] as const)("makes a %s private candidate unavailable without changing P13 or the original result", async (fault) => {
    const hook = vi.fn(), baseline = p14ParentHarness(), harness = p14ParentHarness(), messages = [p13SourceMessage(), p14Message("frame", 11)];
    const before = await baseline.run(messages), result = await harness.run(messages, () => {
      const state = harness.api.privateState(harness.capture.handle), delta = state.delta as NonNullable<P14DeltaRejectionReceipt["delta"]>;
      if (fault === "missing") state.delta = null;
      else if (fault === "role") delta.role = "p11";
      else if (fault === "count") delta.counted_messages++;
      else if (fault === "operand") delta.parent_elapsed_ms = NaN;
      else Object.defineProperty(delta, "received_ms", { enumerable: true, get: hook });
    });
    expect(result.report).toEqual(before.report); expect(result.p13).toEqual(before.p13); expect(result.trace).toEqual(before.trace); expect(result.p14).toMatchObject({ capture_status: "unavailable", unavailable_reason: "invalid-state", delta: null }); expect(hook).not.toHaveBeenCalled();
  });
  it.each(["throw", "null"] as const)("isolates a %s P14 sanitizer failure at seal/read/output without poisoning P13", async (mode) => {
    const baseline = p14ParentHarness(), harness = p14ParentHarness(), messages = [p13SourceMessage(), p14Message("frame", 11)], before = await baseline.run(messages), restore = harness.api.poisonDelta(mode);
    const result = await harness.run(messages); expect(result.report).toEqual(before.report); expect(result.p13).toEqual(before.p13); expect(result.trace).toEqual(before.trace); expect(result.p14).toMatchObject({ unavailable_reason: "invalid-state", delta: null });
    const writes: string[] = []; harness.capture.emit(result.report, `${JSON.stringify(result.report)}\n`, (line) => { writes.push(line); }); expect(writes).toHaveLength(1); expect(writes[0]).toMatch(/^P12_OBSERVATION_LOSS_PROFILE /);
    restore(); expect(harness.capture.readDelta(result.report)).toMatchObject({ unavailable_reason: "invalid-state", delta: null }); expect(harness.errorGetter).not.toHaveBeenCalled();
  });
  it("isolates a private latch failure before sealing without replacing the original P13 first slot", async () => {
    const baseline = p14ParentHarness(), harness = p14ParentHarness(), messages = [p13SourceMessage(), p14Message("frame", 11)], getter = vi.fn(), before = await baseline.run(messages);
    Object.defineProperty(harness.api.privateState(harness.capture.handle), "delta", { get: getter, set: () => { throw harness.fault; } });
    const result = await harness.run(messages);
    expect(result.report).toEqual(before.report); expect(result.p13).toEqual(before.p13); expect(result.trace).toEqual(before.trace); expect(result.p14).toMatchObject({ capture_status: "unavailable", unavailable_reason: "invalid-state", delta: null }); expect(getter).not.toHaveBeenCalled(); expect(harness.errorGetter).not.toHaveBeenCalled();
  });
  it("does not substitute a cause when the original private P13 binding is unavailable", async () => {
    const harness = p14ParentHarness({ outcome: { exit_code: Infinity, closed: true, expired: false, failed: false } }), result = await harness.run([p13SourceMessage(), p14Message("frame", 11)]);
    expect(result.p13.capture_status).toBe("unavailable"); expect(result.p14).toMatchObject({ capture_status: "unavailable", unavailable_reason: "invalid-state", delta: null });
  });
});

describe("P14 closed DTO numeric masks and privacy", () => {
  it.each(P14_DELTA_CONDITIONS)("detaches the %s numeric mask with exactly the closed keys", (condition) => {
    const input = p14Receipt(condition), result = sanitizeP14DeltaRejectionReceipt(input)!; expect(result).toEqual(input); input.delta!.counted_messages = 9; expect(result.delta!.counted_messages).toBe(3);
    expect(Object.keys(result)).toEqual(["schema_version", "kind", "observation_point", "diagnostic_only", "acceptance", "sealed", "capture_status", "unavailable_reason", "delta"]);
    expect(Object.keys(result.delta!)).toEqual(["condition", "role", "counted_messages", "received_ms", "previous_delivery_ms", "parent_elapsed_ms"]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|source_hash|payload|fixture|module|case_name|task_id|context|path|pid|stack|token|credential/);
  });
  it.each(P14_DELTA_CONDITIONS.flatMap((condition) => ["received_ms", "previous_delivery_ms", "parent_elapsed_ms"].map((field) => [condition, field] as const)))("checks the %s/%s null mask without recomputing the guard", (condition, field) => {
    const receipt = p14Receipt(condition), expectedNull = receipt.delta![field as "received_ms"] === null; Object.assign(receipt.delta!, { [field]: expectedNull ? 0 : null }); expect(sanitizeP14DeltaRejectionReceipt(receipt)).toBeNull();
  });
  it.each(["received_ms", "previous_delivery_ms", "parent_elapsed_ms"] as const)("retains finite boundary/fractional %s values and refuses invalid values without comparison-based classification", (field) => {
    for (const value of [0, -0, 0.000000000000001, 899999.9999999999, 900000]) { const input = p14Receipt(); input.delta![field] = value; expect(sanitizeP14DeltaRejectionReceipt(input)?.delta?.[field]).toBe(value); }
    for (const value of [-1, 900001, NaN, Infinity, -Infinity, "PRIVATE", {}]) { const input = p14Receipt(); Object.assign(input.delta!, { [field]: value }); expect(sanitizeP14DeltaRejectionReceipt(input)).toBeNull(); }
    const input = p14Receipt(); Object.assign(input.delta!, { received_ms: 0, previous_delivery_ms: 900000, parent_elapsed_ms: 900000 }); expect(sanitizeP14DeltaRejectionReceipt(input)?.delta?.condition).toBe("after-parent-elapsed");
  });
  it.each([0, 50009, 50010, -1, 0.5, NaN])("checks counted-message bound %s without calling it a receive ordinal", (counted_messages) => {
    const input = p14Receipt(); input.delta!.counted_messages = counted_messages; expect(sanitizeP14DeltaRejectionReceipt(input) !== null).toBe(Number.isSafeInteger(counted_messages) && counted_messages >= 0 && counted_messages <= 50009);
  });
  it.each(["root", "delta"] as const)("refuses extra/accessor/Proxy %s keys without reading private values", (level) => {
    const hook = vi.fn(), input = p14Receipt(), object = level === "root" ? input : input.delta!, wrap = (value: unknown) => level === "root" ? value : { ...input, delta: value };
    for (const value of [{ ...object, private: "PRIVATE" }, Object.defineProperty({ ...object }, Object.keys(object)[0]!, { enumerable: true, get: hook }), new Proxy(object, { get: hook, ownKeys: hook, getOwnPropertyDescriptor: hook, getPrototypeOf: hook })]) expect(sanitizeP14DeltaRejectionReceipt(wrap(value))).toBeNull(); expect(hook).not.toHaveBeenCalled();
  });
  it.each([["schema_version", 2], ["kind", "PRIVATE"], ["observation_point", "elsewhere"], ["diagnostic_only", false], ["acceptance", true], ["sealed", false], ["capture_status", "success"], ["unavailable_reason", "PRIVATE"], ["delta", null]])("refuses changed literal %s", (field, value) => { expect(sanitizeP14DeltaRejectionReceipt({ ...p14Receipt(), [field as string]: value })).toBeNull(); });
  it.each(["invalid-binding", "incomplete-observation", "invalid-state", "not-target-rejection"] as const)("keeps unavailable %s receipts empty and non-accepting", (unavailable_reason) => {
    const input = { ...p14Receipt(), capture_status: "unavailable", unavailable_reason, delta: null }; expect(sanitizeP14DeltaRejectionReceipt(input)).toEqual(input); expect(sanitizeP14DeltaRejectionReceipt({ ...input, delta: p14Receipt().delta })).toBeNull();
  });
  it.each(["condition", "role"] as const)("rejects unknown %s labels rather than exporting arbitrary text", (field) => { const input = p14Receipt(); Object.assign(input.delta!, { [field]: "PRIVATE" }); expect(sanitizeP14DeltaRejectionReceipt(input)).toBeNull(); });
});

describe("P14 original supervision and optional output priority", () => {
  it.each(["close", "send-failure", "expiry"] as const)("preserves actual target %s signals, detach, cancellation and clocks with observation on/off", async (kind) => {
    vi.useFakeTimers();
    const execute = async (enabled: boolean) => {
      const child = new Child(), foreign = new Child(), capture = createP12ObservationLossCapture(), trace: string[] = [], started = Date.now();
      const clock = () => { trace.push("clock"); return kind === "expiry" ? Date.now() - started : 10; };
      child.send.mockImplementation(() => {
        trace.push("send"); child.emit("message", p13SourceMessage()); child.emit("message", { ...p14Message("frame"), extra: true });
        if (kind === "send-failure") throw Object.defineProperty({}, "message", { get: () => { throw new Error("Unexpected private getter"); } });
        if (kind === "close") child.emit("close", 0);
      });
      const pending = runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(clock), () => { trace.push("launch"); return child; }, enabled ? capture.handle : undefined);
      if (kind !== "close") await vi.advanceTimersByTimeAsync(kind === "expiry" ? 900000 : 2000);
      const report = await pending;
      return { report, trace, signals: child.signals, foreign: foreign.signals, p14: capture.readDelta(report), detach: [child.stdout.destroy.mock.calls.length, child.stderr.destroy.mock.calls.length, child.disconnect.mock.calls.length, child.channel.unref.mock.calls.length, child.unref.mock.calls.length] };
    };
    const before = await execute(false), result = await execute(true);
    expect(result.report).toEqual(before.report); expect(result.trace).toEqual(before.trace); expect(result.signals).toEqual(before.signals); expect(result.detach).toEqual(before.detach); expect(result.foreign).toEqual([]);
    expect(result.signals).toEqual(kind === "close" ? [] : ["SIGTERM", "SIGKILL"]); expect(result.p14.delta?.condition).toBe("envelope-shape"); expect(result.report.status).toBe(kind === "expiry" ? "deadline" : "failed");
  });
  it.each(["normal", "p13-throw", "p14-throw", "false", "reentrant", "suppressed"] as const)("keeps %s writer attempts sticky and P13 first without changing the original report", async (mode) => {
    const { capture, report, p13, p14 } = await p14BoundTarget(), original = `${JSON.stringify(report)}\n`, expectedP13 = formatP12ObservationLossLine(p13, original)!, expectedP14 = formatP14DeltaRejectionLine(p14, original, expectedP13)!;
    const write = vi.fn<(line: string) => unknown>((line) => {
      if (mode === "p13-throw" && line.startsWith("P12_")) throw new Error("PRIVATE P13 writer");
      if (mode === "p14-throw" && line.startsWith("P14_")) throw new Error("PRIVATE P14 writer");
      if (mode === "reentrant") capture.emit(report, original, write);
      return mode !== "false";
    });
    const supplied = mode === "suppressed" ? original.padEnd(131073, " ") + "\n" : original;
    expect(() => capture.emit(report, supplied, write)).not.toThrow(); capture.emit(report, original, write);
    expect(write.mock.calls.map(([line]) => line)).toEqual(mode === "suppressed" ? [] : mode === "p13-throw" ? [expectedP13] : [expectedP13, expectedP14]);
    expect(`${JSON.stringify(report)}\n`).toBe(original); expect(report.status).toBe("failed"); expect(write.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it("reads no caller report contents during output and keeps P13 after a P14-only formatting exception", async () => {
    const { capture, report, p13 } = await p14BoundTarget(), originalLine = `${JSON.stringify(report)}\n`, expectedP13 = formatP12ObservationLossLine(p13, originalLine), getter = vi.fn(), stringify = JSON.stringify, writes: string[] = [];
    Object.defineProperty(report, "status", { enumerable: true, get: getter }); Object.defineProperty(report, "source_hashes", { enumerable: true, get: getter });
    vi.spyOn(JSON, "stringify").mockImplementation(((value: unknown) => { if ((value as { kind?: unknown })?.kind === "p14-delta-rejection") throw new Error("PRIVATE formatting"); return stringify(value); }) as typeof JSON.stringify);
    expect(() => capture.emit(report, originalLine, (line) => { writes.push(line); })).not.toThrow(); capture.emit(report, originalLine, (line) => { writes.push(line); });
    expect(writes).toEqual([expectedP13]); expect(getter).not.toHaveBeenCalled(); expect(capture.readDelta(report).delta?.condition).toBe("after-parent-elapsed");
  });
  it.each([2048, 2049])("enforces the exact %s-byte P14 line including prefix and LF without truncation", (size) => {
    const stringify = JSON.stringify, receipt = p14Receipt(), raw = stringify(receipt), prefix = "P14_DELTA_REJECTION_PROFILE ", p13Line = formatP12ObservationLossLine(p13CapturedReceipt(), "{}\n")!;
    vi.spyOn(JSON, "stringify").mockImplementation(((value: unknown) => (value as { kind?: unknown })?.kind === "p14-delta-rejection" ? raw.padEnd(size - prefix.length - 1, " ") : stringify(value)) as typeof JSON.stringify);
    const line = formatP14DeltaRejectionLine(receipt, "{}\n", p13Line);
    if (size === 2048) { expect(Buffer.byteLength(line!)).toBe(2048); expect(JSON.parse(line!.slice(prefix.length))).toEqual(receipt); } else expect(line).toBeNull();
  });
  it.each([131072, 131073])("preserves all original/P13 evidence at the exact joint %s-byte edge and suppresses only P14", async (size) => {
    const { capture, report, p13, p14 } = await p14BoundTarget(), original = `${JSON.stringify(report)}\n`, p13Line = formatP12ObservationLossLine(p13, original)!, p14Line = formatP14DeltaRejectionLine(p14, original, p13Line)!, wrapper = Buffer.byteLength('{"role":"suite-workflow-timing-report","report":') + 1;
    const supplied = original.slice(0, -1).padEnd(size - wrapper - Buffer.byteLength(p13Line) - Buffer.byteLength(p14Line) - 1, " ") + "\n", writes: string[] = [];
    expect(JSON.parse(supplied)).toEqual(report); expect(formatP12ObservationLossLine(p13, supplied)).toBe(p13Line);
    capture.emit(report, supplied, (line) => { writes.push(line); }); capture.emit(report, original, (line) => { writes.push(line); });
    expect(writes).toEqual(size === 131072 ? [p13Line, p14Line] : [p13Line]); expect(Buffer.byteLength(supplied) + wrapper + Buffer.byteLength(p13Line) + Buffer.byteLength(p14Line)).toBe(size);
    expect(`${JSON.stringify(report)}\n`).toBe(original);
  });
  it("bounds every condition/role/counter width in an ordinary real joint envelope without reserializing it", async () => {
    const report = await completedWorkflowTimingReport(), original = `${JSON.stringify(report)}\n`, p13Line = formatP12ObservationLossLine(p13CapturedReceipt(), original)!, stringify = JSON.stringify;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation(((value: unknown) => { expect(value).not.toBe(report); expect((value as { kind?: unknown })?.kind).toBe("p14-delta-rejection"); return stringify(value); }) as typeof JSON.stringify);
    for (const condition of P14_DELTA_CONDITIONS) for (const role of p14Roles) {
      const receipt = p14Receipt(condition); Object.assign(receipt.delta!, { role, counted_messages: 50009 });
      if (condition === "delivery-regression" || condition === "after-parent-elapsed") { receipt.delta!.received_ms = 899999.9999999999; receipt.delta!.previous_delivery_ms = 899999.9999999999; }
      if (condition === "after-parent-elapsed") receipt.delta!.parent_elapsed_ms = 899999.9999999999;
      const line = formatP14DeltaRejectionLine(receipt, original, p13Line)!; expect(line).not.toBeNull(); expect(Buffer.byteLength(line)).toBeLessThanOrEqual(2048); expect(JSON.parse(line.slice("P14_DELTA_REJECTION_PROFILE ".length))).toEqual(receipt);
      expect(Buffer.byteLength(original) + Buffer.byteLength('{"role":"suite-workflow-timing-report","report":') + 1 + Buffer.byteLength(p13Line) + Buffer.byteLength(line)).toBeLessThanOrEqual(131072);
    }
    expect(spy).toHaveBeenCalledTimes(16); spy.mockRestore(); expect(`${JSON.stringify(report)}\n`).toBe(original);
  });
  it.each(["unavailable", "invalid", "missing-old-line", "oversized-old-line", "missing-original-lf"] as const)("suppresses a %s P14 line without repairing input or replacing P13", (mode) => {
    const receipt = p14Receipt(), p13Line = formatP12ObservationLossLine(p13CapturedReceipt(), "{}\n")!;
    const candidate = mode === "unavailable" ? { ...receipt, capture_status: "unavailable", unavailable_reason: "not-target-rejection", delta: null } : mode === "invalid" ? { ...receipt, extra: "PRIVATE" } : receipt;
    expect(formatP14DeltaRejectionLine(candidate, mode === "missing-original-lf" ? "{}" : "{}\n", mode === "missing-old-line" ? "" : mode === "oversized-old-line" ? p13Line.padEnd(2049, " ") + "\n" : p13Line)).toBeNull();
  });
  it("composes the exact unchanged CLI stdout/exit followed by P13 and optional P14, with no new call site", async () => {
    const cli = p13ProfilerText.slice(p13ProfilerText.lastIndexOf('} else if (process.argv[1] && resolve(process.argv[1]) === script) {') + 2), body = cli.slice(cli.indexOf("  try {"), cli.lastIndexOf("}"));
    const code = ts.transpileModule(`async function invoke(){${body}}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    expect(body.match(/observation\?\.emit\(report, line\)/g)).toHaveLength(1); expect(body).not.toContain("readDelta");
    for (const mode of ["normal", "p13-throw", "p14-throw", "false"] as const) {
      const { capture, report, p13, p14 } = await p14BoundTarget(), original = `${JSON.stringify(report)}\n`, order: string[] = [], stdout: string[] = [], stderr: string[] = [];
      let exitCode: number | undefined;
      const processFake = { argv: ["node", "profiler"], get exitCode() { return exitCode; }, set exitCode(value: number | undefined) { exitCode = value; order.push("exit"); }, stdout: { write: (line: string) => { order.push("stdout"); stdout.push(line); } } };
      const write = (line: string) => { const kind = line.startsWith("P12_") ? "p13" : "p14"; order.push(kind); stderr.push(line); if (mode === `${kind}-throw`) throw new Error("PRIVATE writer"); return mode !== "false"; };
      const watchdog = async (_deadline?: unknown, _launch?: unknown, handle?: unknown) => { expect(handle).toBe(capture.handle); order.push("watchdog"); return report; };
      const invoke = new Function("process", "parseProfileArguments", "createP12ObservationLossCapture", "runSuiteWorkflowTimingDiagnosticWatchdog", `${code}\nreturn invoke;`)(processFake, () => "full-suite-workflow-timing", () => { order.push("capture"); return { handle: capture.handle, emit: (value: unknown, line: string) => { capture.emit(value, line, write); } }; }, watchdog) as () => Promise<void>;
      await invoke(); expect(stdout).toEqual([original]); expect(exitCode).toBe(1); expect(order).toEqual(["capture", "watchdog", "stdout", "exit", "p13", ...(mode === "p13-throw" ? [] : ["p14"])]);
      const oldLine = formatP12ObservationLossLine(p13, original)!; expect(stderr).toEqual(mode === "p13-throw" ? [oldLine] : [oldLine, formatP14DeltaRejectionLine(p14, original, oldLine)]);
    }
  });
  it("jointly fits maximum real projections, full frame/receipt slots and both widest side diagnostics", async () => {
    const projection = createSuiteProgressProjection(), costs = createSuiteAttributionCosts(), workflow = createWorkflowCaseTimingProjection(), tail: SuiteProgressFrame[] = []; let sequence = 0, valid = true;
    const moduleSource = (ordinal: number) => ordinal === 17 ? "runner/workflow-orchestrator.test.ts" : `${ordinal < 17 ? "lib" : "scripts"}/${String(ordinal).padStart(3, "0")}-${"x".repeat(ordinal < 17 ? 176 : 172)}.test.ts`;
    const push = (event: SuiteProgressFrame["event"], ordinal: number | null = null, data: unknown = null, test: number | null = null, elapsed = 0) => {
      const frame = { schema_version: 1, kind: "suite-progress-observation", sequence: ++sequence, reporter_elapsed_ms: elapsed, event, module: ordinal === null ? null : { ordinal, source: moduleSource(ordinal) }, case: test === null ? null : { ordinal: test, alias: null }, data } as SuiteProgressFrame;
      valid = projection.accept(frame) && costs.accept(frame) && workflow.accept(frame) && valid; tail.push(frame); if (tail.length > 32) tail.shift();
    };
    push("reporter-init"); push("run-start", null, { module_count: 256 });
    for (let ordinal = 1; ordinal <= 256; ordinal++) { push("module-queued", ordinal); push("module-collected", ordinal, { case_count: ordinal === 17 ? 19940 : ordinal === 256 ? 60 : 0 }); push("module-start", ordinal); }
    for (let ordinal = 1; ordinal <= 20; ordinal++) { push("case-ready", 17, null, ordinal, ordinal * 3 - 2); push("case-result", 17, { state: "passed", original_attempt: null }, ordinal, ordinal * 3 - 1); }
    for (let ordinal = 21; ordinal <= 19936; ordinal++) push("case-result", 17, { state: "skipped", original_attempt: null }, ordinal, 60);
    for (let ordinal = 19937; ordinal <= 19940; ordinal++) push("case-ready", 17, null, ordinal, ordinal - 19876);
    for (let ordinal = 1; ordinal <= 60; ordinal++) push("case-ready", 256, null, ordinal, 65);
    for (let ordinal = 1; ordinal <= 252; ordinal++) push("module-end", ordinal, { state: ordinal === 17 ? "failed" : "passed" }, null, 899999.9999999999);
    const progress = projection.snapshot()!, cost = costs.snapshot()!, cases = workflow.snapshot()!;
    expect(valid).toBe(true); expect(progress.counts.collected).toBe(20000); expect(progress.open_cases).toHaveLength(64); expect(progress.tail).toHaveLength(32); expect(cost.ended?.top).toHaveLength(16); expect(cost.start_without_end?.top).toHaveLength(4); expect(cases.ended?.top).toHaveLength(16); expect(cases.open?.top).toHaveLength(4); expect(cases.coverage?.gaps.top).toHaveLength(4);
    let clocks = 0, settle!: () => void; const original = new Promise<void>((done) => { settle = done; }), harness = continuityHarness({ clock: () => clocks++ === 0 ? 0 : 899999.9999999999 });
    harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => original); harness.observer.checkpoint("wait-enter"); harness.observer.observePoll(() => undefined); settle(); await Promise.resolve();
    for (let index = 0; index < 64; index++) { harness.controller.release(harness.options.workflowExecution); harness.controller.reconcile(); }
    for (let index = 1; index < 256; index++) harness.observer.observePoll(() => undefined); harness.observer.checkpoint("wait-return");
    const continuity = harness.receipt(), wait = await completeWaitReceipt(), span = completeSpanReceipt(), source = workflowTimingSourceEnvelope();
    const report: SuiteWorkflowTimingDiagnosticReport = { ...p13EmptyReport(), wall_ms: 900000, source_hashes: source.source_hashes, source_hashes_after: { ...source.source_hashes }, source_drift: false, progress: compactSuiteProgress(progress), receipt: span, wait_receipt: wait, continuity_receipt: continuity, costs: cost, workflow_cases: cases };
    const safe = sanitizeSuiteWorkflowTimingDiagnostic(report, failureSourceLimits, { progress, costs: cost, workflow_cases: cases }); expect(safe).not.toBeNull();
    let serialized = JSON.stringify(safe);
    for (const receipt of [span, wait, continuity]) { const raw = JSON.stringify(receipt); serialized = serialized.replace(raw, raw.padEnd(8192, " ")); }
    for (const frame of tail) { const raw = JSON.stringify(frame); serialized = serialized.replace(raw, raw.padEnd(2048, " ")); }
    const originalLine = `${serialized}\n`, p13Line = formatP12ObservationLossLine(p13CapturedReceipt(), originalLine)!, receipt = p14Receipt();
    Object.assign(receipt.delta!, { role: "frame", counted_messages: 50009, received_ms: 899999.9999999999, previous_delivery_ms: 899999.9999999999, parent_elapsed_ms: 899999.9999999999 });
    const p14Line = formatP14DeltaRejectionLine(receipt, originalLine, p13Line)!;
    expect(JSON.parse(serialized)).toEqual(safe); expect(p13Line).not.toBeNull(); expect(p14Line).not.toBeNull(); expect(Buffer.byteLength(p13Line)).toBeLessThanOrEqual(2048); expect(Buffer.byteLength(p14Line)).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(`{"role":"suite-workflow-timing-report","report":${serialized}}\n${p13Line}${p14Line}`)).toBeLessThanOrEqual(131072);
  });
});

// P15 additions preserve the complete 982-test prefix byte for byte.
import { createP15SuiteFailureCollector, formatP15SuiteFailuresLine, P15_FAILURE_CANDIDATE_MARKER, P15_FAILURE_LINE_BYTES, P15_FAILURE_MARKER, P15_FAILURE_REASONS, projectP15SuiteFailures, sanitizeP15SuiteFailuresReceipt, type P15SuiteFailuresReceipt } from "./profile-maintenance";

interface P15JsonCase { title: string; fullName?: string; status: string; duration: number; failureMessages?: unknown; location?: unknown }
interface P15Json { success: boolean; numTotalTests: number; numPassedTests: number; numFailedTests: number; testResults: Array<{ name: string; status: string; assertionResults: P15JsonCase[] }> }
function p15Fixture(extraFailures = 0, secondFailed = true) {
  const first = progressModule("lib/synthetic-failures.test.ts", ["PRIVATE duplicate", "PRIVATE duplicate", "PRIVATE pass", "PRIVATE skip"]), planner = progressModule("runner/workflow-orchestrator.test.ts", [PLANNER_FAILURE_CASE]), extra = progressModule("scripts/z-synthetic-failures.test.ts", Array.from({ length: extraFailures }, () => "PRIVATE duplicate"));
  const states: ProgressState[] = ["failed", secondFailed ? "failed" : "passed", "passed", "skipped"];
  first.tests.forEach((test, index) => { test.result = () => ({ state: states[index]! }); }); first.setState("failed"); extra.tests.forEach((test) => { test.result = () => ({ state: "failed" }); }); if (extraFailures) extra.setState("failed");
  const harness = progressHarness([extra, planner, first]); harness.start(); harness.collect(); harness.complete("failed");
  const progress = harness.snapshot()!; const raw = JSON.parse(progressJson(progress)) as P15Json; raw.success = false;
  const tests = raw.testResults.find((m) => m.name === first.specification.moduleId)!.assertionResults;
  tests.forEach((test, index) => { test.status = states[index] === "skipped" ? "pending" : states[index]!; test.fullName = "PRIVATE duplicate name"; test.title = "PRIVATE duplicate"; test.failureMessages = []; });
  tests[0]!.location = { line: 16, column: 2 }; tests[0]!.failureMessages = [`AssertionError: expected PRIVATE_SECRET to equal PRIVATE_OTHER\n    at fictional (${first.specification.moduleId}:17:9)\n    at external (C:/private/secret.ts:1:2)`];
  tests[1]!.failureMessages = [`Error: ${PLANNER_TEST_TIMEOUT_MESSAGE}\n    at fictional (${first.specification.moduleId}:43:7)`];
  const output = JSON.stringify(raw), source = workflowTimingSourceEnvelope(), summary = summarizeSuiteProgressJson(output, progress)!;
  const candidate = projectP15SuiteFailures(output, progress, summary, source.source_hashes), evidence = workflowTimingEvidence({ ...harness, progress });
  const report: SuiteWorkflowTimingDiagnosticReport = { ...p13EmptyReport(), source_hashes: source.source_hashes, source_hashes_after: { ...source.source_hashes }, source_drift: false, progress: compactSuiteProgress(progress), json: summary, costs: evidence.costs, workflow_cases: evidence.workflow_cases, native_exit: { code: 1, signal: null, received_ms: 8 }, stdio_close: { exit_code: 1, closed: true, expired: false, failed: false }, last_progress_received_ms: 5 };
  return { first, planner, extra, harness, progress, raw, output, source, summary, candidate, evidence, report, tests };
}
function p15InternalLine(value: unknown): string { return `${P15_FAILURE_CANDIDATE_MARKER}${JSON.stringify(value)}\n`; }
function p15UnavailableReceipt(reason: typeof P15_FAILURE_REASONS[number]): P15SuiteFailuresReceipt {
  return { schema_version: 1, kind: "p15-suite-failures", observation_point: "watchdog-return", diagnostic_only: true, acceptance: false, sealed: true, capture_status: "unavailable", unavailable_reason: reason, binding: null, failed_total: null, retained_cases: 0, omitted_cases: null, classification_complete: false, cases: [] };
}
async function p15Bound(options: { enabled?: boolean; order?: "before" | "after"; line?: string | null; fixture?: ReturnType<typeof p15Fixture>; runtime?: ReturnType<typeof p15Evaluated>; fault?: (child: Child, capture: ReturnType<typeof createP12ObservationLossCapture>) => void } = {}) {
  const fixture = options.fixture ?? p15Fixture(), child = new Child(), capture = (options.runtime?.capture ?? createP12ObservationLossCapture)(), clock = vi.fn(() => 10), line = options.line === undefined ? p15InternalLine(fixture.candidate) : options.line;
  const stderr = (chunk: unknown) => { const listener = child.stderr.on.mock.calls.find(([event]) => event === "data")?.[1] as ((data: unknown) => void) | undefined; listener?.(chunk); };
  child.send.mockImplementation(() => {
    child.emit("message", fixture.source); emitWorkflowTimingFrames(child, { ...fixture.harness, progress: fixture.progress }, 5);
    if (fixture.report.native_exit) child.emit("message", { role: "suite-workflow-timing-exit", native_exit: fixture.report.native_exit });
    if (line !== null && options.order !== "after") stderr(line); child.emit("message", p13FinalMessage(fixture.report)); if (line !== null && options.order === "after") stderr(line);
    options.fault?.(child, capture); child.emit("close", 0);
  });
  const report = await (options.runtime?.run ?? runSuiteWorkflowTimingDiagnosticWatchdog)(new ProfileDeadline(clock), () => child, options.enabled === false ? undefined : capture.handle);
  return { ...fixture, child, capture, clock, report, stderr, p13: capture.read(report), p14: capture.readDelta(report), p15: capture.readFailures(report) };
}
const p15StrictParseText = p13ProfilerText.slice(p13ProfilerText.indexOf("function suiteParseJson("), p13ProfilerText.indexOf("/** All stderr is drained and bounded"));
/** Private fault hooks exist only in the evaluated test closure. */
function p15Evaluated() {
  const compiled = ts.transpileModule(`${p13RecordText}\n${p15StrictParseText}\n${p13CompanionText}\n${p13ParentText}`.replace(/\bexport /g, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const deps = { nodeTypes: p13NodeTypes, ProfileDeadline, SUITE_PROGRESS_LIMITS, Buffer, createHash, SUITE_WORKFLOW_TIMING_SOURCES, OUTPUT_LIMIT: 8388608, join, repository: resolve("."), project: projectP15SuiteFailures, createSuiteProgressProjection, createSuiteAttributionCosts, createWorkflowCaseTimingProjection, compactSuiteProgress, sanitizeSuiteWorkflowTimingSourceMetadata, sanitizeSuiteProgressFrame, sanitizePlannerSpanReceipt, sanitizePlannerWaitReceipt, sanitizePlannerContinuityReceipt, sanitizeSuiteWorkflowTimingDiagnostic, sourceHashesChanged, superviseChild,
    spanTime: (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 900000,
    suiteExit: (value: unknown) => value,
    workflowTimingUnavailable: (deadline: ProfileDeadline, expired = false) => ({ ...p13EmptyReport(), status: expired ? "deadline" : "failed", wall_ms: deadline.elapsed() }) };
  const build = new Function("deps", `const { nodeTypes, ProfileDeadline, SUITE_PROGRESS_LIMITS, Buffer, createHash, SUITE_WORKFLOW_TIMING_SOURCES, OUTPUT_LIMIT, join, repository, createSuiteProgressProjection, createSuiteAttributionCosts, createWorkflowCaseTimingProjection, compactSuiteProgress, sanitizeSuiteWorkflowTimingSourceMetadata, sanitizeSuiteProgressFrame, sanitizePlannerSpanReceipt, sanitizePlannerWaitReceipt, sanitizePlannerContinuityReceipt, sanitizeSuiteWorkflowTimingDiagnostic, sourceHashesChanged, superviseChild, spanTime, suiteExit, workflowTimingUnavailable } = deps;\n${compiled}\nprojectP15SuiteFailures = deps.project; return { capture: createP12ObservationLossCapture, run: runSuiteWorkflowTimingDiagnosticWatchdog, state: (handle) => observationLossHandles.get(handle), controller: createP15ControllerCapture, finishController: (handle, report, output, progress) => p15ControllerReturn(claimP15Controller(handle), report, output, progress), poison: (name) => { const fault = Object.defineProperty({}, "message", { get: () => { throw new Error("Unexpected error inspection"); } }); if (name === "observe") p15ObserveFrame = () => { throw fault; }; if (name === "seal") sealP15Failures = () => { throw fault; }; if (name === "sanitize") sanitizeP15SuiteFailuresReceipt = () => { throw fault; }; if (name === "project") projectP15SuiteFailures = () => { throw fault; }; } };`);
  return build(deps) as { capture: typeof createP12ObservationLossCapture; run: typeof runSuiteWorkflowTimingDiagnosticWatchdog; state: (handle: object) => { failures: { invalid: boolean; target: boolean; failed_count: number; selected: unknown[]; collector: ReturnType<typeof createP15SuiteFailureCollector>; receipt: P15SuiteFailuresReceipt | null } }; controller: () => { handle: object; emit(report: unknown): void }; finishController: (handle: object, report: SuiteWorkflowTimingDiagnosticReport, output?: string, progress?: SuiteProgressSnapshot) => SuiteWorkflowTimingDiagnosticReport; poison: (name: "observe" | "seal" | "sanitize" | "project") => void };
}

describe("P15 final JSON identities and canonical private error projection", () => {
  it("preserves all 982 prior tests, independent pins and every original workload/guard boundary", () => {
    const tests = readFileSync(fileURLToPath(new URL("./profile-maintenance.test.ts", import.meta.url))), prefix = tests.subarray(0, tests.indexOf(Buffer.from("// P15 additions preserve")) - 1);
    expect(prefix.length).toBe(469437); expect(createHash("sha256").update(prefix).digest("hex")).toBe("14df0037ca4e42d65311b396393edf1119156b91e0df3d74aa24bbd9cf84083b");
    expect(SUITE_WORKFLOW_TIMING_SOURCES).toHaveLength(20); expect(SUITE_WORKFLOW_TIMING_CONTRACT_HASHES).toHaveLength(6); expect(PROFILE_LIMIT_MS).toBe(900000); expect(PROFILE_CLEANUP_RESERVE_MS).toBe(30000); expect(P15_FAILURE_LINE_BYTES).toBe(4096);
    expect(p13ParentText.match(/controller\.send\(/g)).toHaveLength(1); expect(p13ParentText.match(/controller\.on\("message"/g)).toHaveLength(1); expect(p13ParentText.match(/controller\.stderr\?\.on\?\.\("data"/g)).toHaveLength(1);
    expect(p13ParentText).toContain("++messages > 50008"); expect(p13ParentText).toContain("SUITE_PROGRESS_LIMITS.stderr_bytes + 2 * SUITE_PROGRESS_LIMITS.snapshot_bytes + 50000 * 128"); expect(p13ParentText).not.toMatch(/readFile|readdir|setTimeout|setInterval|process\.(send|stdout|stderr)/);
  });
  it("retains both actual failed ordinals despite duplicate private titles, without changing the original summary", () => {
    const f = p15Fixture(), before = JSON.stringify(f.summary), result = f.candidate;
    expect(f.summary).toMatchObject({ failed_tests: 2, passed_tests: 2, skipped_tests: 1, first_planner: { passed: true } }); expect(result).toMatchObject({ capture_status: "captured", failed_total: 2, retained_cases: 2, omitted_cases: 0, classification_complete: true });
    expect(result.cases.map((c) => [c.module.ordinal, c.module.source, c.case_ordinal])).toEqual([[1, "lib/synthetic-failures.test.ts", 1], [1, "lib/synthetic-failures.test.ts", 2]]);
    expect(result.cases[0]!.errors.entries[0]).toMatchObject({ reported_name: "AssertionError", signature: "assertion-failure", message: "Assertion failed (values omitted).", sites: [{ line: 17, column: 9 }] });
    expect(result.cases[1]!.errors.entries[0]).toMatchObject({ reported_name: "Error", signature: "test-timeout-5000", message: "Test timed out in 5000ms.", sites: [{ line: 43, column: 7 }] });
    expect(result.cases[0]!.declaration_status).toBe("reported-not-source-verified"); expect(result.cases[0]!.full_name_sha256).toBe(result.cases[1]!.full_name_sha256); expect(JSON.stringify(result)).not.toMatch(/PRIVATE|expected|secret\.ts|fullName|ancestorTitles|failureMessages|C:|\/\/\//); expect(JSON.stringify(f.summary)).toBe(before);
  });
  it.each([1, 3, 12])("selects the lowest two tuples with exactly %s additional failures, independent of JSON/delivery order", (extra) => {
    const f = p15Fixture(extra); f.raw.testResults.reverse(); const result = projectP15SuiteFailures(JSON.stringify(f.raw), f.progress, f.summary, f.source.source_hashes);
    expect(result.cases).toEqual(f.candidate.cases); expect(result.failed_total).toBe(extra + 2); expect(result.omitted_cases).toBe(extra); expect(result.classification_complete).toBe(false);
  });
  it("keeps exactly two failures across distinct modules and duplicate parameterized names", () => {
    const f = p15Fixture(1, false); expect(f.candidate).toMatchObject({ capture_status: "captured", failed_total: 2, retained_cases: 2, omitted_cases: 0 });
    expect(f.candidate.cases.map((c) => [c.module.ordinal, c.module.source, c.case_ordinal])).toEqual([[1, "lib/synthetic-failures.test.ts", 1], [3, "scripts/z-synthetic-failures.test.ts", 1]]);
    expect(f.candidate.cases.every((c) => c.module.source !== "runner/workflow-orchestrator.test.ts")).toBe(true);
  });
  it("retains a single proven failed case without inventing a second identity", () => {
    const f = p15Fixture(0, false); expect(f.candidate).toMatchObject({ capture_status: "captured", failed_total: 1, retained_cases: 1, omitted_cases: 0, classification_complete: true }); expect(f.candidate.cases.map((c) => c.case_ordinal)).toEqual([1]);
  });
  it.each(["missing-name", "long-name", "missing-location", "bad-location", "foreign-location"] as const)("retains proven identity with %s optional metadata", (kind) => {
    const f = p15Fixture(), test = f.tests[0]!; if (kind === "missing-name") delete test.fullName; else if (kind === "long-name") test.fullName = "x".repeat(2049); else if (kind === "missing-location") delete test.location; else test.location = kind === "bad-location" ? { line: 0, column: 1 } : { line: 1, column: 1, private: true };
    const result = projectP15SuiteFailures(JSON.stringify(f.raw), f.progress, f.summary, f.source.source_hashes); expect(result.capture_status).toBe("captured"); expect(result.cases[0]!.case_ordinal).toBe(1);
    if (kind.includes("name")) expect(result.cases[0]!.full_name_sha256).toBeNull(); else { expect(result.cases[0]!.declaration).toBeNull(); expect(result.cases[0]!.declaration_status).toBe("unavailable"); }
  });
  const signatures: Array<[string, string, string | null]> = [[PLANNER_TEST_TIMEOUT_MESSAGE, "test-timeout-5000", "Test timed out in 5000ms."], [`Error: ${PLANNER_HOOK_TIMEOUT_MESSAGE}`, "hook-timeout-10000", "Hook timed out in 10000ms."], ["AssertionError: PRIVATE expected value", "assertion-failure", "Assertion failed (values omitted)."], ["TypeError: PRIVATE", "typed-error", "Type error (details omitted)."], ["RangeError: PRIVATE", "typed-error", "Range error (details omitted)."], ["ReferenceError: PRIVATE", "typed-error", "Reference error (details omitted)."], ["SyntaxError: PRIVATE", "typed-error", "Syntax error (details omitted)."], ["AggregateError: PRIVATE", "typed-error", "Aggregate error (details omitted)."], ["Error: PRIVATE", "unsupported", null], [`Error: PRIVATE ${PLANNER_TEST_TIMEOUT_MESSAGE}`, "unsupported", null], [`AssertionError: PRIVATE ${PLANNER_TEST_TIMEOUT_MESSAGE}`, "assertion-failure", "Assertion failed (values omitted)."], [`Error: ${PLANNER_TEST_TIMEOUT_MESSAGE}\nPRIVATE trailing detail`, "unsupported", null], [`\u001b[31mError: ${PLANNER_TEST_TIMEOUT_MESSAGE}`, "unsupported", null], ["PRIVATE é😀\n token=password", "unsupported", null]];
  it.each(signatures)("classifies only fixed public/header evidence for %s", (message, signature, expected) => {
    const f = p15Fixture(); f.tests[0]!.failureMessages = [message]; const result = projectP15SuiteFailures(JSON.stringify(f.raw), f.progress, f.summary, f.source.source_hashes);
    expect(result.cases[0]!.errors.entries[0]).toMatchObject({ signature, message: expected }); expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it.each(["missing", "empty", "null", "object", "non-string", "too-long", "too-many"] as const)("keeps identity but makes %s error data explicitly unavailable", (kind) => {
    const f = p15Fixture(), test = f.tests[0]!; if (kind === "missing") delete test.failureMessages; else test.failureMessages = kind === "empty" ? [] : kind === "null" ? null : kind === "object" ? {} : kind === "non-string" ? [42] : kind === "too-long" ? ["x".repeat(65537)] : Array(20001).fill("PRIVATE");
    const result = projectP15SuiteFailures(JSON.stringify(f.raw), f.progress, f.summary, f.source.source_hashes); expect(result.capture_status).toBe("captured"); expect(result.cases).toHaveLength(2); expect(result.cases[0]!.errors).toMatchObject({ capture_status: "unavailable", reported_count: null, retained_count: 0, omitted_count: null, classification_complete: false, entries: [] });
  });
  it("reports exact error omissions and bounded same-file locations without leaking other paths or source text", () => {
    const f = p15Fixture(), path = f.first.specification.moduleId, url = new URL(`file:///${path}`).href;
    f.tests[0]!.failureMessages = [`TypeError: PRIVATE\n    at x (${path}:1:1)\n    at x (${url}:10000:65536)\n    at x (${path}:9:9)\n    at x (${path}:10001:1)\n    at x (${path}:1:65537)`, "PRIVATE unsupported", "PRIVATE omitted"];
    const result = projectP15SuiteFailures(JSON.stringify(f.raw), f.progress, f.summary, f.source.source_hashes), errors = result.cases[0]!.errors;
    expect(errors).toMatchObject({ reported_count: 3, retained_count: 2, omitted_count: 1, classification_complete: false }); expect(errors.entries[0]).toMatchObject({ sites: [{ line: 1, column: 1 }, { line: 10000, column: 65536 }], positions_status: "limit-reached" }); expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it.each(["missing", "duplicate", "escaped-key", "module", "module-count", "summary", "case-state", "total", "overflow", "hostile-progress"] as const)("does not bind %s inconsistent input as an empty successful capture", (fault) => {
    const f = p15Fixture(), hook = vi.fn(); let output = f.output, progress: SuiteProgressSnapshot = f.progress, summary = f.summary;
    if (fault === "missing") output = "PRIVATE no report"; else if (fault === "duplicate") output = output.replace('"success":false', '"success":false,"success":false'); else if (fault === "escaped-key") output = output.replace('"success"', '"succ\\u0065ss"'); else if (fault === "module") f.raw.testResults[0]!.name = "C:/private/outside.test.ts"; else if (fault === "module-count") f.raw.testResults.pop(); else if (fault === "summary") summary = { ...summary, failed_tests: 3 }; else if (fault === "case-state") f.tests[0]!.status = "passed"; else if (fault === "total") f.raw.numTotalTests++; else if (fault === "overflow") output = "x".repeat(8388609); else progress = new Proxy(progress, { get: hook, ownKeys: hook, getPrototypeOf: hook });
    if (["module", "module-count", "case-state", "total"].includes(fault)) output = JSON.stringify(f.raw);
    expect(projectP15SuiteFailures(output, progress, summary, f.source.source_hashes)).toMatchObject({ capture_status: "unavailable", unavailable_reason: "invalid-json", cases: [] }); expect(hook).not.toHaveBeenCalled();
  });
});

describe("P15 closed detached DTOs and bounded independent native stderr", () => {
  it("detaches all nested identities, bindings, errors and locations at both observation points", () => {
    const f = p15Fixture(), original = JSON.stringify(f.candidate), controller = sanitizeP15SuiteFailuresReceipt(f.candidate, "controller-final-json")!;
    const parent = sanitizeP15SuiteFailuresReceipt({ ...controller, observation_point: "watchdog-return" })!;
    expect(controller).toEqual(f.candidate); expect(parent).toEqual({ ...controller, observation_point: "watchdog-return" }); expect(sanitizeP15SuiteFailuresReceipt(controller)).toBeNull(); expect(sanitizeP15SuiteFailuresReceipt(parent, "controller-final-json")).toBeNull();
    parent.binding!.failed_tests = 99; parent.cases[0]!.module.source = "lib/changed.test.ts"; parent.cases[0]!.declaration!.line = 999; parent.cases[0]!.errors.entries[0]!.sites[0]!.line = 888;
    expect(JSON.stringify(f.candidate)).toBe(original); expect(JSON.stringify(controller)).toBe(original); expect(Object.keys(controller)).toHaveLength(14); expect(Object.keys(controller.binding!)).toHaveLength(6); expect(Object.keys(controller.cases[0]!)).toHaveLength(6); expect(Object.keys(controller.cases[0]!.errors)).toHaveLength(7); expect(Object.keys(controller.cases[0]!.errors.entries[0]!)).toHaveLength(6);
  });
  it.each(P15_FAILURE_REASONS)("preserves only the closed unavailable %s mask", (reason) => {
    const receipt = p15UnavailableReceipt(reason); expect(sanitizeP15SuiteFailuresReceipt(receipt)).toEqual(receipt);
    const worker = { ...receipt, observation_point: "controller-final-json" }; expect(sanitizeP15SuiteFailuresReceipt(worker, "controller-final-json")).toEqual(["invalid-json", "invalid-state"].includes(reason) ? worker : null);
    expect(sanitizeP15SuiteFailuresReceipt({ ...receipt, failed_total: 0 })).toBeNull(); expect(sanitizeP15SuiteFailuresReceipt({ ...receipt, omitted_cases: 0 })).toBeNull(); expect(sanitizeP15SuiteFailuresReceipt({ ...receipt, classification_complete: true })).toBeNull();
  });
  const mutations: Array<[string, (v: P15SuiteFailuresReceipt) => void]> = [
    ["extra-root", (v) => Object.assign(v, { private: true })], ["acceptance", (v) => { v.acceptance = true as false; }], ["unsealed", (v) => { v.sealed = false as true; }], ["unknown-reason", (v) => { v.unavailable_reason = "PRIVATE" as typeof v.unavailable_reason; }],
    ["extra-binding", (v) => Object.assign(v.binding!, { private: true })], ["fingerprint", (v) => { v.binding!.source_fingerprint = "PRIVATE"; }], ["sequence", (v) => { v.binding!.progress_sequence = 50001; }], ["module-limit", (v) => { v.binding!.module_count = 257; }], ["count-sum", (v) => { v.binding!.passed_tests = 20000; }], ["failed-total", (v) => { v.failed_total = 3; }], ["omitted-cases", (v) => { v.omitted_cases = 1; }], ["retained-cases", (v) => { v.retained_cases = 1; }], ["classification", (v) => { v.classification_complete = false; }],
    ["case-order", (v) => { v.cases.reverse(); }], ["duplicate-case", (v) => { v.cases[1] = v.cases[0]!; }], ["inconsistent-module", (v) => { v.cases[1]!.module.source = "lib/other.test.ts"; }], ["extra-module", (v) => Object.assign(v.cases[0]!.module, { private: true })], ["module-ordinal", (v) => { v.cases[0]!.module.ordinal = 0; }], ["case-ordinal", (v) => { v.cases[0]!.case_ordinal = 20001; }], ["digest", (v) => { v.cases[0]!.full_name_sha256 = "A".repeat(64); }], ["unsafe-source", (v) => { v.cases[0]!.module.source = "lib/../private.test.ts"; }], ["declaration-limit", (v) => { v.cases[0]!.declaration!.line = 10001; }], ["declaration-mask", (v) => { v.cases[0]!.declaration_status = "unavailable"; }],
    ["extra-errors", (v) => Object.assign(v.cases[0]!.errors, { private: true })], ["error-index", (v) => { v.cases[0]!.errors.entries[0]!.index = 1; }], ["error-name", (v) => { v.cases[0]!.errors.entries[0]!.reported_name = "PRIVATE" as "Error"; }], ["error-signature", (v) => { v.cases[0]!.errors.entries[0]!.signature = "PRIVATE" as "unsupported"; }], ["raw-message", (v) => { v.cases[0]!.errors.entries[0]!.message = "PRIVATE expected actual diff token"; }], ["wrong-name-signature", (v) => { v.cases[0]!.errors.entries[0]!.reported_name = "TypeError"; }], ["error-count", (v) => { v.cases[0]!.errors.reported_count = 0; }], ["error-omission", (v) => { v.cases[0]!.errors.omitted_count = 1; }], ["error-completeness", (v) => { v.cases[0]!.errors.classification_complete = false; }], ["site-limit", (v) => { v.cases[0]!.errors.entries[0]!.sites[0]!.column = 65537; }], ["site-mask", (v) => { v.cases[0]!.errors.entries[0]!.positions_status = "unavailable"; }], ["extra-site", (v) => Object.assign(v.cases[0]!.errors.entries[0]!.sites[0]!, { private: true })],
  ];
  it.each(mutations)("rejects the %s contract violation without coercion or repair", (_name, mutate) => { const receipt = p15Fixture().candidate; mutate(receipt); expect(sanitizeP15SuiteFailuresReceipt(receipt, "controller-final-json")).toBeNull(); });
  it.each(["root-getter", "nested-getter", "array-getter", "sparse", "array-extra", "root-proxy", "nested-proxy", "array-proxy", "conversion"] as const)("rejects %s without evaluating hostile hooks", (kind) => {
    const candidate = p15Fixture().candidate, hook = vi.fn(() => { throw new Error("Unexpected private hook"); }), proxy = (value: object) => new Proxy(value, { get: hook, ownKeys: hook, getPrototypeOf: hook }); let value: unknown = candidate;
    if (kind === "root-getter") Object.defineProperty(candidate, "sealed", { enumerable: true, get: hook }); else if (kind === "nested-getter") Object.defineProperty(candidate.cases[0]!.errors.entries[0]!, "message", { enumerable: true, get: hook }); else if (kind === "array-getter") Object.defineProperty(candidate.cases, "0", { enumerable: true, get: hook }); else if (kind === "sparse") delete (candidate.cases as Array<unknown>)[0]; else if (kind === "array-extra") Object.assign(candidate.cases, { private: true }); else if (kind === "root-proxy") value = proxy(candidate); else if (kind === "nested-proxy") candidate.binding = proxy(candidate.binding!) as typeof candidate.binding; else if (kind === "array-proxy") candidate.cases = proxy(candidate.cases) as typeof candidate.cases; else Object.defineProperty(candidate, "toJSON", { enumerable: true, value: hook });
    expect(sanitizeP15SuiteFailuresReceipt(value, "controller-final-json")).toBeNull(); expect(hook).not.toHaveBeenCalled();
  });
  it("constructs an inert collector before codecs, clock, native output or filesystem access", () => {
    const read = vi.spyOn(fs, "readFileSync"), buffer = vi.spyOn(Buffer, "from"), clock = vi.spyOn(performance, "now"), write = vi.spyOn(process.stderr, "write"); const collector = createP15SuiteFailureCollector();
    expect(collector.finish()).toEqual({ status: "missing", candidate: null }); expect(read).not.toHaveBeenCalled(); expect(buffer).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
  it("accepts a single split native candidate, drains unrelated UTF-8 and detaches repeated sealed reads", () => {
    const candidate = p15Fixture().candidate, collector = createP15SuiteFailureCollector(), bytes = Buffer.from(`PRIVATE é😀\n${p15InternalLine(candidate)}PRIVATE unrelated\n`);
    for (const byte of bytes) collector.push(Buffer.from([byte])); const first = collector.finish(); expect(first).toEqual({ status: "candidate", candidate });
    first.candidate!.cases[0]!.errors.entries[0]!.sites[0]!.line = 999; expect(collector.finish()).toEqual({ status: "candidate", candidate }); const hook = vi.fn(); collector.push(new Proxy({}, { get: hook })); expect(hook).not.toHaveBeenCalled(); expect(collector.finish()).toEqual({ status: "candidate", candidate });
  });
  it.each([4096, 4097])("enforces the exact %s-byte candidate line including prefix and LF", (size) => {
    const candidate = p15Fixture().candidate, collector = createP15SuiteFailureCollector(), raw = JSON.stringify(candidate), line = P15_FAILURE_CANDIDATE_MARKER + raw.padEnd(size - P15_FAILURE_CANDIDATE_MARKER.length - 1, " ") + "\n";
    expect(Buffer.byteLength(line)).toBe(size); collector.push(line); expect(collector.finish()).toEqual(size === 4096 ? { status: "candidate", candidate } : { status: "invalid", candidate: null });
  });
  it.each(["duplicate", "public-alias", "malformed", "duplicate-key", "escaped-key", "truncated", "partial-prefix", "invalid-utf8", "incomplete-utf8", "overflow", "hostile-chunk"] as const)("makes %s permanently unavailable without disturbing original streams", (kind) => {
    const candidate = p15Fixture().candidate, collector = createP15SuiteFailureCollector(), line = p15InternalLine(candidate), hook = vi.fn();
    if (kind === "duplicate") collector.push(line + line); else if (kind === "public-alias") collector.push(line.replace(P15_FAILURE_CANDIDATE_MARKER, P15_FAILURE_MARKER)); else if (kind === "malformed") collector.push(P15_FAILURE_CANDIDATE_MARKER + "PRIVATE malformed\n"); else if (kind === "duplicate-key") collector.push(line.replace('"sealed":true', '"sealed":true,"sealed":true')); else if (kind === "escaped-key") collector.push(line.replace('"sealed"', '"seal\\u0065d"')); else if (kind === "truncated") collector.push(line.slice(0, -1)); else if (kind === "partial-prefix") collector.push("P15_SUITE_"); else if (kind === "invalid-utf8") collector.push(Buffer.from([255])); else if (kind === "incomplete-utf8") collector.push(Buffer.from([0xf0, 0x9f])); else if (kind === "overflow") collector.push(Buffer.alloc(8388609, 120)); else collector.push(new Proxy({}, { get: hook, ownKeys: hook, getPrototypeOf: hook }));
    if (!["truncated", "partial-prefix", "incomplete-utf8"].includes(kind)) collector.push(line); expect(collector.finish()).toEqual({ status: "invalid", candidate: null }); collector.push(line); expect(collector.finish()).toEqual({ status: "invalid", candidate: null }); expect(hook).not.toHaveBeenCalled();
  });
  it.each([8388608, 8388609])("bounds the independent %s-byte stream while dropping long unrelated lines", (size) => {
    const candidate = p15Fixture().candidate, collector = createP15SuiteFailureCollector(), line = p15InternalLine(candidate), filler = Buffer.alloc(size - Buffer.byteLength(line) - 1, 120);
    collector.push(filler); collector.push("\n"); collector.push(line); expect(collector.finish()).toEqual(size === 8388608 ? { status: "candidate", candidate } : { status: "invalid", candidate: null });
  });
});

describe("P15 private watchdog ownership, independent binding and failure isolation", () => {
  it.each(["before", "after"] as const)("seals final IPC and candidate in %s order without new messages, clocks or effects", async (order) => {
    const fixture = p15Fixture(), plain = await p15Bound({ fixture, enabled: false, order }), observed = await p15Bound({ fixture, order });
    expect(observed.report).toEqual(plain.report); expect(observed.report).toMatchObject({ status: "failed", json: { failed_tests: 2, first_planner: { passed: true } }, native_exit: { code: 1 }, stdio_close: { exit_code: 1, closed: true }, cleanup: "unavailable-no-uncertain-fixture-deleted" });
    expect(observed.p13).toMatchObject({ capture_status: "captured", first_rejection: null, terminal: { branch: "report-returned", original_status: "failed", controller_supervision: { exit_code: 0, closed: true, expired: false, failed: false } } }); expect(observed.p14.unavailable_reason).toBe("not-target-rejection"); expect(observed.p15).toEqual({ ...fixture.candidate, observation_point: "watchdog-return" });
    expect(observed.clock.mock.calls).toEqual(plain.clock.mock.calls); expect(observed.child.send.mock.calls).toEqual(plain.child.send.mock.calls); expect(observed.child.send).toHaveBeenCalledOnce(); expect(observed.child.signals).toEqual(plain.child.signals); expect(observed.child.disconnect.mock.calls).toEqual(plain.child.disconnect.mock.calls); expect(observed.child.unref.mock.calls).toEqual(plain.child.unref.mock.calls); expect(observed.child.stdout.destroy.mock.calls).toEqual(plain.child.stdout.destroy.mock.calls); expect(observed.child.stderr.destroy.mock.calls).toEqual(plain.child.stderr.destroy.mock.calls);
    expect(observed.child.stderr.on.mock.calls.filter(([event]) => event === "data")).toHaveLength(1); expect(observed.child.listenerCount("message")).toBe(1); expect(plain.p15.unavailable_reason).toBe("incomplete-observation");
  });
  it("keeps the parent snapshot private, detached and report-reference bound even after caller mutation", async () => {
    let early: P15SuiteFailuresReceipt | undefined; const bound = await p15Bound({ fault: (_child, capture) => { early = capture.readFailures({}); } }), { capture, report, p15, stderr, child } = bound;
    expect(early?.unavailable_reason).toBe("incomplete-observation"); expect(capture.readFailures({ ...report }).unavailable_reason).toBe("invalid-binding"); const hook = vi.fn(() => { throw new Error("Unexpected late access"); });
    expect(capture.readFailures(new Proxy(report, { get: hook, ownKeys: hook, getPrototypeOf: hook })).unavailable_reason).toBe("invalid-binding"); Object.defineProperty(report, "status", { enumerable: true, get: hook }); Object.defineProperty(report, "source_hashes", { enumerable: true, get: hook });
    const first = capture.readFailures(report); first.cases[0]!.errors.entries[0]!.sites[0]!.line = 999; stderr(new Proxy({}, { get: hook })); child.emit("message", { role: "PRIVATE late" }); expect(capture.readFailures(report)).toEqual(p15); expect(hook).not.toHaveBeenCalled();
    const foreign = createP12ObservationLossCapture(), never = vi.fn(() => new Child()); expect(foreign.readFailures(report).unavailable_reason).toBe("incomplete-observation");
    const reused = await runSuiteWorkflowTimingDiagnosticWatchdog(new ProfileDeadline(() => PROFILE_LIMIT_MS), never, capture.handle); expect(reused.status).toBe("deadline"); expect(never).not.toHaveBeenCalled(); expect(capture.readFailures(report)).toEqual(p15); expect(capture.readFailures(reused).unavailable_reason).toBe("invalid-binding");
  });
  it.each(["fingerprint", "sequence", "module-count", "passed-count", "failed-count", "source", "case-ordinal"] as const)("rejects a structurally valid %s candidate against admitted private facts", async (kind) => {
    const fixture = p15Fixture(), c = fixture.candidate;
    if (kind === "fingerprint") c.binding!.source_fingerprint = "b".repeat(64); else if (kind === "sequence") c.binding!.progress_sequence++; else if (kind === "module-count") c.binding!.module_count++; else if (kind === "passed-count") c.binding!.passed_tests++; else if (kind === "failed-count") { c.binding!.failed_tests++; c.failed_total!++; c.omitted_cases!++; c.classification_complete = false; } else if (kind === "source") c.cases.forEach((test) => { test.module.source = "lib/foreign.test.ts"; }); else c.cases[1]!.case_ordinal = 3;
    expect(sanitizeP15SuiteFailuresReceipt(c, "controller-final-json")).not.toBeNull(); const bound = await p15Bound({ fixture }); expect(bound.p15.unavailable_reason).toBe("invalid-binding"); expect(bound.report.json).toEqual(fixture.summary); expect(bound.p13.first_rejection).toBeNull();
  });
  it.each(["missing", "duplicate", "malformed", "worker-invalid-json", "worker-invalid-state"] as const)("keeps the exact %s unavailability separate from original failed-suite evidence", async (kind) => {
    const f = p15Fixture(), unavailable = { ...p15UnavailableReceipt(kind === "worker-invalid-state" ? "invalid-state" : "invalid-json"), observation_point: "controller-final-json" }, line = kind === "missing" ? null : kind === "duplicate" ? p15InternalLine(f.candidate).repeat(2) : kind === "malformed" ? P15_FAILURE_CANDIDATE_MARKER + "PRIVATE\n" : p15InternalLine(unavailable), bound = await p15Bound({ fixture: f, line });
    expect(bound.p15).toEqual(p15UnavailableReceipt(kind === "missing" ? "missing-candidate" : kind === "duplicate" || kind === "malformed" ? "invalid-transport" : kind === "worker-invalid-state" ? "invalid-state" : "invalid-json")); expect(bound.p13.first_rejection).toBeNull(); expect(bound.report.json?.failed_tests).toBe(2);
  });
  it.each(["no-json", "deadline", "no-native-exit", "open-stdio"] as const)("does not broaden the target for %s, even with a valid candidate", async (kind) => {
    const fixture = p15Fixture(); if (kind === "no-json") fixture.report.json = null; else if (kind === "deadline") fixture.report.status = "deadline"; else if (kind === "no-native-exit") fixture.report.native_exit = null; else fixture.report.stdio_close = { exit_code: null, closed: false, expired: false, failed: false };
    const bound = await p15Bound({ fixture }); expect(bound.p15.unavailable_reason).toBe("not-target-report"); expect(bound.p13.first_rejection).toBeNull(); const write = vi.fn(); bound.capture.emit(bound.report, `${JSON.stringify(bound.report)}\n`, write); expect(write).toHaveBeenCalledTimes(kind === "no-json" ? 2 : 1); expect(write.mock.calls[0]![0]).toMatch(/^P12_OBSERVATION_LOSS_PROFILE /);
  });
  it("does not invent failed tests for failed modules or unhandled errors, and never replays original reconciliation", () => {
    const entry = progressModule("lib/hook-only.test.ts", []), harness = progressHarness([entry]); entry.setState("failed"); harness.start(); harness.collect(); harness.complete("failed", [new Error("PRIVATE unhandled")]); const progress = harness.snapshot()!, json = JSON.parse(progressJson(progress)); json.success = false;
    const reconcile = vi.fn(() => true), summary = summarizeSuiteProgressJson(JSON.stringify(json), progress, reconcile)!; expect(summary.failed_tests).toBe(0); expect(reconcile).toHaveBeenCalledOnce(); expect(projectP15SuiteFailures(JSON.stringify(json), progress, summary, workflowTimingSourceEnvelope().source_hashes).capture_status).toBe("unavailable"); expect(reconcile).toHaveBeenCalledOnce();
    const f = p15Fixture(), projection = createSuiteProgressProjection(); for (const frame of f.harness.frames()) projection.accept(frame); [f.tests[1]!.status, f.tests[2]!.status] = [f.tests[2]!.status, f.tests[1]!.status];
    expect(summarizeSuiteProgressJson(JSON.stringify(f.raw), f.progress, projection.reconcile)).toBeNull();
  });
  it.each(["observe", "seal", "sanitize", "collector", "selection", "p13-invalid"] as const)("isolates %s faults from all old admission/status/supervision decisions", async (fault) => {
    const runtime = p15Evaluated(), fixture = p15Fixture(), old = await p15Bound({ fixture, enabled: false });
    if (["observe", "seal", "sanitize"].includes(fault)) runtime.poison(fault as "observe" | "seal" | "sanitize");
    const bound = await p15Bound({ runtime, fixture, fault: (_child, capture) => {
      const state = runtime.state(capture.handle); if (fault === "collector") state.failures.collector = { push() {}, finish() { throw new Error("PRIVATE collector"); } }; else if (fault === "selection") state.failures.selected = []; else if (fault === "p13-invalid") Object.assign(state, { invalid: true });
    } });
    expect(bound.report).toEqual(old.report); expect(bound.clock.mock.calls).toEqual(old.clock.mock.calls); expect(bound.child.signals).toEqual(old.child.signals); expect(bound.p15.unavailable_reason).toBe(fault === "selection" ? "invalid-binding" : "invalid-state");
    if (fault !== "p13-invalid") expect(bound.p13).toMatchObject({ capture_status: "captured", first_rejection: null, terminal: { branch: "report-returned" } }); else expect(bound.p13.unavailable_reason).toBe("invalid-state"); expect(JSON.stringify(bound.p15)).not.toContain("PRIVATE");
  });
  it("excludes P15 after any P14 attempt, retaining original rejection evidence and two-write maximum", async () => {
    const { capture, report, p13, p14 } = await p14BoundTarget(), original = `${JSON.stringify(report)}\n`, lines: string[] = [];
    expect(capture.readFailures(report).unavailable_reason).toBe("not-target-report"); capture.emit(report, original, (line) => { lines.push(line); return false; }); expect(lines).toEqual([formatP12ObservationLossLine(p13, original), formatP14DeltaRejectionLine(p14, original, lines[0]!)]); expect(lines.some((line) => line.startsWith(P15_FAILURE_MARKER))).toBe(false); capture.emit(report, original, (line) => lines.push(line)); expect(lines).toHaveLength(2);
  });
});

describe("P15 source-composed controller and original output priority", () => {
  it.each(["normal", "write-false", "write-throw", "projection-throw", "missing-json"] as const)("binds one private controller result with %s isolation and no raw fallback", (mode) => {
    const api = p15Evaluated(), capture = api.controller(), f = p15Fixture(), hook = vi.fn(() => { throw new Error("Unexpected report read"); }), write = vi.spyOn(process.stderr, "write").mockImplementation(() => { if (mode === "write-throw") throw new Error("PRIVATE writer"); return mode !== "write-false"; });
    capture.emit(new Proxy({}, { get: hook })); expect(write).not.toHaveBeenCalled(); if (mode === "projection-throw") api.poison("project");
    expect(api.finishController(capture.handle, f.report, mode === "missing-json" ? undefined : f.output, f.progress)).toBe(f.report); const other = { ...f.report }; expect(api.finishController(capture.handle, other, f.output, f.progress)).toBe(other); capture.emit(other); expect(write).not.toHaveBeenCalled();
    Object.defineProperty(f.report, "status", { enumerable: true, get: hook }); expect(() => capture.emit(f.report)).not.toThrow(); capture.emit(f.report); expect(write).toHaveBeenCalledOnce(); expect(hook).not.toHaveBeenCalled(); const line = write.mock.calls[0]![0] as string;
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(4096); expect(line.startsWith(P15_FAILURE_CANDIDATE_MARKER)).toBe(true); expect(line.endsWith("\n")).toBe(true); const receipt = JSON.parse(line.slice(P15_FAILURE_CANDIDATE_MARKER.length));
    expect(receipt).toEqual(mode === "projection-throw" || mode === "missing-json" ? { ...p15UnavailableReceipt(mode === "projection-throw" ? "invalid-state" : "invalid-json"), observation_point: "controller-final-json" } : f.candidate); expect(line).not.toMatch(/PRIVATE|failureMessages|fullName/);
  });
  it.each(["normal", "send-false", "callback-error", "send-throw", "write-throw"] as const)("preserves original final send/callback/disconnect/exit order with %s", async (mode) => {
    const api = p15Evaluated(), f = p15Fixture(), order: string[] = [], messages: unknown[] = [], lines: string[] = []; let exit: number | undefined;
    const processFake = { connected: true, get exitCode() { return exit; }, set exitCode(value: number | undefined) { exit = value; order.push("exit"); }, disconnect() { order.push("disconnect"); this.connected = false; }, send(message: unknown, callback: (error: Error | null) => void) { order.push("send"); messages.push(message); if (mode === "send-throw") throw new Error("PRIVATE send"); order.push("callback"); callback(mode === "callback-error" ? new Error("PRIVATE callback") : null); return mode !== "send-false"; } };
    const write = vi.spyOn(process.stderr, "write").mockImplementation((line) => { order.push("p15"); lines.push(String(line)); if (mode === "write-throw") throw new Error("PRIVATE writer"); return false; });
    const worker = p13ProfilerText.slice(p13ProfilerText.indexOf("async function suiteWorkflowTimingControllerWorker("), p13ProfilerText.indexOf("export class ProfileDeadline"));
    const code = ts.transpileModule(worker, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const run = vi.fn(async (_deadline: unknown, _metadata: unknown, _delta: unknown, handle: object) => { order.push("run"); return api.finishController(handle, f.report, f.output, f.progress); });
    const invoke = new Function("process", "suiteExact", "finite", "ProfileDeadline", "createP15ControllerCapture", "runLoadedSuiteWorkflowTiming", `${code}\nreturn suiteWorkflowTimingControllerWorker;`)(processFake, (value: unknown) => value, (value: unknown) => typeof value === "number" && Number.isFinite(value), ProfileDeadline, () => { order.push("capture"); return api.controller(); }, run) as (value: unknown) => Promise<void>;
    await invoke({ role: "suite-workflow-timing-controller", origin_ms: performance.timeOrigin }); expect(run).toHaveBeenCalledOnce(); expect(messages).toEqual([{ role: "suite-workflow-timing-report", report: f.report }]);
    expect(order).toEqual(mode === "send-throw" ? ["capture", "run", "send", "disconnect", "exit"] : ["capture", "run", "send", "callback", "disconnect", "exit", "p15"]); expect(exit).toBe(mode === "send-throw" || mode === "callback-error" ? 1 : 0); expect(write).toHaveBeenCalledTimes(mode === "send-throw" ? 0 : 1); expect(lines.every((line) => line.startsWith(P15_FAILURE_CANDIDATE_MARKER) && !line.includes("PRIVATE"))).toBe(true);
    expect(worker.match(/process\.send\(\{ role: "suite-workflow-timing-report", report \}, \(error\) => \{ if \(process\.connected\) process\.disconnect\(\); process\.exitCode = error \? 1 : 0; \}\)/g)).toHaveLength(1); expect(worker.indexOf("failures.emit(report)")).toBeGreaterThan(worker.indexOf('process.send({ role: "suite-workflow-timing-report"'));
  });
  it.each(["normal", "p13-throw", "p15-throw", "false", "reentrant", "suppressed"] as const)("retains once-only P13-first public writes for %s, without report reserialization", async (mode) => {
    const bound = await p15Bound(), { capture, report, p13, p15 } = bound, original = `${JSON.stringify(report)}\n`, lines: string[] = [], hook = vi.fn(() => { throw new Error("Unexpected report serialization"); });
    Object.defineProperty(report, "status", { enumerable: true, get: hook }); const write = vi.fn((line: string) => { lines.push(line); if (mode === "reentrant") capture.emit(report, original, write); if (mode === "p13-throw" && line.startsWith("P12_") || mode === "p15-throw" && line.startsWith(P15_FAILURE_MARKER)) throw new Error("PRIVATE writer"); return mode !== "false"; });
    capture.emit(report, mode === "suppressed" ? "{}".padEnd(131073, " ") + "\n" : original, write); capture.emit(report, original, write); expect(hook).not.toHaveBeenCalled();
    const first = formatP12ObservationLossLine(p13, original)!; expect(lines).toEqual(mode === "suppressed" ? [] : mode === "p13-throw" ? [first] : [first, formatP15SuiteFailuresLine(p15, original, first)]); expect(lines).toHaveLength(mode === "suppressed" ? 0 : mode === "p13-throw" ? 1 : 2); expect(lines.join("")).not.toContain("PRIVATE");
  });
  it("emits explicit missing-candidate evidence only after the original P13 write", async () => {
    const bound = await p15Bound({ line: null }), original = `${JSON.stringify(bound.report)}\n`, write = vi.fn(); bound.capture.emit(bound.report, original, write); expect(write).toHaveBeenCalledTimes(2);
    expect(JSON.parse(write.mock.calls[1]![0].slice(P15_FAILURE_MARKER.length))).toEqual(p15UnavailableReceipt("missing-candidate"));
  });
  it.each([4096, 4097])("enforces literal %s-byte public P15 formatting with no truncation or old-evidence change", (size) => {
    const value = { ...p15Fixture().candidate, observation_point: "watchdog-return" }, prior = formatP12ObservationLossLine(p13CapturedReceipt(), "{}\n")!, stringify = JSON.stringify, raw = stringify(value);
    vi.spyOn(JSON, "stringify").mockImplementation(((v: unknown) => (v as { kind?: unknown })?.kind === "p15-suite-failures" ? raw.padEnd(size - P15_FAILURE_MARKER.length - 1, " ") : stringify(v)) as typeof JSON.stringify);
    const line = formatP15SuiteFailuresLine(value, "{}\n", prior); if (size === 4096) { expect(Buffer.byteLength(line!)).toBe(4096); expect(JSON.parse(line!.slice(P15_FAILURE_MARKER.length))).toEqual(value); } else expect(line).toBeNull(); expect(formatP12ObservationLossLine(p13CapturedReceipt(), "{}\n")).toBe(prior);
  });
  it.each([131072, 131073])("enforces the exact %s-byte joint envelope without replacing either original string", (size) => {
    const value = { ...p15Fixture().candidate, observation_point: "watchdog-return" }, prior = formatP12ObservationLossLine(p13CapturedReceipt(), "{}\n")!, ordinary = formatP15SuiteFailuresLine(value, "{}\n", prior)!, wrapper = Buffer.byteLength('{"role":"suite-workflow-timing-report","report":') + 1;
    const original = "{}".padEnd(size - wrapper - Buffer.byteLength(prior) - Buffer.byteLength(ordinary) - 1, " ") + "\n", line = formatP15SuiteFailuresLine(value, original, prior); expect(JSON.parse(original)).toEqual({}); expect(line !== null).toBe(size === 131072); expect(formatP12ObservationLossLine(p13CapturedReceipt(), original)).toBe(prior); if (line) expect(Buffer.byteLength(original + prior + line) + wrapper).toBe(131072);
  });
  it.each(["invalid", "worker-point", "missing-original-lf", "missing-p13", "oversized-p13"] as const)("suppresses only P15 for %s inputs", (kind) => {
    const receipt = { ...p15Fixture().candidate, observation_point: "watchdog-return" }, old = formatP12ObservationLossLine(p13CapturedReceipt(), "{}\n")!;
    expect(formatP15SuiteFailuresLine(kind === "invalid" ? { ...receipt, private: true } : kind === "worker-point" ? { ...receipt, observation_point: "controller-final-json" } : receipt, kind === "missing-original-lf" ? "{}" : "{}\n", kind === "missing-p13" ? "" : kind === "oversized-p13" ? old.padEnd(2049, " ") + "\n" : old)).toBeNull();
  });
  it("composes unchanged CLI stdout/exit then P13/P15 in every writer outcome", async () => {
    const cli = p13ProfilerText.slice(p13ProfilerText.lastIndexOf('} else if (process.argv[1] && resolve(process.argv[1]) === script) {') + 2), body = cli.slice(cli.indexOf("  try {"), cli.lastIndexOf("}")), code = ts.transpileModule(`async function invoke(){${body}}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    expect(body.match(/observation\?\.emit\(report, line\)/g)).toHaveLength(1); expect(body).not.toMatch(/readFailures|P15_|readDelta/);
    for (const mode of ["normal", "p13-throw", "p15-throw", "false"] as const) {
      const { capture, report, p13, p15 } = await p15Bound(), original = `${JSON.stringify(report)}\n`, order: string[] = [], stdout: string[] = [], stderr: string[] = []; let exit: number | undefined;
      const processFake = { argv: ["node", "profiler"], get exitCode() { return exit; }, set exitCode(value: number | undefined) { exit = value; order.push("exit"); }, stdout: { write(line: string) { order.push("stdout"); stdout.push(line); } } };
      const write = (line: string) => { const kind = line.startsWith("P12_") ? "p13" : "p15"; order.push(kind); stderr.push(line); if (mode === `${kind}-throw`) throw new Error("PRIVATE writer"); return mode !== "false"; };
      const watchdog = async (_deadline: unknown, _launch: unknown, handle: object) => { expect(handle).toBe(capture.handle); order.push("watchdog"); return report; };
      const invoke = new Function("process", "parseProfileArguments", "createP12ObservationLossCapture", "runSuiteWorkflowTimingDiagnosticWatchdog", `${code}\nreturn invoke;`)(processFake, () => "full-suite-workflow-timing", () => { order.push("capture"); return { handle: capture.handle, emit: (value: unknown, line: string) => capture.emit(value, line, write) }; }, watchdog) as () => Promise<void>;
      await invoke(); const prior = formatP12ObservationLossLine(p13, original)!; expect(stdout).toEqual([original]); expect(exit).toBe(1); expect(order).toEqual(["capture", "watchdog", "stdout", "exit", "p13", ...(mode === "p13-throw" ? [] : ["p15"])]); expect(stderr).toEqual(mode === "p13-throw" ? [prior] : [prior, formatP15SuiteFailuresLine(p15, original, prior)]);
    }
  });
  it("does not repeat the original loaded-run summary, reconciliation, projections, snapshots or clock on a P15 projection fault", async () => {
    const code = ts.transpileModule(p13ProfilerText.slice(p13ProfilerText.indexOf("async function runLoadedSuiteWorkflowTiming("), p13ProfilerText.indexOf("// P13 observes only")), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    async function run(enabled: boolean, poison = false) {
      const f = p15Fixture(), api = p15Evaluated(), capture = api.controller(), trace: string[] = [], child = new Child(), clock = vi.fn(() => 10), reconcile = vi.fn<(ordinal: number, states: readonly ProgressState[]) => boolean>(), summary = vi.fn(summarizeSuiteProgressJson), snapshots: string[] = [];
      if (poison) api.poison("project"); const replay = createSuiteProgressProjection(); for (const frame of f.harness.frames()) replay.accept(frame); reconcile.mockImplementation(replay.reconcile);
      const projection = (kind: "costs" | "workflow") => { const actual = kind === "costs" ? createSuiteAttributionCosts() : createWorkflowCaseTimingProjection(); return { accept(frame: SuiteProgressFrame) { trace.push(kind + ".accept"); return actual.accept(frame); }, revoke() { trace.push(kind + ".revoke"); actual.revoke(); }, snapshot() { snapshots.push(kind); return actual.snapshot(); } }; };
      const deps = {
        workflowTimingUnavailable: (deadline: ProfileDeadline) => ({ ...p13EmptyReport(), wall_ms: deadline.elapsed() }), claimP15Controller: (handle: unknown) => handle,
        p15ControllerReturn: (handle: object, report: SuiteWorkflowTimingDiagnosticReport, output?: string, progress?: SuiteProgressSnapshot) => api.finishController(handle, report, output, progress),
        sourceHashes: () => { trace.push("hashes"); return f.source.source_hashes; }, SUITE_WORKFLOW_TIMING_SOURCES,
        preparePlannerFailureSourceMetadata: () => ({ fixture_sha256: f.source.fixture_sha256, sourceLimits: f.source.sourceLimits }), sanitizeSuiteWorkflowTimingSourceMetadata, prefixInventory: () => { trace.push("inventory"); return new Set(); }, createSuiteAttributionCosts: () => projection("costs"), createWorkflowCaseTimingProjection: () => projection("workflow"),
        createSuiteProgressCollector: (_first: unknown, frame: (frame: SuiteProgressFrame) => void) => ({ push() {}, reconcile, finish() { for (const item of f.harness.frames()) frame(item); return f.progress; } }), spanTime: (value: unknown) => typeof value === "number" && value >= 0 && value <= 900000,
        createWorkflowTimingOutputCollector: (callbacks: { data(chunk: Buffer): void }) => ({ push(chunk: Buffer) { callbacks.data(chunk); }, finish: () => ({ receipt: null, wait_receipt: null, continuity_receipt: null }), valid: () => { trace.push("valid"); return true; } }),
        spawn: () => { trace.push("spawn"); return child; }, repository: resolve("."), suiteWorkflowTimingArguments: () => [], suiteWorkflowTimingEnvironment: () => ({}), suiteExit: (value: unknown) => value,
        superviseChild: async () => { trace.push("supervise"); child.emit("exit", 1, null); return { exit_code: 1, closed: true, expired: false, failed: false }; }, compactSuiteProgress, summarizeSuiteProgressJson: summary, sourceHashesChanged, sanitizeSuiteWorkflowTimingDiagnostic,
      };
      child.stdout.on.mockImplementation((_event, callback: (chunk: Buffer) => void) => { callback(Buffer.from(f.output)); });
      const names = Object.keys(deps), invoke = new Function(...names, `${code}\nreturn runLoadedSuiteWorkflowTiming;`)(...Object.values(deps)) as (deadline: ProfileDeadline, metadata: (value: unknown) => void, delta: (value: unknown) => void, handle?: object) => Promise<SuiteWorkflowTimingDiagnosticReport>;
      const metadata = vi.fn(), delta = vi.fn(), result = await invoke(new ProfileDeadline(clock), metadata, delta, enabled ? capture.handle : undefined); return { result, clock, trace, reconcile, summary, snapshots, metadata, delta };
    }
    const plain = await run(false), observed = await run(true), fault = await run(true, true);
    for (const value of [observed, fault]) { expect(value.result).toEqual(plain.result); expect(value.result).toMatchObject({ status: "failed", json: { failed_tests: 2 } }); expect(value.trace).toEqual(plain.trace); expect(value.clock.mock.calls).toEqual(plain.clock.mock.calls); expect(value.summary).toHaveBeenCalledOnce(); expect(value.reconcile.mock.calls).toEqual(plain.reconcile.mock.calls); expect(value.snapshots).toEqual(plain.snapshots); expect(value.metadata.mock.calls).toEqual(plain.metadata.mock.calls); expect(value.delta.mock.calls).toEqual(plain.delta.mock.calls); }
    expect(plain.reconcile).toHaveBeenCalledTimes(3); expect(plain.snapshots).toEqual(["costs", "workflow"]);
  });
});

function p15WidestReceipt(): P15SuiteFailuresReceipt {
  const result: P15SuiteFailuresReceipt = { ...p15Fixture().candidate, observation_point: "watchdog-return" };
  result.binding = { source_fingerprint: "a".repeat(64), progress_sequence: 50000, module_count: 256, passed_tests: 0, failed_tests: 20000, skipped_tests: 0 }; result.failed_total = 20000; result.omitted_cases = 19998; result.classification_complete = false;
  result.cases.forEach((test, index) => {
    test.module = { ordinal: 255 + index, source: `lib/${String(index)}${"x".repeat(179)}.test.ts` }; test.case_ordinal = 19999 + index; test.full_name_sha256 = "a".repeat(64); test.declaration = { line: 10000, column: 65536 }; test.declaration_status = "reported-not-source-verified";
    test.errors = { capture_status: "captured", unavailable_reason: null, reported_count: 20000, retained_count: 2, omitted_count: 19998, classification_complete: false, entries: [0, 1].map((index) => ({ index, reported_name: "ReferenceError", signature: "typed-error", message: "Reference error (details omitted).", sites: [{ line: 10000, column: 65536 }, { line: 10000, column: 65536 }], positions_status: "reported-not-source-verified" })) };
  }); return result;
}
describe("P15 bounded maximal evidence without expanded execution guards", () => {
  it("fits valid maximum scalar/path/digest/error widths at both points, independently of old evidence", () => {
    const receipt = p15WidestReceipt(), worker = { ...receipt, observation_point: "controller-final-json" }; expect(sanitizeP15SuiteFailuresReceipt(receipt)).toEqual(receipt); expect(sanitizeP15SuiteFailuresReceipt(worker, "controller-final-json")).toEqual(worker);
    expect(receipt.cases.map((test) => Buffer.byteLength(test.module.source))).toEqual([192, 192]); expect(Buffer.byteLength(p15InternalLine(worker))).toBeLessThanOrEqual(4096); const old = formatP12ObservationLossLine(p13CapturedReceipt(), "{}\n")!, line = formatP15SuiteFailuresLine(receipt, "{}\n", old)!; expect(line).not.toBeNull(); expect(Buffer.byteLength(line)).toBeLessThanOrEqual(4096); expect(JSON.parse(line.slice(P15_FAILURE_MARKER.length))).toEqual(receipt);
  });
  it.each([1024, 1025])("bounds optional digest by UTF-8 bytes rather than %s Unicode characters", (length) => {
    const f = p15Fixture(); f.tests[0]!.fullName = "é".repeat(length); f.tests[0]!.failureMessages = ["é".repeat(32768)]; const result = projectP15SuiteFailures(JSON.stringify(f.raw), f.progress, f.summary, f.source.source_hashes);
    expect(result.capture_status).toBe("captured"); expect(result.cases[0]!.full_name_sha256).toBe(length === 1024 ? createHash("sha256").update(f.tests[0]!.fullName!).digest("hex") : null); expect(result.cases[0]!.errors).toMatchObject({ capture_status: "captured", classification_complete: false, entries: [{ reported_name: "unknown", signature: "unsupported", message: null }] });
  });
  it.each([127, 128, 129])("scans at most 128 stack lines, retaining an unverified site after %s private lines only if observed", (count) => {
    const f = p15Fixture(); f.tests[0]!.failureMessages = ["PRIVATE\n".repeat(count) + ` at x (${f.first.specification.moduleId}:1:1)`]; const error = projectP15SuiteFailures(JSON.stringify(f.raw), f.progress, f.summary, f.source.source_hashes).cases[0]!.errors.entries[0]!;
    expect(error.sites).toEqual(count === 127 ? [{ line: 1, column: 1 }] : []); expect(error.positions_status).toBe(count === 127 ? "reported-not-source-verified" : "limit-reached"); expect(JSON.stringify(error)).not.toContain("PRIVATE");
  });
  it("jointly fits maximum real original projections, full old slots and widest P13/P15 without claiming a partial report is a capture", async () => {
    const projection = createSuiteProgressProjection(), costs = createSuiteAttributionCosts(), workflow = createWorkflowCaseTimingProjection(), tail: SuiteProgressFrame[] = []; let sequence = 0, valid = true;
    const moduleSource = (ordinal: number) => ordinal === 17 ? "runner/workflow-orchestrator.test.ts" : `${ordinal < 17 ? "lib" : "scripts"}/${String(ordinal).padStart(3, "0")}-${"x".repeat(ordinal < 17 ? 176 : 172)}.test.ts`;
    const push = (event: SuiteProgressFrame["event"], ordinal: number | null = null, data: unknown = null, test: number | null = null, elapsed = 0) => {
      const frame = { schema_version: 1, kind: "suite-progress-observation", sequence: ++sequence, reporter_elapsed_ms: elapsed, event, module: ordinal === null ? null : { ordinal, source: moduleSource(ordinal) }, case: test === null ? null : { ordinal: test, alias: null }, data } as SuiteProgressFrame;
      valid = projection.accept(frame) && costs.accept(frame) && workflow.accept(frame) && valid; tail.push(frame); if (tail.length > 32) tail.shift();
    };
    push("reporter-init"); push("run-start", null, { module_count: 256 });
    for (let ordinal = 1; ordinal <= 256; ordinal++) { push("module-queued", ordinal); push("module-collected", ordinal, { case_count: ordinal === 17 ? 19940 : ordinal === 256 ? 60 : 0 }); push("module-start", ordinal); }
    for (let ordinal = 1; ordinal <= 20; ordinal++) { push("case-ready", 17, null, ordinal, ordinal * 3 - 2); push("case-result", 17, { state: "passed", original_attempt: null }, ordinal, ordinal * 3 - 1); }
    for (let ordinal = 21; ordinal <= 19936; ordinal++) push("case-result", 17, { state: "skipped", original_attempt: null }, ordinal, 60);
    for (let ordinal = 19937; ordinal <= 19940; ordinal++) push("case-ready", 17, null, ordinal, ordinal - 19876);
    for (let ordinal = 1; ordinal <= 60; ordinal++) push("case-ready", 256, null, ordinal, 65);
    for (let ordinal = 1; ordinal <= 252; ordinal++) push("module-end", ordinal, { state: ordinal === 17 ? "failed" : "passed" }, null, 899999.9999999999);
    const progress = projection.snapshot()!, cost = costs.snapshot()!, cases = workflow.snapshot()!;
    expect(valid).toBe(true); expect(progress.counts.collected).toBe(20000); expect(progress.open_cases).toHaveLength(64); expect(progress.tail).toHaveLength(32); expect(cost.ended?.top).toHaveLength(16); expect(cost.start_without_end?.top).toHaveLength(4); expect(cases.ended?.top).toHaveLength(16); expect(cases.open?.top).toHaveLength(4); expect(cases.coverage?.gaps.top).toHaveLength(4);
    let clocks = 0, settle!: () => void; const original = new Promise<void>((done) => { settle = done; }), harness = continuityHarness({ clock: () => clocks++ === 0 ? 0 : 899999.9999999999 });
    harness.observer.observeAttempt({ ...harness.fixture, options: harness.options }, () => original); harness.observer.checkpoint("wait-enter"); harness.observer.observePoll(() => undefined); settle(); await Promise.resolve();
    for (let index = 0; index < 64; index++) { harness.controller.release(harness.options.workflowExecution); harness.controller.reconcile(); }
    for (let index = 1; index < 256; index++) harness.observer.observePoll(() => undefined); harness.observer.checkpoint("wait-return");
    const continuity = harness.receipt(), wait = await completeWaitReceipt(), span = completeSpanReceipt(), source = workflowTimingSourceEnvelope();
    const report: SuiteWorkflowTimingDiagnosticReport = { ...p13EmptyReport(), wall_ms: 900000, source_hashes: source.source_hashes, source_hashes_after: { ...source.source_hashes }, source_drift: false, progress: compactSuiteProgress(progress), receipt: span, wait_receipt: wait, continuity_receipt: continuity, costs: cost, workflow_cases: cases };
    const safe = sanitizeSuiteWorkflowTimingDiagnostic(report, failureSourceLimits, { progress, costs: cost, workflow_cases: cases }); expect(safe).not.toBeNull();
    let serialized = JSON.stringify(safe); for (const receipt of [span, wait, continuity]) { const raw = JSON.stringify(receipt); serialized = serialized.replace(raw, raw.padEnd(8192, " ")); } for (const frame of tail) { const raw = JSON.stringify(frame); serialized = serialized.replace(raw, raw.padEnd(2048, " ")); }
    const originalLine = `${serialized}\n`, prior = formatP12ObservationLossLine(p13CapturedReceipt(), originalLine)!, receipt = p15WidestReceipt(), line = formatP15SuiteFailuresLine(receipt, originalLine, prior)!;
    expect(JSON.parse(serialized)).toEqual(safe); expect(prior).not.toBeNull(); expect(line).not.toBeNull(); expect(Buffer.byteLength(prior)).toBeLessThanOrEqual(2048); expect(Buffer.byteLength(line)).toBeLessThanOrEqual(4096); expect(Buffer.byteLength(`{"role":"suite-workflow-timing-report","report":${serialized}}\n${prior}${line}`)).toBeLessThanOrEqual(131072);
  });
});

// P16 additions preserve the complete 1157-test prefix except the authorized no-json write-count assertion.
import { createP16SuiteSampleCollector, createP16SuiteCandidateCollector, formatP16PartialSuiteLine, P16_SAMPLE_MARKER, P16_CANDIDATE_MARKER, P16_PARTIAL_MARKER, sanitizeP16PartialSuiteReceipt, type P16PartialSuiteReceipt } from "./profile-maintenance";

const p16Flags = { ...suiteProgressFlags, SURTEC_TEST_PLANNER_WAIT_PROFILE: "1", SURTEC_TEST_PLANNER_CONTINUITY_PROFILE: "1" };
const p16Values = { duration: 123.5, environmentSetupDuration: 7, prepareDuration: 11, collectDuration: 13, setupDuration: 17 };
const p16Compiled = ts.transpileModule(`${p13RecordText}\n${p15StrictParseText}\n${p13CompanionText}\n${p13ParentText}`.replace(/\bexport /g, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
function p16Private() {
  const deps = { nodeTypes: p13NodeTypes, ProfileDeadline, SUITE_PROGRESS_LIMITS, Buffer, createHash, SUITE_WORKFLOW_TIMING_SOURCES, OUTPUT_LIMIT: 8388608, join, repository: resolve("."), project: projectP15SuiteFailures, createSuiteProgressProjection, createSuiteAttributionCosts, createWorkflowCaseTimingProjection, compactSuiteProgress, sanitizeSuiteWorkflowTimingSourceMetadata, sanitizeSuiteProgressFrame, sanitizePlannerSpanReceipt, sanitizePlannerWaitReceipt, sanitizePlannerContinuityReceipt, sanitizeSuiteWorkflowTimingDiagnostic, sourceHashesChanged, superviseChild,
    spanTime: (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 900000, suiteExit: (value: unknown) => value,
    workflowTimingUnavailable: (deadline: ProfileDeadline, expired = false) => ({ ...p13EmptyReport(), status: expired ? "deadline" : "failed", wall_ms: deadline.elapsed() }) };
  const factory = new Function("deps", `const { nodeTypes, ProfileDeadline, SUITE_PROGRESS_LIMITS, Buffer, createHash, SUITE_WORKFLOW_TIMING_SOURCES, OUTPUT_LIMIT, join, repository, createSuiteProgressProjection, createSuiteAttributionCosts, createWorkflowCaseTimingProjection, compactSuiteProgress, sanitizeSuiteWorkflowTimingSourceMetadata, sanitizeSuiteProgressFrame, sanitizePlannerSpanReceipt, sanitizePlannerWaitReceipt, sanitizePlannerContinuityReceipt, sanitizeSuiteWorkflowTimingDiagnostic, sourceHashesChanged, superviseChild, spanTime, suiteExit, workflowTimingUnavailable } = deps;\n${p16Compiled}\nprojectP15SuiteFailures = deps.project; return { capture: createP12ObservationLossCapture, run: runSuiteWorkflowTimingDiagnosticWatchdog, controller: createP15ControllerCapture, state: h => observationLossHandles.get(h), controllerState: h => p15ControllerHandles.get(h), claim: claimP15Controller, rawFrame: p16ControllerFrame, rawSeal: p16ControllerSeal, rawReturn: p15ControllerReturn, unavailable: p16Unavailable, frame: (h, f) => p16ControllerFrame(p15ControllerHandles.get(h).partial, f), sample: (h, chunk) => p15ControllerHandles.get(h).partial.collector.push(chunk), finish: (h, r) => { const s = claimP15Controller(h); if (s) p16ControllerSeal(s.partial, r); return p15ControllerReturn(s, r); }, poison: kind => { if (kind === 'seal') sealP16Partial = () => { throw new Error('PRIVATE'); }; if (kind === 'format') formatP16PartialSuiteLine = () => { throw new Error('PRIVATE'); }; } };`);
  return factory(deps) as {
    capture: typeof createP12ObservationLossCapture; run: typeof runSuiteWorkflowTimingDiagnosticWatchdog;
    claim(handle: unknown): unknown; rawFrame(...args: unknown[]): void; rawSeal(...args: unknown[]): void; rawReturn(...args: unknown[]): SuiteWorkflowTimingDiagnosticReport; unavailable(...args: unknown[]): P16PartialSuiteReceipt;
    controller(): { handle: object; emit(report: unknown): void }; frame(handle: object, frame: SuiteProgressFrame): void; sample(handle: object, chunk: unknown): void; finish(handle: object, report: SuiteWorkflowTimingDiagnosticReport): SuiteWorkflowTimingDiagnosticReport;
    state(handle: object): { invalid: boolean; failures: { invalid: boolean; failed_count: number; selected: unknown[] }; partial: { target: boolean; invalid: boolean; collector: { push(chunk: unknown): void; finish(): unknown }; receipt: P16PartialSuiteReceipt | null } };
    controllerState(handle: object): { partial: { receipt: P16PartialSuiteReceipt | null } }; poison(kind: "seal" | "format"): void;
  };
}
function p16Fixture(options: { extra?: number; zero?: boolean; fillers?: number; runEnd?: boolean; status?: "failed" | "deadline"; env?: NodeJS.ProcessEnv; error?: unknown; diagnostic?: unknown; diagnosticThrows?: boolean; write?: (line: string) => unknown } = {}) {
  const first = progressModule("lib/a-partial.test.ts", ["PRIVATE duplicate", "PRIVATE duplicate"]), planner = progressModule("runner/workflow-orchestrator.test.ts", [PLANNER_FAILURE_CASE]), extra = progressModule("scripts/z-partial.test.ts", Array.from({ length: options.extra ?? 0 }, () => "PRIVATE extra"));
  const filler = Array.from({ length: options.fillers ?? 0 }, (_, index) => progressModule(`scripts/filler-${String(index).padStart(3, "0")}.test.ts`, ["PRIVATE filler", "PRIVATE filler"]));
  const defaultError = { stack: `AssertionError: PRIVATE expected/actual\n    at x (${first.specification.moduleId}:17:9)\n    at y (C:/PRIVATE/secret.ts:20:10)`, message: "PRIVATE message", name: "PRIVATE name" };
  first.tests.forEach((test) => { test.result = vi.fn(() => ({ state: options.zero ? "passed" : "failed", errors: [options.error === undefined ? defaultError : options.error] })); }); if (!options.zero) first.setState("failed");
  extra.tests.forEach((test) => { test.result = vi.fn(() => ({ state: "failed", errors: [{ stack: "TypeError: PRIVATE extra" }] })); }); if (extra.tests.length) extra.setState("failed");
  const diagnostic = vi.fn(function(this: unknown) { expect(this).toBe(planner.module); if (options.diagnosticThrows) throw new Error("PRIVATE diagnostic"); return options.diagnostic === undefined ? { ...p16Values, heap: "PRIVATE", importDurations: { PRIVATE: 1 } } : options.diagnostic; }); Object.assign(planner.module, { diagnostic });
  let elapsed = 0; const selected = [extra, first, planner, ...filler], lines: string[] = [], clock = vi.fn(() => elapsed), reporter = createSuiteProgressReporter({ env: options.env ?? p16Flags, clock, write: (line) => { lines.push(line); return options.write?.(line) ?? false; } });
  reporter.onInit(); reporter.onTestRunStart(selected.map((e) => e.specification));
  for (const entry of selected) { reporter.onTestModuleQueued(entry.module); reporter.onTestModuleCollected(entry.module); reporter.onTestModuleStart(entry.module); }
  for (const entry of selected) { if (filler.includes(entry)) elapsed += 0.01; for (const test of entry.tests) { reporter.onTestCaseReady(test); reporter.onTestCaseResult(test); } reporter.onTestModuleEnd(entry.module); }
  if (options.runEnd !== false) reporter.onTestRunEnd(selected.map((e) => e.module), [], options.zero ? "passed" : "failed");
  const frames = () => lines.filter((line) => line.startsWith("SUITE_PROGRESS_PROFILE ")).map((line) => JSON.parse(line.slice("SUITE_PROGRESS_PROFILE ".length)) as SuiteProgressFrame), progress = parseSuiteProgressOutput(lines.join(""))!, source = workflowTimingSourceEnvelope(), harness = { frames, progress }, costs = createSuiteAttributionCosts(), workflow = createWorkflowCaseTimingProjection();
  for (const frame of frames()) { costs.accept(frame); workflow.accept(frame); } const evidence = { costs: costs.snapshot(), workflow_cases: workflow.snapshot() };
  const report: SuiteWorkflowTimingDiagnosticReport = { ...p13EmptyReport(), status: options.status ?? "deadline", source_hashes: source.source_hashes, source_hashes_after: { ...source.source_hashes }, source_drift: false, progress: compactSuiteProgress(progress), costs: evidence.costs, workflow_cases: evidence.workflow_cases, native_exit: { code: 1, signal: null, received_ms: 8 }, stdio_close: { exit_code: 1, closed: true, expired: options.status !== "failed", failed: false }, last_progress_received_ms: 5 };
  return { first, planner, extra, filler, diagnostic, selected, reporter, lines, clock, frames, progress, source, report, harness, samples: lines.filter((line) => line.startsWith(P16_SAMPLE_MARKER)) };
}
function p16Controller(fixture: ReturnType<typeof p16Fixture>, samples = fixture.samples) {
  const api = p16Private(), capture = api.controller(); for (const frame of fixture.frames()) api.frame(capture.handle, frame); for (const line of samples) api.sample(capture.handle, line); expect(api.finish(capture.handle, fixture.report)).toBe(fixture.report);
  const receipt = api.controllerState(capture.handle).partial.receipt!; return { api, capture, receipt, line: `${P16_CANDIDATE_MARKER}${JSON.stringify(receipt)}\n` };
}
async function p16Bound(options: { fixture?: ReturnType<typeof p16Fixture>; line?: string | null; enabled?: boolean; after?: boolean; api?: ReturnType<typeof p16Private>; fault?: (api: ReturnType<typeof p16Private>, handle: object) => void } = {}) {
  const fixture = options.fixture ?? p16Fixture(), api = options.api ?? p16Private(), capture = api.capture(), child = new Child(), clock = vi.fn(() => 10), line = options.line === undefined ? p16Controller(fixture).line : options.line;
  const stderr = (chunk: unknown) => { const listener = child.stderr.on.mock.calls.find(([event]) => event === "data")?.[1] as ((chunk: unknown) => void) | undefined; listener?.(chunk); };
  child.send.mockImplementation(() => { child.emit("message", fixture.source); for (const frame of fixture.frames()) child.emit("message", { role: "suite-workflow-timing-frame", frame, received_ms: 5 }); child.emit("message", { role: "suite-workflow-timing-exit", native_exit: fixture.report.native_exit }); if (line !== null && !options.after) stderr(line); child.emit("message", p13FinalMessage(fixture.report)); if (line !== null && options.after) stderr(line); options.fault?.(api, capture.handle); child.emit("close", 0); });
  const report = await api.run(new ProfileDeadline(clock), () => child, options.enabled === false ? undefined : capture.handle); return { fixture, api, capture, child, clock, stderr, report, p13: capture.read(report), p14: capture.readDelta(report), p15: capture.readFailures(report), p16: capture.readPartial(report) };
}

describe("P16 independent partial identity and source-bound optional detail", () => {
  it("preserves all original prefix bytes except the single approved no-json assertion", () => {
    const tests = readFileSync(fileURLToPath(new URL("./profile-maintenance.test.ts", import.meta.url))), prefix = tests.subarray(0, 533639).toString("utf8"), normalized = prefix.replace('expect(write).toHaveBeenCalledTimes(kind === "no-json" ? 2 : 1)', 'expect(write).toHaveBeenCalledOnce()');
    expect(Buffer.byteLength(normalized)).toBe(533612); expect(createHash("sha256").update(normalized).digest("hex")).toBe("146f86454f3017cf3f893fbe6e994b11403aaa6a01724358096ce80f76aee7b7"); expect(tests.indexOf(Buffer.from("// P16 additions preserve"))).toBeGreaterThanOrEqual(533639);
    expect(PROFILE_LIMIT_MS).toBe(900000); expect(PROFILE_CLEANUP_RESERVE_MS).toBe(30000); expect(SUITE_PROGRESS_LIMITS.stderr_bytes).toBe(8388608); expect(SUITE_WORKFLOW_TIMING_CONTRACT_HASHES).toHaveLength(6);
  });
  it.each(["failed", "deadline"] as const)("retains two identities and canonical errors on %s with no final JSON/run-end beyond tail eviction", async (status) => {
    const fixture = p16Fixture({ fillers: 20, runEnd: false, status }), bound = await p16Bound({ fixture }); expect(bound.p13).toMatchObject({ capture_status: "captured", first_rejection: null, terminal: { branch: "report-returned" } }); expect(bound.report.json).toBeNull(); expect(bound.report.progress?.run_end).toBeNull(); expect(bound.report.progress?.tail.every((frame) => frame.module?.source !== "lib/a-partial.test.ts")).toBe(true); expect(bound.report.costs?.ended?.top.every((row) => row.source !== "lib/a-partial.test.ts")).toBe(true);
    expect(bound.p16).toMatchObject({ capture_status: "captured", partial: true, acceptance: false, binding: { original_status: status, run_end_seen: false, counts: { failed: 2 } }, failures: { selection: "lowest-two-admitted-tuples", observed: 2, retained: 2, omitted: 0, classification_complete: true, entries: [{ module: { source: "lib/a-partial.test.ts" }, case_ordinal: 1, errors: { entries: [{ signature: "assertion-failure", sites: [{ line: 17, column: 9 }] }] } }, { case_ordinal: 2 }] }, timing: { capture_status: "captured", measurement: "vitest-reported-inclusive-zero-fallback", values: p16Values } });
    expect(JSON.stringify(bound.p16)).not.toMatch(/PRIVATE|fullName|digest|stack|expected|actual|heap|importDurations/); expect(bound.p15.unavailable_reason).toBe("not-target-report");
  });
  it.each([0, 1, 3, 5])("separates first-two samples from lowest-two identities with %s earlier extra failures", async (extra) => {
    const bound = await p16Bound({ fixture: p16Fixture({ extra }) }); expect(bound.p16.capture_status).toBe("captured"); expect(bound.p16.failures).toMatchObject({ observed: 2 + extra, retained: 2, omitted: extra }); expect(bound.p16.failures!.entries.map((e) => e.module.source)).toEqual(["lib/a-partial.test.ts", "lib/a-partial.test.ts"]);
    expect(bound.p16.failures!.entries.map((e) => e.errors.capture_status)).toEqual(extra === 0 ? ["captured", "captured"] : extra === 1 ? ["captured", "unavailable"] : ["unavailable", "unavailable"]); expect(bound.p16.failures!.classification_complete).toBe(extra === 0);
  });
  it("permits only a known partial zero, never complete classification or suite acceptance", async () => {
    const bound = await p16Bound({ fixture: p16Fixture({ zero: true, runEnd: false }) }); expect(bound.p16).toMatchObject({ capture_status: "captured", partial: true, acceptance: false, failures: { observed: 0, retained: 0, omitted: 0, classification_complete: false, entries: [] }, timing: { capture_status: "captured" } }); expect(bound.report.status).toBe("deadline"); expect(bound.report.json).toBeNull();
  });
  it.each(["missing", "malformed", "duplicate", "wrong-point", "fingerprint", "sequence", "counts", "tuple", "timing-end"] as const)("keeps proven identity when candidate detail is %s", async (fault) => {
    const fixture = p16Fixture(), receipt = p16Controller(fixture).receipt; let line: string | null = null;
    if (fault === "wrong-point") receipt.observation_point = "watchdog-return"; else if (fault === "fingerprint") receipt.binding!.source_fingerprint = "b".repeat(64); else if (fault === "sequence") receipt.binding!.progress_sequence++; else if (fault === "counts") receipt.binding!.counts.ready++; else if (fault === "tuple") receipt.failures!.entries[1]!.case_ordinal++; else if (fault === "timing-end") receipt.timing!.reporter_end_ms = 1;
    if (fault !== "missing") line = fault === "malformed" ? `${P16_CANDIDATE_MARKER}PRIVATE\n` : `${P16_CANDIDATE_MARKER}${JSON.stringify(receipt)}\n`.repeat(fault === "duplicate" ? 2 : 1);
    const bound = await p16Bound({ fixture, line, after: true }); expect(bound.p16.capture_status).toBe("captured"); expect(bound.p16.failures?.entries.map((e) => e.case_ordinal)).toEqual([1, 2]); expect(bound.p16.timing?.capture_status).toBe("unavailable"); expect(bound.p13.first_rejection).toBeNull();
    expect(bound.p16.failures!.entries.every((e) => e.errors.capture_status === "unavailable")).toBe(fault !== "timing-end");
  });
  it.each(["source", "source-after", "selection", "latch", "p13", "seal", "optional-collector"] as const)("isolates %s faults without replaying old clocks/projections/effects", async (fault) => {
    const fixture = p16Fixture(), plain = await p16Bound({ fixture, enabled: false }), api = p16Private(); if (fault === "source") fixture.report.source_drift = null; if (fault === "source-after") { fixture.report.source_hashes_after = {}; fixture.report.source_drift = null; } if (fault === "seal") api.poison("seal");
    const baseline = fault.startsWith("source") ? await p16Bound({ fixture, enabled: false }) : plain;
    const bound = await p16Bound({ fixture, api, fault: (runtime, handle) => { const state = runtime.state(handle); if (fault === "selection") state.failures.selected = []; if (fault === "latch") state.failures.invalid = true; if (fault === "p13") state.invalid = true; if (fault === "optional-collector") state.partial.collector = { push() {}, finish() { throw new Error("PRIVATE"); } }; } });
    expect(bound.report).toEqual(baseline.report); expect(bound.clock.mock.calls).toEqual(baseline.clock.mock.calls); expect(bound.child.signals).toEqual(baseline.child.signals); expect(bound.p16.capture_status).toBe(fault === "optional-collector" ? "captured" : "unavailable"); if (fault === "optional-collector") expect(bound.p16.timing?.unavailable_reason).toBe("invalid-transport");
  });
  it("seals detached facts once and ignores foreign/reused/late references without getters", async () => {
    const capture = createP12ObservationLossCapture(), hook = vi.fn(() => { throw new Error("PRIVATE"); }), foreign = new Proxy({}, { get: hook, ownKeys: hook, getPrototypeOf: hook }); expect(capture.readPartial(foreign).unavailable_reason).toBe("incomplete-observation");
    const bound = await p16Bound(), saved = bound.capture.readPartial(bound.report); expect(bound.capture.readPartial(foreign).unavailable_reason).toBe("invalid-binding");
    bound.p16.failures!.entries[0]!.errors.entries[0]!.sites[0]!.line = 999; Object.defineProperty(bound.report, "status", { get: hook }); Object.defineProperty(bound.report, "source_hashes", { get: hook }); bound.stderr(foreign); expect(bound.capture.readPartial(bound.report)).toEqual(saved); expect(hook).not.toHaveBeenCalled();
    const launch = vi.fn(() => new Child()), reused = await bound.api.run(new ProfileDeadline(() => 900000), launch, bound.capture.handle); expect(launch).not.toHaveBeenCalled(); expect(bound.capture.readPartial(reused).unavailable_reason).toBe("invalid-binding"); expect(bound.capture.readPartial(bound.report)).toEqual(saved);
  });
});

describe("P16 reporter side calls and private transport", () => {
  it.each([{}, suiteProgressFlags, { ...p16Flags, SURTEC_TEST_PLANNER_WAIT_PROFILE: "0" }, { ...p16Flags, SURTEC_TEST_PLANNER_CONTINUITY_PROFILE: "0" }, { ...p16Flags, SURTEC_TEST_PLANNER_FAILURE_PROFILE: "0" }])("keeps non-full-workflow construction and hooks free of P16 calls", (env) => {
    const fixture = p16Fixture({ env }); expect(fixture.samples).toEqual([]); expect(fixture.diagnostic).not.toHaveBeenCalled();
  });
  it("uses the exact original result once and original clock/attempt trace, then one module diagnostic", () => {
    const plain = p16Fixture({ env: suiteProgressFlags }), observed = p16Fixture(); expect(observed.frames()).toEqual(plain.frames()); expect(observed.clock.mock.calls).toEqual(plain.clock.mock.calls); expect(observed.samples).toHaveLength(3); expect(observed.diagnostic).toHaveBeenCalledOnce(); expect(observed.first.tests.every((test) => vi.mocked(test.result).mock.calls.length === 1)).toBe(true); expect(vi.mocked(observed.planner.tests[0]!.diagnostic).mock.calls).toEqual(vi.mocked(plain.planner.tests[0]!.diagnostic).mock.calls); expect(observed.samples.every((line) => Buffer.byteLength(line) <= 2048)).toBe(true);
  });
  it.each(["getter", "proxy", "non-string", "unsupported", "message-only", "empty-stack", "name-getter"] as const)("normalizes %s errors without executing private getters or raw fallback", (kind) => {
    const hook = vi.fn(() => { throw new Error("PRIVATE"); }); let error: unknown = { message: "Test timed out in 5000ms." };
    if (kind === "getter") error = Object.defineProperty({}, "stack", { get: hook }); if (kind === "proxy") error = new Proxy({}, { get: hook, ownKeys: hook }); if (kind === "non-string") error = { stack: { toString: hook } }; if (kind === "unsupported") error = { stack: "PRIVATE arbitrary value" }; if (kind === "empty-stack") error = { stack: "", message: "Test timed out in 5000ms." }; if (kind === "name-getter") error = Object.defineProperty({ stack: "TypeError: PRIVATE" }, "name", { get: hook });
    const fixture = p16Fixture({ error }), result = p16Controller(fixture).receipt; expect(result.capture_status).toBe("captured"); expect(hook).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(result.failures!.entries[0]!.errors.capture_status).toBe(["getter", "proxy", "non-string"].includes(kind) ? "unavailable" : "captured"); if (kind === "unsupported") expect(result.failures!.classification_complete).toBe(false);
  });
  it.each(["throw", "getter", "negative", "infinite", "too-large", "missing", "zero"] as const)("keeps %s module timing optional and one-shot", (kind) => {
    const hook = vi.fn(() => { throw new Error("PRIVATE"); }), diagnostic = kind === "getter" ? Object.defineProperty({ ...p16Values }, "duration", { get: hook }) : { ...p16Values, duration: kind === "negative" ? -1 : kind === "infinite" ? Infinity : kind === "too-large" ? 900001 : kind === "missing" ? undefined : kind === "zero" ? 0 : 5 };
    const fixture = p16Fixture({ diagnostic, diagnosticThrows: kind === "throw" });
    const receipt = p16Controller(fixture).receipt; expect(receipt.failures?.classification_complete).toBe(true); expect(receipt.timing?.capture_status).toBe(kind === "zero" ? "captured" : "unavailable"); expect(fixture.diagnostic).toHaveBeenCalledOnce(); expect(hook).not.toHaveBeenCalled();
  });
  it.each(["false", "throw"])('claims sampling slots before a %s writer, with no replacement or original latch mutation', (mode) => {
    let attempts = 0; const fixture = p16Fixture({ extra: 4, write: (line) => { if (line.startsWith(P16_SAMPLE_MARKER)) { attempts++; if (mode === "throw") throw new Error("PRIVATE"); } return false; } }); expect(attempts).toBe(3); expect(fixture.progress.availability).toBe("available"); expect(fixture.progress.counts.failed).toBe(6); expect(fixture.diagnostic).toHaveBeenCalledOnce();
  });
  it.each(["errors", "module", "all"])('does not borrow another sample when %s detail is absent', (kind) => {
    const f = p16Fixture(), samples = f.samples.filter((line) => { const sample = JSON.parse(line.slice(P16_SAMPLE_MARKER.length)); return kind === "all" ? false : kind === "errors" ? sample.type !== "failure" : sample.type !== "module"; }), receipt = p16Controller(f, samples).receipt;
    expect(receipt.capture_status).toBe("captured"); expect(receipt.failures!.entries.every((e) => e.errors.capture_status === "unavailable")).toBe(kind !== "module"); expect(receipt.timing?.capture_status).toBe(kind === "errors" ? "captured" : "unavailable");
  });
  it.each(["source", "sequence", "case", "end", "state", "third-failure"])('refuses mismatched %s early detail without changing original progress', (kind) => {
    const f = p16Fixture(), samples = f.samples.map((line) => JSON.parse(line.slice(P16_SAMPLE_MARKER.length)) as Record<string, unknown>), target = samples[kind === "end" || kind === "state" ? 2 : 0]!;
    if (kind === "source") (target.module as { source: string }).source = "lib/foreign.test.ts"; if (kind === "sequence") target.sequence = 49999; if (kind === "case") target.case_ordinal = 20000; if (kind === "end") { target.reporter_elapsed_ms = 1; (target.timing as { reporter_end_ms: number }).reporter_end_ms = 1; } if (kind === "state") (target.timing as { state: string }).state = "failed"; if (kind === "third-failure") samples[2] = { ...samples[0], case_ordinal: 3 };
    const receipt = p16Controller(f, samples.map((s) => `${P16_SAMPLE_MARKER}${JSON.stringify(s)}\n`)).receipt; expect(receipt.capture_status).toBe("captured"); expect(receipt.timing?.capture_status).toBe("unavailable"); expect(f.progress.counts.failed).toBe(2);
  });
});

function p16WidestReceipt(): P16PartialSuiteReceipt {
  const receipt = p16Controller(p16Fixture()).receipt; receipt.observation_point = "watchdog-return";
  receipt.binding = { source_fingerprint: "a".repeat(64), progress_sequence: 50000, original_status: "deadline", selected_modules: 256, observed_modules: 256, ended_modules: 256, counts: { collected: 20000, ready: 20000, finished: 20000, passed: 0, failed: 20000, skipped: 0 }, run_end_seen: true };
  const wide = p15WidestReceipt(); receipt.failures = { selection: "lowest-two-admitted-tuples", observed: 20000, retained: 2, omitted: 19998, classification_complete: false, entries: wide.cases.map((test) => ({ module: test.module, case_ordinal: test.case_ordinal, errors: test.errors })) };
  receipt.timing = { capture_status: "captured", unavailable_reason: null, measurement: "vitest-reported-inclusive-zero-fallback", module: { ordinal: 17, source: "runner/workflow-orchestrator.test.ts" }, reporter_end_ms: 899999.9999999999, state: "passed", values: { duration: 900000, environmentSetupDuration: 900000, prepareDuration: 900000, collectDuration: 900000, setupDuration: 900000 } }; return receipt;
}

describe("P16 strict DTO masks, privacy and literal transport limits", () => {
  it.each(["watchdog-return", "controller-close"] as const)("detaches and validates the closed %s point", (point) => {
    const root = p16WidestReceipt(); root.observation_point = point; const safe = sanitizeP16PartialSuiteReceipt(root, point)!; expect(safe).toEqual(root); safe.failures!.entries[0]!.errors.entries[0]!.sites[0]!.line = 1; expect(root.failures!.entries[0]!.errors.entries[0]!.sites[0]!.line).toBe(10000); expect(sanitizeP16PartialSuiteReceipt(root, point === "watchdog-return" ? "controller-close" : "watchdog-return")).toBeNull();
  });
  it.each(["schema_version", "kind", "observation_point", "diagnostic_only", "acceptance", "sealed", "partial", "capture_status", "unavailable_reason", "binding", "failures", "timing"] as const)("rejects a missing or accessor %s without executing it", (key) => {
    const root = p16WidestReceipt(), missing = { ...root } as Record<string, unknown>, hook = vi.fn(() => { throw new Error("PRIVATE"); }); delete missing[key]; expect(sanitizeP16PartialSuiteReceipt(missing)).toBeNull(); Object.defineProperty(root, key, { get: hook }); expect(sanitizeP16PartialSuiteReceipt(root)).toBeNull(); expect(hook).not.toHaveBeenCalled();
  });
  it.each(["schema", "kind", "partial", "acceptance", "sealed", "extra", "sequence", "modules", "observed-modules", "ended-modules", "counts", "ready", "run-end", "selection", "retained", "omitted", "complete", "unsorted", "duplicate", "source", "case", "raw-errors", "raw-timing", "negative-time", "timing-mask"] as const)("rejects %s contract inconsistencies without repair", (fault) => {
    const r = p16WidestReceipt() as P16PartialSuiteReceipt & { extra?: unknown };
    if (fault === "schema") (r as unknown as { schema_version: number }).schema_version = 2; if (fault === "kind") (r as unknown as { kind: string }).kind = "p15-suite-failures"; if (fault === "partial") (r as unknown as { partial: boolean }).partial = false; if (fault === "acceptance") (r as unknown as { acceptance: boolean }).acceptance = true; if (fault === "sealed") (r as unknown as { sealed: boolean }).sealed = false; if (fault === "extra") r.extra = "PRIVATE";
    if (fault === "sequence") r.binding!.progress_sequence = 50001; if (fault === "modules") r.binding!.selected_modules = 257; if (fault === "observed-modules") r.binding!.observed_modules = 0; if (fault === "ended-modules") r.binding!.ended_modules = 257; if (fault === "counts") r.binding!.counts.finished--; if (fault === "ready") r.binding!.counts.ready = 0; if (fault === "run-end") (r.binding as unknown as { run_end_seen: string }).run_end_seen = "yes";
    if (fault === "selection") (r.failures as unknown as { selection: string }).selection = "delivery-order"; if (fault === "retained") r.failures!.retained = 1; if (fault === "omitted") r.failures!.omitted = 0; if (fault === "complete") r.failures!.classification_complete = true; if (fault === "unsorted") r.failures!.entries.reverse(); if (fault === "duplicate") r.failures!.entries[1] = r.failures!.entries[0]!; if (fault === "source") r.failures!.entries[0]!.module.source = "../PRIVATE.test.ts"; if (fault === "case") r.failures!.entries[0]!.case_ordinal = 20001;
    if (fault === "raw-errors") Object.assign(r.failures!.entries[0]!.errors, { stack: "PRIVATE" }); if (fault === "raw-timing") Object.assign(r.timing!.values!, { heap: "PRIVATE" }); if (fault === "negative-time") r.timing!.values!.duration = -1; if (fault === "timing-mask") r.timing!.capture_status = "unavailable";
    expect(sanitizeP16PartialSuiteReceipt(r)).toBeNull();
  });
  it.each(["incomplete-observation", "invalid-binding", "invalid-state", "not-target-report"] as const)("keeps unavailable %s roots completely masked", (reason) => {
    const root: P16PartialSuiteReceipt = { schema_version: 1, kind: "p16-partial-suite-evidence", observation_point: "watchdog-return", diagnostic_only: true, acceptance: false, sealed: true, partial: true, capture_status: "unavailable", unavailable_reason: reason, binding: null, failures: null, timing: null }; expect(sanitizeP16PartialSuiteReceipt(root)).toEqual(root); expect(sanitizeP16PartialSuiteReceipt({ ...root, timing: p16WidestReceipt().timing })).toBeNull(); expect(sanitizeP16PartialSuiteReceipt({ ...root, failures: {} })).toBeNull();
  });
  it.each(["sample", "candidate"] as const)("accepts exact %s line ceilings and permanently refuses the next byte", (kind) => {
    const fixture = p16Fixture(), line = kind === "sample" ? fixture.samples[0]! : p16Controller(fixture).line, cap = kind === "sample" ? 2048 : 4096;
    for (const bytes of [cap, cap + 1]) { const collector = kind === "sample" ? createP16SuiteSampleCollector() : createP16SuiteCandidateCollector(), padded = line.slice(0, -1).padEnd(bytes - 1, " ") + "\n"; expect(Buffer.byteLength(padded)).toBe(bytes); collector.push(padded); collector.push("unrelated\n"); expect(collector.finish().status).toBe(bytes === cap ? "captured" : "invalid"); collector.push(line); expect(collector.finish().status).toBe(bytes === cap ? "captured" : "invalid"); }
  });
  it.each(["sample", "candidate"] as const)("counts every %s lane byte inside the unchanged 8MiB bound", (kind) => {
    const fixture = p16Fixture(), line = kind === "sample" ? fixture.samples[0]! : p16Controller(fixture).line;
    for (const extra of [0, 1]) { const collector = kind === "sample" ? createP16SuiteSampleCollector() : createP16SuiteCandidateCollector(), input = Buffer.from("x".repeat(8388608 - Buffer.byteLength(line) - 1 + extra) + "\n" + line); expect(input.byteLength).toBe(8388608 + extra); collector.push(input); expect(collector.finish().status).toBe(extra ? "invalid" : "captured"); }
  });
  it.each(["duplicate-key", "escaped-key", "truncated", "invalid-utf8", "wrong-variant", "duplicate", "excess", "accessor-chunk"] as const)("permanently rejects %s native samples without retaining raw text", (fault) => {
    const fixture = p16Fixture(), line = fixture.samples[0]!, collector = createP16SuiteSampleCollector(), hook = vi.fn(() => { throw new Error("PRIVATE"); });
    if (fault === "duplicate-key") collector.push(line.replace('"schema_version":1', '"schema_version":1,"schema_version":1')); else if (fault === "escaped-key") collector.push(line.replace('"schema_version"', '"schema\\u005fversion"')); else if (fault === "truncated") collector.push(line.slice(0, -1)); else if (fault === "invalid-utf8") collector.push(Buffer.from([0xff])); else if (fault === "wrong-variant") collector.push(line.replace('"type":"failure"', '"type":"module"')); else if (fault === "duplicate") collector.push(line.repeat(2)); else if (fault === "excess") { const row = JSON.parse(line.slice(P16_SAMPLE_MARKER.length)); for (let index = 0; index < 3; index++) collector.push(`${P16_SAMPLE_MARKER}${JSON.stringify({ ...row, sequence: row.sequence + index, case_ordinal: index + 1 })}\n`); } else collector.push(new Proxy({}, { get: hook, ownKeys: hook }));
    const before = collector.finish(); expect(before).toEqual({ status: "invalid", rows: [] }); collector.push(line); expect(collector.finish()).toEqual(before); expect(hook).not.toHaveBeenCalled();
  });
  it("supports byte-split UTF-8 unrelated text and returns detached sealed samples", () => {
    const f = p16Fixture(), collector = createP16SuiteSampleCollector(), bytes = Buffer.from("PRIVATE é🙂\n" + f.samples.join("")); for (const byte of bytes) collector.push(Buffer.from([byte])); const first = collector.finish(); expect(first.status).toBe("captured"); expect(first.rows).toHaveLength(3); first.rows[0]!.module.source = "lib/foreign.test.ts"; collector.push(f.samples[0]); expect(collector.finish().rows[0]!.module.source).toBe("lib/a-partial.test.ts"); expect(JSON.stringify(collector.finish())).not.toContain("PRIVATE");
  });
  it("does not filter side sample bytes out of the original progress collector", () => {
    const f = p16Fixture(), text = f.lines.join(""); for (const extra of [0, 1]) { const input = "x".repeat(8388608 - Buffer.byteLength(text) - 1 + extra) + "\n" + text, collector = createSuiteProgressCollector(); collector.push(Buffer.from(input)); const snapshot = collector.finish(); if (extra) expect(snapshot).toBeNull(); else expect(snapshot?.availability).toBe("available"); }
  });
});

describe("P16 original controller and CLI priority, once-only bounded output", () => {
  it.each(["normal", "false", "p13-throw", "p16-throw", "reentrant", "format-throw", "suppressed"] as const)("retains exact original output/effects with %s side writes", async (mode) => {
    const api = p16Private(); if (mode === "format-throw") api.poison("format"); const bound = await p16Bound({ api }), original = `${JSON.stringify(bound.report)}\n`, lines: string[] = [], hook = vi.fn(() => { throw new Error("PRIVATE late report read"); }); Object.defineProperty(bound.report, "status", { get: hook });
    const write = vi.fn((line: string) => { lines.push(line); if (mode === "reentrant") bound.capture.emit(bound.report, original, write); if (mode === "p13-throw" && line.startsWith("P12_") || mode === "p16-throw" && line.startsWith(P16_PARTIAL_MARKER)) throw new Error("PRIVATE writer"); return mode !== "false"; });
    bound.capture.emit(bound.report, mode === "suppressed" ? "{}".padEnd(131073, " ") + "\n" : original, write); bound.capture.emit(bound.report, original, write); const first = formatP12ObservationLossLine(bound.p13, original)!;
    expect(lines).toEqual(mode === "suppressed" ? [] : mode === "p13-throw" || mode === "format-throw" ? [first] : [first, formatP16PartialSuiteLine(bound.p16, original, first)]); expect(hook).not.toHaveBeenCalled(); expect(bound.child.send).toHaveBeenCalledOnce(); expect(bound.child.signals).toEqual([]); expect(bound.report.json).toBeNull();
  });
  it("does not fall back to P16 after existing P14/P15 targets or attempts", async () => {
    for (const bound of [await p14BoundTarget(), await p15Bound()]) { const lines: string[] = []; bound.capture.emit(bound.report, `${JSON.stringify(bound.report)}\n`, (line) => { lines.push(line); if (!line.startsWith("P12_")) throw new Error("PRIVATE"); }); expect(lines).toHaveLength(2); expect(lines.some((line) => line.startsWith(P16_PARTIAL_MARKER))).toBe(false); }
  });
  it.each(["normal", "false", "callback-error", "send-throw", "write-throw", "reentrant"] as const)("preserves the source-composed original controller send with %s", async (mode) => {
    const fixture = p16Fixture(), api = p16Private(), order: string[] = [], lines: string[] = [], messages: unknown[] = []; let exit: number | undefined, capture: ReturnType<typeof api.controller>;
    const processFake = { connected: true, get exitCode() { return exit; }, set exitCode(value: number | undefined) { exit = value; order.push("exit"); }, disconnect() { order.push("disconnect"); this.connected = false; }, send(message: unknown, callback: (error: Error | null) => void) { order.push("send"); messages.push(message); if (mode === "send-throw") throw new Error("PRIVATE"); order.push("callback"); callback(mode === "callback-error" ? new Error("PRIVATE") : null); return mode !== "false"; } };
    const write = vi.spyOn(process.stderr, "write").mockImplementation((value) => { order.push("p16"); lines.push(String(value)); if (mode === "reentrant") capture.emit(fixture.report); if (mode === "write-throw") throw new Error("PRIVATE"); return false; });
    const worker = p13ProfilerText.slice(p13ProfilerText.indexOf("async function suiteWorkflowTimingControllerWorker("), p13ProfilerText.indexOf("export class ProfileDeadline")), code = ts.transpileModule(worker, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const invoke = new Function("process", "suiteExact", "finite", "ProfileDeadline", "createP15ControllerCapture", "runLoadedSuiteWorkflowTiming", `${code}\nreturn suiteWorkflowTimingControllerWorker;`)(processFake, (value: unknown) => value, Number.isFinite, ProfileDeadline, () => { order.push("capture"); return capture = api.controller(); }, async (_deadline: unknown, _source: unknown, _delta: unknown, handle: object) => { order.push("run"); for (const frame of fixture.frames()) api.frame(handle, frame); for (const sample of fixture.samples) api.sample(handle, sample); return api.finish(handle, fixture.report); }) as (value: unknown) => Promise<void>;
    await invoke({ role: "suite-workflow-timing-controller", origin_ms: performance.timeOrigin }); expect(messages).toEqual([{ role: "suite-workflow-timing-report", report: fixture.report }]); expect(order).toEqual(mode === "send-throw" ? ["capture", "run", "send", "disconnect", "exit"] : ["capture", "run", "send", "callback", "disconnect", "exit", "p16"]); expect(exit).toBe(mode === "send-throw" || mode === "callback-error" ? 1 : 0); expect(write).toHaveBeenCalledTimes(mode === "send-throw" ? 0 : 1); expect(lines.every((line) => line.startsWith(P16_CANDIDATE_MARKER) && Buffer.byteLength(line) <= 4096 && !line.includes("PRIVATE"))).toBe(true); write.mockRestore();
  });
  it("keeps the single original CLI serialization/write/exit/emit sequence untouched", async () => {
    const cli = p13ProfilerText.slice(p13ProfilerText.lastIndexOf('} else if (process.argv[1] && resolve(process.argv[1]) === script) {') + 2), body = cli.slice(cli.indexOf("  try {"), cli.lastIndexOf("}")); expect(body.match(/observation\?\.emit\(report, line\)/g)).toHaveLength(1); expect(body).not.toMatch(/P16_|readPartial/);
    const bound = await p16Bound(), stdout: string[] = [], stderr: string[] = [], order: string[] = []; let exit: number | undefined;
    const fakeProcess = { argv: ["node", "profiler", "--workload=full-suite-workflow-timing"], stdout: { write(line: string) { order.push("stdout"); stdout.push(line); } }, stderr: { write(line: string) { order.push("stderr"); stderr.push(line); } }, set exitCode(value: number | undefined) { exit = value; order.push("exit"); } };
    const code = ts.transpileModule(`async function invoke() { ${body} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, names = ["process", "parseProfileArguments", "createP12ObservationLossCapture", "runSuiteWorkflowTimingDiagnosticWatchdog"];
    const capture = { handle: bound.capture.handle, emit(report: unknown, line: string) { order.push("emit"); bound.capture.emit(report, line, (value) => fakeProcess.stderr.write(value)); } };
    await new Function(...names, `${code}\nreturn invoke();`)(fakeProcess, parseProfileArguments, () => capture, async (_deadline: unknown, _launch: unknown, handle: unknown) => { expect(handle).toBe(capture.handle); order.push("watchdog"); return bound.report; });
    expect(stdout).toEqual([`${JSON.stringify(bound.report)}\n`]); expect(exit).toBe(1); expect(order).toEqual(["watchdog", "stdout", "exit", "emit", "stderr", "stderr"]); expect(stderr[0]).toMatch(/^P12_OBSERVATION_LOSS_PROFILE /); expect(stderr[1]).toMatch(/^P16_PARTIAL_SUITE_PROFILE /);
  });
  it("fits maximal P16 widths and enforces the literal 131072/131073 joint boundary", () => {
    const receipt = p16WidestReceipt(), original = "{}\n", p13 = formatP12ObservationLossLine(p13CapturedReceipt(), original)!, line = formatP16PartialSuiteLine(receipt, original, p13)!; expect(sanitizeP16PartialSuiteReceipt(receipt)).toEqual(receipt); expect(line).not.toBeNull(); expect(Buffer.byteLength(line)).toBeLessThanOrEqual(4096);
    const wrapper = Buffer.byteLength('{"role":"suite-workflow-timing-report","report":') + 1, base = Buffer.byteLength(original) + wrapper + Buffer.byteLength(p13) + Buffer.byteLength(line), padded = original.slice(0, -1).padEnd(2 + 131072 - base, " ") + "\n"; expect(Buffer.byteLength(padded) + wrapper + Buffer.byteLength(p13) + Buffer.byteLength(line)).toBe(131072); expect(formatP16PartialSuiteLine(receipt, padded, p13)).toBe(line); expect(formatP16PartialSuiteLine(receipt, padded.slice(0, -1) + " \n", p13)).toBeNull(); expect(formatP16PartialSuiteLine(receipt, original, p13.padEnd(2049, " ") + "\n")).toBeNull();
  });
  it("composes maximal real original projections/frames/receipts without enlarging any slot", async () => {
    const source = readFileSync(fileURLToPath(new URL("./profile-maintenance.test.ts", import.meta.url))).subarray(0, 533639).toString("utf8"), start = source.indexOf('it("jointly fits maximum real original projections, full old slots and widest P13/P15'), begin = source.indexOf("async () => {", start) + "async () => {".length, end = source.indexOf("\n  });", begin); expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
    const code = ts.transpileModule(`async function verify() { ${source.slice(begin, end)}\n }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const deps = { expect, createSuiteProgressProjection, createSuiteAttributionCosts, createWorkflowCaseTimingProjection, continuityHarness, completeWaitReceipt, completeSpanReceipt, workflowTimingSourceEnvelope, p13EmptyReport, compactSuiteProgress, sanitizeSuiteWorkflowTimingDiagnostic, failureSourceLimits, formatP12ObservationLossLine, p13CapturedReceipt, p15WidestReceipt: p16WidestReceipt, formatP15SuiteFailuresLine: formatP16PartialSuiteLine };
    await new Function(...Object.keys(deps), `${code}\nreturn verify();`)(...Object.values(deps));
  });
});

describe("P16 exact source-composed loaded boundary and noninterference", () => {
  it("feeds original stderr first, preserving original projection/snapshot/clock/summary/source calls even on side seal failure", async () => {
    const code = ts.transpileModule(p13ProfilerText.slice(p13ProfilerText.indexOf("async function runLoadedSuiteWorkflowTiming("), p13ProfilerText.indexOf("// P13 observes only")), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    async function run(enabled: boolean, fault = false) {
      const fixture = p16Fixture(), api = p16Private(), capture = api.controller(), child = new Child(), trace: string[] = [], clock = vi.fn(() => 10), summary = vi.fn(summarizeSuiteProgressJson), metadata = vi.fn(), delta = vi.fn();
      const projection = (kind: "costs" | "workflow") => { const actual = kind === "costs" ? createSuiteAttributionCosts() : createWorkflowCaseTimingProjection(); return { accept(frame: SuiteProgressFrame) { trace.push(kind + ".accept"); return actual.accept(frame); }, revoke() { trace.push(kind + ".revoke"); actual.revoke(); }, snapshot() { trace.push(kind + ".snapshot"); return actual.snapshot(); } }; };
      const deps = { workflowTimingUnavailable: (deadline: ProfileDeadline) => ({ ...p13EmptyReport(), wall_ms: deadline.elapsed() }), claimP15Controller: api.claim, p15ControllerReturn: api.rawReturn, p16ControllerFrame: api.rawFrame, p16ControllerSeal: fault ? () => { throw new Error("PRIVATE"); } : api.rawSeal, p16Unavailable: api.unavailable,
        sourceHashes: () => { trace.push("hashes"); return fixture.source.source_hashes; }, SUITE_WORKFLOW_TIMING_SOURCES, preparePlannerFailureSourceMetadata: () => ({ fixture_sha256: fixture.source.fixture_sha256, sourceLimits: fixture.source.sourceLimits }), sanitizeSuiteWorkflowTimingSourceMetadata, prefixInventory: () => { trace.push("inventory"); return new Set(); }, createSuiteAttributionCosts: () => projection("costs"), createWorkflowCaseTimingProjection: () => projection("workflow"), createSuiteProgressCollector, spanTime: (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 900000,
        createWorkflowTimingOutputCollector: () => ({ push() {}, finish: () => ({ receipt: null, wait_receipt: null, continuity_receipt: null }), valid() { trace.push("valid"); return true; } }), spawn: () => { trace.push("spawn"); return child; }, repository: resolve("."), suiteWorkflowTimingArguments: () => [], suiteWorkflowTimingEnvironment: () => ({}), suiteExit: (value: unknown) => value,
        superviseChild: async () => { trace.push("supervise"); child.emit("exit", 1, null); return { exit_code: 1, closed: true, expired: true, failed: false }; }, compactSuiteProgress, summarizeSuiteProgressJson: summary, sourceHashesChanged, sanitizeSuiteWorkflowTimingDiagnostic };
      child.stderr.on.mockImplementation((_event, callback: (chunk: Buffer) => void) => { callback(Buffer.from(fixture.lines.join(""))); });
      const invoke = new Function(...Object.keys(deps), `${code}\nreturn runLoadedSuiteWorkflowTiming;`)(...Object.values(deps)) as (deadline: ProfileDeadline, metadata: (value: unknown) => void, delta: (value: unknown) => void, handle?: object) => Promise<SuiteWorkflowTimingDiagnosticReport>;
      const report = await invoke(new ProfileDeadline(clock), metadata, delta, enabled ? capture.handle : undefined); return { fixture, api, capture, report, trace, clock, summary, metadata, delta, child };
    }
    const old = await run(false), observed = await run(true), fault = await run(true, true);
    for (const next of [observed, fault]) { expect(next.report).toEqual(old.report); expect(next.trace).toEqual(old.trace); expect(next.clock.mock.calls).toEqual(old.clock.mock.calls); expect(next.summary).toHaveBeenCalledOnce(); expect(next.metadata.mock.calls).toEqual(old.metadata.mock.calls); expect(next.delta.mock.calls).toEqual(old.delta.mock.calls); expect(next.child.stderr.on).toHaveBeenCalledOnce(); }
    expect(observed.report).toMatchObject({ status: "deadline", json: null, source_drift: false }); expect(observed.api.controllerState(observed.capture.handle).partial.receipt).toMatchObject({ capture_status: "captured", failures: { observed: 2, classification_complete: true }, timing: { capture_status: "captured" } }); expect(fault.api.controllerState(fault.capture.handle).partial.receipt?.unavailable_reason).toBe("invalid-state");
  });
  it.each([2048, 2049])("enforces exact %s whole-byte reporter sample writes without changing old frames or retrying", (size) => {
    const original = JSON.stringify; vi.spyOn(JSON, "stringify").mockImplementation(((value: unknown) => { const raw = original(value); return (value as { kind?: unknown })?.kind === "p16-suite-sample" ? raw.padEnd(size - P16_SAMPLE_MARKER.length - 1, " ") : raw; }) as typeof JSON.stringify);
    const f = p16Fixture({ extra: 4 }); expect(f.progress.availability).toBe("available"); expect(f.progress.counts.failed).toBe(6); expect(f.samples).toHaveLength(size === 2048 ? 3 : 0); expect(f.samples.every((line) => Buffer.byteLength(line) === size)).toBe(true); vi.mocked(JSON.stringify).mockRestore();
  });
  it.each([4096, 4097])("suppresses only a %s-byte P16 public line while retaining P13", (size) => {
    const receipt = p16WidestReceipt(), prior = formatP12ObservationLossLine(p13CapturedReceipt(), "{}\n")!, stringify = JSON.stringify, raw = stringify(receipt);
    vi.spyOn(JSON, "stringify").mockImplementation(((value: unknown) => (value as { kind?: unknown })?.kind === "p16-partial-suite-evidence" ? raw.padEnd(size - P16_PARTIAL_MARKER.length - 1, " ") : stringify(value)) as typeof JSON.stringify);
    const line = formatP16PartialSuiteLine(receipt, "{}\n", prior); expect(line !== null).toBe(size === 4096); if (line) { expect(Buffer.byteLength(line)).toBe(size); expect(JSON.parse(line.slice(P16_PARTIAL_MARKER.length))).toEqual(receipt); } expect(formatP12ObservationLossLine(p13CapturedReceipt(), "{}\n")).toBe(prior); vi.mocked(JSON.stringify).mockRestore();
  });
  it("retains exact result/attempt receivers and does not inspect result errors unless admitted", () => {
    const f = p16Fixture(); for (const test of [...f.first.tests, ...f.planner.tests]) expect(vi.mocked(test.result).mock.contexts).toEqual([test]); expect(vi.mocked(f.planner.tests[0]!.diagnostic).mock.contexts).toEqual([f.planner.tests[0]]);
    for (const env of [suiteProgressFlags, p16Flags]) { const entry = progressModule("lib/throwing-result.test.ts", ["PRIVATE"]), hook = vi.fn(() => { throw new Error("PRIVATE forbidden"); }), thrown = Object.defineProperty({}, "message", { get: hook }), result = vi.fn(function(this: unknown) { expect(this).toBe(entry.tests[0]); throw thrown; }); entry.tests[0]!.result = result;
      const lines: string[] = [], reporter = createSuiteProgressReporter({ env, clock: () => 0, write: (line) => lines.push(line) }); reporter.onInit(); reporter.onTestRunStart([entry.specification]); reporter.onTestModuleQueued(entry.module); reporter.onTestModuleCollected(entry.module); reporter.onTestModuleStart(entry.module); reporter.onTestCaseReady(entry.tests[0]!); expect(() => reporter.onTestCaseResult(entry.tests[0]!)).not.toThrow(); expect(parseSuiteProgressOutput(lines.join(""))?.availability).toBe("unavailable"); expect(lines.some((line) => line.startsWith(P16_SAMPLE_MARKER))).toBe(false); expect(result).toHaveBeenCalledOnce(); expect(hook).not.toHaveBeenCalled(); }
  });
});
