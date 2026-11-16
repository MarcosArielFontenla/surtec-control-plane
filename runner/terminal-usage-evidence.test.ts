import { describe, expect, it } from "vitest";
import { createTerminalUsageEvidence, validateTerminalUsageEvidence, type TerminalUsageFacts } from "./terminal-usage-evidence";

function facts(): TerminalUsageFacts {
  const usage = { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 1, totalTokens: 15 };
  return { taskId: "T-fixture", executionId: "run-fixture", contextFingerprint: "a".repeat(64), threadId: "thread-1", turnId: "turn-1", usage,
    baseline: { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
    protocolUsage: { ...usage, cacheWriteInputTokens: 0 }, finalItemId: "item-1", finalPhase: "final_answer",
    finalItemSequence: 2, usageSequence: 3, terminalSequence: 4, terminalStatus: "completed", exitCode: 0, signal: null, stdoutEof: true, stderrEof: true };
}
describe("terminal operational usage receipt", () => {
  it("detaches and freezes a complete exact-bound receipt with key-order independent integrity", () => {
    const source = facts(), receipt = createTerminalUsageEvidence(source);
    source.protocolUsage.totalTokens = 999;
    const reordered = Object.fromEntries(Object.entries(receipt).reverse());
    const accepted = validateTerminalUsageEvidence(reordered, facts());
    expect(accepted).toEqual(receipt);
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(accepted!.protocolUsage)).toBe(true);
    expect(Object.isFrozen(accepted!.baseline)).toBe(true);
    expect(Object.isFrozen(accepted!.usage)).toBe(true);
  });
  it.each(["taskId", "executionId", "contextFingerprint", "threadId", "turnId"] as const)("rejects a replay against changed %s", (key) => {
    const binding = facts(); binding[key] = key === "contextFingerprint" ? "b".repeat(64) : "different";
    expect(validateTerminalUsageEvidence(createTerminalUsageEvidence(facts()), binding)).toBeNull();
  });
  const invalid = { finalPhase: null, finalItemSequence: 3, usageSequence: 4, terminalSequence: 2, terminalStatus: "interrupted", exitCode: 1,
    signal: "SIGTERM", stdoutEof: false, stderrEof: false, contextFingerprint: "invalid", taskId: "../escape", finalItemId: "" };
  it.each(Object.entries(invalid))("rejects invalid %s even at construction", (key, value) => {
    expect(() => createTerminalUsageEvidence({ ...facts(), [key]: value } as TerminalUsageFacts)).toThrow("Invalid terminal usage facts");
  });
  it.each([undefined, null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, "1"])("rejects unsafe protocol counters %s", (value) => {
    const source = facts(); (source.protocolUsage as unknown as Record<string, unknown>).cacheWriteInputTokens = value;
    expect(() => createTerminalUsageEvidence(source)).toThrow();
  });
  it("rejects nonzero history, inconsistent projection and changed binding usage", () => {
    const historical = facts(); historical.baseline.totalTokens = 1;
    expect(() => createTerminalUsageEvidence(historical)).toThrow();
    const mismatched = facts(); mismatched.usage.totalTokens++;
    expect(() => createTerminalUsageEvidence(mismatched)).toThrow();
    expect(validateTerminalUsageEvidence(createTerminalUsageEvidence(facts()), mismatched)).toBeNull();
    expect(validateTerminalUsageEvidence(createTerminalUsageEvidence(facts()), { ...facts(), usage: null })).toBeNull();
  });
  it.each(["version", "source", "basis", "digest", "finalItemId", "terminalSequence"])("rejects altered %s, missing and extra fields", (key) => {
    const receipt = createTerminalUsageEvidence(facts());
    expect(validateTerminalUsageEvidence({ ...receipt, [key]: "changed" }, facts())).toBeNull();
    const missing = { ...receipt } as Record<string, unknown>; delete missing[key];
    expect(validateTerminalUsageEvidence(missing, facts())).toBeNull();
    expect(validateTerminalUsageEvidence({ ...receipt, extra: true }, facts())).toBeNull();
  });
  it("rejects inherited/accessor and non-JSON payloads without invoking getters", () => {
    const receipt = createTerminalUsageEvidence(facts());
    expect(validateTerminalUsageEvidence(Object.create(receipt), facts())).toBeNull();
    const getter = { ...receipt }; Object.defineProperty(getter, "usage", { enumerable: true, get() { throw new Error("must not execute"); } });
    expect(validateTerminalUsageEvidence(getter, facts())).toBeNull();
    const nested = { ...receipt, protocolUsage: { ...receipt.protocolUsage } };
    Object.defineProperty(nested.protocolUsage, "totalTokens", { enumerable: true, get() { throw new Error("must not execute"); } });
    expect(validateTerminalUsageEvidence(nested, facts())).toBeNull();
    expect(validateTerminalUsageEvidence([], facts())).toBeNull();
    expect(validateTerminalUsageEvidence(null, facts())).toBeNull();
  });
});
