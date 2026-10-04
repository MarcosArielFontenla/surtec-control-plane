import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, fsyncSync,
  rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync, linkSync, lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { systemProcessEnvironment } from "../security/environment";
import { WORKFLOW_LIMITS, type WorkflowDocument, type WorkflowGrant, type GovernedWorkflow, type WorkflowStage } from "../workflows/types";
import { readWorkflowDocument, mutateWorkflowDocument, UnsupportedWorkflowVersionError, WorkflowStateError } from "./workflows";
import { workflowStatePath } from "./paths";
import { StateLockConflictError } from "./store";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync), writeFileSync: vi.fn(actual.writeFileSync), renameSync: vi.fn(actual.renameSync), fsyncSync: vi.fn(actual.fsyncSync) };
});
const roots: string[] = [], children = new Set<ChildProcess>();
afterEach(async () => {
  await Promise.all([...children].map((proc) => new Promise<void>((done) => { proc.once("close", () => done()); proc.kill(); }))); children.clear();
  vi.restoreAllMocks(); vi.mocked(openSync).mockReset(); vi.mocked(writeFileSync).mockReset(); vi.mocked(renameSync).mockReset(); vi.mocked(fsyncSync).mockReset();
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
  it("preserves old snapshot and cleans only its unique stage when replacement fails", () => {
    const { path, lock } = fixture(); mutateWorkflowDocument(seed, path); raw(`${path}.unknown.tmp`, "unowned"); const before = readFileSync(path);
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("synthetic rename failure"); });
    expect(() => mutateWorkflowDocument(update, path)).toThrow(WorkflowStateError);
    expect(readFileSync(path)).toEqual(before); expect(readdirSync(dirname(path)).sort()).toEqual(["workflows.json", "workflows.json.unknown.tmp"]); expect(existsSync(lock)).toBe(false);
  });
  it("preserves old bytes on staged write failure", async () => {
    const { path, lock } = fixture(); mutateWorkflowDocument(seed, path); const before = readFileSync(path);
    // Keep the lock initialization real; fail only the staged document write.
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(writeFileSync).mockImplementationOnce(fs.writeFileSync).mockImplementationOnce(() => { throw new Error("synthetic write failure"); });
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
  it("cleans only its uninitialized lock after a token write failure", () => {
    const { path, lock } = fixture(); vi.mocked(writeFileSync).mockImplementationOnce(() => { throw new Error("SYNTHETIC-PRIVATE-MARKER"); });
    expect(() => mutateWorkflowDocument(seed, path)).toThrow(/lock initialization failed/);
    expect(existsSync(path)).toBe(false); expect(existsSync(lock)).toBe(false);
  });
  it("preserves the previous snapshot if flushing its stage fails", () => {
    const { path, lock } = fixture(); mutateWorkflowDocument(seed, path); const before = readFileSync(path);
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error("synthetic flush failure"); });
    expect(() => mutateWorkflowDocument(update, path)).toThrow(/replacement failed/);
    expect(readFileSync(path)).toEqual(before); expect(readdirSync(dirname(path))).toEqual(["workflows.json"]); expect(existsSync(lock)).toBe(false);
  });
  it("enforces real cross-process exclusion and reads the last committed snapshot", async () => {
    const { path, lock } = fixture(); mutateWorkflowDocument(seed, path);
    // A bounded synchronous hold lets another Node process attempt the same
    // named lock. No project commands, model call or external provider runs.
    const holderSource = `import { mutateWorkflowDocument } from ${JSON.stringify(moduleUrl)};
      import { readSync } from 'node:fs';
      mutateWorkflowDocument(d => { process.stdout.write('LOCKED\\n'); readSync(0, Buffer.alloc(1), 0, 1, null); d.workflows['workflow-1'].revision++; d.workflows['workflow-1'].counters.total_tokens++; }, process.argv[1]);`;
    const holder = child(holderSource, [path]);
    await new Promise<void>((ready, reject) => {
      holder.proc.stdout!.on("data", (data) => { if (String(data).includes("LOCKED")) ready(); }); holder.proc.on("close", (code) => reject(new Error(`holder exited before locking: ${code}`))); holder.proc.on("error", reject);
    });
    const contender = child(`import { mutateWorkflowDocument } from ${JSON.stringify(moduleUrl)};
      try { mutateWorkflowDocument(() => { throw new Error('must not run'); }, process.argv[1]); process.exitCode = 2; } catch (e) { if (e.constructor.name !== 'StateLockConflictError') throw e; process.stdout.write('CONFLICT'); }`, [path]);
    const conflict = await contender.done; holder.proc.stdin!.write("x"); holder.proc.stdin!.end();
    expect(conflict).toEqual({ code: 0, out: "CONFLICT", err: "" }); expect((await holder.done).code).toBe(0);
    expect(readWorkflowDocument(path).workflows["workflow-1"]!.revision).toBe(2); expect(existsSync(lock)).toBe(false);
    const restarted = child(`import { readWorkflowDocument, mutateWorkflowDocument } from ${JSON.stringify(moduleUrl)};
      if (readWorkflowDocument(process.argv[1]).workflows['workflow-1'].revision !== 2) throw new Error('lost snapshot');
      mutateWorkflowDocument(d => { d.workflows['workflow-1'].revision++; d.workflows['workflow-1'].counters.total_tokens++; }, process.argv[1]);`, [path]);
    expect((await restarted.done).code).toBe(0); expect(readWorkflowDocument(path).workflows["workflow-1"]!.counters.total_tokens).toBe(2);
  }, 10_000);
});
