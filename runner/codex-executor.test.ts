import { describe, expect, it, vi } from "vitest";
import { codexAppServerEnvironment } from "../lib/security/environment";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexExecutor } from "./codex-executor";
import type { AgentEvent } from "./agent-executor";
import { validateTerminalUsageEvidence } from "./terminal-usage-evidence";
import { GOVERNED_RUNTIME_CONTEXT_PROFILE, LEGACY_RUNTIME_CONTEXT_PROFILE, type RuntimeContextProfileId } from "./runtime-context-profile";

describe("codexAppServerEnvironment", () => {
  it("keeps runtime essentials and excludes unrelated inherited secrets", () => {
    const filtered = codexAppServerEnvironment({
      PATH: "bin",
      USERPROFILE: "C:\\Users\\test",
      OPENAI_API_KEY: "required-by-runtime",
      GH_TOKEN: "github-auth-fixture",
      RAILWAY_TOKEN: "railway-fixture",
      UNRELATED_SERVICE_SECRET: "must-not-cross-boundary",
    });

    expect(filtered).toEqual({
      PATH: "bin",
      USERPROFILE: "C:\\Users\\test",
      OPENAI_API_KEY: "required-by-runtime",
    });
  });
});

describe("CodexExecutor with native Node-only terminal producer", () => {
  it("refuses an unknown profile without spawning", () => {
    const factory = vi.fn();
    expect(() => new CodexExecutor(factory).run({ cwd: "synthetic", developerInstructions: "Synthetic", prompt: "Synthetic", mode: "read-only", outputSchema: {},
      runtimeContextProfile: "unknown" as RuntimeContextProfileId }, () => {}, new AbortController().signal)).toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
  it.each([undefined, LEGACY_RUNTIME_CONTEXT_PROFILE, GOVERNED_RUNTIME_CONTEXT_PROFILE])("passes only a validated profile to its factory: %s", (profile) => {
    const factory = vi.fn(() => { throw new Error("synthetic factory boundary"); });
    expect(() => new CodexExecutor(factory).run({ cwd: "synthetic", developerInstructions: "Synthetic", prompt: "Synthetic", mode: "read-only", outputSchema: {}, runtimeContextProfile: profile },
      () => {}, new AbortController().signal)).toThrow("synthetic factory boundary");
    expect(factory).toHaveBeenCalledExactlyOnceWith(profile ?? LEGACY_RUNTIME_CONTEXT_PROFILE);
  });
  it.each([
    ["success", LEGACY_RUNTIME_CONTEXT_PROFILE],
    ["success", GOVERNED_RUNTIME_CONTEXT_PROFILE],
    ["late-usage", GOVERNED_RUNTIME_CONTEXT_PROFILE],
    ["missing-phase", LEGACY_RUNTIME_CONTEXT_PROFILE],
    ["usage-before-final", LEGACY_RUNTIME_CONTEXT_PROFILE],
  ] as const)("observes native proof boundary for %s under %s", async (scenario, runtimeContextProfile) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../fixtures/codex-app-server-terminal.mjs", import.meta.url)), scenario],
      { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, env: {} });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const events: AgentEvent[] = [], abort = new AbortController();
    try {
      const result = await new CodexExecutor(() => child).run({ cwd: process.cwd(), developerInstructions: "Synthetic", prompt: "Synthetic", mode: "read-only",
        outputSchema: { type: "object" }, contextFingerprint: "a".repeat(64), executionIdentity: { taskId: "T-fixture", executionId: "run-fixture" },
        runtimeContextProfile }, (event) => { events.push(event); }, abort.signal);
      expect(Object.hasOwn(result, "usageComplete")).toBe(true);
      expect(result.usageComplete).toBe(scenario === "success");
      if (scenario === "success") {
        expect(validateTerminalUsageEvidence(result.terminalUsageEvidence, { taskId: "T-fixture", executionId: "run-fixture", contextFingerprint: "a".repeat(64), ...result })).toEqual(result.terminalUsageEvidence);
        expect(result.terminalUsageEvidence).toMatchObject({ exitCode: 0, stdoutEof: true, stderrEof: true });
        expect(events.some((event) => event.type === "usage-unknown")).toBe(false);
      } else {
        expect(result.terminalUsageEvidence).toBeUndefined();
        expect(events.some((event) => event.type === "usage-unknown")).toBe(true);
      }
      if (scenario === "late-usage") expect(result.usageHighWater?.totalTokens).toBe(25);
    } finally { abort.abort(); if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; }
  });
  it.each(["nonzero", "malformed-tail"])("rejects %s after terminal, then closes its native child", async (scenario) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../fixtures/codex-app-server-terminal.mjs", import.meta.url)), scenario],
      { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, env: {} });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const abort = new AbortController();
    try {
      await expect(new CodexExecutor(() => child).run({ cwd: process.cwd(), developerInstructions: "Synthetic", prompt: "Synthetic", mode: "read-only", outputSchema: {},
        contextFingerprint: "a".repeat(64), executionIdentity: { taskId: "T-fixture", executionId: "run-fixture" } }, () => {}, abort.signal)).rejects.toThrow();
    } finally { abort.abort(); if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; }
  });
});
