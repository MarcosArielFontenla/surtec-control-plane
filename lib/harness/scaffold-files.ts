import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, realpathSync, unlinkSync,
  writeFileSync, type BigIntStats,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { hash, safeRelative } from "./source";

const maxTemplateBytes = 256 * 1024;

export function scaffoldDirectoryIdentity(path: string, stat: BigIntStats = lstatSync(path, { bigint: true })): string {
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0n || relative(path, realpathSync.native(path)) !== "") {
    throw new Error("Unsafe scaffold directory");
  }
  return `${stat.dev}:${stat.ino}`;
}

function fileIdentity(stat: BigIntStats, maxBytes: number, links: bigint): string {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.ino === 0n || stat.nlink !== links || stat.size > BigInt(maxBytes)) {
    throw new Error("Unsafe scaffold entry");
  }
  return [stat.dev, stat.ino, stat.birthtimeNs, stat.size, stat.mode, stat.uid, stat.gid, stat.mtimeNs, stat.ctimeNs].join(":");
}

function locateEntry(root: string, path: string) {
  if (!safeRelative(path)) throw new Error("Unsafe scaffold path");
  const directories = [scaffoldDirectoryIdentity(root)];
  const segments = path.split("/");
  const absolute = join(root, path);
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    const stat = lstatSync(parent, { bigint: true, throwIfNoEntry: false });
    if (!stat) return { absolute, directories: directories.join("/"), stat: undefined };
    directories.push(scaffoldDirectoryIdentity(parent, stat));
  }
  return { absolute, directories: directories.join("/"), stat: lstatSync(absolute, { bigint: true, throwIfNoEntry: false }) };
}

export function observeScaffoldEntry(root: string, path: string, maxBytes = maxTemplateBytes) {
  return readEntry(root, path, maxBytes, 1n);
}

