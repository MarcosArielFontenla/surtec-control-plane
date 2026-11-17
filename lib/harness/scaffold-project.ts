import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { PolicyService } from "../policy/service";
import { localGitEnvironment } from "../security/environment";
import { isSafeIdentifier } from "../security/identifiers";
import { isPathWithin } from "../security/paths";
import { observeScaffoldEntry, scaffoldDirectoryIdentity } from "./scaffold-files";
import { previewHarnessScaffold } from "./scaffold-preview";
import { hash } from "./source";

const templatesParent = ".agents/templates";
const busyGitPaths = [
  "index.lock", "HEAD.lock", "packed-refs.lock", "config.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD",
  "REVERT_HEAD", "REBASE_HEAD", "BISECT_START", "rebase-apply", "rebase-merge", "sequencer",
];
const maxIndexBytes = 16 * 1024 * 1024;
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

type GitExclusion = "index-entry" | "head-entry" | "ignored";
type ProjectUnavailableReason = "project-unavailable" | "checkout-unavailable" | "checkout-changed";

function unavailable(reason: ProjectUnavailableReason) {
  return { status: "unavailable", reason, execution_authority: "none" } as const;
}

function namedEntryExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function physicalCheckout(root: string) {
  const gitDirectory = join(root, ".git");
  const rootIdentity = scaffoldDirectoryIdentity(root);
  const gitIdentity = scaffoldDirectoryIdentity(gitDirectory);
  const agentsIdentity = scaffoldDirectoryIdentity(join(root, ".agents"));
  const templatesIdentity = scaffoldDirectoryIdentity(join(root, templatesParent));
  if (busyGitPaths.some((path) => namedEntryExists(join(gitDirectory, path)))
    || namedEntryExists(join(gitDirectory, "commondir"))
    || namedEntryExists(join(root, ".agents/.git"))
    || namedEntryExists(join(root, templatesParent, ".git"))) {
    throw new Error("Scaffold checkout has active or redirected Git metadata");
  }
  const checkout_fingerprint = hash(JSON.stringify([root, rootIdentity, gitIdentity]));
  return {
    checkout_fingerprint,
    template_parent_fingerprint: hash(JSON.stringify([checkout_fingerprint, agentsIdentity, templatesIdentity])),
  };
}

