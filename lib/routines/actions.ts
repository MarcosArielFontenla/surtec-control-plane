import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  realpathSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { isDeepStrictEqual, types as nodeTypes } from "node:util";
import type { BudgetOccurrenceSubject } from "../budgets/types";
import { readBudgetLedger } from "../state/budgets";
import { budgetStatePath, routineStatePath } from "../state/paths";
import { assertRoutineOwnership, type RoutineOwnership } from "../state/routines";
import type { SignalSeverity, SignalSource } from "../signals/types";
import { routineTimestampEpoch } from "./schedule";
import { ROUTINE_EVIDENCE_KINDS, ROUTINE_LIMITS, type RoutineEvidenceFact, type RoutineFailureCode,
  type RoutineOccurrence, type RoutineReceipt } from "./types";
import { assertRoutineOccurrence, assertRoutineReceipt, routineProposalKey } from "./validation";

/** A strict projection of an existing deterministic signal, never its private text. */
export interface RoutineSignalFact {
  id: string; project_id: string; source: SignalSource; severity: SignalSeverity;
  observed_at: string; fingerprint: string;
}
export interface RoutineActionEvidence { sources: RoutineEvidenceFact[]; signals: RoutineSignalFact[] }
export interface RoutineIssueProposal {
  ownership: RoutineOwnership; occurrence: Readonly<RoutineOccurrence>;
  key: string; fingerprint: string; signal: RoutineSignalFact;
}
export type RoutineActionBoundary = "read" | "proposal" | "report" | "complete";
export interface RoutineEvidenceReadOptions { signal: AbortSignal; deadline_at: string; check: () => void }
/** Trusted application composition only, not a request/configurable plugin surface. */
export interface RoutineActionDependencies {
  state_root: string;
  assert_current: (occurrence: Readonly<RoutineOccurrence>, boundary: RoutineActionBoundary) => void;
  read_evidence: (occurrence: Readonly<RoutineOccurrence>, options: RoutineEvidenceReadOptions) => Promise<unknown>;
  propose_issue?: (proposal: RoutineIssueProposal, check: () => void) => string | null;
  assert_report_privacy?: (canonicalStateRoot: string) => void;
  clock?: () => Date;
  monotonic?: () => number;
}
export class RoutineActionError extends Error {
  constructor(readonly code: RoutineFailureCode) { super(`Routine action unavailable: ${code}`); this.name = "RoutineActionError"; }
}
/** A writer observed an ambiguous gap; any retained effect must be independently reread and proved. */
export class RoutineActionEffectError extends RoutineActionError {
  constructor(readonly committed_proposal?: RoutineReceipt["proposals"][number]) {
    super("accounting-unavailable"); this.name = "RoutineActionEffectError";
    if (committed_proposal !== undefined) {
      fields(committed_proposal, ["key", "fingerprint", "issue_id"]);
      requireValue(typeof committed_proposal.key === "string" && /^[a-f0-9]{64}$(?![\s\S])/.test(committed_proposal.key)
        && typeof committed_proposal.fingerprint === "string" && /^[a-f0-9]{64}$(?![\s\S])/.test(committed_proposal.fingerprint));
      safeId(committed_proposal.issue_id);
    }
  }
}
class RoutineReportEffectError extends RoutineActionError {
  constructor() { super("accounting-unavailable"); this.name = "RoutineReportEffectError"; }
}
const SIGNAL_SOURCES: readonly SignalSource[] = ["git", "github", "ci", "deployment", "issue", "task", "profile", "note", "session", "commitment", "objective", "harness"];
const SIGNAL_SEVERITIES: readonly SignalSeverity[] = ["info", "warning", "critical"];
const MAX_SIGNALS = 5000; // Existing deterministic signal engine ceiling.
const attempted = new WeakSet<object>();
function requireValue(ok: boolean, code: RoutineFailureCode = "state-invalid"): asserts ok { if (!ok) throw new RoutineActionError(code); }
function safeId(value: unknown): asserts value is string {
  requireValue(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$(?![\s\S])/.test(value)
    && !value.includes("..") && !["constructor", "prototype", "__proto__"].includes(value));
}
function fields(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !nodeTypes.isProxy(value) && !Array.isArray(value));
  const prototype = Object.getPrototypeOf(value);
  requireValue(prototype === Object.prototype || prototype === null);
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  requireValue(required.every((key) => Object.hasOwn(descriptors, key)) && keys.every((key) => typeof key === "string"
    && [...required, ...optional].includes(key) && descriptors[key]!.enumerable === true && Object.hasOwn(descriptors[key]!, "value")));
}
function array(value: unknown, maximum: number): asserts value is unknown[] {
  requireValue(value !== null && typeof value === "object" && !nodeTypes.isProxy(value) && Array.isArray(value)
    && Object.getPrototypeOf(value) === Array.prototype && value.length <= maximum);
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  requireValue(keys.length === value.length + 1 && keys.every((key) => key === "length" || typeof key === "string"
    && /^\d+$/.test(key) && Number(key) < value.length && descriptors[key]!.enumerable === true && Object.hasOwn(descriptors[key]!, "value")));
  for (let index = 0; index < value.length; index++) requireValue(Object.hasOwn(descriptors, String(index)));
}
function synchronous(callback: unknown, args: unknown[]): unknown {
  requireValue(typeof callback === "function" && !nodeTypes.isProxy(callback)
    && !nodeTypes.isAsyncFunction(callback) && !nodeTypes.isGeneratorFunction(callback));
  const result: unknown = callback(...args);
  // Effect/permission gates are synchronous. Never inspect or invoke a then getter.
  requireValue(result === undefined || result === null || typeof result === "string" || typeof result === "boolean");
  return result;
}
function gate(callback: unknown, args: unknown[]): void { requireValue(synchronous(callback, args) === undefined); }
function signalProjection(value: unknown): asserts value is Omit<RoutineSignalFact, "fingerprint"> {
  fields(value, ["id", "project_id", "source", "severity", "observed_at"]);
  safeId(value.id); safeId(value.project_id);
  requireValue(SIGNAL_SOURCES.includes(value.source as SignalSource) && SIGNAL_SEVERITIES.includes(value.severity as SignalSeverity));
  routineTimestampEpoch(value.observed_at);
}
/** Hash only allowlisted scalars. Signal text, raw evidence and output never enter the digest input. */
export function routineSignalFingerprint(value: Omit<RoutineSignalFact, "fingerprint">): string {
  signalProjection(value);
  const encoded = [value.id, value.project_id, value.source, value.severity, value.observed_at].map((part) => JSON.stringify(part)).join(",");
  return createHash("sha256").update(`[${encoded}]`).digest("hex");
}
export function assertRoutineSignalFact(value: unknown): asserts value is RoutineSignalFact {
  fields(value, ["id", "project_id", "source", "severity", "observed_at", "fingerprint"]);
  const projection = { id: value.id, project_id: value.project_id, source: value.source, severity: value.severity, observed_at: value.observed_at };
  signalProjection(projection);
  requireValue(typeof value.fingerprint === "string" && value.fingerprint === routineSignalFingerprint(projection));
}

