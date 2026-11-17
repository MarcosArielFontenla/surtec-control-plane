import { execFileSync, spawnSync } from "node:child_process";
import {
  linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { createGitFixtureBaselines } from "../../runner/testing/git-fixture";
import { PolicyService } from "../policy/service";
import { localGitEnvironment } from "../security/environment";
import { readScaffoldOperation, withScaffoldOperationStore, type ScaffoldCheckpoint } from "../state/harness-scaffold-operations";
import { acquireMaintenanceParticipant, releaseMaintenanceParticipant } from "../state/maintenance";
import { scaffoldOperationsDir } from "../state/paths";
import { scaffoldDirectoryIdentity, scaffoldStagePath } from "./scaffold-files";
import { createScaffoldOperationService } from "./scaffold-operation";
import { hash, loadHarnessSource } from "./source";
import type { HarnessManifest, HarnessSourceRegistry } from "./types";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, linkSync: vi.fn(fs.linkSync), renameSync: vi.fn(fs.renameSync), unlinkSync: vi.fn(fs.unlinkSync) };
});
vi.mock("node:child_process", async (importOriginal) => {
  const childProcess = await importOriginal<typeof import("node:child_process")>();
  return { ...childProcess, spawnSync: vi.fn(childProcess.spawnSync) };
});

const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
const childProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const baseline = createGitFixtureBaselines();
const repoRoot = resolve(".");
const spec = ".agents/templates/entity.spec.yaml";
const tasks = ".agents/templates/feature.tasks.md";
const input = { projectId: "fixture", selection: "personal@1" };
const roots: { root: string; parent: string; identity: string }[] = [];
const yesApply = (plan: { apply_digest: string }) => ({ digest: plan.apply_digest, exclusive: true });
const yesRollback = (plan: { rollback_digest: string }) => ({ digest: plan.rollback_digest, exclusive: true });

afterEach(() => {
  vi.mocked(spawnSync).mockReset();
  vi.mocked(linkSync).mockReset();
  vi.mocked(renameSync).mockReset();
  vi.mocked(unlinkSync).mockReset();
  for (const { root, parent, identity } of roots.splice(0)) {
    if (dirname(root) !== parent || scaffoldDirectoryIdentity(root) !== identity) throw new Error("Unverified fixture root");
    rmSync(root, { recursive: true });
    expect(lstatSync(root, { throwIfNoEntry: false })).toBeUndefined();
  }
});
afterAll(() => baseline.dispose());

function write(root: string, path: string, bytes: Buffer | string) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", [
    "-C", cwd, "-c", "user.name=Scaffold Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "core.autocrlf=false", "-c", "commit.gpgSign=false", ...args,
  ], { env: { ...localGitEnvironment(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(cwd, "fixture-git-config") },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
}

function reuseFixtureGitReads(target: string) {
  const cache = new Map<string, ReturnType<typeof spawnSync>>();
  // The fault fixtures keep a single local branch and complete index. Reuse only successful
  // Git observations of unchanged, fixture-owned metadata. Ignore checks stay live.
  const anchors = [".git/HEAD", ".git/refs/heads/main", ".git/config", ".git/index"];
  vi.mocked(spawnSync).mockImplementation((command, args, options) => {
    const cwd = args?.indexOf("-C") ?? -1;
    if (command !== "git" || cwd < 0 || args?.[cwd + 1] !== target || args?.includes("check-ignore")) {
      return childProcess.spawnSync(command, args, options);
    }
    const fingerprints = anchors.map((path) => hash(readFileSync(join(target, path))));
    const key = JSON.stringify([args, fingerprints]);
    const saved = cache.get(key);
    if (saved) return saved;
    const observed = childProcess.spawnSync(command, args, options);
    if (observed.status === 0 && !observed.error) cache.set(key, observed);
    return observed;
  });
}

function fixture(oneAddition = false, liveGit = false) {
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, "surtec-scaffold-operation-"));
  roots.push({ root, parent, identity: scaffoldDirectoryIdentity(root) });
  const control = join(root, "control");
  const projects = join(root, "projects");
  const target = join(projects, "fixture");
  const state = join(root, "state");
  const files = { "README.md": "# Synthetic baseline\n" };
  write(target, "README.md", files["README.md"]);
  baseline.attach({ caseRoot: root, repository: target, key: "scaffold", files, initialize({ repository }) {
    git(repository, "init", "--template=", "-b", "main");
    git(repository, "config", "user.name", "Scaffold Fixture");
    git(repository, "config", "user.email", "fixture@example.invalid");
    git(repository, "add", "--", "README.md");
    git(repository, "commit", "-m", "Synthetic baseline");
  } });
  write(target, "AGENTS.md", "# Preserve these synthetic project instructions\n");
  write(target, ".agents/templates/user.md", "Preserved working bytes");
  const reviewed = loadHarnessSource(repoRoot);
  if (!reviewed.manifest || !reviewed.registry) throw new Error("Reviewed Harness fixture unavailable");
  for (const { path } of reviewed.manifest.expected_entries) {
    write(control, path, readFileSync(resolve(repoRoot, reviewed.registry.source.root, path)));
  }
  const sourcePath = "registry/harness-sources.yml";
  const manifestPath = reviewed.registry.source.manifest;
  write(control, manifestPath, readFileSync(join(repoRoot, manifestPath)));
  write(control, "registry/project-archetypes.yml", readFileSync(join(repoRoot, "registry/project-archetypes.yml")));
  write(control, sourcePath, stringify({ ...reviewed.registry, source: { ...reviewed.registry.source, root: "." }, projects: {} }));
  write(control, "registry/agents.yml", "agents: []\n");
  write(control, "registry/projects.yml", "projects:\n  fixture: {}\n");
  if (oneAddition) write(target, tasks, readFileSync(join(control, tasks)));
  if (!liveGit) reuseFixtureGitReads(target);
  const policy = new PolicyService(control, { environment: { SURTEC_PROJECTS_ROOT: projects } });
  const service = createScaffoldOperationService(control, state, policy);
  return { root, control, target, state, service, manifestPath, sourcePath };
}

