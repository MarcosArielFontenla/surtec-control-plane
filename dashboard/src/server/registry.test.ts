import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistryProjects } from "./registry";

describe("loadRegistryProjects", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "surtec-reg-"));
    mkdirSync(join(root, "registry"), { recursive: true });
    writeFileSync(
      join(root, "registry", "agents.yml"),
      "agents:\n  - id: backend-engineer\n    name: Backend Engineer\n    type: engineering\n    description: Implements code.\n    default_sandbox: workspace-write\n    allowed_task_types: []\n    requires_human_approval_for: []\n  - id: qa-reviewer\n    name: QA Reviewer\n    type: quality\n    description: Reviews quality.\n    default_sandbox: read-only\n    allowed_task_types: []\n    requires_human_approval_for: []\n",
      "utf8",
    );
    writeFileSync(
      join(root, "registry", "projects.yml"),
      [
        "projects:",
        "  stock-control:",
        "    repo: git@github.com:surtec/stock-control.git",
        "    local_path: ~/dev/surtec/stock-control",
        "    status: active",
        "    default_branch: main",
        "    allowed_agents:",
        "      - backend-engineer",
        "      - qa-reviewer",
        "  portfolio-site:",
        "    status: planned",
        "",
      ].join("\n"),
      "utf8",
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("maps projects to id/status/repo/allowed_agents/repo_path", () => {
    expect(loadRegistryProjects(root)).toEqual([
      {
        id: "stock-control",
        status: "active",
        repo: "git@github.com:surtec/stock-control.git",
        allowed_agents: ["backend-engineer", "qa-reviewer"],
        repo_path: null,
        default_branch: "main",
        deploy_url: null,
        railway: null,
      },
      {
        id: "portfolio-site",
        status: "planned",
        repo: null,
        allowed_agents: [],
        repo_path: null,
        default_branch: null,
        deploy_url: null,
        railway: null,
      },
    ]);
  });

  it("prefers the discovered machine-local path over a stale configured path", () => {
    const projectsRoot = join(root, "projects");
    const discovered = join(projectsRoot, "stock-control");
    mkdirSync(join(discovered, ".git"), { recursive: true });
    process.env.SURTEC_PROJECTS_ROOT = projectsRoot;
    try {
      expect(loadRegistryProjects(root)[0].repo_path).toBe(discovered);
    } finally {
      delete process.env.SURTEC_PROJECTS_ROOT;
    }
  });
});
