import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistryAgents } from "./registry-agents";

describe("loadRegistryAgents", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "surtec-agents-"));
    mkdirSync(join(root, "registry"), { recursive: true });
    writeFileSync(
      join(root, "registry", "agents.yml"),
      [
        "agents:",
        "  - id: backend-engineer",
        "    name: Backend Engineer",
        "    description: Implements backend services.",
        "    allowed_task_types:",
        "      - backend-implementation",
        "      - bugfix",
        "  - id: qa-reviewer",
        "    name: QA Reviewer",
        "    description: Builds test plans.",
        "",
      ].join("\n"),
      "utf8",
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("maps agents to id/name/description/allowed_task_types with defaults", () => {
    expect(loadRegistryAgents(root)).toEqual([
      {
        id: "backend-engineer",
        name: "Backend Engineer",
        description: "Implements backend services.",
        allowed_task_types: ["backend-implementation", "bugfix"],
      },
      {
        id: "qa-reviewer",
        name: "QA Reviewer",
        description: "Builds test plans.",
        allowed_task_types: [],
      },
    ]);
  });
});
