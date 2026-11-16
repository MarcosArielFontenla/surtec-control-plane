import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  CLAIM_FAILURE, CLAIM_PRODUCER_PATHS, assertUnchargedClaimFacts, claimRecoveryBytesHash, claimRecoveryEventPayload,
  claimRecoveryFingerprint, claimRecoveryHash, inspectUnchargedClaimPackage, prepareUnchargedClaimRecovery,
  readClaimRecoveryFile, requeuedClaimTask, unchargedClaimPackage,
  isReviewedClaimProducer,
} from "./uncharged-claim-recovery";

const roots: string[] = [], hash = "a".repeat(64), at = "2026-11-03T12:00:00Z", started = "2026-11-03T12:00:01Z", finished = "2026-11-03T12:00:02Z";
afterEach(() => { for (const root of roots.splice(0)) { expect(root.startsWith(join(tmpdir(), "surtec-uncharged-"))).toBe(true); rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false); } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "surtec-uncharged-")); roots.push(root);
  const budget = { max_tasks: 4, max_attempts: 4, max_runtime_ms: 900000, max_total_tokens: 100000 };
  const taskId = "writer-task", runId = "uncharged-run", workflowId = "workflow", stageId = "engineer";
  const owner = { id: workflowId, revision: 14, project_id: "synthetic", issue_id: "issue", scope_revision: 1,
    template_id: "implementation", status: "needs-decision", recovery_state: "awaiting-human", current_grant_id: "grant", authority_revision: 1,
    stage_ids: ["planner", stageId], current_stage_id: stageId, pending_decision_id: null, stop_requested_at: null, candidate: null,
    approved_plan: { stage_id: "planner", decision_id: "plan-approval", output_fingerprint: hash },
    counters: { tasks: 2, attempts: 1, runtime_ms: 10, total_tokens: 3, accounting_complete: false }, budget };
  const grant = { id: "grant", authority_revision: 1, correction: { enabled: false } };
  const stage = { id: stageId, workflow_id: workflowId, kind: "implementation", ordinal: 2, generation: 1, status: "queued",
    sandbox: "workspace-write", phase: "execution", supersedes_stage_id: null, predecessor_stage_id: "planner",
    task_id: taskId, execution_id: null, output: null, output_fingerprint: null, candidate: null, agent_id: "engineer-agent",
    grant_id: "grant", authority_revision: 1, context_fingerprint: hash };
  const document = { schema_version: 1, workflows: { [workflowId]: owner }, grants: { grant },
    stages: { [stageId]: stage, planner: { id: "planner", kind: "planning", workflow_id: workflowId, status: "completed" } },
    decisions: { "plan-approval": { status: "approved", decided_by: "human", approval_id: "owner-plan" } },
    admission_intents: { intent: { id: "intent", stage_id: stageId, task_id: taskId, status: "committed", grant_id: "grant",
      authority_revision: 1, context_fingerprint: hash, expected_issue_revision: 5 } },
    accounting: { "plan-run": { workflow_id: workflowId, stage_id: "planner", task_id: "planner-task", execution_id: "plan-run",
      observed_tokens: 3, active_runtime_ms: 10, usage_complete: true } }, events: [], handoffs: {}, review_receipts: {}, lineages: {} };
  const task = { envelope: { id: taskId, project: "synthetic", agent: "engineer-agent", sandbox: "workspace-write", metadata: {},
    context_admission: { schema_version: 2, workflow_id: workflowId, stage_id: stageId, task_id: taskId, grant_id: "grant",
      authority_revision: 1, stage_generation: 1, stage_kind: "implementation", role_id: "software-engineer",
      issue_id: "issue", issue_revision: 5, scope_revision: 1, manifest_fingerprint: hash }, context_manifest: { fingerprint: hash } },
    lifecycle: "finished", outcome: "needs-review", revision: 3, created_at: at, started_at: started, finished_at: finished, updated_at: finished, logs_path: null,
    orchestration: { attempts: 1, max_attempts: 3, max_runtime_ms: 300000, max_total_tokens: 99997, cumulative_tokens: 0,
      lease: null, retry_at: null, cancel_requested_at: null, last_failure: { kind: "terminal", message: CLAIM_FAILURE, at: finished, run_id: runId } },
    result: { status: "needs-review", summary: "Run failed: " + CLAIM_FAILURE, blockers: [CLAIM_FAILURE], verification: null, logs_path: "",
      files_changed: [], commands_run: [], tests_run: [], risks: [], artifacts: [], next_steps: [] } };
  const events = [
    { task_id: taskId, type: "policy-evaluated", revision: 1, run_id: null, at, payload: { allowed: true, workflow_id: workflowId } },
    { task_id: taskId, type: "queued", revision: 1, run_id: null, at, payload: { intent_id: "intent" } },
    { task_id: taskId, type: "claimed", revision: 2, run_id: runId, attempt: 1, at: started, payload: { worker_id: "worker-" + process.pid + "-synthetic" } },
  ];
  const issues = { issues: { issue: { id: "issue", project_id: "synthetic", revision: 5, scope_revision: 1, status: "working", task_ids: ["planner-task", taskId] } } };
  const terminal = () => ({ status: "BLOCKED", worker_stopped: true, active_tasks: 0, plan_approved: true,
    workflow_id: workflowId, workflow_revision: owner.revision, workflow_status: owner.status, counters: owner.counters, budget });
  const native = { pid: process.pid, native_exit: 2, native_signal: null, root_exit_observed: true, stdout_eof: true, stderr_eof: true, timed_out: false,
    capture_truncated: false, spawn_error: null, stream_error: null, termination_requested: false, elapsed_ms: 10, stdout: "", stderr: "" };
  const write = () => {
    native.stdout = JSON.stringify(terminal()) + "\n";
    for (const [name, value] of Object.entries({ "workflows.json": document, "task.json": task, "issues.json": issues, "native.json": native })) writeFileSync(join(root, name), JSON.stringify(value));
    writeFileSync(join(root, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    copyFileSync(resolve("scripts/fixtures/local-issue-api.ts"), join(root, "operator.mjs"));
  };
  const proof = () => { write(); return inspectUnchargedClaimPackage({ runtimeRoot: process.cwd(), archiveRoot: root }); };
  return { root, document, owner, grant, stage, task, events, issues, native, write, proof };
}

describe("uncharged-claim positive proof", () => {
  it("retains only the three reviewed coherent source/operator pairs, refusing mixtures and drift", () => {
    const retained = ["1a945ccb03918823d0dc3e2940c54f66b13bf1d9bc5f45a63f20531cedb87f91", "dd6179e5fb58cc72419758d82818294f46292ac55507675530948340c692fb4c", "90d0903debdc20f541fd80efaefa1e30a36ab80b11fb43c3bbb120737ab7c662", "0c05418bbc8639f6a9f1b22457b803f0d520c399ab73aa22056f1801d1ad57bf", "ff537e17e592c3bd5846183cddf8b2d47152373151b7634901d71c92d36aba19"];
    const previous = ["ae285ae07a36e27343cfc1aacbee496cab6ebcf995a942711e3d2c6a72dcfac6", "d995c6b5924194ac989feec9c272cae298b29f936c5240e914aca199fdc22f81", "90d0903debdc20f541fd80efaefa1e30a36ab80b11fb43c3bbb120737ab7c662", "9e1bf920f34ca39147ed104e2ca7f872be7e08f98c49001c9e6bd4665f817748", "a9054f75be6a1adea004809d9525d33900d3caec5c7d321d34145500056b32ec"];
    const current = [...previous]; current[2] = "566703080806f778d57f0bc7cd41dbf29b964c529b9ec97d6c64ae983a0c5079";
    const pairs = [
      { sources: retained, operator: "cecd33b1b0af3ce0914f78b2e09071f9fccd3639f383666ef6dc6f73506ec94b" },
      { sources: previous, operator: "fd744851a4dad07f0f2b2bf4872974b48d6fc3b33dee5311a0ebc1fb8122540f" },
      { sources: current, operator: "5324c4da653e7b03bcaee81c8e91cabeb69b84cd900196fbc85ad7cae008585a" },
    ];
    for (const [index, pair] of pairs.entries()) {
      for (const [other, candidate] of pairs.entries()) expect(isReviewedClaimProducer(pair.sources, candidate.operator)).toBe(index === other);
      for (let position = 0; position < pair.sources.length; position++) {
        const changed = [...pair.sources]; changed[position] = "0".repeat(64);
        expect(isReviewedClaimProducer(changed, pair.operator)).toBe(false);
      }
      expect(isReviewedClaimProducer(pair.sources.slice(1), pair.operator)).toBe(false);
      expect(isReviewedClaimProducer([...pair.sources, hash], pair.operator)).toBe(false);
    }
    expect(CLAIM_PRODUCER_PATHS.map((path) => claimRecoveryBytesHash(readFileSync(resolve(path))))).toEqual(current);
    expect(claimRecoveryBytesHash(readFileSync(resolve("scripts/fixtures/local-issue-api.ts")))).toBe(pairs[2]!.operator);
  });
  it("qualifies exact closed files/producer/native/claim evidence and preserves all archived values", () => {
    const f = fixture(), proof = f.proof(), bytes = JSON.stringify(f), p = assertUnchargedClaimFacts(proof);
    expect(p.task.orchestration!.attempts).toBe(1); expect(p.document.accounting).toEqual(f.document.accounting);
    expect(JSON.stringify(f)).toBe(bytes);
    const r = prepareUnchargedClaimRecovery(proof, "2026-11-03T12:01:00Z", "synthetic-human");
    expect(r.fingerprint).toBe(claimRecoveryFingerprint(r)); expect(r.original_counters).toEqual(f.owner.counters);
    const next = requeuedClaimTask(p.task, r.created_at);
    expect(next.lifecycle).toBe("queued"); expect(next.revision).toBe(4); expect(next.orchestration!.attempts).toBe(1);
    expect(next.envelope).toEqual(p.task.envelope); expect(next.started_at).toBe(p.task.started_at);
    expect(r.requeued_task_fingerprint).toBe(claimRecoveryHash(next)); expect(r.phase).toBe("prepared");
    expect(claimRecoveryEventPayload(r)).toMatchObject({ original_outcome: "needs-review", original_run_id: "uncharged-run", original_failure: p.task.orchestration!.last_failure });
  });
  it("cannot reconstruct an opaque package proof from its JSON or projected data", () => {
    const f = fixture(), proof = f.proof();
    expect(() => unchargedClaimPackage(JSON.parse(JSON.stringify(proof)))).toThrow();
    const data = unchargedClaimPackage(proof); data.task.lifecycle = "running";
    expect(unchargedClaimPackage(proof).task.lifecycle).toBe("finished");
  });
  it.each(["claim", "gap", "cancel", "lease", "run", "tokens", "attempts", "stage", "plan", "intent", "account", "unknown", "p", "receipt", "scope", "source-event"] as const)("refuses %s evidence without a default-zero interpretation", (kind) => {
    const f = fixture();
    if (kind === "claim") f.events.pop();
    if (kind === "gap") f.task.revision = 4;
    if (kind === "cancel") f.task.orchestration.cancel_requested_at = at as never;
    if (kind === "lease") f.task.orchestration.lease = { run_id: "live" } as never;
    if (kind === "run") f.task.envelope.metadata = { run: { thread_id: "started" } };
    if (kind === "tokens") f.task.orchestration.cumulative_tokens = 1;
    if (kind === "attempts") f.task.orchestration.attempts = 2;
    if (kind === "stage") f.stage.kind = "correction";
    if (kind === "plan") f.owner.approved_plan = null as never;
    if (kind === "intent") f.document.admission_intents.intent.status = "reserved";
    if (kind === "account") f.document.accounting["hidden-run" as "plan-run"] = { ...f.document.accounting["plan-run"], task_id: "writer-task" };
    if (kind === "unknown") f.document.accounting["plan-run"].usage_complete = false;
    if (kind === "p") Object.assign(f.task.envelope, { budget_admission: {} });
    if (kind === "receipt") Object.assign(f.task, { testing_evidence: {} });
    if (kind === "scope") f.issues.issues.issue.scope_revision = 2;
    if (kind === "source-event") f.events[2]!.type = "started";
    expect(() => assertUnchargedClaimFacts(f.proof())).toThrow();
  });
  it.each(["stdout_eof", "stderr_eof", "root_exit_observed"] as const)("refuses missing native %s", (key) => {
    const f = fixture(); f.native[key] = false; expect(() => f.proof()).toThrow();
  });
  it.each([null, "2", undefined])("refuses a noninteger native exit %#", (value) => {
    const f = fixture(); f.native.native_exit = value as never; expect(() => f.proof()).toThrow();
  });
  it("refuses signalled closure without promoting an exit-code coercion", () => {
    const f = fixture(); f.native.native_signal = "SIGTERM" as never; expect(() => f.proof()).toThrow();
  });
  it("refuses unknown code and a changed operator rather than caller-supplied verified flags", () => {
    const f = fixture(); f.write(); writeFileSync(join(f.root, "operator.mjs"), "verified = true;");
    expect(() => inspectUnchargedClaimPackage({ runtimeRoot: process.cwd(), archiveRoot: f.root })).toThrow();
    const source = join(f.root, "unsupported");
    for (const path of CLAIM_PRODUCER_PATHS) { mkdirSync(join(source, path, ".."), { recursive: true }); copyFileSync(resolve(path), join(source, path)); }
    writeFileSync(join(source, CLAIM_PRODUCER_PATHS[0]), "Unknown charge order");
    expect(() => inspectUnchargedClaimPackage({ runtimeRoot: source, archiveRoot: f.root })).toThrow();
  });
  it("closes bounded file observations before rename and preserves over-limit source bytes", () => {
    const f = fixture(), path = join(f.root, "read.txt"); writeFileSync(path, "bounded fixture");
    expect(readClaimRecoveryFile(path, 32)).toBe("bounded fixture"); renameSync(path, path + ".moved");
    const before = readFileSync(path + ".moved"); expect(() => readClaimRecoveryFile(path + ".moved", 2)).toThrow();
    expect(readFileSync(path + ".moved")).toEqual(before); expect(claimRecoveryBytesHash(before)).toHaveLength(64);
  });
});
