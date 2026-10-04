import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjectContext, type ProjectContextSelection } from "./sources";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const input = (): ProjectContextSelection => ({ roleId: "planner", taskKind: "analysis", affectedDomains: ["ui"], routes: [], requiredSkillIds: [] });
function fixture(): string { const root = mkdtempSync(join(tmpdir(), "surtec-context-sources-")); roots.push(root); return root; }
function write(root: string, path: string, text: string): void { mkdirSync(join(root, ...path.split("/").slice(0, -1)), { recursive: true }); writeFileSync(join(root, path), text); }
function harness(root: string, taskClasses: { name: string; artifacts: string[] }[] = []): void {
  write(root, ".agents/cold-start/budget-manifest.yaml", JSON.stringify({ version: 1, budgetLines: 500, loadMode: "full-skills", counting: "physical-lines-including-frontmatter", overflowAction: "decompose-without-skipping-required-reads", alwaysLoad: ["AGENTS.md", ".agents/policies/project.md", ".agents/orchestration/ROUTING.md"], taskClasses }));
  write(root, "AGENTS.md", "---\nrole: session-primer\n---\nSynthetic instructions");
  write(root, ".agents/policies/project.md", "Synthetic policy");
  write(root, ".agents/orchestration/ROUTING.md", "Synthetic routing; do not interpret this prose as permissions.");
}
describe("contained project context selection", () => {
  it("supports honest absent Harness without inventing instructions", () => {
    expect(readProjectContext(fixture(), input())).toMatchObject({ sources: [], harnessPresent: false });
  });
  it("reads only declared mandatory sources and matching trusted routes, leaving bytes unchanged", () => {
    const root = fixture(); harness(root); write(root, "docs/selected.md", "Selected"); write(root, "docs/unselected.md", "Never automatically concatenate");
    const before = readFileSync(join(root, "AGENTS.md"));
    const selection = input(); selection.routes = [{ id: "ui-analysis", role_ids: ["planner"], task_kinds: ["analysis"], affected_domains: ["ui"], paths: ["docs/selected.md"], required: true }];
    const result = readProjectContext(root, selection);
    expect(result.sources.map((source) => source.id)).toContain("project/docs/selected.md"); expect(result.sources.some((source) => source.text.includes("Never automatically"))).toBe(false);
    expect(result.sources.filter((source) => source.id === "project/AGENTS.md")).toHaveLength(1); expect(readFileSync(join(root, "AGENTS.md"))).toEqual(before);
  });
  it("fails on missing required routing rather than silently skipping it", () => {
    const root = fixture(); harness(root); rmSync(join(root, ".agents/orchestration/ROUTING.md"));
    expect(() => readProjectContext(root, input())).toThrow(/missing/);
  });
  it("selects complete structured task classes without loading unrelated classes or following Markdown links", () => {
    const root = fixture();
    harness(root, [{ name: "dashboard-workflow", artifacts: ["docs/dashboard.md", ".agents/skills/example/SKILL.md"] }, { name: "unrelated", artifacts: ["docs/unavailable.md"] }]);
    write(root, "docs/dashboard.md", "Selected [untrusted include](unavailable.md)");
    write(root, ".agents/skills/example/SKILL.md", "---\nname: example\ndescription: Synthetic skill.\n---\nFull body; not a snapshot.");
    const selection = { ...input(), harnessTaskClasses: ["dashboard-workflow", "dashboard-workflow"], requiredSkillIds: ["example"] };
    const result = readProjectContext(root, selection);
    expect(result.sources.filter((source) => source.source_type === "skill")).toHaveLength(1);
    expect(result.sources.some((source) => source.id.endsWith("unavailable.md"))).toBe(false);
    expect(result.sources.find((source) => source.id.endsWith("SKILL.md"))!.text).toContain("Full body");
    expect(() => readProjectContext(root, { ...selection, harnessTaskClasses: ["unknown"] })).toThrow(/task class/);
  });
  it("fails closed on incomplete recognized Harness and malformed structured routes", () => {
    const root = fixture(); write(root, "AGENTS.md", "---\nrole: session-primer\n---\nSynthetic");
    expect(() => readProjectContext(root, input())).toThrow(/manifest is missing/);
    harness(root, [{ name: "dashboard-workflow", artifacts: ["../private.md"] }]);
    expect(() => readProjectContext(root, input())).toThrow(/task class/);
    harness(root, [{ name: "duplicate", artifacts: [] }, { name: "duplicate", artifacts: [] }]);
    expect(() => readProjectContext(root, input())).toThrow(/task class/);
    harness(root, [{ name: "dashboard-workflow", artifacts: ["docs/missing.md"] }]);
    expect(() => readProjectContext(root, { ...input(), harnessTaskClasses: ["dashboard-workflow"] })).toThrow(/missing/);
  });
  it("rejects malformed UTF-8 rather than silently replacing source bytes", () => {
    const root = fixture(); writeFileSync(join(root, "AGENTS.md"), Buffer.from([0xc3, 0x28]));
    expect(() => readProjectContext(root, input())).toThrow(/UTF-8/);
  });
  it("rejects linked directories and traversal", () => {
    const root = fixture(); const outside = fixture(); write(outside, "rules.md", "Outside source"); symlinkSync(outside, join(root, "docs"), "junction");
    const selection = input(); selection.routes = [{ id: "unsafe", role_ids: [], task_kinds: [], affected_domains: [], paths: ["docs/rules.md"], required: true }];
    expect(() => readProjectContext(root, selection)).toThrow(/unsafe/);
    selection.routes[0]!.paths = ["../rules.md"]; expect(() => readProjectContext(root, selection)).toThrow(/Unsafe/);
  });
  it("requires complete valid skills rather than substituting snapshots", () => {
    const root = fixture(); write(root, ".agents/cold-start/snapshots/example.snapshot.md", "Not a complete skill");
    expect(() => readProjectContext(root, { ...input(), requiredSkillIds: ["example"] })).toThrow(/missing/);
    write(root, ".agents/skills/example/SKILL.md", "---\nname: example\ndescription: Synthetic skill.\n---\nComplete body\n");
    expect(readProjectContext(root, { ...input(), requiredSkillIds: ["example"] }).sources[0]!.text).toContain("Complete body");
    write(root, ".agents/skills/example/SKILL.md", "Invalid skill"); expect(() => readProjectContext(root, { ...input(), requiredSkillIds: ["example"] })).toThrow(/metadata/);
  });
  it("rejects oversized primers, files and unsupported manifest versions", () => {
    const root = fixture(); write(root, "AGENTS.md", Array(41).fill("Line").join("\n"));
    expect(() => readProjectContext(root, input())).toThrow(/primer/);
    write(root, "AGENTS.md", "x".repeat(256 * 1024 + 1)); expect(() => readProjectContext(root, input())).toThrow(/unsafe/);
    write(root, "AGENTS.md", "Synthetic"); write(root, ".agents/cold-start/budget-manifest.yaml", "version: 2\nalwaysLoad: []"); expect(() => readProjectContext(root, input())).toThrow(/Unsupported/);
  });
});