function inventory(root: string) {
  return readdirSync(root, { recursive: true, encoding: "utf8" }).sort().map((path) => {
    const file = join(root, path);
    const stat = lstatSync(file);
    return [path, stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : hash(readFileSync(file))];
  });
}

type Fixture = ReturnType<typeof fixture>;
function record(f: Fixture, id: string) {
  const value = readScaffoldOperation(f.state, id);
  if (!value) throw new Error("Expected the operation record");
  return value.record;
}

async function applied(f: Fixture) {
  const result = await f.service.apply(input, yesApply);
  expect(result).toMatchObject({ status: "applied", verification: { result: "passed", doctor_validation: "unknown" } });
  if (!result.operation_id) throw new Error("Expected an operation ID");
  return result.operation_id;
}

function faultCheckpoint(match: (checkpoint: ScaffoldCheckpoint | undefined) => boolean, effect?: () => void) {
  let injected = false;
  vi.mocked(renameSync).mockImplementation((source, destination) => {
    if (!injected && basename(String(destination)) === "record.json") {
      const snapshot = JSON.parse(readFileSync(source, "utf8")) as { checkpoints: ScaffoldCheckpoint[] };
      if (match(snapshot.checkpoints.at(-1))) {
        injected = true;
        if (!effect) throw new Error("Synthetic checkpoint replacement failure");
        effect();
      }
    }
    fs.renameSync(source, destination);
  });
}

