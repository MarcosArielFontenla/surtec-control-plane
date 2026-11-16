import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DeliveryObservation, IssueDocument, IssueEvidenceReference, IssueIntakeReceipt, ReviewCandidate, WorkIssue } from "../issues/types";
import { IssueStateError, mutateIssueDocument, mutateIssueDocumentIfChanged, readIssueDocument, UnsupportedIssueVersionError } from "./issues";
import { validateDeliveryObservation, validateIssueEvidence, validateIssueIntakeReceipt } from "./validation";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const AT = "2026-10-16T14:00:00.000Z", OBSERVED = "2026-10-15T13:00:00.000Z";
let root: string, path: string;
const issueId = `I-${randomUUID()}`, candidateId = `C-${randomUUID()}`;
function issue(): WorkIssue {
  const scope = { expected_outcome: "Observe a fictional result.", acceptance_criteria: ["Keep facts independent."], allowed_path_patterns: ["src/**"], excluded_path_patterns: [], allowed_change_categories: ["test"], explicit_exclusions: [] };
  return { schema_version: 1, id: issueId, project_id: "alpha", objective_id: null, parent_issue_id: null, title: "Fictional issue", expected_outcome: scope.expected_outcome,
    acceptance_criteria: scope.acceptance_criteria, status: "proposed", work_scale: "bounded", classification_inputs: { affected_domains: ["test"], requires_migration: false, security_impact: false }, classification_rationale: [], plan: [], authorized_scope: scope,
    scope_revision: 1, scope_changed_at: null, scope_change_approval_id: null, scope_change_proposal: null, priority: 1, criticality: "low", blocked_by_issue_ids: [], assigned_role_id: null, related_commitment_ids: [], external_references: [], next_action: null,
    task_ids: [], evidence_ids: [], candidate_ids: [], created_at: AT, updated_at: AT, revision: 1 };
}
function observation(overrides: Partial<DeliveryObservation> = {}): DeliveryObservation {
  return { schema_version: 1, kind: "environment-observed", origin: "operator-entered", commitment_id: null, occurred_at: OBSERVED, summary: "Fictional local observation.", source_reference: "observation-1", next_action: "Review the next result.", ...overrides };
}
function evidence(overrides: Partial<IssueEvidenceReference> = {}): IssueEvidenceReference {
  return { schema_version: 1, id: `E-${randomUUID()}`, issue_id: issueId, task_id: null, execution_id: null, candidate_id: null, candidate_revision: null, diff_fingerprint: null, scope_revision: 1,
    kind: "work-product", status: "informational", label: "Operator-entered delivery observation", reference: `/api/work-issues/${issueId}`, created_at: AT, ...overrides };
}
function document(entry = evidence()): IssueDocument {
  const owner = issue(); owner.evidence_ids.push(entry.id);
  return { schema_version: 1, issues: { [owner.id]: owner }, candidates: {}, evidence: { [entry.id]: entry }, events: [] };
}
function install(value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = JSON.stringify(value); writeFileSync(path, bytes, "utf8"); return bytes;
}
function unchangedInvalid(value: unknown): void {
  const before = install(value);
  expect(() => readIssueDocument(path)).toThrow(IssueStateError);
  expect(() => mutateIssueDocument(() => {}, path)).toThrow(IssueStateError);
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(readdirSync(dirname(path))).toEqual(["issues.json"]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surtec-issue-delivery-store-")); path = join(root, "state", "issues", "issues.json");
});
afterEach(() => {
  vi.restoreAllMocks();
  if (!resolve(root).startsWith(`${resolve(tmpdir())}\\surtec-issue-delivery-store-`) && !resolve(root).startsWith(`${resolve(tmpdir())}/surtec-issue-delivery-store-`)) throw new Error("Unowned issue fixture root");
  rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false);
});

