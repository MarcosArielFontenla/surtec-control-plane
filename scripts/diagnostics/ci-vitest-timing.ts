import { createWriteStream, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { types } from "node:util";
import type { TestCase } from "vitest/node";
import { redactText } from "../../lib/security/redaction";
import {
  createSuiteAttributionCosts,
  createSuiteProgressCollector,
  createSuiteProgressReporter,
  PROFILE_LIMIT_MS,
  SUITE_PROGRESS_LIMITS,
  type SuiteProgressFrame,
} from "../profile-maintenance";

const marker = Buffer.from("SUITE_PROGRESS_PROFILE ");
const durationSeparator = "\t";
type ProgressReporter = ReturnType<typeof createSuiteProgressReporter>;
type TimingCase = Omit<Parameters<ProgressReporter["onTestCaseResult"]>[0], "diagnostic" | "result"> & Pick<TestCase, "diagnostic" | "result">;

const failureTargets = [
  { source: "runner/worktree.test.ts", name: "rejects untracked mutation after a passing preflight", file: "vitest-failure-worktree-untracked.json" },
  { source: "lib/routines/actions.test.ts", name: "does not overwrite or unlink a hard-linked report target", file: "vitest-failure-actions-hardlink.json" },
] as const;
type FailureTarget = typeof failureTargets[number];
type CaseResultFrame = Extract<SuiteProgressFrame, { event: "case-result" }>;
type FailureSite = { line: number; column: number };
type FailureReceipt = {
  schema_version: 1;
  source: FailureTarget["source"];
  name: FailureTarget["name"];
  sequence: number;
  module_ordinal: number;
  case_ordinal: number;
  reporter_origin_ms: number;
  error_name: string | null;
  message: string;
  code: string | null;
  syscall: string | null;
  site: FailureSite | null;
  redacted: boolean;
  truncated: boolean;
  omitted_errors: number;
};
const receiptLimit = SUITE_PROGRESS_LIMITS.frame_bytes;
const messageLimit = 1024;
const inspectedTextLimit = 8192;
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const tempParent = fileURLToPath(new URL("../../tmp", import.meta.url));
const fieldPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const regexEscape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function captureDirectory(requested: string | undefined) {
  const directory = requested && resolve(requested);
  if (!directory || dirname(directory) !== resolve(tempParent)
    || !/^ci-vitest-timing-[a-f0-9]{8,32}$/.test(basename(directory))
    || realpathSync(directory) !== directory) {
    throw new Error("CI timing requires a dedicated repository temporary directory");
  }
  return directory;
}

function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function safeField(value: unknown): string | null {
  return typeof value === "string" && fieldPattern.test(value) && redactText(value) === value ? value : null;
}

function failureMessage(raw: string, directory: string) {
  const original = raw.slice(0, inspectedTextLimit);
  let sanitized = redactText(original.replace(/\bbearer[ \t]+[^\s"',;]+/gi, "Bearer [REDACTED]"));
  for (const path of [directory, tmpdir()]) {
    const paths = new Set([path, path.replaceAll("\\", "/"), path.replaceAll("/", "\\")]);
    for (const variant of paths) {
      sanitized = sanitized.replace(new RegExp(regexEscape(variant), process.platform === "win32" ? "gi" : "g"), "[TEMP]");
    }
  }

  let message = "", bytes = 0;
  for (const character of sanitized) {
    const size = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes + size > messageLimit) break;
    message += character;
    bytes += size;
  }
  return { message, redacted: sanitized !== original, truncated: message !== sanitized || original.length !== raw.length };
}

function errorSite(error: unknown, source: string): FailureSite | null {
  const absolute = resolve(repoRoot, source);
  const names = [source, absolute, pathToFileURL(absolute).href].map((name) => name.replaceAll("\\", "/"));
  const flags = process.platform === "win32" ? "mi" : "m";
  const stack = ownValue(error, "stack");
  if (typeof stack === "string") {
    const pattern = new RegExp("(?:^|[ (])(?:" + names.map(regexEscape).join("|")
      + "):([1-9]\\d{0,6}):([1-9]\\d{0,6})(?=\\)?\\r?$)", flags);
    const match = pattern.exec(stack.slice(0, inspectedTextLimit).replaceAll("\\", "/"));
    if (match) return { line: Number(match[1]), column: Number(match[2]) };
  }
  const stacks = ownValue(error, "stacks");
  if (!Array.isArray(stacks) || types.isProxy(stacks)) return null;
  const files = new RegExp("^(?:" + names.map(regexEscape).join("|") + ")$", flags.replace("m", ""));
  for (let index = 0; index < Math.min(stacks.length, 32); index++) {
    const entry = ownValue(stacks, String(index));
    const file = ownValue(entry, "file"), line = ownValue(entry, "line"), column = ownValue(entry, "column");
    if (typeof file === "string" && file.length <= inspectedTextLimit && files.test(file.replaceAll("\\", "/"))
      && positiveInteger(line, 9999999) && positiveInteger(column, 9999999)) return { line, column };
  }
  return null;
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function captureFailure(directory: string, origin: number | undefined, frame: CaseResultFrame, testCase: TimingCase) {
  try {
    const target = failureTargets.find((item) => item.source === frame.module?.source && item.name === testCase.name);
    if (!target || !frame.module || !frame.case || origin === undefined || !Number.isFinite(origin)) return;
    const result = testCase.result();
    const errors = ownValue(result, "errors");
    if (result.state !== "failed" || !Array.isArray(errors) || types.isProxy(errors)) return;
    const error = ownValue(errors, "0"), message = ownValue(error, "message");
    if (typeof message !== "string" || message.length === 0) return;
    const receipt: FailureReceipt = {
      schema_version: 1, source: target.source, name: target.name, sequence: frame.sequence,
      module_ordinal: frame.module.ordinal, case_ordinal: frame.case.ordinal, reporter_origin_ms: origin,
      error_name: safeField(ownValue(error, "name") ?? ownValue(error, "nameStr")),
      ...failureMessage(message, directory),
      code: safeField(ownValue(error, "code")), syscall: safeField(ownValue(error, "syscall")),
      site: errorSite(error, target.source), omitted_errors: errors.length - 1,
    };
    const serialized = JSON.stringify(receipt) + "\n";
    if (Buffer.byteLength(serialized) <= receiptLimit) {
      writeFileSync(join(directory, target.file), serialized, { flag: "wx", mode: 0o600, flush: true });
    }
  } catch {
    // Side evidence is best effort. A capture failure cannot alter the run or its progress.
  }
}

function readFailure(directory: string, target: FailureTarget, origin: number | null): FailureReceipt | null {
  try {
    const file = join(directory, target.file);
    const stats = lstatSync(file);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > receiptLimit) return null;
    const bytes = readFileSync(file);
    if (bytes.length > receiptLimit) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const data = JSON.parse(text) as FailureReceipt;
    if (JSON.stringify(data) + "\n" !== text || Object.keys(data).length !== 15
      || data.schema_version !== 1 || data.source !== target.source || data.name !== target.name
      || !Number.isFinite(origin) || data.reporter_origin_ms !== origin
      || !positiveInteger(data.sequence, SUITE_PROGRESS_LIMITS.frames)
      || !positiveInteger(data.module_ordinal, SUITE_PROGRESS_LIMITS.modules)
      || !positiveInteger(data.case_ordinal, SUITE_PROGRESS_LIMITS.cases)
      || data.error_name !== safeField(data.error_name) || data.code !== safeField(data.code) || data.syscall !== safeField(data.syscall)
      || typeof data.message !== "string" || !data.message.length || Buffer.byteLength(JSON.stringify(data.message)) - 2 > messageLimit
      || failureMessage(data.message, directory).message !== data.message
      || typeof data.redacted !== "boolean" || typeof data.truncated !== "boolean"
      || !(data.omitted_errors === 0 || positiveInteger(data.omitted_errors, Number.MAX_SAFE_INTEGER))
      || !(data.site === null || Object.keys(data.site).length === 2 && positiveInteger(data.site.line, 9999999)
        && positiveInteger(data.site.column, 9999999))) return null;
    return data;
  } catch {
    return null;
  }
}

export function readCiVitestFailures(directory: string, bytes: Buffer, boundary: TimingBoundary) {
  const capture = captureDirectory(directory);
  const receipts = failureTargets.map((target) => readFailure(capture, target, boundary.reporterOriginMs));
  const matched = new Set<FailureReceipt>();
  const progress = summarizeTiming(bytes, boundary, (frame) => {
    for (const receipt of receipts) {
      if (receipt && receipt.sequence === frame.sequence && receipt.source === frame.module?.source
        && receipt.module_ordinal === frame.module.ordinal && receipt.case_ordinal === frame.case?.ordinal) matched.add(receipt);
    }
  });
  return failureTargets.map(({ source, name }, index) => {
    const receipt = receipts[index];
    return receipt && matched.has(receipt) && progress.status !== "unavailable"
      ? { source, name, status: "captured" as const, receipt }
      : { source, name, status: "unknown" as const };
  });
}


export default class CiVitestTimingReporter {
  private readonly directory: string;
  private readonly output: ReturnType<typeof createWriteStream>;
  private readonly closed: Promise<boolean>;
  private readonly observer: ProgressReporter;
  private originMs?: number;
  private reportingCase?: TimingCase;

  constructor() {
    const directory = captureDirectory(process.env.SURTEC_CI_VITEST_TIMING_DIR);
    this.directory = directory;
    this.output = createWriteStream(join(directory, "vitest-progress.log"), { flags: "wx", mode: 0o600 });
    let failed = false;
    let capturedBytes = 0;
    this.closed = new Promise((done) => {
      this.output.on("error", () => { failed = true; });
      this.output.once("close", () => done(!failed && this.output.writableFinished));
    });
    this.observer = createSuiteProgressReporter({
      env: { SURTEC_TEST_SUITE_PROGRESS_PROFILE: "1", SURTEC_TEST_PLANNER_SPAN_PROFILE: "1" },
      clock: () => {
        const now = performance.now();
        this.originMs ??= performance.timeOrigin + now;
        return now;
      },
      write: (line) => {
        if (failed) return;
        // The historical reporter emits synchronously. Keep the duration on its own case-result line.
        const testCase = this.reportingCase;
        const frame: SuiteProgressFrame | undefined = testCase && JSON.parse(line.slice(marker.length));
        if (testCase && frame?.event === "case-result" && frame.data.state !== "skipped") {
          const duration = testCase.diagnostic()?.duration;
          if (duration !== undefined) line = line.slice(0, -1) + durationSeparator + duration + "\n";
        }
        const lineBytes = Buffer.byteLength(line);
        if (lineBytes > SUITE_PROGRESS_LIMITS.frame_bytes || capturedBytes + lineBytes > SUITE_PROGRESS_LIMITS.stderr_bytes) {
          failed = true;
          return;
        }
        capturedBytes += lineBytes;
        this.output.write(line);
        if (testCase && frame?.event === "case-result" && frame.data.state === "failed") {
          captureFailure(directory, this.originMs, frame, testCase);
        }
      },
    });
  }

  onInit() {
    this.observer.onInit();
    writeFileSync(join(this.directory, "vitest-origin.json"), JSON.stringify({ epoch_ms: this.originMs }), { flag: "wx" });
  }

  onTestRunStart(...args: Parameters<ProgressReporter["onTestRunStart"]>) { this.observer.onTestRunStart(...args); }
  onTestModuleQueued(...args: Parameters<ProgressReporter["onTestModuleQueued"]>) { this.observer.onTestModuleQueued(...args); }
  onTestModuleCollected(...args: Parameters<ProgressReporter["onTestModuleCollected"]>) { this.observer.onTestModuleCollected(...args); }
  onTestModuleStart(...args: Parameters<ProgressReporter["onTestModuleStart"]>) { this.observer.onTestModuleStart(...args); }
  onTestCaseReady(...args: Parameters<ProgressReporter["onTestCaseReady"]>) { this.observer.onTestCaseReady(...args); }
  onTestCaseResult(testCase: TimingCase) {
    this.reportingCase = testCase;
    try {
      this.observer.onTestCaseResult(testCase);
    } finally {
      this.reportingCase = undefined;
    }
  }
  onTestModuleEnd(...args: Parameters<ProgressReporter["onTestModuleEnd"]>) { this.observer.onTestModuleEnd(...args); }

  async onTestRunEnd(...args: Parameters<ProgressReporter["onTestRunEnd"]>) {
    this.observer.onTestRunEnd(...args);
    this.output.end();
    const closed = await this.closed;
    writeFileSync(join(this.directory, "vitest-writer.json"), JSON.stringify({ closed }), { flag: "wx" });
  }
}

interface TimingBoundary {
  cutoff: boolean;
  writerClosed: boolean;
  reporterOriginMs: number | null;
  processClosedMs: number | null;
}

interface ModuleWindow {
  source: string;
  queued_ms?: number;
  collected_ms?: number;
  started_ms?: number;
  ended_ms?: number;
}
interface OpenCase {
  source: string;
  ordinal: number;
  ready_ms: number;
}
interface EndedCase extends OpenCase {
  duration_ms: number;
  observed_event_gap_ms: number;
  state: "passed" | "failed";
}

function unavailable(reason: string) {
  return { status: "unavailable" as const, reason };
}

export function summarizeCiVitestTiming(bytes: Buffer, boundary: TimingBoundary) {
  return summarizeTiming(bytes, boundary);
}

function summarizeTiming(bytes: Buffer, boundary: TimingBoundary, onFailure?: (frame: CaseResultFrame) => void) {
  if (bytes.length > SUITE_PROGRESS_LIMITS.stderr_bytes) return unavailable("capacity-exhausted");

  const completeLength = bytes.lastIndexOf(10) + 1;
  const clippedTail = completeLength !== bytes.length;
  if (clippedTail && !boundary.cutoff) return unavailable("incomplete-frame");

  const attribution = createSuiteAttributionCosts();
  const modules = new Map<number, ModuleWindow>();
  const open = new Map<string, OpenCase>();
  const ended: EndedCase[] = [];
  let missingDurations = 0;
  let durationMs: number | undefined;

  function observe(frame: SuiteProgressFrame) {
    if (!attribution.accept(frame)) throw new Error("Invalid attribution input");
    if (durationMs !== undefined && (frame.event !== "case-result" || frame.data.state === "skipped")) {
      throw new Error("Duration does not belong to an executed case result");
    }
    if (!frame.module || frame.reporter_elapsed_ms === null) return;

    const { ordinal, source } = frame.module;
    const now = frame.reporter_elapsed_ms;
    let window = modules.get(ordinal);
    if (!window) {
      window = { source };
      modules.set(ordinal, window);
    }
    switch (frame.event) {
      case "module-queued": window.queued_ms = now; break;
      case "module-collected": window.collected_ms = now; break;
      case "module-start": window.started_ms = now; break;
      case "module-end": window.ended_ms = now; break;
      case "case-ready":
        open.set(ordinal + ":" + frame.case!.ordinal, { source, ordinal: frame.case!.ordinal, ready_ms: now });
        break;
      case "case-result": {
        const key = ordinal + ":" + frame.case!.ordinal;
        const started = open.get(key);
        open.delete(key);
        const { state } = frame.data;
        if (state === "skipped") break;
        if (!started) throw new Error("Missing ready observation for executed case");
        if (state === "failed") onFailure?.(frame);
        if (durationMs === undefined) {
          missingDurations++;
          break;
        }
        ended.push({ ...started, duration_ms: durationMs, observed_event_gap_ms: now - started.ready_ms, state });
        break;
      }
    }
  }

  const collector = createSuiteProgressCollector(undefined, observe);
  for (let start = 0; start < completeLength;) {
    const end = bytes.indexOf(10, start);
    const line = bytes.subarray(start, end + 1);
    if (line.length > SUITE_PROGRESS_LIMITS.frame_bytes || !line.subarray(0, marker.length).equals(marker)) {
      return unavailable("invalid-transport");
    }
    const separator = line.indexOf(durationSeparator, marker.length);
    durationMs = undefined;
    if (separator === -1) {
      collector.push(line);
    } else {
      const encoded = line.toString("utf8", separator + 1, line.length - 1);
      durationMs = Number(encoded);
      if (!Number.isFinite(durationMs) || durationMs < 0 || String(durationMs) !== encoded) {
        return unavailable("invalid-duration");
      }
      collector.push(line.subarray(0, separator));
      collector.push(line.subarray(-1));
    }
    start = end + 1;
  }
  const snapshot = collector.finish();
  if (!snapshot || snapshot.availability !== "available") {
    return unavailable(snapshot?.unavailable_reason ?? "no-progress");
  }
  const costs = attribution.snapshot();
  if (!costs || costs.availability !== "available" || !costs.ended) {
    return unavailable(costs?.unavailable_reason ?? "no-attribution");
  }

  let afterRunToCloseMs: number | null = null;
  if (!boundary.cutoff) {
    if (!boundary.writerClosed || !snapshot.run_end || snapshot.reporter_elapsed_ms === null) {
      return unavailable("missing-terminal-evidence");
    }
    const origin = boundary.reporterOriginMs, close = boundary.processClosedMs;
    if (origin === null || close === null || !Number.isFinite(origin) || !Number.isFinite(close)) {
      return unavailable("missing-clock-boundary");
    }
    afterRunToCloseMs = close - origin - snapshot.reporter_elapsed_ms;
    if (afterRunToCloseMs < 0 || afterRunToCloseMs > PROFILE_LIMIT_MS) return unavailable("invalid-clock-boundary");
  }

  const ranked = ended.sort((a, b) => b.duration_ms - a.duration_ms || a.source.localeCompare(b.source) || a.ordinal - b.ordinal);
  const { tail: _tail, ...progress } = snapshot;
  const summary = {
    status: boundary.cutoff ? "partial" as const : "complete" as const,
    clipped_tail: clippedTail,
    progress,
    modules: [...modules.values()].sort((a, b) => a.source.localeCompare(b.source)),
    module_costs: costs,
    completed_module_overlap_ms: costs.ended.sum_ms - costs.ended.union_ms,
    case_durations: { measured: ranked.length, missing: missingDurations },
    top_cases: ranked.slice(0, 16),
    open_cases: [...open.values()].sort((a, b) => a.ready_ms - b.ready_ms)
      .map((test) => ({ ...test, observed_age_ms: (snapshot.reporter_elapsed_ms ?? test.ready_ms) - test.ready_ms })),
    after_run_to_close_ms: afterRunToCloseMs,
  };
  return Buffer.byteLength(JSON.stringify(summary)) <= SUITE_PROGRESS_LIMITS.snapshot_bytes
    ? summary
    : unavailable("snapshot-capacity-exhausted");
}
