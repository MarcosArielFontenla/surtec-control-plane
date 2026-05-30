import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectCommands } from "./project-commands";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pc-"));
  mkdirSync(join(root, "registry"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeRegistry(yml: string) {
  writeFileSync(join(root, "registry", "projects.yml"), yml, "utf8");
}

describe("loadProjectCommands", () => {
  it("returns the full commands map", () => {
    writeRegistry(`projects:\n  p:\n    commands:\n      dev: npm run dev\n      build: npm run build\n      test: npm test\n      lint: npm run lint\n      install: npm install\n`);
    expect(loadProjectCommands(root, "p")).toEqual({
      dev: "npm run dev", build: "npm run build", test: "npm test", lint: "npm run lint", install: "npm install",
    });
  });

  it("returns a partial map", () => {
    writeRegistry(`projects:\n  p:\n    commands:\n      dev: npm run dev\n      test: npm test\n`);
    expect(loadProjectCommands(root, "p")).toEqual({ dev: "npm run dev", test: "npm test" });
  });

  it("filters out empty/non-string values", () => {
    writeRegistry(`projects:\n  p:\n    commands:\n      dev: ""\n      test: npm test\n`);
    expect(loadProjectCommands(root, "p")).toEqual({ test: "npm test" });
  });

  it("returns {} for an unknown project", () => {
    writeRegistry(`projects:\n  p:\n    commands:\n      test: npm test\n`);
    expect(loadProjectCommands(root, "missing")).toEqual({});
  });

  it("returns {} when the registry is missing", () => {
    expect(loadProjectCommands(root, "p")).toEqual({});
  });

  it("returns {} when a project has no commands", () => {
    writeRegistry(`projects:\n  p:\n    repo: x\n`);
    expect(loadProjectCommands(root, "p")).toEqual({});
  });
});
