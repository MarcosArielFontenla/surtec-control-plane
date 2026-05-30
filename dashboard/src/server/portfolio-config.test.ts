import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectConfig } from "./portfolio-config";

let root: string;
function writeRegistry(yml: string): void {
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(join(root, "registry", "projects.yml"), yml, "utf8");
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "surtec-pcfg-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("loadProjectConfig", () => {
  it("indexes registry entries by id with config fields", () => {
    writeRegistry(
      "projects:\n  alpha:\n    repo: git@x:alpha.git\n    status: active\n    default_branch: main\n    allowed_agents:\n      - backend-engineer\n",
    );
    const cfg = loadProjectConfig(root);
    expect(cfg.get("alpha")).toMatchObject({
      id: "alpha", repo: "git@x:alpha.git", status: "active", default_branch: "main",
      allowed_agents: ["backend-engineer"],
    });
  });
  it("returns an empty map when the registry is missing", () => {
    expect(loadProjectConfig(root).size).toBe(0);
  });
});