describe("scaffold operation service", () => {
  describe("count-truncated checkout", () => {
    let f: Fixture;
    let before: ReturnType<typeof inventory>;
    let id: string;

    beforeEach(async () => {
      f = fixture(true);
      const directory = join(f.target, ".agents/zz-fixture");
      mkdirSync(directory, { recursive: true });
      for (let index = 0; index < 130; index++) writeFileSync(join(directory, `fixture-${index}.txt`), "fixture");
      before = inventory(f.target);
      const apply = await f.service.apply(input, (plan) => {
        expect(plan.doctor).toMatchObject({ inventory_coverage: "partial", inventory_limit: "entry-count" });
        expect(plan.additions.map(({ path }) => path)).toEqual([spec]);
        return yesApply(plan);
      });
      expect(apply).toMatchObject({ status: "applied", verification: { result: "passed", doctor_validation: "unknown" } });
      if (!apply.operation_id) throw new Error("Expected an operation ID");
      id = apply.operation_id;
    });

    it("rolls back only after a confirmation distinct from apply", async () => {
      const digest = record(f, id).preimage.apply_digest;
      expect(await f.service.rollback(id, () => ({ digest, exclusive: true }))).toMatchObject({ status: "refused", reason: "not-approved" });
      expect(readFileSync(join(f.target, spec))).toEqual(readFileSync(join(f.control, spec)));
      expect(await f.service.rollback(id, yesRollback)).toMatchObject({ status: "rolled-back" });
      expect(inventory(f.target)).toEqual(before);
    });
  });

  it("applies exact bytes, verifies with Doctor, and leaves read-only status and repeated apply effect-free", async () => {
    const f = fixture(false, true);
    const before = inventory(f.target);
    const control = inventory(f.control);
    const result = await f.service.apply(input, (plan) => {
      expect(plan.additions.map(({ path }) => path)).toEqual([spec, tasks]);
      expect(inventory(f.target)).toEqual(before);
      return yesApply(plan);
    });
    expect(result).toMatchObject({ status: "applied", verification: { result: "passed", doctor_validation: "unknown" } });
    if (!result.operation_id) throw new Error("Expected an operation ID");
    const id = result.operation_id;
    expect(inventory(f.target).filter(([entry]) => ![spec, tasks].includes(entry.replaceAll("\\", "/")))).toEqual(before);
    for (const path of [spec, tasks]) {
      expect(readFileSync(join(f.target, path))).toEqual(readFileSync(join(f.control, path)));
      expect(lstatSync(join(f.target, path)).nlink).toBe(1);
    }
    const loaded = record(f, id);
    const state = inventory(f.state);
    expect(f.service.status(id)).toMatchObject({ status: "applied", revision: loaded.revision, paths: [{ action: "remove" }, { action: "remove" }] });
    expect(inventory(f.state)).toEqual(state);
    expect(await f.service.apply(input, () => { throw new Error("No-op must not prompt"); })).toMatchObject({ status: "no-op" });
    expect(inventory(f.state)).toEqual(state);
    expect(inventory(f.control)).toEqual(control);
  });

  it("binds rollback approval separately from the apply digest", async () => {
    const f = fixture(true);
    const id = await applied(f);
    const digest = record(f, id).preimage.apply_digest;
    const before = inventory(f.target);
    const state = inventory(f.state);
    const confirm = vi.fn(() => ({ digest, exclusive: true }));
    expect(await f.service.rollback(id, confirm)).toMatchObject({ status: "refused", reason: "not-approved" });
    expect(confirm).toHaveBeenCalledOnce();
    expect(inventory(f.target)).toEqual(before);
    expect(inventory(f.state)).toEqual(state);
  });

  it("verifies rollback of exactly the two additions while preserving the original inventory", async () => {
    const f = fixture();
    const before = inventory(f.target);
    const id = await applied(f);
    expect(await f.service.rollback(id, yesRollback)).toMatchObject({ status: "rolled-back" });
    expect(inventory(f.target)).toEqual(before);
    expect(f.service.status(id)).toMatchObject({ status: "rolled-back", paths: [{ action: "verified-absence" }, { action: "verified-absence" }] });
  });

  it("makes repeated rollback effect-free once absence is verified", async () => {
    const f = fixture(true);
    const id = await applied(f);
    expect(await f.service.rollback(id, yesRollback)).toMatchObject({ status: "rolled-back" });
    const before = inventory(f.target);
    const state = inventory(f.state);
    const repeated = vi.fn(yesRollback);
    expect(await f.service.rollback(id, repeated)).toMatchObject({ status: "no-op" });
    expect(repeated).not.toHaveBeenCalled();
    expect(inventory(f.target)).toEqual(before);
    expect(inventory(f.state)).toEqual(state);
  });

  it("refuses a stale approval, missing exclusive attestation and a busy maintenance boundary", async () => {
    const f = fixture();
    expect(await f.service.apply(input, (plan) => ({ digest: plan.apply_digest, exclusive: false }))).toMatchObject({ reason: "not-approved" });
    const participant = acquireMaintenanceParticipant(f.state, "worker");
    try { expect(await f.service.apply(input, yesApply)).toMatchObject({ reason: "busy" }); }
    finally { releaseMaintenanceParticipant(participant); }
    expect(await f.service.apply(input, (plan) => {
      write(f.target, spec, "Created during operator review");
      return yesApply(plan);
    })).toMatchObject({ status: "refused", reason: "stale-preview" });
    expect(readFileSync(join(f.target, spec), "utf8")).toBe("Created during operator review");
    expect(lstatSync(join(f.target, tasks), { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(scaffoldOperationsDir(f.state), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("protects a destination that appears immediately before the exclusive publication", async () => {
    const f = fixture(true);
    vi.mocked(linkSync).mockImplementationOnce((source, destination) => {
      fs.writeFileSync(destination, "Foreign collision");
      fs.linkSync(source, destination);
    });
    const result = await f.service.apply(input, yesApply);
    expect(result.status).toBe("needs-review");
    if (!result.operation_id) throw new Error("Expected an operation ID");
    expect(readFileSync(join(f.target, spec), "utf8")).toBe("Foreign collision");
    expect(record(f, result.operation_id).checkpoints.map(({ kind }) => kind)).toEqual(["stage-intent", "staged"]);
    expect(lstatSync(join(f.target, scaffoldStagePath(result.operation_id, spec)), { throwIfNoEntry: false })).toBeUndefined();
    expect(f.service.status(result.operation_id)).toMatchObject({ status: "needs-review", rollback: null });
    const confirm = vi.fn(yesRollback);
    expect(await f.service.rollback(result.operation_id, confirm)).toMatchObject({ status: "needs-review" });
    expect(confirm).not.toHaveBeenCalled();
  });

  async function partialApply(f: Fixture) {
    vi.mocked(linkSync).mockImplementation((source, destination) => {
      if (destination === join(f.target, tasks)) throw new Error("Synthetic second publication failure");
      fs.linkSync(source, destination);
    });
    const result = await f.service.apply(input, yesApply);
    expect(result.status).toBe("needs-review");
    if (!result.operation_id) throw new Error("Expected an operation ID");
    return result.operation_id;
  }

  it("retains partial publication and refuses to replay the missing addition", async () => {
    const f = fixture();
    const id = await partialApply(f);
    expect(f.service.status(id)).toMatchObject({ status: "needs-review", paths: [{ action: "remove" }, { action: "already-absent" }] });
    expect(await f.service.apply(input, yesApply)).toMatchObject({ status: "needs-review", operation_id: id });
    expect(readdirSync(scaffoldOperationsDir(f.state))).toEqual([id]);
  });

  it("rolls back partial publication with original evidence", async () => {
    const f = fixture();
    const before = inventory(f.target);
    const id = await partialApply(f);
    expect(await f.service.rollback(id, yesRollback)).toMatchObject({ status: "rolled-back" });
    expect(inventory(f.target)).toEqual(before);
  });

  it("recovers publication evidence after the stage is gone and the publication checkpoint fails", async () => {
    const f = fixture(true);
    const before = inventory(f.target);
    faultCheckpoint((point) => point?.kind === "published");
    const result = await f.service.apply(input, yesApply);
    expect(result.status).toBe("needs-review");
    if (!result.operation_id) throw new Error("Expected an operation ID");
    const id = result.operation_id;
    expect(record(f, id).checkpoints.map(({ kind }) => kind)).toEqual(["stage-intent", "staged"]);
    expect(f.service.status(id)).toMatchObject({ status: "needs-review", paths: [{ action: "remove", recovered: true }] });
    expect(record(f, id).checkpoints).toHaveLength(2);
    expect(await f.service.rollback(id, yesRollback)).toMatchObject({ status: "rolled-back" });
    expect(record(f, id).checkpoints.map(({ kind }) => kind)).toEqual(["stage-intent", "staged", "published", "rollback-approved", "rollback-intent", "absence-observed"]);
    expect(inventory(f.target)).toEqual(before);
  });

  it("preserves both names and refuses rollback when interrupted with two physical links", async () => {
    const f = fixture(true);
    vi.mocked(linkSync).mockImplementationOnce((source, destination) => {
      fs.linkSync(source, destination);
      throw new Error("Synthetic interruption after link creation");
    });
    const result = await f.service.apply(input, yesApply);
    expect(result.status).toBe("needs-review");
    if (!result.operation_id) throw new Error("Expected an operation ID");
    const id = result.operation_id;
    const staged = join(f.target, scaffoldStagePath(id, spec));
    expect(lstatSync(staged).nlink).toBe(2);
    expect(readFileSync(staged)).toEqual(readFileSync(join(f.target, spec)));
    const before = inventory(f.target);
    const confirm = vi.fn(yesRollback);
    expect(f.service.status(id)).toMatchObject({ status: "needs-review" });
    expect(await f.service.rollback(id, confirm)).toMatchObject({ status: "needs-review" });
    expect(confirm).not.toHaveBeenCalled();
    expect(inventory(f.target)).toEqual(before);
  });

  it("records verification failure when an inspected path drifts after publication", async () => {
    const f = fixture(true);
    faultCheckpoint((point) => point?.kind === "published", () => write(f.target, "AGENTS.md", "Changed after publication"));
    const result = await f.service.apply(input, yesApply);
    expect(result).toMatchObject({ status: "needs-review", verification: { result: "failed", doctor_validation: "unknown" } });
    expect(readFileSync(join(f.target, "AGENTS.md"), "utf8")).toBe("Changed after publication");
    expect(readFileSync(join(f.target, spec))).toEqual(readFileSync(join(f.control, spec)));
  });

  it.each(["edited", "same-byte replacement", "staged", "new ownership"])("refuses rollback of a %s addition", async (fault) => {
    const f = fixture(true);
    const id = await applied(f);
    const path = join(f.target, spec);
    if (fault === "edited") writeFileSync(path, "Operator content");
    else if (fault === "same-byte replacement") {
      const replacement = join(f.root, "replacement");
      writeFileSync(replacement, readFileSync(path));
      fs.renameSync(path, join(f.root, "original"));
      fs.renameSync(replacement, path);
    } else if (fault === "staged") git(f.target, "add", "--", spec);
    else {
      const registry: HarnessSourceRegistry = parse(readFileSync(join(f.control, f.sourcePath), "utf8"));
      registry.projects.fixture = {
        ownership: [{ path: spec, classification: "user-owned", evidence: "Synthetic later owner declaration" }],
        testing_policy: { schema_version: 1, mode: "functional", runner_id: null, requires_red_evidence: false, applicable_task_kinds: [] },
        review_policy: "unknown", backup_ready: false, rollback_ready: false, validation: null,
      };
      write(f.control, f.sourcePath, stringify(registry));
    }
    const before = inventory(f.target);
    const confirm = vi.fn(yesRollback);
    expect(await f.service.rollback(id, confirm)).toMatchObject({ status: "needs-review" });
    expect(confirm).not.toHaveBeenCalled();
    expect(inventory(f.target)).toEqual(before);
  });

  it("refuses all removals if a file changes after the separate rollback offer", async () => {
    const f = fixture();
    const id = await applied(f);
    const before = readFileSync(join(f.target, spec));
    const result = await f.service.rollback(id, (plan) => {
      write(f.target, tasks, "Changed while reviewing rollback");
      return yesRollback(plan);
    });
    expect(result).toMatchObject({ status: "refused", reason: "stale-preview" });
    expect(readFileSync(join(f.target, spec))).toEqual(before);
    expect(readFileSync(join(f.target, tasks), "utf8")).toBe("Changed while reviewing rollback");
    expect(record(f, id).checkpoints.some(({ kind }) => kind === "rollback-approved")).toBe(false);
  });

  it("reports absence after interruption following unlink without claiming that removal was recorded", async () => {
    const f = fixture(true);
    const before = inventory(f.target);
    const id = await applied(f);
    faultCheckpoint((point) => point?.kind === "absence-observed");
    expect(await f.service.rollback(id, yesRollback)).toMatchObject({ status: "needs-review" });
    expect(record(f, id).checkpoints.at(-1)).toMatchObject({ kind: "rollback-intent" });
    expect(f.service.status(id)).toMatchObject({ status: "needs-review", paths: [{ action: "already-absent" }] });
    expect(inventory(f.target)).toEqual(before);
  });

  it("records already-absent under a fresh approval after a retained rollback intent", async () => {
    const f = fixture(true);
    const before = inventory(f.target);
    const id = await applied(f);
    withScaffoldOperationStore(f.state, (writer) => {
      const current = record(f, id);
      const approved = writer.checkpoint(id, current.revision, {
        kind: "rollback-approved", rollback_digest: hash("synthetic first rollback"), paths: [spec],
      });
      writer.checkpoint(id, approved.revision, { kind: "rollback-intent", path: spec });
      fs.unlinkSync(join(f.target, spec));
    });
    expect(await f.service.rollback(id, yesRollback)).toMatchObject({ status: "rolled-back" });
    expect(record(f, id).checkpoints.at(-1)).toMatchObject({ kind: "absence-observed", outcome: "already-absent" });
    expect(inventory(f.target)).toEqual(before);
  });

  it("uses the original escrow across a later trusted canonical release", async () => {
    const f = fixture(true);
    const before = inventory(f.target);
    const id = await applied(f);
    const manifest: HarnessManifest = JSON.parse(readFileSync(join(f.control, f.manifestPath), "utf8"));
    const registry: HarnessSourceRegistry = parse(readFileSync(join(f.control, f.sourcePath), "utf8"));
    const newBytes = "New reviewed canonical template\n";
    manifest.harness_version = "fixture-r2";
    const pin = manifest.expected_entries.find(({ path }) => path === spec);
    if (!pin) throw new Error("Expected a pinned spec");
    pin.sha256 = hash(newBytes);
    const manifestBytes = JSON.stringify(manifest);
    registry.source.manifest_sha256 = hash(manifestBytes);
    write(f.control, spec, newBytes);
    write(f.control, f.manifestPath, manifestBytes);
    write(f.control, f.sourcePath, stringify(registry));
    expect(await f.service.rollback(id, yesRollback)).toMatchObject({ status: "rolled-back" });
    expect(inventory(f.target)).toEqual(before);
  });
});
