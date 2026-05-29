import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSeed } from "./surtec-state";

describe("cli seed", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "surtec-cli-"));
    mkdirSync(join(root, "fixtures", "tasks"), { recursive: true });
    mkdirSync(join(root, "fixtures", "projects"), { recursive: true });
    writeFileSync(join(root, "fixtures", "tasks", "T-1.json"), "{}", "utf8");
    writeFileSync(join(root, "fixtures", "projects", "p.json"), "{}", "utf8");
    process.env.SURTEC_STATE_DIR = join(root, "state");
    process.env.SURTEC_FIXTURES_DIR = join(root, "fixtures");
  });
  afterEach(() => {
    delete process.env.SURTEC_STATE_DIR;
    delete process.env.SURTEC_FIXTURES_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("copies fixtures into the state dir", () => {
    const { tasks, projects } = runSeed();
    expect(tasks).toBe(1);
    expect(projects).toBe(1);
    expect(existsSync(join(root, "state", "tasks", "T-1.json"))).toBe(true);
    expect(existsSync(join(root, "state", "projects", "p.json"))).toBe(true);
  });
});
