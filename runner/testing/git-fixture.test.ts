import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createGitFixtureBaselines } from "./git-fixture";
import { managedGitArgs } from "../../lib/security/managed-git.mjs";
import { localGitEnvironment } from "../../lib/security/environment";

const roots: string[] = [], factories: ReturnType<typeof createGitFixtureBaselines>[] = [];
function temporary() { const root = mkdtempSync(join(tmpdir(), "surtec-git-fixture-test-")); roots.push(root); return root; }
function factory() { const value = createGitFixtureBaselines(); factories.push(value); return value; }
function git(repository: string, root: string, args: string[]): string {
  return execFileSync("git", managedGitArgs(["-C", repository, ...args], root), { env: localGitEnvironment(), windowsHide: true, encoding: "utf8" }).trim();
}
const minimal = { "README.md": "hi\n" };
function initialize({ repository, root }: { repository: string; root: string }): void {
  git(repository, root, ["init", "-b", "main"]);
  git(repository, root, ["config", "user.email", "t@t.t"]);
  git(repository, root, ["config", "user.name", "t"]);
  git(repository, root, ["add", "-A"]);
  git(repository, root, ["commit", "-m", "init"]);
}
function working(files: Readonly<Record<string, string>> = minimal) {
  const caseRoot = temporary(), repository = join(caseRoot, "repository"); mkdirSync(repository);
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(repository, path)), { recursive: true }); writeFileSync(join(repository, path), text, { mode: 0o644 }); }
  return { caseRoot, repository };
}
function inventory(path: string, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(path).sort()) {
    const child = join(path, name), key = prefix ? `${prefix}/${name}` : name, stat = lstatSync(child);
    if (stat.isSymbolicLink()) result[key] = "link";
    else if (stat.isDirectory()) Object.assign(result, inventory(child, key));
    else result[key] = readFileSync(child).toString("base64");
  }
  return result;
}
afterEach(() => {
  for (const value of factories.splice(0).reverse()) value.dispose();
  for (const root of roots.splice(0).reverse()) { rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false); }
});

