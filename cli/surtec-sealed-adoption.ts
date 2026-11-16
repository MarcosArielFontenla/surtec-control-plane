import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, opendirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pathsOutsideScope } from "../dashboard/src/server/issue-service";
import { PolicyService } from "../lib/policy/service";
import { localGitEnvironment } from "../lib/security/environment";
import { isSafeIdentifier } from "../lib/security/identifiers";
import { redactText } from "../lib/security/redaction";
import { readIssueDocument } from "../lib/state/issues";
import { issueStatePath, stateDir, tasksDir, workflowStatePath } from "../lib/state/paths";
import type { TaskRecord } from "../lib/state/types";
import { validateTaskRecord } from "../lib/state/validation";
import { readWorkflowDocument } from "../lib/state/workflows";
import {
  AdoptionError, bindAdoptionOwner, digest, hashAdoptionFile, inspectAdoptionReport, isDigest, isIssueId, parseAdoptionJson,
  physicalPath, readAdoptionFile, readAdoptionSeal, record, requireAdoption, type AdoptionOwner, type AdoptionSeal,
} from "../lib/workflows/sealed-adoption";
import { managedWorktreeIdentity } from "../runner/worktree";
import { gearListHistoricalProfileId, historicalPathWithin, readHistoricalEvidence, verifyHistoricalReport, type HistoricalEvidence, type HistoricalProfile } from "../lib/workflows/historical-adoption";

const limit = 16 * 1024 * 1024;
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
interface Request { issueId: string; revision: number; dossierId: string; anchor: string }
interface Project { repo_path: string | null; sandbox: string; allowed_agents: string[]; verify_commands: string[] }
interface Dependencies {
  root: string;
  owner?: (seal: AdoptionSeal) => AdoptionOwner;
  project?: (id: string) => Project;
  now?: () => Date;
  historicalEvidence?: (root: string) => HistoricalEvidence;
}
type Outcome =
  | { outcome: "READY_FOR_HUMAN_REVIEW"; package_id: string; reused: boolean; elapsed_ms: number }
  | { outcome: "HISTORICAL_ACCEPTANCE_REVALIDATED"; receipt_id: string; reused: boolean; elapsed_ms: number }
  | { outcome: "REFUSED" | "UNKNOWN"; code: string; next_action: string };

function parseRequest(args: string[]): Request {
  requireAdoption(args.length === 9 && args[0] === "prepare", "INVALID_ARGUMENTS");
  const values = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1]!;
    requireAdoption(["--issue-id", "--expected-revision", "--dossier-id", "--seal-sha256"].includes(key) && !values.has(key), "INVALID_ARGUMENTS");
    values.set(key, value);
  }
  const issueId = values.get("--issue-id"), revisionText = values.get("--expected-revision"), dossierId = values.get("--dossier-id"), anchor = values.get("--seal-sha256");
  const revision = Number(revisionText);
  requireAdoption(isIssueId(issueId) && isSafeIdentifier(dossierId) && isDigest(anchor)
    && revisionText && /^[1-9]\d*$/.test(revisionText) && Number.isSafeInteger(revision), "INVALID_ARGUMENTS");
  return { issueId, revision, dossierId, anchor };
}

function currentOwner(seal: AdoptionSeal): AdoptionOwner {
  const state = stateDir();
  const issuePath = issueStatePath(state);
  const issueBytes = readAdoptionFile(issuePath, limit);
  const issues = readIssueDocument(issuePath);
  requireAdoption(readAdoptionFile(issuePath, limit).equals(issueBytes), "OWNER_CHANGED", "UNKNOWN");
  const workflows = readWorkflowDocument();
  return bindAdoptionOwner({ issues, workflows, tasks: readAdoptionTasks(state) }, seal);
}

function readAdoptionTasks(state: string): TaskRecord[] {
  const dir = tasksDir(state);
  physicalPath(dir, true);
  const tasks: TaskRecord[] = [];
  const listing = opendirSync(dir);
  try {
    let entries = 0;
    for (let entry = listing.readSync(); entry; entry = listing.readSync()) {
      requireAdoption(++entries <= 10_000, "TASK_INVENTORY_LIMIT", "UNKNOWN");
      if (!entry.name.endsWith(".json")) continue;
      const value = parseAdoptionJson(readAdoptionFile(join(dir, entry.name), 1024 * 1024));
      requireAdoption(validateTaskRecord(value) && entry.name === value.envelope.id + ".json", "OWNER_UNAVAILABLE", "UNKNOWN");
      tasks.push(value);
    }
  } finally {
    listing.closeSync();
  }
  return tasks;
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
};

