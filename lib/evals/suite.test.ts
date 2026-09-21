import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvaluationSuite } from "./suite";

describe("runEvaluationSuite", () => {
  it("validates the repository suite and covers every registered role/task-type pair", () => {
    const result = runEvaluationSuite(process.cwd());

    expect(result.passed).toBe(true);
    expect(result.evaluated).toBe(42);
    expect(result.matched).toBe(42);
    expect(result.coverage).toEqual({ expected: 36, covered: 36, missing: [] });
    expect(result.cases.find((item) => item.evaluation.fixture_id === "hard-secret-exposure")?.evaluation)
      .toMatchObject({ verdict: "hard-fail", score: 1 });
  });
});

describe("evaluation suite integrity", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "surtec-evals-"));
    mkdirSync(join(root, "registry"), { recursive: true });
    mkdirSync(join(root, "evals", "v1", "cases"), { recursive: true });
    writeFileSync(join(root, "registry", "agents.yml"), [
      "agents:",
      "  - id: backend-engineer",
      "    name: Backend Engineer",
      "    type: engineering",
      "    description: Implements backend changes.",
      "    default_sandbox: workspace-write",
      "    allowed_task_types: [bugfix, api-change]",
      "    requires_human_approval_for: [merge]",
      "",
    ].join("\n"), "utf8");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function writeManifest(fixtures: string[]): string {
    const path = join(root, "evals", "v1", "suite.json");
    writeFileSync(path, JSON.stringify({ schema_version: 1, suite_id: "test-v1", minimum_score: 0.8, fixtures }), "utf8");
    return path;
  }

  it("fails the suite when registry drift creates a coverage gap", () => {
    const fixture = JSON.parse(readFileSync(join(process.cwd(), "evals", "v1", "cases", "backend-engineer-pass.json"), "utf8"));
    fixture.task_types = ["bugfix"];
    writeFileSync(join(root, "evals", "v1", "cases", "case.json"), JSON.stringify(fixture), "utf8");
    const result = runEvaluationSuite(root, writeManifest(["cases/case.json"]));

    expect(result.passed).toBe(false);
    expect(result.coverage).toEqual({ expected: 2, covered: 1, missing: ["backend-engineer:api-change"] });
  });

  it("rejects traversal fixture paths before filesystem access", () => {
    writeFileSync(join(root, "evals", "outside.json"), "{}", "utf8");
    const manifest = writeManifest(["../outside.json"]);

    expect(() => runEvaluationSuite(root, manifest)).toThrow("evaluation manifest is invalid");
  });

  it("rejects a manifest outside the evaluations root", () => {
    expect(() => runEvaluationSuite(root, join(root, "registry", "agents.yml")))
      .toThrow("evaluation manifest path escapes its allowed root");
  });
});
