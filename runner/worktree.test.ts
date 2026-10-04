import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, linkSync, unlinkSync, statSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, commitAndDiff, inspectCandidateTree, listManagedWorktrees, pushBranch, removeWorktree } from "./worktree";
import { createTestingEvidence, sealTestingEvidence, evidenceHash } from "../lib/context/testing-evidence";
import type { TaskRecord } from "../lib/state/types";
import type { WorkflowCandidateBinding } from "../lib/workflows/types";
import { defaultTaskOrchestration } from "../lib/state/orchestration";

let dir: string;
let repo: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "surtec-wt-"));
  repo = join(dir, "myrepo");
  spawnSync("git", ["init", "-b", "main", repo], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "config", "user.email", "t@t.t"], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "config", "user.name", "t"], { encoding: "utf8" });
  writeFileSync(join(repo, "README.md"), "hi\n", "utf8");
  spawnSync("git", ["-C", repo, "add", "-A"], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "commit", "-m", "init"], { encoding: "utf8" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function installFixtureHook(name: string): void {
  const hooksPath = join(repo, ".git", "hooks");
  mkdirSync(hooksPath, { recursive: true });
  const hookPath = join(hooksPath, name);
  writeFileSync(hookPath, "#!/bin/sh\nprintf 'hook-ran' > hook-executed.txt\n", "utf8");
  chmodSync(hookPath, 0o755);
  spawnSync("git", ["-C", repo, "config", "core.hooksPath", hooksPath], { encoding: "utf8" });
}

describe("createWorktree", () => {
  it("starts a fresh correction at the exact prior candidate, not source HEAD", () => {
    const prior = createWorktree(repo, "STK-PRIOR", "backend-engineer");
    writeFileSync(join(prior.worktreePath, "README.md"), "prior candidate\n");
    const candidate = commitAndDiff(prior.worktreePath, "synthetic prior candidate");
    writeFileSync(join(repo, "source-only.txt"), "source HEAD differs\n");
    commitAndDiff(repo, "synthetic unrelated source commit");
    const correction = createWorktree(repo, "STK-CORRECTION", "backend-engineer", candidate.candidateRevision);
    expect(correction.worktreePath).not.toBe(prior.worktreePath);
    expect(readFileSync(join(correction.worktreePath, "README.md"), "utf8").replace(/\r\n/g, "\n")).toBe("prior candidate\n");
    expect(existsSync(join(correction.worktreePath, "source-only.txt"))).toBe(false);
    expect(createWorktree(repo, "STK-CORRECTION", "backend-engineer", candidate.candidateRevision)).toEqual(correction);
    writeFileSync(join(correction.worktreePath, "README.md"), "corrected candidate\n");
    commitAndDiff(correction.worktreePath, "synthetic correction");
    expect(() => createWorktree(repo, "STK-CORRECTION", "backend-engineer", candidate.candidateRevision)).toThrow(/exact candidate base/);
  });
  it.each(["main", "HEAD", "../other", "f".repeat(40)])("denies unavailable or non-exact correction base %s before creating a tree", (base) => {
    expect(() => createWorktree(repo, "STK-INVALID-BASE", "backend-engineer", base)).toThrow(/base revision/);
    expect(listManagedWorktrees(repo)).toEqual([]);
  });
  it("creates a worktree on a dedicated agent branch", () => {
    const { branch, worktreePath } = createWorktree(repo, "STK-1", "backend-engineer");
    expect(branch).toBe("agent/STK-1-backend-engineer");
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(worktreePath, "README.md"))).toBe(true);
  });

  it("returns the same managed worktree when a retry repeats creation", () => {
    const first = createWorktree(repo, "STK-1", "backend-engineer");
    const second = createWorktree(repo, "STK-1", "backend-engineer");

    expect(second).toEqual(first);
    expect(listManagedWorktrees(repo)).toEqual([first]);
  });

  it("does not execute a repository post-checkout hook while creating a managed worktree", () => {
    installFixtureHook("post-checkout");

    const { worktreePath } = createWorktree(repo, "STK-HOOK-1", "backend-engineer");

    expect(existsSync(join(worktreePath, "hook-executed.txt"))).toBe(false);
  });
});