function readVerifier(root: string, project: Project, seal: AdoptionSeal) {
  const [command] = project.verify_commands;
  const match = command?.match(/^"([^"\r\n]+)" "([^"\r\n]+)" --pins-sha256 ([a-f0-9]{64})$/);
  requireAdoption(project.verify_commands.length === 1 && match, "VERIFIER_NOT_CONFIGURED", "UNKNOWN");
  const [, node, entry, pinsSha] = match as unknown as [string, string, string, string];
  requireAdoption(isAbsolute(node) && /^node(?:\.exe)?$/i.test(basename(node)) && isAbsolute(entry)
    && inside(root, entry) && basename(entry) === "verify-candidate.mjs" && pinsSha === seal.verifier_pins_sha256, "VERIFIER_BINDING_MISMATCH");
  const directory = dirname(entry), pinsBytes = readAdoptionFile(join(directory, "verifier-pins.json"));
  requireAdoption(digest(pinsBytes) === pinsSha, "VERIFIER_PINS_CHANGED");
  const pins = record(parseAdoptionJson(pinsBytes));
  const contractPath = join(directory, "verification-contract.json");
  const contractBytes = readAdoptionFile(contractPath, limit);
  requireAdoption(pins?.schema_version === 1 && Array.isArray(pins.files) && pins.files.length >= 4 && pins.files.length <= 128
    && pins.contract_sha256 === digest(contractBytes), "VERIFIER_PINS_CHANGED");
  const contract = record(parseAdoptionJson(contractBytes));
  requireAdoption(contract?.schema_version === 1 && contract.baseline_commit === seal.base
    && typeof contract.pilot_root === "string" && isAbsolute(contract.pilot_root)
    && Array.isArray(contract.allowlist) && contract.allowlist.length > 0 && contract.allowlist.length <= 300
    && contract.allowlist.every((path) => typeof path === "string" && safeGitPath(path)), "VERIFIER_CONTRACT_MISMATCH");
  const git = record(record(contract.tools)?.git)?.executable;
  const frontend = contract.required_frontend_tests, backend = contract.required_backend_tests;
  requireAdoption(typeof git === "string" && isAbsolute(git) && /^git(?:\.exe)?$/i.test(basename(git))
    && Number.isSafeInteger(frontend) && Number(frontend) > 0 && Number.isSafeInteger(backend) && Number(backend) > 0, "VERIFIER_CONTRACT_MISMATCH");
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const raw of pins.files) {
    const pin = record(raw);
    requireAdoption(pin && Object.keys(pin).length === 2 && typeof pin.path === "string" && isAbsolute(pin.path)
      && isDigest(pin.sha256), "VERIFIER_PINS_CHANGED");
    const path = resolve(pin.path);
    requireAdoption(!seen.has(path), "VERIFIER_PINS_CHANGED");
    seen.add(path);
    // The installed Git executable can have multiple filesystem names. Private pins cannot.
    const installedGit = path === resolve(git) && !inside(root, path);
    const size = physicalPath(path, false, installedGit).size;
    totalBytes += size;
    requireAdoption(totalBytes <= 1024 * 1024 * 1024, "VERIFIER_PIN_LIMIT", "UNKNOWN");
    requireAdoption(hashAdoptionFile(path, Math.min(size, 512 * 1024 * 1024), installedGit) === pin.sha256, "VERIFIER_PINS_CHANGED");
  }
  requireAdoption([entry, contractPath, git, node].every((path) => seen.has(resolve(path))), "VERIFIER_PINS_CHANGED");
  physicalPath(contract.pilot_root, true);
  return { git, counts: { frontend: Number(frontend), backend: Number(backend) },
    allowed: contract.allowlist as string[], repoPath: resolve(contract.pilot_root), commandSha: digest(command!) };
}

function safeGitPath(path: string): boolean {
  return path.length <= 1024 && !/[\u0000-\u001f\\:]/.test(path)
    && path.split("/").every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}
