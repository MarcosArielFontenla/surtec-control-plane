import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { stateDir, tasksDir, fixturesDir, portfolioDir, portfolioProfilesPath, signalHumanStatePath } from "./paths";

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
    expect(portfolioDir()).toBe(join("/tmp/custom-state", "portfolio"));
    expect(portfolioProfilesPath()).toBe(join("/tmp/custom-state", "portfolio", "projects.json"));
    expect(signalHumanStatePath()).toBe(join("/tmp/custom-state", "signals", "human-state.json"));
  });

  it("defaults fixturesDir to <cwd>/fixtures", () => {
    expect(fixturesDir()).toBe(join(process.cwd(), "fixtures"));
  });
});