describe("commitAndDiff", () => {
  it("commits edits and reports files + diffstat", () => {
    const { worktreePath } = createWorktree(repo, "STK-2", "a");
    writeFileSync(join(worktreePath, "new.txt"), "content\n", "utf8");
    const r = commitAndDiff(worktreePath, "agent STK-2");
    expect(r.committed).toBe(true);
    expect(r.filesChanged).toContain("new.txt");
    expect(r.diffstat).toContain("new.txt");
    expect(r.patch).toContain("+content");
    expect(r.patchTruncated).toBe(false);
    expect(r.baseRevision).toMatch(/^[a-f0-9]{40}$/);
    expect(r.candidateRevision).toMatch(/^[a-f0-9]{40}$/);
  });

  it("rejects out-of-scope staged paths before creating a commit", () => {
    const { worktreePath } = createWorktree(repo, "STK-SCOPE-1", "backend-engineer");
    const base = spawnSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(worktreePath, "secrets.txt"), "synthetic fixture\n", "utf8");

    expect(() => commitAndDiff(worktreePath, "out of scope", {
      validateChangedPaths: (paths) => { if (paths.includes("secrets.txt")) throw new Error("outside issue scope"); },
    })).toThrow("outside issue scope");

    const current = spawnSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    expect(current).toBe(base);
    expect(spawnSync("git", ["-C", worktreePath, "status", "--short"], { encoding: "utf8" }).stdout).toContain("secrets.txt");
  });

  it("reports no commit when there are no changes", () => {
    const { worktreePath } = createWorktree(repo, "STK-3", "a");
    const r = commitAndDiff(worktreePath, "agent STK-3");
    expect(r.committed).toBe(false);
    expect(r.filesChanged).toEqual([]);
    expect(r.diffstat).toBe("");
    expect(r.patch).toBe("");
    expect(r.patchTruncated).toBe(false);
  });

  it("does not execute repository pre-commit hooks during a managed commit", () => {
    const { worktreePath } = createWorktree(repo, "STK-HOOK-2", "backend-engineer");
    installFixtureHook("pre-commit");
    writeFileSync(join(worktreePath, "new.txt"), "content\n", "utf8");

    const result = commitAndDiff(worktreePath, "managed commit");

    expect(result.committed).toBe(true);
    expect(existsSync(join(worktreePath, "hook-executed.txt"))).toBe(false);
  });

  it("redacts credential-looking content from the captured commit patch", () => {
    const { worktreePath } = createWorktree(repo, "STK-REDACT-1", "backend-engineer");
    const syntheticCredential = `ghp_${"a".repeat(32)}`;
    writeFileSync(join(worktreePath, "fixture.txt"), `api_key=${syntheticCredential}\n`, "utf8");

    const result = commitAndDiff(worktreePath, "credential redaction fixture");

    expect(result.patch).not.toContain(syntheticCredential);
    expect(result.patch).toContain("[REDACTED]");
  });
});

