import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, fsyncSync,
  rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync, linkSync, lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { systemProcessEnvironment } from "../security/environment";
import { WORKFLOW_LIMITS, type WorkflowDocument, type WorkflowGrant, type GovernedWorkflow, type WorkflowStage } from "../workflows/types";
import { readWorkflowDocument, mutateWorkflowDocument, UnsupportedWorkflowVersionError, WorkflowStateError } from "./workflows";
import { acquireMaintenanceExclusive, releaseMaintenanceExclusive, setMaintenanceHold } from "./maintenance";
import { maintenanceGatePath, workflowStatePath } from "./paths";
import { StateLockConflictError } from "./store";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, closeSync: vi.fn(actual.closeSync), readFileSync: vi.fn(actual.readFileSync), openSync: vi.fn(actual.openSync), writeFileSync: vi.fn(actual.writeFileSync), renameSync: vi.fn(actual.renameSync), fsyncSync: vi.fn(actual.fsyncSync) };
});
const roots: string[] = [], children = new Set<ChildProcess>();
afterEach(async () => {
  await Promise.all([...children].map((proc) => new Promise<void>((done) => { proc.once("close", () => done()); proc.kill(); }))); children.clear();
  vi.restoreAllMocks(); vi.mocked(openSync).mockReset(); vi.mocked(writeFileSync).mockReset(); vi.mocked(renameSync).mockReset(); vi.mocked(fsyncSync).mockReset();
  vi.mocked(closeSync).mockReset(); vi.mocked(readFileSync).mockReset();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); vi.unstubAllEnvs();
});
const at = "2026-10-02T12:00:00Z", hash = "a".repeat(64);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "surtec-workflow-state-")); roots.push(root);
  const state = join(root, "state"), path = workflowStatePath(state), lock = join(state, "locks", "workflows.lock");
  return { root, state, path, lock };
}
function seed(document: WorkflowDocument, suffix = "1"): void {
  const id = `workflow-${suffix}`, stageId = `stage-${suffix}`, grantId = `grant-${suffix}`;
  const budget = { max_tasks: 7, max_attempts: 10, max_runtime_ms: 900000, max_total_tokens: 100000 };
  const grant: WorkflowGrant = { schema_version: 1, id: grantId, workflow_id: id, project_id: "synthetic", issue_id: `issue-${suffix}`, issue_revision: 1, scope_revision: 1, authority_revision: 1, template_id: "analysis", template_version: 1,
    authorized_scope: { expected_outcome: "Inspect synthetic state", acceptance_criteria: ["Produce bounded observations"], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["code"], explicit_exclusions: [] },
    role_assignments: [{ role_id: "portfolio-analyst", agent_id: "analyst", sandbox: "read-only", client_context_categories: [] }], permitted_stage_kinds: ["analysis"], source_fingerprints: [{ id: "runtime/safety", fingerprint: hash }], policy_fingerprint: hash, preview_fingerprint: hash, testing_policy_fingerprint: hash, minimum_review_depth: "focused", testing_mode: "functional", budget, correction: { enabled: false, max_corrections: 0, budget: null }, approved_by: "human", approval_id: `synthetic-approval-${suffix}`, approved_at: at };
  const workflow: GovernedWorkflow = { schema_version: 1, id, revision: 1, project_id: "synthetic", issue_id: grant.issue_id, scope_revision: 1, template_id: "analysis", template_version: 1, status: "running", work_scale: "bounded", current_grant_id: grantId, authority_revision: 1,
    stage_ids: [stageId], current_stage_id: stageId, pending_decision_id: null, lineage_id: null, candidate: null, approved_plan: null, review_policy: null, budget, counters: { tasks: 0, attempts: 0, runtime_ms: 0, total_tokens: 0, accounting_complete: true }, blocked_reason: null, recovery_state: "none", next_action: "Wait for admission", stop_requested_at: null, created_at: at, updated_at: at, completed_at: null };
  const stage: WorkflowStage = { schema_version: 1, id: stageId, workflow_id: id, grant_id: grantId, authority_revision: 1, generation: 1, ordinal: 1, kind: "analysis", role_id: "portfolio-analyst", agent_id: "analyst", sandbox: "read-only", status: "pending", phase: "execution", task_id: null, execution_id: null, predecessor_stage_id: null, supersedes_stage_id: null, handoff_id: null, output: null, output_fingerprint: null, candidate: null, context_fingerprint: null, created_at: at, updated_at: at };
  document.workflows[id] = workflow; document.grants[grantId] = grant; document.stages[stageId] = stage;
}
function update(document: WorkflowDocument) { const w = document.workflows["workflow-1"]!; w.revision++; w.counters.total_tokens++; }
function raw(path: string, value: string | Buffer) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
function child(source: string, args: string[]) {
  const proc = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, ...args], { cwd: process.cwd(), env: systemProcessEnvironment(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); children.add(proc);
  let out = "", err = ""; proc.stdout!.on("data", (data) => { out += String(data); }); proc.stderr!.on("data", (data) => { err += String(data); });
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolveDone, reject) => {
    proc.on("error", reject); proc.on("close", (code) => { children.delete(proc); resolveDone({ code, out, err }); });
  });
  return { proc, done };
}
const moduleUrl = pathToFileURL(resolve("lib/state/workflows.ts")).href;
describe("uncharged-claim stored compatibility", () => {
  it.each([null, { schema_version: 2 }, { schema_version: 1, phase: "ready", verified: true }])("retains invalid/future source bytes %# without mutation", (value) => {
    const f = fixture(); mutateWorkflowDocument((d) => seed(d), f.path);
    const document = JSON.parse(readFileSync(f.path, "utf8")); document.workflows["workflow-1"].uncharged_claim_recovery = value;
    const bytes = JSON.stringify(document); writeFileSync(f.path, bytes);
    expect(() => readWorkflowDocument(f.path)).toThrow(WorkflowStateError);
    expect(() => mutateWorkflowDocument(() => undefined, f.path)).toThrow(WorkflowStateError);
    expect(readFileSync(f.path, "utf8")).toBe(bytes); expect(existsSync(f.lock)).toBe(false);
  });
});
describe("uncharged-claim bounded write diagnostics", () => {

  it.each(["open", "write", "flush", "close", "ownership", "rename"] as const)("uncharged-claim retains old bytes and reports bounded %s classification", async (kind) => {
    const f = fixture(); mutateWorkflowDocument((d) => seed(d), f.path); raw(f.path + ".unowned.tmp", "unowned");
    const before = readFileSync(f.path), fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const fault = () => Object.assign(new Error("SYNTHETIC-PRIVATE-MARKER " + f.path), { code: "EPERM", syscall: kind === "flush" ? "fsync" : kind });
    const stage = (fd: number) => openedPath(fd)?.startsWith(f.path + ".");
    if (kind === "open") vi.mocked(openSync).mockImplementation((target, ...args) => {
      if (String(target).startsWith(f.path + ".")) throw fault(); return fs.openSync(target, ...args);
    });
    if (kind === "write") vi.mocked(writeFileSync).mockImplementation((target, ...args) => {
      if (typeof target === "number" && stage(target)) throw fault(); return fs.writeFileSync(target, ...args);
    });
    if (kind === "flush") vi.mocked(fsyncSync).mockImplementation((fd) => { if (stage(fd)) throw fault(); return fs.fsyncSync(fd); });
    if (kind === "close") {
      let failed = false;
      vi.mocked(closeSync).mockImplementation((fd) => { if (stage(fd) && !failed) { failed = true; throw fault(); } return fs.closeSync(fd); });
    }
    if (kind === "ownership") {
      let armed = false;
      vi.mocked(fsyncSync).mockImplementation((fd) => { fs.fsyncSync(fd); if (stage(fd)) armed = true; });
      vi.mocked(readFileSync).mockImplementation(((...args: Parameters<typeof readFileSync>) => {
        if (String(args[0]) === f.lock && armed) { armed = false; throw fault(); } return fs.readFileSync(...args);
      }) as typeof readFileSync);
    }
    if (kind === "rename") vi.mocked(renameSync).mockImplementation((source, destination) => {
      if (String(source).startsWith(f.path + ".") && String(destination) === f.path) throw fault(); return fs.renameSync(source, destination);
    });
    let retained: unknown;
    try { mutateWorkflowDocument(update, f.path); } catch (error) { retained = error; }
    expect(retained).toBeInstanceOf(WorkflowStateError);
    const error = retained as WorkflowStateError;
    expect(error.message).toBe("Workflow replacement failed; the previous snapshot was not replaced.");
    const phases = { open: "stage-open", write: "stage-write", flush: "stage-flush", close: "stage-close", ownership: "ownership", rename: "rename" };
    expect(error.diagnostic).toEqual({ phase: phases[kind], code: kind === "ownership" ? "UNKNOWN" : "EPERM",
      syscall: kind === "ownership" ? "UNKNOWN" : kind === "flush" ? "fsync" : kind });
    expect(Object.isFrozen(error.diagnostic)).toBe(true); expect(Object.hasOwn(error, "cause")).toBe(false);
    expect(JSON.stringify(error)).not.toContain("SYNTHETIC-PRIVATE-MARKER"); expect(JSON.stringify(error)).not.toContain(f.path);
    expect(readFileSync(f.path)).toEqual(before); expect(existsSync(f.lock)).toBe(false);
    expect(readdirSync(dirname(f.path)).sort()).toEqual(["workflows.json", "workflows.json.unowned.tmp"]);
  });
  it.each(["getter", "proxy", "unknown"] as const)("uncharged-claim does not inspect native %s hooks or retain arbitrary text", async (kind) => {
    const f = fixture(); mutateWorkflowDocument((d) => seed(d), f.path);
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs"); let called = 0;
    const native = kind === "getter" ? Object.defineProperty(new Error("SYNTHETIC-PRIVATE-MARKER"), "code", { get() { called++; return "EPERM"; } })
      : kind === "proxy" ? new Proxy({}, { get() { called++; throw new Error("must not run"); }, getOwnPropertyDescriptor() { called++; throw new Error("must not run"); } })
      : Object.assign(new Error("SYNTHETIC-PRIVATE-MARKER"), { code: "private code", syscall: "private syscall" });
    vi.mocked(renameSync).mockImplementation((source, destination) => {
      if (String(destination) === f.path) throw native; return fs.renameSync(source, destination);
    });
    let retained: unknown;
    try { mutateWorkflowDocument(update, f.path); } catch (error) { retained = error; }
    expect((retained as WorkflowStateError).diagnostic).toEqual({ phase: "rename", code: "UNKNOWN", syscall: "UNKNOWN" });
    expect(called).toBe(0); expect(JSON.stringify(retained)).not.toContain("private");
  });

});
describe("planner-recovery stored compatibility", () => {
  it.each([null, { schema_version: 2 }, { schema_version: 1, requested_by: "agent" }])("preserves invalid/future facet bytes %#", (value) => {
    const f = fixture(); mutateWorkflowDocument((d) => seed(d), f.path);
    const document = JSON.parse(readFileSync(f.path, "utf8")); document.workflows["workflow-1"].planner_recovery = value;
    const bytes = JSON.stringify(document); writeFileSync(f.path, bytes);
    expect(() => readWorkflowDocument(f.path)).toThrow(WorkflowStateError);
    expect(() => mutateWorkflowDocument(() => undefined, f.path)).toThrow(WorkflowStateError);
    expect(readFileSync(f.path, "utf8")).toBe(bytes);
  });
});
function openedPath(fd: number): string | undefined {
  const mocked = vi.mocked(openSync);
  for (let index = mocked.mock.results.length - 1; index >= 0; index--) {
    const result = mocked.mock.results[index]!;
    if (result.type === "return" && result.value === fd) return String(mocked.mock.calls[index]![0]);
  }
  return undefined;
}

