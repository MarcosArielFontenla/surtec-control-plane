import { describe, expect, it } from "vitest";
import manifest from "../../registry/harness-manifests/surtec-h1-h4.json";
import { assertManifest, assertSourceRegistry } from "./validation";
const source = () => ({ schema_version: 1, source: { id: "fixture", root: ".", manifest: "registry/manifest.json", manifest_sha256: "a".repeat(64) }, runners: {}, projects: {} });
describe("Harness contracts", () => {
  it("accepts the reviewed manifest without fabricating inactive capabilities", () => { expect(() => assertManifest(manifest)).not.toThrow(); expect(manifest.capabilities.telemetry).toBe(false); });
  it.each([0, 2, "1"])("rejects unsupported manifest version %s", (version) => { expect(() => assertManifest({ ...manifest, schema_version: version })).toThrow(); });
  it("rejects duplicate and escaped entries", () => {
    expect(() => assertManifest({ ...manifest, expected_entries: [manifest.expected_entries[0], manifest.expected_entries[0]] })).toThrow();
    expect(() => assertManifest({ ...manifest, expected_entries: [{ ...manifest.expected_entries[0], path: "../outside" }] })).toThrow();
  });
  it("requires a trusted registered runner and red evidence for strict TDD", () => {
    const project = { ownership: [], testing_policy: { schema_version: 1, mode: "strict-tdd", runner_id: "test", requires_red_evidence: true, applicable_task_kinds: ["implementation"] }, review_policy: "human-required", backup_ready: false, rollback_ready: false, validation: null };
    expect(() => assertSourceRegistry({ ...source(), projects: { fixture: project } })).toThrow();
    expect(() => assertSourceRegistry({ ...source(), runners: { test: { command: "node --version" } }, projects: { fixture: project } })).not.toThrow();
    expect(() => assertSourceRegistry({ ...source(), runners: { test: { command: "node --version" } }, projects: { fixture: { ...project, testing_policy: { ...project.testing_policy, requires_red_evidence: false } } } })).toThrow();
  });
});