describe("exact managed candidate tree inspection", () => {
  function fixture() {
    const info = createWorktree(repo, "T-candidate", "engineer");
    writeFileSync(join(info.worktreePath, "README.md"), "candidate contents\n");
    const committed = commitAndDiff(info.worktreePath, "synthetic candidate");
    const scope = { expected_outcome: "Candidate", acceptance_criteria: ["Candidate exists"], allowed_path_patterns: ["README.md"], excluded_path_patterns: [], allowed_change_categories: ["implementation"], explicit_exclusions: [] };
    const at = new Date().toISOString();
    const owner = { envelope: { id: "T-candidate", project: "myrepo", agent: "engineer", sandbox: "workspace-write", repo_path: repo,
      context_admission: { schema_version: 1, issue_id: "I-candidate", issue_revision: 1 },
      context_manifest: { fingerprint: "a".repeat(64), testing: { mode: "functional", commands: ["node verify.mjs"] } },
      metadata: { issue_scope_revision: 1, issue_authorized_scope: scope, run: { branch: info.branch, worktree_path: info.worktreePath, committed: true } } },
      lifecycle: "finished", outcome: "completed", created_at: at, finished_at: at, orchestration: { ...defaultTaskOrchestration(), attempts: 1, lease: null } } as unknown as TaskRecord;
    const candidate: WorkflowCandidateBinding = { candidate_id: "C-candidate", issue_id: "I-candidate", repository_id: "myrepo", task_id: owner.envelope.id, execution_id: "run-candidate", scope_revision: 1,
      base_revision: committed.baseRevision!, candidate_revision: committed.candidateRevision!, changed_paths: committed.filesChanged,
      diff_fingerprint: evidenceHash(`myrepo\0${committed.baseRevision}\0${committed.candidateRevision}\0${committed.filesChanged.join("\0")}`), content_fingerprint: evidenceHash(committed.patch), testing_evidence_fingerprint: "b".repeat(64) };
    const receipt = createTestingEvidence(owner, candidate.execution_id, { mode: "functional", runners: [{ stage: "functional", command: "node verify.mjs" }] });
    receipt.implementation = { started_at: at, finished_at: at, thread_id: "engineer-thread", turn_id: "engineer-turn" };
    receipt.candidate = { id: candidate.candidate_id, base_revision: candidate.base_revision, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint };
    receipt.observations = [{ stage: "functional", command_fingerprint: receipt.requirements[0]!.command_fingerprint, probe_fingerprint: null, assertions: [], outcome: "passed", exit_code: 0,
      started_at: at, finished_at: at, revision: candidate.candidate_revision, before_fingerprint: "c".repeat(64), after_fingerprint: "c".repeat(64) }];
    const { fingerprint: _fingerprint, ...unsigned } = receipt;
    owner.testing_evidence = sealTestingEvidence(unsigned); candidate.testing_evidence_fingerprint = owner.testing_evidence.fingerprint;
    return { info, owner, candidate };
  }
  it("selects the exact clean candidate, not the unchanged source checkout", () => {
    const { info, owner, candidate } = fixture();
    const view = inspectCandidateTree(repo, owner, candidate, dir);
    expect(view.worktreePath).toBe(info.worktreePath); expect(view.candidateRevision).toBe(candidate.candidate_revision);
    expect(view.contentFingerprint).toBe(candidate.content_fingerprint); expect(view.treeRevision).toMatch(/^[a-f0-9]{40}$/);
    expect(spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()).toBe(candidate.base_revision);
    expect(inspectCandidateTree(repo, owner, candidate, dir)).toEqual(view);
  });
  it.each(["dirty", "staged", "untracked", "ignored", "assume-unchanged", "skip-worktree", "new-commit"])("rejects %s mutation after a passing preflight", (mutation) => {
    const { info, owner, candidate } = fixture(); inspectCandidateTree(repo, owner, candidate, dir);
    if (["dirty", "staged", "new-commit"].includes(mutation)) writeFileSync(join(info.worktreePath, "README.md"), "changed after review\n");
    if (mutation === "staged") spawnSync("git", ["-C", info.worktreePath, "add", "README.md"]);
    if (mutation === "new-commit") commitAndDiff(info.worktreePath, "different candidate");
    if (mutation === "untracked") writeFileSync(join(info.worktreePath, "unowned.txt"), "unsealed");
    if (mutation === "ignored") { writeFileSync(join(repo, ".git/info/exclude"), "ignored.txt\n"); writeFileSync(join(info.worktreePath, "ignored.txt"), "hidden"); }
    if (mutation === "assume-unchanged" || mutation === "skip-worktree") {
      spawnSync("git", ["-C", info.worktreePath, "update-index", `--${mutation}`, "README.md"]); writeFileSync(join(info.worktreePath, "README.md"), "hidden change\n");
    }
    expect(() => inspectCandidateTree(repo, owner, candidate, dir)).toThrow(/Candidate/);
  });
  it.each(["lease", "running", "cancel", "failed", "missing-receipt", "receipt-run", "path", "branch", "repository", "base", "content", "paths", "diff"])("rejects %s ownership or content drift", (mutation) => {
    const { owner, candidate } = fixture();
    if (mutation === "lease") owner.orchestration!.lease = { run_id: "other", worker_id: "test", acquired_at: owner.created_at, heartbeat_at: owner.created_at, expires_at: owner.created_at };
    if (mutation === "running") owner.lifecycle = "running";
    if (mutation === "cancel") owner.orchestration!.cancel_requested_at = owner.created_at;
    if (mutation === "failed") owner.outcome = "needs-review";
    if (mutation === "missing-receipt") delete owner.testing_evidence;
    if (mutation === "receipt-run") candidate.execution_id = "unowned-run";
    if (mutation === "path") (owner.envelope.metadata.run as any).worktree_path = repo;
    if (mutation === "branch") (owner.envelope.metadata.run as any).branch = "main";
    if (mutation === "repository") owner.envelope.repo_path = dir;
    if (mutation === "base") candidate.base_revision = "f".repeat(40);
    if (mutation === "content") candidate.content_fingerprint = "f".repeat(64);
    if (mutation === "paths") candidate.changed_paths = ["not-in-candidate.txt"];
    if (mutation === "diff") candidate.diff_fingerprint = "f".repeat(64);
    expect(() => inspectCandidateTree(repo, owner, candidate, dir)).toThrow(/Candidate|binding/);
  });
  it("rejects a byte-identical hard link instead of reading unowned shared file content", () => {
    const { info, owner, candidate } = fixture(), path = join(info.worktreePath, "README.md"), shared = join(dir, "shared-fixture.txt");
    writeFileSync(shared, "candidate contents\n"); unlinkSync(path); linkSync(shared, path);
    expect(() => inspectCandidateTree(repo, owner, candidate, dir)).toThrow(/hard-linked/);
  });
  it("compares physical bytes even when stat-cache configuration could hide a same-size write", () => {
    const { info, owner, candidate } = fixture(), path = join(info.worktreePath, "README.md"), before = statSync(path);
    spawnSync("git", ["-C", info.worktreePath, "config", "core.trustctime", "false"]);
    spawnSync("git", ["-C", info.worktreePath, "config", "core.checkStat", "minimal"]);
    writeFileSync(path, "different contents\n"); utimesSync(path, before.atime, before.mtime);
    expect(() => inspectCandidateTree(repo, owner, candidate, dir)).toThrow(/physical content|dirty/);
  });
  it("rejects repository content filters before any filter program is run", () => {
    const { info, owner, candidate } = fixture();
    writeFileSync(join(repo, ".git/info/attributes"), "README.md filter=fixture-filter\n");
    spawnSync("git", ["-C", info.worktreePath, "config", "filter.fixture-filter.clean", "missing-synthetic-filter"]);
    expect(() => inspectCandidateTree(repo, owner, candidate, dir)).toThrow(/external content conversion/);
  });
});