function readEntry(root: string, path: string, maxBytes: number, links: bigint) {
  const before = locateEntry(root, path);
  if (!before.stat) return { bytes: null, sha256: null, identity: before.directories, proof: null };

  const identity = fileIdentity(before.stat, maxBytes, links);
  const fd = openSync(before.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (fileIdentity(fstatSync(fd, { bigint: true }), maxBytes, links) !== identity) throw new Error("Scaffold entry changed while opening");
    const buffer = Buffer.alloc(Number(before.stat.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const after = locateEntry(root, path);
    if (length !== Number(before.stat.size) || fileIdentity(fstatSync(fd, { bigint: true }), maxBytes, links) !== identity
      || !after.stat || fileIdentity(after.stat, maxBytes, links) !== identity || after.directories !== before.directories) {
      throw new Error("Scaffold entry changed while reading");
    }
    const bytes = buffer.subarray(0, length);
    return { bytes, sha256: hash(bytes), identity: `${before.directories}/${identity}`, proof: fileProof(before.stat) };
  } finally {
    closeSync(fd);
  }
}

const templatePaths = [".agents/templates/entity.spec.yaml", ".agents/templates/feature.tasks.md"] as const;
export type ScaffoldTemplatePath = typeof templatePaths[number];

export function isScaffoldTemplate(path: string): path is ScaffoldTemplatePath {
  return templatePaths.some((candidate) => candidate === path);
}

export function scaffoldStagePath(operationId: string, path: ScaffoldTemplatePath): string {
  if (!isScaffoldTemplate(path) || !/^[a-f0-9-]{36}$(?![\s\S])/.test(operationId)) throw new Error("Invalid scaffold stage");
  return `.agents/templates/.surtec-scaffold-${operationId}-${basename(path)}.tmp`;
}

function fileProof(stat: BigIntStats) {
  const file_identity_sha256 = hash([stat.dev, stat.ino, stat.birthtimeNs].join(":"));
  const staging_metadata_sha256 = hash([stat.mode, stat.uid, stat.gid, stat.size, stat.mtimeNs].join(":"));
  return {
    file_identity_sha256, staging_metadata_sha256,
    file_metadata_sha256: hash(`${staging_metadata_sha256}:${stat.ctimeNs}`),
    has_birth_time: stat.birthtimeNs > 0n,
  };
}

function checkFile(condition: unknown): asserts condition {
  if (!condition) throw new Error("Scaffold file ownership is unavailable");
}

export function prepareScaffoldStage(root: string, id: string, path: ScaffoldTemplatePath, bytes: Buffer, fence: () => void) {
  const stage = scaffoldStagePath(id, path);
  const target = locateEntry(root, path);
  checkFile(!target.stat && bytes.length <= maxTemplateBytes);
  fence();
  const fd = openSync(join(root, stage), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  let identity: string | undefined;
  try {
    try {
      const opened = fstatSync(fd, { bigint: true });
      fileIdentity(opened, maxTemplateBytes, 1n);
      identity = fileProof(opened).file_identity_sha256;
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    fence();
    const observed = observeScaffoldEntry(root, stage);
    checkFile(observed.proof?.file_identity_sha256 === identity && observed.bytes?.equals(bytes));
    return observed;
  } catch (error) {
    if (identity) {
      // A partially written stage is safe to clean only while this call still owns the same object.
      try {
        fence();
        const named = locateEntry(root, stage);
        if (named.stat && named.stat.nlink === 1n && named.stat.isFile() && fileProof(named.stat).file_identity_sha256 === identity) unlinkSync(named.absolute);
      } catch { /* Keep unknown evidence. */ }
    }
    throw error;
  }
}

type StageObservation = ReturnType<typeof prepareScaffoldStage>;

export function discardUnpublishedScaffoldStage(root: string, id: string, path: ScaffoldTemplatePath, staged: StageObservation, fence: () => void): void {
  try {
    const stage = scaffoldStagePath(id, path);
    fence();
    const observed = observeScaffoldEntry(root, stage);
    if (observed.identity === staged.identity && observed.sha256 === staged.sha256) unlinkSync(join(root, stage));
  } catch { /* Linked, replaced or otherwise uncertain stages retain their evidence. */ }
}

export function publishScaffoldStage(root: string, id: string, path: ScaffoldTemplatePath, staged: StageObservation, fence: () => void) {
  const stage = scaffoldStagePath(id, path);
  fence();
  const before = observeScaffoldEntry(root, stage);
  checkFile(staged.proof && before.identity === staged.identity && before.sha256 === staged.sha256);
  // The hard link publishes one complete file and fails atomically when the destination already exists.
  linkSync(join(root, stage), join(root, path));
  fence();
  for (const name of [stage, path]) {
    const linked = readEntry(root, name, maxTemplateBytes, 2n);
    checkFile(linked.sha256 === staged.sha256 && linked.proof?.file_identity_sha256 === staged.proof.file_identity_sha256
      && linked.proof.staging_metadata_sha256 === staged.proof.staging_metadata_sha256);
  }
  unlinkSync(join(root, stage));
  fence();
  const final = observeScaffoldEntry(root, path);
  checkFile(final.sha256 === staged.sha256 && final.proof?.file_identity_sha256 === staged.proof.file_identity_sha256
    && final.proof.staging_metadata_sha256 === staged.proof.staging_metadata_sha256);
  return final;
}

export function removeScaffoldCreation(
  root: string, path: ScaffoldTemplatePath, expected: { sha256: string; file_identity_sha256: string; file_metadata_sha256: string },
  fence: () => void,
): void {
  checkFile(isScaffoldTemplate(path));
  fence();
  const current = observeScaffoldEntry(root, path);
  checkFile(current.sha256 === expected.sha256 && current.proof?.file_identity_sha256 === expected.file_identity_sha256
    && current.proof.file_metadata_sha256 === expected.file_metadata_sha256);
  unlinkSync(join(root, path));
  fence();
  checkFile(observeScaffoldEntry(root, path).sha256 === null);
}
