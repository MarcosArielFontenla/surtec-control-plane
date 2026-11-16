import { createHash } from "node:crypto";
import {
  constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type Identity = { dev: number; ino: number };
type Descriptor = { entries: ReadonlyArray<readonly [string, string]>; fingerprint: string };
type MetadataEntry = { path: string; directory: boolean; hash: string | null; mode: number };
type Seed = { repository: string; descriptor: Descriptor; metadata: MetadataEntry[]; fingerprint: string };

export interface GitFixtureAttachment {
  caseRoot: string;
  repository: string;
  key: string;
  files: Readonly<Record<string, string>>;
  initialize: (fixture: { repository: string; root: string }) => void;
}

const MAX_FILES = 32, MAX_CONTENT_BYTES = 256 * 1024, MAX_METADATA_ENTRIES = 2048, MAX_METADATA_BYTES = 2 * 1024 * 1024;
function fail(reason: string): never { throw new Error(`Git fixture baseline refused: ${reason}`); }
function normalized(path: string): string { const value = resolve(path); return process.platform === "win32" ? value.toLowerCase() : value; }
function inside(root: string, path: string): boolean {
  const part = relative(normalized(root), normalized(path));
  return part !== "" && !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}
function directory(path: string): Identity {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || normalized(realpathSync.native(path)) !== normalized(path)) fail("redirected directory");
  return { dev: stat.dev, ino: stat.ino };
}
function sameIdentity(path: string, expected: Identity): void {
  const actual = directory(path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) fail("directory ownership changed");
}
function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function descriptor(files: Readonly<Record<string, string>>): Descriptor {
  if (!files || typeof files !== "object" || ![null, Object.prototype].includes(Object.getPrototypeOf(files))) fail("invalid file descriptor");
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0 || entries.length > MAX_FILES) fail("file descriptor capacity");
  const folded = new Set<string>(); let bytes = 0;
  for (const [path, value] of entries) {
    const parts = path.split("/");
    if (path.length > 256 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === ".." || part.toLowerCase() === ".git"
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || part.endsWith(".")) || folded.has(path.toLowerCase())) fail("unsafe descriptor path");
    if (typeof value !== "string" || value.includes("\0")) fail("descriptor must contain public text");
    folded.add(path.toLowerCase()); bytes += Buffer.byteLength(value);
  }
  if (bytes > MAX_CONTENT_BYTES) fail("descriptor byte capacity");
  for (const [path] of entries) if (entries.some(([other]) => other !== path && other.startsWith(`${path}/`))) fail("descriptor file/directory collision");
  return { entries, fingerprint: digest(JSON.stringify(entries)) };
}
function inspectWorkingTree(repository: string, expected: Descriptor): void {
  directory(repository);
  const files = new Map(expected.entries), found = new Set<string>(), directories = new Set<string>();
  for (const [path] of expected.entries) {
    const parts = path.split("/");
    for (let count = 1; count < parts.length; count++) directories.add(parts.slice(0, count).join("/"));
  }
  function visit(path: string, prefix: string): void {
    for (const name of readdirSync(path)) {
      if (!prefix && name === ".git") continue;
      const key = prefix ? `${prefix}/${name}` : name, child = join(path, name), stat = lstatSync(child);
      if (stat.isSymbolicLink()) fail("redirected working-tree entry");
      if (stat.isDirectory()) {
        if (!directories.has(key)) fail("extra working-tree directory");
        directory(child); visit(child, key);
      } else {
        const content = files.get(key);
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o111) !== 0 || content === undefined || stat.size !== Buffer.byteLength(content)
          || !readFileSync(child).equals(Buffer.from(content))) fail("working-tree descriptor mismatch");
        found.add(key);
      }
    }
  }
  visit(repository, "");
  if (found.size !== files.size) fail("missing working-tree file");
}
function inspectConfig(bytes: Buffer): void {
  const allowed: Record<string, ReadonlySet<string>> = {
    core: new Set(["repositoryformatversion", "filemode", "bare", "logallrefupdates", "symlinks", "ignorecase"]),
    user: new Set(["name", "email"]),
  };
  let section = ""; const seen = new Set<string>();
  for (const raw of bytes.toString("utf8").split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([A-Za-z]+)\]$/.exec(line);
    if (header) { section = header[1]!.toLowerCase(); if (!Object.hasOwn(allowed, section)) fail("unsafe seed Git configuration"); continue; }
    const entry = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(line), key = entry?.[1]?.toLowerCase(), value = entry?.[2];
    if (!key || value === undefined || !allowed[section]?.has(key) || seen.has(`${section}.${key}`)) fail("unsafe seed Git configuration");
    if (section === "core" && (key === "repositoryformatversion" ? value !== "0" : !["true", "false"].includes(value))) fail("unsafe seed Git configuration");
    if (section === "core" && key === "bare" && value !== "false") fail("bare seed is not a working repository");
    if (section === "user" && (!/^[A-Za-z0-9 @._+-]+$/.test(value) || value.length > 128)) fail("unsafe seed Git identity");
    seen.add(`${section}.${key}`);
  }
  if (!seen.has("core.repositoryformatversion") || !seen.has("core.bare") || !seen.has("user.name") || !seen.has("user.email")) fail("incomplete seed Git configuration");
}
function inspectMetadata(repository: string, seedRoot: string): MetadataEntry[] {
  const metadata = join(repository, ".git"), entries: MetadataEntry[] = []; let bytes = 0;
  directory(metadata);
  function visit(path: string, prefix: string): void {
    for (const name of readdirSync(path).sort()) {
      const key = prefix ? `${prefix}/${name}` : name, child = join(path, name), stat = lstatSync(child);
      if (entries.length >= MAX_METADATA_ENTRIES || stat.isSymbolicLink() || name.toLowerCase().endsWith(".lock")
        || ["gitdir", "commondir", "alternates", "http-alternates", "grafts", "shallow"].includes(name.toLowerCase())
        || key.toLowerCase() === "worktrees" || key.toLowerCase().startsWith("worktrees/")) fail("unsafe seed Git metadata");
      if (prefix === "hooks" && (!stat.isFile() || !name.endsWith(".sample"))) fail("custom seed hook");
      if (stat.isDirectory()) {
        directory(child); entries.push({ path: key, directory: true, hash: null, mode: stat.mode & 0o777 }); visit(child, key);
      } else {
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_METADATA_BYTES || (bytes += stat.size) > MAX_METADATA_BYTES) fail("linked or oversized seed metadata");
        const content = readFileSync(child);
        if (content.includes(Buffer.from(seedRoot)) || content.includes(Buffer.from(seedRoot.replaceAll("\\", "/")))) fail("absolute seed path binding");
        if (key === "config") inspectConfig(content);
        entries.push({ path: key, directory: false, hash: digest(content), mode: stat.mode & 0o777 });
      }
    }
  }
  visit(metadata, "");
  if (!["HEAD", "config", "index"].every((path) => entries.some((entry) => entry.path === path && !entry.directory))) fail("incomplete committed seed");
  return entries;
}
function removeOwned(path: string, parent: string, identity: Identity): void {
  if (!inside(parent, path)) fail("cleanup escaped its owned parent");
  sameIdentity(path, identity);
  // Native recursive removal unlinks contained links; it does not traverse their targets.
  rmSync(path, { recursive: true, force: false });
}

