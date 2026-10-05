import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, renameSync, unlinkSync, writeFileSync, type Stats,
} from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { isDeepStrictEqual, types as nodeTypes } from "node:util";
import { budgetBucket } from "../budgets/policy";
import { BUDGET_DIMENSIONS, BUDGET_LIMITS, type BudgetDimension, type BudgetLedger, type BudgetReservation, type BudgetRunCharge } from "../budgets/types";
import { assertBudgetLedger } from "../budgets/validation";
import { budgetStatePath, locksDir } from "./paths";
import { StateLockConflictError } from "./store";

export class BudgetStateError extends Error {
  constructor(message = "Budget state is invalid, unsupported or inaccessible; no automatic repair was performed.") {
    super(message); this.name = "BudgetStateError";
  }
}
export class UnsupportedBudgetVersionError extends BudgetStateError {
  constructor(readonly version: number) { super("Unsupported budget schema version; stored bytes were preserved."); this.name = "UnsupportedBudgetVersionError"; }
}
declare const transactionBrand: unique symbol;
/** An exact live object issued here is required; persisted data and copies are not authority. */
export interface BudgetTransaction { readonly [transactionBrand]: true }
interface TransactionState { working: BudgetLedger; at: string; active: boolean; updating: boolean; checkOwnership: () => void }
const transactions = new WeakMap<object, TransactionState>();
let mutationActive = false;
const emptyLedger = (at: string): BudgetLedger => ({ schema_version: 1, revision: 1, created_at: at, updated_at: at, subjects: {}, reservations: {}, admission_intents: {}, charges: {} });
function check(ok: boolean, message: string): asserts ok { if (!ok) throw new BudgetStateError(message); }
function clone<T>(value: T): T { return structuredClone(value); }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function safePath(path: string, file: boolean): void {
  const absolute = resolve(path), root = parse(absolute).root, segments = absolute.slice(root.length).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    current = join(current, segments[index]!); let stat: Stats;
    try { stat = lstatSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new BudgetStateError(); }
    const lastFile = file && index === segments.length - 1;
    check(!stat.isSymbolicLink() && (lastFile ? stat.isFile() && stat.nlink === 1 : stat.isDirectory()), "Unsafe budget storage path; no automatic repair was performed.");
  }
}
/** Bound every read, including lock tokens, and verify the opened and named file. */
function readBytes(path: string, maximum: number): Buffer | null {
  safePath(path, true); let before: Stats;
  try { before = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new BudgetStateError(); }
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maximum, "Unsafe or oversized budget storage file.");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const opened = fstatSync(fd);
    check(opened.isFile() && opened.nlink === 1 && sameFile(before, opened) && opened.size === before.size, "Budget storage changed while opening.");
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (count === 0) break; length += count; }
    const after = fstatSync(fd), named = lstatSync(path);
    check(length === before.size && after.size === before.size && after.nlink === 1 && named.nlink === 1 && sameFile(before, after) && sameFile(before, named)
      && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && !named.isSymbolicLink(), "Budget storage changed while reading.");
    safePath(path, true); return buffer.subarray(0, length);
  } catch (error) { if (error instanceof BudgetStateError) throw error; throw new BudgetStateError(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function read(path: string): BudgetLedger | null {
  const bytes = readBytes(path, BUDGET_LIMITS.documentBytes); if (bytes === null) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const version = value !== null && typeof value === "object" ? (value as { schema_version?: unknown }).schema_version : undefined;
    if (typeof version === "number" && version > 1) throw new UnsupportedBudgetVersionError(version);
    assertBudgetLedger(value); return value;
  } catch (error) { if (error instanceof UnsupportedBudgetVersionError) throw error; throw new BudgetStateError(); }
}
function ownedCleanup(path: string, stat: Stats): void {
  try { safePath(path, true); const current = lstatSync(path); if (current.isFile() && current.nlink === 1 && sameFile(current, stat)) unlinkSync(path); }
  catch { /* Unknown/replaced paths are deliberately preserved. */ }
}
function atomicWrite(path: string, ledger: BudgetLedger, checkOwnership: () => void): void {
  const encoded = JSON.stringify(ledger); check(Buffer.byteLength(encoded) <= BUDGET_LIMITS.documentBytes, "Budget snapshot exceeds byte limit.");
  const staged = `${path}.${randomUUID()}.tmp`; let fd: number | undefined, stat: Stats | undefined, created = false;
  try {
    safePath(path, true); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); safePath(path, true);
    fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); created = true; stat = fstatSync(fd);
    writeFileSync(fd, encoded, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined;
    safePath(path, true); safePath(staged, true); check(sameFile(stat, lstatSync(staged)), "Budget staged ownership was lost."); checkOwnership();
    renameSync(staged, path); created = false;
  } catch { throw new BudgetStateError("Budget replacement failed; inspect the preserved snapshot before retrying."); }
  finally { if (fd !== undefined) closeSync(fd); if (created && stat !== undefined) ownedCleanup(staged, stat); }
}
function withBudgetLock<T>(directory: string, action: (checkOwnership: () => void) => T): T {
  try { safePath(directory, false); mkdirSync(directory, { recursive: true, mode: 0o700 }); safePath(directory, false); }
  catch { throw new BudgetStateError(); }
  const path = join(directory, "budgets.lock"), token = `${process.pid}\n${randomUUID()}\n`; safePath(path, true);
  let fd: number;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new StateLockConflictError("Budget state lock is busy; explicit inspected recovery is required.");
    throw new BudgetStateError();
  }
  let stat: Stats;
  try { stat = fstatSync(fd); }
  catch { try { closeSync(fd); } catch { /* Ownership is unknown; preserve the named lock. */ } throw new BudgetStateError("Budget lock identity could not be inspected; explicit recovery is required."); }
  const checkOwnership = () => {
    try { safePath(directory, false); const current = lstatSync(path); check(sameFile(stat, current), "Budget lock ownership was lost."); const bytes = readBytes(path, Buffer.byteLength(token)); check(bytes !== null && bytes.toString("utf8") === token, "Budget lock ownership was lost."); }
    catch { throw new BudgetStateError("Budget lock ownership was lost; explicit inspected recovery is required."); }
  };
  let initialized = false;
  try {
    try { writeFileSync(fd, token, "utf8"); fsyncSync(fd); initialized = true; }
    catch { throw new BudgetStateError("Budget lock initialization failed; no snapshot was replaced."); }
    checkOwnership(); return action(checkOwnership);
  } finally {
    closeSync(fd);
    if (initialized) { checkOwnership(); try { unlinkSync(path); } catch { throw new BudgetStateError("Budget lock release failed; inspect ownership and the current snapshot before retrying."); } }
    else ownedCleanup(path, stat);
  }
}
function callbackValid(callback: unknown): asserts callback is (...args: never[]) => unknown {
  check(typeof callback === "function" && !nodeTypes.isProxy(callback) && !nodeTypes.isAsyncFunction(callback) && !nodeTypes.isGeneratorFunction(callback), "Budget mutation must be synchronous and non-proxied.");
}
function synchronous(value: unknown): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  const seen = new Set<object>(); let current: object | null = value;
  while (current !== null) {
    check(!nodeTypes.isProxy(current) && !nodeTypes.isPromise(current) && !seen.has(current), "Budget mutation must be synchronous and non-proxied."); seen.add(current);
    const descriptors = Object.getOwnPropertyDescriptors(current);
    if (current !== Object.prototype && current !== Function.prototype) check(Reflect.ownKeys(descriptors).every((key) => Object.hasOwn(descriptors[key as keyof typeof descriptors]!, "value")), "Budget mutation result cannot contain accessors.");
    check(!Object.hasOwn(descriptors, "then"), "Budget mutation must be synchronous."); current = Object.getPrototypeOf(current) as object | null;
  }
}
function live(tx: unknown): TransactionState {
  check(tx !== null && typeof tx === "object" && !nodeTypes.isProxy(tx), "Budget transaction proof is invalid or stale.");
  const state = transactions.get(tx); check(!!state && state.active && !state.updating, "Budget transaction proof is invalid, reentrant or stale."); state.checkOwnership(); return state;
}
function childTime(created: string, updated: string, at: string, previous?: string): void {
  check(updated === at && Date.parse(created) <= Date.parse(at) && (previous === undefined || Date.parse(previous) <= Date.parse(at)), "Budget child timestamp is not the current ordered transaction time.");
}
function immutable(left: unknown, right: unknown): void { check(isDeepStrictEqual(left, right), "Budget immutable identity or binding changed."); }
function allTerminal(ledger: BudgetLedger, reservation: BudgetReservation): boolean {
  return reservation.run_ids.length > 0 && Object.values(ledger.charges).filter((charge) => charge.reservation_id === reservation.id).every((charge) => charge.status === "terminal" && charge.runtime_state === "complete" && charge.usage_state === "complete");
}
function total(ledger: BudgetLedger, reservation: string, dimension: BudgetDimension): number {
  let sum = 0;
  for (const charge of Object.values(ledger.charges)) {
    if (charge.reservation_id !== reservation) continue;
    const amount = dimension === "attempts" ? charge.attempts : dimension === "runtime_ms" ? charge.runtime_ms : dimension === "total_tokens" ? charge.observed_total_tokens ?? 0
      : dimension === "review_attempts" ? charge.review ? charge.attempts : 0 : dimension === "review_runtime_ms" ? charge.review ? charge.runtime_ms : 0
        : dimension === "review_total_tokens" ? charge.review ? charge.observed_total_tokens ?? 0 : 0 : dimension === "corrections" ? charge.correction ? 1 : 0 : 0;
    sum += amount; check(Number.isSafeInteger(sum), "Budget monotonic accounting exceeds safe integer capacity.");
  }
  return sum;
}
function firstKnownTerminal(before: BudgetLedger, after: BudgetLedger, reservation: string, review: boolean): boolean {
  const latest = before.reservations[reservation]?.run_ids.at(-1);
  return Object.values(after.charges).some((charge) => charge.reservation_id === reservation && charge.run_id === latest && (!review || charge.review)
    && charge.status === "terminal" && charge.runtime_state === "complete" && charge.usage_state === "complete" && before.charges[charge.id]?.status === "running");
}
function activeRuntimeDelta(before: BudgetLedger, after: BudgetLedger, reservation: string, review: boolean): number {
  const latest = before.reservations[reservation]?.run_ids.at(-1);
  const previous = Object.values(before.charges).find((charge) => charge.reservation_id === reservation && charge.run_id === latest);
  if (!previous || previous.status !== "running" || review && !previous.review) return 0;
  return after.charges[previous.id]!.runtime_ms - previous.runtime_ms;
}
function chargeMutation(previous: BudgetRunCharge, current: BudgetRunCharge, at: string): void {
  immutable([previous.id, previous.subject_id, previous.reservation_id, previous.run_id, previous.attempts, previous.review, previous.correction, previous.created_at], [current.id, current.subject_id, current.reservation_id, current.run_id, current.attempts, current.review, current.correction, current.created_at]);
  check(current.runtime_ms >= previous.runtime_ms && (previous.observed_total_tokens === null || current.observed_total_tokens !== null && current.observed_total_tokens >= previous.observed_total_tokens), "Budget charge high-water cannot decrease.");
  check(previous.status !== "terminal" || current.status === "terminal", "Budget terminal charge cannot reopen.");
  check((previous.runtime_state !== "unknown" || current.runtime_state === "unknown") && (previous.usage_state !== "unknown" || current.usage_state === "unknown"), "Budget unknown accounting cannot become known.");
  if (!isDeepStrictEqual(previous, current)) childTime(current.created_at, current.updated_at, at, previous.updated_at);
}
function reservationMutation(before: BudgetLedger, after: BudgetLedger, previous: BudgetReservation, current: BudgetReservation, at: string): void {
  immutable([previous.id, previous.subject_id, previous.intent_id, previous.policy_bindings, previous.created_at], [current.id, current.subject_id, current.intent_id, current.policy_bindings, current.created_at]);
  check(previous.run_ids.every((run, index) => current.run_ids[index] === run), "Budget run history is append-only.");
  check(previous.status !== "settled" || current.status === "settled", "Settled budget reservation cannot reopen.");
  check(previous.status !== "unknown" || current.status === "unknown", "Unknown budget reservation cannot reopen.");
  const transitions = { pending: ["pending", "committed", "unknown"], committed: ["committed", "active", "settled", "unknown"], active: ["active", "committed", "settled", "unknown"], settled: ["settled"], unknown: ["unknown"] } as const;
  check((transitions[previous.status] as readonly string[]).includes(current.status), "Invalid budget reservation transition.");
  check(current.status !== "settled" || allTerminal(after, current), "Budget settlement requires complete terminal runs.");
  check(previous.uncertain_dimensions.every((dimension) => current.uncertain_dimensions.includes(dimension)), "Budget uncertainty cannot decrease.");
  for (const dimension of BUDGET_DIMENSIONS) {
    const oldHold = previous.held[dimension], hold = current.held[dimension];
    if (hold < oldHold) {
      check(previous.status !== "unknown" && current.status !== "unknown", "Unknown budget holds cannot decrease.");
      if (current.status === "settled") continue;
      check(dimension !== "concurrent_reads" && dimension !== "concurrent_writes", "Budget execution slot cannot be released before settlement.");
      const runtime = dimension === "runtime_ms" || dimension === "review_runtime_ms";
      const delta = runtime ? activeRuntimeDelta(before, after, current.id, dimension === "review_runtime_ms") : total(after, current.id, dimension) - total(before, previous.id, dimension);
      const terminalRelease = runtime && hold === 0 && firstKnownTerminal(before, after, current.id, dimension === "review_runtime_ms");
      check(terminalRelease || oldHold - hold <= delta, "Budget hold reduction lacks a proven canonical debit.");
    } else if (hold > oldHold) {
      check(previous.status !== "unknown" && current.status !== "unknown" && previous.status !== "settled", "Closed or unknown budget holds cannot grow.");
      check(dimension !== "total_tokens" && dimension !== "review_total_tokens" && dimension !== "concurrent_reads" && dimension !== "concurrent_writes" && dimension !== "corrections", "Budget cumulative tokens, slots and correction holds cannot be reallocated.");
      check(allTerminal(before, previous) && isDeepStrictEqual(previous.run_ids, current.run_ids) && current.status === "committed", "Budget retry top-up requires prior complete terminal runs.");
    }
  }
  if (!isDeepStrictEqual(previous, current)) { check(previous.revision < Number.MAX_SAFE_INTEGER && current.revision === previous.revision + 1, "Budget reservation revision must advance exactly once."); childTime(current.created_at, current.updated_at, at, previous.updated_at); }
}
function transition(before: BudgetLedger, after: BudgetLedger, at: string): void {
  immutable([before.schema_version, before.revision, before.created_at, before.updated_at], [after.schema_version, after.revision, after.created_at, after.updated_at]);
  for (const name of ["subjects", "reservations", "admission_intents", "charges"] as const) check(Object.keys(before[name]).every((id) => Object.hasOwn(after[name], id)), "Budget maps are append-only.");
  for (const [id, subject] of Object.entries(before.subjects)) immutable(subject, after.subjects[id]);
  const newCharges = Object.values(after.charges).filter((charge) => before.charges[charge.id] === undefined);
  check(newCharges.length <= 1, "Budget update cannot claim multiple new runs.");
  for (const [id, current] of Object.entries(after.charges)) {
    const previous = before.charges[id];
    if (previous) chargeMutation(previous, current, at);
    else {
      const priorReservation = before.reservations[current.reservation_id], reservation = after.reservations[current.reservation_id]!;
      check(!!priorReservation && priorReservation.status === "committed" && priorReservation.held.attempts === 1
        && priorReservation.held.concurrent_reads + priorReservation.held.concurrent_writes === 1 && reservation.status === "active" && reservation.held.attempts === 0
        && priorReservation.held.concurrent_reads === reservation.held.concurrent_reads && priorReservation.held.concurrent_writes === reservation.held.concurrent_writes,
      "Budget claim lacks its exact committed prospective attempt and execution slot.");
      const subject = before.subjects[priorReservation.subject_id]!;
      const priorCharges = Object.values(before.charges).filter((charge) => charge.reservation_id === priorReservation.id);
      check(priorReservation.held.runtime_ms > 0 && (subject.kind === "occurrence" || priorReservation.held.total_tokens > 0)
        && (priorReservation.run_ids.length === 0 || allTerminal(before, priorReservation)), "Budget claim lacks runtime, tokens or complete prior-run facts.");
      check(priorReservation.held.review_attempts === (current.review ? 1 : 0)
        && (current.review ? priorReservation.held.review_runtime_ms > 0 && priorReservation.held.review_total_tokens > 0
          : priorReservation.held.review_runtime_ms === 0 && priorReservation.held.review_total_tokens === 0), "Budget claim review label differs from its prospective holds.");
      check(current.correction ? priorReservation.held.corrections === 1 || priorCharges.some((charge) => charge.correction) : priorReservation.held.corrections === 0,
        "Budget claim correction label lacks its exact held or retained allowance.");
      check(priorCharges.every((charge) => charge.review === current.review && charge.correction === current.correction), "Budget retry cannot change canonical review or correction labels.");
      check(current.status === "running" && current.runtime_ms === 0 && current.observed_total_tokens === 0 && current.runtime_state === "complete" && current.usage_state === "complete",
        "Budget new charge must record only known initial pre-effect facts.");
      check(current.created_at === at, "New budget charge must use transaction time."); childTime(current.created_at, current.updated_at, at);
    }
  }
  for (const [id, current] of Object.entries(after.reservations)) {
    const previous = before.reservations[id];
    if (previous) reservationMutation(before, after, previous, current, at);
    else { check(current.revision === 1 && !Object.values(before.reservations).some((reservation) => reservation.subject_id === current.subject_id), "Budget subject already has its immutable reservation."); check(current.created_at === at, "New budget reservation must use transaction time."); childTime(current.created_at, current.updated_at, at); }
  }
  for (const [id, current] of Object.entries(after.admission_intents)) {
    const previous = before.admission_intents[id];
    if (!previous) { check(current.created_at === at, "New budget intent must use transaction time."); childTime(current.created_at, current.updated_at, at); continue; }
    immutable([previous.id, previous.subject_id, previous.reservation_id, previous.created_at], [current.id, current.subject_id, current.reservation_id, current.created_at]);
    check(previous.admission_id === null || previous.admission_id === current.admission_id, "Budget admission binding cannot change.");
    check(previous.status === "pending" || current.status === previous.status || current.status === "unknown", "Budget intent cannot regain commitment.");
    check(previous.status !== "unknown" || current.status === "unknown", "Unknown budget intent cannot reopen.");
    if (!isDeepStrictEqual(previous, current)) childTime(current.created_at, current.updated_at, at, previous.updated_at);
  }
}

