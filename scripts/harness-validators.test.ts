import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { cleanupSmoke, harnessTreeHash, observeResponse } from "./playwright-local-app-smoke";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const owned: string[] = [];
function fixture(hidden = false) {
  const root = mkdtempSync(join(tmpdir(), hidden ? ".surtec-harness-test-" : "surtec-harness-test-"));
  owned.push(root);
  for (const path of [".agents", "docs", "AGENTS.md", "package.json"]) cpSync(join(repository, path), join(root, path), { recursive: true });
  return root;
}
function run(root: string, script: string, ...args: string[]) {
  const result = spawnSync("pwsh", ["-NoProfile", "-File", join(repository, ".agents/scripts", script), "-RepoRoot", root, ...args], { encoding: "utf8", timeout: 20_000, shell: false });
  if (result.error) throw result.error;
  return { code: result.status, output: result.stdout + result.stderr };
}
function hideOwnedDirectory(root: string, path: string) {
  expect(owned).toContain(root);
  expect(path === root || path.startsWith(join(root, "/"))).toBe(true);
  const literal = "'" + path.replaceAll("'", "''") + "'";
  // Unix dot directories are already hidden; Windows needs the Hidden flag.
  // Change attributes only inside this test's unique disposable fixture.
  const result = spawnSync("pwsh", ["-NoProfile", "-Command", `$ErrorActionPreference = 'Stop'; $item = Get-Item -LiteralPath ${literal} -Force; if ($IsWindows) { $item.Attributes = $item.Attributes -bor [IO.FileAttributes]::Hidden }; if (-not ((Get-Item -LiteralPath ${literal} -Force).Attributes -band [IO.FileAttributes]::Hidden)) { throw 'Fixture directory is not hidden' }`], { encoding: "utf8", timeout: 20_000, shell: false });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
}
function spec(root: string) {
  const document = parse(readFileSync(join(root, ".agents/templates/entity.spec.yaml"), "utf8"));
  Object.assign(document, { name: "fixture", entity: "fixture", purpose: "Synthetic validator acceptance", domains: ["harness"] });
  document.requirements[0].description = "Check a harmless local invocation";
  Object.assign(document.designContract, { status: "approved", reviewedBy: "synthetic-test-human", approvedAt: "2026-09-29T12:00:00Z" });
  Object.assign(document.designContract.acceptanceChecks[0], { description: "Read runtime version", command: "node --version" });
  return document;
}
function save(root: string, document: ReturnType<typeof spec>) {
  writeFileSync(join(root, ".agents/specs/fixture.spec.yaml"), stringify(document));
}
const specPath = ".agents/specs/fixture.spec.yaml";
afterEach(() => { for (const root of owned.splice(0)) { rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false); } });

