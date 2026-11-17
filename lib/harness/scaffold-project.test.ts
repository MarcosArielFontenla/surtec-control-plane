import { execFileSync } from "node:child_process";
import {
  lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { PolicyService } from "../policy/service";
import { localGitEnvironment } from "../security/environment";
import { scaffoldDirectoryIdentity } from "./scaffold-files";
import { previewRegisteredScaffold } from "./scaffold-project";
import { hash, loadHarnessSource } from "./source";

const repoRoot = resolve(".");
const projectId = "fixture";
const templateParent = ".agents/templates";
const spec = `${templateParent}/entity.spec.yaml`;
const tasks = `${templateParent}/feature.tasks.md`;
const junction = process.platform === "win32" ? "junction" : "dir";
const roots: { parent: string; root: string; identity: string }[] = [];

afterEach(() => {
  for (const { parent, root, identity } of roots.splice(0)) {
    if (dirname(root) !== parent || scaffoldDirectoryIdentity(root) !== identity) throw new Error("Fixture root changed");
    rmSync(root, { recursive: true });
    expect(lstatSync(root, { throwIfNoEntry: false })).toBeUndefined();
  }
});

function write(root: string, path: string, bytes: Buffer | string) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", [
    "-C", root, "-c", "user.name=Scaffold Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "core.autocrlf=false", "-c", "commit.gpgSign=false", ...args,
  ], {
    env: { ...localGitEnvironment(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "fixture-git-config") },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  }).trim();
}

function fixture() {
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, "surtec-scaffold-project-"));
  roots.push({ parent, root, identity: scaffoldDirectoryIdentity(root) });
  const control = join(root, "control");
  const projects = join(root, "projects");
  const target = join(projects, projectId);
  mkdirSync(join(target, templateParent), { recursive: true });
  write(target, "README.md", "Baseline fixture\n");
  git(target, "init", "--template=", "-b", "main");
  git(target, "add", "--", "README.md");
  git(target, "commit", "-m", "Fixture baseline");

  const checked = loadHarnessSource(repoRoot);
  if (checked.status !== "trusted" || !checked.registry || !checked.manifest) throw new Error("Reviewed source fixture unavailable");
  for (const { path } of checked.manifest.expected_entries) {
    write(control, path, readFileSync(resolve(repoRoot, checked.registry.source.root, path)));
  }
  write(control, checked.registry.source.manifest, readFileSync(join(repoRoot, checked.registry.source.manifest)));
  write(control, "registry/project-archetypes.yml", readFileSync(join(repoRoot, "registry/project-archetypes.yml")));
  write(control, "registry/harness-sources.yml", stringify({ ...checked.registry, source: { ...checked.registry.source, root: "." }, projects: {} }));
  write(control, "registry/agents.yml", "agents: []\n");
  write(control, "registry/projects.yml", stringify({ projects: { [projectId]: {} } }));
  const policy = new PolicyService(control, { environment: { SURTEC_PROJECTS_ROOT: projects } });
  return { root, control, projects, target, policy };
}

function inventory(root: string) {
  return readdirSync(root, { recursive: true, encoding: "utf8" }).sort().map((path) => {
    const file = join(root, path);
    const stat = lstatSync(file);
    return [path, stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : hash(readFileSync(file))];
  });
}

type Fixture = ReturnType<typeof fixture>;

function preview(f: Fixture, selection: unknown = "personal@1", id = projectId) {
  return previewRegisteredScaffold(f.control, { projectId: id, selection }, f.policy);
}

function available(f: Fixture) {
  const result = preview(f);
  expect(result.status).toBe("available");
  if (result.status !== "available") throw new Error("Expected an available project plan");
  return result;
}

