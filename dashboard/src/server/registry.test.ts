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
        "    status: active",
        "  portfolio-site:",
        "    status: planned",
        "",
      ].join("\n"),
      "utf8",
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("maps projects to id/status/repo", () => {
    expect(loadRegistryProjects(root)).toEqual([
      { id: "stock-control", status: "active", repo: "git@github.com:surtec/stock-control.git" },
      { id: "portfolio-site", status: "planned", repo: null },
    ]);
  });
});