/** Absence is explicit and has no directory, lock, clock or invented-history effects. */
export function readBudgetLedger(filePath: string = budgetStatePath()): BudgetLedger | null { const ledger = read(resolve(filePath)); return ledger === null ? null : freeze(ledger); }
export function readBudgetTransaction(tx: unknown): { ledger: BudgetLedger; at: string } { const state = live(tx); return freeze({ ledger: clone(state.working), at: state.at }); }
export function updateBudgetTransaction(tx: unknown, update: (draft: BudgetLedger, at: string) => void): void {
  const state = live(tx); callbackValid(update); const draft = clone(state.working); state.updating = true;
  try { const result = update(draft, state.at); synchronous(result); assertBudgetLedger(draft); transition(state.working, draft, state.at); state.checkOwnership(); state.working = clone(draft); }
  finally { state.updating = false; }
}
/** State-only synchronous critical section: no awaits, effects or nested store locks. */
export function mutateBudgetLedger<T>(callback: (tx: BudgetTransaction) => T, filePath: string = budgetStatePath(), at: string = new Date().toISOString()): T {
  callbackValid(callback); check(!mutationActive, "Budget mutation is reentrant."); budgetBucket("none", at); const path = resolve(filePath);
  read(path); // Invalid/future/unsafe existing bytes cause no lock/directory writes.
  mutationActive = true;
  try {
    return withBudgetLock(locksDir(dirname(dirname(path))), (checkOwnership) => {
      const persisted = read(path), before = persisted ?? emptyLedger(at); assertBudgetLedger(before);
      check(Date.parse(before.updated_at) <= Date.parse(at), "Budget transaction clock cannot regress.");
      const tx = Object.freeze({}) as BudgetTransaction, state: TransactionState = { working: clone(before), at, active: true, updating: false, checkOwnership }; transactions.set(tx, state);
      try {
        const result = callback(tx); synchronous(result); checkOwnership();
        if (!isDeepStrictEqual(before, state.working)) { check(persisted === null || before.revision < Number.MAX_SAFE_INTEGER, "Budget ledger revision is exhausted."); const final = clone(state.working); final.revision = persisted === null ? 1 : before.revision + 1; final.updated_at = at; assertBudgetLedger(final); atomicWrite(path, final, checkOwnership); }
        return result;
      } finally { state.active = false; transactions.delete(tx); }
    });
  } finally { mutationActive = false; }
}
