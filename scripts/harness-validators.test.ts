import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { assertWorkflowPreviewIssue, cleanupSmoke, harnessTreeHash, ISSUE_REFRESH_PATHS, observeIssueRefresh, observeResponse,
  nodeApiFailure, observeNodeApi, selectRefreshedWorkflowIssue, trackBrowserApiReads } from "./playwright-local-app-smoke";
import { createBudgetProxyTrace, settleWorkflowPanels } from "./playwright-local-app-smoke";
import { captureUnchargedFixtureNative, requestUnchargedFixture, type UnchargedFixtureAction } from "./playwright-local-app-smoke";
import { assertOperatingFixtureRoot, isOperatingOfflineAsset, operatingConsoleCategory, operatingFailureLocation, operatingFailureSummary, operatingSmokeEnvironment, parseOperatingReady } from "./playwright-operating-views-smoke";

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
describe("F4 T005 node API failure capture", () => {
  it.each(["response", "body"] as const)("binds the exact %s failure without copying private URL/error content", async (phase) => {
    const error = new DOMException("PRIVATE-TOKEN and PRIVATE-BODY", "TimeoutError"), read = vi.fn().mockRejectedValue(error);
    await expect(observeNodeApi("GET", "http://private-user:PRIVATE-PASSWORD@localhost/api/workflows/PRIVATE-ID?token=PRIVATE-QUERY#PRIVATE-FRAGMENT", 30000, phase, read)).rejects.toBe(error);
    expect(read).toHaveBeenCalledOnce();
    expect(nodeApiFailure(error)).toEqual({ schema_version: 1, method: "GET", path: "/api/workflows/:id", phase, timeout_ms: 30000 });
    expect(JSON.stringify(nodeApiFailure(error))).not.toContain("PRIVATE");
    expect(Object.isFrozen(nodeApiFailure(error))).toBe(true);
  });
  it("returns successful reads unchanged without fabricating a failure", async () => {
    const result = { observed: true }, read = vi.fn().mockResolvedValue(result);
    await expect(observeNodeApi("POST", "http://localhost/api/work-issues/opaque/dispatch", 5000, "response", read)).resolves.toBe(result);
    expect(read).toHaveBeenCalledOnce(); expect(nodeApiFailure(result)).toBeNull();
  });
  it("keeps an unclassified or malformed route private without masking the operation error", async () => {
    for (const url of ["PRIVATE invalid URL", "http://localhost/api/PRIVATE-UNKNOWN?secret=PRIVATE"]) {
      const error = new Error("PRIVATE operation");
      await expect(observeNodeApi("GET", url, Infinity, "body", async () => { throw error; })).rejects.toBe(error);
      expect(nodeApiFailure(error)).toEqual({ schema_version: 1, method: "GET", path: "/api/:unknown", phase: "body", timeout_ms: null });
      expect(JSON.stringify(nodeApiFailure(error))).not.toContain("PRIVATE");
    }
  });
  it("preserves primitive rejection identity without inventing an error binding", async () => {
    await expect(observeNodeApi("GET", "http://localhost/api/tasks/opaque", 5000, "response", async () => { throw "synthetic rejection"; })).rejects.toBe("synthetic rejection");
    expect(nodeApiFailure("synthetic rejection")).toBeNull(); expect(nodeApiFailure(null)).toBeNull();
  });
  it("keeps the first error-bound operation when the same error propagates through another observation", async () => {
    const error = new Error("synthetic failure");
    await expect(observeNodeApi("POST", "http://localhost/api/workflows/opaque/decision", 30000, "response", () => observeNodeApi("GET", "http://localhost/api/tasks/opaque/detail", 5000, "body", async () => { throw error; }))).rejects.toBe(error);
    expect(nodeApiFailure(error)).toEqual({ schema_version: 1, method: "GET", path: "/api/tasks/:id/detail", phase: "body", timeout_ms: 5000 });
  });
});
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

  it("accepts the full offline eval catalog and refuses a script that omits organizational checks", () => {
    const root = fixture(); const document = spec(root); document.designContract.acceptanceChecks[0].command = "pnpm evals:check"; save(root, document);
    const accepted = run(root, "validate-spec.ps1");
    expect(accepted.code, accepted.output).toBe(0);
    expect(accepted.output).toContain("0 checks executed");
    const path = join(root, "package.json"); const pkg = JSON.parse(readFileSync(path, "utf8"));
    pkg.scripts["evals:check"] = "tsx scripts/run-evals.ts && tsx scripts/run-outcome-evals.ts";
    writeFileSync(path, JSON.stringify(pkg));
    const refused = run(root, "validate-spec.ps1");
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("Package check implementation has changed; review the catalog");
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

  it("excludes only the two exact idle worker locks, never maintenance evidence or unrelated locks", async () => {
    const root = mkdtempSync(join(tmpdir(), "surtec-harness-test-")); owned.push(root);
    mkdirSync(join(root, "locks")); mkdirSync(join(root, "tasks")); mkdirSync(join(root, "events"));
    mkdirSync(join(root, "maintenance/owners"), { recursive: true });
    const ignored = ["locks/orchestrator-schedule.lock", "maintenance/boundary.lock"];
    const before = await harnessTreeHash(root, ignored);
    writeFileSync(join(root, ignored[0]!), "Synthetic idle scheduling lock");
    expect(await harnessTreeHash(root, ignored)).toBe(before);
    writeFileSync(join(root, ignored[1]!), "Synthetic idle root boundary lock");
    expect(await harnessTreeHash(root, ignored)).toBe(before);
    for (const path of ["tasks/synthetic.json", "events/synthetic.jsonl", "locks/synthetic.lock", "locks/portfolio-profiles.lock",
      "maintenance/control.json", "maintenance/owners/synthetic.json", "maintenance/boundary.lock.other"]) {
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

describe("isolated browser smoke read synchronization", () => {
  const trackers: ReturnType<typeof trackBrowserApiReads>[] = [];
  const turn = () => new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  const request = (method = "GET", path = "/api/portfolio/profiles", errorText = "net::ERR_CONNECTION_RESET") => ({
    method: () => method, url: () => `http://127.0.0.1:1234${path}`, failure: () => ({ errorText }),
  });
  function setup() {
    const page = new EventEmitter();
    const tracker = trackBrowserApiReads(page as unknown as Parameters<typeof trackBrowserApiReads>[0]);
    trackers.push(tracker); return { page, tracker };
  }
  afterEach(() => { for (const tracker of trackers.splice(0)) tracker.dispose(); vi.useRealTimers(); });

  it("drains pending and response-triggered GETs, ignoring static resources and POSTs", async () => {
    const { page, tracker } = setup(), first = request(), next = request("GET", "/api/organization");
    const capture = vi.fn(async () => "stable");
    page.emit("request", first); page.emit("request", request("POST")); page.emit("request", request("GET", "/style.css"));
    const pending = tracker.snapshot(capture);
    await turn(); expect(capture).not.toHaveBeenCalled();
    page.emit("requestfinished", first);
    queueMicrotask(() => page.emit("request", next));
    await turn(); expect(capture).not.toHaveBeenCalled();
    page.emit("requestfinished", next);
    await expect(pending).resolves.toBe("stable"); expect(capture).toHaveBeenCalledOnce();
  });

  it("recaptures only when a GET begins during the capture, not when a POST begins", async () => {
    const { page, tracker } = setup(), read = request();
    const capture = vi.fn(async () => {
      if (capture.mock.calls.length === 1) { page.emit("request", read); queueMicrotask(() => page.emit("requestfinished", read)); }
      return capture.mock.calls.length;
    });
    await expect(tracker.snapshot(capture)).resolves.toBe(2); expect(capture).toHaveBeenCalledTimes(2);
    const writeCapture = vi.fn(async () => { page.emit("request", request("POST")); return "observable write effects remain in the result"; });
    await expect(tracker.snapshot(writeCapture)).resolves.toBe("observable write effects remain in the result");
    expect(writeCapture).toHaveBeenCalledOnce();
  });

  it("drains before navigation instead of swallowing cancelled API reads", async () => {
    const { page, tracker } = setup(), read = request(), navigate = vi.fn(async () => {});
    page.emit("request", read);
    const navigation = tracker.navigate(navigate);
    await turn(); expect(navigate).not.toHaveBeenCalled();
    page.emit("requestfinished", read); await navigation; expect(navigate).toHaveBeenCalledOnce();
    page.emit("request", read); page.emit("requestfailed", read);
    await expect(tracker.drain()).rejects.toThrow("Browser API read failed");
  });

  it("uses context terminal events even when the page misses them, counting only owned navigation aborts", async () => {
    const { page: context, tracker } = setup(), read = request("GET", "/api/budgets", "net::ERR_ABORTED");
    const page = new EventEmitter(), pageFailed = vi.fn(); page.on("requestfailed", pageFailed);
    await expect(tracker.navigate(async () => {
      context.emit("request", read); context.emit("requestfailed", read); return "navigation completed";
    })).resolves.toBe("navigation completed");
    expect(pageFailed).not.toHaveBeenCalled(); expect(tracker.cancelledReads()).toBe(1);
    await expect(tracker.snapshot(async () => "complete effect hash, not an API success receipt")).resolves.toBe("complete effect hash, not an API success receipt");
  });

  it("rejects connection failures during owned navigation and aborts outside or after that navigation", async () => {
    for (const scenario of ["connection-during", "abort-outside", "abort-after"] as const) {
      const { page: context, tracker } = setup();
      const read = request("GET", "/api/budgets", scenario === "connection-during" ? "net::ERR_CONNECTION_RESET" : "net::ERR_ABORTED");
      if (scenario === "connection-during") {
        await expect(tracker.navigate(async () => { context.emit("request", read); context.emit("requestfailed", read); })).rejects.toThrow("Browser API read failed");
      } else {
        if (scenario === "abort-after") await tracker.navigate(async () => { context.emit("request", read); });
        else context.emit("request", read);
        context.emit("requestfailed", read);
      }
      expect(tracker.cancelledReads()).toBe(0);
      await expect(tracker.snapshot(async () => "must not hide unexpected failure")).rejects.toThrow("Browser API read failed");
    }
  });

  it.each([
    ["/api/workflows/private-workflow?token=PRIVATE_QUERY", "/api/workflows/:id"],
    ["/api/work-issues/private-issue?body=PRIVATE_QUERY", "/api/work-issues/:id"],
    ["/api/today?secret=PRIVATE_QUERY", "/api/today"],
  ])("binds transport diagnostics to the exact error without exposing URL fields: %s", async (path, normalized) => {
    const { page: context, tracker } = setup(), read = request("GET", path);
    context.emit("request", read); context.emit("requestfailed", read);
    const error = await tracker.drain().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Browser API read failed before effect capture");
    const receipt = tracker.failureActivity(error);
    expect(receipt).toMatchObject({ schema_version: 1, method: "GET", path: normalized, sequence: 1,
      navigation_active: false, navigation_owned: false, transport_error: "net::ERR_CONNECTION_RESET" });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(JSON.stringify(receipt)).not.toMatch(/private-|PRIVATE_QUERY|token=|secret=|127\.0\.0\.1/);
    expect(tracker.failureActivity(new Error((error as Error).message))).toBeNull();
    expect(tracker.deadlineActivity(error)).toBeNull();
    await expect(tracker.snapshot(async () => "cannot hide transport failure")).rejects.toBe(error);
  });

  it("retains separate failure receipts and records active navigation without allowing a connection failure", async () => {
    const { page: context, tracker } = setup(), first = request("GET", "/api/runs"), second = request("GET", "/api/today");
    const firstError = await tracker.navigate(async () => {
      context.emit("request", first); context.emit("requestfailed", first);
    }).catch((reason: unknown) => reason);
    expect(firstError).toBeInstanceOf(Error);
    expect(tracker.failureActivity(firstError)).toMatchObject({ path: "/api/runs", sequence: 1, navigation_active: true, navigation_owned: true });
    context.emit("request", second); context.emit("requestfailed", second);
    const secondError = await tracker.drain().catch((reason: unknown) => reason);
    expect(secondError).toBeInstanceOf(Error); expect(secondError).not.toBe(firstError);
    expect(tracker.failureActivity(secondError)).toMatchObject({ path: "/api/today", sequence: 2, navigation_active: false, navigation_owned: false });
    expect(tracker.failureActivity(firstError)).toMatchObject({ path: "/api/runs", sequence: 1 });
    expect(tracker.cancelledReads()).toBe(0);
  });

  it("never exposes arbitrary transport text or replaces failure when a diagnostic getter throws", async () => {
    for (const throwing of [false, true]) {
      const { page: context, tracker } = setup(), read = request("GET", "/api/private-record?secret=PRIVATE_QUERY", "PRIVATE_TRANSPORT_TEXT");
      if (throwing) read.failure = () => { throw new Error("PRIVATE_GETTER_FAILURE"); };
      context.emit("request", read); context.emit("requestfailed", read);
      const error = await tracker.drain().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Browser API read failed before effect capture");
      if (throwing) expect(tracker.failureActivity(error)).toBeNull();
      else expect(tracker.failureActivity(error)).toMatchObject({ path: "/api/:unknown", transport_error: "unclassified" });
      expect(JSON.stringify(tracker.failureActivity(error))).not.toContain("PRIVATE_");
    }
  });

  it("does not apply the 10-second read deadline to an existing navigation action", async () => {
    vi.useFakeTimers();
    const { tracker } = setup();
    const navigate = vi.fn(async () => { await new Promise<void>((resolveAction) => setTimeout(resolveAction, 12_000)); return "existing navigation deadline preserved"; });
    const navigation = tracker.navigate(navigate);
    await vi.advanceTimersByTimeAsync(12_050);
    await expect(navigation).resolves.toBe("existing navigation deadline preserved"); expect(navigate).toHaveBeenCalledOnce();
  });

  it("recaptures an ENOENT only when a new GET raced with that capture", async () => {
    const { page, tracker } = setup(), read = request();
    const capture = vi.fn(async () => {
      if (capture.mock.calls.length === 1) {
        page.emit("request", read); page.emit("requestfinished", read);
        throw Object.assign(new Error("Synthetic transient read lock disappeared"), { code: "ENOENT" });
      }
      return "complete unchanged hash";
    });
    await expect(tracker.snapshot(capture)).resolves.toBe("complete unchanged hash"); expect(capture).toHaveBeenCalledTimes(2);
  });

  it.each(["ENOENT-without-new-GET", "EACCES-with-new-GET"])("does not swallow capture failure %s", async (scenario) => {
    const { page, tracker } = setup(), read = request();
    const failure = Object.assign(new Error("Synthetic observable capture failure"), { code: scenario.startsWith("ENOENT") ? "ENOENT" : "EACCES" });
    const capture = vi.fn(async () => {
      if (scenario.endsWith("with-new-GET")) { page.emit("request", read); page.emit("requestfinished", read); }
      throw failure;
    });
    await expect(tracker.snapshot(capture)).rejects.toBe(failure); expect(capture).toHaveBeenCalledOnce();
  });

  it("fails transport errors explicitly and preserves failures for subsequent captures", async () => {
    const { page, tracker } = setup(), read = request(), capture = vi.fn(async () => "must not hide failure");
    page.emit("request", read);
    const pending = tracker.snapshot(capture), rejected = expect(pending).rejects.toThrow("Browser API read failed");
    await turn(); page.emit("requestfailed", read); await rejected;
    await expect(tracker.snapshot(capture)).rejects.toThrow("Browser API read failed"); expect(capture).not.toHaveBeenCalled();
  });

  it("rejects a stalled read at the original 10-second deadline", async () => {
    vi.useFakeTimers();
    const { page, tracker } = setup(), capture = vi.fn(async () => "must not capture a stalled read");
    page.emit("request", request());
    const pending = tracker.snapshot(capture), rejected = expect(pending).rejects.toThrow("effect capture deadline");
    await vi.advanceTimersByTimeAsync(9_999); expect(capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await rejected; expect(capture).not.toHaveBeenCalled();
  });

  it("shares one deadline across recaptures rather than granting another 10 seconds", async () => {
    vi.useFakeTimers();
    const { page, tracker } = setup(), read = request();
    const capture = vi.fn(async () => {
      if (capture.mock.calls.length === 1) {
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 9_000));
        page.emit("request", read); page.emit("requestfinished", read); return "unstable";
      }
      return new Promise<string>(() => {});
    });
    const pending = tracker.snapshot(capture), rejected = expect(pending).rejects.toThrow("effect capture deadline");
    await vi.advanceTimersByTimeAsync(9_999); expect(capture).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); await rejected; expect(capture).toHaveBeenCalledTimes(2);
  });

  it("uses the approved workflow-only 30-second bound without changing the 10-second default", async () => {
    vi.useFakeTimers();
    const { page, tracker } = setup(), read = request(), capture = vi.fn(async () => "complete workflow capture");
    page.emit("request", read);
    const workflow = tracker.snapshot(capture, 30_000);
    await vi.advanceTimersByTimeAsync(12_050); expect(capture).not.toHaveBeenCalled();
    page.emit("requestfinished", read); await vi.advanceTimersByTimeAsync(10);
    await expect(workflow).resolves.toBe("complete workflow capture"); expect(capture).toHaveBeenCalledOnce();
    page.emit("request", read);
    const normal = tracker.snapshot(capture), rejected = expect(normal).rejects.toThrow("effect capture deadline");
    await vi.advanceTimersByTimeAsync(10_000); await rejected; expect(capture).toHaveBeenCalledOnce();
  });

  it("removes all listeners and rejects a pending drain when disposed", async () => {
    const { page, tracker } = setup(); page.emit("request", request());
    const pending = tracker.drain(), rejected = expect(pending).rejects.toThrow("tracker is disposed");
    await turn(); tracker.dispose(); await rejected;
    for (const event of ["request", "requestfinished", "requestfailed"]) expect(page.listenerCount(event)).toBe(0);
    await expect(tracker.snapshot(async () => "closed")).rejects.toThrow("tracker is disposed");
  });
});

describe("isolated browser smoke Issues refresh", () => {
  const response = (path: string, method = "GET", status = 200, json: () => Promise<unknown> = async () => ({ observed: true })) => ({
    url: () => `http://127.0.0.1:1234${path}`, request: () => ({ method: () => method }), status: () => status, json,
  });
  function setup() {
    const waiting: Array<{ matches: (value: ReturnType<typeof response>) => boolean; resolve: (value: ReturnType<typeof response>) => void; reject: (error: Error) => void }> = [];
    const waitForResponse = vi.fn((matches: (value: ReturnType<typeof response>) => boolean, _options: { timeout: number }) => new Promise<ReturnType<typeof response>>((resolveResponse, reject) => {
      waiting.push({ matches, resolve: resolveResponse, reject });
    }));
    const page = { waitForResponse } as unknown as Parameters<typeof observeIssueRefresh>[0];
    const emit = (value: ReturnType<typeof response>) => {
      const index = waiting.findIndex((entry) => entry.matches(value));
      if (index !== -1) waiting.splice(index, 1)[0]!.resolve(value);
    };
    return { page, waiting, emit, waitForResponse };
  }
  afterEach(() => vi.useRealTimers());

  it("registers all five exact GET observations before one click, ignoring query polls and wrong methods", async () => {
    const f = setup();
    const click = vi.fn(async () => {
      expect(f.waitForResponse).toHaveBeenCalledTimes(5);
      f.emit(response("/api/workflows?issue_id=synthetic")); f.emit(response("/api/workflows", "POST"));
      expect(f.waiting).toHaveLength(5);
      for (const path of ISSUE_REFRESH_PATHS) f.emit(response(path));
    });
    const refreshed = await observeIssueRefresh(f.page, click);
    expect(Object.keys(refreshed)).toEqual([...ISSUE_REFRESH_PATHS]); expect(click).toHaveBeenCalledOnce();
    for (const call of f.waitForResponse.mock.calls) expect(call[1]).toEqual({ timeout: 30_000 });
  });

  it.each(ISSUE_REFRESH_PATHS)("rejects an incomplete refresh when %s never responds, without resetting the total 30-second bound", async (missing) => {
    vi.useFakeTimers(); const f = setup(), complete = vi.fn();
    const pending = observeIssueRefresh(f.page, async () => {
      for (const path of ISSUE_REFRESH_PATHS) if (path !== missing) f.emit(response(path));
    }).then(complete);
    const rejected = expect(pending).rejects.toThrow("Issues refresh did not complete within its observation deadline");
    await vi.advanceTimersByTimeAsync(29_999); expect(complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await rejected; expect(complete).not.toHaveBeenCalled();
  });

  it.each(ISSUE_REFRESH_PATHS)("rejects %s with a failed JSON body even when all five statuses are 200", async (failed) => {
    const f = setup(), error = new Error("Synthetic refresh body failure");
    await expect(observeIssueRefresh(f.page, async () => {
      for (const path of ISSUE_REFRESH_PATHS) f.emit(response(path, "GET", 200, async () => { if (path === failed) throw error; return {}; }));
    })).rejects.toBe(error);
  });

  it("requires HTTP 200 and a valid object body, including within the shared observation deadline", async () => {
    for (const invalid of ["status", "body"] as const) {
      const f = setup();
      await expect(observeIssueRefresh(f.page, async () => {
        for (const path of ISSUE_REFRESH_PATHS) f.emit(response(path, "GET", path === "/api/organization" && invalid === "status" ? 500 : 200,
          async () => path === "/api/organization" && invalid === "body" ? null : {}));
      })).rejects.toThrow(invalid === "status" ? "returns 200" : "returns an object body");
    }
    vi.useFakeTimers(); const f = setup();
    const pending = observeIssueRefresh(f.page, async () => {
      for (const path of ISSUE_REFRESH_PATHS) f.emit(response(path, "GET", 200, async () => path === "/api/workflows" ? new Promise(() => {}) : {}));
    });
    const rejected = expect(pending).rejects.toThrow("observation deadline");
    await vi.advanceTimersByTimeAsync(30_000); await rejected;
  });

  it("handles all late observation rejections after the real refresh click fails", async () => {
    const f = setup();
    await expect(observeIssueRefresh(f.page, async () => { throw new Error("Synthetic refresh click failure"); })).rejects.toThrow("Synthetic refresh click failure");
    expect(f.waiting).toHaveLength(5);
    for (const waiting of f.waiting) waiting.reject(new Error("Synthetic observer closed during cleanup"));
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  });

  it("requires one exact fresh issue/project/revision and binds every preview to that parent", () => {
    const previous = { id: "synthetic-issue", project_id: "synthetic-project", revision: 1 }, current = { ...previous, revision: 3 };
    const fresh = selectRefreshedWorkflowIssue({ issues: [current] }, previous, current);
    expect(fresh).toEqual(current);
    for (const payload of [{ issues: [] }, { issues: [current, current] }, { issues: [{ ...current, project_id: "other-project" }] },
      { issues: [{ ...current, revision: 0 }] }, { issues: [{ ...current, revision: 2 }] }]) {
      expect(() => selectRefreshedWorkflowIssue(payload, previous, current)).toThrow();
    }
    expect(() => selectRefreshedWorkflowIssue({ issues: [current] }, previous, { ...current, id: "other-issue" })).toThrow();
    const request = { issue_id: current.id, project_id: current.project_id, expected_revision: current.revision };
    const preview = (value = request) => ({ request: value }) as Parameters<typeof assertWorkflowPreviewIssue>[0];
    expect(() => assertWorkflowPreviewIssue(preview(), fresh)).not.toThrow();
    for (const changed of [{ ...request, issue_id: "other-issue" }, { ...request, project_id: "other-project" }, { ...request, expected_revision: 2 }]) {
      expect(() => assertWorkflowPreviewIssue(preview(changed), fresh)).toThrow();
    }
  });
});

describe("focused operating views smoke isolation", () => {
  it("substitutes only the existing optional remote font CSS, never API responses or arbitrary external content", () => {
    const css = readFileSync(join(repository, "dashboard/src/ui/styles/boreal-tokens.css"), "utf8");
    const url = /@import url\('([^']+)'\)/.exec(css)![1]!;
    expect(isOperatingOfflineAsset(url)).toBe(true);
    for (const other of [url + "&private=value", url.replace("fonts.googleapis.com", "external.invalid"),
      "https://fonts.gstatic.com/synthetic.woff2", "http://127.0.0.1/api/operating/overview", "https://external.invalid"]) {
      expect(isOperatingOfflineAsset(other)).toBe(false);
    }
  });
  it("classifies browser errors without reflecting URLs, private IDs or message bodies", () => {
    expect(operatingConsoleCategory("Synthetic private body", "http://127.0.0.1:43217/api/budgets?private=value")).toBe("api-budgets");
    expect(operatingConsoleCategory("Synthetic private body", "http://localhost:43217/api/tasks/T-private")).toBe("api-tasks");
    expect(operatingConsoleCategory("WebSocket connection to a synthetic private address failed", "")).toBe("vite-connection");
    expect(operatingConsoleCategory("[vite] Synthetic private address", "")).toBe("vite-connection");
    for (const url of ["D:\\private\\file", "https://external.invalid/api/budgets", "http://127.0.0.1:43217/private/path", ""]) {
      expect(operatingConsoleCategory("Synthetic private message", url)).toBe("other");
    }
  });
  it("reports only the numeric local source location, without copying private exception content", () => {
    const error = new Error("SYNTHETIC_PRIVATE_MESSAGE");
    error.stack = "Synthetic private stack at D:\\private\\scripts\\playwright-operating-views-smoke.ts:237:12\nSYNTHETIC_PRIVATE_BODY";
    expect(operatingFailureLocation(error)).toEqual({ line: 237, column: 12 });
    error.stack = "Synthetic private stack without a smoke frame";
    expect(operatingFailureLocation(error)).toBeNull();
    expect(operatingFailureLocation({ stack: "Synthetic private payload" })).toBeNull();
  });
  function operatingRoot() {
    const root = mkdtempSync(join(tmpdir(), "surtec-local-dashboard-")); owned.push(root); return root;
  }

  it("constructs a fixed fixture environment from OS variables only, ignoring inherited secrets and overrides", () => {
    const root = operatingRoot();
    const os = { PATH: "synthetic-path", Path: "synthetic-windows-path", SystemRoot: "synthetic-system-root",
      SYSTEMROOT: "synthetic-upper-system-root", WINDIR: "synthetic-windir", ComSpec: "synthetic-shell",
      PATHEXT: ".EXE;.CMD", TEMP: "synthetic-temp", TMP: "synthetic-tmp", NUMBER_OF_PROCESSORS: "2",
      PROCESSOR_ARCHITECTURE: "synthetic-architecture" };
    const source = Object.freeze({ ...os, NODE_ENV: "production", NODE_OPTIONS: "--invalid-synthetic-option",
      NODE_PATH: "synthetic-injection", HOME: "synthetic-home", USERPROFILE: "synthetic-profile", CODEX_HOME: "synthetic-auth-dir",
      OPENAI_API_KEY: "synthetic-provider-key", CODEX_API_KEY: "synthetic-runtime-key", GH_TOKEN: "synthetic-gh-token",
      GITHUB_TOKEN: "synthetic-github-token", RAILWAY_TOKEN: "synthetic-railway-token", SSH_AUTH_SOCK: "synthetic-agent-socket",
      SURTEC_STATE_DIR: "synthetic-normal-state", SURTEC_PROJECTS_ROOT: "synthetic-sibling-projects",
      SURTEC_FIXTURE_ROOT: "synthetic-unowned-root", SURTEC_CODEX_BIN: "synthetic-real-runtime", SURTEC_CODEX_MODEL: "synthetic-model",
      SURTEC_RUN_ENV_ALLOWLIST: "OPENAI_API_KEY,GH_TOKEN", SURTEC_OTHER_SETTING: "synthetic-unrelated-setting" });
    const before = { ...source };
    expect(operatingSmokeEnvironment(source, root)).toEqual({ ...os, NODE_ENV: "test", SURTEC_OPERATING_VIEWS_SMOKE: "1", SURTEC_FIXTURE_ROOT: root,
      SURTEC_STATE_DIR: join(root, "state"), SURTEC_PROJECTS_ROOT: join(root, "projects"), SURTEC_CODEX_BIN: join(root, "forbidden-runtime") });
    expect(source).toEqual(before);
  });

  it("does not fill missing OS variables from the calling process", () => {
    const root = operatingRoot();
    expect(operatingSmokeEnvironment({}, root)).toEqual({ NODE_ENV: "test", SURTEC_OPERATING_VIEWS_SMOKE: "1", SURTEC_FIXTURE_ROOT: root,
      SURTEC_STATE_DIR: join(root, "state"), SURTEC_PROJECTS_ROOT: join(root, "projects"), SURTEC_CODEX_BIN: join(root, "forbidden-runtime") });
  });

  it("accepts only an absolute smoke-owned temporary root before deriving child state paths", () => {
    const root = operatingRoot();
    expect(() => assertOperatingFixtureRoot(root)).not.toThrow();
    for (const foreign of ["", "surtec-local-dashboard-relative", tmpdir(), repository,
      join(tmpdir(), "surtec-harness-test-foreign"), join(repository, "surtec-local-dashboard-foreign"), join(root, "..")]) {
      expect(() => assertOperatingFixtureRoot(foreign)).toThrow();
      expect(() => operatingSmokeEnvironment({}, foreign)).toThrow();
    }
    expect(existsSync(root)).toBe(true);
  });

  it.each(["setup", "start", "healthy", "incomplete", "blocked", "harness", "delivery", "privacy", "mobile", "degraded", "refusals", "reload", "restart", "cleanup"])(
    "reports only the known %s stage and a bounded failure category, never the underlying error content", (stage) => {
      const error = Object.assign(new Error("Synthetic private notes, credentials, source path and response body"), {
        stack: "Synthetic private stack", cause: { response: "Synthetic private response" }, responseBody: "Synthetic private body",
      });
      const summary = operatingFailureSummary(stage, error);
      expect(summary).toEqual({ status: "failed", stage, error_type: "error" });
      expect(Object.keys(summary).sort()).toEqual(["error_type", "stage", "status"]);
      expect(JSON.stringify(summary).length).toBeLessThan(200);
      expect(JSON.stringify(summary)).not.toContain("Synthetic private");
    });

  it("uses closed error categories and discards unknown stages rather than reflecting caller text", () => {
    for (const [name, category] of [["AssertionError", "assertion"], ["TimeoutError", "timeout"], ["Synthetic private error name", "error"]] as const) {
      const error = new Error("Synthetic private failure"); error.name = name;
      expect(operatingFailureSummary("delivery", error)).toEqual({ status: "failed", stage: "delivery", error_type: category });
    }
    for (const stage of ["", "healthy\nSynthetic private text", "Synthetic private stage".repeat(1_000)]) {
      expect(operatingFailureSummary(stage, new Error("Synthetic private error"))).toEqual({ status: "failed", stage: "unknown", error_type: "error" });
    }
  });

  it("never stringifies unknown failures or traverses cyclic or private payloads", () => {
    const cyclic: { self?: unknown; toString(): string } = { toString() { throw new Error("Unknown failure must not be stringified"); } };
    cyclic.self = cyclic;
    for (const error of [null, undefined, "Synthetic private text", 4, cyclic, { message: "Synthetic private message", responseBody: "Synthetic private body" }]) {
      expect(operatingFailureSummary("setup", error)).toEqual({ status: "failed", stage: "setup", error_type: "unknown" });
    }
  });

  function readyMessage() {
    return { type: "ready", port: 43_217, facts: { deliveryIssueId: "I-delivery", personalIssueId: "I-personal",
      blockedIssueId: "I-blocked", objectiveId: "objective-operating", commitmentId: "commitment-delivery",
      fixedNow: "2026-10-16T12:00:00.000Z", acceptedIssueId: "I-accepted", acceptedCandidateId: "candidate-accepted", taskId: "T-q-recorded" } };
  }

  it("accepts only the closed actual API ready envelope and returns bounded fixture facts without process payloads", () => {
    const message = readyMessage();
    expect(parseOperatingReady(message)).toEqual({ port: message.port, facts: message.facts });
    expect(parseOperatingReady({ ...message, port: 1 })?.port).toBe(1);
    expect(parseOperatingReady({ ...message, port: 65_535 })?.port).toBe(65_535);
  });

  it.each([null, undefined, "ready", [], {}, { type: "ready" }])("rejects an absent or non-envelope ready payload %j", (message) => {
    expect(parseOperatingReady(message)).toBeNull();
  });

  it("rejects wrong ready fields, ports, incomplete facts and unrequested payload keys", () => {
    const ready = readyMessage();
    const withoutFact = { ...ready.facts } as Partial<typeof ready.facts>; delete withoutFact.personalIssueId;
    for (const key of Object.keys(ready.facts)) {
      const incomplete = { ...ready.facts } as Record<string, unknown>; delete incomplete[key];
      expect(parseOperatingReady({ ...ready, facts: incomplete })).toBeNull();
    }
    for (const message of [
      { ...ready, type: "scenario-result" }, { ...ready, port: 0 }, { ...ready, port: -1 }, { ...ready, port: 65_536 },
      { ...ready, port: 1.5 }, { ...ready, port: NaN }, { ...ready, port: "43217" },
      { ...ready, root: "Synthetic private process path" }, { ...ready, facts: null }, { ...ready, facts: [] },
      { ...ready, facts: withoutFact }, { ...ready, facts: { ...ready.facts, privateNotes: "Synthetic private notes" } },
      { ...ready, facts: { ...ready.facts, fixedNow: "2026-10-17T12:00:00.000Z" } },
      { ...ready, facts: { ...ready.facts, commitmentId: "other-commitment" } },
      { ...ready, facts: { ...ready.facts, taskId: "other-task" } },
    ]) expect(parseOperatingReady(message)).toBeNull();
  });

  it("rejects path-like, empty, control-bearing and oversized IDs in every fixture reference", () => {
    const ready = readyMessage();
    for (const key of ["deliveryIssueId", "personalIssueId", "blockedIssueId", "objectiveId", "acceptedIssueId", "acceptedCandidateId"] as const) {
      for (const value of ["", "../outside", "D:\\synthetic-private\\state", "https://example.invalid", "synthetic\nprivate", "x".repeat(1_000), null, 42]) {
        expect(parseOperatingReady({ ...ready, facts: { ...ready.facts, [key]: value } })).toBeNull();
      }
    }
  });
});


describe("isolated browser smoke read diagnostics", () => {
  const trackers: ReturnType<typeof trackBrowserApiReads>[] = [];
  type ReadDiagnostic = {
    schema_version: 1;
    label: string;
    phase: string;
    pending_count: number;
    pending_reads: Array<{ method: "GET"; path: string }>;
    omitted_pending: number;
    generation_at_capture: number | null;
    generation_now: number;
    captures_started: number;
    recaptures: number;
  };
  const prefix = "Browser API reads did not settle within the effect capture deadline; SMOKE_READ_DIAGNOSTIC ";
  const request = (path = "/api/overview", method = "GET", origin = "http://127.0.0.1:1234") => ({
    method: () => method, url: () => origin + path, failure: () => ({ errorText: "net::ERR_CONNECTION_RESET" }),
  });
  function setup() {
    const context = new EventEmitter();
    const tracker = trackBrowserApiReads(context as unknown as Parameters<typeof trackBrowserApiReads>[0]);
    trackers.push(tracker); return { context, tracker };
  }
  function diagnostic(error: unknown): ReadDiagnostic {
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message.startsWith(prefix)).toBe(true);
    return JSON.parse(message.slice(prefix.length)) as ReadDiagnostic;
  }
  afterEach(() => { for (const tracker of trackers.splice(0)) tracker.dispose(); vi.useRealTimers(); });

  it("captures a pending GET before the first capture and freezes its deadline evidence before disposal", async () => {
    vi.useFakeTimers();
    const { context, tracker } = setup(), read = request("/api/portfolio/profiles"), capture = vi.fn(async () => "must not capture");
    context.emit("request", read);
    const failure = tracker.snapshot(capture, 10_000, "phase-n-before-preview").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(9_999); expect(capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const error = await failure, payload = diagnostic(error), frozenMessage = (error as Error).message;
    expect(payload).toEqual({ schema_version: 1, label: "phase-n-before-preview", phase: "waiting-before-capture",
      pending_count: 1, pending_reads: [{ method: "GET", path: "/api/portfolio/profiles" }], omitted_pending: 0,
      generation_at_capture: null, generation_now: 1, captures_started: 0, recaptures: 0 });
    context.emit("requestfinished", read); tracker.dispose();
    expect((error as Error).message).toBe(frozenMessage); expect(diagnostic(error)).toEqual(payload);
    expect(capture).not.toHaveBeenCalled();
  });

  it("identifies an unfinished filesystem capture without inventing a pending API read", async () => {
    vi.useFakeTimers();
    const { tracker } = setup(), capture = vi.fn(() => new Promise<string>(() => {}));
    const failure = tracker.snapshot(capture).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(9_999); expect(capture).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(diagnostic(await failure)).toEqual({ schema_version: 1, label: "unlabelled", phase: "capturing",
      pending_count: 0, pending_reads: [], omitted_pending: 0,
      generation_at_capture: 0, generation_now: 0, captures_started: 1, recaptures: 0 });
  });

  it("retains completed-read generation changes when a recapture remains unfinished", async () => {
    vi.useFakeTimers();
    const { context, tracker } = setup(), read = request("/api/organization");
    const capture = vi.fn(() => {
      if (capture.mock.calls.length === 1) {
        context.emit("request", read); context.emit("requestfinished", read);
        return Promise.resolve("requires a fresh capture");
      }
      return new Promise<string>(() => {});
    });
    const failure = tracker.snapshot(capture, 10_000, "phase-n-after-browser-previews").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(9_999); expect(capture).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(diagnostic(await failure)).toEqual({ schema_version: 1, label: "phase-n-after-browser-previews", phase: "capturing",
      pending_count: 0, pending_reads: [], omitted_pending: 0,
      generation_at_capture: 1, generation_now: 1, captures_started: 2, recaptures: 1 });
  });

  it("admits the three fixed Phase N labels and replaces an invalid runtime label without reflecting it", async () => {
    vi.useFakeTimers();
    for (const [label, expected] of [
      ["phase-n-before-preview", "phase-n-before-preview"],
      ["phase-n-after-api-refusals", "phase-n-after-api-refusals"],
      ["phase-n-after-browser-previews", "phase-n-after-browser-previews"],
      ["PRIVATE_ARBITRARY_LABEL", "unlabelled"],
    ] as const) {
      const { context, tracker } = setup();
      context.emit("request", request());
      const failure = tracker.snapshot(async () => "must not capture", 10_000, label as Parameters<typeof tracker.snapshot>[2]).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      const error = await failure, payload = diagnostic(error);
      expect(payload.label).toBe(expected); expect((error as Error).message).not.toContain("PRIVATE_ARBITRARY_LABEL");
      expect(payload.phase).toBe("waiting-before-capture"); expect(payload.pending_count).toBe(1);
    }
  });

  it("caps pending route rows and excludes hosts, IDs, query data, fragments and private request accessors", async () => {
    vi.useFakeTimers();
    const { context, tracker } = setup(), privateAccessor = vi.fn(() => { throw new Error("PRIVATE_HEADER_OR_BODY"); });
    for (const path of [
      "/api/overview?token=PRIVATE_QUERY#PRIVATE_FRAGMENT",
      "/api/projects/PRIVATE_PROJECT/client-context-options?secret=PRIVATE_QUERY",
      "/api/projects/PRIVATE_PROJECT/context/roles",
      "/api/PRIVATE_UNKNOWN/PRIVATE_ID?secret=PRIVATE_QUERY#PRIVATE_FRAGMENT",
      "/api/organization", "/api/operating/overview?page_size=6", "/api/dispatch-options", "/api/session",
      "/api/work-issues", "/api/workflows", "/api/inbox", "/api/budgets",
    ]) {
      const read = request(path, "GET", "https://private-host.invalid");
      for (const field of ["headers", "postData", "postDataJSON", "body"]) Object.defineProperty(read, field, { get: privateAccessor });
      context.emit("request", read);
    }
    context.emit("request", request("/api/PRIVATE_WRITE", "POST", "https://private-host.invalid"));
    context.emit("request", request("/PRIVATE_STATIC", "GET", "https://private-host.invalid"));
    const failure = tracker.snapshot(async () => "must not capture").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await failure, payload = diagnostic(error);
    expect(Object.keys(payload).sort()).toEqual(["schema_version", "label", "phase", "pending_count", "pending_reads", "omitted_pending",
      "generation_at_capture", "generation_now", "captures_started", "recaptures"].sort());
    expect(payload.pending_count).toBe(12); expect(payload.pending_reads).toHaveLength(8); expect(payload.omitted_pending).toBe(4);
    expect(payload.pending_reads).toEqual([
      { method: "GET", path: "/api/overview" }, { method: "GET", path: "/api/projects/:id/client-context-options" },
      { method: "GET", path: "/api/projects/:id/context/roles" }, { method: "GET", path: "/api/:unknown" },
      { method: "GET", path: "/api/organization" }, { method: "GET", path: "/api/operating/overview" },
      { method: "GET", path: "/api/dispatch-options" }, { method: "GET", path: "/api/session" },
    ]);
    expect(payload.generation_now).toBe(12); expect(payload.captures_started).toBe(0);
    expect((error as Error).message).not.toMatch(/PRIVATE|private-host|https?:|token=|secret=|page_size|#/);
    expect(privateAccessor).not.toHaveBeenCalled();
  });

  it("keeps the original deadline error when a registered request URL accessor subsequently throws", async () => {
    vi.useFakeTimers();
    const { context, tracker } = setup();
    let throwUrl = false;
    const read = { method: () => "GET", url: () => {
      if (throwUrl) throw new Error("PRIVATE_URL_ACCESSOR");
      return "http://127.0.0.1:1234/api/overview";
    }, failure: () => ({ errorText: "net::ERR_CONNECTION_RESET" }) };
    context.emit("request", read); throwUrl = true;
    const failure = tracker.snapshot(async () => "must not capture", 10_000, "phase-n-after-api-refusals").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await failure, payload = diagnostic(error);
    expect(payload).toEqual({ schema_version: 1, label: "phase-n-after-api-refusals", phase: "waiting-before-capture",
      pending_count: 1, pending_reads: [{ method: "GET", path: "/api/:unknown" }], omitted_pending: 0,
      generation_at_capture: null, generation_now: 1, captures_started: 0, recaptures: 0 });
    expect((error as Error).message).not.toContain("PRIVATE_URL_ACCESSOR");
  });
});


describe("isolated browser smoke Harness fixture", () => {
  type Materializer = (sourceRepoRoot: string, destination: string) => Promise<{ paths: string[]; total_bytes: number }>;
  const historyPath = ".agents/specs/tasks/phase-p-operational-continuity.tasks.md";
  function freshRoot(label: string): string {
    const root = mkdtempSync(join(tmpdir(), "surtec-reviewed-harness-" + label + "-"));
    owned.push(root); return root;
  }
  async function sourceFixture(materialize: Materializer): Promise<string> {
    const root = freshRoot("source");
    await materialize(repository, root);
    mkdirSync(join(root, "registry/harness-manifests"), { recursive: true });
    cpSync(join(repository, "registry/harness-sources.yml"), join(root, "registry/harness-sources.yml"));
    cpSync(join(repository, "registry/harness-manifests/surtec-h1-h4.json"), join(root, "registry/harness-manifests/surtec-h1-h4.json"));
    return root;
  }

  it("materializes the byte-exact reviewed scaffold and complete support without importing live project history", async () => {
    const { materializeReviewedHarnessFixture } = await import("./playwright-local-app-smoke");
    const { loadHarnessSource, hash } = await import("../lib/harness/source");
    const { inspectHarness } = await import("../lib/harness/inspect");
    const trusted = loadHarnessSource(repository), beforeHistory = hash(readFileSync(join(repository, historyPath)));
    expect(trusted.status).toBe("trusted"); expect(trusted.manifest!.expected_entries).toHaveLength(25);
    const destination = join(freshRoot("target"), "project");
    const result = await materializeReviewedHarnessFixture(repository, destination);
    const sourceRoot = resolve(repository, trusted.registry!.source.root);
    for (const entry of trusted.manifest!.expected_entries) {
      expect(result.paths).toContain(entry.path);
      const bytes = readFileSync(join(destination, entry.path));
      expect(bytes).toEqual(readFileSync(join(sourceRoot, entry.path))); expect(hash(bytes)).toBe(entry.sha256);
    }
    expect(new Set(result.paths).size).toBe(result.paths.length);
    expect(result.total_bytes).toBe(result.paths.reduce((total, path) => total + readFileSync(join(destination, path)).length, 0));
    expect(existsSync(join(destination, historyPath))).toBe(false);
    expect(hash(readFileSync(join(repository, historyPath)))).toBe(beforeHistory);
    const observed = inspectHarness(destination, "fixture", trusted);
    expect(observed.status).toBe("healthy"); expect(observed.comparison).toBe("compatible");
    expect(observed.findings.some((entry) => entry.id === "context-unknown" || entry.id === "routing-reference-invalid" || entry.id.startsWith("reference-"))).toBe(false);
  });

  it("leaves unselected oversized history and its neighbor unchanged in an owned source without copying either", async () => {
    const { materializeReviewedHarnessFixture } = await import("./playwright-local-app-smoke");
    const { loadHarnessSource } = await import("../lib/harness/source");
    const { inspectHarness } = await import("../lib/harness/inspect");
    const source = await sourceFixture(materializeReviewedHarnessFixture);
    const largePath = ".agents/specs/tasks/synthetic-unselected-oversized-history.md", neighborPath = ".agents/specs/tasks/synthetic-unselected-neighbor.md";
    mkdirSync(dirname(join(source, largePath)), { recursive: true });
    writeFileSync(join(source, largePath), Buffer.alloc(262_145, "x"));
    writeFileSync(join(source, neighborPath), "Synthetic project history remains source-owned.\n");
    const before = await harnessTreeHash(source), destination = join(freshRoot("unselected-target"), "project");
    const result = await materializeReviewedHarnessFixture(source, destination);
    expect(result.paths).not.toContain(largePath); expect(result.paths).not.toContain(neighborPath);
    expect(existsSync(join(destination, largePath))).toBe(false); expect(existsSync(join(destination, neighborPath))).toBe(false);
    expect(await harnessTreeHash(source)).toBe(before);
    const trusted = loadHarnessSource(source); expect(trusted.status).toBe("trusted");
    const observed = inspectHarness(destination, "fixture", trusted);
    expect(observed.status).toBe("healthy"); expect(observed.comparison).toBe("compatible");
  });

  it("retains the partial and drift observation when a required validator is removed only from an owned target", async () => {
    const { materializeReviewedHarnessFixture } = await import("./playwright-local-app-smoke");
    const { loadHarnessSource, hash } = await import("../lib/harness/source");
    const { inspectHarness } = await import("../lib/harness/inspect");
    const validator = ".agents/scripts/validate-spec.ps1", source = await sourceFixture(materializeReviewedHarnessFixture);
    const sourceBefore = await harnessTreeHash(source), pinBefore = hash(readFileSync(join(source, validator)));
    const destination = join(freshRoot("partial-target"), "project");
    await materializeReviewedHarnessFixture(source, destination);
    rmSync(join(destination, validator));
    const targetBefore = await harnessTreeHash(destination), observed = inspectHarness(destination, "fixture", loadHarnessSource(source));
    expect(observed.status).toBe("partial"); expect(observed.comparison).toBe("drift"); expect(observed.detected_version).toBeNull();
    expect(observed.drift_summary.some((entry) => entry.includes(validator))).toBe(true);
    expect(existsSync(join(destination, validator))).toBe(false); expect(await harnessTreeHash(destination)).toBe(targetBefore);
    expect(hash(readFileSync(join(source, validator)))).toBe(pinBefore); expect(await harnessTreeHash(source)).toBe(sourceBefore);
  });

  it("continues to reject a genuine oversized target addition without reading its body or repairing it", async () => {
    const { materializeReviewedHarnessFixture } = await import("./playwright-local-app-smoke");
    const { loadHarnessSource, hash } = await import("../lib/harness/source");
    const { inspectHarness } = await import("../lib/harness/inspect");
    const destination = join(freshRoot("oversized-target"), "project");
    await materializeReviewedHarnessFixture(repository, destination);
    const path = ".agents/specs/tasks/synthetic-genuine-oversized.md", marker = "PRIVATE_TARGET_HISTORY_BODY";
    const bytes = Buffer.alloc(262_145, "x"); bytes.write(marker);
    mkdirSync(dirname(join(destination, path)), { recursive: true }); writeFileSync(join(destination, path), bytes);
    const before = hash(readFileSync(join(destination, path))), observed = inspectHarness(destination, "fixture", loadHarnessSource(repository));
    expect(observed.status).toBe("unknown"); expect(observed.comparison).toBe("unknown");
    expect(observed.entries.find((entry) => entry.path === path)?.status).toBe("unsafe");
    expect(JSON.stringify(observed)).not.toContain(marker);
    expect(hash(readFileSync(join(destination, path)))).toBe(before);
  });

  it("rejects missing required support and changed pins before writing any target while preserving each owned source", async () => {
    const { materializeReviewedHarnessFixture } = await import("./playwright-local-app-smoke");
    const { loadHarnessSource } = await import("../lib/harness/source");
    for (const mode of ["missing-support", "changed-pin"] as const) {
      const source = await sourceFixture(materializeReviewedHarnessFixture);
      if (mode === "missing-support") rmSync(join(source, "docs/architecture/current-architecture.md"));
      else writeFileSync(join(source, "AGENTS.md"), readFileSync(join(source, "AGENTS.md"), "utf8") + "\nSynthetic unreviewed pinned change.\n");
      expect(loadHarnessSource(source).status).toBe(mode === "missing-support" ? "trusted" : "unknown");
      const before = await harnessTreeHash(source), destination = join(freshRoot("rejected-target"), "project");
      await expect(materializeReviewedHarnessFixture(source, destination)).rejects.toThrow();
      expect(existsSync(destination)).toBe(false); expect(await harnessTreeHash(source)).toBe(before);
    }
  });
});


describe("isolated browser smoke Harness absence", () => {
  it("retains a minimal Factory instruction scaffold as unknown rather than claiming it is absent", async () => {
    const { inspectHarness } = await import("../lib/harness/inspect");
    const { loadHarnessSource } = await import("../lib/harness/source");
    const root = mkdtempSync(join(tmpdir(), "surtec-factory-harness-absence-")); owned.push(root);
    mkdirSync(join(root, ".agents/policies"), { recursive: true });
    mkdirSync(join(root, ".agents/orchestration"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "---\nrole: session-primer\n---\n# Synthetic Factory primer\n");
    writeFileSync(join(root, ".agents/policies/project.md"), "# Synthetic Factory policy\nProject documents grant no permissions.\n");
    writeFileSync(join(root, ".agents/orchestration/ROUTING.md"), "# Synthetic Factory routing\nUse only the structured complete selection.\n");
    const trusted = loadHarnessSource(repository), before = await harnessTreeHash(root);
    expect(trusted.status).toBe("trusted"); expect(trusted.manifest!.expected_entries).toHaveLength(25);
    const observed = inspectHarness(root, "fixture", trusted);
    expect(observed.status).toBe("unknown"); expect(observed.comparison).toBe("unknown"); expect(observed.detected_version).toBeNull();
    expect(observed.findings.some((entry) => entry.id === "unsupported-format")).toBe(true);
    expect(observed.entries.find((entry) => entry.path === ".agents/AGENTS.md")?.status).toBe("missing");
    expect(observed.capability_results.find((entry) => entry.capability === "registry")?.status).toBe("missing");
    expect(existsSync(join(root, ".agents/AGENTS.md"))).toBe(false);
    expect(await harnessTreeHash(root)).toBe(before);
  });

  it("observes the pre-campaign workflow documents and verifier as absent Harness without executing or backfilling them", async () => {
    const { inspectHarness } = await import("../lib/harness/inspect");
    const { loadHarnessSource } = await import("../lib/harness/source");
    const root = mkdtempSync(join(tmpdir(), "surtec-workflow-harness-absence-")); owned.push(root);
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/smoke-context.md"), "Synthetic private project source body.\n");
    writeFileSync(join(root, "verify-workflow.mjs"), "throw new Error('Synthetic verifier must never execute during read-only Harness inspection');\n");
    const trusted = loadHarnessSource(repository), before = await harnessTreeHash(root);
    expect(trusted.status).toBe("trusted"); expect(trusted.manifest!.expected_entries).toHaveLength(25);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false); expect(existsSync(join(root, ".agents"))).toBe(false);
    const observed = inspectHarness(root, "fixture", trusted);
    expect(observed.status).toBe("absent"); expect(observed.detected_version).toBeNull();
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false); expect(existsSync(join(root, ".agents"))).toBe(false);
    expect(await harnessTreeHash(root)).toBe(before);
  });
});


describe("isolated browser smoke read activity", () => {
  type Tracker = ReturnType<typeof trackBrowserApiReads>;
  const trackers: Tracker[] = [];
  const turn = () => new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  const request = (path: string, method = "GET") => ({
    method: () => method, url: () => "http://127.0.0.1:1234" + path,
    failure: () => ({ errorText: "net::ERR_CONNECTION_RESET" }),
  });
  function setup() {
    const context = new EventEmitter(), clock = { value: 0, fail: false };
    const tracker = trackBrowserApiReads(context as unknown as Parameters<typeof trackBrowserApiReads>[0], 10_000, () => {
      if (clock.fail) throw new Error("PRIVATE_CLOCK_FAILURE");
      return clock.value;
    });
    trackers.push(tracker);
    return { context, tracker, clock };
  }
  const observe = (pending: Promise<unknown>) => pending.then(
    (value) => ({ status: "resolved" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  function failure(outcome: Awaited<ReturnType<typeof observe>>): Error {
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected" || !(outcome.error instanceof Error)) throw new Error("Synthetic read activity expected an Error rejection");
    return outcome.error;
  }
  function activity(tracker: Tracker, error: Error) {
    const receipt = tracker.deadlineActivity(error);
    expect(receipt).not.toBeNull();
    if (!receipt) throw new Error("Synthetic deadline activity is missing");
    return receipt;
  }
  afterEach(() => { for (const tracker of trackers.splice(0)) tracker.dispose(); vi.useRealTimers(); });
  const fakeDeadlines = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  it("tracks only budget GET proxy milestones without retaining the request", () => {
    const trace = createBudgetProxyTrace();
    const budget = { method: "GET", url: "/api/budgets?project_id=PRIVATE" };
    trace.observe("received", { ...budget, method: "POST" });
    trace.observe("received", { method: "GET", url: "/api/budgets/other" });
    trace.observe("received", budget);
    trace.observe("forwarded", budget);
    const beforeHeaders = trace.snapshot();
    trace.observe("upstream_headers", budget);
    trace.observe("upstream_finished", budget);
    expect(beforeHeaders).toEqual({ received: 1, forwarded: 1, upstream_headers: 0, upstream_finished: 0 });
    expect(trace.snapshot()).toEqual({ received: 1, forwarded: 1, upstream_headers: 1, upstream_finished: 1 });
    expect(JSON.stringify(trace.snapshot())).not.toContain("PRIVATE");
  });

  it.each(["t013-panel-drain", "t013-before-preview-effects"] as const)("traces budget header arrival at %s without changing the drain", async (label) => {
    fakeDeadlines();
    const { context, tracker } = setup();
    const beforeHeaders = request("/api/budgets?project_id=PRIVATE");
    const beforeBody = request("/api/budgets");
    const completed = request("/api/budgets");
    for (const item of [beforeHeaders, beforeBody, completed]) context.emit("request", item);
    context.emit("response", { request: () => beforeBody });
    context.emit("response", { request: () => completed });
    context.emit("requestfinished", completed);
    const capture = vi.fn();
    const outcome = observe(label === "t013-panel-drain" ? tracker.drain(30_000, label) : tracker.snapshot(capture, 30_000, label));
    await vi.advanceTimersByTimeAsync(30_000);
    const error = failure(await outcome);
    expect(activity(tracker, error)).toMatchObject({ label, pending_at_deadline: 2 });
    expect(JSON.parse(error.message.split("SMOKE_READ_DIAGNOSTIC ")[1]!)).toMatchObject({ captures_started: 0 });
    expect(tracker.budgetDeadline(error)).toEqual([{ sequence: 1, headers_received: false }, { sequence: 2, headers_received: true }]);
    expect(tracker.budgetDeadline(new Error(error.message))).toEqual([]);
    expect(capture).not.toHaveBeenCalled();
    tracker.dispose();
    expect(context.listenerCount("response")).toBe(0);
  });

  it("distinguishes two reads already pending at the workflow drain from new arrivals and preserves the legacy payload", async () => {
    fakeDeadlines();
    const f = setup(), runs = request("/api/runs"), today = request("/api/today");
    f.clock.value = 1_000; f.context.emit("request", runs);
    f.clock.value = 2_000; f.context.emit("request", today);
    f.clock.value = 10_000;
    const outcome = observe(f.tracker.drain(30_000));
    expect(f.tracker.deadlineActivity()).toBeNull();
    f.clock.value = 39_999; await vi.advanceTimersByTimeAsync(29_999);
    expect(f.tracker.deadlineActivity()).toBeNull();
    f.clock.value = 40_000; await vi.advanceTimersByTimeAsync(1);
    const error = failure(await outcome), receipt = activity(f.tracker, error);
    expect(receipt).toEqual({
      schema_version: 1, label: "unlabelled", phase: "drain", read_timeout_ms: 30_000, elapsed_ms: 30_000,
      pending_at_start: 2, pending_at_deadline: 2, started_in_window: 0, finished_in_window: 0, failed_in_window: 0,
      pending_reads: [
        { method: "GET", path: "/api/runs", sequence: 1, age_ms: 39_000, started_in_window: false },
        { method: "GET", path: "/api/today", sequence: 2, age_ms: 38_000, started_in_window: false },
      ], omitted_pending: 0,
    });
    expect(JSON.parse(error.message.split("SMOKE_READ_DIAGNOSTIC ")[1]!)).toEqual({
      schema_version: 1, label: "unlabelled", phase: "drain", generation_at_capture: null, captures_started: 0,
      recaptures: 0, pending_count: 2, pending_reads: [{ method: "GET", path: "/api/runs" }, { method: "GET", path: "/api/today" }],
      omitted_pending: 0, generation_now: 2,
    });
  });

  it("records continuing finite completions while a young replacement keeps the drain non-idle", async () => {
    fakeDeadlines();
    const f = setup();
    let previous = request("/api/today");
    f.context.emit("request", previous);
    const outcome = observe(f.tracker.drain());
    for (let index = 1; index <= 9; index++) {
      f.clock.value = index * 1_000; await vi.advanceTimersByTimeAsync(1_000);
      const next = request(index % 2 ? "/api/runs" : "/api/today");
      f.context.emit("request", next); f.context.emit("requestfinished", previous); previous = next;
    }
    expect(f.tracker.deadlineActivity()).toBeNull();
    f.clock.value = 10_000; await vi.advanceTimersByTimeAsync(1_000);
    const receipt = activity(f.tracker, failure(await outcome));
    expect(receipt).toMatchObject({
      phase: "drain", elapsed_ms: 10_000, pending_at_start: 1, pending_at_deadline: 1,
      started_in_window: 9, finished_in_window: 9, failed_in_window: 0, omitted_pending: 0,
    });
    expect(receipt.pending_reads).toEqual([{ method: "GET", path: "/api/runs", sequence: 10, age_ms: 1_000, started_in_window: true }]);
  });

  it("keeps the default and workflow deadlines fixed when reads arrive just before their limit", async () => {
    fakeDeadlines();
    for (const bound of [10_000, 30_000]) {
      const f = setup(), old = request("/api/today"), next = request("/api/runs");
      f.context.emit("request", old);
      const outcome = observe(bound === 10_000 ? f.tracker.drain() : f.tracker.drain(bound));
      const settled = vi.fn(); void outcome.then(settled);
      f.clock.value = bound - 1; await vi.advanceTimersByTimeAsync(bound - 1);
      expect(settled).not.toHaveBeenCalled(); expect(f.tracker.deadlineActivity()).toBeNull();
      f.context.emit("request", next); f.context.emit("requestfinished", old);
      f.clock.value = bound; await vi.advanceTimersByTimeAsync(1);
      const receipt = activity(f.tracker, failure(await outcome));
      expect(receipt).toMatchObject({
        read_timeout_ms: bound, elapsed_ms: bound, pending_at_start: 1, pending_at_deadline: 1,
        started_in_window: 1, finished_in_window: 1, failed_in_window: 0,
      });
      expect(receipt.pending_reads).toEqual([{ method: "GET", path: "/api/runs", sequence: 2, age_ms: 1, started_in_window: true }]);
    }
  });

  it("caps retained rows and normalizes private URL data without consulting private request accessors", async () => {
    fakeDeadlines();
    const f = setup(), privateAccess = vi.fn(() => { throw new Error("PRIVATE_ACCESSOR"); });
    const paths = ["/api/runs?token=PRIVATE_QUERY#PRIVATE_FRAGMENT", "/api/projects/PRIVATE_PROJECT/client-context-options",
      "/api/projects/PRIVATE_PROJECT/context/roles", "/api/PRIVATE_UNKNOWN", "/api/today", "/api/overview",
      "/api/work-issues", "/api/session", "/api/budgets", "/api/workflows"];
    for (const path of paths) {
      const read = { method: () => "GET", url: () => "http://PRIVATE_USER:PRIVATE_PASSWORD@127.0.0.1:1234" + path };
      for (const key of ["headers", "allHeaders", "postData", "postDataJSON", "frame", "timing", "toJSON"]) {
        Object.defineProperty(read, key, { get: privateAccess, enumerable: true });
      }
      f.context.emit("request", read);
    }
    const outcome = observe(f.tracker.drain());
    f.clock.value = 10_000; await vi.advanceTimersByTimeAsync(10_000);
    const error = failure(await outcome), receipt = activity(f.tracker, error);
    expect(receipt).toMatchObject({ pending_at_start: 10, pending_at_deadline: 10, started_in_window: 0,
      finished_in_window: 0, failed_in_window: 0, omitted_pending: 2 });
    expect(receipt.pending_reads).toHaveLength(8);
    expect(receipt.pending_reads.map((read) => read.path)).toEqual([
      "/api/runs", "/api/projects/:id/client-context-options", "/api/projects/:id/context/roles", "/api/:unknown",
      "/api/today", "/api/overview", "/api/work-issues", "/api/session",
    ]);
    expect(receipt.pending_reads.map((read) => read.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(privateAccess).not.toHaveBeenCalled();
    expect(error.message + JSON.stringify(receipt)).not.toContain("PRIVATE_");
  });

  it("freezes deadline activity before later events or disposal without exporting earlier completed history", async () => {
    fakeDeadlines();
    const f = setup(), completed = request("/api/overview"), live = request("/api/today");
    f.context.emit("request", completed); f.clock.value = 10; f.context.emit("requestfinished", completed);
    f.clock.value = 20; f.context.emit("request", live); f.clock.value = 30;
    const outcome = observe(f.tracker.drain());
    f.clock.value = 10_030; await vi.advanceTimersByTimeAsync(10_000);
    const error = failure(await outcome), receipt = activity(f.tracker, error), serialized = JSON.stringify(receipt);
    expect(receipt).toMatchObject({ pending_at_start: 1, pending_at_deadline: 1, started_in_window: 0, finished_in_window: 0, failed_in_window: 0 });
    expect(receipt.pending_reads).toEqual([{ method: "GET", path: "/api/today", sequence: 2, age_ms: 10_010, started_in_window: false }]);
    expect(serialized).not.toContain("/api/overview");
    expect(Object.isFrozen(receipt)).toBe(true); expect(Object.isFrozen(receipt.pending_reads)).toBe(true);
    expect(receipt.pending_reads.every(Object.isFrozen)).toBe(true);
    expect(Reflect.set(receipt, "pending_at_deadline", 0)).toBe(false);
    expect(Reflect.set(receipt.pending_reads[0]!, "age_ms", 0)).toBe(false);
    f.context.emit("requestfinished", live); f.context.emit("request", request("/api/runs")); f.tracker.dispose();
    expect(JSON.stringify(receipt)).toBe(serialized); expect(f.tracker.deadlineActivity(error)).toBe(receipt);
    expect(f.tracker.deadlineActivity()).toBe(receipt);
    expect(f.tracker.deadlineActivity(new Error(error.message))).toBeNull();
    expect(f.tracker.deadlineActivity(undefined)).toBeNull();
  });

  it("does not attach an earlier deadline receipt to a later transport failure", async () => {
    fakeDeadlines();
    const f = setup(), old = request("/api/runs");
    f.context.emit("request", old);
    const first = observe(f.tracker.drain());
    f.clock.value = 10_000; await vi.advanceTimersByTimeAsync(10_000);
    const firstError = failure(await first), firstReceipt = activity(f.tracker, firstError);
    f.context.emit("requestfinished", old);
    f.clock.value = 10_001;
    const failing = request("/api/today"); f.context.emit("request", failing);
    const second = observe(f.tracker.drain());
    await Promise.resolve();
    f.clock.value = 10_002; f.context.emit("requestfailed", failing);
    const error = failure(await second);
    expect(error.message).toBe("Browser API read failed before effect capture");
    expect(f.tracker.deadlineActivity(error)).toBeNull(); expect(f.tracker.deadlineActivity(undefined)).toBeNull();
    expect(f.tracker.deadlineActivity()).toBe(firstReceipt); expect(f.tracker.deadlineActivity(firstError)).toBe(firstReceipt);
    f.clock.value = 20_002; await vi.advanceTimersByTimeAsync(10_000);
    expect(f.tracker.deadlineActivity()).toBe(firstReceipt);
  });

  it("keeps the original deadline and marks all times unknown after invalid or backwards clock observations", async () => {
    fakeDeadlines();
    for (const mode of ["nan", "infinity", "throw", "backwards", "intermediate-backwards"] as const) {
      const f = setup(); f.clock.value = 1_000;
      f.context.emit("request", request("/api/runs")); f.clock.value = 1_100;
      const outcome = observe(f.tracker.drain());
      if (mode === "intermediate-backwards") {
        f.clock.value = 900; f.context.emit("request", request("/api/today")); f.clock.value = 2_000;
      } else if (mode === "nan") f.clock.value = Number.NaN;
      else if (mode === "infinity") f.clock.value = Number.POSITIVE_INFINITY;
      else if (mode === "throw") f.clock.fail = true;
      else f.clock.value = 900;
      await vi.advanceTimersByTimeAsync(10_000);
      const error = failure(await outcome), receipt = activity(f.tracker, error);
      expect(error.message).toContain("Browser API reads did not settle within the effect capture deadline; SMOKE_READ_DIAGNOSTIC ");
      expect(error.message).not.toContain("PRIVATE_CLOCK_FAILURE");
      expect(receipt.elapsed_ms).toBeNull(); expect(receipt.pending_reads.every((read) => read.age_ms === null)).toBe(true);
      expect(receipt).toMatchObject({ read_timeout_ms: 10_000, pending_at_start: 1, pending_at_deadline: mode === "intermediate-backwards" ? 2 : 1,
        started_in_window: mode === "intermediate-backwards" ? 1 : 0, finished_in_window: 0, failed_in_window: 0 });
      if (mode === "intermediate-backwards") {
        f.clock.value = 3_000;
        const recovered = observe(f.tracker.drain()); f.clock.value = 4_000;
        await vi.advanceTimersByTimeAsync(10_000);
        const stillUnknown = activity(f.tracker, failure(await recovered));
        expect(stillUnknown.elapsed_ms).toBeNull(); expect(stillUnknown.pending_reads.every((read) => read.age_ms === null)).toBe(true);
      }
    }
  });

  it("binds concurrent snapshot and drain receipts to their exact errors with independent windows and phases", async () => {
    fakeDeadlines();
    const f = setup(), read = request("/api/runs");
    const capture = vi.fn(async () => {
      f.clock.value = 100; f.context.emit("request", read);
      return new Promise<never>(() => {});
    });
    const snapshot = observe(f.tracker.snapshot(capture, 10_000, "phase-n-before-preview"));
    await Promise.resolve(); await turn();
    expect(capture).toHaveBeenCalledOnce();
    const drain = observe(f.tracker.drain(30_000));
    f.clock.value = 10_000; await vi.advanceTimersByTimeAsync(10_000);
    const snapshotError = failure(await snapshot), snapshotReceipt = activity(f.tracker, snapshotError);
    expect(snapshotReceipt).toMatchObject({
      label: "phase-n-before-preview", phase: "capturing", read_timeout_ms: 10_000, elapsed_ms: 10_000,
      pending_at_start: 0, pending_at_deadline: 1, started_in_window: 1, finished_in_window: 0, failed_in_window: 0,
    });
    expect(snapshotReceipt.pending_reads).toEqual([{ method: "GET", path: "/api/runs", sequence: 1, age_ms: 9_900, started_in_window: true }]);
    f.clock.value = 30_100; await vi.advanceTimersByTimeAsync(20_000);
    const drainError = failure(await drain), drainReceipt = activity(f.tracker, drainError);
    expect(drainReceipt).toMatchObject({
      label: "unlabelled", phase: "drain", read_timeout_ms: 30_000, elapsed_ms: 30_000,
      pending_at_start: 1, pending_at_deadline: 1, started_in_window: 0, finished_in_window: 0, failed_in_window: 0,
    });
    expect(drainReceipt.pending_reads).toEqual([{ method: "GET", path: "/api/runs", sequence: 1, age_ms: 30_000, started_in_window: false }]);
    expect(f.tracker.deadlineActivity()).toBe(drainReceipt);
    expect(f.tracker.deadlineActivity(snapshotError)).toBe(snapshotReceipt);
    expect(f.tracker.deadlineActivity(drainError)).toBe(drainReceipt);
    expect(f.tracker.deadlineActivity(new Error("Synthetic unrelated failure"))).toBeNull();
  });
});

describe("planner-recovery fixture boundary", () => {
  it("refuses the actual test bootstrap outside its owned root before state or runtime effects", () => {
    const root = mkdtempSync(join(tmpdir(), "surtec-recovery-bootstrap-")); owned.push(root);
    const environment: Record<string, string> = { NODE_ENV: "test", SURTEC_SMOKE_FIXTURE_ROOT: root, SURTEC_STATE_DIR: join(root, "state"),
      SURTEC_PROJECTS_ROOT: join(root, "projects"), SURTEC_CODEX_BIN: join(root, "forbidden-paid-runtime"), TEMP: tmpdir(), TMP: tmpdir() };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH", "Path", "LOCALAPPDATA"]) if (process.env[key]) environment[key] = process.env[key]!;
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/fixtures/local-issue-api.ts"], { cwd: repository, env: environment, windowsHide: true, encoding: "utf8", timeout: 9000 });
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(1);
    expect(result.stderr).toContain("test bootstrap requires its owned OS-temp fixture");
    expect(existsSync(join(root, "state"))).toBe(false); expect(existsSync(join(root, "executor-effects.jsonl"))).toBe(false);
  }, 10000);
});



describe("uncharged-claim fixture transport and native closure", () => {
  afterEach(() => vi.useRealTimers());
  const action = (): UnchargedFixtureAction => ({ kind: "recover-uncharged-claim", workflow_id: "workflow-1", expected_revision: 14, expected_task_revision: 3 });
  function ipc(reply?: (message: Record<string, unknown>, child: EventEmitter) => void) {
    const child = Object.assign(new EventEmitter(), { connected: true, send: vi.fn((message: Record<string, unknown>, callback: (error: Error | null) => void) => {
      reply?.(message, child); callback(null); return true;
    }) });
    return child;
  }
  it("binds a reply to its exact child request and removes listeners after success", async () => {
    const child = ipc((message, emitter) => {
      emitter.emit("message", { kind: "uncharged-claim-fixture-result", request_id: "unrelated", ok: true, result: { started: true } });
      emitter.emit("message", { kind: "uncharged-claim-fixture-result", request_id: message.request_id, ok: true, result: { worker_started: false, phase: "ready" } });
    });
    const result = await requestUnchargedFixture(child as unknown as Parameters<typeof requestUnchargedFixture>[0], action());
    expect(result).toEqual({ worker_started: false, phase: "ready" }); expect(child.send).toHaveBeenCalledOnce();
    expect(child.listenerCount("message")).toBe(0); expect(child.listenerCount("exit")).toBe(0); expect(child.listenerCount("disconnect")).toBe(0);
    expect(Object.keys(child.send.mock.calls[0]![0]).sort()).toEqual(["expected_revision", "expected_task_revision", "kind", "request_id", "workflow_id"]);
  });
  it.each(["refusal", "exit", "disconnect", "send-error"] as const)("retains %s as failure and removes only its listeners", async (kind) => {
    const child = ipc((message, emitter) => {
      if (kind === "refusal") emitter.emit("message", { kind: "uncharged-claim-fixture-result", request_id: message.request_id, ok: false, error: "PRIVATE-NATIVE-MESSAGE" });
      if (kind === "exit") emitter.emit("exit", 1, null);
      if (kind === "disconnect") emitter.emit("disconnect");
    });
    if (kind === "send-error") child.send.mockImplementation((_message, callback) => { callback(new Error("PRIVATE-NATIVE-MESSAGE")); return false; });
    const result = await requestUnchargedFixture(child as unknown as Parameters<typeof requestUnchargedFixture>[0], action()).then(() => null, (error: Error) => error);
    expect(result).toBeInstanceOf(Error); expect(result!.message).not.toContain("PRIVATE");
    expect(child.listenerCount("message")).toBe(0); expect(child.listenerCount("exit")).toBe(0); expect(child.listenerCount("disconnect")).toBe(0);
  });
  it("retains the existing workflow observation deadline without auto resend", async () => {
    vi.useFakeTimers(); const child = ipc(); let error: Error | null = null;
    const pending = requestUnchargedFixture(child as unknown as Parameters<typeof requestUnchargedFixture>[0], action()).catch((value: Error) => { error = value; });
    await vi.advanceTimersByTimeAsync(29999); expect(error).toBeNull();
    await vi.advanceTimersByTimeAsync(1); await pending;
    expect(error).toBeInstanceOf(Error); expect(child.send).toHaveBeenCalledOnce(); expect(child.listenerCount("message")).toBe(0);
  });
  it.each(["path", "command", "kind", "revision"] as const)("refuses %s selection before sending IPC", (kind) => {
    const child = ipc(), value = action() as unknown as Record<string, unknown>;
    if (kind === "path") value.archiveRoot = "PRIVATE-EXTERNAL-PATH";
    if (kind === "command") value.command = "arbitrary command";
    if (kind === "kind") value.kind = "run-command";
    if (kind === "revision") value.expected_revision = 0;
    expect(() => requestUnchargedFixture(child as unknown as Parameters<typeof requestUnchargedFixture>[0], value as unknown as UnchargedFixtureAction)).toThrow();
    expect(child.send).not.toHaveBeenCalled(); expect(child.listenerCount("message")).toBe(0);
  });
  function nativeChild() {
    return Object.assign(new EventEmitter(), { pid: 1234, stdout: new EventEmitter(), stderr: new EventEmitter() });
  }
  it("observes root exit and both EOFs separately before returning the native packet", async () => {
    const child = nativeChild(), capture = captureUnchargedFixtureNative(child as unknown as Parameters<typeof captureUnchargedFixtureNative>[0]);
    let done = false; const pending = capture.closed.then((value) => { done = true; return value; });
    child.stdout.emit("data", Buffer.from("synthetic\n")); child.emit("exit", 2, null); await Promise.resolve(); expect(done).toBe(false);
    child.stdout.emit("end"); child.stderr.emit("end"); child.emit("close", 2, null);
    const packet = await pending;
    expect(packet).toMatchObject({ pid: 1234, native_exit: 2, native_signal: null, root_exit_observed: true, stdout_eof: true, stderr_eof: true,
      capture_truncated: false, termination_requested: false, stdout: "synthetic\n" });
  });
  it("keeps missing exit, signal, truncation and forced closure explicit rather than zero or success", async () => {
    for (const variant of ["missing-exit", "missing-eof", "signal", "truncated", "forced", "stream-error"] as const) {
      const child = nativeChild(), capture = captureUnchargedFixtureNative(child as unknown as Parameters<typeof captureUnchargedFixtureNative>[0]);
      if (variant === "truncated") child.stdout.emit("data", Buffer.alloc(65537, 120));
      if (variant === "forced") capture.markTerminationRequested();
      if (variant === "stream-error") child.stderr.emit("error", new Error("PRIVATE-STREAM-CONTENT"));
      if (variant !== "missing-exit") child.emit("exit", variant === "signal" ? null : 2, variant === "signal" ? "SIGKILL" : null);
      if (variant !== "missing-eof") child.stdout.emit("end"); child.stderr.emit("end"); child.emit("close", 2, null);
      const packet = await capture.closed;
      if (variant === "missing-exit") expect(packet).toMatchObject({ native_exit: null, root_exit_observed: false });
      if (variant === "missing-eof") expect(packet.stdout_eof).toBe(false);
      if (variant === "signal") expect(packet).toMatchObject({ native_exit: null, native_signal: "SIGKILL" });
      if (variant === "truncated") { expect(packet.capture_truncated).toBe(true); expect(packet.stdout).toBe(""); }
      if (variant === "forced") expect(packet.termination_requested).toBe(true);
      if (variant === "stream-error") { expect(packet.stream_error).toBe("stderr"); expect(JSON.stringify(packet)).not.toContain("PRIVATE"); }
    }
  });
  it("requires owned IPC before bootstrapping even with the focused flag and a syntactically owned root", () => {
    const root = mkdtempSync(join(tmpdir(), "surtec-local-dashboard-")); owned.push(root);
    const environment: Record<string, string> = { NODE_ENV: "test", SURTEC_SMOKE_FIXTURE_ROOT: root, SURTEC_STATE_DIR: join(root, "state"),
      SURTEC_PROJECTS_ROOT: join(root, "projects"), SURTEC_CODEX_BIN: join(root, "forbidden-paid-runtime"), TEMP: tmpdir(), TMP: tmpdir() };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH", "Path", "LOCALAPPDATA"]) if (process.env[key]) environment[key] = process.env[key]!;
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/fixtures/local-issue-api.ts", "--uncharged-claim-recovery-only"],
      { cwd: repository, env: environment, windowsHide: true, encoding: "utf8", timeout: 9000 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.signal).toBeNull();
    expect(result.stderr).toContain("uncharged-claim fixture requires its owned parent IPC channel");
    expect(existsSync(join(root, "state"))).toBe(false); expect(existsSync(join(root, "executor-effects.jsonl"))).toBe(false);
  }, 10000);
});

describe("planner-recovery workflow read boundary", () => {
  it("closes panels before awaiting existing reads and does not finish until they settle", async () => {
    const counts: Record<string, number> = { "Ocultar workflow": 2, "Ocultar linaje": 1 }, calls: string[] = [];
    const page = { getByRole: (_role: string, options: { name: string; exact: boolean }) => {
      expect(options.exact).toBe(true); expect(Object.hasOwn(counts, options.name)).toBe(true);
      return { count: async () => counts[options.name], first: () => ({ click: async () => { counts[options.name]--; calls.push(options.name); } }) };
    } } as unknown as Pick<import("playwright").Page, "getByRole">;
    let release: () => void = () => {}, completed = false;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const drain = vi.fn(async () => { expect(Object.values(counts)).toEqual([0, 0]); calls.push("drain"); await pending; });
    const result = settleWorkflowPanels(page, drain).then(() => { completed = true; });
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    expect(completed).toBe(false); expect(calls).toEqual(["Ocultar workflow", "Ocultar workflow", "Ocultar linaje", "drain"]);
    release(); await result; expect(completed).toBe(true);
  });
  it("retains a failed drain as a failure instead of skipping pending reads", async () => {
    const failure = new Error("synthetic bounded read did not settle");
    const page = { getByRole: () => ({ count: async () => 0 }) } as unknown as Pick<import("playwright").Page, "getByRole">;
    await expect(settleWorkflowPanels(page, async () => { throw failure; })).rejects.toBe(failure);
  });
});