/** Private, lazy public-fixture baselines. This module never launches Git or reads project/state data. */
export function createGitFixtureBaselines() {
  const seeds = new Map<string, Seed>(); let owned: { path: string; parent: string; identity: Identity } | undefined, disposed = false, next = 0;
  function controlRoot() {
    if (disposed) fail("factory already disposed");
    if (!owned) {
      const parent = realpathSync.native(tmpdir()), path = mkdtempSync(join(parent, "surtec-test-git-seeds-"));
      owned = { path, parent, identity: directory(path) };
    }
    sameIdentity(owned.path, owned.identity); return owned;
  }
  return {
    attach({ caseRoot, repository, key, files, initialize }: GitFixtureAttachment): void {
      if (disposed) fail("factory already disposed");
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) fail("invalid baseline key");
      if (!isAbsolute(caseRoot) || !isAbsolute(repository) || !inside(caseRoot, repository)) fail("repository escaped its case root");
      const caseIdentity = directory(caseRoot), expected = descriptor(files);
      let parent = dirname(repository);
      while (normalized(parent) !== normalized(caseRoot)) { directory(parent); parent = dirname(parent); }
      inspectWorkingTree(repository, expected);
      const target = join(repository, ".git"); let emptyGit = false;
      if (existsSync(target)) { directory(target); if (readdirSync(target).length) fail("nonempty case Git metadata"); emptyGit = true; }
      else { try { lstatSync(target); fail("redirected case Git metadata"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
      let seed = seeds.get(key);
      if (seed && seed.descriptor.fingerprint !== expected.fingerprint) fail("baseline key descriptor mismatch");
      const control = controlRoot();
      if (!seed) {
        const seedRoot = join(control.path, `seed-${next++}`); mkdirSync(seedRoot); const identity = directory(seedRoot);
        const seedRepository = join(seedRoot, "repository"); mkdirSync(seedRepository);
        try {
          for (const [path, content] of expected.entries) { mkdirSync(dirname(join(seedRepository, path)), { recursive: true }); writeFileSync(join(seedRepository, path), content, { flag: "wx", mode: 0o644 }); }
          const returned: unknown = initialize({ repository: seedRepository, root: seedRoot });
          if (returned !== undefined) fail("initializer must complete synchronously");
          inspectWorkingTree(seedRepository, expected);
          const metadata = inspectMetadata(seedRepository, control.path);
          seed = { repository: seedRepository, descriptor: expected, metadata, fingerprint: digest(JSON.stringify(metadata)) };
          seeds.set(key, seed);
        } catch (error) { removeOwned(seedRoot, control.path, identity); throw error; }
      }
      inspectWorkingTree(seed.repository, seed.descriptor);
      const current = inspectMetadata(seed.repository, control.path);
      if (digest(JSON.stringify(current)) !== seed.fingerprint) fail("published seed changed");
      sameIdentity(caseRoot, caseIdentity); inspectWorkingTree(repository, expected);
      if (emptyGit) { directory(target); if (readdirSync(target).length) fail("case Git metadata changed"); rmdirSync(target); }
      let targetIdentity: Identity | undefined;
      try {
        mkdirSync(target); targetIdentity = directory(target);
        for (const entry of seed.metadata) {
          const source = join(seed.repository, ".git", entry.path), destination = join(target, entry.path);
          if (entry.directory) mkdirSync(destination, { mode: entry.mode });
          else copyFileSync(source, destination, constants.COPYFILE_EXCL);
        }
        sameIdentity(caseRoot, caseIdentity);
      } catch (error) {
        if (targetIdentity) removeOwned(target, repository, targetIdentity);
        if (emptyGit && !existsSync(target)) mkdirSync(target);
        throw error;
      }
    },
    dispose(): void {
      if (disposed) return;
      if (owned) removeOwned(owned.path, owned.parent, owned.identity);
      seeds.clear(); owned = undefined; disposed = true;
    },
  };
}
