import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const hash = (source: string) => createHash("sha256").update(source, "utf8").digest("hex");
const lines = (source: string) => source.length === 0 ? 0 : source.replace(/\r?\n$/, "").split(/\r?\n/).length;

function frontmatter(source: string): Record<string, unknown> {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("missing frontmatter");
  return parse(match[1]!) as Record<string, unknown>;
}

interface SkillMetadata {
  version: string;
  snapshotPath: string;
  snapshotVersion: string;
  driftStatus: string;
}

// Test oracle for the committed source/snapshot contract, not a runtime loader
// or replacement for the native PowerShell tooling supplied by H4.
function snapshotProblems(path: string, source: string, snapshotSource: string): string[] {
  const skill = frontmatter(source);
  const metadata = skill.metadata as SkillMetadata;
  const snapshot = frontmatter(snapshotSource);
  const problems: string[] = [];
  if (snapshot.sourceSkill !== skill.name || snapshot.sourcePath !== path) problems.push("source identity");
  if (metadata.version !== metadata.snapshotVersion || snapshot.sourceVersion !== metadata.version) problems.push("version");
  if (snapshot.sourceHash !== hash(source)) problems.push("content hash");
  if (lines(snapshotSource) > 25) problems.push("line limit");
  return problems;
}

interface ContextManifest {
  budgetLines: number;
  loadMode: string;
  alwaysLoad: string[];
  taskClasses: { name: string; artifacts: string[] }[];
}

const manifest = parse(read(".agents/cold-start/budget-manifest.yaml")) as ContextManifest;
const classes = manifest.taskClasses;
const skillPaths = readdirSync(resolve(root, ".agents/skills"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `.agents/skills/${entry.name}/SKILL.md`)
  .sort();

function contextSize(paths: string[]): number {
  return [...new Set(paths)].reduce((total, path) => total + lines(read(path)), 0);
}

describe("H2 skill and context artifacts", () => {
  it("exposes exactly three discoverable domains using supported skill frontmatter", () => {
    expect(skillPaths.map((path) => frontmatter(read(path)).name)).toEqual([
      "agent-execution-safety", "file-state-contracts", "local-dashboard-validation",
    ]);
    for (const path of skillPaths) {
      const skill = frontmatter(read(path));
      expect(Object.keys(skill).sort()).toEqual(["description", "metadata", "name"]);
      expect(skill.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(typeof skill.description).toBe("string");
      expect((skill.description as string).length).toBeLessThanOrEqual(1024);
      const metadata = skill.metadata as SkillMetadata;
      expect(metadata.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(metadata.snapshotPath).toBe(`.agents/cold-start/snapshots/${skill.name}.snapshot.md`);
      expect(metadata.driftStatus).toBe("inactive");
      expect(metadata).not.toHaveProperty("driftPolicy");
      expect(metadata).not.toHaveProperty("driftPolicyPath");
    }
  });

  it.each(skillPaths)("matches the committed version, full SHA-256, identity and line limit for %s", (path) => {
    const source = read(path);
    const metadata = frontmatter(source).metadata as SkillMetadata;
    const snapshot = read(metadata.snapshotPath);
    expect(frontmatter(snapshot).sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshotProblems(path, source, snapshot)).toEqual([]);
  });

  it("detects source edits even when the skill version is not bumped", () => {
    const path = skillPaths[0]!;
    const source = read(path);
    const metadata = frontmatter(source).metadata as SkillMetadata;
    expect(snapshotProblems(path, source + "\nA changed operational rule.\n", read(metadata.snapshotPath)))
      .toEqual(["content hash"]);
  });

  it("detects version drift, wrong source identity and oversized summaries", () => {
    const path = skillPaths[0]!;
    const source = read(path);
    const metadata = frontmatter(source).metadata as SkillMetadata;
    const snapshot = read(metadata.snapshotPath);
    expect(snapshotProblems(path, source, snapshot.replace('sourceVersion: "1.0.0"', 'sourceVersion: "2.0.0"')))
      .toContain("version");
    expect(snapshotProblems(path, source, snapshot.replace("sourceSkill: agent-execution-safety", "sourceSkill: unrelated")))
      .toContain("source identity");
    expect(snapshotProblems(path, source, snapshot + "\nAn extra line.\n")).toContain("line limit");
  });

  it("maps routing classes one-to-one and counts the always-loaded policy and full skills", () => {
    const routingNames = [...read(".agents/orchestration/ROUTING.md").matchAll(/^\| ([a-z]+(?:-[a-z]+)+) \|/gm)]
      .map((match) => match[1]);
    expect(classes.map((entry) => entry.name).sort()).toEqual(routingNames.sort());
    expect(classes).toHaveLength(10);
    expect(new Set(classes.map((entry) => entry.name)).size).toBe(classes.length);
    expect(manifest.loadMode).toBe("full-skills");
    expect(manifest.budgetLines).toBe(500);
    expect(manifest.alwaysLoad).toEqual(["AGENTS.md", ".agents/policies/project.md", ".agents/orchestration/ROUTING.md"]);
    for (const entry of classes) {
      for (const path of entry.artifacts) {
        expect(existsSync(resolve(root, path)), path).toBe(true);
        expect(path).not.toMatch(/snapshot\.md$/);
      }
    }
    const issueRoute = classes.find((entry) => entry.name === "local-issues-acceptance")!;
    expect(issueRoute.artifacts).toEqual(expect.arrayContaining(skillPaths));
  });

  it.each(classes)("fits the complete declared context for $name", (entry) => {
    expect(contextSize([...manifest.alwaysLoad, ...entry.artifacts])).toBeLessThanOrEqual(manifest.budgetLines);
  });

  it("deduplicates cross-domain context and exposes when work must be decomposed", () => {
    const acceptance = classes.find((entry) => entry.name === "local-issues-acceptance")!;
    const lifecycle = classes.find((entry) => entry.name === "issue-lifecycle-contracts")!;
    const once = [...manifest.alwaysLoad, ...acceptance.artifacts];
    expect(contextSize([...once, ...once])).toBe(contextSize(once));
    expect(contextSize([...once, ...lifecycle.artifacts])).toBeGreaterThan(manifest.budgetLines);
  });

  it("keeps vendor-specific names out of the core while preserving optional interface metadata outside it", () => {
    const vendor = /\b(?:Codex|OpenAI|Claude|Cursor|Copilot)\b/i;
    function checkDirectory(directory: string): void {
      for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
        const path = join(directory, entry.name);
        expect(entry.name).not.toMatch(vendor);
        if (entry.isDirectory()) checkDirectory(path);
        else expect(read(path), path).not.toMatch(vendor);
      }
    }
    checkDirectory(".agents");
    expect(existsSync(resolve(root, ".agents/skills/local-dashboard-validation/agents/openai.yaml"))).toBe(false);
    const archive = parse(read("docs/architecture/harness-adapters/codex/local-dashboard-validation.interface.yaml"));
    expect(archive).toEqual({ interface: {
      display_name: "Local Dashboard Validation",
      short_description: "Automate isolated end-to-end dashboard acceptance",
      default_prompt: "Validate the current project phase through isolated local API and browser flows, preserving user state.",
    } });
  });
});