function readOnlyGit(executable: string, cwd: string, ...args: string[]): string {
  const result = spawnSync(executable, ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
    "-c", "core.untrackedCache=false", "-c", "protocol.allow=never", "-C", cwd, ...args], {
    cwd, windowsHide: true, maxBuffer: 1024 * 1024, timeout: 15_000,
    env: { ...localGitEnvironment(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" },
  });
  requireAdoption(result.status === 0 && !result.error && !!result.stdout, "GIT_INSPECTION_UNAVAILABLE", "UNKNOWN");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout); }
  catch { throw new AdoptionError("UNKNOWN", "GIT_PATH_ENCODING"); }
}

type InspectGit = (cwd: string, ...args: string[]) => string;

function inspectWorktree(git: InspectGit, source: string, worktree: string, branch: string | null, requiredCommonDir = join(source, ".git")) {
  physicalPath(source, true);
  physicalPath(worktree, true);
  const cli = (...args: string[]) => git(worktree, ...args);
  const common = (cwd: string) => resolve(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir").trim());
  const commonDir = common(source);
  physicalPath(commonDir, true);
  requireAdoption(commonDir === requiredCommonDir && common(worktree) === commonDir, "WORKTREE_BINDING_MISMATCH");
  physicalPath(join(worktree, ".git"), false);
  const gitDir = resolve(cli("rev-parse", "--absolute-git-dir").trim());
  requireAdoption(inside(join(commonDir, "worktrees"), gitDir), "WORKTREE_BINDING_MISMATCH");
  physicalPath(gitDir, true);
  const index = join(gitDir, "index");
  physicalPath(index, false);
  const listing = git(source, "worktree", "list", "--porcelain", "-z").split("\0\0");
  requireAdoption(listing.some((block) => {
    const [path, ...fields] = block.split("\0");
    return path?.startsWith("worktree ") && resolve(path.slice(9)) === worktree
      && fields.includes(branch ? "branch refs/heads/" + branch : "detached");
  }), "WORKTREE_BINDING_MISMATCH");
  requireAdoption(branch ? cli("symbolic-ref", "HEAD").trim() === "refs/heads/" + branch : !cli("branch", "--show-current").trim(),
    "WORKTREE_BINDING_MISMATCH");
  return { cli, index };
}

function inspectIndex(cli: (...args: string[]) => string, worktree: string, treeish: string): string {
  const tree = cli("ls-tree", "-r", "-z", "--full-tree", treeish).split("\0").filter(Boolean);
  const entries = cli("ls-files", "--stage", "-z").split("\0").filter(Boolean);
  const flags = cli("ls-files", "-v", "-z").split("\0").filter(Boolean);
  requireAdoption(tree.length > 0 && tree.length <= 10_000 && tree.length === entries.length && tree.length === flags.length, "TREE_MISMATCH");
  const indexed = new Map<string, string>();
  for (const entry of entries) {
    const row = /^((?:100644|100755) [a-f0-9]{40}) 0\t(.+)$/.exec(entry);
    requireAdoption(row && safeGitPath(row[2]!) && !indexed.has(row[2]!), "TREE_MISMATCH");
    indexed.set(row[2]!, row[1]!);
  }
  requireAdoption(flags.every((flag) => flag.startsWith("H ") && indexed.has(flag.slice(2))) && !cli("ls-files", "--others", "-z"), "TREE_MISMATCH");
  let totalBytes = 0;
  const files = tree.map((entry) => {
    const row = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    requireAdoption(row && safeGitPath(row[3]!) && indexed.get(row[3]!) === row[1] + " " + row[2], "TREE_MISMATCH");
    const [, mode, oid, path] = row as unknown as [string, string, string, string];
    const full = join(worktree, path), bytes = readAdoptionFile(full, Math.min(16 * 1024 * 1024, 64 * 1024 * 1024 - totalBytes));
    totalBytes += bytes.length;
    const actual = createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
    requireAdoption(actual === oid && (process.platform === "win32" || (physicalPath(full, false).mode & 0o111 ? "100755" : "100644") === mode), "TREE_MISMATCH");
    return { path, oid };
  });

  return digest(JSON.stringify(files));
}

function inspectTree(owner: AdoptionOwner, seal: AdoptionSeal, verifier: ReturnType<typeof readVerifier>) {
  const source = resolve(owner.repoPath), worktree = resolve(owner.worktreePath);
  const expected = managedWorktreeIdentity(source, seal.task_id, owner.agent);
  requireAdoption(source === verifier.repoPath && worktree === expected.worktreePath && owner.branch === expected.branch, "WORKTREE_BINDING_MISMATCH");
  const { cli } = inspectWorktree((cwd, ...args) => readOnlyGit(verifier.git, cwd, ...args), source, worktree, expected.branch);
  requireAdoption(cli("rev-parse", "HEAD", "HEAD^{tree}").trim().split(/\r?\n/).join(" ") === seal.commit + " " + seal.tree, "TREE_MISMATCH");
  requireAdoption(cli("merge-base", seal.base, seal.commit).trim() === seal.base, "BASE_BINDING_MISMATCH");
  const fingerprint = inspectIndex(cli, worktree, "HEAD");
  const paths = cli("diff", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", seal.base, seal.commit, "--").split("\0").filter(Boolean);
  requireAdoption(paths.length > 0 && paths.every((path) => safeGitPath(path) && redactText(path) === path && verifier.allowed.includes(path))
    && !pathsOutsideScope(paths, owner.issue.authorized_scope).length, "PATH_OUTSIDE_SCOPE");
  return { paths, fingerprint };
}

function publishPackage(directory: string, id: string, body: object, now: Date): boolean {
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  physicalPath(directory, true);
  const final = join(directory, id + ".json");
  const existing = () => {
    let bytes: Buffer;
    try { bytes = readAdoptionFile(final); } catch (error) { if (missing(error)) return false; throw error; }
    const value = record(parseAdoptionJson(bytes));
    const time = value?.prepared_at;
    requireAdoption(typeof time === "string" && Number.isFinite(Date.parse(time))
      && bytes.equals(Buffer.from(JSON.stringify({ ...body, prepared_at: time }) + "\n")), "PACKAGE_CONFLICT", "UNKNOWN");
    return true;
  };
  if (existing()) return true;
  const temp = join(directory, "." + randomUUID() + ".tmp");
  writeFileSync(temp, JSON.stringify({ ...body, prepared_at: now.toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
  try {
    try { linkSync(temp, final); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && existing()) return true;
      throw error;
    }
  } finally { unlinkSync(temp); }
  return false;
}

function rejectKnownHistoricalWriters(root: string, project: string): void {
  const state = process.env.SURTEC_STATE_DIR ?? join(root, "state");
  let tasks: TaskRecord[];
  try { tasks = readAdoptionTasks(state); }
  catch (error) { if (!missing(error)) throw error; tasks = []; }
  const workflows = readWorkflowDocument(workflowStatePath(state));
  requireAdoption(!tasks.some((task) => task.envelope.project === project && task.envelope.sandbox === "workspace-write"
    && (task.lifecycle !== "finished" || !!task.orchestration?.lease))
    && !Object.values(workflows.stages).some((stage) => stage.sandbox === "workspace-write"
      && workflows.workflows[stage.workflow_id]?.project_id === project && ["reserved", "queued", "running"].includes(stage.status)),
  "PROJECT_WRITER_ACTIVE", "UNKNOWN");
}

function inspectHistoricalTrees(evidence: HistoricalEvidence): string {
  const { source, original, prior, corrected, git, commonDir, worktreeParent, base } = evidence;
  physicalPath(worktreeParent, true);
  const identity = managedWorktreeIdentity(source, original.taskId, original.agent);
  requireAdoption(original.worktree === identity.worktreePath && original.branch === identity.branch
    && [original.worktree, prior.worktree, corrected.worktree].every((worktree) => historicalPathWithin(worktreeParent, worktree))
    && commonDir === join(source, ".git"), "HISTORICAL_WORKTREE_BINDING");
  requireAdoption(isAbsolute(git.executable) && /^git(?:\.exe)?$/i.test(basename(git.executable))
    && hashAdoptionFile(git.executable, 64 * 1024 * 1024, true) === git.sha256, "HISTORICAL_GIT_EXECUTABLE_UNAVAILABLE", "UNKNOWN");
  const inspect = (worktree: string, branch: string | null) =>
    inspectWorktree((cwd, ...args) => {
      // The historical profile and physical path checks bind this exact directory.
      // Git for Windows may observe different owners for the archived checkout.
      return readOnlyGit(git.executable, cwd, "-c", "safe.directory=" + cwd.replaceAll("\\", "/"), ...args);
    }, source, worktree, branch, commonDir);
  const origin = inspect(original.worktree, original.branch);
  const old = inspect(prior.worktree, null);
  const accepted = inspect(corrected.worktree, null);
  const originalIndex = hashAdoptionFile(origin.index, limit);
  requireAdoption(origin.cli("rev-parse", "HEAD").trim() === base && originalIndex === original.indexSha, "HISTORICAL_INDEX_MISMATCH");
  const first = inspectIndex(origin.cli, original.worktree, prior.tree);
  const observedIndex = [originalIndex];
  for (const [sourceTree, snapshot, parent] of [[prior, old, base], [corrected, accepted, prior.commit]] as const) {
    requireAdoption(snapshot.cli("rev-parse", "HEAD", "HEAD^{tree}").trim().split(/\r?\n/).join(" ") === sourceTree.commit + " " + sourceTree.tree
      && snapshot.cli("rev-list", "--parents", "-n", "1", "HEAD").trim() === sourceTree.commit + " " + parent, "HISTORICAL_GIT_LINEAGE_MISMATCH");
    const fingerprint = inspectIndex(snapshot.cli, sourceTree.worktree, sourceTree.tree);
    if (sourceTree === prior) requireAdoption(fingerprint === first, "HISTORICAL_INDEX_MISMATCH");
    verifyHistoricalReport(sourceTree, fingerprint, evidence.verification);
    observedIndex.push(hashAdoptionFile(snapshot.index, limit));
  }
  const checkPaths = (parent: string, child: string, expected: string[]) => {
    const paths = accepted.cli("diff", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", parent, child, "--").split("\0").filter(Boolean);
    requireAdoption(JSON.stringify([...paths].sort()) === JSON.stringify([...expected].sort())
      && paths.every((path) => safeGitPath(path) && redactText(path) === path)
      && !pathsOutsideScope(paths, evidence.scope).length, "HISTORICAL_SCOPE_MISMATCH");
  };
  checkPaths(base, prior.commit, evidence.paths);
  checkPaths(base, corrected.commit, evidence.paths);
  checkPaths(prior.commit, corrected.commit, evidence.correctionPaths);
  return digest(JSON.stringify(observedIndex));
}

function prepareHistorical(args: string[], deps: Dependencies, start: number): Outcome {
  const [, profileFlag, id, sealFlag, sealSha, acceptanceFlag, acceptanceSha] = args;
  requireAdoption(args.length === 7 && profileFlag === "--profile" && id === gearListHistoricalProfileId
    && sealFlag === "--seal-sha256" && isDigest(sealSha)
    && acceptanceFlag === "--acceptance-sha256" && isDigest(acceptanceSha), "INVALID_ARGUMENTS");
  const profile: HistoricalProfile = { id, sealSha, acceptanceSha };
  const root = resolve(deps.root);
  const read = deps.historicalEvidence ?? ((path: string) => readHistoricalEvidence(path, profile));
  const observe = () => {
    const evidence = read(root);
    rejectKnownHistoricalWriters(root, evidence.project);
    return { evidence, gitSha: inspectHistoricalTrees(evidence) };
  };
  const first = observe();
  let last: typeof first;
  try { last = observe(); }
  catch { throw new AdoptionError("UNKNOWN", "HISTORICAL_EVIDENCE_CHANGED"); }
  requireAdoption(last.evidence.evidenceSha === first.evidence.evidenceSha && last.gitSha === first.gitSha, "HISTORICAL_EVIDENCE_CHANGED", "UNKNOWN");
  const { evidence } = last;
  const binding = {
    profile: evidence.id, project_id: evidence.project, issue_id: evidence.issueId,
    workflow_id: evidence.workflowId, execution_id: evidence.runId, original_task_id: evidence.original.taskId,
    base: evidence.base, adopted_commit: evidence.prior.commit, adopted_tree: evidence.prior.tree,
    commit: evidence.corrected.commit, tree: evidence.corrected.tree, dossier_sha256: evidence.corrected.dossierSha,
    verification_report_sha256: evidence.corrected.reportSha, acceptance_sha256: evidence.acceptanceSha,
    verifier_pins_sha256: evidence.verification.verifierSha, historical_evidence_sha256: evidence.evidenceSha,
    acceptance: evidence.acceptance,
  };
  const receipt_id = "historical-" + digest(JSON.stringify({
    profile: binding.profile, commit: binding.commit, tree: binding.tree, seal: binding.dossier_sha256,
    report: binding.verification_report_sha256, acceptance: binding.acceptance_sha256,
  }));
  const temp = join(root, "tmp"), privateRoot = join(temp, "sealed-adoption");
  physicalPath(temp, true);
  try { mkdirSync(privateRoot, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  physicalPath(privateRoot, true);
  rejectKnownHistoricalWriters(root, evidence.project);
  const outcome = "HISTORICAL_ACCEPTANCE_REVALIDATED" as const;
  const reused = publishPackage(join(privateRoot, "historical-reviews"), receipt_id,
    { schema_version: 1, outcome, receipt_id, binding }, (deps.now ?? (() => new Date()))());
  return { outcome, receipt_id, reused, elapsed_ms: Math.round(performance.now() - start) };
}

export function runSealedAdoption(args: string[], deps: Dependencies): Outcome {
  const start = performance.now();
  try {
    if (args[0] === "prepare-historical") return prepareHistorical(args, deps, start);
    const request = parseRequest(args), root = resolve(deps.root), privateRoot = join(root, "tmp", "sealed-adoption");
    const dossier = join(privateRoot, "dossiers", request.dossierId), sealPath = join(dossier, "seal.json"), reportPath = join(dossier, "report.json");
    physicalPath(dossier, true);
    const seal = readAdoptionSeal(readAdoptionFile(sealPath), request.anchor);
    requireAdoption(seal.issue_id === request.issueId && seal.issue_revision === request.revision, "ISSUE_BINDING_MISMATCH");
    const readOwner = deps.owner ?? currentOwner;
    const readProject = deps.project ?? ((id: string) => new PolicyService(root).project(id));
    const observe = () => {
      const owner = readOwner(seal), project = readProject(seal.project_id);
      requireAdoption(project.repo_path && resolve(project.repo_path) === resolve(owner.repoPath)
        && project.sandbox === "workspace-write" && project.allowed_agents.includes(owner.agent), "PROJECT_POLICY_MISMATCH");
      const verifier = readVerifier(root, project, seal);
      const tree = inspectTree(owner, seal, verifier);
      inspectAdoptionReport(readAdoptionFile(reportPath), seal, tree.fingerprint, verifier.counts);
      return { owner, verifier, tree };
    };
    const first = observe();
    let last: typeof first;
    try { last = observe(); }
    catch { throw new AdoptionError("UNKNOWN", "EVIDENCE_CHANGED"); }
    requireAdoption(first.owner.stateFingerprint === last.owner.stateFingerprint && first.verifier.commandSha === last.verifier.commandSha
      && first.tree.fingerprint === last.tree.fingerprint && digest(readAdoptionFile(sealPath)) === request.anchor, "EVIDENCE_CHANGED", "UNKNOWN");
    // Read ownership again at publication, after the slower native/file inspections.
    requireAdoption(readOwner(seal).stateFingerprint === last.owner.stateFingerprint, "OWNER_CHANGED", "UNKNOWN");
    const binding = {
      ...seal, seal_sha256: request.anchor, dossier_id: request.dossierId, verifier: "sealed-report-v1",
      verifier_command_sha256: last.verifier.commandSha, review: { reviewer: true, qa: last.owner.requiredQa, owner: true },
      changed_paths: last.tree.paths,
      criteria: last.owner.issue.acceptance_criteria.map((text, index) => ({ id: "criterion-" + (index + 1), sha256: digest(text) })),
    };
    const package_id = "adoption-" + digest(JSON.stringify(binding));
    const reused = publishPackage(join(privateRoot, "reviews"), package_id,
      { outcome: "READY_FOR_HUMAN_REVIEW", package_id, binding }, (deps.now ?? (() => new Date()))());
    return { outcome: "READY_FOR_HUMAN_REVIEW", package_id, reused, elapsed_ms: Math.round(performance.now() - start) };
  } catch (error) {
    const outcome = error instanceof AdoptionError ? error.outcome : "UNKNOWN";
    const historical = args[0] === "prepare-historical";
    return { outcome, code: error instanceof AdoptionError ? error.code : historical ? "HISTORICAL_EVIDENCE_UNAVAILABLE" : "ADOPTION_EVIDENCE_UNAVAILABLE",
      next_action: historical ? "Inspect the named historical evidence and the original acceptance record."
        : outcome === "REFUSED" ? "Check the named binding against the current issue and sealed dossier." : "Inspect the retained evidence before a human decision." };
  }
}

export function sealedAdoptionExitCode(result: Outcome): number {
  return result.outcome === "REFUSED" ? 1 : result.outcome === "UNKNOWN" ? 2 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = runSealedAdoption(process.argv.slice(2), { root: process.cwd() });
  console.log(JSON.stringify(result));
  process.exitCode = sealedAdoptionExitCode(result);
}
