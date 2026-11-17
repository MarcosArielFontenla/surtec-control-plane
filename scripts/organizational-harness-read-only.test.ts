import { strict as assert } from "node:assert";
import { lstatSync, readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync, type BigIntStats } from "node:fs";
import { join, posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { expect, it } from "vitest";
import { createHarnessService } from "../dashboard/src/server/harness-service";
import type { previewRegisteredScaffold } from "../lib/harness/scaffold-project";
import { hash } from "../lib/harness/source";
import { PolicyService } from "../lib/policy/service";
import { harnessProfilesPath } from "../lib/state/paths";
import {
  createScaffoldCliFixture, runScaffoldFixtureProcess, scaffoldFixtureMissingTemplate, scaffoldFixtureProjectId,
} from "./testing/scaffold-cli-fixture";

const caseId = "org.harness.read-only";
const oldTime = new Date("2000-01-01T00:00:00Z");

function metadata(stat: BigIntStats) {
  return {
    identity: `${stat.dev}:${stat.ino}`,
    mode: stat.mode, links: stat.nlink, mtime: stat.mtimeNs, ctime: stat.ctimeNs,
  };
}

type Entry = ReturnType<typeof metadata> & { kind: "directory" | "file"; sha256: string | null };
type Inventory = Map<string, Entry>;

function snapshot(root: string, operation: string, mode: "full" | "metadata-only" = "full"): Inventory {
  const entries: Inventory = new Map();
  function visit(path: string) {
    const file = join(root, path);
    let children: string[] = [];
    let entry: Entry;
    try {
      const stat = lstatSync(file, { bigint: true });
      if (stat.ino === 0n || stat.isSymbolicLink()) throw new Error("unverified identity");
      const observed = metadata(stat);
      if (stat.isDirectory()) {
        children = readdirSync(file).sort();
        entry = { ...observed, kind: "directory", sha256: null };
      } else if (stat.isFile() && stat.nlink === 1n) {
        entry = { ...observed, kind: "file", sha256: mode === "full" ? hash(readFileSync(file)) : null };
      } else {
        throw new Error("unsupported entry");
      }
    } catch {
      throw new Error(`${caseId} ${operation}: inventory unavailable at ${path}`);
    }
    entries.set(path, entry);
    for (const child of children) visit(posix.join(path, child));
    try {
      const { kind: _kind, sha256: _sha256, ...observed } = entry;
      if (!isDeepStrictEqual(metadata(lstatSync(file, { bigint: true })), observed)) {
        throw new Error("unstable metadata");
      }
    } catch {
      throw new Error(`${caseId} ${operation}: inventory unstable at ${path}`);
    }
  }
  visit(".");
  return entries;
}

function assertUnchanged(before: Inventory, after: Inventory, operation: string) {
  const changes: string[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const original = before.get(path);
    const current = after.get(path);
    if (!original || !current) {
      changes.push(`${path}: ${original ? "removed" : "added"}`);
      continue;
    }
    const fields = (Object.keys(original) as (keyof Entry)[]).filter((field) => original[field] !== current[field]);
    if (fields.length) changes.push(`${path}: ${fields.join(", ")}`);
  }
  if (changes.length) throw new Error(`${caseId} ${operation}: fixture changed\n${changes.join("\n")}`);
}

function baseline(root: string): Inventory {
  for (const path of [...snapshot(root, "setup", "metadata-only").keys()].reverse()) {
    try {
      utimesSync(join(root, path), oldTime, oldTime);
    } catch {
      throw new Error(`${caseId} setup: unable to seed timestamps at ${path}`);
    }
  }
  return snapshot(root, "baseline");
}

function observeWithoutChanges<T>(root: string, before: Inventory, operation: string, observe: () => T): T {
  try {
    return observe();
  } catch {
    throw new Error(`${caseId} ${operation}: observation unavailable`);
  } finally {
    assertUnchanged(before, snapshot(root, operation), operation);
  }
}

it(`${caseId} preserves the owned fixture after Doctor and scaffold preview independently`, () => {
  const fixture = createScaffoldCliFixture();
  try {
    const before = baseline(fixture.root);
    assert(!before.has("state"), `${caseId} setup: isolated state must start absent`);
    const pinned = before.get(`control/${scaffoldFixtureMissingTemplate}`)?.sha256;
    assert(pinned, `${caseId} setup: canonical template unavailable`);

    const result = observeWithoutChanges(fixture.root, before, "Doctor", () => createHarnessService(fixture.control, {
      policy: new PolicyService(fixture.control, { environment: fixture.environment }),
      clock: () => oldTime,
      statePath: harnessProfilesPath(fixture.state),
    }).read(scaffoldFixtureProjectId));
    const { observation, saved } = result;
    assert(saved === null && observation.project_id === scaffoldFixtureProjectId
      && observation.canonical_version === "surtec-h1-h4-v1" && observation.source_fingerprint
      && observation.entries.some(({ path, status }) => path === scaffoldFixtureMissingTemplate && status === "missing"),
    `${caseId} Doctor: expected trusted observation and absent template`);

    const preview = observeWithoutChanges(fixture.root, before, "preview", () =>
      runScaffoldFixtureProcess(fixture, ["preview", scaffoldFixtureProjectId, "personal@1"]));
    assert(!preview.error && !preview.signal && preview.status === 0 && preview.stderr === "",
      `${caseId} preview: expected successful scaffold CLI response`);
    let plan: ReturnType<typeof previewRegisteredScaffold>;
    try {
      plan = JSON.parse(preview.stdout);
    } catch {
      throw new Error(`${caseId} preview: invalid CLI response`);
    }
    assert(plan?.status === "available" && plan.project_id === scaffoldFixtureProjectId
      && plan.execution_authority === "none" && plan.additions?.length === 1
      && plan.additions[0].path === scaffoldFixtureMissingTemplate && plan.additions[0].sha256 === pinned
      && plan.doctor?.project_fingerprint === observation.project_fingerprint,
    `${caseId} preview: expected pinned addition and matching Doctor observation`);
  } finally {
    fixture.dispose();
  }
});

it(`${caseId} detects persistent and metadata-only fixture mutations`, () => {
  const fixture = createScaffoldCliFixture();
  try {
    let before = baseline(fixture.root);
    writeFileSync(join(fixture.root, "unexpected.txt"), "synthetic", { flag: "wx" });
    let after = snapshot(fixture.root, "creation control");
    expect(() => assertUnchanged(before, after, "creation control")).toThrow("unexpected.txt: added");

    before = after;
    const readme = join(fixture.target, "README.md");
    const readmePath = `projects/${scaffoldFixtureProjectId}/README.md`;
    writeFileSync(readme, readFileSync(readme));
    after = snapshot(fixture.root, "same-byte overwrite control");
    expect(after.get(readmePath)?.sha256).toBe(before.get(readmePath)?.sha256);
    expect(() => assertUnchanged(before, after, "same-byte overwrite control"))
      .toThrow(`${readmePath}: mtime`);

    before = after;
    const temporary = join(fixture.target, ".agents/templates", "temporary.txt");
    writeFileSync(temporary, "synthetic", { flag: "wx" });
    unlinkSync(temporary);
    after = snapshot(fixture.root, "transient file control");
    expect([...after.keys()]).toEqual([...before.keys()]);
    expect(() => assertUnchanged(before, after, "transient file control"))
      .toThrow(`projects/${scaffoldFixtureProjectId}/.agents/templates: mtime`);
  } finally {
    fixture.dispose();
  }
});
