import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runScaffoldCli } from "../cli/surtec-scaffold";
import { hash } from "../lib/harness/source";
import { readScaffoldOperation } from "../lib/state/harness-scaffold-operations";
import {
  createScaffoldCliFixture, runScaffoldFixtureProcess, scaffoldFixtureGit,
  scaffoldFixtureMissingTemplate as spec, scaffoldFixtureProjectId,
} from "./testing/scaffold-cli-fixture";

const fixtures: ReturnType<typeof createScaffoldCliFixture>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function inventory(root: string) {
  return readdirSync(root, { recursive: true, encoding: "utf8" }).sort().map((path) => {
    const absolute = join(root, path);
    const stat = lstatSync(absolute);
    return [path.replaceAll("\\", "/"), stat.isDirectory() ? "directory" : hash(readFileSync(absolute))];
  });
}

function fixture() {
  const owned = createScaffoldCliFixture();
  fixtures.push(owned);
  return { ...owned, before: inventory(owned.target) };
}

type Fixture = ReturnType<typeof fixture>;

async function cli(f: Fixture, args: readonly string[], respond?: (prompt: string) => string) {
  const stdin = Object.assign(new PassThrough(), { isTTY: !!respond });
  const stdout = new PassThrough();
  const stderr = Object.assign(new PassThrough(), { isTTY: !!respond });
  let result = "", displayed = "", replied = false;
  stdout.on("data", (chunk) => { result += chunk.toString(); });
  stderr.on("data", (chunk) => {
    displayed += chunk.toString();
    const prompt = /Type exactly "((?:apply|rollback) [a-f0-9]{64})"/.exec(displayed)?.[1];
    if (!replied && prompt && respond) {
      replied = true;
      queueMicrotask(() => { stdin.write(respond(prompt) + "\n"); });
    }
  });
  const code = await runScaffoldCli(args, { stdin, stdout, stderr, repoRoot: f.control, environment: f.environment });
  return { code, result: JSON.parse(result), displayed };
}

async function apply(f: Fixture): Promise<string> {
  const run = await cli(f, ["apply", scaffoldFixtureProjectId, "personal@1"], (prompt) => prompt);
  expect(run).toMatchObject({ code: 0, result: { status: "applied", verification: { result: "passed", doctor_validation: "unknown" } } });
  expect(run.displayed).toContain('"action": "apply"');
  expect(run.displayed).toContain(spec);
  expect(run.displayed).not.toContain("Preserve the fixture primer");
  return run.result.operation_id;
}

it("starts the actual CLI for a read-only preview and rejects approval delivered through a pipe", () => {
  const f = fixture();
  const preview = runScaffoldFixtureProcess(f, ["preview", scaffoldFixtureProjectId, "personal@1"]);
  expect(preview.status).toBe(0);
  expect(preview.stderr).toBe("");
  const plan = JSON.parse(preview.stdout);
  expect(plan).toMatchObject({ status: "available", project_id: scaffoldFixtureProjectId, additions: [{ path: spec }], execution_authority: "none" });
  const refused = runScaffoldFixtureProcess(f, ["apply", scaffoldFixtureProjectId, "personal@1"], `apply ${plan.apply_digest}\n`);
  expect(refused.status).toBe(1);
  expect(JSON.parse(refused.stdout)).toEqual({ status: "refused", reason: "interactive-terminal-required" });
  expect(inventory(f.target)).toEqual(f.before);
  expect(lstatSync(f.state, { throwIfNoEntry: false })).toBeUndefined();
});

it("applies pinned bytes from the live CLI offer and reads the sealed receipt through status", async () => {
  const f = fixture();
  const controlBefore = inventory(f.control);
  const id = await apply(f);
  const receipt = readScaffoldOperation(f.state, id);
  expect(receipt?.record.preimage.additions).toHaveLength(1);
  const bytes = readFileSync(join(f.control, spec));
  expect(receipt?.blobs).toEqual([{ path: spec, bytes }]);
  expect(readFileSync(join(f.target, spec))).toEqual(bytes);
  expect(lstatSync(join(f.target, spec)).nlink).toBe(1);
  expect(inventory(f.target).filter(([path]) => path !== spec)).toEqual(f.before);
  const stateBefore = inventory(f.state);
  const status = await cli(f, ["status", id]);
  expect(status).toMatchObject({ code: 0, result: { status: "applied", operation_id: id, rollback: { paths: [{ path: spec, action: "remove" }] } } });
  expect(inventory(f.state)).toEqual(stateBefore);
  expect(inventory(f.control)).toEqual(controlBefore);
});

describe("CLI rollback of an applied fixture", () => {
  let f: Fixture;
  let id: string;
  beforeEach(async () => {
    f = fixture();
    id = await apply(f);
  });

  it("rejects the apply verb and restores the exact original inventory after separate approval", async () => {
    const appliedInventory = inventory(f.target);
    const declined = await cli(f, ["rollback", id], (prompt) => prompt.replace(/^rollback /, "apply "));
    expect(declined).toMatchObject({ code: 1, result: { status: "refused", reason: "not-approved" } });
    expect(inventory(f.target)).toEqual(appliedInventory);
    const rolledBack = await cli(f, ["rollback", id], (prompt) => prompt);
    expect(rolledBack).toMatchObject({ code: 0, result: { status: "rolled-back", operation_id: id } });
    expect(rolledBack.displayed).toContain('"action": "rollback"');
    expect(inventory(f.target)).toEqual(f.before);
    expect(readScaffoldOperation(f.state, id)?.record.checkpoints.at(-1)).toEqual({ kind: "absence-observed", path: spec, outcome: "removed" });
  });

  it("preserves an addition staged after apply and exits without an approval prompt", async () => {
    scaffoldFixtureGit(f.target, "add", "--", spec);
    const before = inventory(f.target);
    const state = inventory(f.state);
    const refused = await cli(f, ["rollback", id], () => { throw new Error("Unsafe rollback must not ask for approval"); });
    expect(refused).toMatchObject({ code: 1, result: { status: "needs-review", operation_id: id }, displayed: "" });
    expect(inventory(f.target)).toEqual(before);
    expect(inventory(f.state)).toEqual(state);
  });
});
