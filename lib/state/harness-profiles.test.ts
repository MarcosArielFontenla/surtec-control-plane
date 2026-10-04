import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectHarness } from "../harness/inspect";
import { readHarnessProfiles, saveHarnessProfile } from "./harness-profiles";
vi.mock("node:fs", async (original) => { const actual = await original<typeof import("node:fs")>(); return { ...actual, renameSync: vi.fn(actual.renameSync) }; });
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); vi.clearAllMocks(); });
function fixture() { const root = mkdtempSync(join(tmpdir(), "surtec-harness-state-")); roots.push(root); return { root, path: join(root, "state/harness/profiles.json"), profile: inspectHarness(root, "alpha", { status: "unknown", manifest: null, registry: null, fingerprint: null, reason: "fixture" }) }; }
describe("Harness observation store", () => {
  it("treats absent state as optional and preserves saved profiles on restart", () => { const { path, profile } = fixture(); expect(readHarnessProfiles(path).profiles).toEqual({}); saveHarnessProfile(profile, path); saveHarnessProfile({ ...profile, project_id: "beta" }, path); expect(Object.keys(readHarnessProfiles(path).profiles).sort()).toEqual(["alpha", "beta"]); });
  it.each(["{", '{"schema_version":2,"profiles":{}}', '{"schema_version":1,"profiles":{"wrong":{}}}'])("preserves invalid or future state %s", (raw) => { const { path, profile } = fixture(); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, raw); expect(() => saveHarnessProfile(profile, path)).toThrow(); expect(readFileSync(path, "utf8")).toBe(raw); });
  it("rejects identity mismatches and concurrent locks", () => { const { root, path, profile } = fixture(); mkdirSync(join(root, "state/locks"), { recursive: true }); writeFileSync(join(root, "state/locks/harness-profiles.lock"), "busy"); expect(() => saveHarnessProfile(profile, path)).toThrow(); expect(() => saveHarnessProfile({ ...profile, schema_version: 2 } as never, path)).toThrow(); });
  it("cleans up only its staged file and preserves previous bytes on failed replacement", () => { const { path, profile } = fixture(); saveHarnessProfile(profile, path); const before = readFileSync(path); vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("synthetic replacement failure"); }); expect(() => saveHarnessProfile({ ...profile, project_id: "beta" }, path)).toThrow(); expect(readFileSync(path)).toEqual(before); expect(readdirSync(dirname(path))).toEqual(["profiles.json"]); });
});
