import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname, posix } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { inspectHarness, inspectHarnessWithCoverage } from "./inspect";
import { hash, loadHarnessSource, readContained, safeRelative } from "./source";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(installed = true) {
  const root = mkdtempSync(join(tmpdir(), "surtec-inventory-test-")); roots.push(root);
  if (!installed) return root;
  const trusted = source();
  if (trusted.status !== "trusted" || !trusted.manifest || !trusted.registry || trusted.manifest.expected_entries.length !== 25) {
    throw new Error("The fixture requires the reviewed 25-entry Harness source.");
  }
  const sourceRoot = resolve(process.cwd(), trusted.registry.source.root);
  const files = new Map<string, Buffer>();
  let total = 0;
  const add = (path: string): void => {
    if (!safeRelative(path) || /(^|\/)(?:\.git|\.codex|\.aws|state|auth\.json|credentials|\.env[^/]*)(\/|$)/i.test(path)
      || !(path === "AGENTS.md" || path.startsWith(".agents/") || path.startsWith("docs/")) || path.split("/").length - 1 > 6) {
      throw new Error("The fixture requires a contained instruction or support path.");
    }
    if (files.has(path)) return;
    let bytes: Buffer | null;
    try { bytes = readContained(sourceRoot, path); } catch { throw new Error("Reviewed fixture input is unreadable or unsafe."); }
    if (!bytes) throw new Error("Reviewed fixture input is missing.");
    if (files.size >= 128 || total + bytes.length > 2 * 1024 * 1024) throw new Error("Reviewed fixture support exceeds the inventory bounds.");
    files.set(path, bytes); total += bytes.length;
  };
  for (const entry of trusted.manifest.expected_entries) {
    add(entry.path);
    if (hash(files.get(entry.path)!) !== entry.sha256) throw new Error("Reviewed fixture input changed after source validation.");
  }
  const budget: unknown = parse(files.get(".agents/cold-start/budget-manifest.yaml")!.toString("utf8"));
  if (!budget || typeof budget !== "object" || !("alwaysLoad" in budget) || !Array.isArray(budget.alwaysLoad)
    || !("taskClasses" in budget) || !Array.isArray(budget.taskClasses)) throw new Error("Reviewed fixture context routes are invalid.");
  const required: unknown[] = [...budget.alwaysLoad];
  for (const route of budget.taskClasses) {
    if (!route || typeof route !== "object" || !("artifacts" in route) || !Array.isArray(route.artifacts)) throw new Error("Reviewed fixture context support is invalid.");
    required.push(...route.artifacts);
  }
  for (const path of required) {
    if (typeof path !== "string") throw new Error("Reviewed fixture context paths must be strings.");
    add(path);
  }
  const routing = files.get(".agents/orchestration/ROUTING.md")!.toString("utf8");
  for (const match of [...routing.matchAll(/`([^`]+\.(?:md|yaml|json))`/g)].slice(0, 64)) add(match[1]);
  // Only the initial instruction inventory's first-hop links are inspected; support docs are not recursively followed.
  const instructions = [...files].filter(([path]) => path === "AGENTS.md" || path.startsWith(".agents/"));
  for (const [path, bytes] of instructions) {
    if (!path.endsWith(".md")) continue;
    for (const match of [...bytes.toString("utf8").matchAll(/\]\(([^\s)]+)\)/g)].slice(0, 64)) {
      const ref = match[1];
      if (/^[a-z]+:/i.test(ref) || ref.startsWith("#") || ref.includes("<")) continue;
      add(posix.normalize(posix.join(posix.dirname(path), ref.split("#")[0])));
    }
  }
  for (const [path, bytes] of files) {
    const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes);
  }
  return root;
}
const source = () => loadHarnessSource(process.cwd());
describe("read-only Harness inventory", () => {
  it("reports entry and depth limits through the internal coverage observation", () => {
    const trusted = source();
    const wide = fixture(false);
    mkdirSync(join(wide, ".agents"));
    for (let index = 0; index < 130; index++) writeFileSync(join(wide, ".agents", `fixture-${index}.txt`), "fixture");
    const now = new Date("2026-11-16T20:00:00.000Z");
    const observation = inspectHarnessWithCoverage(wide, "fixture", trusted, now);
    expect(observation.inventoryLimits).toEqual(["entry-count"]);
    expect(observation.profile).toEqual(inspectHarness(wide, "fixture", trusted, now));
    expect(observation.profile.entries).toHaveLength(128);
    expect(observation.profile.findings).toEqual(expect.arrayContaining([expect.objectContaining({ id: "inventory-limit" })]));

    const deep = fixture(false);
    mkdirSync(join(deep, ".agents/a/b/c/d/e/f/g"), { recursive: true });
    expect(inspectHarnessWithCoverage(deep, "fixture", trusted, now).inventoryLimits).toEqual(["depth"]);
  });
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
  it("copies the byte-exact reviewed baseline and required support without live project history", () => {
    const root = fixture(); const trusted = source(); const sourceRoot = resolve(process.cwd(), trusted.registry!.source.root);
    expect(trusted.status).toBe("trusted"); expect(trusted.manifest!.expected_entries).toHaveLength(25);
    for (const entry of trusted.manifest!.expected_entries) {
      const bytes = readContained(root, entry.path)!;
      expect(hash(bytes)).toBe(entry.sha256); expect(bytes).toEqual(readContained(sourceRoot, entry.path));
    }
    expect(readContained(root, ".agents/specs/tasks/phase-p-operational-continuity.tasks.md")).toBeNull();
    expect(readContained(root, ".agents/specs/operational-continuity.spec.yaml")).toBeNull();
    expect(readContained(root, "docs/architecture/phase-p-operational-continuity-design.md")).toBeNull();
    const observed = inspectHarness(root, "fixture", trusted);
    expect(observed.findings.some((entry) => entry.id === "context-unknown" || entry.id === "routing-reference-invalid" || entry.id.startsWith("reference-"))).toBe(false);
  });
  it("preserves a small readable project addition without inferring ownership or validation", () => {
    const root = fixture(); const path = ".agents/specs/tasks/synthetic-history.md"; const body = Buffer.from("synthetic-private-project-history-body\n");
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body);
    const observed = inspectHarness(root, "fixture", source());
    expect(observed.status).toBe("healthy"); expect(observed.comparison).toBe("compatible"); expect(observed.detected_version).toBe("surtec-h1-h4-v1");
    expect(observed.entries.find((entry) => entry.path === path)).toEqual({ path, status: "present", ownership: "unknown", ownership_evidence: null });
    expect(observed.findings.some((entry) => entry.id === "project-additions")).toBe(true);
    expect(observed.validation.status).toBe("unknown"); expect(JSON.stringify(observed)).not.toContain(body.toString("utf8").trim());
    expect(readFileSync(join(root, path))).toEqual(body);
  });
  it.each([
    { size: 262144, removeValidator: false },
    { size: 262144, removeValidator: true },
    { size: 262145, removeValidator: false },
    { size: 262145, removeValidator: true },
  ])("retains the read boundary for $size-byte history with validator removed=$removeValidator", ({ size, removeValidator }) => {
    const root = fixture(); const path = ".agents/specs/tasks/synthetic-history.md"; const validator = ".agents/scripts/validate-spec.ps1";
    const body = Buffer.alloc(size, "x"); const marker = "synthetic-private-project-history-body"; body.write(marker);
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body);
    const primerBefore = readFileSync(join(root, "AGENTS.md"));
    if (removeValidator) unlinkSync(join(root, validator));
    const observed = inspectHarness(root, "fixture", source()); const oversized = size > 262144;
    expect(observed.entries.find((entry) => entry.path === path)).toEqual({ path, status: oversized ? "unsafe" : "present", ownership: "unknown", ownership_evidence: null });
    expect(observed.status).toBe(oversized ? "unknown" : removeValidator ? "partial" : "healthy");
    expect(observed.comparison).toBe(oversized ? "unknown" : removeValidator ? "drift" : "compatible");
    expect(observed.detected_version).toBe(!oversized && !removeValidator ? "surtec-h1-h4-v1" : null);
    expect(observed.entries.find((entry) => entry.path === validator)?.status).toBe(removeValidator ? "missing" : "present");
    expect(observed.capability_results.find((entry) => entry.capability === "validators")?.status).toBe(removeValidator ? "missing" : "present");
    expect(observed.entries.every((entry) => entry.ownership === "unknown")).toBe(true); expect(observed.validation.status).toBe("unknown");
    expect(observed.findings.every((entry) => !entry.safely_automatable)).toBe(true); expect(JSON.stringify(observed)).not.toContain(marker);
    if (oversized) expect(() => readContained(root, path)).toThrow(); else expect(readContained(root, path)).toEqual(body);
    expect(readFileSync(join(root, path))).toEqual(body); expect(readFileSync(join(root, "AGENTS.md"))).toEqual(primerBefore);
  });
});
