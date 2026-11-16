import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { dirname, join } from "node:path";
import { issueStatePath } from "./paths";
import { withStateLock } from "./store";
import { describeValidation, validateDeliveryObservation, validateIssueDocument, validateIssueIntakeReceipt } from "./validation";
import type { IssueDocument, IssueIntakeReceipt } from "../issues/types";

export class IssueStateError extends Error {}
export class UnsupportedIssueVersionError extends IssueStateError {
  constructor(readonly version: number) { super(`unsupported issue schema version: ${version}`); }
}

const emptyDocument = (): IssueDocument => ({ schema_version: 1, issues: {}, candidates: {}, evidence: {}, events: [] });

function validateInvariants(value: IssueDocument): void {
  // Inspect newly versioned facets before the legacy aggregate validator can
  // access a getter or serialize inherited fields supplied by an in-memory writer.
  for (const issue of Object.values(value.issues ?? {})) {
    if (!issue || typeof issue !== "object") continue;
    if (nodeTypes.isProxy(issue) || ![Object.prototype, null].includes(Object.getPrototypeOf(issue))) throw new IssueStateError("issue must be plain JSON data");
    const facet = Object.getOwnPropertyDescriptor(issue, "intake_receipt");
    if (!facet && "intake_receipt" in issue) throw new IssueStateError("issue intake receipt must not be inherited");
    if (facet && (!("value" in facet) || !facet.enumerable || !validateIssueIntakeReceipt(facet.value))) throw new IssueStateError("issue intake receipt must be own plain JSON data");
  }
  for (const evidence of Object.values(value.evidence ?? {})) {
    if (!evidence || typeof evidence !== "object") continue;
    if (nodeTypes.isProxy(evidence)) throw new IssueStateError("issue evidence must be plain JSON data");
    const facet = Object.getOwnPropertyDescriptor(evidence, "delivery_observation");
    if (!facet && "delivery_observation" in evidence) throw new IssueStateError("issue delivery observation must not be inherited");
    if (facet && (!("value" in facet) || !facet.enumerable || !validateDeliveryObservation(facet.value))) throw new IssueStateError("issue delivery observation must be own plain JSON data");
  }
  if (!validateIssueDocument(value)) throw new IssueStateError(`issue state is invalid: ${describeValidation(validateIssueDocument.errors)}`);
  const requestIds = new Set<string>();
  for (const [id, issue] of Object.entries(value.issues)) {
    if (id !== issue.id) throw new IssueStateError("issue document keys do not match issue IDs");
    if (issue.intake_receipt) {
      if (requestIds.has(issue.intake_receipt.request_id)) throw new IssueStateError("issue intake receipt request IDs must be globally unique");
      requestIds.add(issue.intake_receipt.request_id);
    }
    if (issue.parent_issue_id && !value.issues[issue.parent_issue_id]) throw new IssueStateError("issue parent does not exist");
    if (issue.blocked_by_issue_ids.some((blocker) => !value.issues[blocker])) throw new IssueStateError("issue blocker does not exist");
    for (const evidenceId of issue.evidence_ids) if (value.evidence[evidenceId]?.issue_id !== id) throw new IssueStateError("issue evidence index is inconsistent");
    for (const candidateId of issue.candidate_ids) if (value.candidates[candidateId]?.issue_id !== id) throw new IssueStateError("issue candidate index is inconsistent");
    if (issue.evidence_ids.filter((entryId) => Object.hasOwn(value.evidence[entryId]!, "delivery_observation")).length > 64) throw new IssueStateError("issue delivery observation limit exceeded");
    const parentSeen = new Set([id]);
    let parentId = issue.parent_issue_id;
    let depth = 1;
    while (parentId) {
      if (parentSeen.has(parentId)) throw new IssueStateError("issue parent ancestry contains a cycle");
      parentSeen.add(parentId);
      if (++depth > 6) throw new IssueStateError("issue parent ancestry exceeds 6 levels");
      parentId = value.issues[parentId]?.parent_issue_id ?? null;
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new IssueStateError("issue blocker graph contains a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of value.issues[id]?.blocked_by_issue_ids ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of Object.keys(value.issues)) visit(id);
  for (const [id, candidate] of Object.entries(value.candidates)) {
    if (id !== candidate.id || !value.issues[candidate.issue_id]?.candidate_ids.includes(id)) throw new IssueStateError("review candidate index is inconsistent");
  }
  for (const [id, evidence] of Object.entries(value.evidence)) {
    if (id !== evidence.id || !value.issues[evidence.issue_id]?.evidence_ids.includes(id)) throw new IssueStateError("issue evidence key or index is inconsistent");
    if (Object.hasOwn(evidence, "delivery_observation")) {
      if (!validateDeliveryObservation(evidence.delivery_observation)) throw new IssueStateError("issue delivery observation is invalid or unsupported");
      if (Date.parse(evidence.delivery_observation.occurred_at) > Date.parse(evidence.created_at)) throw new IssueStateError("issue delivery observation occurs after its record time");
      const issue = value.issues[evidence.issue_id]!;
      if (evidence.scope_revision! > issue.scope_revision) throw new IssueStateError("issue delivery observation scope is inconsistent");
      // Historical facts survive subsequent candidate invalidation and scope changes.
      if (evidence.candidate_id !== null) {
        const candidate = value.candidates[evidence.candidate_id];
        if (!candidate || candidate.issue_id !== issue.id || candidate.repository_id !== issue.project_id
          || candidate.candidate_revision !== evidence.candidate_revision || candidate.diff_fingerprint !== evidence.diff_fingerprint
          || candidate.scope_revision !== evidence.scope_revision) throw new IssueStateError("issue delivery observation candidate binding is inconsistent");
      }
    }
  }
}

function read(filePath: string): IssueDocument {
  if (!existsSync(filePath)) return emptyDocument();
  let value: unknown;
  try { value = JSON.parse(readFileSync(filePath, "utf8")); }
  catch { throw new IssueStateError("issue state contains invalid JSON"); }
  const version = value && typeof value === "object" ? (value as { schema_version?: unknown }).schema_version : undefined;
  if (typeof version === "number" && version > 1) throw new UnsupportedIssueVersionError(version);
  if (!validateIssueDocument(value)) throw new IssueStateError(`issue state is invalid: ${describeValidation(validateIssueDocument.errors)}`);
  validateInvariants(value);
  return value;
}

function receiptBindings(document: IssueDocument): Map<string, IssueIntakeReceipt | null> {
  return new Map(Object.entries(document.issues).map(([id, issue]) => [id, issue.intake_receipt ? { ...issue.intake_receipt } : null]));
}

function assertReceiptPreservation(document: IssueDocument, previous: ReadonlyMap<string, IssueIntakeReceipt | null>): void {
  for (const [id, original] of previous) {
    const current = document.issues[id]?.intake_receipt;
    if (original === null) {
      if (current) throw new IssueStateError("issue intake receipt cannot be backfilled on a legacy issue");
    } else if (!current || current.schema_version !== original.schema_version || current.request_id !== original.request_id
      || current.request_fingerprint !== original.request_fingerprint) {
      throw new IssueStateError("issue intake receipt and its owner must be preserved unchanged");
    }
  }
}

function write(filePath: string, document: IssueDocument, previous: ReadonlyMap<string, IssueIntakeReceipt | null>, unchanged?: string): void {
  validateInvariants(document);
  assertReceiptPreservation(document, previous);
  if (unchanged !== undefined && JSON.stringify(document) === unchanged) return;
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(document, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* only this call's unique temporary file can be removed */ }
    throw error;
  }
}

export function readIssueDocument(filePath: string = issueStatePath()): IssueDocument {
  return read(filePath);
}

export function mutateIssueDocument<T>(mutate: (document: IssueDocument) => T, filePath: string = issueStatePath()): T {
  return mutateWithWritePolicy(mutate, filePath, false);
}

/** Replay-only callers can return existing data without replacing unchanged state. */
export function mutateIssueDocumentIfChanged<T>(mutate: (document: IssueDocument) => T, filePath: string = issueStatePath()): T {
  return mutateWithWritePolicy(mutate, filePath, true);
}

function mutateWithWritePolicy<T>(mutate: (document: IssueDocument) => T, filePath: string, skipUnchanged: boolean): T {
  const stateRoot = dirname(dirname(filePath));
  return withStateLock("issues", () => {
    const document = read(filePath);
    const previous = receiptBindings(document);
    const unchanged = skipUnchanged ? JSON.stringify(document) : undefined;
    const result = mutate(document);
    write(filePath, document, previous, unchanged);
    return result;
  }, join(stateRoot, "locks"));
}
