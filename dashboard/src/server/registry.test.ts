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
        repo_path: "~/dev/surtec/stock-control",
        default_branch: "main",
        deploy_url: null,
      },
      {
        id: "portfolio-site",
        status: "planned",
        repo: null,
        allowed_agents: [],
        repo_path: null,
        default_branch: null,
        deploy_url: null,
      },
    ]);
  });
});