/** Read-only accounting evidence, never a process/private-policy proof or an allocation. */
export function assertRoutineActionBudget(occurrence: Readonly<RoutineOccurrence>, stateRoot: string): void {
  try {
    assertRoutineOccurrence(occurrence);
    const ledger = readBudgetLedger(budgetStatePath(stateRoot)), bound = occurrence.budget;
    requireValue(ledger !== null && occurrence.owner !== null && occurrence.started_at !== null, "accounting-unavailable");
    const subject: BudgetOccurrenceSubject = { id: bound.subject_id, kind: "occurrence", occurrence_id: occurrence.id,
      routine_id: occurrence.routine_id, routine_revision: occurrence.routine_revision, slot: occurrence.slot,
      project_ids: [...occurrence.project_ids], attribution: structuredClone(occurrence.attribution) };
    const reservation = ledger.reservations[bound.reservation_id], intent = ledger.admission_intents[bound.intent_id];
    const charges = Object.values(ledger.charges).filter((charge) => charge.reservation_id === bound.reservation_id);
    requireValue(isDeepStrictEqual(ledger.subjects[bound.subject_id], subject) && !!reservation && !!intent
      && reservation.status === "active" && reservation.subject_id === bound.subject_id && reservation.intent_id === bound.intent_id
      && reservation.uncertain_dimensions.length === 0 && reservation.created_at === occurrence.created_at
      && isDeepStrictEqual(reservation.policy_bindings, bound.policy_bindings)
      && intent.status === "committed" && intent.admission_id === null && intent.subject_id === bound.subject_id
      && intent.reservation_id === bound.reservation_id && intent.created_at === occurrence.created_at
      && reservation.run_ids.length === 1 && reservation.run_ids[0] === occurrence.owner.run_id && charges.length === 1, "accounting-unavailable");
    const charge = charges[0]!;
    requireValue(charge.runtime_ms < bound.admitted_runtime_ms, "budget-exhausted");
    requireValue(charge.run_id === occurrence.owner.run_id && charge.subject_id === bound.subject_id && charge.attempts === 1
      && charge.status === "running" && charge.runtime_state === "complete" && charge.usage_state === "complete"
      && charge.observed_total_tokens === 0 && !charge.review && !charge.correction
      && reservation.held.attempts === 0 && reservation.held.concurrent_reads === 1
      && reservation.held.concurrent_writes === 0 && reservation.held.total_tokens === 0 && reservation.held.review_attempts === 0
      && reservation.held.review_runtime_ms === 0 && reservation.held.review_total_tokens === 0 && reservation.held.corrections === 0
      && reservation.held.runtime_ms + charge.runtime_ms === bound.admitted_runtime_ms, "accounting-unavailable");
  } catch (error) { if (error instanceof RoutineActionError) throw error; throw new RoutineActionError("accounting-unavailable"); }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function evidence(value: unknown, occurrence: Readonly<RoutineOccurrence>, capturedAt: string): RoutineActionEvidence {
  fields(value, ["sources", "signals"]);
  array(value.sources, ROUTINE_EVIDENCE_KINDS.length * (ROUTINE_LIMITS.projects + 1)); array(value.signals, MAX_SIGNALS);
  for (const source of value.sources) {
    fields(source, ["kind", "project_id", "state", "observed_at", "fingerprint"]);
    requireValue(ROUTINE_EVIDENCE_KINDS.includes(source.kind as RoutineEvidenceFact["kind"])
      && ["fresh", "stale", "unavailable"].includes(source.state as string));
    if (source.project_id !== null) safeId(source.project_id);
    requireValue(source.observed_at === null || typeof source.observed_at === "string");
    if (source.observed_at !== null) routineTimestampEpoch(source.observed_at);
    requireValue(source.fingerprint === null || typeof source.fingerprint === "string" && /^[a-f0-9]{64}$(?![\s\S])/.test(source.fingerprint));
  }
  const ids = new Set<string>();
  for (const signal of value.signals) {
    assertRoutineSignalFact(signal);
    requireValue(occurrence.project_ids.includes(signal.project_id) && !ids.has(signal.id)
      && routineTimestampEpoch(signal.observed_at) <= routineTimestampEpoch(capturedAt)); ids.add(signal.id);
  }
  const result = { sources: structuredClone(value.sources) as RoutineEvidenceFact[], signals: structuredClone(value.signals) as RoutineSignalFact[] };
  const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  result.sources.sort((a, b) => order(`${a.kind}:${a.project_id ?? ""}`, `${b.kind}:${b.project_id ?? ""}`));
  result.signals.sort((a, b) => order(a.id, b.id));
  // Reuse all closed source/time/count invariants from the independent persisted receipt contract.
  assertRoutineReceipt(receipt(occurrence, capturedAt, 0, result.sources, [], 0, 0, "source-unavailable"));
  return freeze(result);
}
function receipt(occurrence: Readonly<RoutineOccurrence>, at: string, runtime: number, sources: RoutineEvidenceFact[],
  proposals: RoutineReceipt["proposals"], evaluated: number, reports: 0 | 1, failure: RoutineFailureCode | null): RoutineReceipt {
  const exceeded = runtime > occurrence.budget.admitted_runtime_ms || ["budget-exhausted", "deadline-exceeded"].includes(failure ?? "");
  const unknownBudget = failure === "accounting-unavailable";
  const allFresh = sources.length > 0 && sources.every((fact) => fact.state === "fresh");
  const freshness = failure !== null || !allFresh ? sources.some((fact) => fact.state === "fresh") ? "partial"
    : sources.some((fact) => fact.state === "stale") ? "stale" : "unavailable" : "fresh";
  const failed = failure ?? (allFresh ? null : "source-unavailable");
  const result: RoutineReceipt = { schema_version: 1, occurrence_id: occurrence.id, occurrence_key: occurrence.occurrence_key,
    routine_id: occurrence.routine_id, routine_revision: occurrence.routine_revision, slot: occurrence.slot,
    action: occurrence.definition.action, scope: structuredClone(occurrence.definition.scope),
    policy_fingerprint: occurrence.definition.policy.fingerprint, cap_fingerprint: occurrence.budget.cap_fingerprint,
    project_ids: [...occurrence.project_ids], started_at: occurrence.started_at, finished_at: at, captured_at: at,
    freshness, sources: structuredClone(sources), counts: { projects_selected: occurrence.project_ids.length,
      facts_total: sources.length, facts_fresh: sources.filter((fact) => fact.state === "fresh").length,
      facts_unavailable: sources.filter((fact) => fact.state === "unavailable").length, signals_evaluated: evaluated,
      proposals_created: proposals.filter((proposal) => proposal.issue_id !== null).length, reports_written: reports },
    consumption: { attempts: 1, runtime_ms: runtime, runtime_state: "complete", model_calls: 0, total_tokens: 0, workspace_writes: 0 },
    budget_outcome: unknownBudget ? "unknown" : exceeded ? "exhausted" : "within-limit", proposals: structuredClone(proposals),
    failure_code: failed, next_action: proposals.some((proposal) => proposal.issue_id !== null) ? "review-proposals"
      : failed === null ? "none" : ["accounting-unavailable", "budget-exhausted", "deadline-exceeded"].includes(failed) ? "inspect-budget"
        : failed === "ownership-unavailable" ? "resolve-ownership" : failed === "cancelled" ? "run-new-occurrence" : "inspect-evidence" };
  assertRoutineReceipt(result); return freeze(result);
}
function safeDirectories(path: string): void {
  const root = parse(path).root, segments = path.slice(root.length).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try { const stat = lstatSync(current); requireValue(stat.isDirectory() && !stat.isSymbolicLink(), "source-unavailable"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
}
function privateDirectory(path: string): void {
  safeDirectories(path); const stat = lstatSync(path);
  requireValue(stat.isDirectory() && !stat.isSymbolicLink(), "source-unavailable");
  if (process.platform !== "win32") requireValue((stat.mode & 0o077) === 0
    && (process.getuid === undefined || stat.uid === process.getuid()), "source-unavailable");
}
function canonicalRoot(value: string): string {
  requireValue(typeof value === "string" && isAbsolute(value) && resolve(value) === value
    && !value.startsWith("\\\\") && !value.startsWith("//")
    && value !== parse(value).root && value !== resolve(homedir()) && value !== resolve(process.cwd()), "source-unavailable");
  safeDirectories(value); requireValue(realpathSync.native(value) === value, "source-unavailable"); privateDirectory(value); return value;
}
function sameFile(first: Stats, second: Stats): boolean { return first.dev === second.dev && first.ino === second.ino; }
function removeOwned(path: string, own: Stats): boolean {
  try {
    safeDirectories(dirname(path));
    const current = lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink() || !sameFile(current, own)) return false;
    unlinkSync(path); return true;
  } catch { return false; /* Never remove a replaced/unknown path. */ }
}
function writeReport(occurrence: Readonly<RoutineOccurrence>, sources: RoutineEvidenceFact[], capturedAt: string,
  dependencies: RoutineActionDependencies, check: () => void): void {
  const root = canonicalRoot(dependencies.state_root);
  requireValue(typeof dependencies.assert_report_privacy === "function", "source-unavailable");
  gate(dependencies.assert_report_privacy, [root]); check();
  const directory = join(root, "reports", "routines"); safeDirectories(directory);
  for (const path of [join(root, "reports"), directory]) {
    check();
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    privateDirectory(path);
  }
  privateDirectory(join(root, "reports")); privateDirectory(directory); safeId(occurrence.id);
  const destination = join(directory, `${occurrence.id}.json`), staged = join(directory, `.${occurrence.id}.${randomUUID()}.tmp`);
  // This is an observation report, not a premature terminal/usage/authority claim.
  requireValue(!Object.hasOwn(Object.prototype, "toJSON") && !Object.hasOwn(Array.prototype, "toJSON"), "source-unavailable");
  const content = JSON.stringify({ schema_version: 1, occurrence_id: occurrence.id, occurrence_key: occurrence.occurrence_key,
    routine_id: occurrence.routine_id, routine_revision: occurrence.routine_revision, slot: occurrence.slot,
    action: occurrence.definition.action, scope: occurrence.definition.scope, project_ids: occurrence.project_ids,
    policy_fingerprint: occurrence.definition.policy.fingerprint, cap_fingerprint: occurrence.budget.cap_fingerprint,
    captured_at: capturedAt, sources, counts: { projects_selected: occurrence.project_ids.length, facts_total: sources.length,
      facts_fresh: sources.filter((fact) => fact.state === "fresh").length, facts_unavailable: sources.filter((fact) => fact.state === "unavailable").length } }) + "\n";
  requireValue(Buffer.byteLength(content) <= ROUTINE_LIMITS.documentBytes, "source-unavailable");
  let fd: number | undefined, own: Stats | undefined, publicationAttempted = false, published = false;
  try {
    check(); privateDirectory(directory);
    fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    own = fstatSync(fd); writeFileSync(fd, content, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined;
    check(); privateDirectory(directory);
    const named = lstatSync(staged); requireValue(named.isFile() && !named.isSymbolicLink() && named.nlink === 1 && sameFile(own, named), "source-unavailable");
    // Exclusive same-volume publication: existing reports/user files are never overwritten.
    publicationAttempted = true; linkSync(staged, destination); published = true;
  } catch (error) {
    if (publicationAttempted && own !== undefined) {
      try { const named = lstatSync(destination); published = named.isFile() && !named.isSymbolicLink() && sameFile(named, own); }
      catch { /* Absence does not prove a failed publication across an I/O fault. */ }
      if (published) throw new RoutineReportEffectError();
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new RoutineActionEffectError();
    }
    if (error instanceof RoutineActionError) throw error; throw new RoutineActionError("source-unavailable");
  } finally {
    if (fd !== undefined) closeSync(fd);
    const clean = own === undefined || removeOwned(staged, own);
    if (published && !clean) throw new RoutineReportEffectError();
  }
  try {
    privateDirectory(directory); const final = lstatSync(destination);
    requireValue(own !== undefined && final.isFile() && !final.isSymbolicLink() && final.nlink === 1 && sameFile(final, own), "accounting-unavailable");
    if (process.platform !== "win32") requireValue((final.mode & 0o077) === 0, "accounting-unavailable");
  } catch { throw new RoutineReportEffectError(); }
}

/** Unwired bounded application slice. Nothing here claims worker, API, consent or production readiness. */
export async function executeRoutineAction(input: { ownership: RoutineOwnership; signal?: AbortSignal },
  dependencies: RoutineActionDependencies): Promise<RoutineReceipt> {
  fields(input, ["ownership"], ["signal"]);
  fields(dependencies, ["state_root", "assert_current", "read_evidence"], ["propose_issue", "assert_report_privacy", "clock", "monotonic"]);
  const path = routineStatePath(dependencies.state_root);
  let occurrence: Readonly<RoutineOccurrence>;
  try { occurrence = assertRoutineOwnership(input.ownership, path); }
  catch { throw new RoutineActionError("ownership-unavailable"); }
  requireValue(!attempted.has(input.ownership), "ownership-unavailable"); attempted.add(input.ownership);
  const clock = dependencies.clock ?? (() => new Date()), monotonic = dependencies.monotonic ?? (() => performance.now());
  const stamp = (): string => { const result = clock().toISOString(); routineTimestampEpoch(result); return result; };
  const startedAt = routineTimestampEpoch(occurrence.started_at!), initialAt = routineTimestampEpoch(stamp());
  requireValue(initialAt >= startedAt && Number.isFinite(monotonic()));
  const initialMono = monotonic(), initialElapsed = initialAt - startedAt, admitted = occurrence.budget.admitted_runtime_ms;
  const elapsed = (): number => {
    const now = monotonic(), wall = routineTimestampEpoch(stamp()) - startedAt;
    requireValue(Number.isFinite(now) && now >= initialMono && wall >= initialElapsed);
    const result = Math.max(wall, initialElapsed + Math.ceil(now - initialMono)); requireValue(Number.isSafeInteger(result)); return result;
  };
  const controller = new AbortController(); let deadlineExpired = false;
  const cancel = () => controller.abort();
  input.signal?.addEventListener("abort", cancel, { once: true }); if (input.signal?.aborted) cancel();
  const timer = setTimeout(() => { deadlineExpired = true; controller.abort(); }, Math.max(0, admitted - initialElapsed));
  const check = (boundary: RoutineActionBoundary = "read") => {
    requireValue(!deadlineExpired && elapsed() < admitted, "deadline-exceeded");
    requireValue(!controller.signal.aborted, "cancelled");
    try { occurrence = assertRoutineOwnership(input.ownership, path); }
    catch { throw new RoutineActionError("ownership-unavailable"); }
    assertRoutineActionBudget(occurrence, dependencies.state_root);
    try { gate(dependencies.assert_current, [occurrence, boundary]); }
    catch (error) { if (error instanceof RoutineActionError) throw error; throw new RoutineActionError("state-invalid"); }
    requireValue(!deadlineExpired && elapsed() < admitted, "deadline-exceeded");
    requireValue(!controller.signal.aborted, "cancelled");
  };
  let sources: RoutineEvidenceFact[] = [], signals: RoutineSignalFact[] = [], proposals: RoutineReceipt["proposals"] = [];
  let evaluated = 0, reports: 0 | 1 = 0, failure: RoutineFailureCode | null = null;
  try {
    check();
    const read = dependencies.read_evidence(occurrence, { signal: controller.signal,
      deadline_at: new Date(startedAt + admitted).toISOString(), check: () => check("read") });
    const interrupted = new Promise<never>((_, reject) => {
      const abort = () => reject(new RoutineActionError(deadlineExpired ? "deadline-exceeded" : "cancelled"));
      if (controller.signal.aborted) abort(); else controller.signal.addEventListener("abort", abort, { once: true });
    });
    const value = await Promise.race([read, interrupted]); check();
    ({ sources, signals } = evidence(value, occurrence, stamp()));
    switch (occurrence.definition.action) {
      case "refresh-evidence": break;
      case "evaluate-signals": evaluated = signals.length; break;
      case "propose-issues":
        evaluated = signals.length;
        requireValue(typeof dependencies.propose_issue === "function", "source-unavailable");
        for (const signal of signals) {
          check("proposal"); const key = routineProposalKey(occurrence.occurrence_key, signal.fingerprint);
          const proposal = { key, fingerprint: signal.fingerprint, issue_id: null as string | null }; proposals.push(proposal);
          const issueId = synchronous(dependencies.propose_issue, [{ ownership: input.ownership, occurrence, key,
            fingerprint: signal.fingerprint, signal }, () => check("proposal")]);
          requireValue(issueId === null || typeof issueId === "string", "action-failed"); if (issueId !== null) safeId(issueId);
          requireValue(issueId === null || !proposals.some((entry) => entry !== proposal && entry.issue_id === issueId), "action-failed");
          proposal.issue_id = issueId;
        }
        break;
      case "generate-local-report":
        check("report"); writeReport(occurrence, sources, stamp(), dependencies, () => check("report")); reports = 1; break;
      default: throw new RoutineActionError("state-invalid");
    }
    check("complete");
  } catch (error) {
    failure = error instanceof RoutineActionError ? error.code : "action-failed";
    if (error instanceof RoutineReportEffectError) reports = 1;
    if (error instanceof RoutineActionEffectError && error.committed_proposal !== undefined) {
      const proven = error.committed_proposal;
      const pending = proposals.find((proposal) => proposal.key === proven.key && proposal.fingerprint === proven.fingerprint
        && proposal.key === routineProposalKey(occurrence.occurrence_key, proven.fingerprint));
      if (pending && !proposals.some((proposal) => proposal !== pending && proposal.issue_id === proven.issue_id)) pending.issue_id = proven.issue_id;
    }
  }
  finally { clearTimeout(timer); input.signal?.removeEventListener("abort", cancel); }
  const runtime = elapsed(), finishedAt = stamp();
  if (runtime > admitted) failure = "deadline-exceeded";
  return receipt(occurrence, finishedAt, runtime, sources, proposals, evaluated, reports, failure);
}