describe("private physical Git fixture baselines", () => {
  it("initializes once, attaches physical repositories and remains usable after seed disposal", () => {
    const baselines = factory(), first = working(), second = working(); let seed = "", calls = 0;
    const setup = (input: { repository: string; root: string }) => { calls++; seed = input.repository; initialize(input); };
    baselines.attach({ ...first, key: "minimal", files: minimal, initialize: setup });
    mkdirSync(join(second.repository, ".git"));
    baselines.attach({ ...second, key: "minimal", files: minimal, initialize: setup });
    expect(calls).toBe(1);
    for (const file of ["index", "config", "refs/heads/main", ...Object.keys(inventory(join(seed, ".git/objects"))).map((path) => `objects/${path}`)]) {
      const identities = [seed, first.repository, second.repository].map((repo) => lstatSync(join(repo, ".git", file)));
      expect(identities.every((stat) => stat.nlink === 1)).toBe(true);
      expect(new Set(identities.map((stat) => `${stat.dev}:${stat.ino}`)).size).toBe(3);
    }
    const trackedIdentities = [seed, first.repository, second.repository].map((repo) => lstatSync(join(repo, "README.md")));
    expect(trackedIdentities.every((stat) => stat.nlink === 1)).toBe(true);
    expect(new Set(trackedIdentities.map((stat) => `${stat.dev}:${stat.ino}`)).size).toBe(3);
    expect(resolve(git(first.repository, first.caseRoot, ["rev-parse", "--show-toplevel"]))).toBe(resolve(first.repository));
    expect(resolve(first.repository, git(first.repository, first.caseRoot, ["rev-parse", "--git-common-dir"]))).toBe(resolve(first.repository, ".git"));
    expect(git(first.repository, first.caseRoot, ["ls-files"])).toBe("README.md");
    baselines.dispose(); expect(existsSync(seed)).toBe(false);
    expect(git(second.repository, second.caseRoot, ["show", "HEAD:README.md"])).toBe("hi");
    expect(() => baselines.attach({ ...working(), key: "minimal", files: minimal, initialize })).toThrow(/disposed/);
  });
  it("keeps tracked bytes, index, objects, refs, config, hooks and worktrees private to each copy", () => {
    const baselines = factory(), first = working(), second = working(); let seed = "";
    baselines.attach({ ...first, key: "minimal", files: minimal, initialize: (input) => { seed = input.repository; initialize(input); } });
    baselines.attach({ ...second, key: "minimal", files: minimal, initialize });
    const beforeSeed = inventory(seed), beforeSecond = inventory(second.repository);
    writeFileSync(join(first.repository, "README.md"), "case-owned mutation\n");
    git(first.repository, first.caseRoot, ["add", "README.md"]); git(first.repository, first.caseRoot, ["commit", "-m", "private mutation"]);
    git(first.repository, first.caseRoot, ["config", "user.name", "Private case"]);
    writeFileSync(join(first.repository, ".git/hooks/case-hook"), "private case hook\n");
    git(first.repository, first.caseRoot, ["worktree", "add", "-b", "case-branch", join(first.caseRoot, "candidate")]);
    expect(inventory(second.repository)).toEqual(beforeSecond);
    expect(existsSync(join(second.repository, ".git/hooks/case-hook"))).toBe(false);
    expect(existsSync(join(second.repository, ".git/worktrees"))).toBe(false);
    expect(inventory(seed)).toEqual(beforeSeed);
  });
  it.each([{ value: 0, refactor: false }, { value: 0, refactor: true }, { value: 1, refactor: false }])("preserves exact project files for value=$value refactor=$refactor", ({ value, refactor }) => {
    const files: Record<string, string> = { "AGENTS.md": "SELECTED PROJECT RULE: do not publish.\n", "src/value.json": JSON.stringify({ value }), "verify.mjs": "process.exit(0);" };
    if (refactor) files["refactor.mjs"] = "process.exit(0)";
    const baselines = factory(), fixture = working(files);
    baselines.attach({ ...fixture, key: `value-${value}-${refactor ? "refactor" : "plain"}`, files, initialize });
    expect(git(fixture.repository, fixture.caseRoot, ["show", "HEAD:AGENTS.md"])).toBe(files["AGENTS.md"].trim());
    expect(git(fixture.repository, fixture.caseRoot, ["show", "HEAD:src/value.json"])).toBe(files["src/value.json"]);
    expect(git(fixture.repository, fixture.caseRoot, ["status", "--porcelain"])).toBe("");
    expect(existsSync(join(fixture.repository, "refactor.mjs"))).toBe(refactor);
  });
  it.each(["missing", "extra", "changed", "agents", "nonempty-git", "wrong-key"])("refuses %s without altering destination bytes", (kind) => {
    const baselines = factory(), files = { ...minimal, "AGENTS.md": "Exact public rules\n" }, existing = working(files);
    baselines.attach({ ...existing, key: "minimal", files, initialize });
    const target = working(files);
    if (kind === "missing") unlinkSync(join(target.repository, "README.md"));
    if (kind === "extra") writeFileSync(join(target.repository, "extra.txt"), "unexpected");
    if (kind === "changed") writeFileSync(join(target.repository, "README.md"), "changed");
    if (kind === "agents") writeFileSync(join(target.repository, "AGENTS.md"), "Changed instructions\n");
    if (kind === "nonempty-git") { mkdirSync(join(target.repository, ".git")); writeFileSync(join(target.repository, ".git/HEAD"), "retain this marker"); }
    let expected: Readonly<Record<string, string>> = files;
    if (kind === "wrong-key") { expected = { ...files, "README.md": "changed descriptor\n" }; writeFileSync(join(target.repository, "README.md"), expected["README.md"]); }
    const before = inventory(target.repository);
    expect(() => baselines.attach({ ...target, key: "minimal", files: expected, initialize })).toThrow(/refused/);
    expect(inventory(target.repository)).toEqual(before);
  });
  it.each(["working-link", "git-link", "ancestor-link", "hardlink"])("refuses %s and preserves its outside target", (kind) => {
    const baselines = factory(), fixture = working(), outside = temporary(), marker = join(outside, "marker.txt"), content = kind === "hardlink" ? "hi\n" : "outside-owned bytes";
    writeFileSync(marker, content);
    if (kind === "hardlink") { unlinkSync(join(fixture.repository, "README.md")); linkSync(marker, join(fixture.repository, "README.md")); }
    if (kind === "working-link") symlinkSync(outside, join(fixture.repository, "redirect"), "junction");
    if (kind === "git-link") symlinkSync(outside, join(fixture.repository, ".git"), "junction");
    let repository = fixture.repository;
    if (kind === "ancestor-link") { symlinkSync(outside, join(fixture.caseRoot, "redirect"), "junction"); mkdirSync(join(outside, "repository")); repository = join(fixture.caseRoot, "redirect/repository"); }
    expect(() => baselines.attach({ ...fixture, repository, key: "minimal", files: minimal, initialize })).toThrow(/refused/);
    expect(readFileSync(marker, "utf8")).toBe(content);
    baselines.dispose(); expect(readFileSync(marker, "utf8")).toBe(content);
  });
  it.each(["config", "lock", "alternates", "commondir", "worktrees", "custom-hook", "changed-object", "hardlink"])("refuses a contaminated published seed: %s", (kind) => {
    const baselines = factory(), first = working(); let seed = "";
    baselines.attach({ ...first, key: "minimal", files: minimal, initialize: (input) => { seed = input.repository; initialize(input); } });
    const metadata = join(seed, ".git");
    if (kind === "config") writeFileSync(join(metadata, "config"), "[include]\npath = /outside/config\n");
    if (kind === "lock") writeFileSync(join(metadata, "index.lock"), "pending");
    if (kind === "alternates") writeFileSync(join(metadata, "objects/info/alternates"), "/outside/objects\n");
    if (kind === "commondir") writeFileSync(join(metadata, "commondir"), "/outside/git\n");
    if (kind === "worktrees") mkdirSync(join(metadata, "worktrees"));
    if (kind === "custom-hook") writeFileSync(join(metadata, "hooks/pre-commit"), "custom\n");
    const object = Object.keys(inventory(join(metadata, "objects"))).find((path) => /^[a-f0-9]{2}\/[a-f0-9]+$/.test(path))!;
    if (kind === "changed-object") { chmodSync(join(metadata, "objects", object), 0o644); writeFileSync(join(metadata, "objects", object), "changed object bytes"); }
    if (kind === "hardlink") linkSync(join(metadata, "objects", object), join(temporary(), "shared-object"));
    const target = working(), before = inventory(target.repository);
    expect(() => baselines.attach({ ...target, key: "minimal", files: minimal, initialize })).toThrow(/refused/);
    expect(inventory(target.repository)).toEqual(before);
  });
  it("cleans failed setup, remains lazy and never removes a redirected ownership root", () => {
    const lazy = factory(); lazy.dispose();
    const baselines = factory(), fixture = working(); let seedRoot = "";
    expect(() => baselines.attach({ ...fixture, key: "minimal", files: minimal, initialize: ({ root }) => { seedRoot = root; throw new Error("Synthetic setup interruption"); } })).toThrow(/Synthetic setup/);
    expect(existsSync(seedRoot)).toBe(false); const factoryRoot = dirname(seedRoot);
    baselines.dispose(); expect(existsSync(factoryRoot)).toBe(false); expect(existsSync(join(fixture.repository, ".git"))).toBe(false);
    const redirected = factory(), another = working(); let ownRoot = "";
    redirected.attach({ ...another, key: "minimal", files: minimal, initialize: (input) => { ownRoot = dirname(input.root); initialize(input); } });
    const outside = temporary(), marker = join(outside, "marker.txt"); writeFileSync(marker, "retain outside");
    const ownRelative = relative(resolve(tmpdir()), resolve(ownRoot));
    expect(ownRelative).not.toBe(""); expect(ownRelative.startsWith("..")).toBe(false); expect(isAbsolute(ownRelative)).toBe(false);
    expect(basename(ownRoot)).toMatch(/^surtec-test-git-seeds-/); expect(lstatSync(ownRoot).isSymbolicLink()).toBe(false);
    rmSync(ownRoot, { recursive: true }); symlinkSync(outside, ownRoot, "junction");
    expect(() => redirected.dispose()).toThrow(/refused/); expect(readFileSync(marker, "utf8")).toBe("retain outside");
    unlinkSync(ownRoot); // Remove only the test-created link, never its outside target.
    factories.splice(factories.indexOf(redirected), 1);
  });
});
