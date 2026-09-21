import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectVerifyCommands } from "./registry-project";

let root: string;

function writeRegistry(yml: string): void {
  mkdirSync(join(root, "registry"), { recursive: true });
  writeFileSync(join(root, "registry", "agents.yml"), "agents: []\n", "utf8");
  writeFileSync(join(root, "registry", "projects.yml"), yml, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-regproj-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadProjectVerifyCommands", () => {
  it("returns an explicit verify list verbatim", () => {
    writeRegistry(`projects:\n  p:\n    verify:\n      - pnpm install\n      - pnpm exec tsc --noEmit\n      - pnpm test\n`);
    expect(loadProjectVerifyCommands(root, "p")).toEqual(["pnpm install", "pnpm exec tsc --noEmit", "pnpm test"]);
  });

  it("defaults to [install, test] from commands", () => {
    writeRegistry(`projects:\n  p:\n    commands:\n      install: pnpm install\n      test: pnpm test\n      build: pnpm build\n`);
    expect(loadProjectVerifyCommands(root, "p")).toEqual(["pnpm install", "pnpm test"]);
  });

  it("falls back to [test] when there is no install", () => {
    writeRegistry(`projects:\n  p:\n    commands:\n      test: pnpm test\n`);
    expect(loadProjectVerifyCommands(root, "p")).toEqual(["pnpm test"]);
  });

  it("returns [] for an unknown project", () => {
    writeRegistry(`projects:\n  p:\n    commands:\n      test: pnpm test\n`);
    expect(loadProjectVerifyCommands(root, "missing")).toEqual([]);
  });

  it("returns [] when the registry file is missing", () => {
    expect(loadProjectVerifyCommands(root, "p")).toEqual([]);
  });

  it("fails closed on empty entries in an explicit verify list", () => {
    writeRegistry(`projects:\n  p:\n    verify:\n      - ""\n      - "  "\n      - pnpm test\n`);
    expect(loadProjectVerifyCommands(root, "p")).toEqual([]);
  });
});
