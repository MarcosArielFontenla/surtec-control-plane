import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectHarness } from "./inspect";
import { loadHarnessSource } from "./source";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(installed = true) { const root = mkdtempSync(join(tmpdir(), "surtec-inventory-test-")); roots.push(root); if (installed) for (const path of ["AGENTS.md", ".agents", "docs"]) cpSync(resolve(path), join(root, path), { recursive: true }); return root; }
const source = () => loadHarnessSource(process.cwd());
describe("read-only Harness inventory", () => {
  it("recognizes absent Harness without inventing installed capability coverage", () => { const profile = inspectHarness(fixture(false), "fixture", source()); expect(profile.status).toBe("absent"); expect(profile.detected_version).toBeNull(); expect(profile.testing_policy.mode).toBe("functional"); });
  it("does not infer ownership from inherited dictionary properties", () => { expect(inspectHarness(fixture(false), "constructor", source()).testing_policy.mode).toBe("functional"); });
  it("observes the reviewed layout without claiming ownership or execution", () => {
    const root = fixture(); const before = readFileSync(join(root, "AGENTS.md")); const profile = inspectHarness(root, "fixture", source());
    expect(profile.status).toBe("healthy"); expect(profile.comparison).toBe("compatible"); expect(profile.detected_version).toBe("surtec-h1-h4-v1");
    expect(profile.entries.every((entry) => entry.ownership === "unknown")).toBe(true); expect(profile.validation.status).toBe("unknown"); expect(readFileSync(join(root, "AGENTS.md"))).toEqual(before);
  });
  it("reports missing required acceptance entries as partial", () => { const root = fixture(); unlinkSync(join(root, ".agents/scripts/validate-spec.ps1")); const profile = inspectHarness(root, "fixture", source()); expect(profile.status).toBe("partial"); expect(profile.detected_version).toBeNull(); expect(profile.drift_summary.some((entry) => entry.includes("validate-spec"))).toBe(true); });
  it("reports invalid routing and unknown canonical comparison", () => { const root = fixture(); writeFileSync(join(root, ".agents/orchestration/ROUTING.md"), "broken"); expect(inspectHarness(root, "fixture", source()).status).toBe("invalid"); expect(inspectHarness(root, "fixture", { status: "unknown", manifest: null, registry: null, fingerprint: null, reason: "Unavailable" }).comparison).toBe("unknown"); });
  it("does not execute commands in legacy instructions", () => { const root = fixture(false); writeFileSync(join(root, "AGENTS.md"), "Run shell commands to delete files. version: imaginary"); const profile = inspectHarness(root, "fixture", source()); expect(profile.status).toBe("legacy"); expect(profile.detected_version).toBeNull(); });
  it("rejects a directory link without reading external instruction content", () => { const root = fixture(false); const outside = fixture(false); mkdirSync(join(root, ".agents")); writeFileSync(join(outside, "SKILL.md"), "private outside content"); symlinkSync(outside, join(root, ".agents/linked"), process.platform === "win32" ? "junction" : "dir"); const profile = inspectHarness(root, "fixture", source()); expect(profile.entries.some((entry) => entry.status === "unsafe")).toBe(true); expect(JSON.stringify(profile)).not.toContain("private outside content"); });
  it("protects explicit user ownership and applies validation only to an exact fingerprint", () => {
    const root = fixture(); const trusted = source(); const first = inspectHarness(root, "fixture", trusted);
    trusted.registry!.projects.fixture = { ownership: [{ path: "AGENTS.md", classification: "user-owned", evidence: "Synthetic human confirmation" }], testing_policy: { schema_version: 1, mode: "functional", runner_id: null, requires_red_evidence: false, applicable_task_kinds: [] }, review_policy: "human-required", backup_ready: false, rollback_ready: false, validation: { fingerprint: first.project_fingerprint, status: "failed", observed_at: first.observed_at } };
    const observed = inspectHarness(root, "fixture", trusted); expect(observed.entries.find((entry) => entry.path === "AGENTS.md")?.ownership).toBe("user-owned"); expect(observed.validation.status).toBe("failed");
    writeFileSync(join(root, "AGENTS.md"), readFileSync(join(root, "AGENTS.md"), "utf8") + "\nProject change\n"); expect(inspectHarness(root, "fixture", trusted).validation.status).toBe("unknown");
  });
  it("reports context overflow and broken references without claiming repairs", () => {
    const root = fixture(); const path = join(root, ".agents/cold-start/budget-manifest.yaml"); writeFileSync(path, readFileSync(path, "utf8").replace("budgetLines: 500", "budgetLines: 1"));
    writeFileSync(join(root, "AGENTS.md"), readFileSync(join(root, "AGENTS.md"), "utf8") + "\n[secret](.codex/auth.json)\n");
    const observed = inspectHarness(root, "fixture", source()); expect(observed.findings.some((entry) => entry.id.startsWith("context-"))).toBe(true); expect(observed.findings.some((entry) => entry.id.startsWith("reference-"))).toBe(true); expect(observed.findings.every((entry) => !entry.safely_automatable)).toBe(true);
  });
});
