import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureVerification, runVerification, validateTestingProbes, type CaptureOptions } from "./verify";
import { evidenceHash } from "../lib/context/testing-evidence";
import { managedGitArgs } from "../lib/security/managed-git.mjs";
import { localGitEnvironment } from "../lib/security/environment";
import type { ContextRunner } from "../lib/context/types";

const PASS = `node -e "process.exit(0)"`;
const FAIL = `node -e "process.exit(1)"`;
const BIG = `node -e "for(let i=0;i<5000;i++)process.stdout.write('x')"`;
const SECRET = `node -e "process.stdout.write('authorization=top-secret-value')"`;

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

  it("redacts secrets from verification output", () => {
    const r = runVerification(process.cwd(), [SECRET]);
    expect(r.status).toBe("passed");
    expect(r.checks[0].output_tail).toContain("[REDACTED]");
    expect(r.checks[0].output_tail).not.toContain("top-secret-value");
  });
});

describe("interruptible infrastructure verification", () => {
  let fixture: string, repo: string, options: CaptureOptions;
  const git = (args: string[]) => execFileSync("git", managedGitArgs(["-C", repo, ...args], fixture), { encoding: "utf8", env: localGitEnvironment(), windowsHide: true });
  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "surtec-verification-")); repo = join(fixture, "repo"); mkdirSync(repo);
    git(["init", "--quiet"]); git(["config", "user.name", "Synthetic"]); git(["config", "user.email", "fixture@example.test"]);
    writeFileSync(join(repo, "fixture.txt"), "base\n"); git(["add", "."]); git(["commit", "--quiet", "-m", "base"]);
    options = { signal: new AbortController().signal, deadline: Date.now() + 30_000, ownsAttempt: () => true, controlPlaneRoot: fixture };
  });
  afterEach(() => rmSync(fixture, { recursive: true, force: true }));
  function probe(status: "passed" | "assertion-failed", exit: number): ContextRunner {
    const source = `console.log(JSON.stringify({schema_version:1,assertions:[{id:'behavior',status:'${status}'}]}));process.exit(${exit});`;
    writeFileSync(join(repo, "probe.mjs"), source); git(["add", "."]); git(["commit", "--quiet", "-m", "trusted probe"]);
    return { command: "node probe.mjs", stage: status === "assertion-failed" ? "red" : "green", probe: { sources: [{ path: "probe.mjs", sha256: evidenceHash(source) }], assertion_ids: ["behavior"] } };
  }
  it("captures actual functional exits, bounded redacted tails and unchanged exact candidate", async () => {
    const revision = git(["rev-parse", "HEAD"]).trim();
    const captured = await captureVerification(repo, [{ stage: "functional", command: SECRET }], { ...options, expectedRevision: revision });
    expect(captured.report.status).toBe("passed"); expect(captured.report.checks[0]!.output_tail).toContain("[REDACTED]");
    expect(captured.observations[0]).toMatchObject({ exit_code: 0, outcome: "passed", revision });
    expect(captured.observations[0]!.before_fingerprint).toBe(captured.observations[0]!.after_fingerprint);
    expect(JSON.stringify(captured.observations)).not.toContain("top-secret-value");
  });
  it("checks command authority before and after execution without treating revocation as a pass", async () => {
    const command = `node -e \"process.stdout.write('observed')\"`;
    await expect(captureVerification(repo, [{ stage: "functional", command }], { ...options, authorizeCommand: () => false })).rejects.toThrow(/no longer authorized/);
    let count = 0;
    const captured = await captureVerification(repo, [{ stage: "functional", command }], { ...options, authorizeCommand: () => ++count === 1 });
    expect(captured.report.status).toBe("failed"); expect(captured.observations[0]!.outcome).toBe("process-error"); expect(captured.observations[0]!.exit_code).toBe(0);
  });
  it("requires a configured behavioral assertion failure rather than arbitrary nonzero status", async () => {
    const runner = probe("assertion-failed", 1);
    const red = await captureVerification(repo, [runner], options);
    expect(red.report.status).toBe("passed"); expect(red.observations[0]!.outcome).toBe("assertion-failed");
    for (const command of [FAIL, "missing-assertion-runner-zzz", `node -e \"throw new SyntaxError('broken')\"`]) {
      const failed = await captureVerification(repo, [{ ...runner, command }], options);
      expect(failed.report.status).toBe("failed"); expect(failed.observations[0]!.outcome).toBe("process-error");
    }
  });
  it("cannot accept a probe with wrong exit code, wrong identity or a claimed failure during GREEN", async () => {
    const runner = probe("assertion-failed", 2);
    expect((await captureVerification(repo, [runner], options)).report.status).toBe("failed");
    runner.probe!.assertion_ids = ["different"];
    expect((await captureVerification(repo, [runner], options)).observations[0]!.outcome).toBe("process-error");
    runner.probe!.assertion_ids = ["behavior"]; runner.stage = "green";
    expect((await captureVerification(repo, [runner], options)).report.status).toBe("failed");
  });
  it.each(["tracked", "untracked", "head"])("refuses verifier mutation of %s candidate state", async (change) => {
    const command = change === "head" ? "git -c core.hooksPath=empty-hooks commit --allow-empty -m verifier-change" : `node -e \"require('fs').writeFileSync('${change === "tracked" ? "fixture.txt" : "new.txt"}','changed')\"`;
    const captured = await captureVerification(repo, [{ stage: "functional", command }], options);
    expect(captured.report.status).toBe("failed"); expect(captured.observations[0]!.outcome).toBe("candidate-changed");
  });
  it("pins already-present sources and rejects source changes, missing files and redirected reads", async () => {
    const runner = probe("passed", 0); validateTestingProbes(repo, { runners: [runner] });
    writeFileSync(join(repo, "probe.mjs"), "changed");
    expect(() => validateTestingProbes(repo, { runners: [runner] })).toThrow(/changed/);
    runner.probe!.sources[0]!.path = "missing.mjs"; expect(() => validateTestingProbes(repo, { runners: [runner] })).toThrow(/missing/);
    runner.probe!.sources[0]!.path = "../outside.mjs"; expect(() => validateTestingProbes(repo, { runners: [runner] })).toThrow(/Unsafe/);
  });
  it("rejects verifier modification of a pinned probe even when ignored files leave Git clean", async () => {
    writeFileSync(join(repo, ".gitignore"), "probe.mjs\n"); git(["add", "."]); git(["commit", "--quiet", "-m", "ignore synthetic probe"]);
    const source = "import {writeFileSync} from 'node:fs'; writeFileSync('probe.mjs','changed'); console.log(JSON.stringify({schema_version:1,assertions:[{id:'behavior',status:'passed'}]}));";
    writeFileSync(join(repo, "probe.mjs"), source);
    const captured = await captureVerification(repo, [{ command: "node probe.mjs", stage: "green", probe: { sources: [{ path: "probe.mjs", sha256: evidenceHash(source) }], assertion_ids: ["behavior"] } }], options);
    expect(git(["status", "--porcelain"])).toBe(""); expect(captured.observations[0]!.outcome).toBe("candidate-changed"); expect(captured.report.status).toBe("failed");
  });
  it("bounds checks by remaining runtime and kills the process tree", async () => {
    const captured = await captureVerification(repo, [{ stage: "functional", command: `node -e \"setInterval(()=>{},1000)\"` }], { ...options, deadline: Date.now() + 800 });
    expect(captured.report.status).toBe("failed"); expect(captured.observations[0]!.outcome).toBe("timed-out");
  });
  // Each real process-tree shutdown needs its own bounded Windows startup/cleanup allowance.
  it.each([
    { reason: "cancellation", cancel: true },
    { reason: "attempt ownership loss", cancel: false },
  ])("interrupts command execution after $reason", async ({ cancel }) => {
    const controller = new AbortController(); let owns = true;
    const timer = setTimeout(() => { if (cancel) controller.abort(); else owns = false; }, 700);
    try {
      const captured = await captureVerification(repo, [{ stage: "functional", command: `node -e \"setInterval(()=>{},1000)\"` }], { ...options, signal: controller.signal, ownsAttempt: () => owns });
      expect(captured.observations[0]!.outcome).toBe("cancelled"); expect(captured.report.status).toBe("failed");
    } finally { clearTimeout(timer); }
  }, 10_000);
});