describe("pushBranch", () => {
  it("pushes a branch to a configured origin", () => {
    const bare = join(dir, "remote.git");
    spawnSync("git", ["init", "--bare", bare], { encoding: "utf8" });
    spawnSync("git", ["-C", repo, "remote", "add", "origin", bare], { encoding: "utf8" });
    spawnSync("git", ["-C", repo, "checkout", "-b", "agent/x"], { encoding: "utf8" });
    writeFileSync(join(repo, "f.txt"), "x\n", "utf8");
    spawnSync("git", ["-C", repo, "add", "-A"], { encoding: "utf8" });
    spawnSync("git", ["-C", repo, "commit", "-m", "c"], { encoding: "utf8" });

    const r = pushBranch(repo, "agent/x");

    expect(r.pushed).toBe(true);
    const ls = spawnSync("git", ["-C", bare, "branch", "--list", "agent/x"], { encoding: "utf8" });
    expect(ls.stdout).toContain("agent/x");
  });

  it("returns pushed:false with an error when there is no remote", () => {
    const r = pushBranch(repo, "agent/missing");
    expect(r.pushed).toBe(false);
    expect(r.error && r.error.length > 0).toBe(true);
  });
});

describe("removeWorktree", () => {
  it("removes the worktree and branch idempotently", () => {
    const { branch, worktreePath } = createWorktree(repo, "STK-9", "a");
    expect(existsSync(worktreePath)).toBe(true);
    expect(listManagedWorktrees(repo)).toEqual([{ branch, worktreePath }]);

    removeWorktree(repo, worktreePath, branch);
    removeWorktree(repo, worktreePath, branch);

    expect(existsSync(worktreePath)).toBe(false);
    const ls = spawnSync("git", ["-C", repo, "branch", "--list", branch], { encoding: "utf8" });
    expect(ls.stdout.trim()).toBe("");
  });

  it("refuses to remove a path outside the managed root", () => {
    expect(() => removeWorktree(repo, join(dir, "outside"), "agent/safe"))
      .toThrow("worktree path escapes its allowed root");
  });

  it("refuses unmanaged branch names", () => {
    expect(() => removeWorktree(repo, join(dir, "surtec-worktrees", "x"), "main"))
      .toThrow("valid managed agent branch");
  });
});