describe("native Harness validators", () => {
  it("checks the real structure without fabricating active specs or execution evidence", () => {
    const root = fixture();
    const artifacts = readdirSync(join(root, ".agents/specs"), { recursive: true }).map(String);
    const specs = artifacts.filter((path) => path.endsWith(".spec.yaml")).length;
    const tasks = artifacts.filter((path) => path.endsWith(".tasks.md")).length;
    const result = run(root, "check-harness.ps1");
    expect(result, result.output).toMatchObject({ code: 0 });
    expect(result.output).toContain(`${specs} structurally checked; 0 checks executed`);
    expect(result.output).toContain(`active tasks: ${tasks}`);
  }, 25_000);

  it.each(["hash", "version", "oversize", "unfinished"])("rejects snapshot %s drift", (kind) => {
    const root = fixture();
    const path = join(root, ".agents/cold-start/snapshots/file-state-contracts.snapshot.md");
    let raw = readFileSync(path, "utf8");
    if (kind === "hash") raw = raw.replace(/sourceHash: .+/, 'sourceHash: "wrong"');
    if (kind === "version") raw = raw.replace(/sourceVersion: .+/, 'sourceVersion: "9.0.0"');
    if (kind === "oversize") raw += "\nextra\nextra\n";
    if (kind === "unfinished") raw = raw.replace("## Must", "## Must [TODO: finish]");
    writeFileSync(path, raw);
    expect(run(root, "generate-snapshots.ps1", "-Check").code).toBe(1);
  }, 25_000);

  it("scaffolds only a new explicit draft, never overwrites or traverses", () => {
    const root = fixture(); const canonical = join(root, ".agents/cold-start/snapshots/file-state-contracts.snapshot.md");
    const before = readFileSync(canonical, "utf8");
    expect(run(root, "generate-snapshots.ps1", "-Scaffold", "-SkillName", "file-state-contracts").code).toBe(1);
    expect(run(root, "generate-snapshots.ps1", "-Scaffold", "-SkillName", "file-state-contracts", "-OutputPath", ".agents/cold-start/draft.snapshot.md").code).toBe(0);
    expect(readFileSync(join(root, ".agents/cold-start/draft.snapshot.md"), "utf8")).toContain("[TODO:");
    expect(run(root, "generate-snapshots.ps1", "-Scaffold", "-SkillName", "file-state-contracts", "-OutputPath", ".agents/cold-start/../escaped.snapshot.md").code).toBe(1);
    expect(readFileSync(canonical, "utf8")).toBe(before);
  }, 25_000);

  it("rejects route omission, unknown selection and union overflow; deduplicates extra reads", () => {
    const root = fixture();
    expect(run(root, "validate-budget.ps1", "-TaskClasses", "unknown-class").code).toBe(1);
    expect(run(root, "validate-budget.ps1", "-TaskClasses", "local-issues-acceptance,issue-lifecycle-contracts").code).toBe(1);
    expect(run(root, "validate-budget.ps1", "-TaskClasses", "explanation-status", "-ExtraArtifacts", "AGENTS.md,AGENTS.md").output).toContain("135/500");
    const path = join(root, ".agents/cold-start/budget-manifest.yaml");
    const manifest = parse(readFileSync(path, "utf8"));
    manifest.taskClasses.find((entry: { name: string }) => entry.name === "local-issues-acceptance").artifacts = [];
    writeFileSync(path, stringify(manifest));
    expect(run(root, "validate-budget.ps1").code).toBe(1);
  }, 25_000);

  it.each(["calendar", "markers", "duplicate", "reference", "coverage", "command", "case", "waiver", "schema"])("rejects invalid spec %s", (kind) => {
    const root = fixture(); const document = spec(root); const dc = document.designContract;
    if (kind === "calendar") dc.approvedAt = "2026-02-30T12:00:00Z";
    if (kind === "markers") document.purpose = "[NEEDS CLARIFICATION: scope]";
    if (kind === "duplicate") document.requirements.push({ ...document.requirements[0] });
    if (kind === "reference") dc.acceptanceChecks[0].requirementIds = ["req-unknown"];
    if (kind === "coverage") document.requirements.push({ id: "req-002", description: "Uncovered requirement" });
    if (kind === "command") dc.acceptanceChecks[0].command = "node --version; echo injected";
    if (kind === "case") dc.acceptanceChecks[0].command = "PNPM TYPECHECK";
    if (kind === "waiver") { dc.acceptanceChecks = []; dc.checksWaiver = { reason: "Manual", approvedBy: "synthetic" }; }
    if (kind === "schema") document.schema_version = 2;
    save(root, document);
    expect(run(root, "validate-spec.ps1").code).toBe(1);
  }, 25_000);

  it("requires both execution flags, refuses drafts/waiver-only and preflights the entire spec", () => {
    const root = fixture(); const document = spec(root); save(root, document);
    expect(run(root, "validate-spec.ps1", "-Run", "-SpecPath", specPath).code).toBe(1);
    document.designContract.status = "proposed"; save(root, document);
    expect(run(root, "validate-spec.ps1", "-Run", "-ConfirmExecution", "-SpecPath", specPath).code).toBe(1);
    document.designContract.status = "approved";
    document.designContract.acceptanceChecks.push({ ...document.designContract.acceptanceChecks[0], id: "ac-002", command: "forbidden" }); save(root, document);
    const invalid = run(root, "validate-spec.ps1", "-Run", "-ConfirmExecution", "-SpecPath", specPath);
    expect(invalid.code).toBe(1); expect(invalid.output).not.toContain("[OK] acceptance");
    document.designContract.acceptanceChecks = [];
    document.designContract.checksWaiver = { reason: "Subjective", approvedBy: "synthetic", date: "2026-09-29" }; save(root, document);
    expect(run(root, "validate-spec.ps1").code).toBe(0);
    expect(run(root, "validate-spec.ps1", "-Run", "-ConfirmExecution", "-SpecPath", specPath).code).toBe(1);
  }, 30_000);

  it("rejects malformed/duplicate YAML and clarification markers in comments", () => {
    const root = fixture(); const path = join(root, specPath); save(root, spec(root));
    const valid = readFileSync(path, "utf8");
    for (const invalid of ["schema_version: [", valid + "\nname: duplicate\n", valid + "\n# [NEEDS CLARIFICATION: hidden]\n"]) {
      writeFileSync(path, invalid); expect(run(root, "validate-spec.ps1").code).toBe(1);
    }
  }, 25_000);

  it("executes only an explicit benign check and rejects an unexpected exit", () => {
    const root = fixture(); const document = spec(root); save(root, document);
    const result = run(root, "validate-spec.ps1", "-Run", "-ConfirmExecution", "-SpecPath", specPath);
    expect(result, result.output).toMatchObject({ code: 0 }); expect(result.output).toContain("1 checks executed");
    document.designContract.acceptanceChecks[0].expectedExitCode = 1; save(root, document);
    expect(run(root, "validate-spec.ps1", "-Run", "-ConfirmExecution", "-SpecPath", specPath).code).toBe(1);
  }, 25_000);

  it("accepts an explicit 900-second public gate ceiling while retaining the 120-second default", () => {
    const validator = readFileSync(join(repository, ".agents/scripts/validate-spec.ps1"), "utf8");
    expect(validator.match(/\[int\]\$TimeoutSeconds\s*=\s*(\d+)/)?.[1]).toBe("120");
    const root = fixture(); save(root, spec(root));
    // node --version exits immediately; the existing 20-second launcher bound
    // proves accepting a 900-second ceiling does not wait for that duration.
    const result = run(root, "validate-spec.ps1", "-Run", "-ConfirmExecution", "-SpecPath", specPath, "-TimeoutSeconds", "900");
    expect(result, result.output).toMatchObject({ code: 0 }); expect(result.output).toContain("1 checks executed");
  }, 25_000);

  it.each(["0", "901"])("rejects public gate timeout %s before executing acceptance", (seconds) => {
    const root = fixture(); save(root, spec(root));
    const result = run(root, "validate-spec.ps1", "-Run", "-ConfirmExecution", "-SpecPath", specPath, "-TimeoutSeconds", seconds);
    expect(result.code).toBe(1); expect(result.output).toContain("TimeoutSeconds"); expect(result.output).not.toContain("[OK] acceptance");
  }, 25_000);

  it("refuses changed package implementations and lifecycle hooks", () => {
    const root = fixture(); const document = spec(root); document.designContract.acceptanceChecks[0].command = "pnpm typecheck"; save(root, document);
    const path = join(root, "package.json"); const pkg = JSON.parse(readFileSync(path, "utf8"));
    pkg.scripts.pretypecheck = "forbidden"; writeFileSync(path, JSON.stringify(pkg));
    expect(run(root, "validate-spec.ps1").code).toBe(1);
    delete pkg.scripts.pretypecheck; pkg.scripts.typecheck = "forbidden"; writeFileSync(path, JSON.stringify(pkg));
    expect(run(root, "validate-spec.ps1").code).toBe(1);
  }, 25_000);

  it("clears inherited injection/secrets and terminates a timed-out child", () => {
    const root = fixture();
    const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    const common = join(repository, ".agents/scripts/common.ps1");
    // Exercise the private primitive with fixed benign programs; specs cannot
    // supply these custom arguments through the public allowlisted entry point.
    const prefix = `. ${literal(common)}; `;
    const clean = spawnSync("pwsh", ["-NoProfile", "-Command", prefix + `$code = Invoke-HarnessCheck ${literal(root)} @{ Program = 'node'; Arguments = @('-e', 'if (process.env.HARNESS_TEST_SECRET || process.env.NODE_OPTIONS) process.exit(1)') } 5; exit $code`], {
      encoding: "utf8", timeout: 15_000, shell: false,
      env: { ...process.env, HARNESS_TEST_SECRET: "synthetic-sentinel", NODE_OPTIONS: "--invalid-fixture-option" },
    });
    expect(clean.error).toBeUndefined(); expect(clean.status, clean.stderr).toBe(0);
    const timed = spawnSync("pwsh", ["-NoProfile", "-Command", prefix + `try { Invoke-HarnessCheck ${literal(root)} @{ Program = 'node'; Arguments = @('-e', 'setTimeout(() => {}, 20000)') } 1; exit 0 } catch { Write-Output $_.Exception.Message; exit 1 }`], { encoding: "utf8", timeout: 15_000, shell: false });
    expect(timed.error).toBeUndefined(); expect(timed.status).toBe(1); expect(timed.stdout).toContain("process tree terminated");
  }, 30_000);

  it("rejects paths outside the namespace and linked artifacts", () => {
    const root = fixture(); save(root, spec(root));
    expect(run(root, "validate-spec.ps1", "-SpecPath", ".agents/templates/entity.spec.yaml").code).toBe(1);
    expect(run(root, "validate-spec.ps1", "-SpecPath", "../outside.spec.yaml").code).toBe(1);
    const source = join(root, ".agents/cold-start/snapshots/file-state-contracts.snapshot.md");
    const link = join(root, ".agents/specs/linked");
    symlinkSync(dirname(source), link, process.platform === "win32" ? "junction" : "dir");
    expect(run(root, "validate-budget.ps1", "-ExtraArtifacts", ".agents/specs/linked/file-state-contracts.snapshot.md").code).toBe(1);
    expect(existsSync(source)).toBe(true);
  }, 25_000);

  it("accepts a hidden artifact directory without executing acceptance", () => {
    const root = fixture(); save(root, spec(root)); hideOwnedDirectory(root, join(root, ".agents"));
    const before = readFileSync(join(root, specPath));
    const result = run(root, "validate-spec.ps1", "-SpecPath", specPath);
    expect(result, result.output).toMatchObject({ code: 0 }); expect(result.output).toContain("1 structurally checked; 0 checks executed");
    expect(readFileSync(join(root, specPath))).toEqual(before);
  }, 25_000);

  it("accepts a hidden repository root without executing acceptance", () => {
    const root = fixture(true); save(root, spec(root)); hideOwnedDirectory(root, root);
    const before = readFileSync(join(root, specPath));
    const result = run(root, "validate-spec.ps1", "-SpecPath", specPath);
    expect(result, result.output).toMatchObject({ code: 0 }); expect(result.output).toContain("1 structurally checked; 0 checks executed");
    expect(readFileSync(join(root, specPath))).toEqual(before);
  }, 25_000);

  it.each(["artifact", "repository-root"] as const)("rejects a hidden %s link rather than treating it as a missing directory", (kind) => {
    const root = fixture(); save(root, spec(root));
    const target = kind === "artifact" ? join(root, ".agents/specs") : root, link = join(root, kind === "artifact" ? ".agents/specs/.hidden-link" : ".hidden-link");
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir"); hideOwnedDirectory(root, link);
    const before = readFileSync(join(root, specPath));
    const result = kind === "artifact"
      ? run(root, "validate-budget.ps1", "-ExtraArtifacts", ".agents/specs/.hidden-link/fixture.spec.yaml")
      : run(link, "validate-spec.ps1", "-SpecPath", specPath);
    expect(result.code).toBe(1); expect(result.output).toContain(kind === "artifact" ? "Linked artifact path is not supported" : "Linked repository root is not supported");
    expect(result.output).not.toContain("[OK] acceptance"); expect(readFileSync(join(root, specPath))).toEqual(before);
  }, 25_000);

  it("checks task mappings, future targets, dependencies and completion without executing", () => {
    const root = fixture(); save(root, spec(root)); mkdirSync(join(root, ".agents/specs/tasks"), { recursive: true });
    const path = join(root, ".agents/specs/tasks/fixture.tasks.md");
    const header = '---\nspec: .agents/specs/fixture.spec.yaml\nfeature: fixture\nstatus: draft\ncreatedAt: "2026-09-29"\nreviewedBy: null\napprovedAt: null\n---\n## Phase 1\n<!-- maps to: ac-001 -->\n';
    const body = '- [ ] T001 Define fixture -> lib/future-fixture.ts\n- [ ] T002 (depends: T001) Verify fixture -> scripts/future-fixture.test.ts\n';
    writeFileSync(path, header + body);
    expect(run(root, "validate-tasks.ps1").code).toBe(0);
    for (const changed of [(header + body).replace("ac-001", "ac-missing"), header + body.replace("depends: T001", "depends: T003"), header + '- [ ] T001 [P] First -> lib/same.ts\n- [ ] T002 [P] Second -> lib/same.ts\n']) {
      writeFileSync(path, changed); expect(run(root, "validate-tasks.ps1").code).toBe(1);
    }
  }, 30_000);
});

