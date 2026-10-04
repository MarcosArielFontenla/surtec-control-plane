import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { issueStatePath } from "./paths";
import { withStateLock } from "./store";
import { describeValidation, validateIssueDocument } from "./validation";
import type { IssueDocument } from "../issues/types";

export class IssueStateError extends Error {}
export class UnsupportedIssueVersionError extends IssueStateError {
  constructor(readonly version: number) { super(`unsupported issue schema version: ${version}`); }
}

const emptyDocument = (): IssueDocument => ({ schema_version: 1, issues: {}, candidates: {}, evidence: {}, events: [] });

function validateInvariants(value: IssueDocument): void {
  if (!validateIssueDocument(value)) throw new IssueStateError(`issue state is invalid: ${describeValidation(validateIssueDocument.errors)}`);
  for (const [id, issue] of Object.entries(value.issues)) {
    if (id !== issue.id) throw new IssueStateError("issue document keys do not match issue IDs");
    if (issue.parent_issue_id && !value.issues[issue.parent_issue_id]) throw new IssueStateError("issue parent does not exist");
    if (issue.blocked_by_issue_ids.some((blocker) => !value.issues[blocker])) throw new IssueStateError("issue blocker does not exist");
    for (const evidenceId of issue.evidence_ids) if (value.evidence[evidenceId]?.issue_id !== id) throw new IssueStateError("issue evidence index is inconsistent");
    for (const candidateId of issue.candidate_ids) if (value.candidates[candidateId]?.issue_id !== id) throw new IssueStateError("issue candidate index is inconsistent");
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

function write(filePath: string, document: IssueDocument): void {
  validateInvariants(document);
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
  const stateRoot = dirname(dirname(filePath));
  return withStateLock("issues", () => {
    const document = read(filePath);
    const result = mutate(document);
    write(filePath, document);
    return result;
  }, join(stateRoot, "locks"));
}
