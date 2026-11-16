import type { HistoricalEvidence } from "../lib/workflows/historical-adoption";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkIssue } from "../lib/issues/types";
import { digest, type AdoptionOwner, type AdoptionSeal } from "../lib/workflows/sealed-adoption";
import { managedWorktreeIdentity } from "../runner/worktree";
import { runSealedAdoption, sealedAdoptionExitCode } from "./surtec-sealed-adoption";

const repoId = "fixture";
const issueId = "I-00000000-0000-4000-8000-000000000001";
const taskId = "T-fixture";
const agent = "fixture";
const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const native = { native_exit: 0, native_signal: null, root_exit_observed: true, stdout_eof: true, stderr_eof: true,
  timed_out: false, capture_truncated: false, termination_requested: false, spawn_error: null, stream_error: null };
const session = (i: number) => ({
  origin: "operator-observed-v1", id: "session-" + i, containerId: "container-" + i, database: "db-" + i, workspace: "workspace-" + i,
  apiPid: 10 + i, frontendPid: 20 + i, browserPid: 30 + i, apiPort: 1000 + i, frontendPort: 2000 + i, browserPort: 3000 + i,
  profile: "profile-" + i, facts: Object.fromEntries(["registration", "list", "item", "persistence", "purchased", "archive",
    "unauthenticated", "isolation", "noMocks", "dbConfirmed", "ownedClosure"].map((key) => [key, true])),
});
let root: string, source: string, worktree: string, branch: string, reviews: string, gitExecutable: string;
let base: string, commit: string, tree: string, index: string, report: Buffer, seal: AdoptionSeal;
let project: { repo_path: string; sandbox: string; allowed_agents: string[]; verify_commands: string[] };
const git = (cwd: string, ...args: string[]) => execFileSync(gitExecutable, ["--no-optional-locks", "-c", "core.autocrlf=false", "-C", cwd, ...args],
  { encoding: "utf8", windowsHide: true, timeout: 15_000 }).trim();

