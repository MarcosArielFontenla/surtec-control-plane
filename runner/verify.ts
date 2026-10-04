import { spawn, spawnSync } from "node:child_process";
import type { VerificationReport, VerificationCheck } from "../lib/state/types";
import { projectCommandEnvironment, localGitEnvironment, systemProcessEnvironment } from "../lib/security/environment";
import { redactText } from "../lib/security/redaction";
import { managedGitArgs } from "../lib/security/managed-git.mjs";
import { readContained } from "../lib/harness/source";
import type { ContextRunner, TestingPlan } from "../lib/context/types";
import { ContextContractError, safeContextPath } from "../lib/context/validation";
import { evidenceHash, testingRequirement, type TestingObservation } from "../lib/context/testing-evidence";

const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const TAIL_CHARS = 4000;

// Runs the given commands IN ORDER in the worktree, fail-fast. Commands come from the
// trusted registry (never agent input), so shell:true is acceptable and resolves
// pnpm/pnpm.cmd cross-platform. Never throws — a spawn failure is recorded as a failed check.
export function runVerification(worktreePath: string, commands: string[]): VerificationReport {
  if (commands.length === 0) return { status: "skipped", checks: [] };
  const checks: VerificationCheck[] = [];
  for (const command of commands) {
    const r = spawnSync(command, {
      cwd: worktreePath,
      shell: true,
      encoding: "utf8",
      timeout: VERIFY_TIMEOUT_MS,
      env: projectCommandEnvironment(),
    });
    const ok = r.status === 0 && !r.error;
    const combined = redactText((r.stdout ?? "") + (r.stderr ?? "") + (r.error ? r.error.message : ""));
    checks.push({ command: redactText(command), ok, output_tail: combined.slice(-TAIL_CHARS) });
    if (!ok) return { status: "failed", checks };
  }
  return { status: "passed", checks };
}

