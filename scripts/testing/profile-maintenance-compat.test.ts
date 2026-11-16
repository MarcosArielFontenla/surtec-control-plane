import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptHistoricalProfilerTest, historicalProfilerAdapter } from "./profile-maintenance-compat";

const testFile = fileURLToPath(new URL("../profile-maintenance.test.ts", import.meta.url));
const archiveFile = new URL("../../fixtures/profile-maintenance/workflow-orchestrator-p14.bin", import.meta.url);

describe("historical profiler adapter", () => {
  it("adapts exactly three byte comparisons and two archived fixture reads", () => {
    const bytes = readFileSync(testFile);
    const source = bytes.toString("utf8");
    const adapted = historicalProfilerAdapter(testFile).load(testFile)!;
    const comparison = "expect(readFileSync(copiedProfiler).equals(readFileSync(profilerSource))).toBe(true);";
    const archiveRead = 'readFileSync(new URL("../fixtures/profile-maintenance/workflow-orchestrator-p14.bin", import.meta.url))';
    expect(adapted.split(comparison)).toHaveLength(4);
    expect(adapted.split(archiveRead)).toHaveLength(3);
    expect(adapted
      .replaceAll(comparison, "expect(readFileSync(copiedProfiler)).toEqual(readFileSync(profilerSource));")
      .replaceAll(archiveRead, "readFileSync(failureFixturePath)")).toBe(source);
    expect(readFileSync(testFile).equals(bytes)).toBe(true);
  });

  it("ignores other modules, including a different file with the same name", () => {
    const adapter = historicalProfilerAdapter(testFile);
    const otherFile = fileURLToPath(new URL("./profile-maintenance.test.ts", import.meta.url));
    expect(adapter.load(otherFile)).toBeUndefined();
    expect(adapter.load(testFile + "?raw")).toBeUndefined();
  });

  it("refuses a one-byte edit to the historical test source", () => {
    const changed = readFileSync(testFile);
    changed[0] = changed[0]! ^ 1;
    expect(() => adaptHistoricalProfilerTest(changed)).toThrow(/unexpected SHA-256/);
  });

  it("retains the exact archived fixture that the existing hash checks require", () => {
    const digest = createHash("sha256").update(readFileSync(archiveFile)).digest("hex");
    expect(digest).toBe("93249820fd2c7edff923c1ccd8f70760abdce35ac55dca9e13ba7f606b406c87");
  });
});