function dossier(id: string, bytes = report, update: Partial<AdoptionSeal> = {}) {
  const directory = join(root, "tmp", "sealed-adoption", "dossiers", id);
  mkdirSync(directory, { recursive: true });
  const data = json({ ...seal, ...update });
  writeFileSync(join(directory, "seal.json"), data);
  writeFileSync(join(directory, "report.json"), bytes);
  return { directory, args: ["prepare", "--issue-id", issueId, "--expected-revision", "5", "--dossier-id", id, "--seal-sha256", digest(data)] };
}
function owner(): AdoptionOwner {
  return { issue: { acceptance_criteria: ["Matches evidence"], authorized_scope: { allowed_path_patterns: ["README.md"], excluded_path_patterns: [] } } as unknown as WorkIssue,
    agent, repoPath: source, worktreePath: worktree, branch, requiredQa: true, stateFingerprint: digest("owned") };
}
function dependencies() { return { root, owner, project: () => project, now: () => new Date("2026-11-14T18:00:00Z") }; }
function reviewNames() { return existsSync(reviews) ? readdirSync(reviews).sort() : []; }

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "surtec-sealed-test-")));
  gitExecutable = realpathSync.native(execFileSync(process.platform === "win32" ? "where.exe" : "which",
    [process.platform === "win32" ? "git.exe" : "git"], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/)[0]!);
  source = join(root, repoId);
  mkdirSync(source);
  git(source, "init", "--quiet");
  git(source, "config", "core.autocrlf", "false");
  git(source, "config", "user.name", "Surtec Fixture");
  git(source, "config", "user.email", "surtec-fixture@example.invalid");
  git(source, "config", "commit.gpgsign", "false");
  writeFileSync(join(source, "README.md"), "base\n");
  git(source, "add", "--", "README.md");
  git(source, "commit", "--quiet", "-m", "fixture base");
  base = git(source, "rev-parse", "HEAD");
  ({ worktreePath: worktree, branch } = managedWorktreeIdentity(source, taskId, agent));
  mkdirSync(dirname(worktree));
  git(source, "worktree", "add", "--quiet", "-b", branch, worktree, base);
  writeFileSync(join(worktree, "README.md"), "sealed\n");
  git(worktree, "add", "--", "README.md");
  git(worktree, "commit", "--quiet", "-m", "fixture candidate");
  commit = git(worktree, "rev-parse", "HEAD");
  tree = git(worktree, "rev-parse", "HEAD^{tree}");
  index = git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "index");
  const oid = git(worktree, "rev-parse", "HEAD:README.md");
  report = json({ schema_version: 1, outcome: "PASS", reason: null, real_model_calls: false, successors_not_run: [], observation_errors: [],
    candidate: { commit, tree, fingerprint: digest(JSON.stringify([{ path: "README.md", oid }])), sealed: true },
    stages: Array.from({ length: 8 }, (_, index) => {
      if (index === 7) return { id: "V08", outcome: "PASS", sealed: true };
      const tests = index === 1 ? 82 : index === 5 ? 10 : 8;
      return { id: "V0" + (index + 1), outcome: "PASS", reason: null, native,
        coverage: { tests, passed: tests, failed: 0, skipped: 0, cancelled: 0, todo: 0, pending: 0 } };
    }), sessions: [session(1), session(2)] });
  const verifier = join(root, "verifier");
  mkdirSync(verifier);
  const entry = join(verifier, "verify-candidate.mjs"), contract = join(verifier, "verification-contract.json");
  const node = join(verifier, process.platform === "win32" ? "node.exe" : "node");
  writeFileSync(entry, "throw new Error('the verifier must not execute');\n");
  writeFileSync(node, "inert executable pin");
  writeFileSync(contract, json({ schema_version: 1, baseline_commit: base, pilot_root: source, allowlist: ["README.md"],
    required_frontend_tests: 82, required_backend_tests: 10, tools: { git: { executable: gitExecutable } } }));
  const pins = json({ schema_version: 1, contract_sha256: digest(readFileSync(contract)),
    files: [entry, contract, node, gitExecutable].map((path) => ({ path, sha256: digest(readFileSync(path)) })) });
  writeFileSync(join(verifier, "verifier-pins.json"), pins);
  seal = { schema_version: 1, issue_id: issueId, issue_revision: 5, scope_revision: 2, scope_sha256: digest("scope"),
    project_id: repoId, workflow_id: "WF-fixture", stage_id: "ST-fixture", task_id: taskId, run_id: "R-fixture",
    plan_sha256: digest("plan"), review_policy_sha256: digest("review"), testing_policy_sha256: digest("testing"),
    base, commit, tree, report_sha256: digest(report), verifier_pins_sha256: digest(pins) };
  project = { repo_path: source, sandbox: "workspace-write", allowed_agents: [agent],
    verify_commands: ['"' + node + '" "' + entry + '" --pins-sha256 ' + seal.verifier_pins_sha256] };
  reviews = join(root, "tmp", "sealed-adoption", "reviews");
}, 15_000);

afterAll(() => {
  if (root && dirname(root) === realpathSync.native(tmpdir())) rmSync(root, { recursive: true, force: true });
});