function readGit(root: string, args: readonly string[], acceptOne = false, input?: string) {
  const result = spawnSync("git", [
    "--no-optional-locks", "--no-replace-objects",
    "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", root, ...args,
  ], {
    env: { ...localGitEnvironment(), GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024, input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error || result.signal || (result.status !== 0 && !(acceptOne && result.status === 1))) {
    throw new Error("Scaffold Git observation is unavailable");
  }
  return { status: result.status, stdout: result.stdout };
}

function nulPaths(text: string): string[] {
  if (text === "") return [];
  if (!text.endsWith("\0")) throw new Error("Incomplete Git path observation");
  return text.slice(0, -1).split("\0");
}

function gitLine(text: string) {
  return text.replace(/\r?\n$/, "");
}

function readCheckout(root: string) {
  const physical = physicalCheckout(root);
  const gitDir = join(root, ".git");
  // Validate named entries before Git opens them, then bind the resulting Git projections.
  if (!observeScaffoldEntry(root, ".git/HEAD").bytes) throw new Error("Git HEAD is unavailable");
  observeScaffoldEntry(root, ".git/config");
  const index = observeScaffoldEntry(root, ".git/index", maxIndexBytes);
  const coordinates = gitLine(readGit(root, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--path-format=absolute", "--git-common-dir"]).stdout)
    .split(/\r?\n/);
  if (coordinates.length !== 3 || [root, gitDir, gitDir].some((path, index) =>
    !isAbsolute(coordinates[index]) || relative(path, coordinates[index]) !== "")) {
    throw new Error("Git resolved a different scaffold checkout");
  }
  const head = gitLine(readGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]).stdout);
  const ref = readGit(root, ["symbolic-ref", "--quiet", "HEAD"], true);
  const branch = ref.status === 1 ? null : gitLine(ref.stdout);
  if (!objectId.test(head) || (branch === null ? ref.stdout !== "" : !/^refs\/heads\/[^\x00-\x20\x7f]{1,512}$/.test(branch))) {
    throw new Error("Invalid scaffold Git anchor");
  }
  const staged = readGit(root, ["ls-files", "--stage", "-z"]).stdout;
  const indexPaths = nulPaths(staged).map((entry) => {
    const separator = entry.indexOf("\t");
    if (separator < 0) throw new Error("Invalid Git index entry");
    return entry.slice(separator + 1);
  });
  return { binding: { ...physical, head, branch, index_sha256: index.sha256, index_entries_sha256: hash(staged) }, indexPaths };
}

function overlaps(gitPath: string, target: string): boolean {
  const path = gitPath.toLowerCase();
  return path === target || path.startsWith(target + "/") || target.startsWith(path + "/");
}

function readExclusions(root: string, checkout: ReturnType<typeof readCheckout>, paths: readonly string[]) {
  const exclusions = new Map<string, GitExclusion>();
  if (paths.length === 0) return exclusions;
  const headPaths = nulPaths(readGit(root, ["ls-tree", "-r", "--name-only", "-z", "--full-tree", checkout.binding.head]).stdout);
  for (const path of paths) {
    if (checkout.indexPaths.some((candidate) => overlaps(candidate, path))) exclusions.set(path, "index-entry");
    else if (headPaths.some((candidate) => overlaps(candidate, path))) exclusions.set(path, "head-entry");
  }
  const remaining = paths.filter((path) => !exclusions.has(path));
  if (remaining.length > 0) {
    const ignored = readGit(root, ["check-ignore", "--no-index", "-z", "--stdin"], true, remaining.join("\0") + "\0");
    for (const path of nulPaths(ignored.stdout)) {
      if (!remaining.includes(path)) throw new Error("Unexpected Git ignore path");
      exclusions.set(path, "ignored");
    }
  }
  return exclusions;
}

/** Read-only plan for an explicitly selected, registry-resolved checkout. */
export function previewRegisteredScaffold(
  repoRoot: string, input: { projectId: string; selection: unknown },
  policy: Pick<PolicyService, "project"> = new PolicyService(repoRoot),
) {
  if (!isSafeIdentifier(input.projectId)) return unavailable("project-unavailable");
  let targetRoot: string;
  try {
    const project = policy.project(input.projectId);
    if (!project.repo_path || project.id !== input.projectId) return unavailable("project-unavailable");
    targetRoot = resolve(project.repo_path);
    if (isPathWithin(repoRoot, targetRoot) || isPathWithin(targetRoot, repoRoot)) return unavailable("project-unavailable");
  } catch {
    return unavailable("project-unavailable");
  }

  try {
    const before = readCheckout(targetRoot);
    const preview = previewHarnessScaffold({
      repoRoot, targetRoot, projectId: input.projectId, selection: input.selection, includeAdditionText: true,
    });
    if (preview.status !== "available") return preview;
    const exclusions = readExclusions(targetRoot, before, preview.addition_text.map(({ path }) => path));
    const { binding: git } = readCheckout(targetRoot);
    if (!isDeepStrictEqual(git, before.binding)) return unavailable("checkout-changed");

    const physical = physicalCheckout(targetRoot);
    if (git.checkout_fingerprint !== physical.checkout_fingerprint || git.template_parent_fingerprint !== physical.template_parent_fingerprint) {
      return unavailable("checkout-changed");
    }

    if (preview.entries.some((entry) => observeScaffoldEntry(targetRoot, entry.path).sha256 !== entry.observed_sha256)) {
      return unavailable("checkout-changed");
    }
    const additions = preview.addition_text.filter(({ path }) => !exclusions.has(path)).map(({ path, text }) => ({
      path, text, sha256: hash(text), preimage: "absent" as const,
    }));
    const plan = {
      schema_version: 1,
      project_id: input.projectId,
      archetype: preview.archetype,
      source: preview.source,
      scaffold_fingerprint: preview.fingerprint,
      git,
      entries: preview.entries.map((entry) => ({ ...entry, git_exclusion: exclusions.get(entry.path) ?? null })),
      additions,
      doctor: preview.doctor,
      validation: preview.validation,
      routing: {
        ...preview.routing,
        added_physical_lines: preview.entries.reduce((lines, entry) =>
          lines + (entry.decision === "safe-addition" && !exclusions.has(entry.path) ? entry.canonical_physical_lines : 0), 0),
      },
      backup: preview.backup,
      rollback: {
        ...preview.rollback,
        additions: additions.map(({ path, sha256 }) => ({ path, expected_sha256: sha256 })),
      },
    } as const;
    return { status: "available", ...plan, apply_digest: hash(JSON.stringify(plan)), execution_authority: "none" } as const;
  } catch {
    return unavailable("checkout-unavailable");
  }
}