describe("independently versioned manual delivery evidence persistence", () => {
  it("does not create state on absent read or synthesize a facet for legacy evidence", () => {
    expect(readIssueDocument(path)).toEqual({ schema_version: 1, issues: {}, candidates: {}, evidence: {}, events: [] }); expect(existsSync(path)).toBe(false);
    const legacy = document(); const before = install(legacy);
    expect(readIssueDocument(path)).toEqual(legacy); expect(readFileSync(path, "utf8")).toBe(before);
    expect(Object.hasOwn(Object.values(readIssueDocument(path).evidence)[0]!, "delivery_observation")).toBe(false);
    mutateIssueDocument((state) => { state.issues[issueId]!.next_action = "Inspect later."; }, path);
    expect(Object.hasOwn(Object.values(readIssueDocument(path).evidence)[0]!, "delivery_observation")).toBe(false);
  });

  it.each<DeliveryObservation["kind"]>(["readiness-reviewed", "environment-observed", "handoff-recorded", "client-response-recorded", "follow-up-recorded"])("round-trips explicit %s facts without backfilling observation time or authority", (kind) => {
    const entry = evidence({ delivery_observation: observation({ kind }) }); const value = document(entry);
    mutateIssueDocument((state) => Object.assign(state, value), path);
    const persisted = readIssueDocument(path);
    expect(persisted).toEqual(value); expect(persisted.issues[issueId]!.status).toBe("proposed");
    expect(persisted.evidence[entry.id]!.delivery_observation!.occurred_at).not.toBe(entry.created_at);
    expect(readdirSync(dirname(path))).toEqual(["issues.json"]);
  });

  it.each([null, { schema_version: 2 }, { ...observation(), schema_version: 2 }, { ...observation(), authority: "accept" },
    { ...observation(), origin: "agent-produced" }, { ...observation(), kind: "accepted" }, { ...observation(), occurred_at: "2026-02-30T00:00:00Z" },
    { ...observation(), summary: " " }, { ...observation(), summary: "x".repeat(501) }, { ...observation(), next_action: "x".repeat(501) },
    { ...observation(), source_reference: "x".repeat(301) }, { ...observation(), commitment_id: "../other" }, { ...observation(), summary: " leading space" },
    { ...observation(), next_action: "bad\u0000text" },
    Object.fromEntries(Object.entries(observation()).filter(([key]) => key !== "occurred_at")),
  ])("refuses malformed/null/future nested facts without repairing bytes (%#)", (facet) => {
    expect(validateDeliveryObservation(facet)).toBe(false);
    unchangedInvalid(document(evidence({ delivery_observation: facet as DeliveryObservation })));
  });

  it("distinguishes explicitly present undefined from absence for in-memory mutations", () => {
    const before = install(document());
    expect(() => mutateIssueDocument((state) => { Object.values(state.evidence)[0]!.delivery_observation = undefined; }, path)).toThrow(IssueStateError);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses inherited fields, accessors and proxies before invoking or persisting them", () => {
    const before = install(document()), invoked = vi.fn(() => "Synthetic private accessor");
    const getter = { ...observation() }; Object.defineProperty(getter, "summary", { get: invoked, enumerable: true });
    const hidden = { ...observation() }; Object.defineProperty(hidden, "summary", { value: "Hidden", enumerable: false });
    for (const facet of [Object.create(observation()), getter, hidden, new Proxy(observation(), { get: invoked })]) {
      expect(validateDeliveryObservation(facet)).toBe(false);
      expect(() => mutateIssueDocument((state) => { Object.values(state.evidence)[0]!.delivery_observation = facet; }, path)).toThrow(IssueStateError);
      expect(readFileSync(path, "utf8")).toBe(before);
    }
    expect(() => mutateIssueDocument((state) => { Object.defineProperty(Object.values(state.evidence)[0]!, "delivery_observation", { get: invoked, enumerable: true }); }, path)).toThrow(IssueStateError);
    expect(() => mutateIssueDocument((state) => { Object.setPrototypeOf(Object.values(state.evidence)[0]!, { delivery_observation: observation() }); }, path)).toThrow(IssueStateError);
    expect(invoked).not.toHaveBeenCalled(); expect(readFileSync(path, "utf8")).toBe(before);
  });

  it.each(["file:///C:/private.txt", "C:\\private.txt", "../private", "\\\\host\\share", "javascript:alert(1)", "data:text/plain,private", "https://user:pass@example.invalid/a", "https://example.invalid/a?token=x", "https://example.invalid/a#secret", "https://example.invalid:99999/a", "https://example.invalid/%0a", "https://example.invalid/\n", "curl https://example.invalid", "https://example.invalid/with space"])("refuses unsafe reference data without fetching or rewriting (%#)", (source_reference) => {
    unchangedInvalid(document(evidence({ delivery_observation: observation({ source_reference }) })));
  });

  it.each(["release-1", "https://example.invalid", "http://127.0.0.1:4317/release/1", "https://example.invalid/observations/result-1"])("allows inert bounded source reference (%#)", (source_reference) => {
    expect(validateDeliveryObservation(observation({ source_reference }))).toBe(true);
  });

  it.each<Partial<IssueEvidenceReference>>([{ kind: "verification" }, { kind: "review" }, { status: "passed" }, { status: "failed" }, { task_id: "task-1" }, { execution_id: "run-1" },
    { testing_evidence_fingerprint: "a".repeat(64) }, { scope_revision: null }, { candidate_id: candidateId }, { candidate_revision: "a".repeat(40) }, { diff_fingerprint: "b".repeat(64) },
  ])("refuses to disguise manual evidence as runtime/approval evidence (%#)", (overrides) => {
    const entry = evidence({ delivery_observation: observation(), ...overrides }); expect(validateIssueEvidence(entry)).toBe(false); unchangedInvalid(document(entry));
  });

  it("rejects observations later than server-recorded time", () => {
    unchangedInvalid(document(evidence({ delivery_observation: observation({ occurred_at: "2026-10-17T00:00:00Z" }) })));
  });

  function candidateDocument(): IssueDocument {
    const candidate: ReviewCandidate = { schema_version: 1, id: candidateId, issue_id: issueId, task_id: "task-1", execution_id: "run-1", repository_id: "alpha", base_revision: "a".repeat(40), candidate_revision: "b".repeat(40), diff_fingerprint: "c".repeat(64), changed_paths: ["src/example.ts"], scope_revision: 1, created_at: OBSERVED, invalidated_at: null };
    const state = document(evidence({ delivery_observation: observation(), candidate_id: candidate.id, candidate_revision: candidate.candidate_revision, diff_fingerprint: candidate.diff_fingerprint }));
    state.candidates[candidate.id] = candidate; state.issues[issueId]!.candidate_ids.push(candidate.id); return state;
  }
  it.each(["missing", "project", "revision", "fingerprint", "scope"])("refuses a dangling/inconsistent historical candidate binding (%s)", (mode) => {
    const state = candidateDocument(), entry = Object.values(state.evidence)[0]!;
    if (mode === "missing") { delete state.candidates[candidateId]; state.issues[issueId]!.candidate_ids = []; }
    if (mode === "project") state.candidates[candidateId]!.repository_id = "beta";
    if (mode === "revision") entry.candidate_revision = "d".repeat(40);
    if (mode === "fingerprint") entry.diff_fingerprint = "e".repeat(64);
    if (mode === "scope") entry.scope_revision = 2;
    unchangedInvalid(state);
  });

  it("preserves historical facts after candidate invalidation, new scope and removal of a commitment link", () => {
    const state = candidateDocument(); const entry = Object.values(state.evidence)[0]!;
    entry.delivery_observation!.commitment_id = "commitment-old"; state.issues[issueId]!.related_commitment_ids = ["commitment-old"];
    install(state);
    mutateIssueDocument((current) => { current.candidates[candidateId]!.invalidated_at = AT; current.issues[issueId]!.scope_revision = 2; current.issues[issueId]!.related_commitment_ids = []; }, path);
    expect(Object.values(readIssueDocument(path).evidence)[0]).toEqual(entry);
  });

  it("keeps the manual bound independent from legacy evidence and refuses the 65th without eviction", () => {
    const state = document(); const owner = state.issues[issueId]!;
    for (let count = 0; count < 64; count++) { const entry = evidence({ delivery_observation: observation() }); state.evidence[entry.id] = entry; owner.evidence_ids.push(entry.id); }
    const before = install(state); expect(Object.keys(readIssueDocument(path).evidence)).toHaveLength(65);
    expect(() => mutateIssueDocument((current) => { const entry = evidence({ delivery_observation: observation() }); current.evidence[entry.id] = entry; current.issues[issueId]!.evidence_ids.push(entry.id); }, path)).toThrow(/limit exceeded/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("preserves malformed JSON and unknown whole-document versions", () => {
    const before = install({ schema_version: 2 }); expect(() => readIssueDocument(path)).toThrow(UnsupportedIssueVersionError); expect(readFileSync(path, "utf8")).toBe(before);
    writeFileSync(path, "{ fixture malformed", "utf8"); expect(() => mutateIssueDocument(() => {}, path)).toThrow(/invalid JSON/); expect(readFileSync(path, "utf8")).toBe("{ fixture malformed");
  });

  it("refuses a concurrent writer before callback effects and does not replace a live lock", () => {
    const before = install(document()), lockDirectory = join(root, "state", "locks"), invoked = vi.fn();
    mkdirSync(lockDirectory, { recursive: true }); const lockPath = join(lockDirectory, "issues.lock"), lockBytes = "synthetic-live-owner\n";
    writeFileSync(lockPath, lockBytes, "utf8");
    expect(() => mutateIssueDocument(invoked, path)).toThrow(/lock is busy/);
    expect(invoked).not.toHaveBeenCalled(); expect(readFileSync(path, "utf8")).toBe(before); expect(readFileSync(lockPath, "utf8")).toBe(lockBytes);
  });

  it("keeps the previous aggregate and removes only its own staged file when replacement fails", () => {
    const before = install(document());
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("Synthetic replacement failure"); });
    expect(() => mutateIssueDocument((current) => { const entry = evidence({ delivery_observation: observation() }); current.evidence[entry.id] = entry; current.issues[issueId]!.evidence_ids.push(entry.id); }, path)).toThrow("Synthetic replacement failure");
    expect(readFileSync(path, "utf8")).toBe(before); expect(readdirSync(dirname(path))).toEqual(["issues.json"]);
  });
});

describe("durable manual intake receipt persistence", () => {
  const requestId = "a1111111-b222-c333-d444-e55555555555";
  function receipt(overrides: Partial<IssueIntakeReceipt> = {}): IssueIntakeReceipt {
    return { schema_version: 1, request_id: requestId, request_fingerprint: "a".repeat(64), ...overrides };
  }
  function receiptDocument(): IssueDocument {
    const state = document(); state.issues[issueId]!.intake_receipt = receipt(); return state;
  }

  it("leaves an absent issue aggregate absent when the conditional transaction changes nothing", () => {
    vi.mocked(renameSync).mockClear();
    const result = mutateIssueDocumentIfChanged((state) => Object.keys(state.issues).length, path);
    expect(result).toBe(0); expect(existsSync(path)).toBe(false); expect(existsSync(dirname(path))).toBe(false);
    expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
  });

  it("reads historical issues without synthesizing a receipt or rewriting their bytes", () => {
    const before = install(document());
    expect(Object.hasOwn(readIssueDocument(path).issues[issueId]!, "intake_receipt")).toBe(false);
    vi.mocked(renameSync).mockClear();
    expect(mutateIssueDocumentIfChanged((state) => state.issues[issueId]!, path).id).toBe(issueId);
    expect(readFileSync(path, "utf8")).toBe(before); expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
    mutateIssueDocument((state) => { state.issues[issueId]!.next_action = "Review the historical issue."; }, path);
    expect(Object.hasOwn(readIssueDocument(path).issues[issueId]!, "intake_receipt")).toBe(false);
  });

  it("round-trips a new receipt without creating approval, execution or additional evidence", () => {
    const state = receiptDocument(); expect(validateIssueIntakeReceipt(receipt())).toBe(true);
    mutateIssueDocumentIfChanged((current) => Object.assign(current, state), path);
    const persisted = readIssueDocument(path);
    expect(persisted).toEqual(state); expect(persisted.issues[issueId]!.status).toBe("proposed");
    expect(persisted.issues[issueId]!.task_ids).toEqual([]); expect(persisted.issues[issueId]!.candidate_ids).toEqual([]);
    expect(persisted.events).toEqual([]); expect(readdirSync(dirname(path))).toEqual(["issues.json"]);
  });

  it.each([null, {}, { ...receipt(), schema_version: 2 }, { ...receipt(), schema_version: "1" },
    { ...receipt(), request_id: requestId.toUpperCase() }, { ...receipt(), request_id: "not-a-uuid" },
    { ...receipt(), request_fingerprint: "A".repeat(64) }, { ...receipt(), request_fingerprint: "a".repeat(63) },
    { ...receipt(), authority: "authorize" }, Object.fromEntries(Object.entries(receipt()).filter(([key]) => key !== "request_fingerprint")),
  ])("rejects null, malformed or future receipts without repairing stored bytes (%#)", (facet) => {
    expect(validateIssueIntakeReceipt(facet)).toBe(false);
    const state = document(); state.issues[issueId]!.intake_receipt = facet as IssueIntakeReceipt;
    unchangedInvalid(state);
    expect(() => mutateIssueDocumentIfChanged(() => {}, path)).toThrow(IssueStateError);
  });

  it("rejects a present undefined receipt rather than downgrading it to historical absence", () => {
    const before = install(document());
    for (const mutate of [mutateIssueDocument, mutateIssueDocumentIfChanged]) {
      expect(() => mutate((state) => { state.issues[issueId]!.intake_receipt = undefined; }, path)).toThrow(IssueStateError);
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  });

  it("rejects inherited, hidden, accessor, proxy and symbol receipt fields before invoking them", () => {
    const before = install(document()), invoked = vi.fn(() => "Synthetic private accessor");
    const getter = receipt(); Object.defineProperty(getter, "request_fingerprint", { get: invoked, enumerable: true });
    const hidden = receipt(); Object.defineProperty(hidden, "request_fingerprint", { value: "a".repeat(64), enumerable: false });
    const symbolic = Object.assign(receipt(), { [Symbol("unpersisted")]: "private" });
    const facets = [Object.create(receipt()), getter, hidden, symbolic, new Proxy(receipt(), { get: invoked })];
    for (const facet of facets) {
      expect(validateIssueIntakeReceipt(facet)).toBe(false);
      expect(() => mutateIssueDocumentIfChanged((state) => { state.issues[issueId]!.intake_receipt = facet; }, path)).toThrow(IssueStateError);
      expect(readFileSync(path, "utf8")).toBe(before);
    }
    expect(() => mutateIssueDocumentIfChanged((state) => {
      Object.defineProperty(state.issues[issueId]!, "intake_receipt", { get: invoked, enumerable: true });
    }, path)).toThrow(IssueStateError);
    expect(() => mutateIssueDocumentIfChanged((state) => {
      Object.setPrototypeOf(state.issues[issueId]!, { intake_receipt: receipt() });
    }, path)).toThrow(IssueStateError);
    expect(() => mutateIssueDocumentIfChanged((state) => {
      state.issues[issueId] = new Proxy(state.issues[issueId]!, { get: invoked });
    }, path)).toThrow(IssueStateError);
    expect(invoked).not.toHaveBeenCalled(); expect(readFileSync(path, "utf8")).toBe(before);
  });

  it.each(["alpha", "beta"])("rejects duplicate request identities even across project %s", (projectId) => {
    const state = receiptDocument(), second = { ...issue(), id: `I-${randomUUID()}`, project_id: projectId, intake_receipt: receipt() };
    state.issues[second.id] = second; unchangedInvalid(state);
  });

  it("allows distinct request identities with the same payload fingerprint", () => {
    const state = receiptDocument(), second = { ...issue(), id: `I-${randomUUID()}`, intake_receipt: receipt({ request_id: randomUUID() }) };
    state.issues[second.id] = second;
    mutateIssueDocumentIfChanged((current) => Object.assign(current, state), path);
    expect(Object.keys(readIssueDocument(path).issues)).toHaveLength(2);
    expect(readIssueDocument(path).issues[second.id]!.intake_receipt!.request_fingerprint).toBe(receipt().request_fingerprint);
  });

  it.each(["identity", "fingerprint", "remove", "remove-owner"])("preserves an existing receipt and rejects %s changes through either mutator", (mode) => {
    const before = install(receiptDocument());
    for (const mutate of [mutateIssueDocument, mutateIssueDocumentIfChanged]) {
      expect(() => mutate((state) => {
        if (mode === "identity") state.issues[issueId]!.intake_receipt!.request_id = randomUUID();
        if (mode === "fingerprint") state.issues[issueId]!.intake_receipt!.request_fingerprint = "b".repeat(64);
        if (mode === "remove") delete state.issues[issueId]!.intake_receipt;
        if (mode === "remove-owner") { delete state.issues[issueId]; state.evidence = {}; }
      }, path)).toThrow(IssueStateError);
      expect(readFileSync(path, "utf8")).toBe(before); expect(readdirSync(dirname(path))).toEqual(["issues.json"]);
    }
  });

  it("refuses to backfill a legacy issue with a newly generated receipt", () => {
    const before = install(document());
    for (const mutate of [mutateIssueDocument, mutateIssueDocumentIfChanged]) {
      expect(() => mutate((state) => { state.issues[issueId]!.intake_receipt = receipt(); }, path)).toThrow(IssueStateError);
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  });

  it("preserves exact bytes and returns the current issue on a conditional replay after progress", () => {
    const initial = receiptDocument(); initial.issues[issueId]!.next_action = "Current follow-up."; initial.issues[issueId]!.revision = 3;
    initial.issues[issueId]!.status = "authorized";
    const before = install(initial); vi.mocked(renameSync).mockClear();
    const returned = mutateIssueDocumentIfChanged((state) => state.issues[issueId]!, path);
    expect(returned).toEqual(initial.issues[issueId]); expect(returned.intake_receipt).toEqual(receipt());
    expect(readFileSync(path, "utf8")).toBe(before); expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
    expect(readIssueDocument(path).events).toEqual([]); expect(readdirSync(dirname(path))).toEqual(["issues.json"]);
  });

  it("retains ordinary no-op writes and writes actual changes through the conditional helper", () => {
    install(receiptDocument()); vi.mocked(renameSync).mockClear();
    mutateIssueDocument(() => {}, path);
    expect(vi.mocked(renameSync)).toHaveBeenCalledTimes(1); vi.mocked(renameSync).mockClear();
    mutateIssueDocumentIfChanged((state) => { state.issues[issueId]!.next_action = "A real stored update."; state.issues[issueId]!.revision++; }, path);
    expect(vi.mocked(renameSync)).toHaveBeenCalledTimes(1);
    const current = readIssueDocument(path).issues[issueId]!;
    expect(current.next_action).toBe("A real stored update."); expect(current.revision).toBe(2); expect(current.intake_receipt).toEqual(receipt());
  });

  it("validates changed conditional state before attempting a replacement", () => {
    const before = install(receiptDocument()); vi.mocked(renameSync).mockClear();
    expect(() => mutateIssueDocumentIfChanged((state) => { state.issues[issueId]!.revision = 0; }, path)).toThrow(IssueStateError);
    expect(readFileSync(path, "utf8")).toBe(before); expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
  });

  it("refuses a conditional replay while another writer owns the issue lock", () => {
    const before = install(receiptDocument()), lockDirectory = join(root, "state", "locks"), invoked = vi.fn();
    mkdirSync(lockDirectory, { recursive: true }); const lockPath = join(lockDirectory, "issues.lock"), lockBytes = "synthetic-intake-owner\n";
    writeFileSync(lockPath, lockBytes, "utf8");
    expect(() => mutateIssueDocumentIfChanged(invoked, path)).toThrow(/lock is busy/);
    expect(invoked).not.toHaveBeenCalled(); expect(readFileSync(path, "utf8")).toBe(before); expect(readFileSync(lockPath, "utf8")).toBe(lockBytes);
  });

  it("preserves the previous receipt aggregate when conditional replacement fails", () => {
    const before = install(receiptDocument());
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("Synthetic intake replacement failure"); });
    expect(() => mutateIssueDocumentIfChanged((state) => { state.issues[issueId]!.next_action = "Attempt an update."; }, path)).toThrow("Synthetic intake replacement failure");
    expect(readFileSync(path, "utf8")).toBe(before); expect(readdirSync(dirname(path))).toEqual(["issues.json"]);
  });
});