describe("optional workflow store (T003)", () => {
  it("reads absence without creating any directory and returns independent empty documents", () => {
    const { path, state } = fixture(), a = readWorkflowDocument(path), b = readWorkflowDocument(path);
    expect(a).toEqual(b); expect(a).not.toBe(b); expect(existsSync(state)).toBe(false);
    seed(a); expect(readWorkflowDocument(path).workflows).toEqual({});
  });
  it("honors the selected state root without touching default state", () => {
    const { path, state } = fixture(); vi.stubEnv("SURTEC_STATE_DIR", state);
    expect(workflowStatePath()).toBe(path); mutateWorkflowDocument(seed); expect(Object.keys(readWorkflowDocument().workflows)).toEqual(["workflow-1"]);
  });
  it("persists and reloads fresh state, preserving other optional stores", () => {
    const { root, path } = fixture(); raw(join(root, "state/issues/issues.json"), "SYNTHETIC-UNTOUCHED");
    const result = mutateWorkflowDocument((d) => { seed(d); return "saved"; }, path); expect(result).toBe("saved");
    mutateWorkflowDocument((d) => seed(d, "2"), path);
    expect(Object.keys(readWorkflowDocument(path).workflows)).toEqual(["workflow-1", "workflow-2"]);
    expect(readFileSync(join(root, "state/issues/issues.json"), "utf8")).toBe("SYNTHETIC-UNTOUCHED");
    expect(readdirSync(dirname(path))).toEqual(["workflows.json"]);
  });
  it("does not replace bytes for a no-op, including absent optional state", () => {
    const { path } = fixture(); mutateWorkflowDocument(() => undefined, path); expect(existsSync(path)).toBe(false);
    mutateWorkflowDocument(seed, path); const before = readFileSync(path), stat = lstatSync(path);
    mutateWorkflowDocument(() => undefined, path);
    expect(readFileSync(path)).toEqual(before); expect(lstatSync(path).mtimeMs).toBe(stat.mtimeMs);
  });
  it.each(["{", "null", "[]", '{"schema_version":"1"}', '{"schema_version":0}', '{"schema_version":1}', '{"schema_version":2}', '{"schema_version":1,"private":"SYNTHETIC-PRIVATE-MARKER"}'])("preserves malformed or unsupported bytes %s", (bytes) => {
    const { path, lock } = fixture(); raw(path, bytes); const mutate = vi.fn(seed);
    expect(() => readWorkflowDocument(path)).toThrow(WorkflowStateError); expect(() => mutateWorkflowDocument(mutate, path)).toThrow(WorkflowStateError);
    expect(mutate).not.toHaveBeenCalled(); expect(readFileSync(path, "utf8")).toBe(bytes); expect(existsSync(dirname(lock))).toBe(false);
  });
  it("reports future version explicitly but never prints its input body", () => {
    const { path } = fixture(); raw(path, '{"schema_version":3,"private":"SYNTHETIC-PRIVATE-MARKER"}');
    try { readWorkflowDocument(path); throw new Error("must reject"); } catch (error) { expect(error).toBeInstanceOf(UnsupportedWorkflowVersionError); expect((error as UnsupportedWorkflowVersionError).version).toBe(3); expect((error as Error).message).not.toContain("SYNTHETIC-PRIVATE-MARKER"); }
  });
  it("rejects oversized raw bytes and invalid UTF-8 before any mutation", () => {
    const { path } = fixture(); raw(path, " "); truncateSync(path, WORKFLOW_LIMITS.documentBytes + 1);
    expect(() => readWorkflowDocument(path)).toThrow(WorkflowStateError); expect(lstatSync(path).size).toBe(WORKFLOW_LIMITS.documentBytes + 1);
    raw(path, Buffer.from([0xff, 0xfe])); expect(() => mutateWorkflowDocument(seed, path)).toThrow(WorkflowStateError); expect(readFileSync(path)).toEqual(Buffer.from([0xff, 0xfe]));
  });
  it("rejects cross-record corruption and unsafe file types without repairing them", () => {
    const { path, lock } = fixture(); mutateWorkflowDocument(seed, path); const d = readWorkflowDocument(path); d.grants["grant-1"]!.issue_id = "other";
    raw(path, JSON.stringify(d)); const before = readFileSync(path); expect(() => mutateWorkflowDocument(seed, path)).toThrow(); expect(readFileSync(path)).toEqual(before); expect(existsSync(lock)).toBe(false);
    const other = fixture(); mkdirSync(other.path, { recursive: true }); expect(() => readWorkflowDocument(other.path)).toThrow();
  });
  it.each(["state", "workflows", "file", "locks"])("rejects a redirected %s path without changing its destination", (redirect) => {
    const f = fixture(), target = join(f.root, "redirect-target"); mkdirSync(target); raw(join(target, "sentinel"), "untouched");
    if (redirect === "state") symlinkSync(target, f.state, "junction");
    else if (redirect === "workflows") { mkdirSync(f.state); symlinkSync(target, dirname(f.path), "junction"); }
    else if (redirect === "locks") { mkdirSync(f.state); symlinkSync(target, dirname(f.lock), "junction"); }
    else { mkdirSync(dirname(f.path), { recursive: true }); symlinkSync(target, f.path, "junction"); }
    expect(() => mutateWorkflowDocument(seed, f.path)).toThrow(WorkflowStateError);
    expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("untouched"); expect(existsSync(join(target, "workflows.lock"))).toBe(false);
  });
  it("rejects hard-linked snapshots without modifying the other link", () => {
    const { root, path } = fixture(); const target = join(root, "original.json"); raw(target, "{}"); mkdirSync(dirname(path), { recursive: true }); linkSync(target, path);
    expect(() => mutateWorkflowDocument(seed, path)).toThrow(); expect(readFileSync(target, "utf8")).toBe("{}");
  });
  it.each([0, 60_000])("never steals an existing lock, even when it is %i ms old", (age) => {
    const { path, lock } = fixture(); raw(lock, "unknown owner"); const time = new Date(Date.now() - age); utimesSync(lock, time, time);
    const mutate = vi.fn(seed); expect(() => mutateWorkflowDocument(mutate, path)).toThrow(StateLockConflictError);
    expect(mutate).not.toHaveBeenCalled(); expect(readFileSync(lock, "utf8")).toBe("unknown owner"); expect(existsSync(path)).toBe(false);
  });
  it("rejects async/reentrant callbacks and rolls back invalid or thrown mutations", () => {
    const { path, lock } = fixture(); mutateWorkflowDocument(seed, path); const before = readFileSync(path);
    expect(() => mutateWorkflowDocument(async (d) => update(d), path)).toThrow(/synchronous/);
    expect(() => mutateWorkflowDocument((d) => { update(d); mutateWorkflowDocument(seed, path); }, path)).toThrow(StateLockConflictError);
    expect(() => mutateWorkflowDocument((d) => { update(d); d.workflows["workflow-1"]!.revision--; }, path)).toThrow(/revision/);
    expect(() => mutateWorkflowDocument((d) => { update(d); throw new Error("synthetic callback failure"); }, path)).toThrow(/callback failure/);
    expect(readFileSync(path)).toEqual(before); expect(existsSync(lock)).toBe(false);
  });
  it.each(["async", "generator", "proxy"])("rejects a %s callback before executing it or creating maintenance state", (kind) => {
    const { path, state } = fixture(), called = vi.fn(), hook = vi.fn();
    const mutate = kind === "async" ? async (document: WorkflowDocument) => { called(); seed(document); }
      : kind === "generator" ? function* (document: WorkflowDocument) { called(); seed(document); yield undefined; }
      : new Proxy((document: WorkflowDocument) => { called(); seed(document); }, { apply() { hook(); }, get() { hook(); return undefined; } });
    expect(() => mutateWorkflowDocument<unknown>(mutate, path)).toThrow(/synchronous/);
    expect(called).not.toHaveBeenCalled(); expect(hook).not.toHaveBeenCalled(); expect(existsSync(state)).toBe(false);
  });
  it.each(["promise", "own-getter", "inherited-getter", "own-then", "inherited-then", "proxy"])("rejects a %s result without running hooks or replacing workflow bytes", (kind) => {
    const { path, state, lock } = fixture(); mutateWorkflowDocument(seed, path); const before = readFileSync(path), hook = vi.fn();
    let result: unknown;
    if (kind === "promise") result = Promise.resolve();
    else if (kind === "proxy") result = new Proxy({}, { get() { hook(); return undefined; }, ownKeys() { hook(); return []; }, getPrototypeOf() { hook(); return null; } });
    else {
      const then = kind.endsWith("getter") ? { get: hook } : { value: hook };
      const object = Object.defineProperty({}, "then", then);
      result = kind.startsWith("inherited") ? Object.create(object) : object;
    }
    expect(() => mutateWorkflowDocument((document) => { update(document); return result; }, path)).toThrow(/synchronous/);
    expect(hook).not.toHaveBeenCalled(); expect(readFileSync(path)).toEqual(before); expect(existsSync(lock)).toBe(false);
    const gate = maintenanceGatePath(state), retained = readFileSync(gate), mutate = vi.fn(update);
    expect(() => mutateWorkflowDocument(mutate, path)).toThrow(StateLockConflictError);
    expect(() => acquireMaintenanceExclusive(state)).toThrow(StateLockConflictError);
    expect(mutate).not.toHaveBeenCalled(); expect(readFileSync(path)).toEqual(before); expect(readFileSync(gate)).toEqual(retained);
  });
  it("preserves old snapshot and cleans only its unique stage when replacement fails", async () => {
    const { path, lock } = fixture(); mutateWorkflowDocument(seed, path); raw(`${path}.unknown.tmp`, "unowned"); const before = readFileSync(path);
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(renameSync).mockImplementation((source, destination) => {
      if (String(source).startsWith(`${path}.`) && String(destination) === path) throw new Error("synthetic rename failure");
      return fs.renameSync(source, destination);
    });
    expect(() => mutateWorkflowDocument(update, path)).toThrow(WorkflowStateError);
    expect(readFileSync(path)).toEqual(before); expect(readdirSync(dirname(path)).sort()).toEqual(["workflows.json", "workflows.json.unknown.tmp"]); expect(existsSync(lock)).toBe(false);
  });
  it("preserves old bytes on staged write failure", async () => {
    const { path, lock } = fixture(); mutateWorkflowDocument(seed, path); const before = readFileSync(path);
    // Keep both coordination and domain lock writes real; fail only this stage.
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(writeFileSync).mockImplementation((target, ...args) => {
      if (typeof target === "number" && openedPath(target)?.startsWith(`${path}.`)) throw new Error("synthetic write failure");
      return fs.writeFileSync(target, ...args);
    });
    expect(() => mutateWorkflowDocument(update, path)).toThrow(WorkflowStateError);
    expect(readFileSync(path)).toEqual(before); expect(readdirSync(dirname(path))).toEqual(["workflows.json"]); expect(existsSync(lock)).toBe(false);
  });
  it("never commits or deletes a replaced lock after ownership loss", () => {
    const { path, lock } = fixture(); mutateWorkflowDocument(seed, path); const before = readFileSync(path);
    expect(() => mutateWorkflowDocument((d) => { update(d); raw(lock, "replacement owner"); }, path)).toThrow(/ownership/);
    expect(readFileSync(path)).toEqual(before); expect(readFileSync(lock, "utf8")).toBe("replacement owner");
  });
  it("fails closed on read errors without substituting empty state or exposing private paths", () => {
    const { path, state } = fixture(); vi.mocked(openSync).mockImplementationOnce(() => { throw Object.assign(new Error("SYNTHETIC-PRIVATE-MARKER"), { code: "EACCES" }); });
    expect(() => readWorkflowDocument(path)).toThrow(WorkflowStateError); expect(existsSync(state)).toBe(false);
  });
  it("cleans only its uninitialized lock after a token write failure", async () => {
    const { path, lock } = fixture(), fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(writeFileSync).mockImplementation((target, ...args) => {
      if (typeof target === "number" && openedPath(target) === lock) throw new Error("SYNTHETIC-PRIVATE-MARKER");
      return fs.writeFileSync(target, ...args);
    });
    expect(() => mutateWorkflowDocument(seed, path)).toThrow(/lock initialization failed/);
    expect(existsSync(path)).toBe(false); expect(existsSync(lock)).toBe(false);
  });
  it("preserves the previous snapshot if flushing its stage fails", async () => {
    const { path, lock } = fixture(); mutateWorkflowDocument(seed, path); const before = readFileSync(path);
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fsyncSync).mockImplementation((fd) => {
      if (openedPath(fd)?.startsWith(`${path}.`)) throw new Error("synthetic flush failure");
      return fs.fsyncSync(fd);
    });
    expect(() => mutateWorkflowDocument(update, path)).toThrow(/replacement failed/);
    expect(readFileSync(path)).toEqual(before); expect(readdirSync(dirname(path))).toEqual(["workflows.json"]); expect(existsSync(lock)).toBe(false);
  });
  it.each([false, true])("fences maintenance before workflow reads, locks and callbacks (present: %s)", (present) => {
    const { path, state, lock } = fixture();
    if (present) mutateWorkflowDocument(seed, path);
    const before = present ? readFileSync(path) : null, owner = acquireMaintenanceExclusive(state), mutate = vi.fn(seed);
    try {
      vi.mocked(openSync).mockClear();
      expect(() => mutateWorkflowDocument(mutate, path)).toThrow(StateLockConflictError);
      expect(mutate).not.toHaveBeenCalled();
      expect(vi.mocked(openSync).mock.calls.some(([target]) => String(target) === path || String(target) === lock)).toBe(false);
      expect(existsSync(lock)).toBe(false);
      if (before) expect(readFileSync(path)).toEqual(before);
      else { expect(existsSync(path)).toBe(false); expect(existsSync(dirname(lock))).toBe(false); }
      // Inspection is side-effect-free, not permission for a mutation.
      expect(Object.keys(readWorkflowDocument(path).workflows)).toEqual(present ? ["workflow-1"] : []);
    } finally { releaseMaintenanceExclusive(owner); }
    mutateWorkflowDocument(present ? update : seed, path);
    expect(readWorkflowDocument(path).workflows["workflow-1"]!.revision).toBe(present ? 2 : 1);
  });
  it.each(["restore", "rollback", "ownership-review"] as const)("preserves workflow history beneath a durable %s hold", (kind) => {
    const { path, state, lock } = fixture(); mutateWorkflowDocument(seed, path); const before = readFileSync(path);
    const owner = acquireMaintenanceExclusive(state);
    try { setMaintenanceHold(owner, { operation_id: "synthetic-operation", kind }); }
    finally { releaseMaintenanceExclusive(owner); }
    const mutate = vi.fn(update);
    expect(() => mutateWorkflowDocument(mutate, path)).toThrow();
    expect(mutate).not.toHaveBeenCalled(); expect(readFileSync(path)).toEqual(before); expect(existsSync(lock)).toBe(false);
    expect(readWorkflowDocument(path).workflows["workflow-1"]!.revision).toBe(1);
  });
  it("retains an unknown old maintenance gate without creating a workflow lock", () => {
    const { path, state, lock } = fixture(), gate = maintenanceGatePath(state), mutate = vi.fn(seed);
    raw(gate, "unknown synthetic owner"); const old = new Date(Date.now() - 86_400_000); utimesSync(gate, old, old);
    expect(() => mutateWorkflowDocument(mutate, path)).toThrow(StateLockConflictError);
    expect(mutate).not.toHaveBeenCalled(); expect(readFileSync(gate, "utf8")).toBe("unknown synthetic owner");
    expect(existsSync(path)).toBe(false); expect(existsSync(dirname(lock))).toBe(false);
  });
  it("retains private maintenance participation for the entire synchronous callback", () => {
    const { path, state, lock } = fixture(); mutateWorkflowDocument(seed, path);
    mutateWorkflowDocument((document) => {
      expect(() => acquireMaintenanceExclusive(state)).toThrow(StateLockConflictError);
      update(document);
    }, path);
    expect(readWorkflowDocument(path).workflows["workflow-1"]!.revision).toBe(2); expect(existsSync(lock)).toBe(false);
  });
  it("refuses a late replacement of its maintenance gate before workflow staging", () => {
    const { path, state, lock } = fixture(); mutateWorkflowDocument(seed, path); const before = readFileSync(path);
    const gate = maintenanceGatePath(state);
    expect(() => mutateWorkflowDocument((document) => {
      update(document);
      raw(gate, "replacement synthetic owner");
    }, path)).toThrow();
    expect(readFileSync(path)).toEqual(before); expect(readFileSync(gate, "utf8")).toBe("replacement synthetic owner");
    expect(readdirSync(dirname(path))).toEqual(["workflows.json"]); expect(existsSync(lock)).toBe(false);
  });
  it("uses the trusted parent as the maintenance boundary for a nonstandard store filename", () => {
    const { root } = fixture(), selected = join(root, "selected-state"), path = join(selected, "workflow-history.json"), owner = acquireMaintenanceExclusive(selected);
    const mutate = vi.fn(seed);
    try {
      expect(() => mutateWorkflowDocument(mutate, path)).toThrow(StateLockConflictError);
      expect(mutate).not.toHaveBeenCalled(); expect(existsSync(path)).toBe(false);
    } finally { releaseMaintenanceExclusive(owner); }
    mutateWorkflowDocument(seed, path);
    expect(readWorkflowDocument(path).workflows["workflow-1"]!.revision).toBe(1);
    expect(existsSync(join(root, "locks"))).toBe(false);
  });
  it.runIf(process.platform === "win32")("cannot bypass the canonical maintenance boundary through a Windows folder-case alias", () => {
    const { state, path, lock } = fixture(); mutateWorkflowDocument(seed, path);
    const before = readFileSync(path), alias = join(state, "WORKFLOWS", "workflows.json"), owner = acquireMaintenanceExclusive(state), mutate = vi.fn(update);
    try {
      expect(() => mutateWorkflowDocument(mutate, alias)).toThrow(StateLockConflictError);
      expect(mutate).not.toHaveBeenCalled(); expect(readFileSync(path)).toEqual(before); expect(readFileSync(alias)).toEqual(before);
      expect(existsSync(lock)).toBe(false); expect(existsSync(join(dirname(path), "maintenance"))).toBe(false);
    } finally { releaseMaintenanceExclusive(owner); }
    mutateWorkflowDocument(update, alias);
    expect(readWorkflowDocument(path).workflows["workflow-1"]!.revision).toBe(2);
    expect(existsSync(join(dirname(path), "maintenance"))).toBe(false);
  });
  it("enforces real cross-process exclusion and reads the last committed snapshot", async () => {
    const { path, state, lock } = fixture(); mutateWorkflowDocument(seed, path);
    // A bounded synchronous hold lets another Node process attempt the same
    // named lock. No project commands, model call or external provider runs.
    const holderSource = `import { mutateWorkflowDocument } from ${JSON.stringify(moduleUrl)};
      import { readSync } from 'node:fs';
      mutateWorkflowDocument(d => { process.stdout.write('LOCKED\\n'); readSync(0, Buffer.alloc(1), 0, 1, null); d.workflows['workflow-1'].revision++; d.workflows['workflow-1'].counters.total_tokens++; }, process.argv[1]);`;
    const holder = child(holderSource, [path]);
    await new Promise<void>((ready, reject) => {
      holder.proc.stdout!.on("data", (data) => { if (String(data).includes("LOCKED")) ready(); }); holder.proc.on("close", (code) => reject(new Error(`holder exited before locking: ${code}`))); holder.proc.on("error", reject);
    });
    // This process cannot declare quiescence while another process owns a
    // complete workflow RMW, including the callback before replacement.
    expect(() => acquireMaintenanceExclusive(state)).toThrow(StateLockConflictError);
    const contender = child(`import { mutateWorkflowDocument } from ${JSON.stringify(moduleUrl)};
      try { mutateWorkflowDocument(() => { throw new Error('must not run'); }, process.argv[1]); process.exitCode = 2; } catch (e) { if (e.constructor.name !== 'StateLockConflictError') throw e; process.stdout.write('CONFLICT'); }`, [path]);
    const conflict = await contender.done; holder.proc.stdin!.write("x"); holder.proc.stdin!.end();
    expect(conflict).toEqual({ code: 0, out: "CONFLICT", err: "" }); expect((await holder.done).code).toBe(0);
    expect(readWorkflowDocument(path).workflows["workflow-1"]!.revision).toBe(2); expect(existsSync(lock)).toBe(false);
    const owner = acquireMaintenanceExclusive(state); releaseMaintenanceExclusive(owner);
    const restarted = child(`import { readWorkflowDocument, mutateWorkflowDocument } from ${JSON.stringify(moduleUrl)};
      if (readWorkflowDocument(process.argv[1]).workflows['workflow-1'].revision !== 2) throw new Error('lost snapshot');
      mutateWorkflowDocument(d => { d.workflows['workflow-1'].revision++; d.workflows['workflow-1'].counters.total_tokens++; }, process.argv[1]);`, [path]);
    expect((await restarted.done).code).toBe(0); expect(readWorkflowDocument(path).workflows["workflow-1"]!.counters.total_tokens).toBe(2);
  }, 10_000);
});
