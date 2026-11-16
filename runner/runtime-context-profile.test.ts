import { describe, expect, it, vi } from "vitest";
import { assertRuntimeContextConfiguration, GOVERNED_RUNTIME_CONTEXT_BINDING, GOVERNED_RUNTIME_CONTEXT_PROFILE,
  LEGACY_RUNTIME_CONTEXT_PROFILE, runtimeContextProfile, runtimeContextSpawnArgs, runtimeContextThreadConfig,
  selectRuntimeContextContract } from "./runtime-context-profile";

const base = () => ({ version: "governed-execution-v1", manifest: "a".repeat(64), mode: "read-only", cwd: "synthetic",
  verifyCommands: [], outputSchema: { type: "object" } });
// Captured from the published legacy object serialization, not from the selector.
const legacy = "589a740c9d88827bf9679a59e3f0c49a08256880143c84bce66cddc7b7e074d2";

describe("context-economy code-owned profile", () => {
  it("selects a fresh deterministic contract without mutating source metadata", () => {
    const metadata = { source: "synthetic" }, snapshot = JSON.stringify(metadata);
    const first = selectRuntimeContextContract(base(), metadata);
    expect(first).toEqual(selectRuntimeContextContract(base(), {}));
    expect(first.runtimeContextProfile).toBe(GOVERNED_RUNTIME_CONTEXT_PROFILE);
    expect(first.fingerprint).not.toBe(legacy); expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.threadId).toBeUndefined(); expect(JSON.stringify(metadata)).toBe(snapshot);
    expect(Object.isFrozen(GOVERNED_RUNTIME_CONTEXT_BINDING)).toBe(true);
  });
  it("keeps the exact legacy fingerprint and thread without backfill", () => {
    const metadata = { run: { context_fingerprint: legacy, thread_id: "retained-thread" } }, before = JSON.stringify(metadata);
    expect(selectRuntimeContextContract(base(), metadata)).toEqual({ fingerprint: legacy, threadId: "retained-thread", runtimeContextProfile: LEGACY_RUNTIME_CONTEXT_PROFILE });
    expect(JSON.stringify(metadata)).toBe(before);
  });
  it("retains the new profile through preparation and thread binding", () => {
    const first = selectRuntimeContextContract(base(), {}), metadata = { run: { context_fingerprint: first.fingerprint } };
    expect(selectRuntimeContextContract(base(), metadata)).toEqual(first);
    Object.assign(metadata.run, { thread_id: "new-thread" });
    expect(selectRuntimeContextContract(base(), metadata)).toEqual({ ...first, threadId: "new-thread" });
  });
  it.each([legacy, null, undefined, 42, "unknown", "b".repeat(64)])("refuses malformed or drifted retained bindings (%s)", (value) => {
    const changed = { ...base(), cwd: "changed" };
    expect(() => selectRuntimeContextContract(changed, { run: { context_fingerprint: value } })).toThrow(/another or changed/);
  });
  it.each([null, undefined, "", 2])("refuses a present invalid saved thread (%s)", (value) => {
    expect(() => selectRuntimeContextContract(base(), { run: { context_fingerprint: legacy, thread_id: value } })).toThrow();
  });
  it("refuses a bare thread instead of inventing its profile", () => {
    expect(() => selectRuntimeContextContract(base(), { run: { thread_id: "bare" } })).toThrow();
  });
  it("rejects accessors, proxies and inherited metadata without invoking hooks", () => {
    const hook = vi.fn(() => legacy), ownKeys = vi.fn(() => [] as string[]);
    const getter = Object.defineProperty({}, "context_fingerprint", { enumerable: true, get: hook });
    for (const run of [getter, new Proxy({}, { get: hook, ownKeys }), Object.create({ context_fingerprint: legacy }), null, undefined]) {
      expect(() => selectRuntimeContextContract(base(), { run })).toThrow();
    }
    expect(hook).not.toHaveBeenCalled(); expect(ownKeys).not.toHaveBeenCalled();
  });
  it("admits only the two fixed identifiers and preserves legacy spawn bytes", () => {
    expect(runtimeContextProfile(undefined)).toBe(LEGACY_RUNTIME_CONTEXT_PROFILE);
    expect(runtimeContextSpawnArgs()).toEqual(["app-server", "--stdio"]);
    expect(runtimeContextSpawnArgs(GOVERNED_RUNTIME_CONTEXT_PROFILE)).toEqual(["-c", "skills.include_instructions=false", "app-server", "--stdio"]);
    for (const value of [null, "future-profile", {}, { skills: { include_instructions: false } }]) expect(() => runtimeContextProfile(value)).toThrow();
    const args = runtimeContextSpawnArgs(); args.push("--unsafe"); expect(runtimeContextSpawnArgs()).toEqual(["app-server", "--stdio"]);
  });
  it("exposes only a fresh fixed thread override without mutable shared settings", () => {
    expect(runtimeContextThreadConfig()).toEqual({});
    const first = runtimeContextThreadConfig(GOVERNED_RUNTIME_CONTEXT_PROFILE);
    expect(first).toEqual({ skills: { include_instructions: false } });
    first.skills!.include_instructions = true;
    expect(runtimeContextThreadConfig(GOVERNED_RUNTIME_CONTEXT_PROFILE)).toEqual({ skills: { include_instructions: false } });
  });
  it("reads only the own explicit false setting and never private config fields", () => {
    const hook = vi.fn(() => { throw new Error("PRIVATE-CONFIG-SECRET"); });
    const response = { config: { skills: { include_instructions: false }, get private_config() { return hook(); } } };
    expect(() => assertRuntimeContextConfiguration(response)).not.toThrow(); expect(hook).not.toHaveBeenCalled();
  });
  it.each([{}, { config: {} }, { config: { skills: {} } }, { config: { skills: { include_instructions: true } } },
    { config: { skills: { include_instructions: "false" } } }, { config: { skills: { include_instructions: null } } }])("refuses unqualified native config without leaking it", (response) => {
    expect(() => assertRuntimeContextConfiguration({ ...response, private_config: "PRIVATE-CONFIG-SECRET" })).toThrow(/another or changed/);
    try { assertRuntimeContextConfiguration(response); } catch (error) { expect(String(error)).not.toContain("PRIVATE-CONFIG-SECRET"); }
  });
  it("refuses config getters and proxies without evaluating native-shaped hooks", () => {
    const hook = vi.fn(() => false), getter = Object.defineProperty({}, "include_instructions", { enumerable: true, get: hook });
    expect(() => assertRuntimeContextConfiguration({ config: { skills: getter } })).toThrow();
    expect(() => assertRuntimeContextConfiguration(new Proxy({}, { get: hook }))).toThrow();
    expect(hook).not.toHaveBeenCalled();
  });
});