describe("sealed adoption CLI on isolated Git", () => {
  it("prepares the exact package once, revalidates before reuse, and preserves source and dossier bytes", () => {
    const fixture = dossier("valid");
    const indexBytes = readFileSync(index);
    const sealBytes = readFileSync(join(fixture.directory, "seal.json"));
    const first = runSealedAdoption(fixture.args, dependencies());
    expect(first).toMatchObject({ outcome: "READY_FOR_HUMAN_REVIEW", reused: false, elapsed_ms: expect.any(Number) });
    if (first.outcome !== "READY_FOR_HUMAN_REVIEW") throw new Error(JSON.stringify(first));
    expect(sealedAdoptionExitCode(first)).toBe(0);
    const path = join(reviews, first.package_id + ".json"), bytes = readFileSync(path);
    expect(JSON.parse(bytes.toString())).toMatchObject({ binding: { commit, tree, base, issue_id: issueId, run_id: seal.run_id,
      report_sha256: digest(report), changed_paths: ["README.md"], criteria: [{ id: "criterion-1" }], review: { qa: true, owner: true } } });
    expect(runSealedAdoption(fixture.args, dependencies())).toMatchObject({ package_id: first.package_id, reused: true });
    expect(readFileSync(path)).toEqual(bytes);
    expect(readFileSync(index)).toEqual(indexBytes);
    expect(readFileSync(join(fixture.directory, "seal.json"))).toEqual(sealBytes);
    expect(readFileSync(join(fixture.directory, "report.json"))).toEqual(report);
    expect(git(source, "rev-parse", "HEAD")).toBe(base);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(commit);
    writeFileSync(join(fixture.directory, "report.json"), "{}\n");
    expect(runSealedAdoption(fixture.args, dependencies())).toMatchObject({ outcome: "REFUSED", code: "REPORT_SHA256_MISMATCH" });
    expect(readFileSync(path)).toEqual(bytes);
  }, 20_000);

  it("rejects one staged byte with the report intact", () => {
    const fixture = dossier("changed-tree"), before = reviewNames(), file = join(worktree, "README.md");
    const original = readFileSync(file);
    const changed = Buffer.from(original);
    changed[0] = 0x53;
    expect([...original].filter((byte, index) => byte !== changed[index])).toHaveLength(1);
    try {
      writeFileSync(file, changed);
      git(worktree, "add", "--", "README.md");
      const result = runSealedAdoption(fixture.args, dependencies());
      expect(result).toMatchObject({ outcome: "REFUSED", code: "TREE_MISMATCH" });
      expect(sealedAdoptionExitCode(result)).toBe(1);
      expect(reviewNames()).toEqual(before);
    } finally {
      writeFileSync(file, original);
      git(worktree, "add", "--", "README.md");
    }
  }, 15_000);

  it("rejects an otherwise identical report with one changed whitespace byte", () => {
    const changed = Buffer.from(report);
    changed[report.indexOf(0x0a)] = 0x20;
    expect(JSON.parse(changed.toString())).toEqual(JSON.parse(report.toString()));
    const before = reviewNames();
    expect(runSealedAdoption(dossier("changed-report", changed).args, dependencies())).toMatchObject({ outcome: "REFUSED", code: "REPORT_SHA256_MISMATCH" });
    expect(reviewNames()).toEqual(before);
  }, 15_000);

  it("rejects a re-anchored swapped report, a changed pin and an excluded path", () => {
    const before = reviewNames(), swap = JSON.parse(report.toString());
    swap.candidate.commit = "b".repeat(40);
    const swapped = json(swap);
    expect(runSealedAdoption(dossier("swapped", swapped, { report_sha256: digest(swapped) }).args, dependencies()))
      .toMatchObject({ outcome: "REFUSED", code: "REPORT_CANDIDATE_MISMATCH" });
    const fixture = dossier("policy");
    const mismatch = { ...dependencies(), project: () => ({ ...project, verify_commands: [project.verify_commands[0]!.slice(0, -64) + "f".repeat(64)] }) };
    expect(runSealedAdoption(fixture.args, mismatch)).toMatchObject({ outcome: "REFUSED", code: "VERIFIER_BINDING_MISMATCH" });
    const excluded = () => {
      const value = owner();
      value.issue.authorized_scope.excluded_path_patterns = ["README.md"];
      return value;
    };
    expect(runSealedAdoption(fixture.args, { ...dependencies(), owner: excluded })).toMatchObject({ outcome: "REFUSED", code: "PATH_OUTSIDE_SCOPE" });
    expect(reviewNames()).toEqual(before);
  }, 20_000);

  it("fails closed on an unstable owner and on a linked dossier file", () => {
    const before = reviewNames();
    const unstable = dossier("unstable");
    let reads = 0;
    const result = runSealedAdoption(unstable.args, { ...dependencies(), owner: () => ({ ...owner(), stateFingerprint: digest(String(++reads)) }) });
    expect(result).toMatchObject({ outcome: "UNKNOWN", code: "EVIDENCE_CHANGED" });
    expect(sealedAdoptionExitCode(result)).toBe(2);
    const linked = dossier("linked");
    linkSync(join(linked.directory, "report.json"), join(linked.directory, "linked-report.json"));
    expect(runSealedAdoption(linked.args, dependencies())).toMatchObject({ outcome: "REFUSED", code: "UNSAFE_PATH" });
    expect(reviewNames()).toEqual(before);
  }, 20_000);

  it("treats incomplete native or session evidence as unknown and preserves an incomplete package", () => {
    const before = reviewNames(), incomplete = JSON.parse(report.toString());
    incomplete.stages[0].native.stdout_eof = false;
    const bytes = json(incomplete);
    expect(runSealedAdoption(dossier("incomplete", bytes, { report_sha256: digest(bytes) }).args, dependencies()))
      .toMatchObject({ outcome: "UNKNOWN", code: "REPORT_NATIVE_INCOMPLETE" });
    incomplete.stages[0].native.stdout_eof = true;
    incomplete.sessions[1].browserPid = incomplete.sessions[0].browserPid;
    const sessions = json(incomplete);
    expect(runSealedAdoption(dossier("sessions", sessions, { report_sha256: digest(sessions) }).args, dependencies()))
      .toMatchObject({ outcome: "UNKNOWN", code: "REPORT_SESSIONS_INCOMPLETE" });
    expect(reviewNames()).toEqual(before);
    const fixture = dossier("package-conflict");
    const first = runSealedAdoption(fixture.args, dependencies());
    if (first.outcome !== "READY_FOR_HUMAN_REVIEW") throw new Error(JSON.stringify(first));
    const path = join(reviews, first.package_id + ".json");
    writeFileSync(path, "{}");
    expect(runSealedAdoption(fixture.args, dependencies())).toMatchObject({ outcome: "UNKNOWN", code: "PACKAGE_CONFLICT" });
    expect(readFileSync(path, "utf8")).toBe("{}");
  }, 20_000);
});

