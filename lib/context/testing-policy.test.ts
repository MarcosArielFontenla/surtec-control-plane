import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { resolveTestingPolicy } from "./testing-policy";
import type { ContextConfig } from "./types";
const config = (): ContextConfig => parse(readFileSync("registry/context-policy.yml", "utf8"));
const input = { projectId: "synthetic", roleId: "software-engineer", verifyCommands: ["node verify.mjs"] };
describe("testing policy resolution", () => {
  it("defaults to functional without inventing RED evidence", () => {
    expect(resolveTestingPolicy(config(), input)).toMatchObject({ mode: "functional", requires_red_evidence: false, commands: input.verifyCommands, minimum_review_depth: "focused" });
  });
  it("retains stricter review and strict TDD across lower-priority functional policy", () => {
    const value = config();
    value.runners = { red: { command: "node red.mjs", stage: "red" }, green: { command: "node green.mjs", stage: "green" } };
    const probe = { sources: [{ path: "test/probe.mjs", sha256: "a".repeat(64) }], assertion_ids: ["behavior"] };
    value.runners.red!.probe = probe; value.runners.green!.probe = probe;
    value.testing.no_refactor_justification = "No structural change is required for this bounded fixture.";
    value.testing.global = { mode: "strict-tdd", minimum_review_depth: "full", runner_ids: ["red", "green"] };
    value.testing.projects.synthetic = { mode: "functional", minimum_review_depth: "focused", runner_ids: [] };
    expect(resolveTestingPolicy(value, { ...input, verifyCommands: ["node red.mjs", "node green.mjs"] })).toMatchObject({ mode: "strict-tdd", requires_red_evidence: true, minimum_review_depth: "full" });
  });
  it("rejects any runner not authorized by current technical policy", () => {
    const value = config(); value.runners.check = { command: "node unauthorized.mjs", stage: "functional" }; value.testing.global.runner_ids = ["check"];
    expect(() => resolveTestingPolicy(value, input)).toThrow(/authorized/);
  });
  it("cannot use inherited registry properties or claim strict TDD without stages", () => {
    const value = config(); value.testing.global.runner_ids = ["constructor"];
    expect(() => resolveTestingPolicy(value, input)).toThrow(/authorized/);
    expect(() => resolveTestingPolicy(config(), { ...input, harnessPolicy: { mode: "strict-tdd", minimum_review_depth: "full", runner_ids: [] } })).toThrow(/RED/);
  });
  it("blocks unobservable, mismatched and unjustified strict stages without downgrading", () => {
    const value = config();
    value.runners = { red: { command: "node red.mjs", stage: "red" }, green: { command: "node green.mjs", stage: "green" } };
    value.testing.global = { mode: "strict-tdd", minimum_review_depth: "full", runner_ids: ["red", "green"] };
    const authorized = { ...input, verifyCommands: ["node red.mjs", "node green.mjs"] };
    expect(() => resolveTestingPolicy(value, authorized)).toThrow(/observable/);
    const probe = { sources: [{ path: "test/probe.mjs", sha256: "a".repeat(64) }], assertion_ids: ["behavior"] };
    value.runners.red!.probe = probe; value.runners.green!.probe = { ...probe, assertion_ids: ["different"] };
    expect(() => resolveTestingPolicy(value, authorized)).toThrow(/identities/);
    value.runners.green!.probe = probe;
    expect(() => resolveTestingPolicy(value, authorized)).toThrow(/REFACTOR/);
    value.runners.refactor = { command: "node refactor.mjs", stage: "refactor" }; value.testing.global.runner_ids.push("refactor");
    expect(resolveTestingPolicy(value, { ...authorized, verifyCommands: [...authorized.verifyCommands, "node refactor.mjs"] }).mode).toBe("strict-tdd");
  });
});