describe("registered scaffold preview", () => {
  it("binds the registered writable location while keeping the checkout, index, and source inventory read-only", () => {
    const f = fixture();
    write(f.target, "README.md", "Unrelated working edit\n");
    write(f.target, "AGENTS.md", "Private synthetic project instructions\n");
    const before = inventory(f.root);
    const result = available(f);
    expect(result).toMatchObject({
      project_id: projectId, archetype: { id: "personal@1" }, git: {
        branch: "refs/heads/main", head: git(f.target, "rev-parse", "HEAD"),
        index_sha256: hash(readFileSync(join(f.target, ".git/index"))),
      },
      doctor: { status: "legacy", validation: { status: "unknown" } },
      backup: { paths: [] }, execution_authority: "none",
    });
    expect(result.additions).toEqual([spec, tasks].map((path) => {
      const bytes = readFileSync(join(f.control, path));
      return { path, preimage: "absent", sha256: hash(bytes), text: bytes.toString("utf8") };
    }));
    expect(result.entries.find((entry) => entry.path === "AGENTS.md")).toMatchObject({ decision: "manual-migration-required" });
    expect(available(f)).toEqual(result);
    expect(inventory(f.root)).toEqual(before);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(JSON.stringify(f.root).slice(1, -1));
    expect(serialized).not.toContain("Private synthetic project instructions");
  });

  it("excludes a working-tree deletion and a Git-ignored destination from effects and rollback", () => {
    const f = fixture();
    write(f.target, spec, "Previously tracked content");
    git(f.target, "add", "--", spec);
    git(f.target, "commit", "-m", "Tracked fixture template");
    unlinkSync(join(f.target, spec));
    write(f.target, ".gitignore", `/${tasks}\n`);
    const before = inventory(f.root);
    const result = available(f);
    expect(result.entries).toMatchObject([
      { path: spec, decision: "safe-addition", git_exclusion: "index-entry" },
      { path: tasks, decision: "safe-addition", git_exclusion: "ignored" },
      { path: "AGENTS.md", decision: "manual-migration-required", git_exclusion: null },
    ]);
    expect(result.additions).toEqual([]);
    expect(result.rollback.additions).toEqual([]);
    expect(result.routing.added_physical_lines).toBe(0);
    expect(inventory(f.root)).toEqual(before);
  });

  it("preserves a staged deletion still present in HEAD and plans only the other addition", () => {
    const f = fixture();
    write(f.target, spec, "Tracked fixture template");
    git(f.target, "add", "--", spec);
    git(f.target, "commit", "-m", "Tracked fixture template");
    git(f.target, "rm", "--cached", "--", spec);
    unlinkSync(join(f.target, spec));
    const result = available(f);
    expect(result.entries[0]).toMatchObject({ path: spec, git_exclusion: "head-entry" });
    expect(result.additions.map(({ path }) => path)).toEqual([tasks]);
    expect(result.rollback.additions.map(({ path }) => path)).toEqual([tasks]);
  });

  it("excludes differently cased index entries with absent working-tree bytes", () => {
    const f = fixture();
    const alias = `${templateParent}/Entity.Spec.Yaml`;
    write(f.target, alias, "Staged fixture content");
    git(f.target, "add", "--", alias);
    unlinkSync(join(f.target, alias));
    const result = available(f);
    expect(result.entries[0]).toMatchObject({ path: spec, git_exclusion: "index-entry" });
    expect(result.additions.map(({ path }) => path)).toEqual([tasks]);
  });

  it("excludes template paths below a tracked parent that was replaced locally by a directory", () => {
    const f = fixture();
    renameSync(join(f.target, ".agents"), join(f.root, "original-agents"));
    write(f.target, ".agents", "Tracked parent");
    git(f.target, "add", "--", ".agents");
    git(f.target, "commit", "-m", "Tracked parent fixture");
    unlinkSync(join(f.target, ".agents"));
    mkdirSync(join(f.target, templateParent), { recursive: true });
    const before = inventory(f.root);
    const result = available(f);
    expect(result.entries.slice(0, 2)).toMatchObject([{ git_exclusion: "index-entry" }, { git_exclusion: "index-entry" }]);
    expect(result.additions).toEqual([]);
    expect(inventory(f.root)).toEqual(before);
  });

  it("binds branch, index, and physical destination parent changes independently", () => {
    const f = fixture();
    const first = available(f);
    git(f.target, "symbolic-ref", "HEAD", "refs/heads/renamed");
    git(f.target, "update-ref", "refs/heads/renamed", first.git.head);
    const branch = available(f);
    expect(branch.git.head).toBe(first.git.head);
    expect(branch.apply_digest).not.toBe(first.apply_digest);
    write(f.target, "README.md", "Staged elsewhere\n");
    git(f.target, "add", "--", "README.md");
    const index = available(f);
    expect(index.git.index_sha256).not.toBe(branch.git.index_sha256);
    expect(index.apply_digest).not.toBe(branch.apply_digest);
    renameSync(join(f.target, templateParent), join(f.root, "old-templates"));
    mkdirSync(join(f.target, templateParent));
    const parent = available(f);
    expect(parent.git.template_parent_fingerprint).not.toBe(index.git.template_parent_fingerprint);
    expect(parent.apply_digest).not.toBe(index.apply_digest);
  });

  it("binds observed HEAD changes even when the scaffold paths and index bytes are identical", () => {
    const f = fixture();
    const first = available(f);
    const commit = git(f.target, "commit-tree", git(f.target, "rev-parse", "HEAD^{tree}"), "-p", first.git.head, "-m", "Second fixture HEAD");
    git(f.target, "update-ref", "HEAD", commit);
    const next = available(f);
    expect(next.git.head).toBe(commit);
    expect(next.git.index_sha256).toBe(first.git.index_sha256);
    expect(next.scaffold_fingerprint).toBe(first.scaffold_fingerprint);
    expect(next.apply_digest).not.toBe(first.apply_digest);
  });

  it("requires a registered project and explicit archetype selection", () => {
    const f = fixture();
    expect(preview(f, "personal@1", "unknown")).toMatchObject({ status: "unavailable", reason: "project-unavailable" });
    expect(preview(f, "personal@1", "../outside")).toMatchObject({ status: "unavailable", reason: "project-unavailable" });
    expect(preview(f, "personal")).toMatchObject({ status: "unavailable", reason: "archetype-unavailable" });
  });

  it.each(["index.lock", "MERGE_HEAD", "rebase-merge", "commondir"])("refuses when .git/%s is present", (name) => {
    const f = fixture();
    write(f.target, `.git/${name}`, "Synthetic marker");
    const before = inventory(f.root);
    expect(preview(f)).toEqual({ status: "unavailable", reason: "checkout-unavailable", execution_authority: "none" });
    expect(inventory(f.root)).toEqual(before);
  });

  it("refuses redirected Git worktree coordinates and nested Git roots", () => {
    const f = fixture();
    git(f.target, "config", "core.worktree", f.projects);
    const before = inventory(f.root);
    expect(preview(f)).toMatchObject({ status: "unavailable", reason: "checkout-unavailable" });
    expect(inventory(f.root)).toEqual(before);
    git(f.target, "config", "--unset", "core.worktree");
    mkdirSync(join(f.target, templateParent, ".git"));
    expect(preview(f)).toMatchObject({ status: "unavailable", reason: "checkout-unavailable" });
  });

  it("refuses missing and redirected template parents without reading through the link", () => {
    const f = fixture();
    const outside = join(f.root, "exported-templates");
    const destination = join(f.target, templateParent);
    renameSync(destination, outside);
    expect(preview(f)).toMatchObject({ status: "unavailable", reason: "checkout-unavailable" });
    write(outside, "entity.spec.yaml", "Outside fixture content");
    symlinkSync(outside, destination, junction);
    const before = inventory(f.root);
    const result = preview(f);
    expect(result).toMatchObject({ status: "unavailable", reason: "checkout-unavailable" });
    expect(JSON.stringify(result)).not.toContain("Outside fixture content");
    expect(inventory(f.root)).toEqual(before);
  });
});
