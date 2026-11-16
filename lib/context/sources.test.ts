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

describe("Factory F2 selected project sources", () => {
  const selectedDocuments = {
    "README.md": "# Synthetic request project\nUse the local request contract. [Unselected notes](docs/unselected.md) are not an include directive.\n",
    "docs/architecture/control-plane.md": "# Synthetic architecture\nKeep one local API and the current issue aggregate.\n",
    "docs/decisions/ADR-0001-request.md": "# Synthetic request decision\nA proposed request requires a separate current human scope decision.\n",
    "docs/contracts/request.md": "# Synthetic request contract\nConfigured check: pnpm test. Configuration does not prove execution or approval.\n",
  };
  const taskClass = "factory-request-analysis";

  it("loads the complete selected README, architecture, ADR and contract only from their contained project", () => {
    const root = fixture(); const otherProject = fixture();
    harness(root, [
      { name: taskClass, artifacts: Object.keys(selectedDocuments) },
      { name: "unselected-project-work", artifacts: ["docs/unselected.md", "docs/not-present.md"] },
    ]);
    for (const [path, text] of Object.entries(selectedDocuments)) {
      write(root, path, text);
      write(otherProject, path, `Other project material must stay excluded: ${path}`);
    }
    write(root, "docs/unselected.md", "Unselected document body must stay excluded.");
    const selection = { ...input(), harnessTaskClasses: [taskClass], routes: [] };
    const originalSelection = structuredClone(selection);
    const before = Object.fromEntries(Object.keys(selectedDocuments).map((path) => [path, readFileSync(join(root, path))]));

    const result = readProjectContext(root, selection);

    expect(result.harnessPresent).toBe(true);
    expect(result.omitted).toEqual([]);
    expect(result.sources.map((source) => source.id).sort()).toEqual([
      "project/AGENTS.md", "project/.agents/cold-start/budget-manifest.yaml",
      "project/.agents/policies/project.md", "project/.agents/orchestration/ROUTING.md",
      ...Object.keys(selectedDocuments).map((path) => `project/${path}`),
    ].sort());
    for (const [path, text] of Object.entries(selectedDocuments)) {
      expect(result.sources.find((source) => source.id === `project/${path}`)).toEqual({
        id: `project/${path}`, layer: "instructions", source_type: path.includes("/decisions/") ? "decision" : "instruction",
        sensitivity: "local", reason: `Selected complete Harness task class ${taskClass}`, text,
      });
      expect(readFileSync(join(root, path))).toEqual(before[path]);
    }
    expect(result.sources.some((source) => source.text.includes("Other project material must stay excluded"))).toBe(false);
    expect(result.sources.some((source) => source.text.includes("Unselected document body must stay excluded"))).toBe(false);
    expect(result.sources.some((source) => source.id.endsWith("/docs/unselected.md") || source.id.endsWith("/docs/not-present.md"))).toBe(false);
    expect(selection).toEqual(originalSelection);
  });

  it.each([
    ["missing", /Required selected context source is missing/],
    ["oversized", /Selected context source is unsafe or unavailable/],
  ] as const)("refuses a %s selected contract instead of skipping or truncating the mandatory source", (condition, message) => {
    const root = fixture();
    harness(root, [{ name: taskClass, artifacts: Object.keys(selectedDocuments) }]);
    for (const [path, text] of Object.entries(selectedDocuments)) {
      if (path !== "docs/contracts/request.md") write(root, path, text);
    }
    if (condition === "oversized") write(root, "docs/contracts/request.md", "x".repeat(256 * 1024 + 1));
    const primerBefore = readFileSync(join(root, "AGENTS.md"));
    const manifestBefore = readFileSync(join(root, ".agents/cold-start/budget-manifest.yaml"));

    expect(() => readProjectContext(root, { ...input(), harnessTaskClasses: [taskClass] })).toThrow(message);

    expect(readFileSync(join(root, "AGENTS.md"))).toEqual(primerBefore);
    expect(readFileSync(join(root, ".agents/cold-start/budget-manifest.yaml"))).toEqual(manifestBefore);
  });
});
