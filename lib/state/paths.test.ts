import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { stateDir, tasksDir, fixturesDir } from "./paths";

describe("paths", () => {
  afterEach(() => {
    delete process.env.SURTEC_STATE_DIR;
  });

  it("defaults stateDir to <cwd>/state", () => {
    expect(stateDir()).toBe(join(process.cwd(), "state"));
  });

  it("honors SURTEC_STATE_DIR override", () => {
    process.env.SURTEC_STATE_DIR = "/tmp/custom-state";
    expect(stateDir()).toBe("/tmp/custom-state");
    expect(tasksDir()).toBe(join("/tmp/custom-state", "tasks"));
  });

  it("defaults fixturesDir to <cwd>/fixtures", () => {
    expect(fixturesDir()).toBe(join(process.cwd(), "fixtures"));
  });
});