describe("isolated browser smoke failure safety", () => {
  function workflowCleanupFixture() {
    const root = mkdtempSync(join(tmpdir(), "surtec-local-dashboard-")); owned.push(root);
    const outside = mkdtempSync(join(tmpdir(), "surtec-harness-test-")); owned.push(outside);
    // Cleanup canaries only: these bytes are never read as product records or authority.
    const evidence = new Map([
      ["state/workflows/workflows.json", '{"schema_version":1,"workflow_id":"synthetic-workflow","corrections_consumed":1}\n'],
      ["state/issues/issues.json", '{"schema_version":1,"candidate_id":"synthetic-candidate","status":"checking"}\n'],
      ["state/tasks/synthetic-task.json", '{"schema_version":2,"workflow_id":"synthetic-workflow","task_id":"synthetic-task"}\n'],
      ["projects/surtec-worktrees/synthetic-candidate/src/value.txt", "Synthetic retained candidate content.\n"],
      ["executor-effects.jsonl", '{"stage_id":"synthetic-stage","mode":"workspace-write-verify"}\n'],
    ]);
    for (const [path, bytes] of evidence) {
      mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes);
    }
    const sentinels: ReadonlyArray<readonly [string, string]> = [
      ["normal-state/sentinel.json", "Synthetic unrelated state must remain unchanged.\n"],
      ["sibling/src/value.txt", "Synthetic unrelated project must remain unchanged.\n"],
      ["dependencies/sentinel.txt", "Synthetic linked dependency must remain unchanged.\n"],
    ];
    for (const [path, bytes] of sentinels) {
      mkdirSync(dirname(join(outside, path)), { recursive: true }); writeFileSync(join(outside, path), bytes);
    }
    mkdirSync(join(root, "runtime"));
    symlinkSync(join(outside, "dependencies"), join(root, "runtime/node_modules"), process.platform === "win32" ? "junction" : "dir");
    const assertEvidenceRetained = () => {
      for (const [path, bytes] of evidence) expect(readFileSync(join(root, path))).toEqual(Buffer.from(bytes));
    };
    return { root, outside, evidence, assertEvidenceRetained };
  }

  it("excludes only the idle scheduling lock, never task/evidence records or unrelated locks", async () => {
    const root = mkdtempSync(join(tmpdir(), "surtec-harness-test-")); owned.push(root);
    mkdirSync(join(root, "locks")); mkdirSync(join(root, "tasks")); mkdirSync(join(root, "events"));
    const ignored = ["locks/orchestrator-schedule.lock"];
    const before = await harnessTreeHash(root, ignored);
    writeFileSync(join(root, ignored[0]!), "Synthetic idle scheduling lock");
    expect(await harnessTreeHash(root, ignored)).toBe(before);
    for (const path of ["tasks/synthetic.json", "events/synthetic.jsonl", "locks/synthetic.lock"]) {
      writeFileSync(join(root, path), "Synthetic observable effect");
      expect(await harnessTreeHash(root, ignored)).not.toBe(before);
      rmSync(join(root, path));
    }
  });

  it("handles the pending response rejection even when the browser action fails first", async () => {
    let rejectResponse!: (reason: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => { rejectResponse = reject; });
    const page = { waitForResponse: vi.fn().mockReturnValue(pending) };
    await expect(observeResponse(page, "/api/synthetic", "POST", async () => { throw new Error("Synthetic action failed"); })).rejects.toThrow("Synthetic action failed");
    rejectResponse(new Error("Page closed during cleanup"));
    await new Promise((resolveTick) => setImmediate(resolveTick));
    expect(page.waitForResponse).toHaveBeenCalledOnce();
  });

  it("attempts every close after an earlier close fails, retaining the workspace safely", async () => {
    const root = mkdtempSync(join(tmpdir(), "surtec-local-dashboard-")); owned.push(root);
    const browser = vi.fn(async () => { throw new Error("Synthetic close error"); });
    const vite = vi.fn(async () => {}), api = vi.fn(async () => true);
    const result = await cleanupSmoke({ browser, vite, api, root });
    expect(result).toMatchObject({ browser_closed: false, vite_closed: true, api_stopped: true, workspace_removed: false, failures: ["browser"] });
    expect(vite).toHaveBeenCalledOnce(); expect(api).toHaveBeenCalledOnce(); expect(existsSync(root)).toBe(true);
  });

  it("unlinks only its owned dependency junction and removes its stopped synthetic workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "surtec-local-dashboard-")); owned.push(root);
    const dependency = mkdtempSync(join(tmpdir(), "surtec-harness-test-")); owned.push(dependency);
    writeFileSync(join(dependency, "preserved.txt"), "Synthetic dependency remains untouched");
    mkdirSync(join(root, "runtime")); symlinkSync(dependency, join(root, "runtime/node_modules"), process.platform === "win32" ? "junction" : "dir");
    const result = await cleanupSmoke({ root, api: async () => true });
    expect(result).toMatchObject({ workspace_removed: true, api_stopped: true, failures: [] });
    expect(existsSync(root)).toBe(false); expect(readFileSync(join(dependency, "preserved.txt"), "utf8")).toBe("Synthetic dependency remains untouched");
  });

  it("removes workflow, candidate and effect evidence only after all owned resources close, preserving outside sentinels", async () => {
    const f = workflowCleanupFixture(), outsideBefore = await harnessTreeHash(f.outside), closed: string[] = [];
    const close = async (resource: string) => { f.assertEvidenceRetained(); closed.push(resource); };
    const result = await cleanupSmoke({ root: f.root, browser: () => close("browser"), vite: () => close("vite"), api: async () => { await close("api"); return true; } });
    expect(closed).toEqual(["browser", "vite", "api"]);
    expect(result).toEqual({ browser_closed: true, vite_closed: true, api_stopped: true, workspace_removed: true, failures: [] });
    expect(existsSync(f.root)).toBe(false);
    for (const path of f.evidence.keys()) expect(existsSync(join(f.root, path))).toBe(false);
    expect(await harnessTreeHash(f.outside)).toBe(outsideBefore);
  });

  it.each(["browser", "vite", "api"] as const)("retains exact workflow, candidate and effect bytes after %s close failure", async (failed) => {
    const f = workflowCleanupFixture(), outsideBefore = await harnessTreeHash(f.outside), closed: string[] = [];
    const close = async (resource: string) => {
      f.assertEvidenceRetained(); closed.push(resource);
      if (resource === failed) throw new Error("Synthetic owned resource close failure");
    };
    const result = await cleanupSmoke({ root: f.root, browser: () => close("browser"), vite: () => close("vite"), api: async () => { await close("api"); return true; } });
    expect(closed).toEqual(["browser", "vite", "api"]);
    expect(result).toEqual({ browser_closed: failed !== "browser", vite_closed: failed !== "vite", api_stopped: failed !== "api", workspace_removed: false, failures: [failed] });
    f.assertEvidenceRetained();
    expect(existsSync(join(f.root, "runtime/node_modules/sentinel.txt"))).toBe(true);
    expect(await harnessTreeHash(f.outside)).toBe(outsideBefore);
  });

  it("refuses broad/foreign roots and never deletes state while its API is still running", async () => {
    const root = mkdtempSync(join(tmpdir(), "surtec-local-dashboard-")); owned.push(root);
    expect(await cleanupSmoke({ root, api: async () => false })).toMatchObject({ api_stopped: false, workspace_removed: false });
    const foreign = fixture();
    expect(await cleanupSmoke({ root: foreign })).toMatchObject({ workspace_removed: false, failures: ["workspace"] });
    expect(await cleanupSmoke({ root: tmpdir() })).toMatchObject({ workspace_removed: false, failures: ["workspace"] });
    expect(existsSync(root) && existsSync(foreign)).toBe(true);
  });
});