export interface CaptureOptions {
  signal: AbortSignal;
  deadline: number;
  ownsAttempt: () => boolean;
  controlPlaneRoot: string;
  expectedRevision?: string;
  authorizeCommand?: (command: string) => boolean;
}
export function validateTestingProbes(root: string, plan: Pick<TestingPlan, "runners">): void {
  for (const runner of plan.runners) for (const entry of runner.probe?.sources ?? []) {
    if (!safeContextPath(entry.path)) throw new ContextContractError("Unsafe assertion probe path");
    let bytes: Buffer | null;
    try { bytes = readContained(root, entry.path); } catch { throw new ContextContractError("Pinned assertion probe is unavailable or redirected"); }
    if (!bytes || evidenceHash(bytes) !== entry.sha256) throw new ContextContractError("Pinned assertion probe source changed or is missing");
  }
}
function snapshot(root: string, options: CaptureOptions): { revision: string; fingerprint: string; clean: boolean } {
  const read = (args: string[]) => {
    if (options.signal.aborted || !options.ownsAttempt() || Date.now() >= options.deadline) throw new ContextContractError("Verification no longer owns the bounded attempt");
    const result = spawnSync("git", managedGitArgs(["-C", root, ...args], options.controlPlaneRoot), { encoding: "utf8", env: localGitEnvironment(), timeout: Math.max(1, Math.min(5000, options.deadline - Date.now())), maxBuffer: 256 * 1024, windowsHide: true });
    if (result.error || result.status !== 0) throw new ContextContractError("Verification cannot observe repository identity");
    return result.stdout;
  };
  const revision = read(["rev-parse", "HEAD"]).trim();
  if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new ContextContractError("Invalid observed candidate revision");
  const tree = read(["rev-parse", "HEAD^{tree}"]).trim();
  const status = read(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]);
  return { revision, fingerprint: evidenceHash(`${revision}\0${tree}\0${status}`), clean: status.length === 0 };
}
// Only this infrastructure adapter reads the probe stdout. Agent reports never enter it.
// Probe JSON v1: {schema_version:1, assertions:[{id, status:"passed"|"assertion-failed"}]}.
function assertionsFromOutput(stdout: string, runner: ContextRunner): TestingObservation["assertions"] {
  if (!runner.probe) return [];
  try {
    const value = JSON.parse(stdout) as { schema_version: unknown; assertions: unknown };
    if (!value || Object.keys(value).sort().join(",") !== "assertions,schema_version" || value.schema_version !== 1 || !Array.isArray(value.assertions) || value.assertions.length > 64) return [];
    const assertions = value.assertions as TestingObservation["assertions"];
    if (assertions.some((entry) => !entry || Object.keys(entry).sort().join(",") !== "id,status" || typeof entry.id !== "string" || !["passed", "assertion-failed"].includes(entry.status))) return [];
    if (JSON.stringify(assertions.map((entry) => entry.id).sort()) !== JSON.stringify([...runner.probe.assertion_ids].sort())) return [];
    return [...assertions].sort((a, b) => a.id.localeCompare(b.id));
  } catch { return []; }
}
async function execute(command: string, cwd: string, options: CaptureOptions, observable: boolean): Promise<{ stdout: string; tail: string; exit: number | null; error: boolean; interrupted: "timed-out" | "cancelled" | null }> {
  return new Promise((resolve) => {
    let stdout = "", tail = "", error = false, omitted = false, settled = false, interrupted: "timed-out" | "cancelled" | null = null;
    let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== "win32", env: projectCommandEnvironment() });
    const appendOutput = (data: Buffer) => {
      if (settled || omitted) return;
      if (Buffer.byteLength(tail) + data.length > 64 * 1024) { omitted = true; tail = "Verification output omitted after the bounded capture limit."; }
      else tail += data.toString();
    };
    const finish = (exit: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearInterval(fence); clearTimeout(cleanupDeadline); options.signal.removeEventListener("abort", abort);
      resolve({ stdout, tail: redactText(tail).slice(-TAIL_CHARS), exit, error, interrupted });
    };
    const stop = (reason: "timed-out" | "cancelled") => {
      if (interrupted) return;
      interrupted = reason;
      if (child.pid) {
        if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { env: systemProcessEnvironment(), timeout: 5000, windowsHide: true });
        else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
      }
      cleanupDeadline = setTimeout(() => {
        error = true; tail = "Verifier process-tree termination could not be confirmed; inspect the preserved worktree before retrying.";
        finish(null);
      }, 5000);
    };
    const abort = () => stop("cancelled");
    const timer = setTimeout(() => stop("timed-out"), Math.max(1, Math.min(VERIFY_TIMEOUT_MS, options.deadline - Date.now())));
    const fence = setInterval(() => { try { if (!options.ownsAttempt()) stop("cancelled"); } catch { stop("cancelled"); } }, 100);
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    child.stdout.on("data", (data: Buffer) => {
      if (settled) return;
      appendOutput(data);
      if (observable) {
        if (Buffer.byteLength(stdout) + data.length > 64 * 1024) { error = true; stop("cancelled"); } else stdout += data.toString();
      }
    });
    child.stderr.on("data", (data: Buffer) => { appendOutput(data); if (observable && data.toString().trim()) error = true; });
    child.on("error", () => { error = true; });
    child.on("close", finish);
  });
}
export async function captureVerification(root: string, runners: ContextRunner[], options: CaptureOptions): Promise<{ report: VerificationReport; observations: TestingObservation[] }> {
  const observations: TestingObservation[] = [], checks: VerificationCheck[] = [];
  for (const runner of runners) {
    if (options.authorizeCommand && !options.authorizeCommand(runner.command)) throw new ContextContractError("Verification command or testing policy is no longer authorized");
    const before = snapshot(root, options);
    validateTestingProbes(root, { runners: [runner] });
    const started_at = new Date().toISOString();
    const processResult = !before.clean || (options.expectedRevision && before.revision !== options.expectedRevision)
      ? { stdout: "", tail: "Candidate is not the expected clean revision.", exit: null, error: true, interrupted: null }
      : await execute(runner.command, root, options, !!runner.probe);
    let after = before, unchanged = false;
    try {
      after = snapshot(root, options); validateTestingProbes(root, { runners: [runner] });
      unchanged = before.clean && after.clean && before.fingerprint === after.fingerprint;
    } catch { /* Interrupted, stale, or unobservable state cannot pass. */ }
    const assertions = assertionsFromOutput(processResult.stdout, runner);
    let authorized = true;
    try { authorized = options.authorizeCommand?.(runner.command) ?? true; } catch { authorized = false; }
    let outcome: TestingObservation["outcome"] = processResult.error ? "process-error" : processResult.interrupted ?? "passed";
    if (!processResult.interrupted && !processResult.error) {
      if (!authorized) outcome = "process-error";
      else if (!unchanged) outcome = "candidate-changed";
      else if (runner.probe && assertions.length !== runner.probe.assertion_ids.length) outcome = "process-error";
      else if (processResult.exit === 1 && assertions.some((entry) => entry.status === "assertion-failed")) outcome = "assertion-failed";
      else if (processResult.exit !== 0 || assertions.some((entry) => entry.status !== "passed")) outcome = "process-error";
    }
    const { assertion_ids: _ids, ...identity } = testingRequirement(runner);
    observations.push({ ...identity, assertions, outcome, exit_code: processResult.exit, started_at, finished_at: new Date().toISOString(), revision: before.revision, before_fingerprint: before.fingerprint, after_fingerprint: unchanged ? after.fingerprint : evidenceHash(`unverified:${after.fingerprint}`) });
    const ok = runner.stage === "red" ? outcome === "assertion-failed" : outcome === "passed";
    checks.push({ command: redactText(runner.command), ok, output_tail: processResult.tail });
    if (!ok) return { observations, report: { status: "failed", checks } };
  }
  return { observations, report: { status: runners.length ? "passed" : "skipped", checks } };
}