describe("historical adoption CLI on isolated Git", () => {
  let history: HistoricalEvidence;
  const args = ["prepare-historical", "--profile", "gear-list-f5", "--seal-sha256", "a".repeat(64), "--acceptance-sha256", "b".repeat(64)];
  const historicalDeps = () => ({ ...dependencies(), historicalEvidence: () => history,
    project: () => { throw new Error("Historical evidence must not resolve through live project policy"); },
    owner: () => { throw new Error("Historical evidence must not load the live issue"); } });
  const output = () => join(root, "tmp", "sealed-adoption", "historical-reviews");
  const names = () => existsSync(output()) ? readdirSync(output()).sort() : [];
  const indexOf = (cwd: string) => git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "index");

  beforeAll(() => {
    const originalTask = "T-history";
    const retained = managedWorktreeIdentity(source, originalTask, agent);
    const parent = dirname(retained.worktreePath);
    const prior = join(parent, "prior-adopted");
    const corrected = join(parent, "corrected-adopted");
    git(source, "worktree", "add", "--quiet", "-b", retained.branch, retained.worktreePath, base);
    writeFileSync(join(retained.worktreePath, "README.md"), "sealed\n");
    git(retained.worktreePath, "add", "--", "README.md");
    git(source, "worktree", "add", "--quiet", "--detach", prior, commit);
    git(source, "worktree", "add", "--quiet", "--detach", corrected, commit);
    writeFileSync(join(corrected, "README.md"), "corrected\n");
    git(corrected, "add", "--", "README.md");
    git(corrected, "commit", "--quiet", "-m", "fixture correction");
    const correctedCommit = git(corrected, "rev-parse", "HEAD"), correctedTree = git(corrected, "rev-parse", "HEAD^{tree}");
    const fixedReport = JSON.parse(report.toString());
    const fixedOid = git(corrected, "rev-parse", "HEAD:README.md");
    fixedReport.candidate = { commit: correctedCommit, tree: correctedTree, sealed: true,
      fingerprint: digest(JSON.stringify([{ path: "README.md", oid: fixedOid }])) };
    const fixedBytes = json(fixedReport);
    history = { id: "gear-list-f5", source, commonDir: join(source, ".git"), worktreeParent: parent,
      git: { executable: gitExecutable, sha256: digest(readFileSync(gitExecutable)) }, base,
      original: { worktree: retained.worktreePath, branch: retained.branch, indexSha: digest(readFileSync(indexOf(retained.worktreePath))), taskId: originalTask, agent },
      project: "gear-list-app", issueId, workflowId: "WF-historical", runId: "R-historical", scope: owner().issue.authorized_scope,
      paths: ["README.md"], correctionPaths: ["README.md"],
      prior: { worktree: prior, commit, tree, dossierSha: digest("prior dossier"), reportSha: digest(report), report },
      corrected: { worktree: corrected, commit: correctedCommit, tree: correctedTree, dossierSha: digest("corrected dossier"),
        reportSha: digest(fixedBytes), report: fixedBytes },
      verification: { frontend: 82, backend: 10, verifierSha: digest("historical pins") },
      acceptanceSha: digest("original acceptance"), evidenceSha: digest("historical evidence"),
      acceptance: { status: "ACCEPTED_LOCALLY", recorded_at_utc: "2026-11-13T00:35:19.614Z",
        criteria: [{ id: "F3-01", decision: "accepted" }], phases: { F3: "closed", F5: "closed" },
        integration: { status: "not_performed", f4_n11: "not_applicable" } },
    };
  }, 15_000);

  it("revalidates both committed trees and the retained index and returns byte-identical receipts", () => {
    const locations = [history.original.worktree, history.prior.worktree, history.corrected.worktree];
    const tracked = locations.map((path) => ({ index: readFileSync(indexOf(path)), text: readFileSync(join(path, "README.md")) }));
    const gitObjects = git(source, "count-objects", "-v");
    const originalReport = Buffer.from(history.corrected.report);
    const result = runSealedAdoption(args, historicalDeps());
    expect(result).toMatchObject({ outcome: "HISTORICAL_ACCEPTANCE_REVALIDATED", reused: false });
    if (result.outcome !== "HISTORICAL_ACCEPTANCE_REVALIDATED") throw new Error(JSON.stringify(result));
    expect(sealedAdoptionExitCode(result)).toBe(0);
    const path = join(output(), result.receipt_id + ".json"), before = readFileSync(path);
    expect(JSON.parse(before.toString())).toMatchObject({ binding: { base, adopted_commit: commit, commit: history.corrected.commit,
      tree: history.corrected.tree, acceptance_sha256: history.acceptanceSha, acceptance: history.acceptance } });
    expect(runSealedAdoption(args, { ...historicalDeps(), now: () => new Date("2026-11-15T18:00:00Z") }))
      .toMatchObject({ outcome: "HISTORICAL_ACCEPTANCE_REVALIDATED", receipt_id: result.receipt_id, reused: true });
    expect(readFileSync(path)).toEqual(before);
    expect(names()).toEqual([result.receipt_id + ".json"]);
    expect(history.corrected.report).toEqual(originalReport);
    expect(git(source, "count-objects", "-v")).toBe(gitObjects);
    expect(locations.map((cwd) => ({ index: readFileSync(indexOf(cwd)), text: readFileSync(join(cwd, "README.md")) }))).toEqual(tracked);
  }, 30_000);

  it("refuses a changed report byte, a different parent, and a non-detached substitute", () => {
    const before = names(), edited = Buffer.from(history.corrected.report);
    edited[edited.indexOf(0x0a)] = 0x20;
    expect(JSON.parse(edited.toString())).toEqual(JSON.parse(history.corrected.report.toString()));
    expect(runSealedAdoption(args, { ...historicalDeps(), historicalEvidence: () => ({ ...history, corrected: { ...history.corrected, report: edited } }) }))
      .toMatchObject({ outcome: "REFUSED", code: "REPORT_SHA256_MISMATCH" });
    expect(runSealedAdoption(args, { ...historicalDeps(), historicalEvidence: () => ({ ...history, base: history.prior.commit }) }))
      .toMatchObject({ outcome: "REFUSED", code: "HISTORICAL_INDEX_MISMATCH" });
    expect(runSealedAdoption(args, { ...historicalDeps(), historicalEvidence: () => ({ ...history, corrected: { ...history.corrected, worktree } }) }))
      .toMatchObject({ outcome: "REFUSED", code: "WORKTREE_BINDING_MISMATCH" });
    expect(names()).toEqual(before);
  }, 30_000);

  it("refuses physical drift and unknown evidence for the existing receipt", () => {
    const before = names(), path = join(history.corrected.worktree, "README.md"), pristine = readFileSync(path);
    const changed = Buffer.from(pristine);
    changed[0]! ^= 0x20;
    try {
      writeFileSync(path, changed);
      expect(runSealedAdoption(args, historicalDeps())).toMatchObject({ outcome: "REFUSED", code: "TREE_MISMATCH" });
    } finally { writeFileSync(path, pristine); }
    let calls = 0;
    const unstable = runSealedAdoption(args, { ...historicalDeps(), historicalEvidence: () => ({ ...history, evidenceSha: digest(String(++calls)) }) });
    expect(unstable).toMatchObject({ outcome: "UNKNOWN", code: "HISTORICAL_EVIDENCE_CHANGED" });
    expect(sealedAdoptionExitCode(unstable)).toBe(2);
    expect(names()).toEqual(before);
  }, 30_000);

  it("refuses out-of-scope evidence and preserves an incomplete historical receipt", () => {
    const before = names(), receipt = join(output(), before[0]!);
    const original = readFileSync(receipt);
    const forbidden = { ...history, scope: { ...history.scope, excluded_path_patterns: ["README.md"] } };
    expect(runSealedAdoption(args, { ...historicalDeps(), historicalEvidence: () => forbidden }))
      .toMatchObject({ outcome: "REFUSED", code: "HISTORICAL_SCOPE_MISMATCH" });
    try {
      writeFileSync(receipt, "{}");
      expect(runSealedAdoption(args, historicalDeps())).toMatchObject({ outcome: "UNKNOWN", code: "PACKAGE_CONFLICT" });
      expect(readFileSync(receipt, "utf8")).toBe("{}");
    } finally { writeFileSync(receipt, original); }
    expect(names()).toEqual(before);
  }, 30_000);

  it("rejects a linked historical seal and an unavailable dossier", () => {
    const original = dossier("historical-link");
    const sealPath = join(root, "tmp", "f3-fix", "seal.json");
    mkdirSync(dirname(sealPath), { recursive: true });
    try {
      expect(runSealedAdoption(args, { root })).toMatchObject({ outcome: "UNKNOWN", code: "HISTORICAL_EVIDENCE_UNAVAILABLE" });
      linkSync(join(original.directory, "seal.json"), sealPath);
      expect(runSealedAdoption(args, { root })).toMatchObject({ outcome: "REFUSED", code: "UNSAFE_PATH" });
    } finally {
      if (existsSync(sealPath)) rmSync(sealPath);
    }
  });

  it("keeps the historical profile closed and refuses it at the daily entry point", () => {
    expect(runSealedAdoption(args.slice(0, 3), historicalDeps())).toMatchObject({ outcome: "REFUSED", code: "INVALID_ARGUMENTS" });
    expect(runSealedAdoption(args.map(value => value === "gear-list-f5" ? "another-pilot" : value), historicalDeps())).toMatchObject({ outcome: "REFUSED", code: "INVALID_ARGUMENTS" });
    expect(runSealedAdoption([...args.slice(0, -1), "invalid"], historicalDeps())).toMatchObject({ outcome: "REFUSED", code: "INVALID_ARGUMENTS" });
    expect(runSealedAdoption(["prepare", "--profile", "gear-list-f5"], historicalDeps())).toMatchObject({ outcome: "REFUSED", code: "INVALID_ARGUMENTS" });
  });
});
